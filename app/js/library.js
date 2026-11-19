// Your Library (the list in the sidebar): playlists, saved albums, followed artists
// and podcasts together, with filter buttons, sorting and pins.
//
// Spotify does not tell outside apps which items you pinned, or what order its own
// "Recents" view uses. So Glasswave keeps its own pins (right-click > Pin to top) and
// works out "Recents" from your listening history plus what you play here.

import { DEMO } from './config.js';
import { sp, session, waiting } from './api.js';
import { h, icon, coverEl, store, bus, pickImg, debounce, report } from './util.js';
import * as player from './player.js';
import { openMenu, iconBtn, newPlaylist, playLiked } from './ui.js';

export const LIKED = 'glasswave:liked';
const SORTS = [['recents', 'Recents'], ['alpha', 'A to Z'], ['creator', 'Creator'], ['spotify', 'Spotify order']];
const FILTERS = [['playlist', 'Playlists'], ['album', 'Albums'], ['artist', 'Artists'], ['show', 'Podcasts']];
const KIND_RANK = { liked: 0, playlist: 1, album: 2, artist: 3, show: 4 };
const KIND_ICON = { liked: 'heartFill', playlist: 'note', album: 'disc', artist: 'user', show: 'mic' };
const PAGE = 80;                                   // how many rows to draw before "Show all"

let items = DEMO ? [] : (store.get('gw.library', []) || []);
let showAll = false;
let listEl = null, chipsEl = null, afterRender = null;

const thumb = images => { const url = pickImg(images, 64); return url ? [{ url, width: 64, height: 64 }] : []; };
const names = list => (list || []).map(a => a && a.name).filter(Boolean).join(', ');
const normal = uri => (/^spotify:user:[^:]+:collection$/.test(uri || '') ? LIKED : uri);

// ---- loading --------------------------------------------------------------------------------
async function pages(load, pick, max) {
  const out = [];
  let offset = 0;
  for (let i = 0; i < max; i++) {
    const page = await load(offset);
    const got = (page && page.items) || [];
    out.push(...got.map(pick).filter(Boolean));
    offset += got.length;
    if (!page || !page.next || !got.length) break;
  }
  return out;
}
async function followed(max) {
  const out = [];
  let after;
  for (let i = 0; i < max; i++) {
    const r = await sp.followedArtists(after);
    const a = (r && r.artists) || {};
    out.push(...(a.items || []).filter(Boolean));
    after = a.cursors && a.cursors.after;
    if (!a.next || !after) break;
  }
  return out;
}

// When Spotify does not answer, what you had stays, and Glasswave tries again by itself.
let problem = null;                                // { kinds: [...], status } while something could not be loaded
let retryTimer = 0, retryDelay = 0;
function retryLater() {
  clearTimeout(retryTimer);
  retryDelay = Math.min(retryDelay ? retryDelay * 2 : 30e3, 5 * 60e3);
  retryTimer = setTimeout(() => refreshLibrary().catch(() => {}), Math.max(retryDelay, waiting() + 1500));
}

