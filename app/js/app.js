// Glasswave: start-up, sign-in screen, the window layout, navigation and the player bar.

import { APP_NAME, DEMO, REDIRECT_URI } from './config.js';
import { $, h, icon, store, toast, fmtTime, coverEl, pickImg, bus, debounce, clamp } from './util.js';
import * as auth from './auth.js';
import { sp, session } from './api.js';
import * as player from './player.js';
import { markPlaying, openMenu, iconBtn, artistLinks, imagesOf, newPlaylist, dialog, note, trackMenu } from './ui.js';
import * as views from './views.js';
import { applyTheme } from './theme.js';
import { libraryPanel, refreshLibrary, onLibraryRender, touch } from './library.js';
import { lyricsFor } from './lyrics.js';
import { createViz } from './viz.js';
import { loadLocal, indexLocal } from './local.js';
import * as hk from './hotkeys.js';
import { initSmart, isPick } from './smart.js';

const root = $('#root');
const els = {};

// Running inside Glasswave's own standalone window (not a browser)? Then the app draws
// the top bar itself: a strip to drag the window by, and minimise / maximise / close.
const SHELL = !!(window.chrome && window.chrome.webview);
const post = msg => { try { window.chrome.webview.postMessage(msg); } catch { /* not in the own window, or it is closing */ } };
let host2 = false;                     // the own window knows the mini player, full screen and edge resizing
// ---- notes for the log (launcher\standalone.log) -------------------------------------------------
const reported = new Map();
bus.on('report', msg => {
  if (!host2 || reported.size > 80) return;
  if (Date.now() - (reported.get(msg) || 0) < 60e3) return;      // the same note at most once a minute
  reported.set(msg, Date.now());
  post('log:' + msg.replace(/[\r\n]+/g, ' ').slice(0, 300));
});
window.addEventListener('error', e => bus.emit('report', 'Page error: ' + (e.message || e.error)));
window.addEventListener('unhandledrejection', e => { const r = e.reason; if (!(r && r.status)) bus.emit('report', 'Page error: ' + ((r && r.message) || r)); });
let toldWait = 0;
bus.on('spotify-wait', seconds => {
  if (Date.now() - toldWait < 10 * 60e3) return;
  toldWait = Date.now();
  const mins = Math.ceil(seconds / 60);
  toast('Spotify asked ' + APP_NAME + ' to slow down' + (mins > 1 ? ' for about ' + mins + ' minutes' : ' for a moment') + '. Your library and pages come back by themselves.', { ms: 8000 });
});

// ---- desktop-wide shortcuts -------------------------------------------------------------------
function runHotkey(action) {
  if (action === 'prev') player.prev();
  else if (action === 'toggle') player.toggle();
  else if (action === 'next') player.next();
  else if (action === 'fullscreen') {
    // From a shortcut, whatever you were using (a game, say) keeps the keyboard and mouse.
    quiet = true;
    try {
      if (vizOn) setVizFull(!vizFull);
      else if (mode === 'full') setMode(modeBefore);
      else setMode('full');
    } finally { quiet = false; }
  }
}
let quiet = false;
const modeMsg = name => 'mode:' + name + (quiet ? ':quiet' : '');

// ---- which screen full screen uses (chosen in Settings; the own window does the moving) --------
let screens = [];                          // [{ device, x, y, w, h, main, n }], numbered left to right
function parseScreens(text) {
  return text.split('|').filter(Boolean).map((part, i) => {
    const [device, x, y, w, h, main] = part.split(';');
    return { device, x: +x, y: +y, w: +w, h: +h, main: main === '1', n: i + 1 };
  });
}
function sendFullScreen() {
  if (!host2) return;
  const c = store.get('gw.fullScreen', null);
  post('fullscreen-screen:' + (c ? [c.device, c.x, c.y, c.w, c.h].join(';') : ''));
}
// Hands the chosen combos to the own window, which asks Windows for them.
let hotkeyWait = 0;
function sendHotkeys() {
  if (!host2) return;
  const keys = hk.getKeys();
  for (const [a] of hk.ACTIONS) hk.status[a] = keys[a] ? 'pending' : 'none';
  post('hotkeys:' + hk.encode(keys));
  clearTimeout(hotkeyWait);
  // A window from before this feature never answers.
  hotkeyWait = setTimeout(() => { for (const [a] of hk.ACTIONS) if (hk.status[a] === 'pending') hk.status[a] = 'old'; bus.emit('hotkeys-status'); }, 2500);
  bus.emit('hotkeys-status');
}

function initShell() {
  const top = document.documentElement;
  top.classList.add('shell');
  const btn = (name, label, msg, cls = '') => h('button', { class: 'winbtn ' + cls, title: label, 'aria-label': label, onclick: () => post(msg) }, icon(name, 16));
  const bar = $('.dragbar');
  bar.removeAttribute('aria-hidden');
  bar.replaceChildren(
    h('span', { class: 'drag-title' }, icon('wave', 16), h('span', null, APP_NAME)),
    h('span', { class: 'drag-space' }),
    btn('winmin', 'Minimise', 'min'), btn('winmax', 'Maximise', 'max'), btn('close', 'Close', 'close'));
  // Fallback for moving the window when the system does not treat the strip as a title bar.
  bar.addEventListener('mousedown', e => { if (e.button === 0 && !e.target.closest('button')) post('drag'); });
  bar.addEventListener('dblclick', e => { if (!e.target.closest('button')) post('max'); });
  // The window has no border of its own. These unseen strips along its edges are what you drag to resize it.
  for (const edge of ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']) {
    document.body.append(h('div', { class: 'rz rz-' + edge, onmousedown: e => { if (e.button === 0) { e.preventDefault(); post('resize:' + edge); } } }));
  }
  try {
    window.chrome.webview.addEventListener('message', e => {
      const msg = String(e.data);
      if (msg === 'host:2') { host2 = true; top.classList.add('host2'); sendHotkeys(); sendFullScreen(); post('screens?'); post('mode:' + (vizFull ? 'full' : mode)); if (vizOn) post('viz:1'); paintModeButtons(); }
      else if (msg === 'win:max' || msg === 'win:normal') top.classList.toggle('maxed', msg === 'win:max');
      else if (msg.startsWith('screens:')) { screens = parseScreens(msg.slice(8)); bus.emit('screens'); }
      else if (msg.startsWith('fft:')) { if (viz) viz.host(msg.slice(4)); }
      else if (msg === 'viz:deaf') { if (viz) viz.deaf(); }
      // A desktop-wide shortcut was pressed (see the Settings page).
      else if (msg.startsWith('hotkey:')) runHotkey(msg.slice(7));
      else if (msg.startsWith('hotkeys-status:')) { clearTimeout(hotkeyWait); hk.setStatus(msg.slice(15)); }
    });
  } catch { /* an older window: it simply never answers */ }
  post('hello');
}

