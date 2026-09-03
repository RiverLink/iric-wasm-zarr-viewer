// MapView: one canvas showing a scalar field on a project's grid (wasm rasterizer) over optional
// XYZ basemap tiles, with zoom/pan, hover readout, click probing and in-map overlays
// (legend, title, zoom buttons, attribution).
import { W_, f32, i32, u8c, fb, scratch, ensureScratch, MAXPX } from './wasm.js';
import { shared } from './project.js';

const MAXM = 20037508.342789244;               // half the Web Mercator world width [m]
export const BASEMAPS = {
  none: null,
  gsi_pale:  { url: (z, x, y) => `https://cyberjapandata.gsi.go.jp/xyz/pale/${z}/${x}/${y}.png`,          zmin: 5, zmax: 18, attr: '地理院タイル（淡色地図）' },
  gsi_std:   { url: (z, x, y) => `https://cyberjapandata.gsi.go.jp/xyz/std/${z}/${x}/${y}.png`,           zmin: 5, zmax: 18, attr: '地理院タイル（標準地図）' },
  gsi_photo: { url: (z, x, y) => `https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/${z}/${x}/${y}.jpg`, zmin: 2, zmax: 18, attr: '地理院タイル（全国最新写真）' },
  gsi_hill:  { url: (z, x, y) => `https://cyberjapandata.gsi.go.jp/xyz/hillshademap/${z}/${x}/${y}.png`,  zmin: 2, zmax: 16, attr: '地理院タイル（陰影起伏図）' },
  osm:       { url: (z, x, y) => `https://tile.openstreetmap.org/${z}/${x}/${y}.png`,                    zmin: 0, zmax: 19, attr: '© OpenStreetMap contributors' },
};
const tileCache = new Map();
const tileWaiters = new Set();   // MapViews to re-render when a tile arrives
function getTile(src, z, x, y) {
  const n = 2 ** z;
  if (y < 0 || y >= n) return null;
  x = ((x % n) + n) % n;
  const key = `${src}/${z}/${x}/${y}`;
  let img = tileCache.get(key);
  if (img) return img;
  img = new Image(); img.crossOrigin = 'anonymous'; img.decoding = 'async';
  img.onload = () => { for (const v of tileWaiters) v.rerender(); };
  img.onerror = () => { img.failed = true; };
  img.src = BASEMAPS[src].url(z, x, y);
  if (tileCache.size > 800) tileCache.delete(tileCache.keys().next().value);
  tileCache.set(key, img);
  return img;
}
const el = (tag, cls) => { const e = document.createElement(tag); if (cls) e.className = cls; return e; };
const fmtSig = (v, s = 4) => Number.isFinite(v) ? (+v.toPrecision(s)).toString() : '-';

export class MapView {
  constructor(container, opts = {}) {
    this.opts = opts;
    this.wrap = el('div', 'mapwrap');
    this.canvas = el('canvas', 'view'); this.ctx = this.canvas.getContext('2d');
    this.readout = el('div', 'readout');
    this.attr = el('div', 'attr'); this.attr.hidden = true;
    this.titleEl = el('div', 'maptitle'); this.titleEl.hidden = true;
    this.legend = el('div', 'maplegend'); this.legend.hidden = true;
    this.legendCv = el('canvas'); this.legendCv.width = 256; this.legendCv.height = 1;
    this.legendMin = el('span'); this.legendMax = el('span'); this.legendLabel = el('span');
    const bar = el('div', 'bar'); bar.append(this.legendMin, this.legendCv, this.legendMax);
    this.legend.append(bar, this.legendLabel);
    this.zoom = el('div', 'zoombtns');
    for (const [txt, title, fn] of [['⌂', '全体表示', () => this.fitAll()], ['+', '拡大', () => this.zoomBy(1.5)], ['−', '縮小', () => this.zoomBy(1 / 1.5)]]) {
      const b = el('button'); b.textContent = txt; b.title = title; b.onclick = fn; this.zoom.append(b);
    }
    if (opts.noControls) this.zoom.hidden = true;
    this.wrap.append(this.canvas, this.readout, this.titleEl, this.legend, this.zoom, this.attr);
    container.appendChild(this.wrap);
    this.res = el('canvas'); this.resCtx = this.res.getContext('2d');
    this.view = { ox: 0, oy: 0, scale: 1 };
    this.W = 1; this.H = 1; this.dpr = 1;
    this.project = null; this.state = null; this.cellMap = null; this.last = {};
    this.rendering = false; this.pending = false;
    this.bindEvents();
    tileWaiters.add(this);
  }
  destroy() { tileWaiters.delete(this); this.wrap.remove(); }

