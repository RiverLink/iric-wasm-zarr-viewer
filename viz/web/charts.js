// Minimal canvas line charts (no libraries).
//   drawChart(canvas, spec, dpr)
//   spec = { panels: [panel, ...] }  or a single panel
//   panel = { title, x: number[], series: [{ name, y: number[], color, fill?, dash? }], xlabel, marker?, legend? }

export const PALETTE = ['#1f77b4', '#d62728', '#2ca02c', '#9467bd', '#ff7f0e', '#17becf', '#8c564b', '#e377c2'];

export function drawChart(cv, spec, dpr = 1, message = '') {
  const c = cv.getContext('2d');
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  const Wc = cv.width / dpr, Hc = cv.height / dpr;
  c.clearRect(0, 0, Wc, Hc);
  if (!spec) { c.font = '12px system-ui, sans-serif'; c.fillStyle = '#6a707a'; c.fillText(message, 12, 24); return; }
  const panels = spec.panels || [spec];
  const n = panels.length, cols = spec.cols || (n <= 2 ? n : Math.min(n, 4)), rows = Math.ceil(n / cols);
  const pw = Wc / cols, ph = Hc / rows;
  panels.forEach((p, k) => drawPanel(c, p, (k % cols) * pw, Math.floor(k / cols) * ph, pw, ph));
}

function niceTicks(lo, hi, n = 5) {
  const span = hi - lo || 1, step0 = span / n, mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => span / s <= n) || mag * 10;
  const out = []; for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(+v.toPrecision(10));
  return out;
}

export function drawPanel(c, d, x0, y0, w, h) {
  const ml = 58, mr = 12, mt = 26, mb = 30;
  const px0 = x0 + ml, py0 = y0 + mt, pw = w - ml - mr, ph = h - mt - mb;
  const xs = d.x; let lo = Infinity, hi = -Infinity;
  for (const s of d.series) for (const v of s.y) if (Number.isFinite(v)) { if (v < lo) lo = v; if (v > hi) hi = v; }
  if (!Number.isFinite(lo)) { lo = 0; hi = 1; }
  if (d.ymin !== undefined) lo = Math.min(lo, d.ymin);
  if (hi - lo < 1e-9) hi = lo + 1;
  const pad = (hi - lo) * 0.05; lo -= pad; hi += pad;
  const xmin = xs[0], xmax = xs[xs.length - 1] || 1;
  const X = (v) => px0 + (v - xmin) / (xmax - xmin) * pw, Y = (v) => py0 + (hi - v) / (hi - lo) * ph;
  c.strokeStyle = '#d9dce1'; c.lineWidth = 1; c.fillStyle = '#6a707a'; c.font = '11px system-ui, sans-serif';
  c.textAlign = 'right'; c.textBaseline = 'middle';
  for (const v of niceTicks(lo, hi, Math.max(2, Math.min(5, Math.floor(ph / 40))))) { c.beginPath(); c.moveTo(px0, Y(v)); c.lineTo(px0 + pw, Y(v)); c.stroke(); c.fillText(v.toLocaleString(), px0 - 6, Y(v)); }
  c.textAlign = 'center'; c.textBaseline = 'top';
  for (const v of niceTicks(xmin, xmax, Math.max(2, Math.min(6, Math.floor(pw / 90))))) { c.beginPath(); c.moveTo(X(v), py0); c.lineTo(X(v), py0 + ph); c.stroke(); c.fillText(v.toLocaleString(), X(v), py0 + ph + 4); }
  c.strokeStyle = '#9aa0a6'; c.strokeRect(px0, py0, pw, ph);
  c.fillStyle = '#1f2328'; c.font = '600 12px system-ui, sans-serif'; c.textAlign = 'left'; c.textBaseline = 'alphabetic';
  c.fillText(d.title || '', px0, py0 - 8);
  c.font = '11px system-ui, sans-serif'; c.fillStyle = '#6a707a'; c.textAlign = 'right'; c.fillText(d.xlabel || '', px0 + pw, py0 + ph + 26);
  c.save(); c.beginPath(); c.rect(px0, py0, pw, ph); c.clip();
  d.series.forEach((s) => {
    c.strokeStyle = s.color; c.lineWidth = s.width || 1.6; c.setLineDash(s.dash || []); c.beginPath(); let pen = false;
    for (let k = 0; k < xs.length; k++) { const v = s.y[k]; if (!Number.isFinite(v)) { pen = false; continue; } pen ? c.lineTo(X(xs[k]), Y(v)) : c.moveTo(X(xs[k]), Y(v)); pen = true; }
    c.stroke(); c.setLineDash([]);
    if (s.fill) { c.lineTo(X(xs[xs.length - 1]), py0 + ph); c.lineTo(X(xs[0]), py0 + ph); c.closePath(); c.fillStyle = s.color + '33'; c.fill(); }
  });
  let km = -1;
  if (Number.isFinite(d.marker)) {
    c.strokeStyle = '#d0021b'; c.setLineDash([4, 3]); c.beginPath(); c.moveTo(X(d.marker), py0); c.lineTo(X(d.marker), py0 + ph); c.stroke(); c.setLineDash([]);
    km = 0; for (let k = 1; k < xs.length; k++) if (Math.abs(xs[k] - d.marker) < Math.abs(xs[km] - d.marker)) km = k;
    d.series.forEach((s) => {
      const v = s.y[km]; if (!Number.isFinite(v)) return;
      c.fillStyle = s.color; c.beginPath(); c.arc(X(xs[km]), Y(v), 4, 0, Math.PI * 2); c.fill();
      c.strokeStyle = '#fff'; c.lineWidth = 1.5; c.stroke();
    });
  }
  c.restore();
  if (km >= 0 && d.series.length) {
    const txt = d.series.map((s) => Number.isFinite(s.y[km]) ? (+s.y[km].toPrecision(4)).toString() : '-').join(' / ');
    c.font = '600 12px ui-monospace, Consolas, monospace'; c.fillStyle = '#d0021b'; c.textAlign = 'right'; c.textBaseline = 'alphabetic';
    const tw = c.measureText(txt).width; c.font = '600 12px system-ui, sans-serif'; const ttw = c.measureText(d.title || '').width;
    c.font = '600 12px ui-monospace, Consolas, monospace';
    if (ttw + tw + 16 <= pw) c.fillText(txt, px0 + pw, py0 - 8);          // beside the title (skipped when the panel is too narrow)
  }
  if (d.legend !== false && d.series.length > 1 || d.legend) {
    c.font = '11px system-ui, sans-serif'; c.textAlign = 'left'; c.textBaseline = 'middle';
    let lx = px0 + 8, ly = py0 + 9;
    for (const s of d.series) {
      const tw = c.measureText(s.name).width;
      if (lx + 18 + tw > px0 + pw - 4) { lx = px0 + 8; ly += 14; }
      c.fillStyle = s.color; c.fillRect(lx, ly - 1, 14, 3); c.fillStyle = '#1f2328'; c.fillText(s.name, lx + 18, ly); lx += 18 + tw + 16;
    }
  }
}