// Browsers offer "install as an app" through this event; keep it for the Install button.
let installOffer = null;
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); installOffer = e; paintInstall(); });
window.addEventListener('appinstalled', () => {
  installOffer = null; store.set('gw.installed', true); paintInstall();
  toast('Installed. Close this window and open ' + APP_NAME + ' from its new icon.', { ms: 9000 });
});
function paintInstall() { if (els.install) els.install.hidden = SHELL || !installOffer || store.get('gw.installed', false); }
async function installApp() {
  if (installOffer) {
    const offer = installOffer;
    installOffer = null; paintInstall();
    try { offer.prompt(); await offer.userChoice; } catch { /* closed */ }
    return;
  }
  const open = await dialog('Install ' + APP_NAME + ' as an app', h('div', { class: 'settings' },
    h('p', { class: 'fine' }, 'Browsers only let installed apps colour the bar at the very top of the window. Installing takes a few seconds and changes nothing else.'),
    h('ol', { class: 'steps' },
      h('li', null, 'Press ', h('b', null, 'Open in a tab'), ' below. ' + APP_NAME + ' opens in your normal browser.'),
      h('li', null, 'In that tab, click ', h('b', null, 'Install app'), ' at the top of ' + APP_NAME + ', or the install icon at the right end of the address bar.'),
      h('li', null, 'Close the old window. From then on, open ' + APP_NAME + ' from its new icon or from Start Glasswave.'))),
  [{ label: 'Not now', value: false }, { label: 'Open in a tab', value: true, cls: 'primary' }]);
  if (open) window.open(location.origin + '/' + (DEMO ? '?demo' : ''), '_blank', 'noopener');
}

async function boot() {
  if (SHELL) initShell();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  let message = null;
  try { message = sessionStorage.getItem('gw.msg'); sessionStorage.removeItem('gw.msg'); } catch { /* ignore */ }
  if (location.pathname === '/callback') {
    try { await auth.completeLogin(); } catch (e) { message = e.message; }
  }
  auth.onSignedOut(msg => {
    for (const k of ['gw.library', 'gw.playlists', 'gw.played', 'gw.recs', 'gw.fresh']) store.remove(k);
    try { if (msg) sessionStorage.setItem('gw.msg', msg); } catch { /* ignore */ }
    location.replace('/');
  });
  if (!DEMO && !auth.isSignedIn()) return renderSetup(message);

  renderShell();
  try { session.me = await sp.me(); }
  catch (e) {
    if (!DEMO && !auth.isSignedIn()) return;
    els.scroller.replaceChildren(note('close', 'Couldn’t reach Spotify', e.message, h('button', { class: 'pill primary', onclick: () => location.reload() }, 'Try again')));
    return;
  }
  paintUser();
  player.subscribe(onPlayer);
  initSmart();
  player.initPlayer();
  refreshLibrary().catch(() => {});
  loadLocal().then(() => setTimeout(() => indexLocal(), 2500)).catch(() => {});
  window.addEventListener('hashchange', route);
  route();
}

// ===== Sign-in screen =========================================================================
function renderSetup(message) {
  const err = h('div', { class: 'setup-error', role: 'alert' }, message || '');
  const input = h('input', { class: 'field', type: 'text', placeholder: 'Paste your Client ID here', value: auth.getClientId(), spellcheck: false, autocomplete: 'off', 'aria-label': 'Spotify Client ID' });
  const go = async () => {
    const v = input.value.trim();
    if (!/^[0-9a-f]{32}$/i.test(v)) { err.textContent = 'That doesn’t look like a Client ID. It’s 32 letters and numbers, shown at the top of your app’s page.'; return; }
    auth.setClientId(v);
    try { await auth.beginLogin(); } catch (e) { err.textContent = e.message; }
  };
  input.addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
  const copy = h('button', { class: 'pill ghost sm', onclick: async () => {
    try { await navigator.clipboard.writeText(REDIRECT_URI); toast('Copied'); }
    catch { const r = document.createRange(); r.selectNodeContents(uri); const s = getSelection(); s.removeAllRanges(); s.addRange(r); toast('Press Ctrl+C to copy'); }
  } }, icon('copy', 16), h('span', null, 'Copy'));
  const uri = h('code', { class: 'uri' }, REDIRECT_URI);

  root.replaceChildren(h('div', { class: 'setup' },
    h('div', { class: 'setup-card glass' },
      h('div', { class: 'brand big' }, h('span', { class: 'logo' }, icon('wave', 30)), h('span', null, APP_NAME)),
      h('p', { class: 'lead' }, 'A glass-style player for your Spotify account. Link it once and you’re in.'),
      h('ol', { class: 'steps' },
        h('li', null, 'Open the ', h('a', { href: 'https://developer.spotify.com/dashboard', target: '_blank', rel: 'noopener' }, 'Spotify developer dashboard'), ', click your app, then ', h('b', null, 'Settings'), '. The app you already made for another player works fine.'),
        h('li', null, 'Under ', h('b', null, 'Redirect URIs'), ' add this address, tick ', h('b', null, 'Web API'), ' and ', h('b', null, 'Web Playback SDK'), ', then press Save:', h('div', { class: 'uri-row' }, uri, copy)),
        h('li', null, 'Copy the ', h('b', null, 'Client ID'), ' from that page and paste it below.')),
      input,
      h('button', { class: 'pill primary wide', onclick: go }, 'Sign in with Spotify'),
      err,
      h('div', { class: 'setup-foot' },
        h('a', { href: '/?demo' }, 'Look around with demo music first'),
        h('span', null, 'Playback needs Spotify Premium. ' + APP_NAME + ' is a personal, unofficial player; music and artwork come from Spotify.')))));
  if (!auth.getClientId()) input.focus();
}

// ===== Layout =================================================================================
function renderShell() {
  root.replaceChildren(h('div', { class: 'app' + (store.get('gw.queue', false) ? ' panel-open' : ''), id: 'app' }, sidebar(), main(), queuePanel(), playerBar()), nowPlaying(), miniPlayer(), visualizer());
  paintModeButtons();
  document.addEventListener('fullscreenchange', () => {
    if (document.fullscreenElement || host2) return;
    if (vizOn && vizFull) setVizFull(false); else if (mode === 'full') setMode(modeBefore);
  });
  document.addEventListener('keydown', onKey);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) syncProgress(); });
  setInterval(() => { if (!document.hidden && !player.state.paused) { els.progress.tick(); if (!els.np.hidden) els.npProgress.tick(); } }, 1000);
  bus.on('playlists-changed', () => { viewCache.delete('/'); viewCache.delete('/library/playlists'); });
  onLibraryRender(() => paintNav(current || '/'));
  bus.on('playlist-changed', id => viewCache.delete('/playlist/' + id));
  bus.on('library-changed', () => { for (const k of [...viewCache.keys()]) if (k === '/liked' || k.startsWith('/library')) { if (k !== current) viewCache.delete(k); } refreshLike(player.state.track); });
  bus.on('rerender', () => { viewCache.delete(current); route(); });
  if (store.get('gw.queue', false)) refreshQueue();
}

function sidebar() {
  const link = (href, name, label) => h('a', { class: 'nav-item', href, dataset: { nav: href }, title: label }, icon(name), h('span', null, label));
  els.user = h('a', { class: 'user-chip', title: 'Settings', href: '#/settings', dataset: { nav: '#/settings' } });
  return h('aside', { class: 'sidebar glass' },
    h('a', { class: 'brand', href: '#/', title: APP_NAME }, h('span', { class: 'logo' }, icon('wave', 22)), h('span', null, APP_NAME)),
    h('nav', { class: 'nav', 'aria-label': 'Main' }, link('#/', 'home', 'Home'), link('#/search', 'search', 'Search'), link('#/local', 'folder', 'Local Files')),
    libraryPanel(),
    els.user);
}
function paintUser() {
  const me = session.me || {};
  const pic = pickImg(me.images, 64);
  els.user.replaceChildren(
    pic ? h('img', { class: 'avatar', src: pic, alt: '' }) : h('span', { class: 'avatar' }, (me.display_name || '?').slice(0, 1).toUpperCase()),
    h('span', { class: 'user-name' }, me.display_name || 'Account'),
    icon('settings', 18));
}

