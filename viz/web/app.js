// App shell: project folder scanning, conversion, and mounting the viewer / comparison UI.
import { Project } from './project.js';
import { mountViewer } from './viewer.js';
import { mountCompare } from './compare.js';
import { localProjectsFromFiles, openLocalProject, pickDirectory, cacheClear } from './local.js';

const $ = (id) => document.getElementById(id);
const status = $('status'), plist = $('plist'), perr = $('perr'), convStatus = $('convStatus');
let projects = [], selected = new Set(), mounted = null, serverOk = null, localProjects = [];
const opened = new Map();   // name -> Project (wasm buffers are allocated once per project)

async function api(path, body) {
  const r = await fetch(path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : undefined);
  const j = await r.json();
  if (!r.ok || j.error) throw new Error(j.error || r.statusText);
  return j;
}
const fmtSize = (b) => b > 1e9 ? `${(b / 1e9).toFixed(2)} GB` : `${(b / 1e6).toFixed(1)} MB`;

async function detectServer() {
  if (serverOk !== null) return serverOk;
  try { const r = await fetch('/api/projects?folder=', { cache: 'no-store' }); serverOk = (r.headers.get('content-type') || '').includes('json'); } catch { serverOk = false; }
  $('folderbar').hidden = !serverOk;
  $('mode').textContent = serverOk ? 'サーバー接続あり（サーバー変換 + ブラウザ内変換）' : '静的モード（変換・解析・レポートはすべてブラウザ内）';
  return serverOk;
}
function mergeLists() {
  const server = projects.filter((p) => !p.kind.startsWith('local'));
  projects = [...localProjects, ...server];
  $('pcount').textContent = `(${projects.length} 件)`;
  renderList();
}
async function scan() {
  perr.textContent = '';
  if (!(await detectServer())) { mergeLists(); return; }
  status.textContent = 'スキャン中…';
  try {
    const folder = $('folder').value.trim();
    const j = await api(`/api/projects?folder=${encodeURIComponent(folder)}`);
    projects = j.projects; selected.clear();
    try { localStorage.setItem('iric.folder', folder); } catch {}
    status.textContent = `${j.folder}: ${projects.length} 件`;
    mergeLists();
  } catch (e) { perr.textContent = String(e); status.textContent = ''; mergeLists(); }
}
function addLocalFiles(files) {
  const found = localProjectsFromFiles(files);
  for (const f of found) { localProjects = localProjects.filter((p) => p.name !== f.name); localProjects.push(f); }
  localProjects.sort((a, b) => a.name.localeCompare(b.name));
  $('localStatus').textContent = found.length ? `${found.length} 件を追加` : 'iRIC プロジェクトが見つかりません（.ipro / project.xml を含むフォルダ / .cgn）';
  mergeLists();
}

function renderList() {
  plist.replaceChildren();
  if (!projects.length) { plist.innerHTML = '<tr><td colspan="8" class="sub">iRIC プロジェクト（*.ipro または project.xml を含むフォルダ）が見つかりません</td></tr>'; return; }
  for (const p of projects) {
    const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = selected.has(p.name);
    cb.addEventListener('change', () => { cb.checked ? selected.add(p.name) : selected.delete(p.name); updateButtons(); tr.classList.toggle('sel', cb.checked); });
    const tr = document.createElement('tr'); tr.classList.toggle('sel', cb.checked);
    const KIND = { ipro: '.ipro', folder: 'フォルダ', 'local-ipro': '.ipro（ローカル）', 'local-folder': 'フォルダ（ローカル）', 'local-cgn': '.cgn（ローカル）' };
    const cells = [cb, p.name, KIND[p.kind] || p.kind, `${p.solver || (p.kind.startsWith('local') ? '（変換時に判定）' : '?')} ${p.solverVersion || ''}`, p.crs || '-', fmtSize(p.size),
      p.converted ? '済' : (p.error ? `エラー: ${p.error}` : (opened.has(p.name) ? '済（ブラウザ）' : '未')), p.meta ? `${p.meta.ni}×${p.meta.nj} / ${p.meta.nt}` : '-'];
    for (const c of cells) { const td = document.createElement('td'); td.append(c.nodeType ? c : String(c)); tr.append(td); }
    tr.addEventListener('dblclick', () => { selected = new Set([p.name]); renderList(); openSelected('view'); });
    plist.append(tr);
  }
  updateButtons();
}
function updateButtons() { $('openOne').disabled = selected.size !== 1; $('openCompare').disabled = selected.size < 2; }

