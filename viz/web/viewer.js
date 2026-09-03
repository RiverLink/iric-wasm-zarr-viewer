// Single-project viewer (layout A): controls in the sidebar groups, full-size map with in-map overlays,
// timeline under the map and a bottom / right drawer for charts (time series, section, statistics).
import { MapView } from './mapview.js';
import { drawChart } from './charts.js';
import { h, select, labeled, check, num, timebar, drawer, observeSize, fmt, fmtSig, downloadText } from './ui.js';
import { chartImage, downloadReport, today } from './report.js';

export const CMAP_OPTIONS = [['0', 'viridis'], ['4', 'turbo'], ['1', 'jet'], ['2', 'blues'], ['3', 'terrain'], ['5', 'RdBu']];
export const BASEMAP_OPTIONS = [['gsi_pale', '地理院 淡色地図'], ['gsi_std', '地理院 標準地図'], ['gsi_photo', '地理院 航空写真'], ['gsi_hill', '地理院 陰影起伏図'], ['osm', 'OpenStreetMap'], ['none', 'なし']];

/** Global maximum speed of a project (for automatic arrow scaling). */
export function velMax(p) {
  if (!p.hasVel) return 1;
  if (p.arrays.Velocity_magnitude_Max) return Math.max(1e-6, p.range('Velocity_magnitude_Max')[1]);
  const [a, b] = p.range('Velocity_ms_1_X'), [c, d] = p.range('Velocity_ms_1_Y');
  return Math.max(1e-6, Math.hypot(Math.max(Math.abs(a), Math.abs(b)), Math.max(Math.abs(c), Math.abs(d))));
}