function main() {
  els.search = h('input', { class: 'search', type: 'search', placeholder: 'Search songs, artists, albums…', 'aria-label': 'Search', spellcheck: false, autocomplete: 'off' });
  const goSearch = () => {
    const q = els.search.value.trim();
    const hash = '#/search' + (q ? '/' + encodeURIComponent(q) : '');
    if (location.hash === hash) return;
    if (location.hash.startsWith('#/search')) location.replace(hash); else location.hash = hash;
  };
  els.search.addEventListener('input', debounce(goSearch, 320));
  els.search.addEventListener('keydown', e => { if (e.key === 'Enter') goSearch(); });
  els.scroller = h('div', { class: 'scroller', id: 'scroller', tabIndex: -1 });
  els.install = h('button', { class: 'pill ghost sm', hidden: true, title: 'Install ' + APP_NAME + ' as an app so the window\u2019s top bar matches too', onclick: installApp }, icon('down', 16), h('span', null, 'Install app'));
  paintInstall();
  return h('main', { class: 'main glass' },
    h('div', { class: 'wash', 'aria-hidden': 'true' }),
    h('div', { class: 'topbar' },
      iconBtn('back', 'Back', () => history.back(), 'sm'), iconBtn('forward', 'Forward', () => history.forward(), 'sm'),
      h('label', { class: 'search-wrap' }, icon('search', 18), els.search),
      h('span', { class: 'topbar-gap' }),
      els.install,
      DEMO ? h('a', { class: 'pill ghost sm', href: '/' }, 'Exit demo') : null),
    els.scroller);
}

// ===== Navigation =============================================================================
const ROUTES = [
  [/^\/?$/, views.viewHome],
  [/^\/search(?:\/(.*))?$/, views.viewSearch],
  [/^\/liked$/, views.viewLiked],
  [/^\/local$/, views.viewLocal],
  [/^\/settings$/, viewSettings],
  [/^\/playlist\/([^/]+)$/, views.viewPlaylist],
  [/^\/album\/([^/]+)$/, views.viewAlbum],
  [/^\/artist\/([^/]+)$/, views.viewArtist],
  [/^\/show\/([^/]+)$/, views.viewShow],
  [/^\/library(?:\/(playlists|albums|artists|podcasts))?$/, views.viewLibrary],
];
const viewCache = new Map();          // path -> { node, scroll, t, failed }
let current = null;

function route() {
  const path = location.hash.slice(1) || '/';
  const old = current && viewCache.get(current);
  if (old) old.scroll = els.scroller.scrollTop;
  current = path;
  paintNav(path);
  if (vizOn) toggleViz(false);
  if (mode !== 'normal') setMode('normal');
  showNp(false, true);

  let match = null, fn = null;
  for (const [re, f] of ROUTES) { match = path.match(re); if (match) { fn = f; break; } }
  const args = match ? match.slice(1).map(a => { try { return a == null ? undefined : decodeURIComponent(a); } catch { return a; } }) : [];
  if (fn === views.viewSearch && document.activeElement !== els.search) els.search.value = args[0] || '';
  else if (fn !== views.viewSearch && document.activeElement !== els.search) els.search.value = '';

  let entry = viewCache.get(path);
  if (entry && !entry.failed && Date.now() - entry.t < 5 * 60e3) {
    els.scroller.replaceChildren(entry.node);
    els.scroller.scrollTop = entry.scroll || 0;
    markPlaying(entry.node);
    applyTheme(entry.theme);
    bus.emit('player-changed');
    return;
  }
  const node = h('div', { class: 'view' });
  entry = { node, scroll: 0, t: Date.now(), failed: false, theme: null };
  const setTheme = t => { entry.theme = t; if (current === path && els.np.hidden) applyTheme(t); };
  viewCache.delete(path);
  viewCache.set(path, entry);
  if (viewCache.size > 14) viewCache.delete(viewCache.keys().next().value);
  els.scroller.replaceChildren(node);
  els.scroller.scrollTop = 0;
  if (!fn) { setTheme({ key: 'home' }); node.append(note('search', 'Page not found', null, h('a', { class: 'pill ghost', href: '#/' }, 'Go home'))); return; }
  Promise.resolve().then(() => fn(node, { scroller: els.scroller, theme: setTheme }, ...args)).catch(e => {
    console.error(e);
    entry.failed = true;
    if (!entry.theme) setTheme({ key: 'home' });
    const gone = e.status === 404 || e.status === 400;
    node.replaceChildren(note('close', gone ? 'Spotify doesn’t have that' : 'Couldn’t load this page',
      gone ? 'It may have been removed, or it isn’t open to outside apps.' : e.message,
      h('button', { class: 'pill ghost', onclick: () => { viewCache.delete(path); route(); } }, 'Try again')));
  });
}
function paintNav(path) {
  const hash = '#' + path;
  for (const a of document.querySelectorAll('[data-nav]')) {
    const n = a.dataset.nav;
    a.classList.toggle('on', n === '#/' ? path === '/' : hash === n || hash.startsWith(n + '/'));
  }
}

// ===== Player bar =============================================================================
function bar(label, onSet, onDone) {
  const fill = h('div', { class: 'bar-fill' });
  const el = h('div', { class: 'bar', role: 'slider', tabIndex: 0, 'aria-label': label, 'aria-valuemin': '0', 'aria-valuemax': '100' }, h('div', { class: 'bar-track' }, fill));
  const self = { el, fill, dragging: false };
  const frac = e => { const r = el.getBoundingClientRect(); return clamp((e.clientX - r.left) / Math.max(1, r.width), 0, 1); };
  el.addEventListener('pointerdown', e => { if (e.button) return; self.dragging = true; el.setPointerCapture(e.pointerId); onSet(frac(e)); });
  el.addEventListener('pointermove', e => { if (self.dragging) onSet(frac(e)); });
  el.addEventListener('pointerup', e => { if (!self.dragging) return; self.dragging = false; if (onDone) onDone(frac(e)); });
  el.addEventListener('pointercancel', () => { self.dragging = false; if (onDone) onDone(null); });
  return self;
}
// ---- volume ------------------------------------------------------------------------------------
// A mute button and a bar. Pointing at the bar shows the exact percent under the pointer,
// which is the volume a click there would set. Shift makes the wheel and arrow keys move 1% at a time.
const volumes = [];
let volumeBefore = 0.6;
function volumeControl(big) {
  const btn = iconBtn('volume', 'Mute', () => { const v = player.state.volume; if (v > 0) { volumeBefore = v; player.setVolume(0); } else player.setVolume(volumeBefore || 0.6); }, 'sm');
  const tip = h('div', { class: 'bar-tip', hidden: true, 'aria-hidden': 'true' });
  const show = f => { tip.textContent = Math.round(f * 100) + '%'; tip.style.left = (f * 100).toFixed(2) + '%'; tip.hidden = false; };
  const b = bar('Volume', f => { const v = Math.round(f * 100) / 100; player.setVolume(v); show(v); });
  const under = e => { const r = b.el.getBoundingClientRect(); return clamp((e.clientX - r.left) / Math.max(1, r.width), 0, 1); };
  b.el.classList.add(big ? 'vol-wide' : 'vol');
  b.el.append(tip);
  b.el.addEventListener('pointerenter', e => show(under(e)));
  b.el.addEventListener('pointermove', e => { if (!b.dragging) show(under(e)); });
  b.el.addEventListener('pointerleave', () => { if (!b.dragging) tip.hidden = true; });
  b.el.addEventListener('blur', () => { tip.hidden = true; });
  const nudge = (up, fine) => { const v = clamp(Math.round(player.state.volume * 100) + (up ? 1 : -1) * (fine ? 1 : 5), 0, 100) / 100; player.setVolume(v); show(v); };
  b.el.addEventListener('wheel', e => { e.preventDefault(); nudge(e.deltaY < 0, e.shiftKey); }, { passive: false });
  b.el.addEventListener('keydown', e => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') nudge(true, e.shiftKey);
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') nudge(false, e.shiftKey);
  });
  const pct = big ? h('span', { class: 'vol-pct' }, '') : null;
  const v = { btn, bar: b, pct, el: big ? h('div', { class: 'np-vol' }, btn, b.el, pct) : null };
  volumes.push(v);
  return v;
}
function progressBar() {
  const cur = h('span', { class: 'time' }, '0:00'), tot = h('span', { class: 'time' }, '0:00');
  const paint = f => { b.fill.style.transition = 'none'; b.fill.style.transform = `scaleX(${f})`; };
  const b = bar('Seek', f => { if (!player.state.duration) return; paint(f); cur.textContent = fmtTime(f * player.state.duration); },
    f => { if (f != null && player.state.duration) player.seek(f * player.state.duration); else sync(); });
  b.el.addEventListener('keydown', e => {
    if (e.key === 'ArrowRight') player.seek(player.positionNow() + 5000);
    else if (e.key === 'ArrowLeft') player.seek(player.positionNow() - 5000);
  });
  function sync() {
    if (b.dragging) return;
    const s = player.state, dur = s.duration || 0, pos = player.positionNow();
    paint(dur ? clamp(pos / dur, 0, 1) : 0);
    if (!s.paused && dur && !document.hidden) {
      void b.fill.offsetWidth;                              // restart the glide from the new spot
      b.fill.style.transition = `transform ${Math.max(0, dur - pos)}ms linear`;
      b.fill.style.transform = 'scaleX(1)';
    }
    cur.textContent = fmtTime(pos);
    tot.textContent = fmtTime(dur);
    b.el.setAttribute('aria-valuenow', String(dur ? Math.round((pos / dur) * 100) : 0));
  }
  return { el: h('div', { class: 'progress' }, cur, b.el, tot), sync, tick: () => { if (!b.dragging) cur.textContent = fmtTime(player.positionNow()); } };
}
function syncProgress() { els.progress.sync(); if (!els.np.hidden) els.npProgress.sync(); if (mode === 'mini') els.miniProgress.sync(); }

