// Reusable interface pieces: song lists, cards, menus, dialogs.

import { h, icon, coverEl, fmtTime, toast, clamp, bus } from './util.js';
import { sp, session } from './api.js';
import * as player from './player.js';
import { local, findLocal, playLocal, queueLocal } from './local.js';

export const navigate = hash => { location.hash = hash; };
export const linkFor = o => `#/${o.type}/${o.id}`;
export const imagesOf = t => (t && (t.images || (t.album && t.album.images) || (t.show && t.show.images))) || [];
const KIND_ICON = { album: 'disc', artist: 'user', playlist: 'note', show: 'mic', track: 'note', episode: 'mic' };

export function artistLinks(artists) {
  const out = [];
  (artists || []).forEach((a, i) => {
    if (i) out.push(', ');
    out.push(a.id ? h('a', { href: '#/artist/' + a.id }, a.name) : a.name);
  });
  return out;
}

// ---- buttons ------------------------------------------------------------------------------
export const iconBtn = (name, title, onClick, cls = '') => h('button', { class: 'icon-btn ' + cls, title, 'aria-label': title, onclick: onClick }, icon(name));
export const pill = (label, name, onClick, cls = '') => h('button', { class: 'pill ' + cls, onclick: onClick }, name ? icon(name, 18) : null, h('span', null, label));
export const playBig = (onClick, title = 'Play') => h('button', { class: 'play-big', title, 'aria-label': title, onclick: onClick }, icon('play', 26));

// A pill that flips between two states (Save / Saved, Follow / Following).
export function toggleSave(uri, labels = ['Save', 'Saved']) {
  let on = false;
  const btn = pill(labels[0], 'heart', async () => {
    const want = !on;
    paint(want);
    try { await (want ? sp.save([uri]) : sp.unsave([uri])); bus.emit('library-changed', uri); }
    catch (e) { paint(!want); toast(e.message, { error: true }); }
  }, 'ghost');
  function paint(v) {
    on = v;
    btn.classList.toggle('on', on);
    btn.replaceChildren(icon(on ? 'heartFill' : 'heart', 18), h('span', null, labels[on ? 1 : 0]));
  }
  sp.contains([uri]).then(r => paint(!!r[0])).catch(() => {});
  return btn;
}

// ---- menus --------------------------------------------------------------------------------
let menuEl = null;
export function closeMenu() { if (menuEl) { menuEl.remove(); menuEl = null; } }
export function openMenu(x, y, items) {
  closeMenu();
  const el = menuEl = h('div', { class: 'menu glass', role: 'menu' });
  const place = () => {
    const r = el.getBoundingClientRect();
    el.style.left = clamp(x, 8, innerWidth - r.width - 8) + 'px';
    el.style.top = clamp(y, 8, innerHeight - r.height - 8) + 'px';
  };
  const fill = list => {
    el.replaceChildren();
    for (const it of list) {
      if (!it) continue;
      if (it.sep) { el.append(h('div', { class: 'msep' })); continue; }
      if (it.header) { el.append(h('div', { class: 'mhead' }, it.header)); continue; }
      if (it.hint) { el.append(h('div', { class: 'mhint' }, it.hint)); continue; }
      const b = h(it.href ? 'a' : 'button', {
        class: 'mitem' + (it.danger ? ' danger' : '') + (it.active ? ' active' : ''), role: 'menuitem',
        href: it.href, target: it.external ? '_blank' : null, rel: it.external ? 'noopener' : null,
      }, it.icon ? icon(it.icon, 18) : h('span', { class: 'mi-pad' }), h('span', { class: 'mlabel' }, it.label), it.submenu ? icon('forward', 16) : null);
      b.addEventListener('click', async e => {
        if (it.submenu) {
          e.preventDefault();
          const sub = await it.submenu();
          if (menuEl !== el) return;
          fill([{ label: 'Back', icon: 'back', stay: () => fill(list) }, { sep: true }, ...sub]);
          return place();
        }
        if (it.stay) { e.preventDefault(); it.stay(); return place(); }
        closeMenu();
        if (it.onClick) it.onClick();
      });
      el.append(b);
    }
  };
  fill(items);
  document.body.append(el);
  place();
}
document.addEventListener('pointerdown', e => { if (menuEl && !menuEl.contains(e.target)) closeMenu(); }, true);
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeMenu(); });
window.addEventListener('blur', closeMenu);
window.addEventListener('resize', closeMenu);
window.addEventListener('hashchange', closeMenu);