async function ensureConverted(names) {
  for (const [k, name] of names.entries()) {
    const p = projects.find((x) => x.name === name);
    if (p.kind.startsWith('local')) {
      if (opened.has(name)) continue;
      const group = await openLocalProject(p, (msg, frac) => { convStatus.textContent = `ブラウザ内変換 (${k + 1}/${names.length}) ${name}: ${msg} ${frac !== undefined ? Math.round(frac * 100) + '%' : ''}`; });
      opened.set(name, await Project.fromGroup(name, group));
      const A = group.attrs; p.meta = { ni: A.ni, nj: A.nj, nt: A.nt }; p.solver = A.solver; p.solverVersion = A.solverVersion; p.crs = A.crs; p.converted = true;
      continue;
    }
    if (p.converted) continue;
    convStatus.textContent = `変換中 (${k + 1}/${names.length}): ${name} … (CGNS → Zarr, 数十秒かかることがあります)`;
    const j = await api('/api/convert', { path: p.path });
    p.converted = true; p.meta = j.meta;
  }
  convStatus.textContent = ''; renderList();
}

async function openSelected(mode) {
  perr.textContent = '';
  const names = projects.filter((p) => selected.has(p.name)).map((p) => p.name);
  try {
    $('openOne').disabled = $('openCompare').disabled = true;
    await ensureConverted(names);
    convStatus.textContent = 'データ読込中…';
    const ps = [];
    for (const n of names) { if (!opened.has(n)) opened.set(n, await Project.open(n)); ps.push(opened.get(n)); }
    convStatus.textContent = '';
    if (mounted) mounted.destroy();
    $('projects').open = false;
    mounted = mode === 'view' ? mountViewer($('content'), ps[0]) : mountCompare($('content'), ps);
    document.title = mode === 'view' ? `${names[0]} – iRIC viewer` : `比較: ${names.join(', ')}`;
  } catch (e) { perr.textContent = String(e); console.error(e); convStatus.textContent = ''; }
  updateButtons();
}

$('scan').onclick = scan;
$('pickLocalFiles').onclick = () => { const inp = $('localFiles'); inp.value = ''; inp.click(); };
$('pickLocalDir').onclick = async () => { try { addLocalFiles(await pickDirectory($('localDir'))); } catch (e) { if (e.name !== 'AbortError') perr.textContent = String(e); } };
$('clearCache').onclick = async () => { await cacheClear(); $('localStatus').textContent = 'ブラウザ内キャッシュを削除しました'; };
$('localFiles').addEventListener('change', () => addLocalFiles([...$('localFiles').files]));
$('folder').addEventListener('keydown', (e) => { if (e.key === 'Enter') scan(); });
$('pick').onclick = async () => {
  try { const j = await api('/api/pick-folder', { initial: $('folder').value }); if (j.folder) { $('folder').value = j.folder; scan(); } }
  catch (e) { perr.textContent = String(e); }
};
$('openOne').onclick = () => openSelected('view');
$('openCompare').onclick = () => openSelected('compare');
$('projects').addEventListener('toggle', () => window.dispatchEvent(new Event('resize')));

// initial folder: URL ?folder=..., else last used, else ../projects next to the app
const qs = new URLSearchParams(location.search);
let initial = qs.get('folder');
if (!initial) { try { initial = localStorage.getItem('iric.folder'); } catch {} }
$('folder').value = initial || '../projects';
scan().then(() => {
  const auto = qs.get('open');
  if (auto) { selected = new Set(auto.split(',')); renderList(); openSelected(selected.size > 1 ? 'compare' : 'view'); }
});