  setProject(p) { const first = !this.project; this.project = p; if (first) this.fit(); }
  resize(cssW, cssH) {
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    let w = Math.max(1, Math.round(cssW * this.dpr)), h = Math.max(1, Math.round(cssH * this.dpr));
    if (w * h > MAXPX) { const f = Math.sqrt(MAXPX / (w * h)); w = Math.floor(w * f); h = Math.floor(h * f); }
    const cx = this.view.ox + this.W / 2 / this.view.scale, cy = this.view.oy - this.H / 2 / this.view.scale;
    this.W = w; this.H = h;
    this.canvas.width = w; this.canvas.height = h; this.canvas.style.width = `${cssW}px`; this.canvas.style.height = `${cssH}px`;
    this.res.width = w; this.res.height = h;
    this.view.ox = cx - w / 2 / this.view.scale; this.view.oy = cy + h / 2 / this.view.scale;
  }
  fit(bbox) {
    const [x0, y0, x1, y1] = bbox || this.project.bbox;
    const pad = 0.03;
    this.view.scale = Math.min(this.W / ((x1 - x0) * (1 + 2 * pad)), this.H / ((y1 - y0) * (1 + 2 * pad)));
    this.view.ox = (x0 + x1) / 2 - this.W / 2 / this.view.scale; this.view.oy = (y0 + y1) / 2 + this.H / 2 / this.view.scale;
  }
  fitAll() { this.fit(this.opts.fitBbox ? this.opts.fitBbox() : undefined); this.viewChanged(); }
  zoomBy(f) {
    const v = this.view, cx = v.ox + this.W / 2 / v.scale, cy = v.oy - this.H / 2 / v.scale;
    v.scale *= f; v.ox = cx - this.W / 2 / v.scale; v.oy = cy + this.H / 2 / v.scale; this.viewChanged();
  }
  setView(v) { this.view.ox = v.ox; this.view.oy = v.oy; this.view.scale = v.scale; }
  nodePx(k) { const p = this.project, o = shared.origin; return [(p.rx[k] - o[0] - this.view.ox) * this.view.scale, (this.view.oy - (p.ry[k] - o[1])) * this.view.scale]; }
  toDataURL(type = 'image/png', q = 0.9) { return this.canvas.toDataURL(type, q); }

  // ------------------------------------------------------------ events
  bindEvents() {
    const cv = this.canvas;
    const pix = (e) => { const r = cv.getBoundingClientRect(); return [Math.floor((e.clientX - r.left) * this.W / r.width), Math.floor((e.clientY - r.top) * this.H / r.height)]; };
    cv.addEventListener('wheel', (e) => {
      e.preventDefault();
      const [px, py] = pix(e), v = this.view;
      const wx = v.ox + px / v.scale, wy = v.oy - py / v.scale;
      v.scale *= e.deltaY < 0 ? 1.2 : 1 / 1.2;
      v.ox = wx - px / v.scale; v.oy = wy + py / v.scale;
      this.viewChanged();
    }, { passive: false });
    let drag = null;
    cv.addEventListener('mousedown', (e) => { drag = { x: e.clientX, y: e.clientY, ox: this.view.ox, oy: this.view.oy, moved: false }; });
    window.addEventListener('mouseup', (e) => {
      if (drag && !drag.moved && e.target === cv && this.cellMap) {
        const [px, py] = pix(e); const cid = this.cellAt(px, py);
        if (cid >= 0 && this.opts.onClick) this.opts.onClick(cid % this.project.ni, (cid / this.project.ni) | 0, this);
      }
      drag = null;
    });
    cv.addEventListener('mouseleave', () => { this.readout.textContent = ''; if (this.opts.onHover) this.opts.onHover(-1, this); });
    cv.addEventListener('mousemove', (e) => {
      if (drag) {
        const k = this.W / cv.getBoundingClientRect().width;
        if (Math.abs(e.clientX - drag.x) + Math.abs(e.clientY - drag.y) > 3) drag.moved = true;
        this.view.ox = drag.ox - (e.clientX - drag.x) * k / this.view.scale;
        this.view.oy = drag.oy + (e.clientY - drag.y) * k / this.view.scale;
        this.viewChanged(); return;
      }
      const [px, py] = pix(e); const cid = this.cellAt(px, py);
      this.readout.textContent = this.hoverText(px, py, cid);
      if (this.opts.onHover) this.opts.onHover(cid, this);
    });
  }
  viewChanged() { if (this.opts.onViewChange) this.opts.onViewChange(this.view, this); this.rerender(); }
  cellAt(px, py) { return (!this.cellMap || px < 0 || py < 0 || px >= this.W || py >= this.H) ? -1 : this.cellMap[py * this.W + px]; }
  hoverText(px, py, cid) {
    const p = this.project, s = this.state; if (!p || !s) return '';
    const o = shared.origin, wx = this.view.ox + px / this.view.scale + o[0], wy = this.view.oy - py / this.view.scale + o[1];
    let pos;
    if (p.hasMerc) { const lon = wx / 6378137 * 180 / Math.PI, lat = (2 * Math.atan(Math.exp(wy / 6378137)) - Math.PI / 2) * 180 / Math.PI; pos = `lon=${lon.toFixed(5)} lat=${lat.toFixed(5)}`; }
    else pos = `x=${wx.toFixed(1)} y=${wy.toFixed(1)}`;
    if (cid < 0) return pos;
    const i = cid % p.ni, j = (cid / p.ni) | 0, L = this.last;
    const f = (v) => Number.isFinite(v) ? v.toFixed(3) : '-';
    let txt = `cell (i=${i + 1}, j=${j + 1})  ${pos}\nnode ${p.A.crs || ''}: x=${p.origX[cid].toFixed(1)} y=${p.origY[cid].toFixed(1)}\n${s.label} = ${f(L.values?.[cid])} ${s.unit || ''}`;
    if (L.depth) txt += `\ndepth = ${f(L.depth[cid])} m`;
    if (L.u && L.w) txt += `   |V| = ${f(Math.hypot(L.u[cid], L.w[cid]))} m/s`;
    return txt;
  }

