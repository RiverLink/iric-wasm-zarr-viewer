// Project: one converted iRIC result (a Zarr store served at data/<name>/, or an in-memory store
// converted in the browser) plus its wasm-side buffers and analysis products.
//
// Heavy whole-run operations (time series, whole-run analysis) go to the server API when the project
// is server-backed, so the browser never downloads every step; the in-browser path remains for
// projects converted locally (static hosting).
import { ZarrGroup } from './zarr.js';
import { W_, f32, f64, alloc, fb, scratch, ensureScratch } from './wasm.js';

export const UNITS = { Depth: 'm', Depth_Max: 'm', Elevation: 'm', WaterSurfaceElevation: 'm', Velocity_ms_1_X: 'm/s', Velocity_ms_1_Y: 'm/s', Velocity_magnitude_Max: 'm/s' };
/** Render-space origin shared by every project so that views can be synchronised. */
export const shared = { origin: null };

const b64f32 = (s) => { const bin = atob(s); const u8 = new Uint8Array(bin.length); for (let k = 0; k < bin.length; k++) u8[k] = bin.charCodeAt(k); return new Float32Array(u8.buffer); };

export class Project {
  static async open(name) {
    return Project.fromGroup(name, await ZarrGroup.open(`data/${encodeURIComponent(name)}`));
  }
  /** Build from any group with the zarr.js surface (ZarrGroup over HTTP, or MemGroup converted in the browser). */
  static async fromGroup(name, root) {
    const p = new Project();
    p.name = name; p.url = root.url || null; p.server = !!root.url;
    const A = p.A = root.attrs;
    p.ni = A.ni; p.nj = A.nj; p.nt = A.nt; p.N = A.ni * A.nj; p.NC = (A.ni - 1) * (A.nj - 1);
    const [gx, gy] = await Promise.all([root.array('grid/x'), root.array('grid/y')]);
    p.origX = await gx.getAll(); p.origY = await gy.getAll();
    p.mercX = p.mercY = null;
    if (A.bbox3857) {
      try { p.mercX = await (await root.array('grid/x3857')).getAll(); p.mercY = await (await root.array('grid/y3857')).getAll(); } catch (e) { console.warn(e); }
    }
    p.hasMerc = !!p.mercX;
    p.rx = p.hasMerc ? p.mercX : p.origX; p.ry = p.hasMerc ? p.mercY : p.origY;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let k = 0; k < p.N; k++) { const x = p.rx[k], y = p.ry[k]; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    if (!shared.origin) shared.origin = [(x0 + x1) / 2, (y0 + y1) / 2];
    const o = shared.origin;
    p.bbox = [x0 - o[0], y0 - o[1], x1 - o[0], y1 - o[1]];
    p.timeArr = await (await root.array('time')).getAll();
    p.varNames = Object.keys(A.variables).filter((k) => k !== 'IBC');
    p.labels = { ...A.variables };
    p.units = { ...UNITS };
    p.arrays = {};
    for (const k of p.varNames) p.arrays[k] = await root.array(`results/${k}`);
    p.hasVel = !!(p.arrays.Velocity_ms_1_X && p.arrays.Velocity_ms_1_Y);
    p.derived = new Set();
    // wasm buffers
    ensureScratch(p.N);
    p.ptr = { x: alloc(p.N * 4), y: alloc(p.N * 4), ox: alloc(p.N * 4), oy: alloc(p.N * 4), area: alloc(p.NC * 4), arr: alloc(p.N * 4), dur: alloc(p.N * 4) };
    { const X = f32(p.ptr.x, p.N), Y = f32(p.ptr.y, p.N); for (let k = 0; k < p.N; k++) { X[k] = p.rx[k] - o[0]; Y[k] = p.ry[k] - o[1]; } }
    f32(p.ptr.ox, p.N).set(p.origX); f32(p.ptr.oy, p.N).set(p.origY);
    p.totalArea = W_.cellAreas(p.ptr.ox, p.ptr.oy, p.ni, p.nj, p.ptr.area);
    p.analysis = { done: false };
    return p;
  }