export async function refreshLibrary() {
  const failed = [];
  let status = 0;
  const guard = (kind, p) => p.catch(e => { failed.push(kind); status = status || (e && e.status) || 0; return null; });
  const [playlists, albums, artists, shows] = await Promise.all([
    guard('playlist', sp.loadPlaylists()),
    guard('album', pages(sp.savedAlbums, x => x && x.album, 4)),
    guard('artist', followed(4)),
    guard('show', pages(sp.savedShows, x => x && x.show, 2)),
    loadRecents(),
  ]);
  const before = kind => items.filter(it => it.kind === kind);          // from the last time it loaded
  const out = [{ uri: LIKED, id: 'liked', kind: 'liked', name: 'Liked Songs', creator: '', sub: 'Playlist', href: '#/liked', images: [], index: 0 }];
  if (!playlists) out.push(...before('playlist'));
  else playlists.forEach((p, i) => p && p.id && out.push({
    uri: p.uri, id: p.id, kind: 'playlist', name: p.name || 'Playlist', creator: (p.owner && p.owner.display_name) || '',
    sub: 'Playlist' + (p.owner && p.owner.display_name ? ' · ' + p.owner.display_name : ''), href: '#/playlist/' + p.id, images: thumb(p.images), index: i,
  }));
  if (!albums) out.push(...before('album'));
  else albums.forEach((a, i) => a.id && out.push({ uri: a.uri, id: a.id, kind: 'album', name: a.name, creator: names(a.artists), sub: 'Album · ' + names(a.artists), href: '#/album/' + a.id, images: thumb(a.images), index: i }));
  if (!artists) out.push(...before('artist'));
  else artists.forEach((a, i) => a.id && out.push({ uri: a.uri, id: a.id, kind: 'artist', name: a.name, creator: a.name, sub: 'Artist', href: '#/artist/' + a.id, images: thumb(a.images), index: i }));
  if (!shows) out.push(...before('show'));
  else shows.forEach((s, i) => s.id && out.push({ uri: s.uri, id: s.id, kind: 'show', name: s.name, creator: '', sub: 'Podcast', href: '#/show/' + s.id, images: thumb(s.images), index: i }));
  items = out;
  if (!DEMO) store.set('gw.library', out.slice(0, 600));
  const count = kind => out.filter(it => it.kind === kind).length;
  if (failed.length) {
    problem = { kinds: failed, status };
    report('Library: Spotify did not answer for ' + failed.join(', ') + ' (' + (status || 'no connection') + '); kept ' + count('playlist') + ' playlists from last time');
    retryLater();
  } else {
    if (problem) report('Library loaded again: ' + count('playlist') + ' playlists, ' + count('album') + ' albums');
    problem = null; retryDelay = 0; clearTimeout(retryTimer);
  }
  render();
  bus.emit('library-loaded');
  return out;
}
const refreshSoon = debounce(() => { refreshLibrary().catch(() => {}); }, 500);
bus.on('playlists-changed', refreshSoon);
bus.on('library-changed', refreshSoon);

// ---- recently played ------------------------------------------------------------------------
let history = new Map();                           // address -> time last played, from your Spotify history
const mine = () => store.get('gw.played', {}) || {};
async function loadRecents() {
  try {
    const r = await sp.recent();
    const map = new Map();
    for (const it of (r && r.items) || []) {
      const uri = normal(it && it.context && it.context.uri), t = Date.parse(it.played_at) || 0;
      if (uri && t > (map.get(uri) || 0)) map.set(uri, t);
    }
    history = map;
  } catch { /* keep what we had */ }
}
// Call when something is played (or made) here, so it moves up under "Recents".
export function touch(uri) {
  uri = normal(uri);
  if (!uri) return;
  const played = mine();
  played[uri] = Date.now();
  store.set('gw.played', Object.fromEntries(Object.entries(played).sort((a, b) => b[1] - a[1]).slice(0, 200)));
  if (getSort() === 'recents') renderSoon();
}
bus.on('touch', touch);

// ---- pins, sorting, filtering ----------------------------------------------------------------
const getSort = () => store.get('gw.libSort', 'recents');
const getFilter = () => store.get('gw.libFilter', null);
function getPins() {
  const saved = store.get('gw.pins', null);
  return Array.isArray(saved) ? saved : [LIKED];                 // Liked Songs starts out pinned
}
const livePins = () => getPins().filter(u => items.some(i => i.uri === u));
function togglePin(uri) {
  const pins = getPins(), i = pins.indexOf(uri);
  if (i >= 0) pins.splice(i, 1); else pins.push(uri);
  store.set('gw.pins', pins);
  render();
}
// Puts an item at a chosen spot among the pins (pinning it if it was not pinned yet).
function placePin(uri, target, after) {
  const pins = livePins().filter(u => u !== uri);
  const at = pins.indexOf(target);
  if (at < 0 || uri === target) return;
  pins.splice(after ? at + 1 : at, 0, uri);
  store.set('gw.pins', pins);
  render();
}
function movePin(uri, dir) {
  const pins = livePins(), i = pins.indexOf(uri), j = i + dir;
  if (i < 0 || j < 0 || j >= pins.length) return;
  [pins[i], pins[j]] = [pins[j], pins[i]];
  store.set('gw.pins', pins);
  render();
}