const groups = { play: [], shuffle: [], repeat: [] };
function controls(big) {
  const shuffle = iconBtn('shuffle', 'Shuffle is off', () => player.cycleShuffle(), 'sm toggle');
  const repeat = iconBtn('repeat', 'Repeat is off', () => player.cycleRepeat(), 'sm toggle');
  const play = h('button', { class: 'play-main' + (big ? ' xl' : ''), title: 'Play', 'aria-label': 'Play', onclick: () => player.toggle() }, icon('play', big ? 30 : 22));
  play.dataset.size = big ? '30' : '22';
  groups.play.push(play); groups.shuffle.push(shuffle); groups.repeat.push(repeat);
  return h('div', { class: 'pb-controls' }, shuffle, iconBtn('prev', 'Previous', () => player.prev()), play, iconBtn('next', 'Next', () => player.next()), repeat);
}

function playerBar() {
  els.pbCover = h('button', { class: 'pb-cover', title: 'Open now playing', 'aria-label': 'Open now playing', onclick: () => toggleNowPlaying(true) }, coverEl([], 64));
  els.pbTitle = h('div', { class: 'pb-title' }, 'Nothing playing');
  els.pbPick = h('span', { class: 'pick-mark', title: 'Smart Shuffle pick: Glasswave added this song', hidden: true }, icon('sparkle', 14));
  els.pbArtist = h('div', { class: 'pb-artist' }, 'Pick something to start');
  els.like = iconBtn('heart', 'Save to Liked Songs', toggleLike, 'sm like');
  els.like.hidden = true;
  els.progress = progressBar();
  els.pbMini = iconBtn('mini', 'Mini player', () => setMode('mini'), 'sm');
  els.deviceNote = h('button', { class: 'device-note', hidden: true, title: 'Choose where to play', onclick: openDevices });
  const vol = volumeControl(false);
  return h('footer', { class: 'player glass' },
    h('div', { class: 'pb-left' }, els.pbCover, h('div', { class: 'pb-text' }, els.pbTitle, els.pbArtist), els.like),
    h('div', { class: 'pb-center' }, controls(false), els.progress.el),
    h('div', { class: 'pb-right' }, els.deviceNote,
      iconBtn('mic', 'Lyrics', () => toggleNowPlaying(true), 'sm'),
      iconBtn('viz', 'Visualizer', () => toggleViz(true), 'sm'),
      iconBtn('queue', 'Queue', toggleQueue, 'sm q-btn'), iconBtn('devices', 'Play on another device', openDevices, 'sm'),
      vol.btn, vol.bar.el, els.pbMini, iconBtn('expand', 'Full screen', () => setMode('full'), 'sm')));
}

const last = { uri: undefined, paused: undefined, repeat: undefined, vol: undefined };
function onPlayer(s) {
  const t = s.track;
  const uri = t ? t.uri : null;
  const rev = t ? (t.rev || 0) : 0;
  if (uri !== last.uri || rev !== last.rev) { const same = uri === last.uri; last.uri = uri; last.rev = rev; paintTrack(t, same); if (!same) refreshQueue(); }
  if (s.contextUri !== last.context) { last.context = s.contextUri; if (s.contextUri && !s.paused) touch(s.contextUri); }
  if (s.paused !== last.paused || uri !== last.markedUri) {
    last.paused = s.paused; last.markedUri = uri;
    for (const b of groups.play) { b.replaceChildren(icon(s.paused ? 'play' : 'pause', Number(b.dataset.size))); b.title = s.paused ? 'Play' : 'Pause'; b.setAttribute('aria-label', b.title); }
    markPlaying();
    bus.emit('player-changed');
    document.title = t && !s.paused ? `${t.name} · ${(t.artists || []).map(a => a.name).join(', ')}` : APP_NAME;
  }
  // Shuffle: off, on, or Smart Shuffle (Glasswave's, or Spotify's own when turned on in a Spotify app).
  const shuf = s.spotifySmart ? 'spotify' : s.smart ? 'smart' : s.shuffle ? 'on' : 'off';
  if (shuf !== last.shuf || s.files !== last.shufFiles) {
    last.shuf = shuf; last.shufFiles = s.files;
    const plain = s.files || (s.track && s.track.type === 'episode');
    const title = {
      off: 'Shuffle is off',
      on: plain ? 'Shuffle is on' : 'Shuffle is on. Press again for Smart Shuffle',
      smart: 'Smart Shuffle is on: Glasswave adds songs that fit. Press to turn shuffle off',
      spotify: 'Smart Shuffle is on (turned on in a Spotify app)',
    }[shuf];
    for (const b of groups.shuffle) {
      b.replaceChildren(icon(shuf === 'smart' || shuf === 'spotify' ? 'smartShuffle' : 'shuffle'));
      b.classList.toggle('on', shuf !== 'off');
      b.classList.toggle('smart', shuf === 'smart' || shuf === 'spotify');
      b.setAttribute('aria-pressed', String(shuf !== 'off'));
      b.title = title;
      b.setAttribute('aria-label', title);
    }
  }
  if (s.repeat !== last.repeat) {
    last.repeat = s.repeat;
    for (const b of groups.repeat) { b.replaceChildren(icon(s.repeat === 'track' ? 'repeat1' : 'repeat')); b.classList.toggle('on', s.repeat !== 'off'); b.setAttribute('aria-pressed', String(s.repeat !== 'off')); b.title = { off: 'Repeat is off', context: 'Repeating all', track: 'Repeating this song' }[s.repeat] || 'Repeat is off'; b.setAttribute('aria-label', b.title); }
  }
  if (s.volume !== last.vol) {
    last.vol = s.volume;
    const pct = Math.round(s.volume * 100);
    for (const v of volumes) {
      v.bar.fill.style.transform = `scaleX(${s.volume})`;
      v.bar.el.setAttribute('aria-valuenow', String(pct));
      v.bar.el.setAttribute('aria-valuetext', pct + '%');
      v.btn.replaceChildren(icon(s.volume === 0 ? 'mute' : s.volume < 0.5 ? 'volumeLow' : 'volume'));
      v.btn.title = s.volume === 0 ? 'Unmute' : 'Mute';
      v.btn.setAttribute('aria-label', v.btn.title);
      if (v.pct) v.pct.textContent = pct + '%';
    }
  }
  const away = !s.isLocal && s.device;
  els.deviceNote.hidden = !away;
  if (away) { els.deviceNote.replaceChildren(icon('devices', 16), h('span', null, s.device.name)); els.deviceNote.title = 'Playing on ' + s.device.name + '. Click to change.'; }
  syncProgress();
  syncLyrics();
}

