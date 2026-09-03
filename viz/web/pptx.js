// Browser-side PPTX generation with PptxGenJS (loaded from jsDelivr on first use).
// Takes the same report spec as report.py: { title, subtitle, sections: [{ title, bullets, images:[{dataUrl, caption}], table:{header, rows} }] }

const CDN = 'https://cdn.jsdelivr.net/npm/pptxgenjs@3.12.0/dist/pptxgen.bundle.js';
let loading = null;

function loadPptxGen() {
  if (window.PptxGenJS) return Promise.resolve(window.PptxGenJS);
  if (!loading) loading = new Promise((res, rej) => {
    const s = document.createElement('script'); s.src = CDN; s.onload = () => res(window.PptxGenJS); s.onerror = () => rej(new Error('PptxGenJS の読み込みに失敗しました (CDN)')); document.head.appendChild(s);
  });
  return loading;
}

const SW = 13.333, SH = 7.5, M = 0.5;
const imageSize = (dataUrl) => new Promise((res) => { const im = new Image(); im.onload = () => res([im.naturalWidth, im.naturalHeight]); im.onerror = () => res([4, 3]); im.src = dataUrl; });

async function placeImage(slide, im, x, y, w, h) {
  const [iw, ih] = await imageSize(im.dataUrl);
  const capH = im.caption ? 0.35 : 0;
  const s = Math.min(w / iw, (h - capH) / ih), pw = iw * s, ph = ih * s;
  slide.addImage({ data: im.dataUrl, x: x + (w - pw) / 2, y, w: pw, h: ph });
  if (im.caption) slide.addText(im.caption, { x, y: y + ph + 0.05, w, h: 0.3, fontSize: 11, color: '6A707A', align: 'center' });
}

export async function buildPptx(spec, fileName) {
  const PptxGenJS = await loadPptxGen();
  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_WIDE';
  let s = pptx.addSlide();
  s.addText(spec.title || 'iRIC 計算結果レポート', { x: M, y: 2.4, w: SW - 2 * M, h: 1.2, fontSize: 40, bold: true });
  if (spec.subtitle) s.addText(String(spec.subtitle).split('\n').map((t) => ({ text: t, options: { breakLine: true } })), { x: M, y: 3.7, w: SW - 2 * M, h: 1.5, fontSize: 16, color: '6A707A' });
  for (const sec of spec.sections || []) {
    s = pptx.addSlide();
    s.addText(sec.title || '', { x: M, y: 0.3, w: SW - 2 * M, h: 0.7, fontSize: 26, bold: true, color: '1F2328' });
    const top = 1.1, contentH = SH - top - M;
    const bullets = sec.bullets || [], images = sec.images || [];
    let imgLeft = M, imgW = SW - 2 * M;
    if (bullets.length) {
      const w = images.length ? 3.8 : SW - 2 * M;
      s.addText(bullets.map((b) => ({ text: String(b), options: { bullet: true, breakLine: true } })), { x: M, y: top, w, h: contentH, fontSize: 13, valign: 'top', paraSpaceAfter: 4 });
      if (images.length) { imgLeft = M + 4.0; imgW = SW - 2 * M - 4.0; }
    }
    const n = images.length;
    if (n === 1) await placeImage(s, images[0], imgLeft, top, imgW, contentH);
    else if (n === 2) { const w = (imgW - 0.2) / 2; for (let k = 0; k < 2; k++) await placeImage(s, images[k], imgLeft + k * (w + 0.2), top, w, contentH); }
    else if (n >= 3) {
      const cols = 2, rows = Math.ceil(Math.min(n, 6) / 2), w = (imgW - 0.2) / cols, h = (contentH - 0.2 * (rows - 1)) / rows;
      for (let k = 0; k < Math.min(n, 6); k++) { const r = Math.floor(k / cols), c = k % cols; await placeImage(s, images[k], imgLeft + c * (w + 0.2), top + r * (h + 0.2), w, h); }
    }
    const table = sec.table;
    if (table && table.rows && table.rows.length) {
      const s2 = pptx.addSlide();
      s2.addText((sec.title || '') + (images.length || bullets.length ? ' – 表' : ''), { x: M, y: 0.3, w: SW - 2 * M, h: 0.7, fontSize: 26, bold: true, color: '1F2328' });
      const rows = [table.header.map((h) => ({ text: String(h), options: { bold: true, fill: { color: 'F0F2F5' } } })), ...table.rows.map((r) => r.map((c) => String(c ?? '')))];
      s2.addTable(rows, { x: M, y: 1.1, w: SW - 2 * M, fontSize: 10, border: { type: 'solid', pt: 0.5, color: 'D9DCE1' }, autoPage: true, rowH: 0.32 });
    }
  }
  await pptx.writeFile({ fileName });
  return fileName;
}