// The library in the order the sidebar shows it: pinned items first, then the chosen sort.
export function sortedLibrary(opts = {}) {
  const filter = opts.filter === undefined ? getFilter() : opts.filter;
  const sort = opts.sort || getSort();
  const played = mine();
  const last = uri => Math.max(history.get(uri) || 0, played[uri] || 0);
  const base = (a, b) => (KIND_RANK[a.kind] - KIND_RANK[b.kind]) || (a.index - b.index);
  const text = (a, b) => String(a).localeCompare(String(b), undefined, { sensitivity: 'base', numeric: true });
  const cmp = {
    recents: (a, b) => (last(b.uri) - last(a.uri)) || base(a, b),
    spotify: base,
    alpha: (a, b) => text(a.name, b.name),
    creator: (a, b) => text(a.creator || '￿', b.creator || '￿') || text(a.name, b.name),
  }[sort] || base;
  const list = items.filter(i => !filter || i.kind === filter || (filter === 'playlist' && i.kind === 'liked'));
  const place = new Map(getPins().map((u, i) => [u, i]));
  const pinned = list.filter(i => place.has(i.uri)).sort((a, b) => place.get(a.uri) - place.get(b.uri)).map(i => ({ ...i, pinned: true }));
  return [...pinned, ...list.filter(i => !place.has(i.uri)).sort(cmp)];
}
export const playItem = it => { if (it.kind === 'liked') { playLiked(); touch(LIKED); } else player.playContext(it.uri); };

// ---- the panel in the sidebar ----------------------------------------------------------------
export function onLibraryRender(fn) { afterRender = fn; }

export function libraryPanel() {
  chipsEl = h('div', { class: 'chips', role: 'group', 'aria-label': 'Show only' }, FILTERS.map(([kind, label]) =>
    h('button', { class: 'chip', dataset: { kind }, onclick: () => { store.set('gw.libFilter', getFilter() === kind ? null : kind); showAll = false; render(); listEl.scrollTop = 0; } }, label)));
  listEl = h('div', { class: 'side-list' });
  const head = h('div', { class: 'side-head' },
    h('a', { href: '#/library/playlists', dataset: { nav: '#/library' }, title: 'Open your library' }, 'Your Library'),
    h('div', { class: 'side-tools' }, iconBtn('list', 'Sort your library', sortMenu, 'sm'), iconBtn('plus', 'New playlist', () => newPlaylist(), 'sm')));
  render();
  return [head, chipsEl, listEl];
}
function sortMenu(e) {
  const b = e.currentTarget.getBoundingClientRect(), now = getSort();
  openMenu(b.left, b.bottom + 6, [
    { header: 'Sort by' },
    ...SORTS.map(([key, label]) => ({ label, icon: key === now ? 'check' : null, active: key === now, onClick: () => { store.set('gw.libSort', key); showAll = false; render(); listEl.scrollTop = 0; } })),
    { sep: true },
    { hint: 'Right-click anything in the list to pin it. Drag pins up and down to reorder them.' },
  ]);
}
function itemMenu(it) {
  const pins = livePins(), at = pins.indexOf(it.uri);
  return [
    { label: 'Play', icon: 'play', onClick: () => playItem(it) },
    { sep: true },
    { label: at < 0 ? 'Pin' : 'Unpin', icon: 'pin', onClick: () => togglePin(it.uri) },
    at > 0 ? { label: 'Move pin up', icon: 'up', onClick: () => movePin(it.uri, -1) } : null,
    at >= 0 && at < pins.length - 1 ? { label: 'Move pin down', icon: 'down', onClick: () => movePin(it.uri, 1) } : null,
    pins.length > 1 || at < 0 ? { hint: 'Drag items up and down among the pins to put them in any order.' } : null,
  ];
}
let dragging = null;
function clearDrop() { if (listEl) for (const x of listEl.querySelectorAll('.drop-before, .drop-after')) x.classList.remove('drop-before', 'drop-after'); }

