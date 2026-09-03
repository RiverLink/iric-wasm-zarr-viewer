// Small DOM helpers shared by the viewer and the comparison UI.

export const h = (tag, attrs = {}, ...children) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') el.className = v; else if (k === 'style') el.style.cssText = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v); else if (v !== null && v !== undefined && v !== false) el.setAttribute(k, v === true ? '' : v);
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
/** Sidebar field: label above control. */
export function labeled(text, el) { return h('label', { class: 'f' }, text, el); }
export function check(text, checked, onchange) {
  const id = 'c' + Math.random().toString(36).slice(2, 8);
  const c = h('input', { type: 'checkbox', id }); c.checked = checked; c.addEventListener('change', () => onchange(c.checked));
  return h('div', { class: 'row tight' }, c, h('label', { for: id }, text));
}
export function num(value, step, onchange, width = 74) {
  return h('input', { type: 'number', value, step, style: `width:${width}px`, oninput: (e) => onchange(+e.target.value) });
}

/** Time bar: play/stop, prev/next, slider, step input, speed, label. onChange(t) for every change.
 *  Keyboard (when focus is not in a field): ←/→ step, Shift+←/→ 10 steps, Space play/stop, Home/End. */
export function timebar(nt, timeArr, onChange) {
  const state = { t: 0, playing: false, fps: 12 };
  const play = h('button', { class: 'primary', title: '再生 / 停止 (Space)' }, '▶');
  const range = h('input', { type: 'range', min: 0, max: nt - 1, value: 0 });
  const stepIn = h('input', { type: 'number', min: 1, max: nt, value: 1, title: 'ステップ番号' });
  const label = h('span', { class: 't' });
  const speed = select([['6', '0.5×'], ['12', '1×'], ['24', '2×'], ['48', '4×']], '12', (v) => { state.fps = +v; });
  const set = (t, fire = true) => { state.t = ((t % nt) + nt) % nt; range.value = state.t; stepIn.value = state.t + 1; label.textContent = `t = ${timeArr[state.t]} s  (${state.t + 1}/${nt})`; if (fire) onChange(state.t); };
  range.addEventListener('input', () => set(+range.value));
  stepIn.addEventListener('change', () => set((+stepIn.value || 1) - 1));
  const prev = h('button', { onclick: () => set(state.t - 1), title: '前のステップ (←)' }, '◀'), next = h('button', { onclick: () => set(state.t + 1), title: '次のステップ (→)' }, '▶');
  let last = 0;
  const loop = async (ts) => {
    if (!state.playing) return;
    if (!ts || ts - last > 1000 / state.fps) { last = ts || 0; await set(state.t + 1); }
    requestAnimationFrame(loop);
  };
  const toggle = () => { state.playing = !state.playing; play.textContent = state.playing ? '❚❚' : '▶'; if (state.playing) loop(); };
  play.onclick = toggle;
  const onKey = (e) => {
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'select' || tag === 'textarea' || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === ' ') { e.preventDefault(); toggle(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); set(state.t - (e.shiftKey ? 10 : 1)); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); set(state.t + (e.shiftKey ? 10 : 1)); }
    else if (e.key === 'Home') { e.preventDefault(); set(0); }
    else if (e.key === 'End') { e.preventDefault(); set(nt - 1); }
  };
  window.addEventListener('keydown', onKey);
  const el = h('div', { class: 'timebar' }, play, prev, next, range, stepIn, label, speed);
  set(0, false);
  return { el, state, set, get t() { return state.t; }, stop() { state.playing = false; play.textContent = '▶'; }, destroy() { state.playing = false; window.removeEventListener('keydown', onKey); } };
}

/** Bottom (or right) drawer with tabs, a resize handle and a close button. */
export function drawer(stage, { tabs, onTab, onResize, storageKey = 'iric.drawer' }) {
  let saved = {}; try { saved = JSON.parse(localStorage.getItem(storageKey) || '{}'); } catch {}
  const info = h('span', { class: 'info' });
  const tabBtns = tabs.map(([id, label]) => h('button', { onclick: () => select(id) }, label));
  const close = h('button', { class: 'icon', title: '閉じる', onclick: () => setOpen(false) }, '×');
  const head = h('div', { class: 'dhead' }, h('div', { class: 'tabs' }, tabBtns), info, close);
  const canvas = h('canvas', { class: 'chart', width: 800, height: 260 });
  const el = h('div', { class: 'drawer' }, head, h('div', { class: 'dbody' }, canvas));
  let cur = tabs[0][0], open = false;
  const apply = () => { if (saved.h) document.documentElement.style.setProperty('--drawer-h', `${saved.h}px`); if (saved.w) document.documentElement.style.setProperty('--drawer-w', `${saved.w}px`); };
  apply();
  const save = () => { try { localStorage.setItem(storageKey, JSON.stringify(saved)); } catch {} };
  function select(id) { cur = id; tabBtns.forEach((b, k) => b.classList.toggle('on', tabs[k][0] === id)); onTab(id); }
  function setOpen(v) { open = v; el.hidden = !v; onResize(); }
  // drag to resize
  head.addEventListener('mousedown', (e) => {
    if (e.target.tagName === 'BUTTON') return;
    const side = stage.classList.contains('side'), start = side ? e.clientX : e.clientY, h0 = side ? el.offsetWidth : el.offsetHeight;
    const move = (ev) => { const d = side ? start - ev.clientX : start - ev.clientY; const v = Math.max(140, h0 + d); if (side) { saved.w = v; } else { saved.h = v; } apply(); onResize(); };
    const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); save(); };
    window.addEventListener('mousemove', move); window.addEventListener('mouseup', up); e.preventDefault();
  });
  tabBtns.forEach((b, k) => b.classList.toggle('on', tabs[k][0] === cur)); el.hidden = true;   // no onTab during construction
  return { el, canvas, info, get open() { return open; }, get tab() { return cur; }, setOpen, select, enable(id, on) { const k = tabs.findIndex((t) => t[0] === id); if (k >= 0) tabBtns[k].disabled = !on; } };
}

export const fmt = (v, d = 3) => Number.isFinite(v) ? (+v.toFixed(d)).toLocaleString() : '-';
export const fmtSig = (v, s = 4) => Number.isFinite(v) ? (+v.toPrecision(s)).toString() : '-';

export function downloadText(name, text, type = 'text/csv') {
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(['﻿' + text], { type })); a.download = name; a.click();
}

/** Observe an element's size; callback receives (width, height) in CSS px. */
export function observeSize(el, cb) {
  const ro = new ResizeObserver(() => { const r = el.getBoundingClientRect(); if (r.width > 0 && r.height > 0) cb(r.width, r.height); });
  ro.observe(el); return ro;
}
