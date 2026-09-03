// Shared WebAssembly instance (AssemblyScript kernels) + linear-memory helpers.
// All kernels take byte offsets; the bump allocator never frees, so buffers are allocated once
// and reused (see `scratch` for the shared per-frame work buffers).

const imports = { env: { abort(msg, file, line, col) { throw new Error(`wasm abort ${line}:${col}`); }, seed: () => Math.random() * 2 ** 32, trace() {} } };
let instance;
try { ({ instance } = await WebAssembly.instantiateStreaming(fetch('viz.wasm'), imports)); }
catch (e) { ({ instance } = await WebAssembly.instantiate(await (await fetch('viz.wasm')).arrayBuffer(), imports)); }

export const W_ = instance.exports;
export const mem = () => W_.memory.buffer;
export const f32 = (ptr, n) => new Float32Array(mem(), ptr, n);
export const f64 = (ptr, n) => new Float64Array(mem(), ptr, n);
export const i32 = (ptr, n) => new Int32Array(mem(), ptr, n);
export const u8c = (ptr, n) => new Uint8ClampedArray(mem(), ptr, n);
export const alloc = (bytes) => W_.alloc(bytes);

export const CMAPS = { viridis: 0, jet: 1, blues: 2, terrain: 3, turbo: 4, rdbu: 5 };

/** Shared framebuffer (rgba + cell-id map) large enough for MAXPX pixels. */
export const MAXPX = 2560 * 1600;
export const fb = { rgba: alloc(MAXPX * 4), cell: alloc(MAXPX * 4), mm: alloc(8), stat: alloc(32) };

/** Shared per-node scratch buffers, grown on demand. */
export const scratch = { cap: 0, v: 0, d: 0, u: 0, w: 0, arrows: 0 };
export function ensureScratch(n) {
  if (n <= scratch.cap) return;
  scratch.cap = n;
  scratch.v = alloc(n * 4); scratch.d = alloc(n * 4); scratch.u = alloc(n * 4); scratch.w = alloc(n * 4);
  scratch.arrows = alloc(n * 5 * 4);
}