function paintTrack(t, same) {
  els.pbCover.replaceChildren(coverEl(imagesOf(t), 64, t && t.type === 'episode' ? 'mic' : 'note'));
  if (!t) {
    els.pbTitle.textContent = player.state.problem ? 'Player not ready' : 'Nothing playing';
    els.pbArtist.textContent = player.state.problem || 'Pick something to start';
  } else {
    const album = t.album && t.album.id ? '#/album/' + t.album.id : (t.show && t.show.id ? '#/show/' + t.show.id : null);
    els.pbTitle.replaceChildren(els.pbPick, album ? h('a', { href: album, title: t.name }, t.name) : t.name);
    els.pbArtist.replaceChildren(...artistLinks(t.artists));
  }
  els.npCover.replaceChildren(coverEl(imagesOf(t), 640, 'note'));
  els.npTitle.textContent = t ? t.name : 'Nothing playing';
  els.npArtist.replaceChildren(...(t ? artistLinks(t.artists) : []));
  els.npAlbum.textContent = t && t.album && t.album.name ? t.album.name : '';
  paintPick();
  const big = pickImg(imagesOf(t), 640);
  document.documentElement.style.setProperty('--cover', big ? `url("${big.replace(/"/g, '%22')}")` : 'none');
  els.np.classList.toggle('no-art', !big);
  els.mini.classList.toggle('no-art', !big);
  els.miniCover.replaceChildren(coverEl(imagesOf(t), 64, 'note'));
  els.miniTitle.textContent = t ? t.name : 'Nothing playing';
  els.miniArtist.textContent = t ? (t.artists || []).map(a => a.name).join(', ') : 'Pick something to start';
  viz.track(t);
  if (!same) refreshLike(t);
  if (!els.np.hidden || vizOn) applyTheme(trackTheme());
  if (lyricsWanted()) loadLyrics();
}
// The sparkle on a song Smart Shuffle added.
function paintPick() {
  const t = player.state.track, on = !!(t && isPick(t.uri));
  els.pbPick.hidden = !on;
  els.npPick.hidden = !on;
}
bus.on('smart-changed', () => {
  if (els.pbPick) paintPick();
  if ($('#app') && $('#app').classList.contains('panel-open')) refreshQueue();
});
const trackTheme = () => ({ image: pickImg(imagesOf(player.state.track), 300), key: 'home' });

// ---- like button --------------------------------------------------------------------------
let liked = false;
function paintLike() {
  els.like.replaceChildren(icon(liked ? 'heartFill' : 'heart'));
  els.like.classList.toggle('on', liked);
  els.like.title = liked ? 'Remove from Liked Songs' : 'Save to Liked Songs';
  els.like.setAttribute('aria-label', els.like.title);
}
async function refreshLike(t) {
  liked = false; paintLike();
  const ok = t && t.uri && t.uri.startsWith('spotify:track:');
  els.like.hidden = !ok;
  if (!ok) return;
  const uri = t.uri;
  try { const r = await sp.contains([uri]); if (last.uri === uri) { liked = !!r[0]; paintLike(); } } catch { /* leave it empty */ }
}
async function toggleLike() {
  const t = player.state.track;
  if (!t) return;
  const want = !liked;
  liked = want; paintLike();
  try { await (want ? sp.save([t.uri]) : sp.unsave([t.uri])); toast(want ? 'Saved to Liked Songs' : 'Removed from Liked Songs'); bus.emit('library-changed', t.uri); }
  catch (e) { liked = !want; paintLike(); toast(e.message, { error: true }); }
}

// ===== Queue panel ============================================================================
function queuePanel() {
  els.queueBody = h('div', { class: 'panel-body' });
  return h('aside', { class: 'panel glass', 'aria-label': 'Queue' },
    h('div', { class: 'panel-head' }, h('h2', null, 'Queue'), iconBtn('close', 'Close queue', toggleQueue, 'sm')),
    els.queueBody);
}
function toggleQueue() {
  const open = !$('#app').classList.contains('panel-open');
  $('#app').classList.toggle('panel-open', open);
  store.set('gw.queue', open);
  if (open) refreshQueue();
}
function qRow(t, now) {
  return h('div', { class: 'q-row' + (now ? ' now' : ''), oncontextmenu: e => { e.preventDefault(); if (!t.is_file) openMenu(e.clientX, e.clientY, trackMenu(t)); } },
    coverEl(imagesOf(t), 64, t.type === 'episode' ? 'mic' : 'note'),
    h('div', { class: 'ttext' }, h('div', { class: 'tname' }, isPick(t.uri) ? h('span', { class: 'pick-mark', title: 'Smart Shuffle pick: Glasswave added this song' }, icon('sparkle', 13)) : null, h('span', { class: 'tn' }, t.name)), h('div', { class: 'tsub' }, t.type === 'episode' ? ((t.show && t.show.name) || 'Episode') : artistLinks(t.artists))));
}
// Something was added to the queue: show it in the queue panel if that is open.
bus.on('queue-changed', () => { if ($('#app') && $('#app').classList.contains('panel-open')) setTimeout(refreshQueue, 600); });

const refreshQueue = debounce(async () => {
  if (!els.queueBody || !$('#app').classList.contains('panel-open')) return;
  try {
    const q = await player.getQueue();
    const now = q.currently_playing || player.state.track;
    els.queueBody.replaceChildren(
      h('div', { class: 'q-label' }, 'Now playing'),
      now ? qRow(now, true) : h('div', { class: 'q-empty' }, 'Nothing yet.'),
      h('div', { class: 'q-label' }, 'Next up'),
      ...(q.queue.length ? q.queue.slice(0, 40).map(t => qRow(t)) : [h('div', { class: 'q-empty' }, 'Nothing lined up. Spotify keeps going from the album or playlist you started.')]));
  } catch (e) {
    els.queueBody.replaceChildren(note('queue', 'No queue to show', e.status ? 'Start playing something to see what’s next.' : e.message));
  }
}, 400);

