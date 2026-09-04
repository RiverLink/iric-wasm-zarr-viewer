// App shell (layout A): left sidebar with accordion groups (data / view / analysis / layout / output /
// settings), full-size stage on the right. Viewer and comparison modules mount their controls into the
// groups. The data group is backed by the server catalog (registered root folders + conversion jobs)
// and, in static mode, by projects converted in the browser.
import { Project } from './project.js';
import { mountViewer } from './viewer.js';
import { mountCompare } from './compare.js';
import { localProjectsFromFiles, openLocalProject, pickDirectory, cacheClear } from './local.js';

const $ = (id) => document.getElementById(id);
const status = $('status'), plist = $('plist'), perr = $('perr'), convStatus = $('convStatus');
let projects = [], selected = new Set(), mounted = null, serverOk = null, localProjects = [], roots = [], sortDesc = false, pollTimer = null, pollEmpty = 0;
const opened = new Map();   // name -> Project (wasm buffers are allocated once per project)
const side = { data: $('grp-data-body'), view: $('grp-view-body'), analysis: $('grp-analysis-body'), layout: $('grp-layout-body'), output: $('grp-output-body') };

// ---------------- sidebar chrome
const sidebar = $('sidebar'), stage = $('stage');
function setSidebar(open) { sidebar.classList.toggle('collapsed', !open); stage.classList.toggle('nosb', !open); try { localStorage.setItem('iric.sidebar', open ? '1' : '0'); } catch {} window.dispatchEvent(new Event('resize')); }
$('toggleSidebar').onclick = () => setSidebar(sidebar.classList.contains('collapsed'));
$('showSidebar').onclick = () => setSidebar(true);
for (const d of document.querySelectorAll('#sidebar details.grp')) {
  if (d.id === 'grp-data') { d.open = true; continue; }          // the data group always starts open (nothing is loaded yet)
  try { const v = localStorage.getItem('iric.grp.' + d.id); if (v !== null) d.open = v === '1'; } catch {}
  d.addEventListener('toggle', () => { try { localStorage.setItem('iric.grp.' + d.id, d.open ? '1' : '0'); } catch {} });
}

async function api(path, body) {
  const r = await fetch(path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : { cache: 'no-store' });
  const j = await r.json();
  if (!r.ok || j.error) throw new Error(j.error || r.statusText);
  return j;
}
const fmtSize = (b) => !b ? '-' : b > 1e9 ? `${(b / 1e9).toFixed(2)} GB` : `${(b / 1e6).toFixed(1)} MB`;

async function detectServer() {
  if (serverOk !== null) return serverOk;
  try { const r = await fetch('/api/catalog', { cache: 'no-store' }); serverOk = (r.headers.get('content-type') || '').includes('json'); } catch { serverOk = false; }
  $('serverbar').hidden = !serverOk; $('findbar').hidden = !serverOk; $('queueSel').hidden = !serverOk; $('queueAll').hidden = !serverOk; $('storage').hidden = !serverOk;
  $('grp-settings').hidden = !serverOk;
  $('mode').textContent = serverOk ? 'サーバー接続あり' : '静的モード（ブラウザ内で変換・解析）';
  return serverOk;
}

