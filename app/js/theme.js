// Colour theme. The whole window takes its colours from the page you are on:
// the artwork of a playlist, album, artist or podcast, or a signature palette
// for each tab (Home, Search, Liked Songs, and the Library tabs).

import { $ } from './util.js';

export const PALETTES = {
  home:      [[47, 107, 255], [176, 44, 201]],
  search:    [[16, 185, 160], [56, 120, 255]],
  liked:     [[124, 77, 255], [255, 92, 168]],
  playlists: [[56, 132, 255], [20, 200, 190]],
  albums:    [[245, 158, 66], [220, 70, 110]],
  artists:   [[60, 200, 120], [40, 130, 230]],
  podcasts:  [[240, 96, 72], [250, 180, 60]],
  local:     [[38, 166, 154], [92, 107, 192]],
  settings:  [[99, 102, 241], [71, 85, 125]],
};
const BASE = [12, 15, 27];
const WHITE = [255, 255, 255];
const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
const lum = c => (c[0] * 0.299 + c[1] * 0.587 + c[2] * 0.114) / 255;
const css = c => c.join(', ');
const hex = c => '#' + c.map(v => Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0')).join('');

// A lighter version of a colour that stays readable as text and icons on dark glass.
function readable(c) {
  let out = mix(c, WHITE, 0.3);
  for (let i = 0; i < 6 && lum(out) < 0.62; i++) out = mix(out, WHITE, 0.2);
  return out;
}
// Keeps a tint from being so dark or so pale that it disappears behind the glass.
function vivid(c) {
  const l = lum(c);
  if (l < 0.2) return mix(c, WHITE, 0.25);
  if (l > 0.85) return mix(c, [120, 130, 160], 0.35);
  return c;
}

const colorCache = new Map();      // picture address -> [main, second]
let token = 0, flip = false, shown;

export function applyTheme(theme) {
  theme = theme || {};
  const my = ++token;
  const pal = PALETTES[theme.key] || PALETTES.home;
  const url = theme.image || null;
  if (!url) { showArt(null); setColors(pal[0], pal[1]); return; }
  const known = colorCache.get(url);
  if (known) { showArt(url); setColors(known[0], known[1]); return; }
  const im = new Image();
  im.crossOrigin = 'anonymous';
  im.onload = () => {
    const c = colorsOf(im) || pal;
    colorCache.set(url, c);
    if (colorCache.size > 200) colorCache.delete(colorCache.keys().next().value);
    if (my !== token) return;
    showArt(url); setColors(c[0], c[1]);
  };
  im.onerror = () => { if (my !== token) return; showArt(url); setColors(pal[0], pal[1]); };   // picture can be shown but not measured
  im.src = url;
}

function showArt(url) {
  if (url === shown) return;
  shown = url;
  const a = $('#art-a'), b = $('#art-b');
  if (!a || !b) return;
  if (!url) { a.classList.remove('on'); b.classList.remove('on'); return; }
  const show = flip ? a : b, hide = flip ? b : a;
  flip = !flip;
  show.style.backgroundImage = `url("${url.replace(/"/g, '%22')}")`;
  show.classList.add('on');
  hide.classList.remove('on');
}

function setColors(main, second) {
  main = vivid(main); second = vivid(second);
  const s = document.documentElement.style;
  s.setProperty('--tint', css(main));
  s.setProperty('--tint2', css(second));
  s.setProperty('--accent', css(readable(main)));
  s.setProperty('--wash', `rgba(${css(main)}, 0.36)`);
  // The window's own title bar (when Glasswave is installed as an app) follows along.
  const bar = hex(mix(BASE, main, 0.36));
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', bar);
  // Glasswave's own window colours its thin outer border to match.
  try { if (window.chrome && window.chrome.webview) window.chrome.webview.postMessage('theme:' + bar); } catch { /* not in that window */ }
}

// Finds the strongest colour family in a picture, plus a second one for depth.
function colorsOf(im) {
  try {
    const n = 24, c = document.createElement('canvas');
    c.width = c.height = n;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(im, 0, 0, n, n);
    const d = g.getImageData(0, 0, n, n).data;
    const bins = Array.from({ length: 12 }, () => ({ w: 0, r: 0, g: 0, b: 0 }));
    const sum = [0, 0, 0];
    let count = 0;
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i], gr = d[i + 1], bl = d[i + 2];
      const mx = Math.max(r, gr, bl), mn = Math.min(r, gr, bl), delta = mx - mn;
      sum[0] += r; sum[1] += gr; sum[2] += bl; count++;
      if (!delta) continue;
      const sat = delta / mx, l = (r * 0.299 + gr * 0.587 + bl * 0.114) / 255;
      const score = sat * (1 - Math.abs(l - 0.55));
      if (score < 0.12) continue;
      let hue = mx === r ? ((gr - bl) / delta) % 6 : mx === gr ? (bl - r) / delta + 2 : (r - gr) / delta + 4;
      if (hue < 0) hue += 6;
      const bin = bins[Math.min(11, Math.floor(hue * 2))];
      const w = score * score;
      bin.w += w; bin.r += r * w; bin.g += gr * w; bin.b += bl * w;
    }
    const avg = sum.map(v => Math.round(v / Math.max(1, count)));
    const ranked = bins.filter(b => b.w > 0).sort((x, y) => y.w - x.w);
    const total = ranked.reduce((t, b) => t + b.w, 0);
    if (!ranked.length || total < 1.5) {                 // black-and-white or very muted artwork
      const soft = mix(avg, [128, 140, 172], 0.55);
      return [soft, mix(soft, [84, 96, 150], 0.5)];
    }
    const col = b => [Math.round(b.r / b.w), Math.round(b.g / b.w), Math.round(b.b / b.w)];
    const main = col(ranked[0]);
    const second = ranked[1] && ranked[1].w > ranked[0].w * 0.25 ? col(ranked[1]) : mix(main, avg, 0.6);
    return [main, second];
  } catch { return null; }
}
