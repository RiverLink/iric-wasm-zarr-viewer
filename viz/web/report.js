// Report helpers: offscreen chart/map snapshots and PPTX download through the server.
import { drawChart } from './charts.js';
import { MapView } from './mapview.js';

export function chartImage(spec, w = 1600, h = 520) {
  const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
  const c = cv.getContext('2d'); c.fillStyle = '#fff'; c.fillRect(0, 0, w, h);
  drawChart(cv, spec, 1);
  return cv.toDataURL('image/png');
}

/** Render a map state into a hidden MapView and return a PNG data URL (waits for basemap tiles). */
export async function snapshotMap(project, state, { w = 1200, h = 720, view = null } = {}) {
  const host = document.createElement('div'); host.style.cssText = 'position:fixed; left:-10000px; top:0; width:' + w + 'px;';
  document.body.appendChild(host);
  const mv = new MapView(host, {});
  try {
    mv.setProject(project); mv.resize(w, h);
    if (view) mv.setView(view); else mv.fit();
    mv.draw(state);
    for (let k = 0; k < 40 && mv.tilesPending > 0; k++) { await new Promise((r) => setTimeout(r, 100)); mv.draw(state); }
    return mv.toDataURL('image/jpeg', 0.85);
  } finally { mv.destroy(); host.remove(); }
}

export async function downloadReport(spec, filename = 'iric_report.pptx') {
  // 1) build in the browser (works on static hosting); 2) fall back to the Python server
  try { const { buildPptx } = await import('./pptx.js'); await buildPptx(spec, filename); return 0; }
  catch (e) { console.warn('browser pptx failed, trying server', e); }
  const r = await fetch('/api/report', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...spec, filename }) });
  if (!r.ok) { let msg = r.statusText; try { msg = (await r.json()).error || msg; } catch {} throw new Error(`report failed: ${msg}`); }
  const blob = await r.blob();
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  return blob.size;
}

export const today = () => new Date().toISOString().slice(0, 10);
