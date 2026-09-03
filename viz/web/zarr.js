// Minimal Zarr v2 reader (no external dependencies).
// Supports: C-order arrays, '<f4' '<f8' '<i4' '<u1' dtypes, compressor null or zlib
// (decoded with the browser's native DecompressionStream), any dimension separator.

const DTYPES = {
  '<f4': Float32Array, '<f8': Float64Array, '<i4': Int32Array, '<u4': Uint32Array,
  '<i2': Int16Array, '<u2': Uint16Array, '|u1': Uint8Array, '|i1': Int8Array,
};

async function fetchJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return r.json();
}

async function decompress(buf, compressor) {
  if (!compressor) return buf;
  const fmt = { zlib: 'deflate', gzip: 'gzip' }[compressor.id];
  if (!fmt) throw new Error(`unsupported compressor ${compressor.id}`);
  const ds = new DecompressionStream(fmt);
  const stream = new Blob([buf]).stream().pipeThrough(ds);
  return new Response(stream).arrayBuffer();
}

export class ZarrArray {
  constructor(url, meta, attrs) {
    this.url = url; this.meta = meta; this.attrs = attrs;
    this.shape = meta.shape; this.chunks = meta.chunks;
    this.TypedArray = DTYPES[meta.dtype];
    if (!this.TypedArray) throw new Error(`unsupported dtype ${meta.dtype}`);
    this.sep = meta.dimension_separator || '.';
    this.cache = new Map();
    this.stats = { fetched: 0, bytes: 0, fetchMs: 0, decodeMs: 0 };
  }
  static async open(url) {
    const [meta, attrs] = await Promise.all([
      fetchJSON(`${url}/.zarray`), fetchJSON(`${url}/.zattrs`).catch(() => ({})),
    ]);
    if (meta.zarr_format !== 2) throw new Error('only zarr v2 supported');
    if (meta.order !== 'C' || meta.filters) throw new Error('unsupported array layout');
    return new ZarrArray(url, meta, attrs);
  }
  /** Fetch + decode one chunk by its grid index, e.g. [t, 0, 0]. Returns a TypedArray. */
  async getChunk(idx) {
    const key = idx.join(this.sep);
    if (this.cache.has(key)) return this.cache.get(key);
    const p = (async () => {
      const t0 = performance.now();
      const r = await fetch(`${this.url}/${key}`);
      if (!r.ok) throw new Error(`chunk ${key}: ${r.status}`);
      const raw = await r.arrayBuffer();
      const t1 = performance.now();
      const dec = await decompress(raw, this.meta.compressor);
      this.stats.fetched++; this.stats.bytes += raw.byteLength;
      this.stats.fetchMs += t1 - t0; this.stats.decodeMs += performance.now() - t1;
      return new this.TypedArray(dec);
    })();
    this.cache.set(key, p);
    return p;
  }
  /** Convenience: whole array when it is a single chunk. */
  async getAll() {
    if (!this.shape.every((s, k) => s === this.chunks[k])) throw new Error('multi-chunk array');
    return this.getChunk(this.shape.map(() => 0));
  }
}

export class ZarrGroup {
  constructor(url, attrs) { this.url = url; this.attrs = attrs; }
  static async open(url) {
    const [g, attrs] = await Promise.all([
      fetchJSON(`${url}/.zgroup`), fetchJSON(`${url}/.zattrs`).catch(() => ({})),
    ]);
    if (g.zarr_format !== 2) throw new Error('only zarr v2 supported');
    return new ZarrGroup(url, attrs);
  }
  array(path) { return ZarrArray.open(`${this.url}/${path}`); }
  group(path) { return ZarrGroup.open(`${this.url}/${path}`); }
}
