// Small helpers shared by every part of the app.

export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];
export const sleep = ms => new Promise(r => setTimeout(r, ms));
export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export const idOf = uri => (uri || '').split(':').pop();

// Leaves a short note in the own window's log (launcher\standalone.log), for working out problems.
export const report = msg => bus.emit('report', String(msg));

export class ApiError extends Error {
  constructor(status, message, reason) {
    super(message || `Request failed (${status})`);
    this.status = status;
    this.reason = reason;
  }
}

// ---- DOM builder -----------------------------------------------------------
export function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  if (props) {
    for (const k in props) {
      const v = props[k];
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (typeof v !== 'string' && k in el) el[k] = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  append(el, kids);
  return el;
}
function append(el, kids) {
  for (const k of kids) {
    if (k == null || k === false) continue;
    if (Array.isArray(k)) append(el, k);
    else el.append(k.nodeType ? k : document.createTextNode(String(k)));
  }
}

// ---- Icons (simple line icons drawn for this app) -----------------------------
const F = 'fill="currentColor" stroke="none"';
const ICONS = {
  play: `<path d="M8 5.5v13a1 1 0 0 0 1.5.86l11-6.5a1 1 0 0 0 0-1.72l-11-6.5A1 1 0 0 0 8 5.5z" ${F}/>`,
  pause: `<rect x="6" y="5" width="4.5" height="14" rx="1.5" ${F}/><rect x="13.5" y="5" width="4.5" height="14" rx="1.5" ${F}/>`,
  next: `<path d="M5 5.6v12.8a1 1 0 0 0 1.52.85L16 13.6v4.9a1 1 0 0 0 2 0v-13a1 1 0 0 0-2 0v4.9L6.52 4.75A1 1 0 0 0 5 5.6z" ${F}/>`,
  prev: `<g transform="translate(24 0) scale(-1 1)"><path d="M5 5.6v12.8a1 1 0 0 0 1.52.85L16 13.6v4.9a1 1 0 0 0 2 0v-13a1 1 0 0 0-2 0v4.9L6.52 4.75A1 1 0 0 0 5 5.6z" ${F}/></g>`,
  shuffle: '<path d="M3 7h3.2c2 0 3.4 1 4.4 2.7l2.8 4.6c1 1.700 2.400 2.700 4.400 2.700H21M3 17h3.200c1.300 0 2.400-.400 3.200-1.200M21 7h-3.200c-1.300 0-2.400.4-3.200 1.200M18 4l3 3-3 3M18 14l3 3-3 3"/>',
  smartShuffle: '<path d="M3 8h2.700c1.900 0 3.200 1 4.200 2.600l2.600 4.200c1 1.600 2.300 2.400 4.200 2.400H21M3 17h3.200c1.300 0 2.300-.400 3.100-1.100M18 14l3 3.200-3 3.200"/><path d="M17.500 2.500c.300 1.800 1.200 2.700 3 3-1.800.300-2.700 1.200-3 3-.300-1.800-1.200-2.700-3-3 1.800-.300 2.700-1.200 3-3z" fill="currentColor" stroke-width="1.200"/>',
  sparkle: '<path d="M12 3c.6 4.200 2.800 6.400 7 7-4.200.6-6.400 2.800-7 7-.6-4.200-2.800-6.400-7-7 4.200-.6 6.400-2.800 7-7z" fill="currentColor" stroke-width="1.400"/><path d="M19 15.500c.200 1.300.900 2 2.200 2.200-1.300.200-2 .900-2.200 2.200-.200-1.300-.900-2-2.200-2.200 1.300-.200 2-.900 2.200-2.200z" fill="currentColor" stroke-width="1"/>',
  repeat: '<path d="M17 2.500l3 3-3 3M4 11.500v-2a4 4 0 0 1 4-4h12M7 21.500l-3-3 3-3M20 12.500v2a4 4 0 0 1-4 4H4"/>',
  repeat1: '<path d="M17 2.500l3 3-3 3M4 11.500v-2a4 4 0 0 1 4-4h12M7 21.500l-3-3 3-3M20 12.500v2a4 4 0 0 1-4 4H4M11 10.500l1.500-1v5"/>',
  heart: '<path d="M12 20.300S4.500 15.800 4.500 10.200A4.200 4.200 0 0 1 12 7.600a4.200 4.200 0 0 1 7.500 2.600c0 5.600-7.500 10.100-7.500 10.100z"/>',
  heartFill: `<path d="M12 20.300S4.500 15.800 4.500 10.200A4.200 4.200 0 0 1 12 7.600a4.200 4.200 0 0 1 7.500 2.600c0 5.600-7.500 10.100-7.500 10.100z" fill="currentColor"/>`,
  volume: `<path d="M4 9.500v5h3.500l4.500 4v-13l-4.500 4H4z" ${F}/><path d="M15.500 9a4.200 4.200 0 0 1 0 6M18 6.500a7.700 7.700 0 0 1 0 11"/>`,
  volumeLow: `<path d="M4 9.500v5h3.500l4.500 4v-13l-4.500 4H4z" ${F}/><path d="M15.500 9a4.200 4.200 0 0 1 0 6"/>`,
  mute: `<path d="M4 9.500v5h3.500l4.500 4v-13l-4.500 4H4z" ${F}/><path d="M16 9.500l5 5M21 9.500l-5 5"/>`,
  queue: `<path d="M4 6h16M4 11h16M4 16h8"/><path d="M16.500 14.200v5.600l4.500-2.800-4.500-2.800z" ${F}/>`,
  devices: '<rect x="2.500" y="5" width="13" height="10" rx="2"/><path d="M6.500 19h5M9 15v4"/><rect x="17.500" y="9" width="4.500" height="10" rx="1.500"/>',
  search: '<circle cx="11" cy="11" r="6.500"/><path d="M16 16l4.500 4.500"/>',
  home: '<path d="M4 11l8-7 8 7v8a1 1 0 0 1-1 1h-4.500v-5.500h-5V20H5a1 1 0 0 1-1-1v-8z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  queueAdd: '<path d="M4 6h12M4 11h12M4 16h7"/><path d="M17.500 13.500v7M14 17h7"/>',
  more: `<circle cx="5.500" cy="12" r="1.700" ${F}/><circle cx="12" cy="12" r="1.700" ${F}/><circle cx="18.500" cy="12" r="1.700" ${F}/>`,
  back: '<path d="M14.500 5.500L8 12l6.500 6.500"/>',
  forward: '<path d="M9.500 5.500L16 12l-6.500 6.500"/>',
  up: '<path d="M5.500 14.500L12 8l6.500 6.500"/>',
  down: '<path d="M5.500 9.500L12 16l6.500-6.500"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  settings: '<path d="M4 7h9M19 7h1M4 17h1M11 17h9"/><circle cx="16" cy="7" r="2.500"/><circle cx="8" cy="17" r="2.500"/>',
  note: '<path d="M9 18V6l10-2v12"/><circle cx="6.500" cy="18" r="2.500"/><circle cx="16.500" cy="16" r="2.500"/>',
  folder: '<path d="M3 7.5a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  expand: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  shrink: '<path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/>',
  restore: '<path d="M14 4h6v6M20 4l-7 7M10 20H4v-6M4 20l7-7"/>',
  viz: '<path d="M4 14v-4M8 18V6M12 15V9M16 20V4M20 13v-2"/>',
  mini: '<rect x="3" y="5" width="18" height="14" rx="2.5"/><rect x="12" y="11.5" width="6.5" height="5" rx="1" fill="currentColor" stroke="none"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.500 11.500a6.500 6.500 0 0 0 13 0M12 18v3"/>',
  disc: '<circle cx="12" cy="12" r="8.500"/><circle cx="12" cy="12" r="2.500"/>',
  user: '<circle cx="12" cy="8.500" r="3.500"/><path d="M5 20a7 7 0 0 1 14 0"/>',
  list: '<path d="M8 6h12M8 12h12M8 18h12"/><circle cx="4" cy="6" r="1" fill="currentColor"/><circle cx="4" cy="12" r="1" fill="currentColor"/><circle cx="4" cy="18" r="1" fill="currentColor"/>',
  check: '<path d="M5 12.500l4.500 4.500L19 7.500"/>',
  external: '<path d="M14 5h5v5M19 5l-8 8M11 6H6.500A1.500 1.500 0 0 0 5 7.500v10A1.500 1.500 0 0 0 6.500 19h10a1.500 1.500 0 0 0 1.500-1.500V13"/>',
  wave: '<path d="M2.500 13c2.200-4.500 4.400-4.500 6.500 0s4.300 4.500 6.500 0 3.800-4 6-1.500"/>',
  copy: '<rect x="8.500" y="8.500" width="11" height="11" rx="2"/><path d="M15.500 5.500v-1a1.500 1.500 0 0 0-1.500-1.500H5.500A1.500 1.500 0 0 0 4 4.500V13a1.500 1.500 0 0 0 1.500 1.500h1"/>',
  signout: '<path d="M10 5H6.500A1.500 1.500 0 0 0 5 6.500v11A1.500 1.500 0 0 0 6.500 19H10M14.500 8l4 4-4 4M18.500 12H9.500"/>',
  pin: '<path d="M9 3.500h6l-1 6.500 3.500 3.500v1.500h-11v-1.500L10 10 9 3.500zM12 15v6"/>',
  winmin: '<path d="M6 12h12"/>',
  winmax: '<rect x="6.500" y="6.500" width="11" height="11" rx="1.500"/>',
};
const tpl = document.createElement('template');
export function icon(name, size = 20) {
  tpl.innerHTML = `<svg class="ic" viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`;
  return tpl.content.firstChild;
}

// ---- Storage (never throws) --------------------------------------------------------
export const store = {
  get(k, d = null) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage full or blocked */ } },
  remove(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};

