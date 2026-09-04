// In-memory data store with the same surface as zarr.js (ZarrGroup / ZarrArray) so Project can be
// built from arrays converted in the browser (see local.js) or restored from IndexedDB.
//
// data = { attrs, x, y (Float32Array N), mx, my (Float64Array N | null), time (Float64Array nt),
//          results: { key: { data: Float32Array(steps*N), steps (1 for time-invariant), min, max, original_name } } }

class MemArray {
  constructor(shape, data, attrs = {}) {
    this.shape = shape; this.chunks = shape.length === 3 ? [1, shape[1], shape[2]] : shape.slice();
    this.data = data; this.attrs = attrs;
    this.stats = { fetched: 0, bytes: 0, fetchMs: 0, decodeMs: 0 };
    this.cache = new Map();
    this.N = shape.length === 3 ? shape[1] * shape[2] : data.length;
  }
  async getAll() { return this.data; }
  async getChunk(idx) {
    if (this.shape.length !== 3) return this.data;
    const t = this.shape[0] === 1 ? 0 : idx[0];
    return this.data.subarray(t * this.N, (t + 1) * this.N);
  }
}

export class MemGroup {
  constructor(data) {
    this.data = data; this.attrs = data.attrs;
    const { ni, nj, nt } = data.attrs;
    this.arrays = {
      'grid/x': new MemArray([nj, ni], data.x), 'grid/y': new MemArray([nj, ni], data.y),
      time: new MemArray([nt], data.time),
    };
    if (data.mx) { this.arrays['grid/x3857'] = new MemArray([nj, ni], data.mx); this.arrays['grid/y3857'] = new MemArray([nj, ni], data.my); }
    for (const [k, r] of Object.entries(data.results)) {
      const steps = r.steps || (r.data.length / (ni * nj));
      this.arrays[`results/${k}`] = new MemArray([steps, nj, ni], r.data, { min: r.min, max: r.max, original_name: r.original_name, static: steps === 1 });
    }
  }
  async array(path) {
    const a = this.arrays[path];
    if (!a) throw new Error(`no array ${path}`);
    return a;
  }
}
