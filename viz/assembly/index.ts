// iRIC 2D structured-grid visualizer kernels (AssemblyScript -> WebAssembly)
//
// Memory is managed by the host (JS) through alloc(); every pointer below is a
// byte offset into the shared linear memory.
//   grid x,y      : f32[nj*ni]  node coordinates (j-major, C order)
//   values        : f32[nj*ni]  scalar field at nodes (NaN = missing)
//   depth (mask)  : f32[nj*ni]  used to blank dry cells (ptr 0 = no mask)
//   rgba out      : u8 [W*H*4]  canvas ImageData buffer
//   cell out      : i32[W*H]    cell index (j*ni+i) under each pixel, -1 = none

export function alloc(bytes: usize): usize {
  return heap.alloc(bytes);
}

// ---------------------------------------------------------------- colormaps
// control points: r,g,b in 0..1 at equally spaced t
const VIRIDIS: StaticArray<f32> = [
  0.267, 0.005, 0.329,  0.283, 0.141, 0.458,  0.254, 0.265, 0.530,  0.207, 0.372, 0.553,
  0.164, 0.471, 0.558,  0.128, 0.567, 0.551,  0.135, 0.659, 0.518,  0.267, 0.749, 0.441,
  0.478, 0.821, 0.318,  0.741, 0.873, 0.150,  0.993, 0.906, 0.144];
const JET: StaticArray<f32> = [
  0.0, 0.0, 0.5,  0.0, 0.0, 1.0,  0.0, 0.5, 1.0,  0.0, 1.0, 1.0,  0.5, 1.0, 0.5,
  1.0, 1.0, 0.0,  1.0, 0.5, 0.0,  1.0, 0.0, 0.0,  0.5, 0.0, 0.0];
const BLUES: StaticArray<f32> = [
  0.97, 0.98, 1.00,  0.87, 0.92, 0.97,  0.78, 0.86, 0.94,  0.62, 0.79, 0.88,
  0.42, 0.68, 0.84,  0.26, 0.57, 0.78,  0.13, 0.44, 0.71,  0.03, 0.32, 0.61,  0.03, 0.19, 0.42];
const TERRAIN: StaticArray<f32> = [
  0.20, 0.20, 0.60,  0.00, 0.60, 1.00,  0.00, 0.80, 0.40,  1.00, 1.00, 0.60,
  0.60, 0.40, 0.30,  0.90, 0.85, 0.85,  1.00, 1.00, 1.00];
const TURBO: StaticArray<f32> = [
  0.190, 0.072, 0.232,  0.276, 0.408, 0.860,  0.153, 0.735, 0.926,  0.226, 0.939, 0.591,
  0.629, 0.985, 0.264,  0.925, 0.834, 0.238,  0.987, 0.510, 0.117,  0.818, 0.190, 0.021,  0.480, 0.016, 0.011];

const RDBU: StaticArray<f32> = [
  0.40, 0.00, 0.12,  0.70, 0.09, 0.17,  0.84, 0.38, 0.30,  0.96, 0.65, 0.51,  0.99, 0.86, 0.78,
  0.97, 0.97, 0.97,  0.82, 0.90, 0.94,  0.57, 0.77, 0.87,  0.26, 0.58, 0.77,  0.13, 0.40, 0.67,  0.02, 0.19, 0.38];

function table(id: i32): StaticArray<f32> {
  switch (id) {
    case 5: return RDBU;
    case 1: return JET;
    case 2: return BLUES;
    case 3: return TERRAIN;
    case 4: return TURBO;
    default: return VIRIDIS;
  }
}

// packed little-endian RGBA (R in lowest byte) for t in [0,1]
export function colorAt(id: i32, t: f32): u32 {
  const tab = table(id);
  const n = tab.length / 3;
  if (t != t) t = 0; // NaN
  if (t < 0) t = 0; else if (t > 1) t = 1;
  const f = t * <f32>(n - 1);
  let k = <i32>f;
  if (k >= n - 1) k = n - 2;
  const w = f - <f32>k;
  const r = tab[k * 3] * (1 - w) + tab[(k + 1) * 3] * w;
  const g = tab[k * 3 + 1] * (1 - w) + tab[(k + 1) * 3 + 1] * w;
  const b = tab[k * 3 + 2] * (1 - w) + tab[(k + 1) * 3 + 2] * w;
  return (<u32>(r * 255) & 255) | ((<u32>(g * 255) & 255) << 8) | ((<u32>(b * 255) & 255) << 16) | (<u32>255 << 24);
}

const LUT_N: i32 = 256;
const lut: StaticArray<u32> = new StaticArray<u32>(LUT_N);
let lutId: i32 = -1;