// ===== Devices ================================================================================
async function openDevices(e) {
  const b = e.currentTarget.getBoundingClientRect();
  let list = [];
  try { list = await player.getDevices(); } catch (err) { return toast(err.message, { error: true }); }
  const s = player.state;
  if (s.localId && !list.some(d => d.id === s.localId)) list.unshift({ id: s.localId, name: 'This computer', type: 'Computer' });
  const items = [{ header: 'Play on' }];
  const seen = new Set();
  for (const d of list) {
    if (!d.id || seen.has(d.id)) continue;
    seen.add(d.id);
    const here = d.id === s.localId;
    const active = here ? s.isLocal : !!(!s.isLocal && s.device && s.device.id === d.id);
    items.push({ label: here ? 'This computer' : d.name, icon: active ? 'check' : 'devices', active, onClick: () => { if (!active) player.transfer(d.id); } });
  }
  if (items.length === 1) items.push({ label: 'No devices found yet', icon: 'devices', onClick: () => {} });
  openMenu(b.right - 230, b.top - 16 - items.length * 42, items);
}

// ===== Now playing (full view) ================================================================
function nowPlaying() {
  els.npCover = h('div', { class: 'np-cover' });
  els.npTitle = h('h1', null, 'Nothing playing');
  els.npArtist = h('div', { class: 'np-artist' });
  els.npAlbum = h('div', { class: 'np-album' });
  els.npPick = h('div', { class: 'np-pick', hidden: true }, icon('sparkle', 14), 'Smart Shuffle pick');
  els.npNote = h('div', { class: 'np-note' });
  els.npProgress = progressBar();
  els.npLyrics = h('div', { class: 'np-lyrics', tabIndex: -1, 'aria-label': 'Lyrics' });
  els.npLyrics.addEventListener('click', e => {
    const line = e.target.closest('.ly'), d = ly.data;
    if (line && d && d.kind === 'synced') { ly.hands = 0; player.seek(d.lines[Number(line.dataset.i)].t); }
  });
  for (const ev of ['wheel', 'touchmove']) els.npLyrics.addEventListener(ev, () => { ly.hands = Date.now(); }, { passive: true });
  els.npMini = iconBtn('mini', 'Mini player', () => setMode('mini'));
  els.npFull = iconBtn('expand', 'Full screen', () => setMode(mode === 'full' ? modeBefore : 'full'));
  els.np = h('div', { class: 'np', hidden: true, role: 'dialog', 'aria-label': 'Now playing' },
    h('div', { class: 'np-bg', 'aria-hidden': 'true' }),
    h('div', { class: 'np-glow', 'aria-hidden': 'true' }, h('i'), h('i')),
    h('div', { class: 'np-tools' }, iconBtn('viz', 'Visualizer', () => toggleViz(true)), els.npMini, els.npFull, iconBtn('down', 'Close', () => toggleNowPlaying(false))),
    h('div', { class: 'np-stage' },
      h('div', { class: 'np-side' }, els.npCover, h('div', { class: 'np-meta' }, els.npTitle, els.npArtist, els.npAlbum, els.npPick), els.npProgress.el, volumeControl(true).el, controls(true), els.npNote),
      els.npLyrics));
  return els.np;
}
function showNp(open, quiet) {
  if (!els.np || els.np.hidden === !open) return;
  els.np.hidden = !open;
  if (open) { els.npProgress.sync(); onPlayerButtons(); applyTheme(trackTheme()); loadLyrics(); syncLyrics(); }
  else { clearTimeout(ly.timer); if (!quiet) applyTheme((viewCache.get(current) || {}).theme); }
}
function toggleNowPlaying(open) {
  if (!open && mode === 'full') { npBefore = false; return setMode(modeBefore); }
  showNp(open);
}

// ---- lyrics ---------------------------------------------------------------------------------
const ly = { key: null, data: null, idx: -2, timer: 0, hands: 0 };
const lyricsWanted = () => !!els.np && (!els.np.hidden || mode === 'mini');
async function loadLyrics() {
  const t = player.state.track;
  const key = t ? t.uri + '#' + (t.rev || 0) : null;
  if (key === ly.key) return;
  if (t && t.is_file && !t.rev) {                      // a file from this computer: its title is still being read
    if (ly.key !== 'wait') { ly.key = 'wait'; ly.data = null; paintLyrics(); }
    return;
  }
  ly.key = key; ly.data = null;
  paintLyrics();
  if (!t) return;
  const data = await lyricsFor(t, player.state.duration);
  if (ly.key !== key) return;
  ly.data = data;
  paintLyrics();
  syncLyrics();
}
const LY_NOTES = { none: 'No lyrics found for this song', instrumental: 'This one is instrumental', error: 'Lyrics couldn’t be loaded right now', plain: 'These lyrics aren’t timed to the music', synced: '' };
function paintLyrics() {
  const d = ly.data;
  const has = !!d && (d.kind === 'synced' || d.kind === 'plain');
  els.np.classList.toggle('has-lyrics', has);
  els.np.classList.toggle('synced', !!d && d.kind === 'synced');
  els.npNote.textContent = !player.state.track ? '' : !d ? 'Looking for lyrics…' : (LY_NOTES[d.kind] || '');
  els.npLyrics.replaceChildren(...(has ? d.lines.map((l, i) => h('p', { class: 'ly' + (l.text ? '' : ' gap'), dataset: { i: String(i) } }, l.text || '♪')) : []));
  els.npLyrics.scrollTop = 0;
  ly.idx = -2; ly.hands = 0;
  els.miniLine.textContent = '';
}
function showLine(i) {
  ly.idx = i;
  const kids = els.npLyrics.children, d = ly.data;
  for (let k = 0; k < kids.length; k++) { kids[k].classList.toggle('on', k === i); kids[k].classList.toggle('past', k < i); }
  els.miniLine.textContent = i >= 0 && d && d.lines[i] ? (d.lines[i].text || '♪') : '';
  if (els.np.hidden || Date.now() - ly.hands < 3500) return;
  const box = els.npLyrics, el = kids[i];
  const topOf = el ? el.offsetTop - box.clientHeight * 0.36 + el.offsetHeight / 2 : 0;
  box.scrollTo({ top: Math.max(0, topOf), behavior: document.documentElement.dataset.fx === 'lite' ? 'auto' : 'smooth' });
}
// Moves the highlight to the line being sung, then sleeps until the next line is due.
function syncLyrics() {
  clearTimeout(ly.timer);
  const d = ly.data;
  if (!d || d.kind !== 'synced' || !lyricsWanted()) return;
  const lines = d.lines, pos = player.positionNow() + 180;
  let lo = 0, hi = lines.length - 1, i = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (lines[mid].t <= pos) { i = mid; lo = mid + 1; } else hi = mid - 1; }
  if (i !== ly.idx) showLine(i);
  if (!player.state.paused && i + 1 < lines.length) ly.timer = setTimeout(syncLyrics, clamp(lines[i + 1].t - pos + 15, 40, 30000));
}

// ---- visualizer -------------------------------------------------------------------------------
// While it is open it is all there is of Glasswave: the rest stays hidden until you exit it.
let viz = null, vizOn = false, vizFull = false;
function visualizer() {
  viz = createViz({ onExit: () => toggleViz(false), onFull: () => setVizFull(!vizFull) });
  return viz.el;
}
function toggleViz(open) {
  if (!viz || open === vizOn) return;
  if (open) { if (mode !== 'normal') setMode('normal'); showNp(false, true); }
  else if (vizFull) setVizFull(false);
  vizOn = open;
  document.documentElement.classList.toggle('mode-viz', open);
  if (open) { viz.track(player.state.track); viz.open(); } else viz.close();
  if (host2) post(open ? 'viz:1' : 'viz:0');           // the own window listens to the speakers only while this is open
  applyTheme(open ? trackTheme() : (viewCache.get(current) || {}).theme);
}
function setVizFull(full) {
  if (full === vizFull) return;
  vizFull = full;
  document.documentElement.classList.toggle('mode-full', full);
  viz.full(full);
  if (host2) post(modeMsg(full ? 'full' : 'normal'));
  else if (full) { try { document.documentElement.requestFullscreen().catch(() => {}); } catch { /* stays in the window */ } }
  else if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
}