// ---------------- catalog (server) + local projects
async function loadCatalog() {
  if (!(await detectServer())) { mergeLists(); return; }
  try {
    const q = $('find').value.trim(), sort = $('sort').value;
    const j = await api(`/api/catalog?q=${encodeURIComponent(q)}&sort=${sort}&desc=${sortDesc ? 1 : 0}`);
    projects = j.projects.map((r) => ({ ...r, kind: r.kind || 'folder', converted: !!r.converted, meta: r.nt ? { ni: r.ni, nj: r.nj, nt: r.nt } : null, solverVersion: r.solver_version }));
    roots = j.roots; renderRoots();
    mergeLists();
    if (projects.some((p) => p.job)) startPolling();
  } catch (e) { perr.textContent = String(e); }
  refreshStorage();
}
function renderRoots() {
  const el = $('roots'); el.replaceChildren();
  for (const r of roots) {
    const rm = document.createElement('button'); rm.className = 'small'; rm.textContent = '×'; rm.title = '登録を解除（変換済みデータは残ります）';
    rm.onclick = async () => { try { await api('/api/roots/remove', { folder: r.folder }); loadCatalog(); } catch (e) { perr.textContent = String(e); } };
    const sp = document.createElement('span'); sp.textContent = r.folder; sp.title = r.folder;
    const row = document.createElement('div'); row.className = 'root'; row.append('📁', sp, rm); el.append(row);
  }
}
function mergeLists() {
  const server = projects.filter((p) => !p.kind.startsWith('local'));
  projects = [...localProjects, ...server];
  $('pcount').textContent = projects.length ? `${projects.length} 件` : '';
  renderList();
}
async function refreshStorage() {
  if (!serverOk) return;
  try {
    const s = await api('/api/storage');
    const pct = Math.min(100, 100 * s.cache_bytes / s.limit_bytes), low = s.free_bytes < 5e9;
    $('storage').innerHTML = `キャッシュ ${fmtSize(s.cache_bytes)} / 上限 ${fmtSize(s.limit_bytes)} · 空き ${fmtSize(s.free_bytes)}${low ? ' <span style="color:var(--danger)">（空き容量が少ない）</span>' : ''}<span class="bar"><i class="${low ? 'warn' : ''}" style="width:${pct}%"></i></span>`;
    $('cfgLimit').value = Math.round(s.limit_bytes / 1e9); $('cfgWorkers').value = s.workers;
    $('cfgInfo').textContent = `キャッシュ先: ${s.cache_dir}`;
  } catch {}
}
function addLocalFiles(files) {
  const found = localProjectsFromFiles(files);
  for (const f of found) { localProjects = localProjects.filter((p) => p.name !== f.name); localProjects.push(f); }
  localProjects.sort((a, b) => a.name.localeCompare(b.name));
  $('localStatus').textContent = found.length ? `${found.length} 件を追加` : 'iRIC プロジェクトが見つかりません（.ipro / project.xml を含むフォルダ / .cgn）';
  mergeLists();
}

// ---------------- list
const PH = { queued: '待機', start: '開始', extract: '展開', convert: '変換', finalize: '仕上げ', done: '完了', error: 'エラー', cancelled: '中止' };
function statusCell(p) {
  const td = document.createElement('span'); td.className = 'st';
  if (p.job) {
    const j = p.job, pct = j.nt ? Math.round(100 * j.step / j.nt) : 0;
    td.innerHTML = j.state === 'queued' ? '<span class="run">キュー待ち</span>' : `<span class="run">${PH[j.phase] || j.phase} ${j.nt ? pct + '%' : ''}</span> <span class="bar"><i style="width:${pct}%"></i></span>`;
    const c = document.createElement('button'); c.className = 'small'; c.textContent = '×'; c.title = '中止';
    c.onclick = async (e) => { e.stopPropagation(); await api('/api/jobs/cancel', { id: j.id }); loadCatalog(); };
    td.append(' ', c);
  } else if (p.converted || opened.has(p.name)) {
    const nt = p.meta ? `${p.meta.ni}×${p.meta.nj}·${p.meta.nt}` : '';
    const s = p.max_depth_m != null ? ` · 最大水深 ${p.max_depth_m.toFixed(2)} m` : '';
    td.innerHTML = `<span class="ok">済</span> ${nt}${s}`;
  } else if (p.error) td.innerHTML = `<span class="bad" title="${p.error}">エラー</span>`;
  else td.textContent = `未 ${fmtSize(p.size)}`;
  return td;
}
function renderList() {
  plist.replaceChildren();
  if (!projects.length) { plist.innerHTML = '<tr><td class="sub">iRIC プロジェクト（*.ipro または project.xml を含むフォルダ）が見つかりません</td></tr>'; return; }
  const KIND = { ipro: '.ipro', folder: 'ﾌｫﾙﾀﾞ', 'local-ipro': '.ipro', 'local-folder': 'ﾌｫﾙﾀﾞ', 'local-cgn': '.cgn' };
  for (const p of projects) {
    const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = selected.has(p.name);
    cb.addEventListener('change', () => { cb.checked ? selected.add(p.name) : selected.delete(p.name); updateButtons(); tr.classList.toggle('sel', cb.checked); });
    const tr = document.createElement('tr'); tr.classList.toggle('sel', cb.checked);
    const td0 = document.createElement('td'); td0.append(cb);
    const td1 = document.createElement('td'); td1.className = 'entry';
    const nm = document.createElement('div'); nm.className = 'name'; nm.textContent = p.name;
    const meta = document.createElement('div'); meta.className = 'meta';
    const kind = document.createElement('span'); kind.className = 'kind'; kind.textContent = `${KIND[p.kind] || p.kind}${p.kind.startsWith('local') ? '·ローカル' : ''} ${p.solver ? p.solver.slice(0, 12) : ''}`;
    meta.append(kind, ' ', statusCell(p));
    td1.append(nm, meta);
    tr.append(td0, td1);
    tr.title = [p.name, p.path, p.solver && `${p.solver} ${p.solverVersion || ''}`, p.crs, p.meta && `${p.meta.ni}×${p.meta.nj} 節点 · ${p.meta.nt} ステップ`, p.peak_area_m2 != null && `浸水面積 最大 ${(p.peak_area_m2 / 1e6).toFixed(3)} km²`, p.error].filter(Boolean).join('\n');
    tr.addEventListener('dblclick', () => { selected = new Set([p.name]); renderList(); openSelected('view'); });
    plist.append(tr);
  }
  updateButtons();
}
function updateButtons() {
  $('openOne').disabled = selected.size !== 1; $('openCompare').disabled = selected.size < 2;
  $('queueSel').disabled = ![...selected].some((n) => { const p = projects.find((x) => x.name === n); return p && !p.kind.startsWith('local') && !p.converted && !p.job; });
}

