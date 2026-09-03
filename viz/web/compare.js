// Multi-project comparison as a configurable dashboard: an R x C grid of panels, each showing a
// case map, a difference map, an ensemble map, a chart (point / section / statistics) or the
// summary table. Presets reproduce the classic views; the layout is saved in localStorage.
import { MapView, drawLegend } from './mapview.js';
import { drawChart, PALETTE } from './charts.js';
import { h, select, labeled, check, num, timebar, fmt, fmtSig, downloadText } from './ui.js';
import { chartImage, snapshotMap, downloadReport, today } from './report.js';
import { BASEMAP_OPTIONS } from './viewer.js';

const CMAP_OPTIONS = [['0', 'viridis'], ['4', 'turbo'], ['1', 'jet'], ['2', 'blues'], ['3', 'terrain']];
const LS_KEY = 'iric.compare.layout';

export function mountCompare(container, projects) {
  const P = projects, ref = P[0], N = P.length;
  const sameGrid = P.every((p) => p.sameGridAs(ref));
  const nt = Math.min(...P.map((p) => p.nt));
  const timeArr = ref.timeArr;
  const varNames = ref.varNames.filter((k) => P.every((p) => p.varNames.includes(k)));
  const ui = { var: varNames.includes('Depth') ? 'Depth' : varNames[0], cmap: 2, dry: true, dryThr: 0.01, vec: false, basemap: ref.hasMerc ? 'gsi_pale' : 'none', opacity: 0.8,
    diffA: 0, diffB: Math.min(1, N - 1), ensemble: 'freq', clickMode: 'ts', panelH: 0 };
  let probe = null, pointSpec = null, statsSpec = null, sectionSpec = null, tableEl = null;
  const colors = P.map((_, k) => PALETTE[k % PALETTE.length]);

  // ---------------- panel kinds
  const KINDS = [
    ...P.map((p, k) => [`map:${k}`, `地図: ${p.name}`]),
    ['diff', '差分マップ (A − B)'], ['ens', '統合マップ'], ['point', 'グラフ: 地点時系列'], ['section', 'グラフ: 断面比較'], ['stats', 'グラフ: 統計時系列'], ['table', '要約表'], ['empty', '（空）'],
  ];
  const isMap = (kind) => kind.startsWith('map:') || kind === 'diff' || kind === 'ens';
  const PRESETS = {
    grid: () => { const cols = Math.min(N, 3); const cells = P.map((_, k) => `map:${k}`); while (cells.length % cols) cells.push('empty'); const row2 = ['point', 'stats', 'table'].slice(0, cols); while (row2.length < cols) row2.push('empty'); return { rows: Math.ceil(N / cols) + 1, cols, cells: cells.concat(row2) }; },
    diff: () => ({ rows: 1, cols: 2, cells: ['diff', 'section'] }),
    ens: () => ({ rows: 1, cols: 2, cells: ['ens', 'stats'] }),
    stats: () => ({ rows: 1, cols: 2, cells: ['stats', 'table'] }),
  };
  let layout = null;
  try { const saved = JSON.parse(localStorage.getItem(LS_KEY) || 'null'); if (saved && saved.n === N && saved.rows && saved.cols && Array.isArray(saved.cells)) layout = saved; } catch {}
  if (!layout) layout = PRESETS.grid();
  const saveLayout = () => { try { localStorage.setItem(LS_KEY, JSON.stringify({ ...layout, n: N })); } catch {} };

  // ---------------- controls
  const tabs = [['grid', '並列表示'], ['diff', '差分'], ['ens', '統合解析'], ['stats', '統計比較']].map(([m, label]) => h('button', { onclick: () => applyLayout(PRESETS[m]()) }, label));
  const varSel = select(varNames.map((k) => [k, ref.label(k)]), ui.var, (v) => { ui.var = v; ui.cmap = v === 'Depth' ? 2 : 0; cmapSel.value = String(ui.cmap); render(); if (probe) onProbe(); });
  const cmapSel = select(CMAP_OPTIONS, String(ui.cmap), (v) => { ui.cmap = +v; render(); });
  const bmSel = select(BASEMAP_OPTIONS, ui.basemap, (v) => { ui.basemap = v; render(); }); bmSel.disabled = !ref.hasMerc;
  const opacity = h('input', { type: 'range', min: 0, max: 1, step: 0.05, value: ui.opacity, style: 'width:120px', oninput: (e) => { ui.opacity = +e.target.value; render(); } });
  const projOpts = P.map((p, k) => [String(k), p.name]);
  const selA = select(projOpts, String(ui.diffA), (v) => { ui.diffA = +v; render(); }), selB = select(projOpts, String(ui.diffB), (v) => { ui.diffB = +v; render(); });
  const ensSel = select([['freq', '浸水頻度（浸水したケースの割合）'], ['envmax', '包絡最大水深（全ケースの最大）'], ['envmin', '最小の最大水深'], ['arrmin', '最早到達時間'], ['arrspread', '到達時間の幅（最遅 − 最早）']], 'freq', (v) => { ui.ensemble = v; render(); });
  const clickSel = select([['ts', '地点時系列'], ['xs', '横断面（i 一定, j 方向）'], ['ls', '縦断面（j 一定, i 方向）']], 'ts', (v) => { ui.clickMode = v; if (probe) onProbe(); render(); });
  const prog = h('span', { class: 'sub' }), err = h('div', { class: 'err' }), info = h('div', { class: 'stats' });
  const btnRun = h('button', { onclick: () => runAll().catch((e) => { err.textContent = String(e); }) }, '全ケース解析（浸水面積・到達時間）');
  const btnReport = h('button', { class: 'primary', onclick: () => makeReport().catch((e) => { err.textContent = String(e); prog.textContent = ''; }) }, 'レポート (pptx)');
  const btnCsv = h('button', { onclick: exportCsv }, 'CSV 出力');
  const ctl = h('div', { class: 'ctl' },
    h('div', { class: 'tabs' }, tabs), labeled('変数', varSel), labeled('カラーマップ', cmapSel), labeled('背景地図', bmSel), labeled('不透明度', opacity),
    check('乾燥セルを透過/グレー', true, (v) => { ui.dry = v; render(); }), h('div', { class: 'row' }, '閾値', num(0.01, 0.01, (v) => { ui.dryThr = v; render(); }, 70)),
    check('流速ベクトル', false, (v) => { ui.vec = v; render(); }), labeled('クリック動作', clickSel),
    labeled('差分 A', selA), h('span', { style: 'padding-bottom:6px' }, '−'), labeled('B', selB), labeled('統合指標', ensSel),
    btnRun, prog, btnReport, btnCsv);

  // layout editor
  const rowsIn = num(layout.rows, 1, (v) => setGridSize(v, layout.cols), 56), colsIn = num(layout.cols, 1, (v) => setGridSize(layout.rows, v), 56);
  const panelHIn = num(0, 20, (v) => { ui.panelH = Math.max(0, v | 0); layoutPanels(); render(); drawAllCharts(); }, 70);
  const cellEditor = h('div', { class: 'cells' });
  const layoutBox = h('details', { class: 'layoutbox' }, h('summary', {}, 'レイアウト'),
    h('div', { class: 'row', style: 'margin:6px 0' }, '行', rowsIn, '× 列', colsIn, h('span', { class: 'sub' }, '　パネル高さ [px]（0 = 自動）'), panelHIn,
      h('span', { class: 'sub' }, '　各パネルの内容:'), cellEditor));
  function rebuildCellEditor() {
    cellEditor.replaceChildren();
    cellEditor.style.gridTemplateColumns = `repeat(${layout.cols}, auto)`;
    layout.cells.forEach((kind, k) => cellEditor.append(select(KINDS, kind, (v) => { layout.cells[k] = v; applyLayout(layout); })));
  }
  function setGridSize(rows, cols) {
    rows = Math.min(4, Math.max(1, rows | 0)); cols = Math.min(4, Math.max(1, cols | 0));
    const cells = [];
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) { const old = (r < layout.rows && c < layout.cols) ? layout.cells[r * layout.cols + c] : null; cells.push(old || 'empty'); }
    applyLayout({ rows, cols, cells });
  }

  const tb = timebar(nt, timeArr, () => render());
  const grid = h('div', { class: 'mapgrid' });
  const legendBar = h('canvas', { width: 256, height: 1 }), lmin = h('span'), lmax = h('span'), lunit = h('span');
  const rootEl = h('div', { class: 'compare' }, ctl, layoutBox, tb.el, grid, h('div', { class: 'legend' }, lmin, legendBar, lmax, lunit, h('span', { class: 'sub' }, sameGrid ? '' : '※ 格子が異なるため差分・統合マップ・地点/断面比較は使えません（統計比較のみ）')), info, err);
  container.replaceChildren(rootEl);

  // ---------------- panels
  const slots = [];              // { kind, el, view?, canvas? }
  let syncing = false, sharedView = null;
  const onViewChange = (v, src) => { sharedView = { ...v }; if (syncing) return; syncing = true; for (const s of slots) if (s.view && s.view !== src) { s.view.setView(v); s.view.rerender(); } syncing = false; };
  const onClick = (i, j) => { probe = { i, j }; onProbe(); render(); };
  const onProbe = () => (ui.clickMode === 'ts' ? buildPoint() : buildSection());
  const sectionLine = () => (probe && sameGrid && ui.clickMode !== 'ts') ? ref.sectionNodes(probe.i, probe.j, ui.clickMode) : null;

  function applyLayout(L) {
    layout = { rows: L.rows, cols: L.cols, cells: L.cells.slice(0, L.rows * L.cols) };
    while (layout.cells.length < layout.rows * layout.cols) layout.cells.push('empty');
    rowsIn.value = layout.rows; colsIn.value = layout.cols; saveLayout(); rebuildCellEditor();
    for (const s of slots) if (s.view) s.view.destroy();
    slots.length = 0; grid.replaceChildren();
    grid.style.gridTemplateColumns = `repeat(${layout.cols}, minmax(0, 1fr))`;
    for (const kind of layout.cells) {
      const el = h('div', { class: 'panel' }); grid.append(el);
      const s = { kind, el };
      if (isMap(kind)) { s.view = new MapView(el, { onViewChange, onClick, onError: (e) => { err.textContent = String(e); } }); s.view.setProject(ref); }
      else if (kind === 'point' || kind === 'section' || kind === 'stats') { s.canvas = h('canvas', { class: 'chart' }); el.append(s.canvas); }
      else if (kind === 'table') { el.classList.add('tablepanel'); }
      slots.push(s);
    }
    layoutPanels();
    const first = slots.find((s) => s.view);
    if (first) { if (sharedView) first.view.setView(sharedView); else first.view.fit(unionBbox()); for (const s of slots) if (s.view) s.view.setView(first.view.view); }
    render(); drawAllCharts(); fillTables();
  }
  function unionBbox() { const b = P.map((p) => p.bbox); return [Math.min(...b.map((x) => x[0])), Math.min(...b.map((x) => x[1])), Math.max(...b.map((x) => x[2])), Math.max(...b.map((x) => x[3]))]; }
  function layoutPanels() {
    const r = grid.getBoundingClientRect();
    const avail = Math.max(240, window.innerHeight - r.top - 110);
    const cellH = ui.panelH || Math.max(220, Math.floor((avail - 8 * (layout.rows - 1)) / layout.rows));
    const cellW = Math.floor((grid.clientWidth - 8 * (layout.cols - 1)) / layout.cols);
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    for (const s of slots) {
      s.el.style.height = `${cellH}px`;
      if (s.view) s.view.resize(cellW, cellH);
      if (s.canvas) { s.canvas.style.height = `${cellH}px`; s.canvas.width = Math.round(cellW * dpr); s.canvas.height = Math.round(cellH * dpr); }
    }
  }
  const onResize = () => { layoutPanels(); render(); drawAllCharts(); };
  window.addEventListener('resize', onResize);
  layoutBox.addEventListener('toggle', onResize);

  // ---------------- data helpers
  const globalRange = (key) => { let lo = Infinity, hi = -Infinity; for (const p of P) { const [a, b] = p.range(key); lo = Math.min(lo, a); hi = Math.max(hi, b); } return [lo, hi]; };
  async function frame(p, t, key) {
    const wantVel = ui.vec && p.hasVel;
    const [values, depth, u, w] = await Promise.all([p.get(key, t), p.arrays.Depth ? p.get('Depth', t) : null, wantVel ? p.get('Velocity_ms_1_X', t) : null, wantVel ? p.get('Velocity_ms_1_Y', t) : null]);
    return { values, depth, u, w };
  }
  const base = (t) => ({ t, dryThr: ui.dryThr, vec: ui.vec, vecStep: 3, vecScale: 6, basemap: ui.basemap, opacity: ui.opacity, probe, line: sectionLine() });
  const analysed = () => P.every((p) => p.analysis.done);

  /** Difference field A - B at step t (nodes wet in either case). */
  async function diffField(A, B, t, key) {
    const [fa, fb] = await Promise.all([frame(A, t, key), frame(B, t, key)]);
    const n = ref.N, diff = new Float32Array(n), mask = new Float32Array(n);
    let maxAbs = 0, sum = 0, sum2 = 0, cnt = 0, wetA = 0, wetB = 0, both = 0;
    for (let k = 0; k < n; k++) {
      const wa = fa.depth ? fa.depth[k] > ui.dryThr : true, wb = fb.depth ? fb.depth[k] > ui.dryThr : true;
      mask[k] = (wa || wb) ? 1 : 0; if (wa) wetA++; if (wb) wetB++; if (wa && wb) both++;
      const d = fa.values[k] - fb.values[k]; diff[k] = d;
      if ((wa || wb) && Number.isFinite(d)) { const ad = Math.abs(d); if (ad > maxAbs) maxAbs = ad; sum += d; sum2 += d * d; cnt++; }
    }
    const iou = (wetA + wetB - both) ? both / (wetA + wetB - both) : 1;
    return { diff, mask, maxAbs, mean: sum / (cnt || 1), rms: Math.sqrt(sum2 / (cnt || 1)), wetA, wetB, iou };
  }

  // ---------------- rendering
  let rendering = false, pending = false;
  async function render() {
    if (rendering) { pending = true; return; }
    rendering = true;
    try {
      const t = Math.min(tb.t, nt - 1), key = ui.var;
      const [lo, hi] = globalRange(key);
      const lines = [`t = ${timeArr[t]} s   ${ref.label(key)} 共通レンジ ${fmtSig(lo)} – ${fmtSig(hi)} ${ref.unit(key)}`];
      let legend = { cmap: ui.cmap, lo, hi, unit: `${ref.label(key)} [${ref.unit(key)}]` };
      const frames = new Map();
      const getFrame = async (p) => { if (!frames.has(p)) frames.set(p, await frame(p, t, key)); return frames.get(p); };
      for (const s of slots) {
        if (!s.view) continue;
        if (s.kind.startsWith('map:')) {
          const p = P[+s.kind.slice(4)]; const f = await getFrame(p);
          s.view.setProject(p);
          s.view.draw({ ...base(t), ...f, label: p.label(key), unit: p.unit(key), cmap: ui.cmap, vmin: lo, vmax: hi, dryMask: ui.dry, title: p.name });
        } else if (s.kind === 'diff') {
          if (!sameGrid) { s.view.titleEl.textContent = '格子が異なるため差分不可'; s.view.titleEl.hidden = false; continue; }
          const A = P[ui.diffA], B = P[ui.diffB]; const D = await diffField(A, B, t, key); const lim = D.maxAbs || 1;
          s.view.setProject(A);
          s.view.draw({ ...base(t), values: D.diff, depth: D.mask, u: null, w: null, label: `Δ${A.label(key)} (A−B)`, unit: A.unit(key), cmap: 5, vmin: -lim, vmax: lim, dryMask: ui.dry, dryThr: 0.5, title: `差分 ${A.name} − ${B.name}` });
          legend = { cmap: 5, lo: -lim, hi: lim, unit: `Δ${ref.label(key)} [${ref.unit(key)}]（赤: A が大きい / 青: B が大きい）` };
          lines.push(`差分 A=${A.name}, B=${B.name}: 平均差 ${fmt(D.mean)}, RMS ${fmt(D.rms)}, 最大|差| ${fmt(D.maxAbs)} ${ref.unit(key)}, 湿潤節点 A ${D.wetA} / B ${D.wetB}, 一致率(IoU) ${(100 * D.iou).toFixed(1)} %`);
        } else if (s.kind === 'ens') {
          if (!sameGrid || !analysed()) { s.view.titleEl.textContent = !sameGrid ? '格子が異なるため統合マップ不可' : '統合マップ: 「全ケース解析」を実行してください'; s.view.titleEl.hidden = false; continue; }
          const E = ensembleField(ui.ensemble);
          s.view.setProject(ref);
          s.view.draw({ ...base(t), values: E.data, depth: null, u: null, w: null, label: E.label, unit: E.unit, cmap: E.cmap, vmin: E.lo, vmax: E.hi, dryMask: false, title: E.label });
          legend = { cmap: E.cmap, lo: E.lo, hi: E.hi, unit: `${E.label} [${E.unit}]` };
          lines.push(E.info);
        }
      }
      drawLegend(legendBar, legend.cmap); lmin.textContent = fmtSig(legend.lo); lmax.textContent = fmtSig(legend.hi); lunit.textContent = legend.unit;
      info.textContent = lines.join('\n');
      if (probe && slots.some((s) => s.kind === 'section')) await buildSection();   // section follows the current step
      drawAllCharts();
    } catch (e) { err.textContent = String(e); console.error(e); }
    rendering = false;
    if (pending) { pending = false; render(); }
  }

  /** Ensemble fields across projects (same grid). */
  const ensCache = {};
  function ensembleField(kind) {
    if (ensCache[kind]) return ensCache[kind];
    const n = ref.N, m = P.length, data = new Float32Array(n);
    const arr = P.map((p) => p.analysis.arrival), dmax = P.map((p) => p.dmaxFinal);
    let lo = Infinity, hi = -Infinity, cnt = 0;
    for (let k = 0; k < n; k++) {
      let v;
      if (kind === 'freq') { let c = 0; for (let q = 0; q < m; q++) if (Number.isFinite(arr[q][k])) c++; v = c ? c / m : NaN; }
      else if (kind === 'envmax') { v = -Infinity; for (let q = 0; q < m; q++) if (dmax[q][k] > ui.dryThr) v = Math.max(v, dmax[q][k]); if (v === -Infinity) v = NaN; }
      else if (kind === 'envmin') { v = Infinity; for (let q = 0; q < m; q++) v = Math.min(v, dmax[q][k] > ui.dryThr ? dmax[q][k] : 0); if (v <= 0) v = NaN; }
      else if (kind === 'arrmin') { v = Infinity; for (let q = 0; q < m; q++) if (Number.isFinite(arr[q][k])) v = Math.min(v, arr[q][k]); if (v === Infinity) v = NaN; }
      else { let a = Infinity, b = -Infinity; for (let q = 0; q < m; q++) if (Number.isFinite(arr[q][k])) { a = Math.min(a, arr[q][k]); b = Math.max(b, arr[q][k]); } v = a === Infinity ? NaN : b - a; }
      data[k] = v; if (Number.isFinite(v)) { lo = Math.min(lo, v); hi = Math.max(hi, v); cnt++; }
    }
    const meta = { freq: ['浸水頻度', '-', 4], envmax: ['包絡最大水深', 'm', 2], envmin: ['最小の最大水深', 'm', 2], arrmin: ['最早到達時間', 'min', 4], arrspread: ['到達時間の幅', 'min', 4] }[kind];
    if (kind === 'freq') { lo = 0; hi = 1; }
    const E = { data, lo, hi, label: meta[0], unit: meta[1], cmap: meta[2], info: `${meta[0]}: 対象節点 ${cnt} / ${n}（${m} ケース）` };
    if (kind === 'freq') { const all = data.reduce((s, v) => s + (v >= 0.999 ? 1 : 0), 0); E.info += `   全ケースで浸水 ${all} 節点 / いずれかで浸水 ${cnt} 節点`; }
    ensCache[kind] = E; return E;
  }

  // ---------------- analysis
  async function runAll() {
    btnRun.disabled = true;
    for (const p of P) {
      if (!p.analysis.done) await p.runAnalysis(ui.dryThr, (a, b) => { prog.textContent = `解析中 ${p.name} ${a}/${b}`; });
      if (!p.dmaxFinal) p.dmaxFinal = p.arrays.Depth_Max ? await p.get('Depth_Max', p.nt - 1) : await p.get('Depth', p.nt - 1);
    }
    for (const k of Object.keys(ensCache)) delete ensCache[k];
    prog.textContent = `解析完了（閾値 ${ui.dryThr} m）`; btnRun.disabled = false;
    buildStats(); buildTable(); fillTables(); drawAllCharts(); render();
  }
  function buildStats() {
    const x = Array.from(timeArr).slice(0, nt), ser = (f, c) => P.map((p, k) => ({ name: p.name, y: p.analysis.series[f].slice(0, nt).map(c), color: colors[k] }));
    statsSpec = { panels: [
      { title: '浸水面積 [km²]', x, series: ser('area', (v) => v / 1e6), xlabel: 't [s]', legend: true },
      { title: '貯留量 [10³ m³]', x, series: ser('vol', (v) => v / 1e3), xlabel: 't [s]' },
      { title: '最大水深 [m]', x, series: ser('maxd', (v) => v), xlabel: 't [s]' },
      { title: '最大流速 [m/s]', x, series: ser('maxv', (v) => v), xlabel: 't [s]' },
    ] };
  }
  const SUMMARY_HEADER = ['ケース', '浸水面積 最大 [km²]', '最大時刻 [s]', '領域比 [%]', '最終浸水面積 [km²]', '貯留量 最大 [10³ m³]', '最大水深 [m]', '最大流速 [m/s]', '浸水節点数'];
  function summaryRows() {
    return P.map((p) => { const S = p.analysis.summary; return [p.name, (S.peakArea / 1e6).toFixed(3), S.peakAreaTime, (100 * S.peakAreaFrac).toFixed(1), (S.finalArea / 1e6).toFixed(3), (S.peakVolume / 1e3).toFixed(1), S.maxDepth.toFixed(3), S.maxSpeed.toFixed(3), `${S.everWet}`]; });
  }
  function buildTable() {
    if (!analysed()) return;
    const rows = summaryRows();
    const tbl = h('table', { class: 'summary' }, h('thead', {}, h('tr', {}, SUMMARY_HEADER.map((x) => h('th', {}, x)))), h('tbody', {}, rows.map((r) => h('tr', {}, r.map((c) => h('td', {}, c))))));
    const rel = P.slice(1).map((p) => { const a = P[0].analysis.summary, b = p.analysis.summary; return [`${p.name} / ${P[0].name}`, `${(100 * (b.peakArea / a.peakArea - 1)).toFixed(1)} %`, `${(100 * (b.peakVolume / a.peakVolume - 1)).toFixed(1)} %`, `${(100 * (b.maxDepth / a.maxDepth - 1)).toFixed(1)} %`, `${(100 * (b.maxSpeed / a.maxSpeed - 1)).toFixed(1)} %`]; });
    const tbl2 = rel.length ? h('table', { class: 'summary', style: 'margin-top:6px' }, h('thead', {}, h('tr', {}, ['基準との比', '浸水面積', '貯留量', '最大水深', '最大流速'].map((x) => h('th', {}, x)))), h('tbody', {}, rel.map((r) => h('tr', {}, r.map((c) => h('td', {}, c)))))) : null;
    tableEl = h('div', {}, h('div', { class: 'sub', style: 'margin-bottom:4px' }, '要約（全ケース解析）'), tbl, tbl2 || '');
  }
  function fillTables() {
    for (const s of slots) if (s.kind === 'table') s.el.replaceChildren(tableEl ? tableEl.cloneNode(true) : h('div', { class: 'sub', style: 'padding:8px' }, '「全ケース解析」を実行すると要約表を表示します。'));
  }
  async function buildPoint() {
    if (!probe || !sameGrid) { pointSpec = null; return; }
    const { i, j } = probe, key = ui.var, k0 = ref.node(i, j);
    const ys = await Promise.all(P.map((p) => p.timeseries(key, k0)));
    pointSpec = { x: Array.from(timeArr).slice(0, nt), series: P.map((p, k) => ({ name: p.name, y: Array.from(ys[k]).slice(0, nt), color: colors[k] })), xlabel: 't [s]', title: `地点時系列 ${ref.label(key)} [${ref.unit(key)}]  i=${i + 1}, j=${j + 1}`, legend: true };
    drawAllCharts();
  }
  /** Cross / longitudinal section at the probe for the current step: bed + water surface of every case, plus the selected variable. */
  async function buildSection() {
    if (!probe || !sameGrid || ui.clickMode === 'ts') return;
    const { i, j } = probe, mode = ui.clickMode, t = Math.min(tb.t, nt - 1), key = ui.var;
    const nodes = ref.sectionNodes(i, j, mode), x = ref.distances(nodes);
    const elev = ref.arrays.Elevation ? await ref.get('Elevation', t) : null;
    const data = await Promise.all(P.map(async (p) => ({
      wse: p.arrays.WaterSurfaceElevation ? await p.get('WaterSurfaceElevation', t) : null,
      depth: p.arrays.Depth ? await p.get('Depth', t) : null, v: await p.get(key, t) })));
    const label = mode === 'xs' ? `横断面 i=${i + 1}（j=1→${ref.nj}）` : `縦断面 j=${j + 1}（i=1→${ref.ni}）`;
    const marker = x[mode === 'xs' ? j : i];
    const s1 = [];
    if (elev) s1.push({ name: '河床標高', y: nodes.map((n) => elev[n]), color: '#8c6d31', fill: true });
    P.forEach((p, k) => { if (data[k].wse) s1.push({ name: `${p.name} 水位`, y: nodes.map((n) => (data[k].depth && data[k].depth[n] <= ui.dryThr) ? NaN : data[k].wse[n]), color: colors[k] }); });
    const panels = [{ x, xlabel: '距離 [m]', marker, title: `${label}  t=${timeArr[t]} s  河床標高・水位 [m]`, series: s1, legend: true }];
    if (!['Elevation', 'WaterSurfaceElevation'].includes(key)) panels.push({ x, xlabel: '距離 [m]', marker, title: `${ref.label(key)} [${ref.unit(key)}]`, series: P.map((p, k) => ({ name: p.name, y: nodes.map((n) => data[k].v[n]), color: colors[k] })), legend: true });
    sectionSpec = { panels, cols: 1, label, mode, t, length: x[x.length - 1] };
  }
  function drawAllCharts() {
    const dpr = Math.min(2, window.devicePixelRatio || 1), marker = timeArr[Math.min(tb.t, nt - 1)];
    for (const s of slots) {
      if (!s.canvas) continue;
      const cssW = s.canvas.width / dpr, wide = cssW >= 1000;
      if (s.kind === 'point') drawChart(s.canvas, pointSpec ? { ...pointSpec, marker } : null, dpr, sameGrid ? '地点時系列: クリック動作を「地点時系列」にして地図をクリック' : '格子が異なるため地点比較はできません。');
      else if (s.kind === 'section') drawChart(s.canvas, sectionSpec ? { ...sectionSpec, cols: cssW >= 800 ? sectionSpec.panels.length : 1 } : null, dpr, sameGrid ? '断面比較: クリック動作を「横断面」「縦断面」にして地図をクリック' : '格子が異なるため断面比較はできません。');
      else drawChart(s.canvas, statsSpec ? { panels: statsSpec.panels.map((q) => ({ ...q, marker })), cols: wide ? 4 : 2 } : null, dpr, '統計時系列: 「全ケース解析」を実行してください');
    }
  }
  function exportCsv() {
    const kinds = new Set(slots.map((s) => s.kind));
    if (statsSpec && kinds.has('stats')) {
      const head = ['time_s', ...P.flatMap((p) => ['area_m2', 'volume_m3', 'max_depth_m', 'max_speed_ms'].map((c) => `${p.name}:${c}`))];
      const rows = Array.from({ length: nt }, (_, t) => [timeArr[t], ...P.flatMap((p) => { const s = p.analysis.series; return [s.area[t].toFixed(1), s.vol[t].toFixed(1), s.maxd[t].toFixed(4), s.maxv[t].toFixed(4)]; })]);
      downloadText('compare_stats.csv', head.join(',') + '\n' + rows.map((r) => r.join(',')).join('\n'));
    }
    if (sectionSpec && kinds.has('section')) {
      const x = sectionSpec.panels[0].x, ser = sectionSpec.panels.flatMap((q, qi) => q.series.map((s) => ({ ...s, name: qi ? `${q.title}:${s.name}` : s.name })));
      downloadText(`compare_${sectionSpec.mode}_i${probe.i + 1}_j${probe.j + 1}_t${sectionSpec.t}.csv`, ['distance_m', ...ser.map((s) => s.name)].join(',') + '\n' + x.map((v, k) => [v, ...ser.map((s) => s.y[k])].join(',')).join('\n'));
    }
    if (pointSpec && kinds.has('point')) {
      downloadText(`compare_point_i${probe.i + 1}_j${probe.j + 1}.csv`, ['time_s', ...pointSpec.series.map((s) => s.name)].join(',') + '\n' + pointSpec.x.map((x, k) => [x, ...pointSpec.series.map((s) => s.y[k])].join(',')).join('\n'));
    }
  }

  // ---------------- report
  async function makeReport() {
    tb.stop(); err.textContent = ''; prog.textContent = 'レポート作成中…';
    if (!analysed()) await runAll();
    const t = Math.min(tb.t, nt - 1), key = ui.var, [lo, hi] = globalRange(key);
    const shot = { w: 1200, h: 720, view: null };
    const sections = [];
    sections.push({ title: '比較対象の計算ケース', table: { header: ['ケース', 'ソルバー', '格子', 'ステップ', '座標系', '領域面積 [km²]'], rows: P.map((p) => [p.name, `${p.A.solver || ''} ${p.A.solverVersion || ''}`, `${p.ni}×${p.nj}`, p.nt, p.A.crs || '-', (p.totalArea / 1e6).toFixed(3)]) },
      bullets: [`比較変数: ${ref.label(key)}`, `表示時刻: t = ${timeArr[t]} s`, `湿潤判定閾値: 水深 > ${ui.dryThr} m`, sameGrid ? '全ケースが同一格子（節点単位で比較可能）' : '格子が異なるため統計比較のみ'] });
    const imgs = [];
    for (const p of P) { const f = await frame(p, t, key); imgs.push({ dataUrl: await snapshotMap(p, { ...base(t), ...f, label: p.label(key), unit: p.unit(key), cmap: ui.cmap, vmin: lo, vmax: hi, dryMask: ui.dry, title: p.name, probe: null }, shot), caption: `${p.name}  ${p.label(key)}  t = ${timeArr[t]} s` }); }
    sections.push({ title: `並列表示: ${ref.label(key)}（共通レンジ ${fmtSig(lo)} – ${fmtSig(hi)} ${ref.unit(key)}）`, images: imgs });
    if (sameGrid) {
      const dimgs = [], dbul = [];
      for (let m = 1; m < P.length; m++) {
        const A = P[m], B = P[0]; const D = await diffField(A, B, t, key); const lim = D.maxAbs || 1;
        dimgs.push({ dataUrl: await snapshotMap(A, { ...base(t), values: D.diff, depth: D.mask, u: null, w: null, label: 'Δ', unit: A.unit(key), cmap: 5, vmin: -lim, vmax: lim, dryMask: ui.dry, dryThr: 0.5, title: `${A.name} − ${B.name}`, probe: null }, shot), caption: `${A.name} − ${B.name}  (±${fmtSig(lim)} ${A.unit(key)})` });
        dbul.push(`${A.name} − ${B.name}: 平均差 ${fmt(D.mean)} ${A.unit(key)}, RMS ${fmt(D.rms)}, 最大|差| ${fmt(D.maxAbs)} ${A.unit(key)}, 湿潤範囲の一致率 ${(100 * D.iou).toFixed(1)} %`);
      }
      sections.push({ title: `差分マップ: ${ref.label(key)}  t = ${timeArr[t]} s（赤: 対象ケースが大きい）`, images: dimgs, bullets: dbul });
      const eimgs = [];
      for (const kind of ['freq', 'envmax', 'arrmin', 'arrspread']) { const E = ensembleField(kind); eimgs.push({ dataUrl: await snapshotMap(ref, { ...base(t), values: E.data, depth: null, u: null, w: null, label: E.label, unit: E.unit, cmap: E.cmap, vmin: E.lo, vmax: E.hi, dryMask: false, title: E.label, probe: null }, shot), caption: `${E.label} [${E.unit}]  ${fmtSig(E.lo)} – ${fmtSig(E.hi)}` }); }
      sections.push({ title: '統合解析（全ケースの重ね合わせ）', images: eimgs, bullets: [ensembleField('freq').info] });
    }
    sections.push({ title: '統計比較（浸水面積・貯留量・最大水深・最大流速）', images: [{ dataUrl: chartImage(statsSpec, 1600, 560) }], table: { header: SUMMARY_HEADER, rows: summaryRows() } });
    if (pointSpec) sections.push({ title: pointSpec.title, images: [{ dataUrl: chartImage({ ...pointSpec, marker: timeArr[t] }) }] });
    if (sectionSpec) { await buildSection(); sections.push({ title: `断面比較: ${sectionSpec.label}  t = ${timeArr[sectionSpec.t]} s`, bullets: [`断面長 ${sectionSpec.length.toFixed(0)} m`, '水位は各ケースの乾燥部（水深 ≤ 閾値）を非表示', '並列表示の画像に断面位置（赤線）を表示'], images: [{ dataUrl: chartImage({ ...sectionSpec, cols: sectionSpec.panels.length }, 1600, 560) }] }); }
    const bytes = await downloadReport({ title: 'iRIC 計算結果 比較レポート', subtitle: `${P.map((p) => p.name).join(' / ')}\n作成日 ${today()}`, sections }, `compare_report_${today()}.pptx`);
    prog.textContent = `レポートをダウンロードしました (${(bytes / 1024).toFixed(0)} KB)`;
  }

  applyLayout(layout);
  tb.set(Math.min(nt - 1, 90));
  return { destroy() { tb.stop(); window.removeEventListener('resize', onResize); for (const s of slots) if (s.view) s.view.destroy(); container.replaceChildren(); } };
}