export function mountViewer({ stage, content, side }, project) {
  const p = project;
  const ui = { var: p.varNames.includes('Depth') ? 'Depth' : p.varNames[0], cmap: 2, range: 'global', vmin: 0, vmax: 1, dry: true, dryThr: 0.01,
    vec: p.hasVel, vecStep: 3, vecScale: 6, vecAuto: true, grid: false, basemap: p.hasMerc ? 'gsi_pale' : 'none', opacity: 0.8, clickMode: 'ts', place: 'below' };
  const vmaxGlobal = velMax(p);
  try { ui.place = localStorage.getItem('iric.viewer.place') || 'below'; } catch {}
  if (ui.var !== 'Depth') ui.cmap = 0;
  let probe = null;
  const charts = { ts: null, section: null, stats: null };   // specs per drawer tab
  const info = { ts: '', section: '', stats: '' };

  // ---------------- sidebar: 表示
  const varSel = select(p.varNames.map((k) => [k, p.label(k)]), ui.var, (v) => { ui.var = v; render(); if (probe) onProbe(probe.i, probe.j); });
  const cmapSel = select(CMAP_OPTIONS, String(ui.cmap), (v) => { ui.cmap = +v; render(); });
  const rangeSel = select([['global', '全ステップの最小/最大'], ['step', '現ステップの最小/最大'], ['manual', '手動']], 'global', (v) => { ui.range = v; if (v === 'manual') { ui.vmin = +vmin.value; ui.vmax = +vmax.value; } render(); });
  const vmin = num(0, 'any', (v) => { ui.vmin = v; render(); }), vmax = num(1, 'any', (v) => { ui.vmax = v; render(); });
  const bmSel = select(BASEMAP_OPTIONS, ui.basemap, (v) => { ui.basemap = v; render(); }); bmSel.disabled = !p.hasMerc;
  const opacity = h('input', { type: 'range', min: 0, max: 1, step: 0.05, value: ui.opacity, style: 'flex:1', oninput: (e) => { ui.opacity = +e.target.value; render(); } });
  const stats = h('div', { class: 'stats' }), err = h('div', { class: 'err' });
  const vecScaleIn = num(6, 1, (v) => { ui.vecScale = v; render(); }, 56); vecScaleIn.disabled = true; vecScaleIn.title = 'px / (m/s)';
  side.view.replaceChildren(
    labeled('変数', varSel), labeled('カラーマップ', cmapSel), labeled('レンジ', rangeSel),
    h('div', { class: 'row' }, 'min', vmin, 'max', vmax),
    labeled('背景地図', bmSel), h('div', { class: 'row' }, '不透明度', opacity),
    check('乾燥セルをグレー表示', true, (v) => { ui.dry = v; render(); }),
    h('div', { class: 'row' }, '乾燥閾値 [m]', num(0.01, 0.01, (v) => { ui.dryThr = v; render(); })),
    check('流速ベクトル', ui.vec, (v) => { ui.vec = v; render(); }),
    h('div', { class: 'row' }, '間引き', num(3, 1, (v) => { ui.vecStep = Math.max(1, v | 0); render(); }, 56), '倍率', vecScaleIn, check('自動', true, (v) => { ui.vecAuto = v; vecScaleIn.disabled = v; render(); })),
    check('格子線', false, (v) => { ui.grid = v; render(); }),
    stats, err);

  // ---------------- sidebar: 解析
  const clickMode = select([['ts', '地点の時系列'], ['xs', '横断面（i 一定, j 方向）'], ['ls', '縦断面（j 一定, i 方向）'], ['none', 'なし']], 'ts', (v) => { ui.clickMode = v; if (probe) onProbe(probe.i, probe.j); else render(); });
  const prog = h('span', { class: 'sub' });
  const btnRun = h('button', { class: 'primary', onclick: runAll }, '全ステップ解析');
  const btnStats = h('button', { disabled: true, onclick: () => { dr.select('stats'); dr.setOpen(true); } }, '統計グラフ');
  const placeSel = select([['below', '下'], ['side', '右']], ui.place, (v) => { ui.place = v; try { localStorage.setItem('iric.viewer.place', v); } catch {} applyPlace(); });
  side.analysis.replaceChildren(
    labeled('クリック動作', clickMode),
    h('div', { class: 'row tight' }, btnRun, btnStats), prog,
    h('span', { class: 'sub' }, '全ステップ解析: 浸水面積・貯留量・最大水深・最大流速の時系列と、到達時間・浸水継続時間マップ（変数に追加）'),
    h('div', { class: 'row' }, 'グラフの配置', placeSel));

  // ---------------- sidebar: 出力
  const btnCsv = h('button', { disabled: true, onclick: exportCsv }, 'CSV（表示中のグラフ）');
  const rprog = h('span', { class: 'sub' });
  side.output.replaceChildren(
    h('div', { class: 'row tight' }, h('button', { onclick: () => { const a = document.createElement('a'); a.download = `${p.name}_${ui.var}_t${tb.t}.png`; a.href = map.toDataURL(); a.click(); } }, 'PNG（地図）'), btnCsv),
    h('button', { class: 'primary', onclick: () => makeReport().catch((e) => { err.textContent = String(e); rprog.textContent = ''; }) }, 'レポート (pptx)'), rprog);

  // ---------------- stage: map, timebar, drawer
  const tb = timebar(p.nt, p.timeArr, () => render());
  const mapHost = h('div', { class: 'maparea' });
  content.replaceChildren(mapHost, tb.el);
  const dr = drawer(stage, { tabs: [['ts', '時系列'], ['section', '断面'], ['stats', '統計']], onTab: () => drawCurrentChart(), onResize: () => { sizeChart(); drawCurrentChart(); } });
  stage.append(dr.el);
  const map = new MapView(mapHost, { onClick: (i, j) => onProbe(i, j), onError: (e) => { err.textContent = String(e); } });
  map.setProject(p);
  const roMap = observeSize(mapHost, (w, hh) => { map.resize(w, hh); render(); });
  const roChart = observeSize(dr.canvas.parentElement, () => { sizeChart(); drawCurrentChart(); });
  function sizeChart() { const r = dr.canvas.getBoundingClientRect(); if (r.width < 2 || r.height < 2) return; dr.canvas.width = Math.round(r.width * map.dpr); dr.canvas.height = Math.round(r.height * map.dpr); }
  function applyPlace() { stage.classList.toggle('side', ui.place === 'side'); }
  applyPlace();
  { const r = mapHost.getBoundingClientRect(); map.resize(Math.max(300, r.width), Math.max(200, r.height)); map.fit(); }

  // ---------------- rendering
  let rendering = false, pending = false;
  async function render() {
    if (rendering) { pending = true; return; }
    rendering = true;
    try {
      const t = tb.t, key = ui.var, derived = p.derived.has(key);
      const wantDepth = (ui.dry || ui.vec) && p.arrays.Depth, wantVel = ui.vec && p.hasVel;
      const [values, depth, u, w] = await Promise.all([p.get(key, t), wantDepth ? p.get('Depth', t) : null, wantVel ? p.get('Velocity_ms_1_X', t) : null, wantVel ? p.get('Velocity_ms_1_Y', t) : null]);
      let lo, hi;
      if (ui.range === 'global') [lo, hi] = p.range(key);
      else if (ui.range === 'step') { lo = Infinity; hi = -Infinity; for (const v of values) if (Number.isFinite(v)) { if (v < lo) lo = v; if (v > hi) hi = v; } }
      else { lo = ui.vmin; hi = ui.vmax; }
      if (ui.range !== 'manual') { vmin.value = fmtSig(lo); vmax.value = fmtSig(hi); }
      const line = probe && (ui.clickMode === 'xs' || ui.clickMode === 'ls') ? p.sectionNodes(probe.i, probe.j, ui.clickMode) : null;
      await map.render({ t, label: p.label(key), unit: p.unit(key), cmap: ui.cmap, vmin: lo, vmax: hi, dryMask: ui.dry && !derived, dryThr: ui.dryThr, vec: ui.vec, vecStep: ui.vecStep, vecScale: ui.vecAuto ? 36 / vmaxGlobal : ui.vecScale,
        grid: ui.grid, basemap: ui.basemap, opacity: ui.opacity, values, depth, u, w, probe, line, legendNote: `t = ${p.timeArr[t]} s` });
      if (charts.section && probe) await buildSection();
      drawCurrentChart();
      const s = Object.values(p.arrays).reduce((a, z) => { a.f += z.stats.fetched; a.b += z.stats.bytes; return a; }, { f: 0, b: 0 });
      stats.textContent = `wasm ${map.wasmMs.toFixed(1)} ms · ${map.cells} cells · ${map.W}×${map.H}px` + (s.f ? `\nzarr chunks ${s.f} (${(s.b / 1024).toFixed(0)} KB)` : '') + (map.tilesPending ? `\ntiles loading ${map.tilesPending}` : '');
    } catch (e) { err.textContent = String(e); console.error(e); }
    rendering = false;
    if (pending) { pending = false; render(); }
  }

  // ---------------- charts
  async function onProbe(i, j) {
    probe = { i, j };
    render();
    const k0 = p.node(i, j);
    if (ui.clickMode === 'ts') {
      dr.info.textContent = `時系列を読込中 (i=${i + 1}, j=${j + 1}) …`;
      const keys = [ui.var]; if (ui.var !== 'Depth' && p.arrays.Depth) keys.push('Depth');
      const ys = await Promise.all(keys.map((k) => p.timeseries(k, k0)));
      const series = keys.map((k, n) => ({ name: `${p.label(k)} [${p.unit(k)}]`, y: Array.from(ys[n]), color: n ? '#1f77b4' : '#d62728' }));
      charts.ts = { x: Array.from(p.timeArr), series, xlabel: 't [s]', title: `地点時系列  i=${i + 1}, j=${j + 1}  (${p.origX[k0].toFixed(1)}, ${p.origY[k0].toFixed(1)})`, legend: true };
      const pk = series[0].y.reduce((m, v, t) => (v > series[0].y[m] ? t : m), 0);
      info.ts = `${series[0].name}: 最大 ${fmt(series[0].y[pk])} @ t=${p.timeArr[pk]} s`;
      dr.select('ts');
    } else if (ui.clickMode === 'xs' || ui.clickMode === 'ls') {
      await buildSection(); dr.select('section');
    } else return;
    dr.setOpen(true); btnCsv.disabled = false; drawCurrentChart();
  }
  async function buildSection() {
    if (!probe || (ui.clickMode !== 'xs' && ui.clickMode !== 'ls')) return;
    const { i, j } = probe, mode = ui.clickMode, t = tb.t;
    const sec = await p.section(i, j, mode, t, ui.var, ui.dryThr);
    const label = mode === 'xs' ? `横断面 i=${i + 1}（j=1→${p.nj}）` : `縦断面 j=${j + 1}（i=1→${p.ni}）`;
    const main = sec.series.filter((s) => ['Elevation', 'WaterSurfaceElevation'].includes(s.key)), extra = sec.series.filter((s) => !main.includes(s));
    const base = { x: sec.x, xlabel: '距離 [m]', marker: sec.marker };
    charts.section = extra.length
      ? { panels: [{ ...base, title: `${label}  t=${p.timeArr[t]} s`, series: main, legend: true }, { ...base, title: extra[0].name, series: extra }], cols: 2 }
      : { ...base, title: `${label}  t=${p.timeArr[t]} s`, series: main, legend: true };
    info.section = `断面長 ${sec.length.toFixed(0)} m`;
  }
  async function runAll() {
    btnRun.disabled = true;
    const T = performance.now();
    await p.runAnalysis(ui.dryThr, (k, n) => { prog.textContent = `解析中 ${k}/${n}`; });
    for (const key of ['__arrival', '__duration']) if (![...varSel.options].some((o) => o.value === key)) varSel.append(h('option', { value: key }, p.label(key)));
    prog.textContent = `解析完了 ${((performance.now() - T) / 1000).toFixed(1)} s（閾値 ${ui.dryThr} m）`;
    btnStats.disabled = false; btnCsv.disabled = false; btnRun.disabled = false;
    const S = p.analysis.summary;
    info.stats = `浸水面積 最大 ${(S.peakArea / 1e6).toFixed(3)} km² @ t=${S.peakAreaTime} s / 領域の ${(100 * S.peakAreaFrac).toFixed(1)} %`;
    charts.stats = true;
    dr.select('stats'); dr.setOpen(true); drawCurrentChart();
  }
  function statsSpec() {
    const s = p.analysis.series, x = Array.from(p.timeArr), marker = p.timeArr[tb.t];
    const narrow = dr.canvas.width / map.dpr < 900;
    return { cols: narrow ? 2 : 4, panels: [
      { title: '浸水面積 [km²]', x, series: [{ name: p.name, y: s.area.map((v) => v / 1e6), color: '#1f77b4' }], marker, xlabel: 't [s]' },
      { title: '貯留量 [10³ m³]', x, series: [{ name: p.name, y: s.vol.map((v) => v / 1e3), color: '#2ca02c' }], marker, xlabel: 't [s]' },
      { title: '最大水深 [m]', x, series: [{ name: p.name, y: s.maxd, color: '#d62728' }], marker, xlabel: 't [s]' },
      { title: '最大流速 [m/s]', x, series: [{ name: p.name, y: s.maxv, color: '#9467bd' }], marker, xlabel: 't [s]' },
    ] };
  }
  function currentSpec() {
    const tab = dr.tab;
    if (tab === 'stats') return p.analysis.done ? statsSpec() : null;
    if (tab === 'ts') return charts.ts ? { ...charts.ts, marker: p.timeArr[tb.t] } : null;
    if (tab === 'section') { const s = charts.section; if (!s) return null; const narrow = dr.canvas.width / map.dpr < 800; return s.panels ? { ...s, cols: narrow ? 1 : 2 } : s; }
    return null;
  }
  function drawCurrentChart() {
    if (!dr.open) return;
    const spec = currentSpec();
    const msg = { ts: 'クリック動作を「地点の時系列」にして地図をクリックすると表示します。', section: 'クリック動作を「横断面」「縦断面」にして地図をクリックすると表示します。', stats: '「全ステップ解析」を実行すると表示します。' }[dr.tab];
    drawChart(dr.canvas, spec, map.dpr, msg);
    dr.info.textContent = info[dr.tab] || '';
  }
  function exportCsv() {
    const tab = dr.tab;
    if (tab === 'stats' && p.analysis.done) {
      const s = p.analysis.series;
      downloadText(`${p.name}_flood_stats.csv`, 'time_s,wet_area_m2,volume_m3,max_depth_m,max_speed_ms\n' + Array.from(p.timeArr, (t, k) => `${t},${s.area[k].toFixed(1)},${s.vol[k].toFixed(1)},${s.maxd[k].toFixed(4)},${s.maxv[k].toFixed(4)}`).join('\n'));
    } else {
      const spec = tab === 'ts' ? charts.ts : charts.section; if (!spec) return;
      const d = spec.panels ? { x: spec.panels[0].x, xlabel: spec.panels[0].xlabel, series: spec.panels.flatMap((q) => q.series) } : spec;
      downloadText(`${p.name}_${tab}_i${probe ? probe.i + 1 : 0}_j${probe ? probe.j + 1 : 0}.csv`, [d.xlabel, ...d.series.map((s) => s.name)].join(',') + '\n' + d.x.map((x, k) => [x, ...d.series.map((s) => s.y[k])].join(',')).join('\n'));
    }
  }

  // ---------------- report
  async function makeReport() {
    tb.stop(); err.textContent = ''; rprog.textContent = 'レポート作成中…';
    if (!p.analysis.done) await p.runAnalysis(ui.dryThr, (k, n) => { rprog.textContent = `解析中 ${k}/${n}`; });
    const S = p.analysis.summary, t = tb.t;
    const sections = [];
    sections.push({ title: '計算ケースの概要', bullets: [
      `プロジェクト: ${p.name}`, `ソルバー: ${p.A.solver || '-'} ${p.A.solverVersion || ''}`, `格子: ${p.ni} × ${p.nj} 節点（${p.NC.toLocaleString()} セル）`,
      `出力ステップ: ${p.nt}（t = ${p.timeArr[0]} – ${p.timeArr[p.nt - 1]} s）`, `座標系: ${p.A.crs || '不明'}`, `領域面積: ${(p.totalArea / 1e6).toFixed(3)} km²`],
      images: [{ dataUrl: map.toDataURL('image/jpeg', 0.85), caption: `${p.label(ui.var)}  t = ${p.timeArr[t]} s` }] });
    if (charts.ts) sections.push({ title: '地点時系列', bullets: [info.ts], images: [{ dataUrl: chartImage({ ...charts.ts, marker: p.timeArr[t] }) }] });
    if (charts.section) sections.push({ title: ui.clickMode === 'xs' ? '横断面' : '縦断面', bullets: [info.section], images: [{ dataUrl: chartImage({ ...charts.section, cols: charts.section.panels ? 2 : 1 }) }] });
    const statsImg = chartImage({ ...statsSpec(), cols: 4 });
    sections.push({ title: '全ステップ解析（浸水面積・貯留量・最大水深・最大流速）', images: [{ dataUrl: statsImg }],
      bullets: [`湿潤判定閾値: 水深 > ${p.analysis.thr} m`, `浸水面積 最大 ${(S.peakArea / 1e6).toFixed(3)} km²（領域の ${(100 * S.peakAreaFrac).toFixed(1)} %）@ t = ${S.peakAreaTime} s`,
        `最終ステップの浸水面積 ${(S.finalArea / 1e6).toFixed(3)} km²`, `貯留量 最大 ${(S.peakVolume / 1e3).toFixed(1)} ×10³ m³`, `最大水深 ${S.maxDepth.toFixed(2)} m / 最大流速 ${S.maxSpeed.toFixed(2)} m/s`],
      table: { header: ['指標', '値'], rows: [['浸水面積 最大 [km²]', (S.peakArea / 1e6).toFixed(3)], ['最大時刻 [s]', S.peakAreaTime], ['最終浸水面積 [km²]', (S.finalArea / 1e6).toFixed(3)], ['貯留量 最大 [m³]', S.peakVolume.toFixed(0)], ['最大水深 [m]', S.maxDepth.toFixed(3)], ['最大流速 [m/s]', S.maxSpeed.toFixed(3)], ['浸水を経験した節点数', `${S.everWet} / ${p.N}`]] } });
    const cur = map.state, derivedImages = [];
    for (const [key, cm] of [['__arrival', 4], ['__duration', 0]]) {
      const data = await p.get(key, 0), [lo, hi] = p.range(key);
      map.draw({ ...cur, values: data, depth: null, u: null, w: null, dryMask: false, cmap: cm, vmin: lo, vmax: hi, label: p.label(key), unit: 'min', probe: null, line: null, vec: false, legendNote: '' });
      derivedImages.push({ dataUrl: map.toDataURL('image/jpeg', 0.85), caption: `${p.label(key)} [min]  (${fmtSig(lo)} – ${fmtSig(hi)})` });
    }
    map.draw(cur);
    sections.push({ title: '到達時間・浸水継続時間', images: derivedImages, bullets: [`到達時間: 水深が初めて ${p.analysis.thr} m を超えた時刻`, `浸水継続時間: 水深 > ${p.analysis.thr} m であった時間の合計`] });
    const bytes = await downloadReport({ title: `iRIC 計算結果レポート: ${p.name}`, subtitle: `${p.A.solver || ''} ${p.A.solverVersion || ''}\n作成日 ${today()}`, sections }, `${p.name}_report.pptx`);
    rprog.textContent = bytes ? `レポートをダウンロードしました (${(bytes / 1024).toFixed(0)} KB)` : 'レポートをダウンロードしました';
  }

  tb.set(Math.min(p.nt - 1, 90));
  return { destroy() { tb.destroy(); roMap.disconnect(); roChart.disconnect(); map.destroy(); dr.el.remove(); stage.classList.remove('side'); content.replaceChildren(); } };
}