// ---- mini player and full screen ------------------------------------------------------------
let mode = 'normal', modeBefore = 'normal', npBefore = false;
function miniPlayer() {
  els.miniCover = h('div', { class: 'mini-cover' });
  els.miniTitle = h('div', { class: 'mini-title' }, 'Nothing playing');
  els.miniArtist = h('div', { class: 'mini-artist' });
  els.miniLine = h('div', { class: 'mini-line' });
  els.miniProgress = progressBar();
  els.mini = h('div', { class: 'mini', hidden: true, role: 'region', 'aria-label': 'Mini player' },
    h('div', { class: 'mini-bg', 'aria-hidden': 'true' }),
    h('div', { class: 'mini-top' }, els.miniCover, h('div', { class: 'mini-text' }, els.miniTitle, els.miniArtist),
      h('div', { class: 'mini-tools' },
        iconBtn('restore', 'Back to the full window', () => setMode('normal'), 'sm'),
        iconBtn('expand', 'Full screen', () => setMode('full'), 'sm'),
        iconBtn('close', 'Close Glasswave', () => post('close'), 'sm'))),
    els.miniLine,
    controls(false),
    els.miniProgress.el);
  els.mini.addEventListener('mousedown', e => { if (e.button === 0 && !e.target.closest('button, .bar')) post('drag'); });
  return els.mini;
}
function paintModeButtons() {
  if (els.pbMini) els.pbMini.hidden = !host2;
  if (els.npMini) els.npMini.hidden = !host2;
}
function setMode(next) {
  if (vizOn && next !== 'normal') return;
  if (next === 'mini' && !host2) return;
  if (next === mode || !els.np) return;
  const prev = mode;
  mode = next;
  const cl = document.documentElement.classList;
  cl.toggle('mode-mini', next === 'mini');
  cl.toggle('mode-full', next === 'full');
  els.mini.hidden = next !== 'mini';
  if (next === 'full') { modeBefore = prev; npBefore = !els.np.hidden; showNp(true); }
  else if (prev === 'full') showNp(next === 'normal' && npBefore);
  else if (next === 'mini') showNp(false);
  if (host2) post(modeMsg(next));
  else if (next === 'full') { try { document.documentElement.requestFullscreen().catch(() => {}); } catch { /* stays in the window */ } }
  else if (prev === 'full' && document.fullscreenElement) document.exitFullscreen().catch(() => {});
  els.npFull.replaceChildren(icon(next === 'full' ? 'shrink' : 'expand'));
  els.npFull.title = next === 'full' ? 'Leave full screen' : 'Full screen';
  els.npFull.setAttribute('aria-label', els.npFull.title);
  if (next === 'mini') { loadLyrics(); onPlayerButtons(); }
  syncProgress();
  syncLyrics();
}
function onPlayerButtons() { last.paused = undefined; last.repeat = undefined; onPlayer(player.state); }

// ===== Settings ===============================================================================
// ===== Settings page ==========================================================================
function viewSettings(v, ctx) {
  ctx.theme({ key: 'settings' });
  const card = (title, ...kids) => h('section', { class: 'set-card' }, h('h2', null, title), ...kids);
  const text = t => h('p', { class: 'set-text' }, t);

  const fx = document.documentElement.dataset.fx || 'glass';
  const opt = (value, name, hint) => h('label', { class: 'radio' },
    h('input', { type: 'radio', name: 'fx', value, checked: fx === value, onchange: () => { store.set('gw.fx', value); document.documentElement.dataset.fx = value; } }),
    h('span', null, h('b', null, name), h('small', null, hint)));

  const me = session.me || {};
  v.append(h('div', { class: 'settings-page' },
    h('h1', { class: 'set-title' }, 'Settings'),
    shortcutsCard(card, text),
    fullScreenCard(card, text),
    card('Glass effects',
      opt('lite', 'Lite', 'Fastest. Tinted panels with no live blur.'),
      opt('glass', 'Glass', 'Frosted glass with highlights. A good balance.'),
      opt('liquid', 'Liquid', 'Adds rippled, bending glass to the player bar. Uses more graphics power.')),
    ...(SHELL ? [] : [card('App window',
      text(store.get('gw.installed', false)
        ? APP_NAME + ' is installed as an app. Opened from its own icon, the top bar follows the colours of the page.'
        : 'Install ' + APP_NAME + ' as an app and the bar at the very top of the window follows the colours of the page too.'),
      h('button', { class: 'pill ghost sm', onclick: () => { store.remove('gw.installed'); installApp(); } }, store.get('gw.installed', false) ? 'Install again' : 'Install as an app'))]),
    card('Keys inside ' + APP_NAME,
      text('Space: play or pause · Ctrl+→ / Ctrl+←: next or previous · L: lyrics · V: visualizer · F: full screen · Esc: back · / or Ctrl+K: search · Right-click a song for more.')),
    card('Lyrics', text('Lyrics come from lrclib.net, a free public lyrics site. Only the song’s title, artist, album and length are sent to it. Not every song has them.')),
    card('Local Files',
      text(APP_NAME + ' plays the music files in your Music folder. To add other folders, write one folder per line in “Local folders.txt” inside the ' + APP_NAME + ' folder, then press Rescan on the Local Files page.'),
      h('a', { class: 'pill ghost sm', href: '#/local' }, icon('folder', 16), h('span', null, 'Open Local Files'))),
    card('Account',
      text(DEMO ? 'This is the demo, with made-up music.' : 'Signed in to Spotify' + (me.display_name ? ' as ' + me.display_name : '') + '.'),
      h('button', { class: 'pill ghost sm', onclick: () => auth.signOut() }, DEMO ? 'Exit demo' : 'Sign out')),
    card('About', text(APP_NAME + ' is a personal, unofficial player. Music, artwork and data come from Spotify, and playing music needs Spotify Premium.'))));
}

// Where full screen opens.
let screensOff = null;
function fullScreenCard(card, text) {
  const pick = h('select', { class: 'set-select', 'aria-label': 'Screen for full screen' });
  const show = h('button', { class: 'pill ghost sm', onclick: () => post('identify') }, 'Show screen numbers');
  const note = h('p', { class: 'set-text' });
  function paint() {
    const chosen = store.get('gw.fullScreen', null);
    const opts = [h('option', { value: '' }, 'The screen ' + APP_NAME + ' is on')];
    let found = !chosen;
    for (const s of screens) {
      const same = chosen && (s.device === chosen.device || (s.x === chosen.x && s.y === chosen.y && s.w === chosen.w && s.h === chosen.h));
      if (same) found = true;
      opts.push(h('option', { value: s.device, selected: !!same }, 'Screen ' + s.n + ' · ' + s.w + ' × ' + s.h + (s.main ? ' · main' : '')));
    }
    if (chosen && !found) opts.push(h('option', { value: chosen.device, selected: true }, 'A screen that isn’t connected now (' + chosen.w + ' × ' + chosen.h + ')'));
    pick.replaceChildren(...opts);
    if (!chosen) pick.value = '';
    pick.disabled = !host2;
    show.hidden = !host2 || screens.length < 2;
    note.textContent = !host2
      ? 'Choosing a screen works in the ' + APP_NAME + ' app (Glasswave.exe). Here in a browser, full screen uses the screen the window is on.'
      : chosen && !found ? 'That screen isn’t connected, so full screen uses the screen ' + APP_NAME + ' is on until it is.'
      : 'The full screen button, the F key and the Full screen shortcut all use this screen. From the shortcut, your game or app keeps the keyboard and mouse.';
  }
  pick.addEventListener('change', () => {
    const s = screens.find(x => x.device === pick.value);
    if (!pick.value) store.remove('gw.fullScreen');
    else if (s) store.set('gw.fullScreen', { device: s.device, x: s.x, y: s.y, w: s.w, h: s.h });
    sendFullScreen();
    paint();
  });
  if (screensOff) screensOff();
  screensOff = bus.on('screens', paint);
  if (host2) post('screens?');
  paint();
  return card('Full screen', text('Choose the screen ' + APP_NAME + ' fills when it goes full screen.'),
    h('div', { class: 'set-row' }, pick, show), note);
}