// ---- Tiny event bus --------------------------------------------------------------
const handlers = {};
export const bus = {
  on(evt, fn) { (handlers[evt] ||= new Set()).add(fn); return () => handlers[evt].delete(fn); },
  emit(evt, data) { handlers[evt]?.forEach(fn => { try { fn(data); } catch (e) { console.error(e); } }); },
};

// ---- Formatting -------------------------------------------------------------------
export function fmtTime(ms) {
  if (!isFinite(ms) || ms < 0) ms = 0;
  const s = Math.floor(ms / 1000), hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60;
  return hh ? `${hh}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}` : `${mm}:${String(ss).padStart(2, '0')}`;
}
export function fmtLong(ms) {
  const m = Math.max(1, Math.round(ms / 60000));
  if (m < 60) return `${m} min`;
  const hh = Math.floor(m / 60), mm = m % 60;
  return mm ? `${hh} hr ${mm} min` : `${hh} hr`;
}
export const plural = (n, word) => `${Number(n || 0).toLocaleString()} ${word}${n === 1 ? '' : 's'}`;
export function plainText(html) {
  if (!html) return '';
  try { return new DOMParser().parseFromString(String(html), 'text/html').body.textContent.trim(); } catch { return ''; }
}
export function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

// ---- Images -----------------------------------------------------------------------
// Picks the smallest picture that is still at least `want` pixels wide.
export function pickImg(images, want = 300) {
  if (!images || !images.length) return null;
  let best = null;
  for (const im of images) {
    if (!im || !im.url) continue;
    const w = im.width || 9999;
    if (w >= want && (!best || w < (best.width || 9999))) best = im;
  }
  return (best || images.find(i => i && i.url) || {}).url || null;
}
export function coverEl(images, want = 300, kind = 'note', round = false) {
  const url = pickImg(images, want);
  const box = h('div', { class: 'cover' + (round ? ' round' : '') + (url ? '' : ' empty') });
  if (url) box.append(h('img', { src: url, alt: '', loading: 'lazy', decoding: 'async', draggable: false }));
  else box.append(icon(kind, 26));
  return box;
}

// ---- Toasts -----------------------------------------------------------------------
export function toast(msg, opts = {}) {
  const box = $('#toasts');
  if (!box || !msg) return;
  const t = h('div', { class: 'toast glass' + (opts.error ? ' error' : '') }, msg);
  box.append(t);
  requestAnimationFrame(() => t.classList.add('in'));
  setTimeout(() => { t.classList.remove('in'); setTimeout(() => t.remove(), 280); }, opts.ms || 3200);
}