// Is this library item the thing that is playing right now?
function isCurrent(kind, uri) {
  const ctx = !player.state.files && player.state.contextUri;
  if (!ctx) return false;
  return kind === 'liked' ? /^spotify:user:[^:]+:collection$/.test(ctx) : ctx === uri;
}
function row(it) {
  // Hovering a row puts a play button over its picture, so it can be played without opening it first.
  const play = h('button', { class: 'side-play', title: 'Play ' + it.name, 'aria-label': 'Play ' + it.name,
    onclick: e => {
      e.preventDefault(); e.stopPropagation();
      if (isCurrent(it.kind, it.uri)) player.toggle(); else playItem(it);
    } }, icon('play', 18));
  const cover = coverEl(it.images, 64, KIND_ICON[it.kind] || 'note', it.kind === 'artist');
  if (it.kind === 'liked') cover.classList.add('liked-cover');
  const a = h('a', { class: 'side-item' + (it.pinned ? ' pinned' : ''), href: it.href, title: it.name, dataset: { nav: it.href, uri: it.uri, kind: it.kind } },
    h('span', { class: 'side-art' + (it.kind === 'artist' ? ' round' : '') }, cover, play),
    h('div', { class: 'ttext' },
      h('div', { class: 'tname' }, it.name),
      h('div', { class: 'tsub' }, it.pinned ? h('span', { class: 'pin-ic', title: 'Pinned' }, icon('pin', 12)) : null, it.sub)));
  a.addEventListener('contextmenu', e => { e.preventDefault(); openMenu(e.clientX, e.clientY, itemMenu(it)); });
  // Dragging: drop an item on a pinned one to put it just above or below it.
  a.draggable = true;
  a.addEventListener('dragstart', e => {
    dragging = it.uri;
    a.classList.add('dragging');
    try { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', it.name); } catch { /* the drag still works */ }
  });
  a.addEventListener('dragend', () => { dragging = null; a.classList.remove('dragging'); clearDrop(); });
  a.addEventListener('dragover', e => {
    if (!dragging || dragging === it.uri || !it.pinned) return;
    e.preventDefault();
    try { e.dataTransfer.dropEffect = 'move'; } catch { /* fine */ }
    const r = a.getBoundingClientRect(), after = e.clientY > r.top + r.height / 2;
    if (a.classList.contains(after ? 'drop-after' : 'drop-before')) return;
    clearDrop();
    a.classList.add(after ? 'drop-after' : 'drop-before');
  });
  a.addEventListener('dragleave', e => { if (!a.contains(e.relatedTarget)) a.classList.remove('drop-before', 'drop-after'); });
  a.addEventListener('drop', e => {
    if (!dragging || dragging === it.uri || !it.pinned) return;
    e.preventDefault();
    const r = a.getBoundingClientRect(), uri = dragging;
    dragging = null;
    placePin(uri, it.uri, e.clientY > r.top + r.height / 2);
  });
  return a;
}
// Shows which row is playing, and turns its button into pause while it plays.
let playSig = null;
function paintPlaying(force) {
  if (!listEl) return;
  const sig = (player.state.files ? '' : player.state.contextUri || '') + '|' + player.state.paused;
  if (!force && sig === playSig) return;
  playSig = sig;
  for (const a of listEl.querySelectorAll('.side-item')) {
    const on = isCurrent(a.dataset.kind, a.dataset.uri), going = on && !player.state.paused;
    a.classList.toggle('playing', on);
    const b = a.querySelector('.side-play');
    if (!b || b.dataset.going === String(going)) continue;
    b.dataset.going = String(going);
    b.replaceChildren(icon(going ? 'pause' : 'play', 18));
    b.title = (going ? 'Pause ' : 'Play ') + a.title;
    b.setAttribute('aria-label', b.title);
  }
}
player.subscribe(() => paintPlaying(false));
function problemNote() {
  const kept = items.some(it => it.kind === 'playlist');
  const mins = Math.ceil(waiting() / 60000);
  const why = problem.status === 429
    ? 'Spotify asked Glasswave to wait' + (mins > 1 ? ' about ' + mins + ' minutes' : ' a moment') + ' before asking again.'
    : problem.status === 0 ? 'Spotify can\u2019t be reached right now.' : 'Spotify didn\u2019t answer properly (' + problem.status + ').';
  return h('div', { class: 'side-problem', role: 'status' },
    h('div', null, why + ' ' + (kept ? 'These are your playlists from last time.' : 'Your playlists will show up when it answers.') + ' Glasswave tries again by itself.'),
    h('button', { class: 'pill ghost sm', onclick: () => { retryDelay = 0; refreshLibrary().catch(() => {}); } }, 'Try now'));
}

function render() {
  if (!listEl) return;
  const filter = getFilter();
  for (const c of chipsEl.children) { const on = c.dataset.kind === filter; c.classList.toggle('on', on); c.setAttribute('aria-pressed', String(on)); }
  const list = sortedLibrary();
  const shown = showAll ? list : list.slice(0, PAGE);
  listEl.replaceChildren(...shown.map(row));
  if (problem && problem.kinds.includes('playlist')) listEl.prepend(problemNote());
  if (list.length > shown.length) listEl.append(h('button', { class: 'side-more', onclick: () => { showAll = true; render(); } }, 'Show all ' + list.length));
  if (!list.length) listEl.append(h('div', { class: 'side-empty' }, filter ? 'Nothing saved here yet.' : 'Your library will show up here.'));
  paintPlaying(true);
  if (afterRender) afterRender();
  bus.emit('library-order');
}
const renderSoon = debounce(render, 150);