// Choosing desktop-wide shortcuts: click a key box, then press the combo.
let choosing = null;                    // the row that is listening for a combo, if any
let shortcutsOff = null;
function shortcutsCard(card, text) {
  const where = h('p', { class: 'set-text' });
  const paintWhere = () => {
    where.textContent = host2
      ? 'They work wherever you are — in a game, another app, or with ' + APP_NAME + ' minimised — as long as ' + APP_NAME + ' is open.'
      : 'Here in a browser tab they only work while ' + APP_NAME + ' is in front. In the ' + APP_NAME + ' app (Glasswave.exe) they work everywhere, even in a game.';
  };
  paintWhere();
  const rows = hk.ACTIONS.map(([action, title]) => shortcutRow(action, title));
  const el = card('Shortcuts', text('Choose key combos for these. Click a box, then press the keys together.'), ...rows.map(r => r.el), where);
  // Only the newest copy of this card listens (the page may be rebuilt later).
  if (shortcutsOff) shortcutsOff();
  const off = bus.on('hotkeys-status', () => { paintWhere(); rows.forEach(r => r.paint()); });
  const off2 = bus.on('hotkeys-changed', () => rows.forEach(r => r.paint()));
  shortcutsOff = () => { off(); off2(); };
  return el;
}

function shortcutRow(action, title) {
  let listening = false, partial = '', problem = '';
  const keyBtn = h('button', { class: 'key-btn', 'aria-label': 'Shortcut for ' + title });
  const clear = iconBtn('close', 'Clear this shortcut', () => { stop(); problem = ''; hk.setKey(action, null); sendHotkeys(); paint(); }, 'sm key-clear');
  const msg = h('div', { class: 'key-msg', 'aria-live': 'polite' });
  const el = h('div', { class: 'key-row' }, h('div', { class: 'key-title' }, title), keyBtn, clear, msg);

  function paint() {
    const combo = hk.getKeys()[action];
    keyBtn.classList.toggle('listening', listening);
    keyBtn.classList.toggle('empty', !listening && !combo);
    keyBtn.textContent = listening ? (partial || 'Press the keys…') : combo ? hk.label(combo) : 'Choose keys';
    clear.hidden = listening || !combo;
    let line = '', kind = '';
    if (listening) line = 'Press the combo now. Esc cancels.';
    else if (problem) { line = problem; kind = 'warn'; }
    else if (combo && host2) {
      const st = hk.status[action];
      if (st === 'ok') { line = '✓ Works everywhere'; kind = 'ok'; }
      else if (st === 'taken') { line = 'Another program already uses ' + hk.label(combo) + '. Choose a different combo.'; kind = 'warn'; }
      else if (st === 'old') { line = 'Close ' + APP_NAME + ' and open it again to turn this on.'; kind = 'warn'; }
    }
    msg.textContent = line;
    msg.className = 'key-msg' + (kind ? ' ' + kind : '');
  }

  const swallow = e => { e.preventDefault(); e.stopImmediatePropagation(); };
  function onDown(e) {
    swallow(e);
    if (e.key === 'Escape' && !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey) { stop(); return; }
    const r = hk.fromEvent(e);
    if (r.partial !== undefined) { partial = r.partial; paint(); return; }
    if (r.error) { stop(); problem = r.error; paint(); return; }
    const keys = hk.getKeys();
    const other = hk.ACTIONS.find(([a]) => a !== action && hk.same(keys[a], r.combo));
    if (other) { stop(); problem = hk.label(r.combo) + ' is already used for ' + other[1] + '.'; paint(); return; }
    problem = '';
    hk.setKey(action, r.combo);
    stop();
  }
  function onUp(e) {
    swallow(e);
    partial = hk.fromEvent({ keyCode: 0, ctrlKey: e.ctrlKey, altKey: e.altKey, shiftKey: e.shiftKey, metaKey: e.metaKey }).partial;
    paint();
  }
  function onOutside(e) { if (e.target !== keyBtn) stop(); }
  function start() {
    if (choosing) choosing.stop();
    listening = true; partial = ''; problem = '';
    choosing = { stop };
    if (host2) post('hotkeys:pause');          // let go of the current combos, so they can be pressed here
    window.addEventListener('keydown', onDown, true);
    window.addEventListener('keyup', onUp, true);
    document.addEventListener('pointerdown', onOutside, true);
    window.addEventListener('blur', stop);
    paint();
  }
  function stop() {
    if (!listening) return;
    listening = false; partial = '';
    if (choosing && choosing.stop === stop) choosing = null;
    window.removeEventListener('keydown', onDown, true);
    window.removeEventListener('keyup', onUp, true);
    document.removeEventListener('pointerdown', onOutside, true);
    window.removeEventListener('blur', stop);
    sendHotkeys();
    paint();
  }
  keyBtn.addEventListener('click', () => { if (listening) stop(); else start(); });
  paint();
  return { el, paint };
}

function onKey(e) {
  if (!host2 && (e.ctrlKey || e.altKey || e.metaKey || e.keyCode >= 112)) {
    const action = hk.actionFor(e);
    if (action) { e.preventDefault(); runHotkey(action); return; }
  }
  const el = e.target;
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable;
  if ((e.key === '/' && !typing) || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k')) {
    e.preventDefault(); els.search.focus(); els.search.select(); return;
  }
  if (typing || e.altKey || e.metaKey || document.querySelector('.modal-back')) return;
  if (e.code === 'Space' && !el.closest('button, a, [role=slider]')) { e.preventDefault(); player.toggle(); }
  else if (e.ctrlKey && e.key === 'ArrowRight') { e.preventDefault(); player.next(); }
  else if (e.ctrlKey && e.key === 'ArrowLeft') { e.preventDefault(); player.prev(); }
  else if (vizOn) {                                   // the visualizer has the window to itself
    if (e.key === 'Escape') { if (vizFull) setVizFull(false); else toggleViz(false); }
    else if (!e.ctrlKey && e.key.toLowerCase() === 'f') setVizFull(!vizFull);
    else if (!e.ctrlKey && e.key.toLowerCase() === 'v') toggleViz(false);
  }
  else if (!e.ctrlKey && e.key.toLowerCase() === 'v') toggleViz(true);
  else if (e.key === 'Escape' && mode !== 'normal') setMode(mode === 'full' ? modeBefore : 'normal');
  else if (e.key === 'Escape' && !els.np.hidden) toggleNowPlaying(false);
  else if (!e.ctrlKey && e.key.toLowerCase() === 'f') setMode(mode === 'full' ? modeBefore : 'full');
  else if (!e.ctrlKey && e.key.toLowerCase() === 'l' && mode === 'normal') toggleNowPlaying(els.np.hidden);
}

boot();