  // ------------------------------------------------------------ rendering
  rerender() { if (this.state) this.render(this.state); }
  /** state: { t, label, unit, cmap, vmin, vmax, dryMask, dryThr, vec, vecStep, vecScale, grid, basemap, opacity,
   *           values, depth, u, w, probe {i,j}, line [nodes], title, legendNote, hideLegend } */
  async render(state) {
    if (this.rendering) { this.pending = true; this.state = state; return; }
    this.rendering = true; this.state = state;
    try { this.draw(state); } catch (e) { console.error(e); if (this.opts.onError) this.opts.onError(e); }
    this.rendering = false;
    if (this.pending) { this.pending = false; this.render(this.state); }
  }
  draw(s) {
    const p = this.project, N = p.N, { W, H, view, ctx } = this;
    ensureScratch(N);
    f32(scratch.v, N).set(s.values);
    if (s.depth) f32(scratch.d, N).set(s.depth);
    if (s.u && s.w) { f32(scratch.u, N).set(s.u); f32(scratch.w, N).set(s.w); }
    this.last = { values: s.values, depth: s.depth, u: s.u, w: s.w };
    const withMap = s.basemap && s.basemap !== 'none' && p.hasMerc;
    const dryColor = withMap ? 0 : 0xFFE6E6E6;
    const t0 = performance.now();
    const cells = W_.rasterize(p.ptr.x, p.ptr.y, scratch.v, s.dryMask && s.depth ? scratch.d : 0, p.ni, p.nj, W, H,
      view.ox, view.oy, view.scale, s.vmin, s.vmax, s.cmap, s.dryThr ?? 0.01, dryColor, fb.rgba, fb.cell);
    if (s.grid) W_.gridLines(p.ptr.x, p.ptr.y, p.ni, p.nj, W, H, view.ox, view.oy, view.scale, 1, 0x60303030, fb.rgba);
    let nArrows = 0;
    if (s.vec && s.u && s.w) nArrows = W_.arrows(p.ptr.x, p.ptr.y, scratch.u, scratch.w, s.depth ? scratch.d : 0, p.ni, p.nj, s.vecStep || 3, view.ox, view.oy, view.scale, (s.vecScale || 6) * this.dpr, s.dryThr ?? 0.01, scratch.arrows, N);
    this.wasmMs = performance.now() - t0; this.cells = cells; this.nArrows = nArrows;
    this.cellMap = i32(fb.cell, W * H).slice();
    ctx.fillStyle = '#fafafa'; ctx.fillRect(0, 0, W, H);
    this.tilesPending = withMap ? this.drawTiles(s.basemap) : 0;
    this.resCtx.putImageData(new ImageData(u8c(fb.rgba, W * H * 4).slice(), W, H), 0, 0);
    ctx.globalAlpha = withMap ? (s.opacity ?? 0.8) : 1; ctx.drawImage(this.res, 0, 0); ctx.globalAlpha = 1;
    if (nArrows) this.drawArrows(nArrows);
    if (s.line) this.drawLine(s.line);
    if (s.probe) this.drawProbe(s.probe);
    if (s.overlay) s.overlay(ctx, this);
    this.attr.textContent = withMap ? BASEMAPS[s.basemap].attr : ''; this.attr.hidden = !withMap;
    this.titleEl.textContent = s.title || ''; this.titleEl.hidden = !s.title;
    if (s.hideLegend || !Number.isFinite(s.vmin)) this.legend.hidden = true;
    else {
      drawLegend(this.legendCv, s.cmap);
      this.legendMin.textContent = fmtSig(s.vmin); this.legendMax.textContent = fmtSig(s.vmax);
      this.legendLabel.textContent = `${s.label || ''} [${s.unit || '-'}]${s.legendNote ? '  ' + s.legendNote : ''}`;
      this.legend.hidden = false;
    }
  }
  drawTiles(src) {
    const bm = BASEMAPS[src], { W, H, view, ctx } = this, o = shared.origin;
    let z = Math.ceil(Math.log2(2 * MAXM * view.scale / 256));
    z = Math.max(bm.zmin, Math.min(bm.zmax, z));
    const tileM = 2 * MAXM / 2 ** z; this.tileZ = z;
    const west = view.ox + o[0], north = view.oy + o[1], east = west + W / view.scale, south = north - H / view.scale;
    const tx0 = Math.floor((west + MAXM) / tileM), tx1 = Math.floor((east + MAXM) / tileM);
    const ty0 = Math.floor((MAXM - north) / tileM), ty1 = Math.floor((MAXM - south) / tileM);
    let pending = 0; ctx.imageSmoothingEnabled = true;
    for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) {
      const img = getTile(src, z, tx, ty); if (!img) continue;
      const px = (tx * tileM - MAXM - west) * view.scale, py = (north - (MAXM - ty * tileM)) * view.scale, size = tileM * view.scale;
      if (img.complete && img.naturalWidth > 0) ctx.drawImage(img, px, py, size + 0.5, size + 0.5); else if (!img.failed) pending++;
    }
    return pending;
  }
  drawArrows(n) {
    const a = f32(scratch.arrows, n * 5), ctx = this.ctx, dpr = this.dpr;
    ctx.save(); ctx.lineWidth = dpr; ctx.strokeStyle = 'rgba(0,0,0,.75)'; ctx.beginPath();
    for (let k = 0; k < n; k++) {
      const x1 = a[k * 5], y1 = a[k * 5 + 1], x2 = a[k * 5 + 2], y2 = a[k * 5 + 3];
      ctx.moveTo(x1, y1); ctx.lineTo(x2, y2);
      const ang = Math.atan2(y2 - y1, x2 - x1), hl = Math.min(6 * dpr, Math.hypot(x2 - x1, y2 - y1) * 0.4);
      ctx.moveTo(x2, y2); ctx.lineTo(x2 - hl * Math.cos(ang - 0.5), y2 - hl * Math.sin(ang - 0.5));
      ctx.moveTo(x2, y2); ctx.lineTo(x2 - hl * Math.cos(ang + 0.5), y2 - hl * Math.sin(ang + 0.5));
    }
    ctx.stroke(); ctx.restore();
  }
  drawLine(nodes) {
    const ctx = this.ctx; ctx.save(); ctx.lineWidth = 2 * this.dpr; ctx.strokeStyle = '#d0021b'; ctx.beginPath();
    nodes.forEach((k, n) => { const [x, y] = this.nodePx(k); n ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
    ctx.stroke(); ctx.restore();
  }
  drawProbe(pr) {
    const ctx = this.ctx, [x, y] = this.nodePx(this.project.node(pr.i, pr.j));
    ctx.save(); ctx.lineWidth = 2 * this.dpr; ctx.strokeStyle = '#d0021b'; ctx.fillStyle = '#fff';
    ctx.beginPath(); ctx.arc(x, y, 5 * this.dpr, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); ctx.restore();
  }
}

/** Colour-bar into a 256x1 canvas. */
export function drawLegend(cv, cmap) {
  const c = cv.getContext('2d'), img = c.createImageData(256, 1), u32 = new Uint32Array(img.data.buffer);
  for (let k = 0; k < 256; k++) u32[k] = W_.colorAt(cmap, k / 255);
  c.putImageData(img, 0, 0);
}