  label(key) { return this.labels[key] || key; }
  unit(key) { return this.units[key] || '-'; }
  isStatic(key) { const a = this.arrays[key]; return !!(a && a.shape && a.shape.length === 3 && a.shape[0] === 1); }
  get(key, t) { return this.arrays[key].getChunk([this.isStatic(key) ? 0 : t, 0, 0]); }
  node(i, j) { return j * this.ni + i; }
  gridSignature() { return `${this.ni}x${this.nj}:${this.A.bbox.map((v) => v.toFixed(1)).join(',')}`; }
  sameGridAs(p) { return this.gridSignature() === p.gridSignature(); }
  /** Range of a variable over the whole run. */
  range(key) { const a = this.arrays[key].attrs; return [a.min, a.max]; }

  /** Register an in-memory (derived) variable so it can be mapped like a result. */
  addDerived(key, label, data, unit, cmap) {
    let lo = Infinity, hi = -Infinity; for (const v of data) if (Number.isFinite(v)) { if (v < lo) lo = v; if (v > hi) hi = v; }
    this.arrays[key] = { attrs: { min: lo, max: hi, original_name: label }, shape: [1, this.nj, this.ni], getChunk: async () => data, stats: { fetched: 0, bytes: 0, fetchMs: 0, decodeMs: 0 }, cache: new Map(), cmap };
    this.derived.add(key); this.labels[key] = label; this.units[key] = unit;
  }

  async api(path, params) {
    const q = new URLSearchParams({ name: this.name, ...params });
    const r = await fetch(`/api/${path}?${q}`);
    const j = await r.json();
    if (!r.ok || j.error) throw new Error(j.error || r.statusText);
    return j;
  }

  /** Time series of one variable at node index k. Server-backed projects ask the API (no per-step download). */
  async timeseries(key, k) {
    if (this.isStatic(key)) { const v = (await this.get(key, 0))[k]; return new Float64Array(this.nt).fill(v); }
    if (this.server) {
      const j = await this.api('timeseries', { var: key, i: (k % this.ni) + 1, j: Math.floor(k / this.ni) + 1 });
      return Float64Array.from(j.series[key], (v) => (v === null ? NaN : v));
    }
    const chunks = await Promise.all(Array.from({ length: this.nt }, (_, t) => this.get(key, t)));
    return Float64Array.from(chunks, (c) => c[k]);
  }

  sectionNodes(i, j, mode) {
    const out = [];
    if (mode === 'xs') for (let jj = 0; jj < this.nj; jj++) out.push(jj * this.ni + i);
    else for (let ii = 0; ii < this.ni; ii++) out.push(j * this.ni + ii);
    return out;
  }
  distances(nodes) {
    const d = [0];
    for (let n = 1; n < nodes.length; n++) d.push(d[n - 1] + Math.hypot(this.origX[nodes[n]] - this.origX[nodes[n - 1]], this.origY[nodes[n]] - this.origY[nodes[n - 1]]));
    return d;
  }
  /** Bed elevation + water surface (+ an extra variable) along an i- or j-line at step t (current-step chunks only). */
  async section(i, j, mode, t, extraKey, dryThr) {
    const nodes = this.sectionNodes(i, j, mode);
    const x = this.distances(nodes);
    const keys = ['Elevation', 'WaterSurfaceElevation'].filter((k) => this.arrays[k]);
    if (extraKey && !keys.includes(extraKey) && extraKey !== 'Depth' && this.arrays[extraKey]) keys.push(extraKey);
    const chunks = await Promise.all(keys.map((k) => this.get(k, t)));
    const depth = this.arrays.Depth ? await this.get('Depth', t) : null;
    const colors = { Elevation: '#8c6d31', WaterSurfaceElevation: '#1f77b4' };
    const series = keys.map((k, n) => ({
      key: k, name: `${this.label(k)} [${this.unit(k)}]`, color: colors[k] || '#d62728', fill: k === 'Elevation',
      y: nodes.map((nd) => (k === 'WaterSurfaceElevation' && depth && depth[nd] <= dryThr) ? NaN : chunks[n][nd]),
    }));
    return { x, nodes, series, marker: x[mode === 'xs' ? j : i], length: x[x.length - 1] };
  }