function buildLut(id: i32): void {
  if (lutId == id) return;
  for (let k = 0; k < LUT_N; k++) lut[k] = colorAt(id, <f32>k / <f32>(LUT_N - 1));
  lutId = id;
}

// ---------------------------------------------------------------- statistics
export function minmax(vPtr: usize, n: i32, outPtr: usize): i32 {
  let lo: f32 = f32.MAX_VALUE, hi: f32 = -f32.MAX_VALUE, cnt = 0;
  for (let k = 0; k < n; k++) {
    const v = load<f32>(vPtr + (<usize>k << 2));
    if (v != v) continue;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
    cnt++;
  }
  store<f32>(outPtr, lo); store<f32>(outPtr + 4, hi);
  return cnt;
}

// ---------------------------------------------------------------- rasterizer
// world -> pixel:  px = (x - ox) * scale ;  py = (oy - y) * scale
// @ts-ignore: decorator
@inline function px(x: f64, ox: f64, scale: f64): f32 { return <f32>((x - ox) * scale); }
// @ts-ignore: decorator
@inline function py(y: f64, oy: f64, scale: f64): f32 { return <f32>((oy - y) * scale); }

function fillTri(
  ax: f32, ay: f32, av: f32, bx: f32, by: f32, bv: f32, cx: f32, cy: f32, cv: f32,
  W: i32, H: i32, vmin: f32, inv: f32, dry: bool, dryColor: u32, cellId: i32, rgbaPtr: usize, cellPtr: usize): void {
  let area = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay);
  if (area == 0) return;
  // make orientation positive by swapping b/c
  if (area < 0) {
    const tx = bx, ty = by, tv = bv; bx = cx; by = cy; bv = cv; cx = tx; cy = ty; cv = tv; area = -area;
  }
  let x0 = <i32>Mathf.floor(Mathf.min(ax, Mathf.min(bx, cx)));
  let x1 = <i32>Mathf.ceil (Mathf.max(ax, Mathf.max(bx, cx)));
  let y0 = <i32>Mathf.floor(Mathf.min(ay, Mathf.min(by, cy)));
  let y1 = <i32>Mathf.ceil (Mathf.max(ay, Mathf.max(by, cy)));
  if (x1 < 0 || y1 < 0 || x0 >= W || y0 >= H) return;
  if (x0 < 0) x0 = 0;
  if (y0 < 0) y0 = 0;
  if (x1 >= W) x1 = W - 1;
  if (y1 >= H) y1 = H - 1;
  const invA: f32 = 1 / area;
  const eps: f32 = -1e-3; // small tolerance closes hairline seams between triangles
  for (let yy = y0; yy <= y1; yy++) {
    const p_y = <f32>yy + 0.5;
    for (let xx = x0; xx <= x1; xx++) {
      const p_x = <f32>xx + 0.5;
      const w0 = ((bx - p_x) * (cy - p_y) - (cx - p_x) * (by - p_y)) * invA; // weight of a
      const w1 = ((cx - p_x) * (ay - p_y) - (ax - p_x) * (cy - p_y)) * invA; // weight of b
      const w2: f32 = <f32>1 - w0 - w1;
      if (w0 < eps || w1 < eps || w2 < eps) continue;
      const idx = yy * W + xx;
      let color: u32;
      if (dry) color = dryColor;
      else {
        const v = av * w0 + bv * w1 + cv * w2;
        const t = (v - vmin) * inv;
        let k = <i32>(t * <f32>(LUT_N - 1) + 0.5);
        if (k < 0) k = 0; else if (k >= LUT_N) k = LUT_N - 1;
        color = lut[k];
      }
      store<u32>(rgbaPtr + (<usize>idx << 2), color);
      store<i32>(cellPtr + (<usize>idx << 2), cellId);
    }
  }
}

/** Render a scalar field on the curvilinear grid into an RGBA buffer.
 *  dryColor: packed RGBA for dry cells (0 = transparent). Returns the number of cells rasterized. */