// ---- dialogs ------------------------------------------------------------------------------
export function dialog(title, bodyNodes, buttons) {
  return new Promise(resolve => {
    const done = v => { back.remove(); document.removeEventListener('keydown', onKey, true); resolve(v); };
    const onKey = e => { if (e.key === 'Escape') { e.stopPropagation(); done(null); } };
    const box = h('div', { class: 'modal glass', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      h('h2', null, title), bodyNodes,
      h('div', { class: 'modal-actions' }, buttons.map(b => h('button', { class: 'pill ' + (b.cls || 'ghost'), onclick: () => done(typeof b.value === 'function' ? b.value() : b.value) }, b.label))));
    const back = h('div', { class: 'modal-back', onpointerdown: e => { if (e.target === back) done(null); } }, box);
    document.body.append(back);
    document.addEventListener('keydown', onKey, true);
    const first = box.querySelector('input, textarea, select') || box.querySelector('.modal-actions .pill:last-child');
    if (first) { first.focus(); if (first.select) first.select(); }
    box.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.tagName === 'INPUT') { e.preventDefault(); box.querySelector('.modal-actions .pill:last-child').click(); } });
  });
}
export function ask(title, label, value = '', okText = 'Save') {
  const input = h('input', { class: 'field', type: 'text', value, maxlength: '100', placeholder: label, 'aria-label': label });
  return dialog(title, input, [{ label: 'Cancel', value: null }, { label: okText, cls: 'primary', value: () => input.value.trim() || null }]);
}
export const confirmBox = (title, text, okText = 'OK', danger = false) =>
  dialog(title, h('p', { class: 'modal-text' }, text), [{ label: 'Cancel', value: false }, { label: okText, cls: danger ? 'danger' : 'primary', value: true }]);

// Plays Liked Songs from the top. It has no official "play this list" address, so try it and fall back to a plain list.
export async function playLiked() {
  const me = session.me;
  if (me && await player.playContext(`spotify:user:${me.id}:collection`, undefined, true)) return;
  try { const page = await sp.liked(0); player.playUris(((page && page.items) || []).map(x => x && x.track && x.track.uri), 0); }
  catch (e) { toast(e.message, { error: true }); }
}