// ---------------- conversion jobs
function startPolling() {
  if (pollTimer) return;
  pollEmpty = 0;
  pollTimer = setInterval(async () => {
    try {
      const j = await api('/api/jobs');
      const live = new Map(j.jobs.filter((x) => x.state === 'queued' || x.state === 'running').map((x) => [x.name, x]));
      let changed = false;
      for (const p of projects) {
        const was = !!p.job, now = live.get(p.name);
        if (was && !now) changed = true;
        p.job = now ? { id: now.id, state: now.state, step: now.step, nt: now.nt, phase: now.phase } : null;
      }
      const running = j.jobs.filter((x) => x.state === 'running' || x.state === 'queued');
      convStatus.textContent = running.length ? `変換 ${running.filter((x) => x.state === 'running').length} 件実行中 / ${running.length - running.filter((x) => x.state === 'running').length} 件待ち` : '';
      if (changed) await loadCatalog(); else renderList();
      pollEmpty = live.size ? 0 : pollEmpty + 1;
      if (pollEmpty >= 3) { clearInterval(pollTimer); pollTimer = null; await loadCatalog(); }
    } catch {}
  }, 1500);
}
async function queueNames(names) {
  perr.textContent = '';
  try { const j = await api('/api/jobs', { names }); const bad = j.jobs.filter((x) => x.error); if (bad.length) perr.textContent = bad.map((x) => `${x.name}: ${x.error}`).join('\n'); await loadCatalog(); startPolling(); }
  catch (e) { perr.textContent = String(e); }
}
$('queueSel').onclick = () => queueNames([...selected].filter((n) => { const p = projects.find((x) => x.name === n); return p && !p.kind.startsWith('local') && !p.converted; }));
$('queueAll').onclick = () => queueNames(projects.filter((p) => !p.kind.startsWith('local') && !p.converted && !p.job && !p.error).map((p) => p.name));