export function rasterize(
  xPtr: usize, yPtr: usize, vPtr: usize, dPtr: usize,
  ni: i32, nj: i32, W: i32, H: i32,
  ox: f64, oy: f64, scale: f64,
  vmin: f32, vmax: f32, cmap: i32, dryThr: f32, dryColor: u32,
  rgbaPtr: usize, cellPtr: usize): i32 {
  buildLut(cmap);
  const npx = <usize>(W * H);
  memory.fill(rgbaPtr, 0, npx << 2);
  for (let k: usize = 0; k < npx; k++) store<i32>(cellPtr + (k << 2), -1);

  const inv: f32 = vmax > vmin ? 1 / (vmax - vmin) : 0;
  let drawn = 0;
  for (let j = 0; j < nj - 1; j++) {
    for (let i = 0; i < ni - 1; i++) {
      const i00 = <usize>(j * ni + i), i10 = i00 + 1, i01 = i00 + <usize>ni, i11 = i01 + 1;
      const v00 = load<f32>(vPtr + (i00 << 2)), v10 = load<f32>(vPtr + (i10 << 2));
      const v01 = load<f32>(vPtr + (i01 << 2)), v11 = load<f32>(vPtr + (i11 << 2));
      if (v00 != v00 || v10 != v10 || v01 != v01 || v11 != v11) continue;
      let dry = false;
      if (dPtr != 0) {
        dry = load<f32>(dPtr + (i00 << 2)) <= dryThr && load<f32>(dPtr + (i10 << 2)) <= dryThr &&
              load<f32>(dPtr + (i01 << 2)) <= dryThr && load<f32>(dPtr + (i11 << 2)) <= dryThr;
      }
      const x00 = px(load<f32>(xPtr + (i00 << 2)), ox, scale), y00 = py(load<f32>(yPtr + (i00 << 2)), oy, scale);
      const x10 = px(load<f32>(xPtr + (i10 << 2)), ox, scale), y10 = py(load<f32>(yPtr + (i10 << 2)), oy, scale);
      const x01 = px(load<f32>(xPtr + (i01 << 2)), ox, scale), y01 = py(load<f32>(yPtr + (i01 << 2)), oy, scale);
      const x11 = px(load<f32>(xPtr + (i11 << 2)), ox, scale), y11 = py(load<f32>(yPtr + (i11 << 2)), oy, scale);
      const cid = j * ni + i;
      fillTri(x00, y00, v00, x10, y10, v10, x11, y11, v11, W, H, vmin, inv, dry, dryColor, cid, rgbaPtr, cellPtr);
      fillTri(x00, y00, v00, x11, y11, v11, x01, y01, v01, W, H, vmin, inv, dry, dryColor, cid, rgbaPtr, cellPtr);
      drawn++;
    }
  }
  return drawn;
}

/** Overlay grid lines (every N-th line) into the rgba buffer with a simple DDA. */
export function gridLines(
  xPtr: usize, yPtr: usize, ni: i32, nj: i32, W: i32, H: i32,
  ox: f64, oy: f64, scale: f64, every: i32, color: u32, rgbaPtr: usize): void {
  for (let j = 0; j < nj; j += every) for (let i = 0; i < ni - 1; i++) segment(xPtr, yPtr, ni, i, j, i + 1, j, W, H, ox, oy, scale, color, rgbaPtr);
  for (let i = 0; i < ni; i += every) for (let j = 0; j < nj - 1; j++) segment(xPtr, yPtr, ni, i, j, i, j + 1, W, H, ox, oy, scale, color, rgbaPtr);
}

function segment(xPtr: usize, yPtr: usize, ni: i32, i0: i32, j0: i32, i1: i32, j1: i32,
                 W: i32, H: i32, ox: f64, oy: f64, scale: f64, color: u32, rgbaPtr: usize): void {
  const a = <usize>(j0 * ni + i0), b = <usize>(j1 * ni + i1);
  const x0 = px(load<f32>(xPtr + (a << 2)), ox, scale), y0 = py(load<f32>(yPtr + (a << 2)), oy, scale);
  const x1 = px(load<f32>(xPtr + (b << 2)), ox, scale), y1 = py(load<f32>(yPtr + (b << 2)), oy, scale);
  const dx = x1 - x0, dy = y1 - y0;
  const n = <i32>Mathf.ceil(Mathf.max(Mathf.abs(dx), Mathf.abs(dy)));
  if (n <= 0) return;
  for (let k = 0; k <= n; k++) {
    const t = <f32>k / <f32>n;
    const xx = <i32>(x0 + dx * t), yy = <i32>(y0 + dy * t);
    if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
    store<u32>(rgbaPtr + (<usize>(yy * W + xx) << 2), color);
  }
}

/** Compute velocity arrow segments in pixel space.
 *  out: f32[maxOut*5] = x1,y1,x2,y2,magnitude ; returns count. */
export function arrows(
  xPtr: usize, yPtr: usize, uPtr: usize, vPtr: usize, dPtr: usize,
  ni: i32, nj: i32, step: i32, ox: f64, oy: f64, scale: f64,
  pxPerUnit: f32, dryThr: f32, outPtr: usize, maxOut: i32): i32 {
  let n = 0;
  for (let j = 0; j < nj; j += step) {
    for (let i = 0; i < ni; i += step) {
      if (n >= maxOut) return n;
      const k = <usize>(j * ni + i);
      const u = load<f32>(uPtr + (k << 2)), v = load<f32>(vPtr + (k << 2));
      if (u != u || v != v) continue;
      if (dPtr != 0 && load<f32>(dPtr + (k << 2)) <= dryThr) continue;
      const mag = Mathf.sqrt(u * u + v * v);
      if (mag < 1e-6) continue;
      const x0 = px(load<f32>(xPtr + (k << 2)), ox, scale), y0 = py(load<f32>(yPtr + (k << 2)), oy, scale);
      const o = outPtr + (<usize>n * 20);
      store<f32>(o, x0); store<f32>(o + 4, y0);
      store<f32>(o + 8, x0 + u * pxPerUnit); store<f32>(o + 12, y0 - v * pxPerUnit);
      store<f32>(o + 16, mag);
      n++;
    }
  }
  return n;
}