// ---- song menu ----------------------------------------------------------------------------
async function addTo(playlist, uri) {
  try { await sp.addToPlaylist(playlist.id, [uri]); toast('Added to ' + playlist.name); bus.emit('playlist-changed', playlist.id); }
  catch (e) { toast(e.status === 403 ? 'Spotify wouldn’t let this app change that playlist.' : e.message, { error: true }); }
}
export async function newPlaylist(firstUri) {
  const name = await ask('New playlist', 'Playlist name', '', 'Create');
  if (!name) return null;
  try {
    const p = await sp.createPlaylist(name);
    if (firstUri && p) await sp.addToPlaylist(p.id, [firstUri]);
    await sp.loadPlaylists(true);
    if (p && p.uri) bus.emit('touch', p.uri);
    bus.emit('playlists-changed');
    toast('Created ' + name);
    return p;
  } catch (e) { toast(e.message, { error: true }); return null; }
}
function playlistTargets(uri) {
  const mine = session.playlists.filter(p => p.collaborative || (p.owner && session.me && p.owner.id === session.me.id));
  return [
    { label: 'New playlist…', icon: 'plus', onClick: () => newPlaylist(uri) },
    mine.length ? { sep: true } : null,
    ...mine.slice(0, 60).map(p => ({ label: p.name, onClick: () => addTo(p, uri) })),
  ];
}
export function trackMenu(t, ctx = {}) {
  const song = t.type !== 'episode';
  const like = async on => {
    try { await (on ? sp.save([t.uri]) : sp.unsave([t.uri])); toast(on ? 'Saved to Liked Songs' : 'Removed from Liked Songs'); bus.emit('library-changed', t.uri); if (!on && ctx.onUnliked) ctx.onUnliked(); }
    catch (e) { toast(e.message, { error: true }); }
  };
  const artist = t.artists && t.artists.find(a => a.id);
  const web = t.external_urls && t.external_urls.spotify;
  return [
    { label: 'Play', icon: 'play', onClick: ctx.play || (() => player.playUris([t.uri])) },
    { label: 'Add to queue', icon: 'queue', onClick: () => player.addToQueue(t.uri) },
    { sep: true },
    song && !ctx.liked ? { label: 'Save to Liked Songs', icon: 'heart', onClick: () => like(true) } : null,
    song && ctx.liked ? { label: 'Remove from Liked Songs', icon: 'heartFill', onClick: () => like(false) } : null,
    song ? { label: 'Add to playlist', icon: 'plus', submenu: async () => playlistTargets(t.uri) } : null,
    ctx.remove ? { label: 'Remove from this playlist', icon: 'close', danger: true, onClick: ctx.remove } : null,
    { sep: true },
    t.album && t.album.id ? { label: 'Go to album', icon: 'disc', href: '#/album/' + t.album.id } : null,
    artist ? { label: 'Go to artist', icon: 'user', href: '#/artist/' + artist.id } : null,
    t.show && t.show.id ? { label: 'Go to podcast', icon: 'mic', href: '#/show/' + t.show.id } : null,
    web ? { label: 'Open in Spotify', icon: 'external', href: web, external: true } : null,
  ];
}

