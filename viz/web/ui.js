// Small DOM helpers shared by the viewer and the comparison UI.

export const h = (tag, attrs = {}, ...children) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') el.className = v; else if (k === 'style') el.style.cssText = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v); else if (v !== null && v !== undefined) el.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined) el.append(c.nodeType ? c : String(c));
  return el;
};

export function select(options, value, onchange) {
  const s = h('select', { onchange: (e) => onchange(e.target.value) });
  for (const [v, label] of options) s.append(h('option', { value: v }, label));
  if (value !== undefined) s.value = value;
  return s;
}
export function labeled(text, el) { return h('label', {}, text, el); }
export function check(text, checked, onchange) {
  const id = 'c' + Math.random().toString(36).slice(2, 8);
  const c = h('input', { type: 'checkbox', id }); c.checked = checked; c.addEventListener('change', () => onchange(c.checked));
  return h('div', { class: 'row' }, c, h('label', { for: id, style: 'flex-direction:row' }, text));
}
export function num(value, step, onchange, width = 80) {
  const n = h('input', { type: 'number', value, step, style: `width:${width}px`, oninput: (e) => onchange(+e.target.value) });
  return n;
}

/** Time bar: play/stop, prev/next, slider, label. onChange(t) is called for every change. */
export function timebar(nt, timeArr, onChange, fps = 12) {
  const state = { t: 0, playing: false };
  const play = h('button', { class: 'primary' }, '▶ 再生');
  const range = h('input', { type: 'range', min: 0, max: nt - 1, value: 0 });
  const label = h('span', { class: 't' });
  const set = (t, fire = true) => { state.t = ((t % nt) + nt) % nt; range.value = state.t; label.textContent = `step ${state.t + 1}/${nt}   t = ${timeArr[state.t]} s`; if (fire) onChange(state.t); };
  range.addEventListener('input', () => set(+range.value));
  const prev = h('button', { onclick: () => set(state.t - 1) }, '◀'), next = h('button', { onclick: () => set(state.t + 1) }, '▶');
  let last = 0;
  const loop = async (ts) => {
    if (!state.playing) return;
    if (!ts || ts - last > 1000 / fps) { last = ts || 0; await set(state.t + 1); }
    requestAnimationFrame(loop);
  };
  play.onclick = () => { state.playing = !state.playing; play.textContent = state.playing ? '❚❚ 停止' : '▶ 再生'; if (state.playing) loop(); };
  const el = h('div', { class: 'timebar' }, play, prev, next, range, label);
  set(0, false);
  return { el, state, set, get t() { return state.t; }, stop() { state.playing = false; play.textContent = '▶ 再生'; } };
}

export const fmt = (v, d = 3) => Number.isFinite(v) ? (+v.toFixed(d)).toLocaleString() : '-';
export const fmtSig = (v, s = 4) => Number.isFinite(v) ? (+v.toPrecision(s)).toString() : '-';

export function downloadText(name, text, type = 'text/csv') {
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(['﻿' + text], { type })); a.download = name; a.click();
}