// ---------------------------------------------------------------- analysis kernels
/** Planar cell areas (shoelace on the 4 nodes) from metric coordinates.
 *  out: f32[(ni-1)*(nj-1)]; returns the total area. */
export function cellAreas(xPtr: usize, yPtr: usize, ni: i32, nj: i32, outPtr: usize): f64 {
  let total: f64 = 0;
  for (let j = 0; j < nj - 1; j++) {
    for (let i = 0; i < ni - 1; i++) {
      const a = <usize>(j * ni + i), b = a + 1, c = a + <usize>ni + 1, d = a + <usize>ni;
      const xa = <f64>load<f32>(xPtr + (a << 2)), ya = <f64>load<f32>(yPtr + (a << 2));
      const xb = <f64>load<f32>(xPtr + (b << 2)), yb = <f64>load<f32>(yPtr + (b << 2));
      const xc = <f64>load<f32>(xPtr + (c << 2)), yc = <f64>load<f32>(yPtr + (c << 2));
      const xd = <f64>load<f32>(xPtr + (d << 2)), yd = <f64>load<f32>(yPtr + (d << 2));
      const area = Math.abs((xa * yb - xb * ya) + (xb * yc - xc * yb) + (xc * yd - xd * yc) + (xd * ya - xa * yd)) * 0.5;
      store<f32>(outPtr + (<usize>(j * (ni - 1) + i) << 2), <f32>area);
      total += area;
    }
  }
  return total;
}

/** Domain-wide wet statistics for one time step.
 *  A cell is wet when its mean node depth exceeds thr.
 *  out: f64[4] = wet area [m2], stored volume [m3], max depth [m], max speed [m/s]. */
export function wetStats(dPtr: usize, uPtr: usize, vPtr: usize, areaPtr: usize,
                         ni: i32, nj: i32, thr: f32, outPtr: usize): void {
  let area: f64 = 0, vol: f64 = 0, maxD: f64 = 0, maxV: f64 = 0;
  for (let j = 0; j < nj - 1; j++) {
    for (let i = 0; i < ni - 1; i++) {
      const a = <usize>(j * ni + i), b = a + 1, c = a + <usize>ni + 1, d = a + <usize>ni;
      const da = load<f32>(dPtr + (a << 2)), db = load<f32>(dPtr + (b << 2));
      const dc = load<f32>(dPtr + (c << 2)), dd = load<f32>(dPtr + (d << 2));
      const mean = (da + db + dc + dd) * 0.25;
      if (mean != mean || mean <= thr) continue;
      const ca = <f64>load<f32>(areaPtr + (<usize>(j * (ni - 1) + i) << 2));
      area += ca; vol += ca * <f64>mean;
    }
  }
  const n = ni * nj;
  for (let k = 0; k < n; k++) {
    const dep = load<f32>(dPtr + (<usize>k << 2));
    if (dep == dep && dep > thr) {
      if (<f64>dep > maxD) maxD = <f64>dep;
      if (uPtr != 0) {
        const u = load<f32>(uPtr + (<usize>k << 2)), v = load<f32>(vPtr + (<usize>k << 2));
        const s = <f64>Mathf.sqrt(u * u + v * v);
        if (s > maxV) maxV = s;
      }
    }
  }
  store<f64>(outPtr, area); store<f64>(outPtr + 8, vol); store<f64>(outPtr + 16, maxD); store<f64>(outPtr + 24, maxV);
}

/** Accumulate flood arrival time and inundation duration per node.
 *  arr: f32[n] initialised to NaN, set to tSec on first depth > thr.
 *  dur: f32[n] initialised to 0, incremented by dtSec while depth > thr. */
export function accumulate(dPtr: usize, thr: f32, tSec: f32, dtSec: f32, arrPtr: usize, durPtr: usize, n: i32): void {
  for (let k = 0; k < n; k++) {
    const o = <usize>k << 2;
    const dep = load<f32>(dPtr + o);
    if (dep != dep || dep <= thr) continue;
    const a = load<f32>(arrPtr + o);
    if (a != a) store<f32>(arrPtr + o, tSec);
    store<f32>(durPtr + o, load<f32>(durPtr + o) + dtSec);
  }
}
