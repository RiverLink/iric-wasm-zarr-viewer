// Single-project viewer: map + controls + analysis panel (time series, sections, whole-run stats).
import { MapView, drawLegend } from './mapview.js';
import { drawChart } from './charts.js';
import { CMAPS } from './wasm.js';
import { h, select, labeled, check, num, timebar, fmt, fmtSig, downloadText } from './ui.js';
import { chartImage, downloadReport, today } from './report.js';

const CMAP_OPTIONS = [['0', 'viridis'], ['4', 'turbo'], ['1', 'jet'], ['2', 'blues'], ['3', 'terrain'], ['5', 'RdBu']];
export const BASEMAP_OPTIONS = [['gsi_pale', '地理院 淡色地図'], ['gsi_std', '地理院 標準地図'], ['gsi_photo', '地理院 航空写真'], ['gsi_hill', '地理院 陰影起伏図'], ['osm', 'OpenStreetMap'], ['none', 'なし']];

export function mountViewer(container, project) {
  const p = project;
  const ui = { var: p.varNames.includes('Depth') ? 'Depth' : p.varNames[0], cmap: 2, range: 'global', vmin: 0, vmax: 1, dry: true, dryThr: 0.01,
    vec: p.hasVel, vecStep: 3, vecScale: 6, grid: false, basemap: p.hasMerc ? 'gsi_pale' : 'none', opacity: 0.8, clickMode: 'ts', layout: 'below', chartH: 260 };
  if (ui.var !== 'Depth') ui.cmap = 0;
  let probe = null;
  const chart = { kind: null, spec: null, info: '' };

  // ---------------- DOM
  const varSel = select(p.varNames.map((k) => [k, p.label(k)]), ui.var, (v) => { ui.var = v; render(); if (probe) onProbe(probe.i, probe.j); });
  const cmapSel = select(CMAP_OPTIONS, String(ui.cmap), (v) => { ui.cmap = +v; render(); });
  const rangeSel = select([['global', '全ステップの最小/最大（固定）'], ['step', '現ステップの最小/最大'], ['manual', '手動']], 'global', (v) => { ui.range = v; if (v === 'manual') { ui.vmin = +vmin.value; ui.vmax = +vmax.value; } render(); });
  const vmin = num(0, 'any', (v) => { ui.vmin = v; render(); }), vmax = num(1, 'any', (v) => { ui.vmax = v; render(); });
  const bmSel = select(BASEMAP_OPTIONS, ui.basemap, (v) => { ui.basemap = v; render(); }); bmSel.disabled = !p.hasMerc;
  const opacity = h('input', { type: 'range', min: 0, max: 1, step: 0.05, value: ui.opacity, style: 'flex:1', oninput: (e) => { ui.opacity = +e.target.value; render(); } });
  const stats = h('div', { class: 'stats' }), err = h('div', { class: 'err' });
  const aside = h('aside', {},
    labeled('変数', varSel), labeled('背景地図', bmSel), h('div', { class: 'row' }, '結果の不透明度', opacity),
    labeled('カラーマップ', cmapSel), labeled('レンジ', rangeSel),
    h('div', { class: 'row' }, 'min', vmin, 'max', vmax),
    check('乾燥セルをグレー表示（Depth ≤ 閾値）', true, (v) => { ui.dry = v; render(); }),
    h('div', { class: 'row' }, '閾値', num(0.01, 0.01, (v) => { ui.dryThr = v; render(); })),
    check('流速ベクトル', ui.vec, (v) => { ui.vec = v; render(); }),
    h('div', { class: 'row' }, '間引き', num(3, 1, (v) => { ui.vecStep = Math.max(1, v | 0); render(); }, 60), '倍率', num(6, 1, (v) => { ui.vecScale = v; render(); }, 60)),
    check('格子線', false, (v) => { ui.grid = v; render(); }),
    h('div', { class: 'row' }, h('button', { onclick: () => { map.fit(); render(); } }, '全体表示'), h('button', { onclick: () => { const a = document.createElement('a'); a.download = `${p.name}_${ui.var}_t${tb.t}.png`; a.href = map.toDataURL(); a.click(); } }, 'PNG保存')),
    h('button', { class: 'primary', onclick: () => makeReport().catch((e) => { err.textContent = String(e); }) }, 'レポート (pptx)'),
    stats, err);

  const tb = timebar(p.nt, p.timeArr, () => render());
  const mapHost = h('div', {});
  const legendBar = h('canvas', { width: 256, height: 1 }), lmin = h('span'), lmax = h('span'), lunit = h('span');
  const chartCv = h('canvas', { class: 'chart', width: 800, height: 260 });
  const clickMode = select([['ts', '地点の時系列'], ['xs', '横断面（i 一定, j 方向）'], ['ls', '縦断面（j 一定, i 方向）'], ['none', 'なし']], 'ts', (v) => { ui.clickMode = v; if (probe) onProbe(probe.i, probe.j); });
  const prog = h('span', { class: 'sub' }), chartInfo = h('span', { class: 'sub', style: 'font-family:ui-monospace,Consolas,monospace; font-size:12px' });
  const btnStats = h('button', { disabled: true, onclick: showStats }, '統計グラフ'), btnCsv = h('button', { disabled: true, onclick: exportCsv }, 'CSV 出力');
  const btnRun = h('button', { onclick: runAll }, '全ステップ解析（浸水面積・貯留量・到達時間）');
  const analysis = h('details', { class: 'analysis' }, h('summary', {}, '分析ツール'),
    h('div', { class: 'row', style: 'margin:6px 0' }, h('label', { style: 'flex-direction:row; align-items:center; gap:6px' }, 'クリック動作', clickMode), btnRun, prog, btnStats, btnCsv, chartInfo),
    chartCv);
  const layoutSel = select([['below', 'グラフ: 下'], ['side', 'グラフ: 右']], 'below', (v) => { ui.layout = v; stage.classList.toggle('side', v === 'side'); if (v === 'side') analysis.open = true; onResize(); });
  const chartHIn = num(260, 20, (v) => { ui.chartH = Math.max(120, v | 0); onResize(); }, 70);
  analysis.querySelector('.row').append(h('span', { class: 'sub' }, '　配置'), layoutSel, h('span', { class: 'sub' }, 'グラフ高さ'), chartHIn);
  const body = h('div', { class: 'body' }, h('div', {}, mapHost, h('div', { class: 'legend' }, lmin, legendBar, lmax, lunit)), analysis);
  const stage = h('section', { class: 'stage' }, tb.el, body);
  const rootEl = h('div', { class: 'viewer' }, aside, stage);
  container.replaceChildren(rootEl);

  const map = new MapView(mapHost, { onClick: (i, j) => onProbe(i, j), onError: (e) => { err.textContent = String(e); } });
  map.setProject(p);
  function layout() {
    const r = mapHost.getBoundingClientRect();
    const side = ui.layout === 'side';
    const below = side ? 60 : 60 + (analysis.open ? (analysis.offsetHeight - chartCv.clientHeight + ui.chartH) + 8 : 30);
    const cssH = Math.max(360, window.innerHeight - r.top - below);
    map.resize(Math.max(300, mapHost.clientWidth), cssH);
    const ch = side ? Math.max(200, cssH - 40) : ui.chartH;
    chartCv.style.height = `${ch}px`;
    chartCv.width = Math.round(chartCv.clientWidth * map.dpr); chartCv.height = Math.round(ch * map.dpr);
  }
  layout(); map.fit();
  const onResize = () => { layout(); render(); drawCurrentChart(); };
  window.addEventListener('resize', onResize);
  analysis.addEventListener('toggle', onResize);

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
      const cmap = derived && ui.range === 'global' && p.arrays[key].cmap !== undefined && cmapSel.dataset.auto !== '0' ? ui.cmap : ui.cmap;
      const line = probe && (ui.clickMode === 'xs' || ui.clickMode === 'ls') ? p.sectionNodes(probe.i, probe.j, ui.clickMode) : null;
      await map.render({ t, label: p.label(key), unit: p.unit(key), cmap, vmin: lo, vmax: hi, dryMask: ui.dry && !derived, dryThr: ui.dryThr, vec: ui.vec, vecStep: ui.vecStep, vecScale: ui.vecScale,
        grid: ui.grid, basemap: ui.basemap, opacity: ui.opacity, values, depth, u, w, probe, line });
      drawLegend(legendBar, cmap); lmin.textContent = fmtSig(lo); lmax.textContent = fmtSig(hi); lunit.textContent = `${p.label(key)} [${p.unit(key)}]`;
      if (chart.kind === 'xs' || chart.kind === 'ls') await buildSection();
      if (chart.kind) drawCurrentChart();
      const s = Object.values(p.arrays).reduce((a, z) => { a.f += z.stats.fetched; a.b += z.stats.bytes; a.fm += z.stats.fetchMs; a.dm += z.stats.decodeMs; return a; }, { f: 0, b: 0, fm: 0, dm: 0 });
      stats.textContent = `wasm rasterize+arrows: ${map.wasmMs.toFixed(1)} ms (${map.cells} cells, ${map.nArrows} arrows, ${map.W}×${map.H}px)\nzarr chunks fetched: ${s.f} (${(s.b / 1024).toFixed(0)} KB), fetch ${s.fm.toFixed(0)} ms, inflate ${s.dm.toFixed(0)} ms` + (map.tilesPending ? `\nmap tiles loading: ${map.tilesPending}` : '');
    } catch (e) { err.textContent = String(e); console.error(e); }
    rendering = false;
    if (pending) { pending = false; render(); }
  }

  // ---------------- analysis
  async function onProbe(i, j) {
    probe = { i, j };
    render();
    const k0 = p.node(i, j);
    if (ui.clickMode === 'ts') {
      chartInfo.textContent = `時系列を読込中 (i=${i + 1}, j=${j + 1}) …`;
      const keys = [ui.var]; if (ui.var !== 'Depth' && p.arrays.Depth) keys.push('Depth');
      const ys = await Promise.all(keys.map((k) => p.timeseries(k, k0)));
      const series = keys.map((k, n) => ({ name: `${p.label(k)} [${p.unit(k)}]`, y: Array.from(ys[n]), color: n ? '#1f77b4' : '#d62728' }));
      chart.kind = 'ts';
      chart.spec = { x: Array.from(p.timeArr), series, xlabel: 't [s]', title: `地点時系列  i=${i + 1}, j=${j + 1}  (${p.origX[k0].toFixed(1)}, ${p.origY[k0].toFixed(1)})`, legend: true };
      const pk = series[0].y.reduce((m, v, t) => (v > series[0].y[m] ? t : m), 0);
      chart.info = `${series[0].name}: 最大 ${fmt(series[0].y[pk])} @ t=${p.timeArr[pk]} s`;
    } else if (ui.clickMode === 'xs' || ui.clickMode === 'ls') {
      chart.kind = ui.clickMode; await buildSection();
    } else return;
    chartInfo.textContent = chart.info; analysis.open = true; drawCurrentChart(); btnCsv.disabled = false;
  }
  async function buildSection() {
    if (!probe) return;
    const { i, j } = probe, mode = chart.kind, t = tb.t;
    const sec = await p.section(i, j, mode, t, ui.var, ui.dryThr);
    const label = mode === 'xs' ? `横断面 i=${i + 1}（j=1→${p.nj}）` : `縦断面 j=${j + 1}（i=1→${p.ni}）`;
    const main = sec.series.filter((s) => ['Elevation', 'WaterSurfaceElevation'].includes(s.key)), extra = sec.series.filter((s) => !main.includes(s));
    const base = { x: sec.x, xlabel: '距離 [m]', marker: sec.marker };
    chart.spec = extra.length
      ? { panels: [{ ...base, title: `${label}  t=${p.timeArr[t]} s`, series: main, legend: true }, { ...base, title: extra[0].name, series: extra }] }
      : { ...base, title: `${label}  t=${p.timeArr[t]} s`, series: main, legend: true };
    chart.info = `断面長 ${sec.length.toFixed(0)} m`;
  }
  async function runAll() {
    btnRun.disabled = true;
    const T = performance.now();
    await p.runAnalysis(ui.dryThr, (k, n) => { prog.textContent = `解析中 ${k}/${n}`; });
    for (const key of ['__arrival', '__duration']) if (![...varSel.options].some((o) => o.value === key)) varSel.append(h('option', { value: key }, p.label(key)));
    prog.textContent = `解析完了 ${((performance.now() - T) / 1000).toFixed(1)} s（閾値 ${ui.dryThr} m）`;
    btnStats.disabled = false; btnCsv.disabled = false; btnRun.disabled = false;
    showStats();
  }
  function statsSpec() {
    const s = p.analysis.series, x = Array.from(p.timeArr), marker = p.timeArr[tb.t];
    return { panels: [
      { title: '浸水面積 [km²]', x, series: [{ name: p.name, y: s.area.map((v) => v / 1e6), color: '#1f77b4' }], marker, xlabel: 't [s]' },
      { title: '貯留量 [10³ m³]', x, series: [{ name: p.name, y: s.vol.map((v) => v / 1e3), color: '#2ca02c' }], marker, xlabel: 't [s]' },
      { title: '最大水深 [m]', x, series: [{ name: p.name, y: s.maxd, color: '#d62728' }], marker, xlabel: 't [s]' },
      { title: '最大流速 [m/s]', x, series: [{ name: p.name, y: s.maxv, color: '#9467bd' }], marker, xlabel: 't [s]' },
    ] };
  }
  function showStats() {
    if (!p.analysis.done) return;
    chart.kind = 'stats'; chart.spec = statsSpec();
    const S = p.analysis.summary;
    chart.info = `浸水面積 最大 ${(S.peakArea / 1e6).toFixed(3)} km² @ t=${S.peakAreaTime} s / 領域の ${(100 * S.peakAreaFrac).toFixed(1)} %`;
    chartInfo.textContent = chart.info; analysis.open = true; drawCurrentChart();
  }
  function drawCurrentChart() {
    if (!chart.kind) { drawChart(chartCv, null, map.dpr, '地図上のセルをクリックすると時系列 / 断面を表示します。「全ステップ解析」で浸水面積などの統計を計算します。'); return; }
    let spec = chart.spec;
    if (chart.kind === 'stats') spec = statsSpec();
    else if (chart.kind === 'ts') spec = { ...spec, marker: p.timeArr[tb.t] };
    drawChart(chartCv, spec, map.dpr);
  }
  function exportCsv() {
    if (chart.kind === 'stats' || !chart.spec) {
      const s = p.analysis.series;
      downloadText(`${p.name}_flood_stats.csv`, 'time_s,wet_area_m2,volume_m3,max_depth_m,max_speed_ms\n' + Array.from(p.timeArr, (t, k) => `${t},${s.area[k].toFixed(1)},${s.vol[k].toFixed(1)},${s.maxd[k].toFixed(4)},${s.maxv[k].toFixed(4)}`).join('\n'));
    } else {
      const d = chart.spec.panels ? { x: chart.spec.panels[0].x, xlabel: chart.spec.panels[0].xlabel, series: chart.spec.panels.flatMap((q) => q.series) } : chart.spec;
      downloadText(`${p.name}_${chart.kind}_i${probe ? probe.i + 1 : 0}_j${probe ? probe.j + 1 : 0}.csv`, [d.xlabel, ...d.series.map((s) => s.name)].join(',') + '\n' + d.x.map((x, k) => [x, ...d.series.map((s) => s.y[k])].join(',')).join('\n'));
    }
  }

  // ---------------- report
  async function makeReport() {
    tb.stop();
    err.textContent = ''; prog.textContent = 'レポート作成中…';
    if (!p.analysis.done) await p.runAnalysis(ui.dryThr, (k, n) => { prog.textContent = `解析中 ${k}/${n}`; });
    const S = p.analysis.summary, t = tb.t;
    const sections = [];
    sections.push({ title: '計算ケースの概要', bullets: [
      `プロジェクト: ${p.name}`, `ソルバー: ${p.A.solver || '-'} ${p.A.solverVersion || ''}`, `格子: ${p.ni} × ${p.nj} 節点（${p.NC.toLocaleString()} セル）`,
      `出力ステップ: ${p.nt}（t = ${p.timeArr[0]} – ${p.timeArr[p.nt - 1]} s）`, `座標系: ${p.A.crs || '不明'}`, `領域面積: ${(p.totalArea / 1e6).toFixed(3)} km²`,
      `変数: ${p.varNames.filter((k) => !p.derived.has(k)).map((k) => p.label(k)).join(', ')}`],
      images: [{ dataUrl: map.toDataURL('image/jpeg', 0.85), caption: `${p.label(ui.var)}  t = ${p.timeArr[t]} s` }] });
    if (chart.kind && chart.kind !== 'stats') sections.push({ title: chart.kind === 'ts' ? '地点時系列' : (chart.kind === 'xs' ? '横断面' : '縦断面'), bullets: [chart.info], images: [{ dataUrl: chartImage(chart.kind === 'ts' ? { ...chart.spec, marker: p.timeArr[t] } : chart.spec) }] });
    sections.push({ title: '全ステップ解析（浸水面積・貯留量・最大水深・最大流速）', images: [{ dataUrl: chartImage(statsSpec()) }],
      bullets: [`湿潤判定閾値: 水深 > ${p.analysis.thr} m`, `浸水面積 最大 ${(S.peakArea / 1e6).toFixed(3)} km²（領域の ${(100 * S.peakAreaFrac).toFixed(1)} %）@ t = ${S.peakAreaTime} s`,
        `最終ステップの浸水面積 ${(S.finalArea / 1e6).toFixed(3)} km²`, `貯留量 最大 ${(S.peakVolume / 1e3).toFixed(1)} ×10³ m³`, `最大水深 ${S.maxDepth.toFixed(2)} m / 最大流速 ${S.maxSpeed.toFixed(2)} m/s`],
      table: { header: ['指標', '値'], rows: [['浸水面積 最大 [km²]', (S.peakArea / 1e6).toFixed(3)], ['最大時刻 [s]', S.peakAreaTime], ['最終浸水面積 [km²]', (S.finalArea / 1e6).toFixed(3)], ['貯留量 最大 [m³]', S.peakVolume.toFixed(0)], ['最大水深 [m]', S.maxDepth.toFixed(3)], ['最大流速 [m/s]', S.maxSpeed.toFixed(3)], ['浸水を経験した節点数', `${S.everWet} / ${p.N}`]] } });
    // arrival + duration maps rendered on the live view, then restored
    const cur = map.state;
    const derivedImages = [];
    for (const [key, cm] of [['__arrival', 4], ['__duration', 0]]) {
      const data = await p.get(key, 0), [lo, hi] = p.range(key);
      map.draw({ ...cur, values: data, depth: null, u: null, w: null, dryMask: false, cmap: cm, vmin: lo, vmax: hi, label: p.label(key), unit: 'min', probe: null, line: null, vec: false });
      derivedImages.push({ dataUrl: map.toDataURL('image/jpeg', 0.85), caption: `${p.label(key)} [min]  (${fmtSig(lo)} – ${fmtSig(hi)})` });
    }
    map.draw(cur);
    sections.push({ title: '到達時間・浸水継続時間', images: derivedImages, bullets: [`到達時間: 水深が初めて ${p.analysis.thr} m を超えた時刻`, `浸水継続時間: 水深 > ${p.analysis.thr} m であった時間の合計`] });
    const bytes = await downloadReport({ title: `iRIC 計算結果レポート: ${p.name}`, subtitle: `${p.A.solver || ''} ${p.A.solverVersion || ''}\n作成日 ${today()}`, sections }, `${p.name}_report.pptx`);
    prog.textContent = `レポートをダウンロードしました (${(bytes / 1024).toFixed(0)} KB)`;
  }

  drawCurrentChart();
  tb.set(Math.min(p.nt - 1, 90));
  return { destroy() { tb.stop(); window.removeEventListener('resize', onResize); map.destroy(); container.replaceChildren(); } };
}