  /** Whole-run analysis. Server-backed: fetched from the API (precomputed at conversion, else streamed on
   *  the server). Browser-converted: computed with the wasm kernels step by step. */
  async runAnalysis(thr, onProgress) {
    if (this.analysis.done && this.analysis.thr === thr) return this.analysis;
    let series, summary, arrival, duration;
    if (this.server) {
      if (onProgress) onProgress(0, this.nt);
      const j = await this.api('analyze', { thr });
      const s = j.series;
      series = { area: s.wet_area_m2, vol: s.volume_m3, maxd: s.max_depth_m, maxv: s.max_speed_ms || s.max_depth_m.map(() => NaN) };
      arrival = b64f32(j.arrival_min_b64); duration = b64f32(j.duration_min_b64);
      const S = j.summary;
      summary = { peakArea: S.peak_wet_area_m2, peakAreaTime: S.peak_wet_area_time_s, peakAreaFrac: S.peak_wet_area_fraction, finalArea: S.final_wet_area_m2,
        peakVolume: S.peak_volume_m3, maxDepth: S.max_depth_m, maxSpeed: S.max_speed_ms ?? NaN, everWet: S.ever_wet_nodes };
    } else {
      const { N, ni, nj, nt, timeArr, ptr } = this;
      ensureScratch(N);
      f32(ptr.arr, N).fill(NaN); f32(ptr.dur, N).fill(0);
      series = { area: [], vol: [], maxd: [], maxv: [] };
      for (let t = 0; t < nt; t++) {
        const [d, u, v] = await Promise.all([this.get('Depth', t), this.hasVel ? this.get('Velocity_ms_1_X', t) : null, this.hasVel ? this.get('Velocity_ms_1_Y', t) : null]);
        f32(scratch.d, N).set(d); if (u) { f32(scratch.u, N).set(u); f32(scratch.w, N).set(v); }
        W_.wetStats(scratch.d, u ? scratch.u : 0, u ? scratch.w : 0, ptr.area, ni, nj, thr, fb.stat);
        const s = f64(fb.stat, 4);
        series.area.push(s[0]); series.vol.push(s[1]); series.maxd.push(s[2]); series.maxv.push(s[3]);
        const dt = t + 1 < nt ? timeArr[t + 1] - timeArr[t] : (t ? timeArr[t] - timeArr[t - 1] : 0);
        W_.accumulate(scratch.d, thr, timeArr[t], dt, ptr.arr, ptr.dur, N);
        if (onProgress && t % 10 === 0) { onProgress(t + 1, nt); await new Promise((r) => setTimeout(r)); }
      }
      arrival = Float32Array.from(f32(ptr.arr, N), (v) => v / 60);
      duration = Float32Array.from(f32(ptr.dur, N), (v) => v / 60);
      const pk = series.area.reduce((m, v, t) => (v > series.area[m] ? t : m), 0);
      summary = {
        peakArea: series.area[pk], peakAreaTime: timeArr[pk], peakAreaFrac: series.area[pk] / this.totalArea,
        finalArea: series.area[nt - 1], peakVolume: Math.max(...series.vol), maxDepth: Math.max(...series.maxd), maxSpeed: Math.max(...series.maxv),
        everWet: arrival.reduce((n, v) => n + (Number.isFinite(v) ? 1 : 0), 0),
      };
    }
    this.analysis = { done: true, thr, series, arrival, duration, summary };
    this.addDerived('__arrival', '到達時間（解析）', arrival, 'min', 4);
    this.addDerived('__duration', '浸水継続時間（解析）', duration, 'min', 0);
    return this.analysis;
  }
}
