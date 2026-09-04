// Browser-side conversion of iRIC projects: .ipro (zip) -> CGNS (HDF5, read with h5wasm) -> in-memory
// store (memstore.js), cached in IndexedDB so the next open is instant. No server involved.
import { MemGroup } from './memstore.js';
import { toMercator } from './proj.js';

const H5WASM_URL = 'https://cdn.jsdelivr.net/npm/h5wasm@0.10.3/dist/esm/hdf5_hl.js';
const safe = (s) => s.replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '') || 'x';

// ---------------------------------------------------------------- zip (central directory + deflate-raw)
async function readZipDirectory(file) {
  const tailLen = Math.min(file.size, 65536 + 22);
  const tail = new DataView(await file.slice(file.size - tailLen).arrayBuffer());
  let eocd = -1;
  for (let k = tail.byteLength - 22; k >= 0; k--) if (tail.getUint32(k, true) === 0x06054b50) { eocd = k; break; }
  if (eocd < 0) throw new Error('zip の End of Central Directory が見つかりません');
  const count = tail.getUint16(eocd + 10, true), cdSize = tail.getUint32(eocd + 12, true), cdOff = tail.getUint32(eocd + 16, true);
  const cd = new DataView(await file.slice(cdOff, cdOff + cdSize).arrayBuffer());
  const entries = []; let p = 0; const dec = new TextDecoder();
  for (let k = 0; k < count; k++) {
    if (cd.getUint32(p, true) !== 0x02014b50) break;
    const method = cd.getUint16(p + 10, true), compSize = cd.getUint32(p + 20, true), size = cd.getUint32(p + 24, true);
    const nameLen = cd.getUint16(p + 28, true), extraLen = cd.getUint16(p + 30, true), commentLen = cd.getUint16(p + 32, true);
    const offset = cd.getUint32(p + 42, true);
    const name = dec.decode(new Uint8Array(cd.buffer, cd.byteOffset + p + 46, nameLen));
    entries.push({ name, method, compSize, size, offset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}
async function readZipEntry(file, entry) {
  const lh = new DataView(await file.slice(entry.offset, entry.offset + 30).arrayBuffer());
  if (lh.getUint32(0, true) !== 0x04034b50) throw new Error(`zip ローカルヘッダが不正: ${entry.name}`);
  const start = entry.offset + 30 + lh.getUint16(26, true) + lh.getUint16(28, true);
  const blob = file.slice(start, start + entry.compSize);
  if (entry.method === 0) return blob.arrayBuffer();
  if (entry.method !== 8) throw new Error(`未対応の圧縮方式 ${entry.method}: ${entry.name}`);
  return new Response(blob.stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer();
}

// ---------------------------------------------------------------- h5wasm
let h5p = null;
async function loadH5() {
  if (!h5p) h5p = (async () => {
    const mod = await import(/* webpackIgnore: true */ H5WASM_URL);
    const h5 = mod.default || mod;
    const M = await h5.ready;
    return { h5, FS: h5.FS || M.FS };
  })();
  return h5p;
}

function parseProjectXml(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  const root = doc.documentElement, lst = doc.querySelector('CgnsFileList');
  return { solver: root.getAttribute('solverName') || '', solverVersion: root.getAttribute('solverVersion') || '', crs: root.getAttribute('coordinateSystem') || null,
    iricVersion: root.getAttribute('version') || '', cgns: (lst && lst.getAttribute('current')) || 'Case1' };
}

/** Convert a CGNS ArrayBuffer to the memstore data object. */
async function convertCgns(buf, info, name, onProgress) {
  const { h5, FS } = await loadH5();
  const fn = `/work_${Date.now()}.cgn`;
  FS.writeFile(fn, new Uint8Array(buf));
  const f = new h5.File(fn, 'r');
  try {
    const zone = f.get('iRIC/iRICZone');
    const zs = f.get('iRIC/iRICZone/ data').value;                 // [[ni, nj], [ni-1, nj-1], [0,0]]
    const ni = Number(zs[0]), nj = Number(zs[1]), N = ni * nj;
    const x = Float32Array.from(f.get('iRIC/iRICZone/GridCoordinates/CoordinateX/ data').value);
    const y = Float32Array.from(f.get('iRIC/iRICZone/GridCoordinates/CoordinateY/ data').value);
    if (x.length !== N) throw new Error(`格子サイズ不一致 ${x.length} != ${N}`);
    let time = Float64Array.from(f.get('iRIC/BaseIterativeData/TimeValues/ data').value);
    const sols = zone.keys().filter((k) => /^FlowSolution\d+$/.test(k)).sort((a, b) => +a.slice(12) - +b.slice(12));
    const nt = Math.min(time.length, sols.length); time = time.subarray(0, nt); sols.length = nt;
    const first = f.get(`iRIC/iRICZone/${sols[0]}`);
    const vars = first.keys().filter((k) => !k.startsWith(' ') && first.get(k).keys && first.get(k).keys().includes(' data'));
    const results = {}, variables = {};
    const same = (a, b) => { if (a.length !== b.length) return false; for (let k = 0; k < a.length; k++) if (a[k] !== b[k] && !(a[k] !== a[k] && b[k] !== b[k])) return false; return true; };
    for (const [vi, v] of vars.entries()) {
      const key = safe(v); variables[key] = v;
      const a0 = f.get(`iRIC/iRICZone/${sols[0]}/${v}/ data`).value;
      // time-invariant variables (e.g. Elevation) are stored once
      const isStatic = nt > 2 && same(a0, f.get(`iRIC/iRICZone/${sols[nt - 1]}/${v}/ data`).value) && same(a0, f.get(`iRIC/iRICZone/${sols[nt >> 1]}/${v}/ data`).value);
      const steps = isStatic ? 1 : nt;
      const data = new Float32Array(steps * N); let lo = Infinity, hi = -Infinity;
      for (let t = 0; t < steps; t++) {
        const a = t === 0 ? a0 : f.get(`iRIC/iRICZone/${sols[t]}/${v}/ data`).value;
        for (let k = 0; k < N; k++) { const val = a[k]; data[t * N + k] = val; if (val === val) { if (val < lo) lo = val; if (val > hi) hi = val; } }
        if (onProgress && t % 20 === 0) { onProgress(`変換中 ${v} ${t + 1}/${steps}`, (vi + t / steps) / vars.length); await new Promise((r) => setTimeout(r)); }
      }
      results[key] = { data, steps, min: lo, max: hi, original_name: v };
    }
    let mx = null, my = null, bbox3857 = null, center = null;
    const tr = toMercator(x, y, info.crs);
    if (tr) { mx = tr.mx; my = tr.my; bbox3857 = [Math.min(...mx), Math.min(...my), Math.max(...mx), Math.max(...my)]; center = [tr.lon, tr.lat]; }
    const attrs = { source: name, project: name, ni, nj, nt, variables, bbox: [Math.min(...x), Math.min(...y), Math.max(...x), Math.max(...y)], crs: info.crs,
      solver: info.solver, solverVersion: info.solverVersion, converted: new Date().toISOString(), local: true, ...(bbox3857 ? { bbox3857, center_lonlat: center } : {}) };
    return { attrs, x, y, mx, my, time: Float64Array.from(time), results };
  } finally { f.close(); FS.unlink(fn); }
}

// ---------------------------------------------------------------- IndexedDB cache
function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('iric-local', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('projects');
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
async function cacheGet(key) { try { const db = await idb(); return await new Promise((res) => { const q = db.transaction('projects').objectStore('projects').get(key); q.onsuccess = () => res(q.result || null); q.onerror = () => res(null); }); } catch { return null; } }
async function cachePut(key, val) {
  try {
    const db = await idb();
    await new Promise((res) => { const tx = db.transaction('projects', 'readwrite'); tx.oncomplete = res; tx.onerror = res; tx.onabort = res; tx.objectStore('projects').put(val, key); });
  } catch (e) { console.warn('cache skipped', e); }
}
export async function cacheClear() { try { const db = await idb(); await new Promise((res) => { const q = db.transaction('projects', 'readwrite').objectStore('projects').clear(); q.onsuccess = res; q.onerror = res; }); } catch {} }

// ---------------------------------------------------------------- local project registry
/** Group File objects (from <input type=file> or a directory picker) into project entries. */
export function localProjectsFromFiles(files) {
  const out = [], byDir = new Map();
  for (const f of files) {
    const rel = f.webkitRelativePath || f.name, parts = rel.split('/');
    const lname = f.name.toLowerCase();
    if (lname.endsWith('.ipro')) out.push({ name: f.name.replace(/\.ipro$/i, ''), kind: 'local-ipro', size: f.size, mtime: f.lastModified / 1000, files: { ipro: f }, path: rel });
    else if (parts.length >= 2 && (lname === 'project.xml' || lname.endsWith('.cgn'))) {
      const dir = parts.slice(0, -1).join('/'); if (!byDir.has(dir)) byDir.set(dir, { xml: null, cgns: [] });
      lname === 'project.xml' ? byDir.get(dir).xml = f : byDir.get(dir).cgns.push(f);
    } else if (lname.endsWith('.cgn')) out.push({ name: f.name.replace(/\.cgn$/i, ''), kind: 'local-cgn', size: f.size, mtime: f.lastModified / 1000, files: { cgn: f }, path: rel });
  }
  for (const [dir, d] of byDir) {
    if (d.xml) out.push({ name: dir.split('/').pop(), kind: 'local-folder', size: d.cgns.reduce((s, f) => s + f.size, 0), mtime: Math.max(...d.cgns.map((f) => f.lastModified), d.xml.lastModified) / 1000, files: { xml: d.xml, cgns: d.cgns }, path: dir });
    else for (const c of d.cgns) out.push({ name: c.name.replace(/\.cgn$/i, ''), kind: 'local-cgn', size: c.size, mtime: c.lastModified / 1000, files: { cgn: c }, path: `${dir}/${c.name}` });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Convert (or restore from IndexedDB) a local project entry -> MemGroup. */
export const BROWSER_SOFT_LIMIT_MB = 1500;   // above this, recommend the server mode (memory: file + arrays)
export async function openLocalProject(entry, onProgress = () => {}) {
  const key = `${entry.kind}|${entry.path}|${entry.size}|${Math.round(entry.mtime)}`;
  if (entry.size / 1048576 > BROWSER_SOFT_LIMIT_MB) onProgress(`注意: ${(entry.size / 1048576).toFixed(0)} MB はブラウザ内変換の目安 (${BROWSER_SOFT_LIMIT_MB} MB) を超えています。メモリ不足で失敗する場合は server.py のサーバーモードをお使いください`, 0.01);
  const cached = await cacheGet(key);
  if (cached) { onProgress('キャッシュから読込', 1); return new MemGroup(cached); }
  let info = { solver: '', solverVersion: '', crs: null, cgns: 'Case1' }, cgnBuf = null;
  if (entry.kind === 'local-ipro') {
    onProgress('zip を読込中 …', 0.02);
    let entries; try { entries = await readZipDirectory(entry.files.ipro); } catch (e) { throw readError(e, entry.files.ipro.name); }
    const xml = entries.find((e) => e.name === 'project.xml');
    if (xml) info = parseProjectXml(new TextDecoder().decode(await readZipEntry(entry.files.ipro, xml)));
    const cgn = entries.find((e) => e.name.toLowerCase() === `${info.cgns}.cgn`.toLowerCase()) || entries.find((e) => e.name.toLowerCase().endsWith('.cgn') && !e.name.toLowerCase().includes('_input'));
    if (!cgn) throw new Error('.ipro 内に CGNS ファイルがありません');
    onProgress(`${cgn.name} を展開中 (${(cgn.size / 1e6).toFixed(0)} MB) …`, 0.05);
    try { cgnBuf = await readZipEntry(entry.files.ipro, cgn); } catch (e) { throw readError(e, entry.files.ipro.name); }
  } else if (entry.kind === 'local-folder') {
    info = parseProjectXml(await entry.files.xml.text());
    const cgn = entry.files.cgns.find((f) => f.name.toLowerCase() === `${info.cgns}.cgn`.toLowerCase()) || entry.files.cgns.find((f) => !f.name.toLowerCase().includes('_input'));
    if (!cgn) throw new Error('フォルダに CGNS ファイルがありません');
    onProgress(`${cgn.name} を読込中 (${(cgn.size / 1e6).toFixed(0)} MB) …`, 0.05);
    try { cgnBuf = await cgn.arrayBuffer(); } catch (e) { throw readError(e, cgn.name); }
  } else {
    onProgress(`${entry.files.cgn.name} を読込中 …`, 0.05);
    try { cgnBuf = await entry.files.cgn.arrayBuffer(); } catch (e) { throw readError(e, entry.files.cgn.name); }
  }
  onProgress('HDF5 リーダー (h5wasm) を読込中 …', 0.1);
  const data = await convertCgns(cgnBuf, info, entry.name, onProgress);
  cgnBuf = null;
  const mb = dataBytes(data) / 1048576;
  if (mb <= CACHE_MAX_MB) {
    onProgress(`キャッシュに保存 (${mb.toFixed(0)} MB) …`, 0.98);
    await Promise.race([cachePut(key, data), new Promise((r) => setTimeout(r, CACHE_TIMEOUT_MS))]);   // best effort: never block the viewer
  } else {
    onProgress(`変換データ ${mb.toFixed(0)} MB はキャッシュ上限 ${CACHE_MAX_MB} MB を超えるため保存しません（次回も変換します）`, 0.99);
  }
  return new MemGroup(data);
}
const CACHE_MAX_MB = 250, CACHE_TIMEOUT_MS = 90000;
function dataBytes(d) {
  let n = 0;
  for (const a of [d.x, d.y, d.mx, d.my, d.time]) if (a) n += a.byteLength;
  for (const r of Object.values(d.results)) n += r.data.byteLength;
  return n;
}
/** Friendlier message for File API read failures. */
function readError(e, what) {
  if (e && (e.name === 'NotReadableError' || /NotReadable/.test(String(e)))) {
    return new Error(`${what} を読めませんでした。他のプログラム（iRIC など）で開かれている、選択後に変更された、またはオンラインのみ（OneDrive 等）のファイルの可能性があります。閉じてから「フォルダを選択」で選び直してください。`);
  }
  return e;
}

/** Directory picker with File System Access API when available, else a hidden <input webkitdirectory>. */
export async function pickDirectory(inputEl) {
  if (window.showDirectoryPicker) {
    const dir = await window.showDirectoryPicker();
    const files = [];
    async function walk(handle, prefix) {
      for await (const [name, h] of handle.entries()) {
        if (h.kind === 'file') { const f = await h.getFile(); Object.defineProperty(f, 'webkitRelativePath', { value: `${prefix}${name}` }); files.push(f); }
        else if (prefix.split('/').length <= 3) await walk(h, `${prefix}${name}/`);
      }
    }
    await walk(dir, `${dir.name}/`);
    return files;
  }
  return new Promise((res) => { inputEl.value = ''; inputEl.addEventListener('change', () => res([...inputEl.files]), { once: true }); inputEl.click(); });
}