// ---- song list ----------------------------------------------------------------------------
// opts: { showAlbum, showCover, albumNumbers, play(index), menu(track, index, rowEl) }
export function trackList(opts = {}) {
  const tracks = [];
  const el = h('div', { class: 'tracks' + (opts.showAlbum ? ' with-album' : '') + (opts.extra ? ' with-extra' : ''), role: 'table' });

  function row(t, i) {
    const dim = t.is_playable === false || (t.is_local && !findLocal(t));
    return h('div', { class: 'trow' + (dim ? ' dim' : ''), dataset: { i: String(i), uri: t.uri }, tabIndex: 0, role: 'row' },
      h('div', { class: 'tnum' },
        h('span', { class: 'n' }, String(opts.albumNumbers ? (t.track_number || i + 1) : i + 1)),
        h('span', { class: 'eq', 'aria-hidden': 'true' }, h('i'), h('i'), h('i')),
        h('button', { class: 'tplay', title: 'Play', 'aria-label': 'Play ' + t.name }, icon('play', 16))),
      h('div', { class: 'tmain' },
        opts.showCover ? coverEl(imagesOf(t), 64, KIND_ICON[t.type] || 'note') : null,
        h('div', { class: 'ttext' },
          h('div', { class: 'tname' }, h('span', { class: 'tn' }, t.name), t.explicit ? h('span', { class: 'tag', title: 'Explicit' }, 'E') : null),
          h('div', { class: 'tsub' }, t.type === 'episode' ? (t.release_date || (t.show && t.show.name) || 'Episode') : artistLinks(t.artists)))),
      opts.showAlbum ? h('div', { class: 'talbum' }, t.album && t.album.id ? h('a', { href: '#/album/' + t.album.id }, t.album.name) : ((t.album && t.album.name) || '')) : null,
      opts.extra ? h('div', { class: 'textra' }, opts.extra(t, i)) : null,
      h('div', { class: 'tdur' }, t.is_file && !t.duration_ms ? '' : fmtTime(t.duration_ms)),
      h('div', { class: 'tacts' },
        dim ? null : h('button', { class: 'icon-btn sm tqueue', title: 'Add to queue', 'aria-label': 'Add ' + t.name + ' to the queue' }, icon('queueAdd', 18)),
        h('button', { class: 'icon-btn sm tmore', title: 'More', 'aria-label': 'More options for ' + t.name }, icon('more', 18))));
  }
  function add(list) {
    const frag = document.createDocumentFragment();
    for (const t of list) {
      if (!t || !t.uri) continue;
      frag.append(row(t, tracks.push(t) - 1));
    }
    el.append(frag);
    markPlaying(el);
  }
  function playRow(i) {
    const t = tracks[i];
    if (!t) return;
    if (player.state.track && player.state.track.uri === t.uri) return player.toggle();
    if (t.is_local) {                      // a song Spotify only knows as a file on a computer: play this computer's copy
      const f = findLocal(t);
      if (f) return playLocal([f], 0);
      return toast(local.indexed ? 'That song is a file from a computer. Glasswave couldn\u2019t find it in your Music folder.' : 'Still reading your music files. Try that again in a moment.');
    }
    opts.play ? opts.play(i, t) : player.playUris(tracks.map(x => x.uri), i);
  }
  function menuFor(i, rowEl, x, y) {
    const t = tracks[i];
    if (!t) return;
    const ctx = opts.menu ? opts.menu(t, i, rowEl) : {};
    openMenu(x, y, opts.items ? opts.items(t, i, rowEl) : trackMenu(t, { play: () => playRow(i), ...ctx }));
  }
  el.addEventListener('click', e => {
    const r = e.target.closest('.trow');
    if (!r) return;
    const i = Number(r.dataset.i);
    if (e.target.closest('.tplay')) return playRow(i);
    const q = e.target.closest('.tqueue');
    if (q) { if (queueSong(tracks[i])) queued(q); return; }
    const more = e.target.closest('.tmore');
    if (more) { const b = more.getBoundingClientRect(); menuFor(i, r, b.right - 220, b.bottom + 6); }
  });
  el.addEventListener('dblclick', e => {
    if (e.target.closest('a, button')) return;
    const r = e.target.closest('.trow');
    if (r) playRow(Number(r.dataset.i));
  });
  el.addEventListener('contextmenu', e => {
    const r = e.target.closest('.trow');
    if (!r) return;
    e.preventDefault();
    menuFor(Number(r.dataset.i), r, e.clientX, e.clientY);
  });
  el.addEventListener('keydown', e => {
    if (e.key !== 'Enter' || e.target.closest('a, button')) return;
    const r = e.target.closest('.trow');
    if (r) playRow(Number(r.dataset.i));
  });
  return { el, tracks, add, playRow };
}

// Once the music files on this computer have been read, songs that Spotify lists as "local" and that
// were found here stop being greyed out.
bus.on('local-indexed', () => {
  for (const r of document.querySelectorAll('.trow.dim[data-uri^="spotify:local:"]')) {
    const p = r.dataset.uri.split(':').map(x => { try { return decodeURIComponent(x.replace(/\+/g, ' ')); } catch { return x; } });
    if (findLocal({ name: p[4], artists: [{ name: p[2] }], duration_ms: Number(p[5]) * 1000 })) r.classList.remove('dim');
  }
});

// Lights up whichever row is the song playing right now.
export function markPlaying(root = document) {
  const uri = player.state.track && player.state.track.uri;
  for (const r of root.querySelectorAll('.trow.playing')) if (r.dataset.uri !== uri) r.classList.remove('playing', 'paused');
  if (!uri) return;
  for (const r of root.querySelectorAll('.trow[data-uri="' + CSS.escape(uri) + '"]')) {
    r.classList.add('playing');
    r.classList.toggle('paused', player.state.paused);
  }
}