/** Make sure every selected project is converted (browser or server queue), then return Project objects. */
async function ensureConverted(names) {
  for (const [k, name] of names.entries()) {
    const p = projects.find((x) => x.name === name);
    if (p.kind.startsWith('local')) {
      if (opened.has(name)) continue;
      const group = await openLocalProject(p, (msg, frac) => { convStatus.textContent = `変換 (${k + 1}/${names.length}) ${name}: ${msg} ${frac !== undefined ? Math.round(frac * 100) + '%' : ''}`; });
      opened.set(name, await Project.fromGroup(name, group));
      const A = group.attrs; p.meta = { ni: A.ni, nj: A.nj, nt: A.nt }; p.solver = A.solver; p.solverVersion = A.solverVersion; p.crs = A.crs; p.converted = true;
      continue;
    }
    if (p.converted) continue;
    try { const st = await api('/api/storage'); if (st.free_bytes < p.size * 1.5) perr.textContent = `注意: キャッシュ先 ${st.cache_dir} の空き容量 ${fmtSize(st.free_bytes)} が少なく、変換に失敗する可能性があります`; } catch {}
    const j = await api('/api/jobs', { names: [name] });
    if (j.jobs[0]?.error) throw new Error(j.jobs[0].error);
    startPolling();
    const t0 = Date.now();
    for (;;) {                       // wait for the job while showing progress
      await new Promise((r) => setTimeout(r, 1000));
      const s = await api(`/api/convert/status?name=${encodeURIComponent(name)}`);
      const el = `${Math.round((Date.now() - t0) / 1000)} 秒`;
      convStatus.textContent = `変換中 (${k + 1}/${names.length}): ${name} … ${PH[s.phase] || s.phase || ''}` + (s.nt ? ` ${s.step}/${s.nt} (${Math.round(100 * s.step / s.nt)} %)` : '') + ` · ${el}`;
      if (s.done) { if (s.error || (s.state && s.state !== 'done')) throw new Error(s.error || `変換が${PH[s.state] || s.state}になりました`); break; }
    }
    p.converted = true; p.job = null;
  }
  convStatus.textContent = ''; await loadCatalog();
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
    for (const g of Object.values(side)) if (g !== side.data) g.replaceChildren();
    $('grp-layout').hidden = mode !== 'compare';
    $('grp-data').open = false; $('grp-view').open = true; $('grp-analysis').open = true;
    const ctx = { stage, content: $('content'), side };
    mounted = mode === 'view' ? mountViewer(ctx, ps[0]) : mountCompare(ctx, ps);
    $('projName').textContent = names.join(' / '); $('projName').title = names.join('\n');
    $('modeChip').textContent = mode === 'view' ? '単一' : `比較 ${names.length} 件`; $('modeChip').hidden = false;
    document.title = mode === 'view' ? `${names[0]} – iRIC viewer` : `比較: ${names.join(', ')}`;
  } catch (e) { perr.textContent = String(e); console.error(e); convStatus.textContent = ''; $('grp-data').open = true; }
  updateButtons();
}

// ---------------- wiring
$('addRoot').onclick = async () => { const f = $('folder').value.trim(); if (!f) return; perr.textContent = ''; try { await api('/api/roots', { folder: f }); $('folder').value = ''; loadCatalog(); } catch (e) { perr.textContent = String(e); } };
$('folder').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('addRoot').click(); });
$('rescan').onclick = async () => { status.textContent = 'スキャン中…'; try { const j = await api('/api/scan', {}); status.textContent = `${j.found} 件を確認`; } catch (e) { perr.textContent = String(e); } loadCatalog(); };
$('pick').onclick = async () => { try { const j = await api('/api/pick-folder', { initial: $('folder').value }); if (j.folder) { $('folder').value = j.folder; $('addRoot').click(); } } catch (e) { perr.textContent = String(e); } };
$('find').addEventListener('input', () => { clearTimeout($('find')._t); $('find')._t = setTimeout(loadCatalog, 250); });
$('sort').addEventListener('change', loadCatalog);
$('sortDir').onclick = () => { sortDesc = !sortDesc; $('sortDir').textContent = sortDesc ? '↑' : '↓'; loadCatalog(); };
$('pickLocalFiles').onclick = () => { const inp = $('localFiles'); inp.value = ''; inp.click(); };
$('pickLocalDir').onclick = async () => { try { addLocalFiles(await pickDirectory($('localDir'))); } catch (e) { if (e.name !== 'AbortError') perr.textContent = String(e); } };
$('clearCache').onclick = async () => { await cacheClear(); $('localStatus').textContent = 'ブラウザ内キャッシュを削除しました'; };
$('localFiles').addEventListener('change', () => addLocalFiles([...$('localFiles').files]));
$('localDir').addEventListener('change', () => addLocalFiles([...$('localDir').files]));
$('openOne').onclick = () => openSelected('view');
$('openCompare').onclick = () => openSelected('compare');
$('cfgSave').onclick = async () => { try { await api('/api/config', { cache_limit_gb: +$('cfgLimit').value, workers: +$('cfgWorkers').value }); refreshStorage(); loadCatalog(); } catch (e) { perr.textContent = String(e); } };

// initial state
try { if (localStorage.getItem('iric.sidebar') === '0') setSidebar(false); } catch {}
const qs = new URLSearchParams(location.search);
loadCatalog().then(async () => {
  const folder = qs.get('folder');
  if (folder && serverOk && !roots.some((r) => r.folder.replace(/\\/g, '/').endsWith(folder.replace(/\\/g, '/').replace(/^\.\.\//, '')))) {
    try { await api('/api/roots', { folder }); await loadCatalog(); } catch (e) { perr.textContent = String(e); }
  }
  const auto = qs.get('open');
  if (auto) { selected = new Set(auto.split(',')); renderList(); openSelected(selected.size > 1 ? 'compare' : 'view'); }
});
