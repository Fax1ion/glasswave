// The visualizer: a ring of bars around the cover that moves with the music.
//
// Where the movement comes from:
//   - a music file from this computer: the sound itself, measured right here in the page
//   - a Spotify song in Glasswave's own window: the window listens to what the computer's
//     speakers are playing and passes along how loud each pitch is (Spotify's sound cannot
//     be measured from inside the page)
// With neither, the ring just breathes slowly and a line of text says why.

import { h, icon, coverEl, clamp } from './util.js';
import * as player from './player.js';
import { imagesOf } from './ui.js';

const N = 48;                                     // bars on each half of the ring

export function createViz({ onExit, onFull }) {
  const canvas = h('canvas', { class: 'viz-canvas', 'aria-hidden': 'true' });
  const art = h('div', { class: 'viz-art' });
  const title = h('div', { class: 'viz-title' }, 'Nothing playing');
  const artist = h('div', { class: 'viz-artist' });
  const hint = h('div', { class: 'viz-hint' });
  const tool = (name, label, fn) => h('button', { class: 'icon-btn', title: label, 'aria-label': label, onclick: fn }, icon(name));
  const fullBtn = tool('expand', 'Full screen', () => onFull());
  const el = h('div', { class: 'viz', hidden: true, role: 'dialog', 'aria-label': 'Visualizer' },
    h('div', { class: 'viz-bg', 'aria-hidden': 'true' }), canvas, art,
    h('div', { class: 'viz-meta' }, title, artist, hint),
    h('div', { class: 'viz-tools' }, fullBtn, tool('close', 'Exit the visualizer', () => onExit())));

  const g = canvas.getContext('2d');
  const raw = new Float32Array(N), cur = new Float32Array(N), caps = new Float32Array(N), fromHost = new Float32Array(N);
  let on = false, raf = 0, frame = 0, w = 0, hgt = 0, hostAt = -1e9, deaf = false;
  let freq = null, bins = null, loudest = 0.5, bassAvg = 0, lastBeat = 0, rings = [], palette = [], idleTimer = 0, hintNow = null, toldAt = 0, colouredAt = 0, openedAt = 0;

  // ---- which pitches go into which bar ----------------------------------------------------
  function makeBins(rate, size) {
    const lo = new Int32Array(N), hi = new Int32Array(N);
    const top = Math.min(16000, rate / 2 - 1), ratio = Math.pow(top / 40, 1 / N);
    let edge = 40;
    for (let b = 0; b < N; b++) {
      const next = edge * ratio;
      lo[b] = Math.max(1, Math.floor(edge * size / rate));
      hi[b] = Math.min(size / 2, Math.max(lo[b] + 1, Math.ceil(next * size / rate)));
      edge = next;
    }
    return { lo, hi, rate, size };
  }

  // ---- listening ------------------------------------------------------------------------------
  function listen(now) {
    const s = player.state;
    if (s.files && !s.paused) {
      const a = player.fileAnalyser();
      if (a) {
        if (!freq || freq.length !== a.node.frequencyBinCount) freq = new Uint8Array(a.node.frequencyBinCount);
        if (!bins || bins.rate !== a.rate || bins.size !== a.node.fftSize) bins = makeBins(a.rate, a.node.fftSize);
        a.node.getByteFrequencyData(freq);
        for (let b = 0; b < N; b++) { let m = 0; for (let k = bins.lo[b]; k < bins.hi[b]; k++) if (freq[k] > m) m = freq[k]; raw[b] = m / 255; }
        return 'file';
      }
    }
    if (!s.paused && s.track && now - hostAt < 600) { raw.set(fromHost); return 'window'; }
    raw.fill(0);
    return null;
  }
  function explain(source) {
    const s = player.state;
    let text = '';
    if (!s.track) text = 'Play something and the ring will move with it.';
    else if (s.paused) text = 'Paused';
    else if (!source) {
      // The own window sends a steady stream while it is listening. Hearing nothing at all means it is not.
      if (window.chrome && window.chrome.webview && hostAt < openedAt && performance.now() - openedAt > 2500) deaf = true;
      if (!s.files && !s.isLocal && s.device) text = 'Playing on ' + s.device.name + '. The visualizer only hears this computer.';
      else if (deaf) text = 'The visualizer couldn’t listen to this computer’s sound, so it is only drifting.';
      else if (!(window.chrome && window.chrome.webview)) text = 'In a browser window the visualizer follows local files. Spotify songs are followed in Glasswave’s own window.';
    }
    if (text !== hintNow) { hintNow = text; hint.textContent = text; }
  }

  // ---- drawing --------------------------------------------------------------------------------
  function colours() {
    const css = getComputedStyle(document.documentElement);
    const read = name => (css.getPropertyValue(name) || '255, 255, 255').split(',').map(x => Number(x) || 0);
    const a = read('--accent'), b = read('--tint2');
    palette = [];
    for (let i = 0; i < N; i++) {
      const t = i / (N - 1), c = [0, 1, 2].map(k => Math.round(a[k] + (b[k] - a[k]) * t + (255 - (a[k] + (b[k] - a[k]) * t)) * 0.18));
      palette.push(c.join(','));
    }
  }
  function size() {
    const r = el.getBoundingClientRect(), dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    w = Math.max(1, r.width); hgt = Math.max(1, r.height);
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(hgt * dpr);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const R = Math.min(w, hgt) * 0.2;
    art.style.width = art.style.height = Math.round(R * 2 - 10) + 'px';
    art.style.left = Math.round(w / 2) + 'px';
    art.style.top = Math.round(hgt * 0.46) + 'px';
  }
  function tick(now) {
    raf = 0;
    if (!on || document.hidden) return;
    raf = requestAnimationFrame(tick);
    frame++;
    const lite = document.documentElement.dataset.fx === 'lite';
    if (lite && frame % 2) return;                       // Lite effects: half the frames
    if (now - colouredAt > 1500) { colouredAt = now; colours(); }

    const source = listen(now);
    if (now - toldAt > 350) { toldAt = now; explain(source); }
    // Keep the picture lively at any volume: measure against the loudest recent moment.
    let peak = 0;
    for (let b = 0; b < N; b++) if (raw[b] > peak) peak = raw[b];
    loudest = Math.max(peak, loudest * 0.998, 0.3);
    for (let b = 0; b < N; b++) {
      let v = source ? clamp((raw[b] / loudest - 0.22) / 0.78, 0, 1) * (0.86 + 0.3 * b / N) : 0.05 + 0.035 * Math.sin(now / 900 + b * 0.42);
      v = clamp(v, 0, 1);
      cur[b] += (v - cur[b]) * (v > cur[b] ? 0.6 : 0.17);
      caps[b] = Math.max(caps[b] - 0.007, cur[b]);
    }
    const bass = (cur[0] + cur[1] + cur[2] + cur[3] + cur[4] + cur[5]) / 6;
    bassAvg += (bass - bassAvg) * 0.06;
    if (source && !lite && bass > bassAvg * 1.22 + 0.05 && now - lastBeat > 250) { lastBeat = now; rings.push({ t: now, k: clamp(bass, 0.3, 1) }); if (rings.length > 5) rings.shift(); }

    const cx = w / 2, cy = hgt * 0.46, R = Math.min(w, hgt) * 0.2, count = N * 2, step = Math.PI * 2 / count;
    const r0 = R + 12, reach = Math.min(R * 1.05, Math.min(w, hgt) * 0.5 - R - 26);
    art.style.transform = 'translate(-50%, -50%) scale(' + (1 + bass * 0.06).toFixed(4) + ')';
    g.clearRect(0, 0, w, hgt);
    // rings that spread out on each beat
    rings = rings.filter(r => now - r.t < 1100);
    for (const r of rings) {
      const p = (now - r.t) / 1100;
      g.beginPath(); g.arc(cx, cy, r0 + reach * (0.2 + p * 1.5), 0, Math.PI * 2);
      g.strokeStyle = 'rgba(' + palette[8] + ',' + ((1 - p) * 0.28 * r.k).toFixed(3) + ')';
      g.lineWidth = 2 + (1 - p) * 3; g.stroke();
    }
    g.lineCap = 'round';
    const thick = Math.max(2, (2 * Math.PI * r0 / count) * 0.56);
    for (let pass = 0; pass < 2; pass++) {               // a soft wide stroke under a crisp one, in place of a costly glow
      g.lineWidth = pass ? thick : thick * 2.4;
      for (let i = 0; i < count; i++) {
        const b = i < N ? i : count - 1 - i;             // low notes at the top, high notes at the bottom, mirrored left and right
        const a = -Math.PI / 2 + (i + 0.5) * step, ca = Math.cos(a), sa = Math.sin(a);
        const r1 = r0 + reach * (0.04 + Math.pow(cur[b], 1.2) * 0.96);
        g.strokeStyle = 'rgba(' + palette[b] + (pass ? ',0.95)' : ',0.16)');
        g.beginPath(); g.moveTo(cx + ca * r0, cy + sa * r0); g.lineTo(cx + ca * r1, cy + sa * r1); g.stroke();
      }
    }
    g.fillStyle = 'rgba(255,255,255,0.75)';
    for (let i = 0; i < count; i++) {                    // little caps that hang at each bar's recent high point
      const b = i < N ? i : count - 1 - i;
      if (caps[b] < 0.06) continue;
      const a = -Math.PI / 2 + (i + 0.5) * step, rc = r0 + reach * (0.04 + Math.pow(caps[b], 1.2) * 0.96) + thick * 0.9 + 3;
      g.beginPath(); g.arc(cx + Math.cos(a) * rc, cy + Math.sin(a) * rc, Math.max(1, thick * 0.3), 0, Math.PI * 2); g.fill();
    }
  }
  function wake() { if (on && !raf && !document.hidden) raf = requestAnimationFrame(tick); }
  document.addEventListener('visibilitychange', wake);
  if (typeof ResizeObserver === 'function') new ResizeObserver(() => { if (on) size(); }).observe(el);
  el.addEventListener('mousemove', () => {
    el.classList.remove('idle');
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => el.classList.add('idle'), 2600);
  });

  return {
    el,
    get isOpen() { return on; },
    open() {
      if (on) return;
      on = true; el.hidden = false; el.classList.remove('idle'); hintNow = null; frame = 0; deaf = false; toldAt = colouredAt = 0; openedAt = performance.now();
      if (player.state.files) player.fileAnalyser();             // set up while the click that opened this is still fresh
      size(); colours(); wake();
    },
    close() { on = false; el.hidden = true; cancelAnimationFrame(raf); raf = 0; rings = []; cur.fill(0); caps.fill(0); },
    track(t) {
      art.replaceChildren(coverEl(imagesOf(t), 640, 'note', true));
      title.textContent = t ? t.name : 'Nothing playing';
      artist.textContent = t ? (t.artists || []).map(a => a.name).join(', ') : '';
    },
    full(isFull) { fullBtn.replaceChildren(icon(isFull ? 'shrink' : 'expand')); fullBtn.title = isFull ? 'Leave full screen' : 'Full screen'; fullBtn.setAttribute('aria-label', fullBtn.title); },
    // From Glasswave's own window: 48 bar heights as two letters each.
    host(hex) {
      if (hex.length < N * 2) return;
      for (let b = 0; b < N; b++) fromHost[b] = parseInt(hex.substr(b * 2, 2), 16) / 255 || 0;
      hostAt = performance.now();
    },
    deaf() { deaf = true; },
  };
}