// ---- cards --------------------------------------------------------------------------------
export function card(o) {
  let sub = '';
  if (o.type === 'album') sub = [(o.release_date || '').slice(0, 4), (o.artists || []).map(a => a.name).join(', ')].filter(Boolean).join(' · ');
  else if (o.type === 'artist') sub = 'Artist';
  else if (o.type === 'playlist') sub = o.owner && o.owner.display_name ? 'By ' + o.owner.display_name : 'Playlist';
  else if (o.type === 'show') sub = o.publisher || 'Podcast';
  return h('a', { class: 'card', href: linkFor(o), title: o.name },
    h('div', { class: 'card-art' },
      coverEl(o.images, 300, KIND_ICON[o.type] || 'note', o.type === 'artist'),
      h('button', { class: 'card-play', title: 'Play', 'aria-label': 'Play ' + o.name, onclick: e => { e.preventDefault(); e.stopPropagation(); player.playContext(o.uri); } }, icon('play', 20))),
    h('div', { class: 'card-title' }, o.name),
    h('div', { class: 'card-sub' }, sub));
}
export const grid = (items, cls = '') => h('div', { class: 'grid ' + cls }, items.filter(o => o && o.id).map(card));

// A song shown as a card (used on Home). Click opens its album; the round button plays it.
// Adds one song to the queue: a Spotify song, a music file from this computer, or a song
// Spotify lists as a local file (this computer's copy is used).
export function queueSong(t) {
  if (!t) return false;
  let file = t.is_file ? t : null;
  if (!file && t.is_local) {
    file = findLocal(t);
    if (!file) { toast('That song is a file from a computer. Glasswave couldn\u2019t find it in your Music folder.'); return false; }
  }
  if (file) {
    if (!player.state.files && player.state.track) {
      toast('A Spotify song is playing, so music files from this computer can\u2019t join its queue. Play the file instead.');
      return false;
    }
    queueLocal(file);
    return true;
  }
  if (player.state.files) {
    toast('A music file from this computer is playing, so Spotify songs can\u2019t join its queue. Play the song instead, or queue music files.');
    return false;
  }
  player.addToQueue(t.uri);
  return true;
}
// The button's check mark after a click.
function queued(btn) {
  btn.classList.add('done');
  btn.replaceChildren(icon('check', 18));
  clearTimeout(btn._t);
  btn._t = setTimeout(() => { btn.classList.remove('done'); btn.replaceChildren(icon('queueAdd', 18)); }, 1400);
}

export function songCard(t, onPlay) {
  const el = h('div', { class: 'card song-card', title: t.name, tabIndex: 0, dataset: { uri: t.uri } },
    h('div', { class: 'card-art' },
      coverEl(imagesOf(t), 300, 'note'),
      h('button', { class: 'card-play', title: 'Play', 'aria-label': 'Play ' + t.name, onclick: e => { e.stopPropagation(); onPlay(); } }, icon('play', 20)),
      h('button', { class: 'card-queue', title: 'Add to queue', 'aria-label': 'Add ' + t.name + ' to the queue', onclick: e => { e.stopPropagation(); if (queueSong(t)) queued(e.currentTarget); } }, icon('queueAdd', 18))),
    h('div', { class: 'card-title' }, t.name),
    h('div', { class: 'card-sub' }, artistLinks(t.artists)));
  el.addEventListener('click', e => { if (!e.target.closest('a, button') && t.album && t.album.id) navigate('#/album/' + t.album.id); });
  el.addEventListener('dblclick', e => { if (!e.target.closest('a, button')) onPlay(); });
  el.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target === el) onPlay(); });
  el.addEventListener('contextmenu', e => { e.preventDefault(); openMenu(e.clientX, e.clientY, trackMenu(t, { play: onPlay })); });
  return el;
}

// A rounded shortcut to something you open a lot.
export function quickPick(o) {
  return h('a', { class: 'quick', href: o.href || linkFor(o), title: o.name },
    coverEl(o.images, 64, o.iconName || KIND_ICON[o.type] || 'note', true),
    h('span', { class: 'quick-name' }, o.name),
    h('button', { class: 'quick-play', title: 'Play', 'aria-label': 'Play ' + o.name, onclick: e => { e.preventDefault(); e.stopPropagation(); o.play ? o.play() : player.playContext(o.uri); } }, icon('play', 16)));
}

// A row that scrolls sideways, with arrow buttons that appear when there is more to see.
export function shelf(nodes) {
  const el = h('div', { class: 'shelf' }, nodes);
  const step = dir => el.scrollBy({ left: dir * Math.max(240, el.clientWidth * 0.85), behavior: 'smooth' });
  const prev = iconBtn('back', 'Scroll back', () => step(-1), 'sm');
  const next = iconBtn('forward', 'Scroll forward', () => step(1), 'sm');
  const arrows = h('div', { class: 'shelf-arrows' }, prev, next);
  const sync = () => {
    arrows.hidden = el.scrollWidth <= el.clientWidth + 4;
    prev.disabled = el.scrollLeft < 4;
    next.disabled = el.scrollLeft + el.clientWidth > el.scrollWidth - 4;
  };
  el.addEventListener('scroll', sync, { passive: true });
  if ('ResizeObserver' in window) new ResizeObserver(sync).observe(el);
  requestAnimationFrame(sync);
  return { el, arrows };
}
export const cardShelf = items => shelf(items.filter(o => o && o.id).map(card));

// ---- page pieces ----------------------------------------------------------------------------
export function hero({ kind, title, images, round, lines = [], actions = [], iconName = 'note' }) {
  return h('header', { class: 'hero' },
    coverEl(images, 300, iconName, round),
    h('div', { class: 'hero-text' },
      h('div', { class: 'hero-kind' }, kind),
      h('h1', { title }, title),
      lines.filter(Boolean).map(l => h('div', { class: 'hero-line' }, l)),
      h('div', { class: 'hero-actions' }, actions)));
}
export function section(title, extra) {
  const body = h('div', { class: 'section-body' }, skeleton());
  const tools = h('div', { class: 'section-tools' }, extra || null);
  const el = h('section', { class: 'section' }, h('div', { class: 'section-head' }, h('h2', null, title), tools), body);
  return { el, body, tools, set(node) { body.replaceChildren(node); }, hide() { el.remove(); } };
}
export const skeleton = (n = 6) => h('div', { class: 'grid skeleton one-row', 'aria-hidden': 'true' }, Array.from({ length: n }, () => h('div', { class: 'card ghost-card' }, h('div', { class: 'cover' }), h('div', { class: 'line' }), h('div', { class: 'line short' }))));
export const spinner = () => h('div', { class: 'spinner', role: 'status', 'aria-label': 'Loading' });
export function note(iconName, title, text, action) {
  return h('div', { class: 'note' }, icon(iconName, 30), h('div', { class: 'note-title' }, title), text ? h('div', { class: 'note-text' }, text) : null, action || null);
}

// Loads the next page whenever the bottom of a list scrolls into view.
export function infinite(scroller, host, loadMore) {
  const sentinel = h('div', { class: 'sentinel' }, spinner());
  host.append(sentinel);
  let busy = false;
  const io = new IntersectionObserver(async entries => {
    if (busy || !entries.some(e => e.isIntersecting)) return;
    busy = true;
    let more = false;
    try { more = await loadMore(); }
    catch (e) { host.append(note('close', 'Couldn’t load more', e.message)); }
    busy = false;
    if (!more) { io.disconnect(); sentinel.remove(); return; }
    io.unobserve(sentinel); io.observe(sentinel);      // still on screen? load again
  }, { root: scroller, rootMargin: '700px 0px' });
  io.observe(sentinel);
}
