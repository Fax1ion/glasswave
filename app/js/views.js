// The screens: home, search, liked songs, playlists, albums, artists, podcasts, library.

import { APP_NAME } from './config.js';
import { h, icon, toast, bus, fmtLong, fmtTime, plural, plainText, pickImg, coverEl, debounce } from './util.js';
import { sp, session } from './api.js';
import * as player from './player.js';
import { trackList, grid, hero, section, note, spinner, infinite, playBig, pill, toggleSave, artistLinks, imagesOf, openMenu, ask, confirmBox, navigate, shelf, cardShelf, songCard, quickPick } from './ui.js';
import { homeRecs, freshReleases, playlistRecs } from './recs.js';
import { sortedLibrary, playItem } from './library.js';
import { local, loadLocal, playLocal, queueLocal, indexLocal } from './local.js';

const year = d => (d || '').slice(0, 4);
const openInSpotify = o => (o.external_urls && o.external_urls.spotify ? { label: 'Open in Spotify', icon: 'external', href: o.external_urls.spotify, external: true } : null);
const moreBtn = items => h('button', { class: 'icon-btn', title: 'More', 'aria-label': 'More options', onclick: e => { const b = e.currentTarget.getBoundingClientRect(); openMenu(b.left, b.bottom + 6, items()); } }, icon('more'));

// ---- Home -----------------------------------------------------------------------------------
let heroPaint = null;
bus.on('player-changed', () => { if (heroPaint) heroPaint(); });
let quicksPaint = null;
bus.on('library-order', () => { if (quicksPaint) quicksPaint(); });

export async function viewHome(v, ctx) {
  ctx.theme({ key: 'home' });
  const hour = new Date().getHours();
  const hello = hour < 5 ? 'Up late' : hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const first = session.me && session.me.display_name ? ', ' + session.me.display_name.split(' ')[0] : '';
  v.append(h('div', { class: 'view-head' }, h('h1', null, hello + first)));

  // Top of the page: what you were listening to, and shortcuts to the things you open most.
  const banner = h('div', { class: 'continue' });
  const quicks = h('div', { class: 'quicks' });
  v.append(h('div', { class: 'bento' }, banner, quicks));

  let lastAlbum = null;
  const paintBanner = () => {
    const st = player.state, t = st.track;
    let label = 'Welcome', title = 'Pick something to play', sub = 'Search above, or open a playlist from the sidebar.', images = [], href = null, onPlay = null, playing = false;
    if (t) {
      playing = !st.paused;
      label = playing ? 'Now playing' : 'Continue listening';
      title = t.name; sub = artistLinks(t.artists); images = imagesOf(t);
      href = t.album && t.album.id ? '#/album/' + t.album.id : (t.show && t.show.id ? '#/show/' + t.show.id : null);
      onPlay = () => player.toggle();
    } else if (lastAlbum) {
      label = 'Jump back in'; title = lastAlbum.name; sub = artistLinks(lastAlbum.artists); images = lastAlbum.images;
      href = '#/album/' + lastAlbum.id;
      onPlay = () => player.playContext(lastAlbum.uri);
    }
    banner.replaceChildren(
      coverEl(images, 300, 'note'),
      h('div', { class: 'continue-text' },
        h('div', { class: 'hero-kind' }, label),
        h('div', { class: 'continue-title' }, href ? h('a', { href }, title) : title),
        h('div', { class: 'continue-sub' }, sub),
        onPlay ? h('div', { class: 'hero-actions' }, h('button', { class: 'play-big', title: playing ? 'Pause' : 'Play', 'aria-label': playing ? 'Pause' : 'Play', onclick: onPlay }, icon(playing ? 'pause' : 'play', 26))) : null));
  };
  heroPaint = () => { if (banner.isConnected) paintBanner(); };
  paintBanner();

  // Shortcuts: the first six things in your library, in the same order as the sidebar (pinned first).
  const paintQuicks = () => {
    quicks.replaceChildren(...sortedLibrary({ filter: null }).slice(0, 6).map(it => {
      const q = quickPick({ name: it.name, href: it.href, images: it.images, uri: it.uri, type: it.kind === 'liked' ? 'playlist' : it.kind, iconName: it.kind === 'liked' ? 'heartFill' : undefined, play: () => playItem(it) });
      if (it.kind === 'liked') q.classList.add('liked');
      return q;
    }));
  };
  quicksPaint = () => { if (quicks.isConnected) paintQuicks(); };
  paintQuicks();

  // Shelves.
  const refresh = pill('Refresh', null, () => loadRecs(true), 'ghost sm');
  const recArrows = h('div', null);
  const recs = section('Recommended for you', [refresh, recArrows]);
  recs.el.insertBefore(h('div', { class: 'section-sub' }, 'Picked by ' + APP_NAME + ' from the genres and artists you play most. New picks every day.'), recs.body);
  const recent = section('Jump back in');
  const tops = section('Your top songs right now');
  const artists = section('Your top artists');
  const fresh = section('New from artists you like');
  const lists = section('Your playlists', h('a', { class: 'see-all', href: '#/library/playlists' }, 'See all'));
  v.append(recs.el, recent.el, tops.el, artists.el, fresh.el, lists.el);
  const putShelf = (sec, sh) => { sec.set(sh.el); sec.tools.append(sh.arrows); };

  const topArtists = sp.top('artists', 12).then(r => ((r && r.items) || []).filter(Boolean)).catch(() => []);
  const topTracks = sp.top('tracks', 10).then(r => ((r && r.items) || []).filter(Boolean)).catch(() => []);
  const recents = sp.recent().then(r => ((r && r.items) || []).filter(x => x && x.track)).catch(() => []);

  recents.then(items => {
    const seen = new Set(), albums = [];
    for (const it of items) {
      const a = it.track.album;
      if (a && a.id && !seen.has(a.id)) { seen.add(a.id); albums.push({ ...a, type: 'album' }); }
    }
    lastAlbum = albums[0] || null;
    if (!player.state.track) heroPaint();
    albums.length ? putShelf(recent, cardShelf(albums.slice(0, 14))) : recent.hide();
  });
  topTracks.then(items => {
    if (!items.length) return tops.hide();
    const list = trackList({ showCover: true, showAlbum: true });
    list.add(items.slice(0, 6));
    tops.set(list.el);
  });
  topArtists.then(items => { items.length ? putShelf(artists, cardShelf(items)) : artists.hide(); });
  topArtists.then(items => freshReleases(items)).then(albums => { albums.length ? putShelf(fresh, cardShelf(albums)) : fresh.hide(); }).catch(() => fresh.hide());

  async function loadRecs(force) {
    refresh.disabled = true;
    try {
      const [ta, tt, rc] = await Promise.all([topArtists, topTracks, recents]);
      let seeds = ta;
      if (!seeds.length) {                               // no listening history yet: lean on what was played lately
        const seen = new Set();
        seeds = rc.map(x => x.track.artists && x.track.artists[0]).filter(a => a && a.name && !seen.has(a.name) && seen.add(a.name));
      }
      const exclude = new Set([...tt.map(t => t.uri), ...rc.map(x => x.track.uri)]);
      const picks = await homeRecs(seeds, exclude, force);
      if (!picks.length) { if (force) toast('No new picks found right now.'); else recs.hide(); }
      else {
        const uris = picks.map(t => t.uri);
        const sh = shelf(picks.map((t, i) => songCard(t, () => player.playUris(uris, i))));
        recs.set(sh.el);
        recArrows.replaceChildren(sh.arrows);
      }
    } catch { if (!force) recs.hide(); }
    refresh.disabled = false;
  }
  loadRecs(false);

  sp.loadPlaylists().then(pl => {
    const byId = new Map(pl.map(p => [p.id, p]));
    const ordered = sortedLibrary({ filter: 'playlist' }).map(it => byId.get(it.id)).filter(Boolean);
    if (ordered.length) pl = ordered;
    pl.length ? putShelf(lists, cardShelf(pl.slice(0, 20))) : lists.set(note('note', 'No playlists yet', 'Make one with the + button in the sidebar.'));
  }).catch(e => {
    // Spotify isn't answering: show the playlists from last time instead.
    const kept = keptPlaylists();
    if (kept.length) putShelf(lists, cardShelf(kept.slice(0, 20)));
    else lists.set(note('close', 'Couldn’t load your playlists', e.message));
  });
}

// The playlists the library saved last time, shaped like Spotify's, for when Spotify isn't answering.
function keptPlaylists() {
  return sortedLibrary({ filter: 'playlist' }).filter(it => it.kind === 'playlist').map(it => ({ id: it.id, uri: it.uri, type: 'playlist', name: it.name, images: it.images, owner: { display_name: it.creator } }));
}

// ---- Search ---------------------------------------------------------------------------------
export async function viewSearch(v, ctx, q) {
  ctx.theme({ key: 'search' });
  q = (q || '').trim();
  if (!q) {
    v.append(note('search', 'Search Spotify', 'Type in the box above to find songs, artists, albums, playlists and podcasts.'));
    return;
  }
  v.append(h('div', { class: 'view-head' }, h('h1', null, 'Results for “' + q + '”')));
  const wait = spinner();
  v.append(wait);
  const r = await sp.search(q, 'track,artist,album,playlist,show');
  wait.remove();
  const items = k => ((r && r[k] && r[k].items) || []).filter(Boolean);
  const songs = items('tracks');
  let any = false;

  if (songs.length) {
    any = true;
    const list = trackList({ showCover: true, showAlbum: true });
    list.add(songs);
    const s = section('Songs');
    s.set(list.el);
    let offset = songs.length, total = (r.tracks && r.tracks.total) || 0;
    if (offset < total) {
      const more = pill('More songs', 'down', async () => {
        more.disabled = true;
        try {
          const n = await sp.search(q, 'track', offset);
          const next = ((n && n.tracks && n.tracks.items) || []).filter(Boolean);
          list.add(next);
          offset += next.length || 10;
          if (!next.length || offset >= total || offset >= 100) more.remove();
        } catch (e) { toast(e.message, { error: true }); }
        more.disabled = false;
      }, 'ghost center');
      s.el.append(more);
    }
    v.append(s.el);
  }
  for (const [key, title] of [['artists', 'Artists'], ['albums', 'Albums'], ['playlists', 'Playlists'], ['shows', 'Podcasts']]) {
    const list = items(key);
    if (!list.length) continue;
    any = true;
    const s = section(title);
    s.set(grid(list, 'one-row'));
    v.append(s.el);
  }
  if (!any) v.append(note('search', 'Nothing found', 'Try a different spelling or fewer words.'));
}

// ---- Liked Songs ----------------------------------------------------------------------------
export async function viewLiked(v, ctx) {
  ctx.theme({ key: 'liked' });
  const first = await sp.liked(0);
  const total = (first && first.total) || 0;
  const collection = session.me ? `spotify:user:${session.me.id}:collection` : null;
  const list = trackList({
    showCover: true, showAlbum: true,
    play: async (i, t) => {
      // Liked Songs has no official "play from here" address, so try it and fall back to a plain list.
      const ok = collection ? await player.playContext(collection, t.uri, true) : false;
      if (!ok) player.playUris(list.tracks.map(x => x.uri), i);
    },
    menu: (t, i, rowEl) => ({ liked: true, onUnliked: () => rowEl.remove() }),
  });
  v.append(hero({
    kind: 'Playlist', title: 'Liked Songs', iconName: 'heartFill', images: [],
    lines: [plural(total, 'song')],
    actions: [playBig(() => list.playRow(0))],
  }));
  v.firstChild.classList.add('liked-hero');
  if (!total) { v.append(note('heart', 'Songs you like will show up here', 'Use the heart in the player bar or the menu on any song.')); return; }
  v.append(list.el);
  let offset = 0;
  const take = page => { const items = (page && page.items) || []; list.add(items.map(x => x && x.track)); offset += items.length; return !!(page && page.next) && items.length > 0; };
  if (take(first)) infinite(ctx.scroller, v, async () => take(await sp.liked(offset)));
}

// ---- Playlist -------------------------------------------------------------------------------
export async function viewPlaylist(v, ctx, id) {
  const p = await sp.playlist(id);
  ctx.theme({ image: pickImg(p.images, 300), key: 'playlists' });
  const mine = !!(p.owner && session.me && p.owner.id === session.me.id);
  const total = (p.items && p.items.total) != null ? p.items.total : (p.tracks && p.tracks.total);
  const list = trackList({
    showCover: true, showAlbum: true,
    play: (i, t) => player.playContext(p.uri, t.uri),
    menu: (t, i, rowEl) => (mine || p.collaborative ? {
      remove: async () => {
        try { await sp.removeFromPlaylist(p.id, [t.uri]); rowEl.remove(); toast('Removed from ' + p.name); bus.emit('playlist-changed', p.id); }
        catch (e) { toast(e.message, { error: true }); }
      },
    } : {}),
  });
  const menu = () => [
    mine ? { label: 'Rename', icon: 'settings', onClick: async () => {
      const name = await ask('Rename playlist', 'Playlist name', p.name);
      if (!name || name === p.name) return;
      try { await sp.editPlaylist(p.id, { name }); await sp.loadPlaylists(true); bus.emit('playlists-changed'); bus.emit('playlist-changed', p.id); bus.emit('rerender'); }
      catch (e) { toast(e.message, { error: true }); }
    } } : null,
    mine ? { label: 'Delete playlist', icon: 'close', danger: true, onClick: async () => {
      if (!await confirmBox('Delete “' + p.name + '”?', 'This removes the playlist from your Spotify library.', 'Delete', true)) return;
      try { await sp.unsave([p.uri]); await sp.loadPlaylists(true); bus.emit('playlists-changed'); navigate('#/'); toast('Playlist deleted'); }
      catch (e) { toast(e.message, { error: true }); }
    } } : null,
    openInSpotify(p),
  ];
  const save = mine ? null : toggleSave(p.uri, ['Save', 'Saved']);
  if (save) save.addEventListener('click', () => setTimeout(() => sp.loadPlaylists(true).then(() => bus.emit('playlists-changed')).catch(() => {}), 900));
  v.append(hero({
    kind: p.collaborative ? 'Collaborative playlist' : 'Playlist', title: p.name, images: p.images,
    lines: [plainText(p.description), [p.owner && p.owner.display_name ? 'By ' + p.owner.display_name : null, total != null ? plural(total, 'song') : null].filter(Boolean).join(' · ')],
    actions: [playBig(() => player.playContext(p.uri)), save, moreBtn(menu)],
  }));

  let first;
  try { first = await sp.playlistItems(id, 0); }
  catch (e) {
    if (e.status === 403 || e.status === 404) {
      v.append(note('note', 'Song list not available', 'Spotify only shares the song list of playlists you own with outside apps. You can still play this one with the play button.'));
      return;
    }
    throw e;
  }
  if (!first.items || !first.items.length) { v.append(note('note', 'This playlist is empty', 'Add songs from the menu on any song.')); return; }
  v.append(list.el);
  let offset = 0;
  const take = page => { const items = (page && page.items) || []; list.add(items.map(x => x && (x.item || x.track))); offset += items.length; return !!(page && page.next) && items.length > 0; };
  if (take(first)) infinite(ctx.scroller, v, async () => take(await sp.playlistItems(id, offset)));
  if (mine || p.collaborative) addPlaylistRecs(v, ctx, p, list);
}

// Suggestions under your own playlists, loaded when you scroll down to them.
function addPlaylistRecs(v, ctx, p, list) {
  const refresh = pill('Refresh', null, () => load(true), 'ghost sm');
  const sec = section('Recommended', refresh);
  sec.el.classList.add('recs');
  sec.el.insertBefore(h('div', { class: 'section-sub' }, 'Based on the artists in this playlist. Picked by ' + APP_NAME + ' using Spotify search.'), sec.body);
  sec.set(spinner());
  v.append(sec.el);
  async function load(force) {
    refresh.disabled = true;
    sec.set(spinner());
    try {
      const picks = await playlistRecs(p.id, list.tracks, force);
      if (!picks.length) sec.set(note('note', 'No suggestions right now', 'Add a few more songs, then press Refresh.'));
      else {
        const recs = trackList({
          showCover: true, showAlbum: true,
          extra: t => h('button', { class: 'pill ghost sm', title: 'Add to ' + p.name, onclick: async e => {
            const btn = e.currentTarget, row = btn.closest('.trow');
            btn.disabled = true;
            try { await sp.addToPlaylist(p.id, [t.uri]); row.remove(); list.add([t]); toast('Added to ' + p.name); bus.emit('playlist-changed', p.id); }
            catch (err) { btn.disabled = false; toast(err.status === 403 ? 'Spotify wouldn\u2019t let this app change that playlist.' : err.message, { error: true }); }
          } }, 'Add'),
        });
        recs.add(picks);
        sec.set(recs.el);
      }
    } catch (e) { sec.set(note('close', 'Couldn\u2019t load suggestions', e.message)); }
    refresh.disabled = false;
  }
  let started = false;
  const io = new IntersectionObserver(entries => {
    if (started || !entries.some(e => e.isIntersecting)) return;
    started = true; io.disconnect(); load(false);
  }, { root: ctx.scroller, rootMargin: '200px 0px' });
  io.observe(sec.el);
}

// ---- Album ----------------------------------------------------------------------------------
export async function viewAlbum(v, ctx, id) {
  const a = await sp.album(id);
  ctx.theme({ image: pickImg(a.images, 300), key: 'albums' });
  const slim = { id: a.id, name: a.name, uri: a.uri, images: a.images };
  const list = trackList({ albumNumbers: true, play: (i, t) => player.playContext(a.uri, t.uri) });
  const withAlbum = items => (items || []).filter(Boolean).map(t => ({ ...t, album: slim }));
  const firstItems = (a.tracks && a.tracks.items) || [];
  const total = a.total_tracks || (a.tracks && a.tracks.total) || firstItems.length;
  const length = firstItems.reduce((s, t) => s + (t.duration_ms || 0), 0);
  const kind = a.album_type === 'single' ? 'Single' : a.album_type === 'compilation' ? 'Compilation' : 'Album';
  v.append(hero({
    kind, title: a.name, images: a.images, iconName: 'disc',
    lines: [h('span', null, artistLinks(a.artists), ' · ' + [year(a.release_date), plural(total, 'song'), firstItems.length >= total && length ? fmtLong(length) : null].filter(Boolean).join(' · '))],
    actions: [playBig(() => player.playContext(a.uri)), toggleSave(a.uri), moreBtn(() => [
      { label: 'Add album to queue', icon: 'queue', onClick: async () => { for (const t of list.tracks.slice(0, 30)) await player.addToQueue(t.uri); } },
      openInSpotify(a),
    ])],
  }));
  v.append(list.el);
  list.add(withAlbum(firstItems));
  let offset = firstItems.length;
  if (a.tracks && a.tracks.next && offset) {
    infinite(ctx.scroller, v, async () => { const p = await sp.albumTracks(id, offset); const items = (p && p.items) || []; list.add(withAlbum(items)); offset += items.length; return !!(p && p.next) && items.length > 0; });
  }
  const c = a.copyrights && a.copyrights[0] && a.copyrights[0].text;
  if (c) v.append(h('div', { class: 'fine' }, c));
}

// ---- Artist ---------------------------------------------------------------------------------
export async function viewArtist(v, ctx, id) {
  const a = await sp.artist(id);
  ctx.theme({ image: pickImg(a.images, 300), key: 'artists' });
  v.append(hero({
    kind: 'Artist', title: a.name, images: a.images, round: true, iconName: 'user',
    lines: [(a.genres || []).slice(0, 3).join(' · ')],
    actions: [playBig(() => player.playContext(a.uri)), toggleSave(a.uri, ['Follow', 'Following']), moreBtn(() => [openInSpotify(a)])],
  }));
  for (const [group, title] of [['album', 'Albums'], ['single', 'Singles and EPs']]) {
    const s = section(title);
    v.append(s.el);
    sp.artistAlbums(id, group).then(r => {
      const items = ((r && r.items) || []).filter(Boolean);
      if (!items.length) return s.hide();
      const g = grid(items);
      s.set(g);
      let offset = items.length;
      if (r.next) {
        const more = pill('Show more', 'down', async () => {
          more.disabled = true;
          try {
            const n = await sp.artistAlbums(id, group, offset);
            const next = ((n && n.items) || []).filter(Boolean);
            g.append(...grid(next).children);
            offset += next.length;
            if (!n.next || !next.length) more.remove();
          } catch (e) { toast(e.message, { error: true }); }
          more.disabled = false;
        }, 'ghost center');
        s.el.append(more);
      }
    }).catch(() => s.hide());
  }
}

// ---- Podcast --------------------------------------------------------------------------------
export async function viewShow(v, ctx, id) {
  const s = await sp.show(id);
  ctx.theme({ image: pickImg(s.images, 300), key: 'podcasts' });
  const slimShow = { id: s.id, name: s.name, uri: s.uri, images: s.images };
  const list = trackList({ showCover: true });
  const prep = items => (items || []).filter(Boolean).map(e => ({ ...e, type: 'episode', show: slimShow, images: e.images && e.images.length ? e.images : s.images }));
  v.append(hero({
    kind: 'Podcast', title: s.name, images: s.images, iconName: 'mic',
    lines: [plainText(s.description).slice(0, 220), s.total_episodes ? plural(s.total_episodes, 'episode') : null],
    actions: [playBig(() => list.playRow(0)), toggleSave(s.uri, ['Follow', 'Following']), moreBtn(() => [openInSpotify(s)])],
  }));
  v.append(list.el);
  const firstItems = (s.episodes && s.episodes.items) || [];
  list.add(prep(firstItems));
  let offset = firstItems.length;
  if (s.episodes && s.episodes.next && offset) {
    infinite(ctx.scroller, v, async () => { const p = await sp.showEpisodes(id, offset); const items = (p && p.items) || []; list.add(prep(items)); offset += items.length; return !!(p && p.next) && items.length > 0; });
  }
  if (!firstItems.length) v.append(note('mic', 'No episodes to show'));
}

// ---- Library --------------------------------------------------------------------------------
const TABS = [['playlists', 'Playlists'], ['albums', 'Albums'], ['artists', 'Artists'], ['podcasts', 'Podcasts']];
export async function viewLibrary(v, ctx, kind = 'playlists') {
  ctx.theme({ key: kind });
  v.append(h('div', { class: 'view-head' }, h('h1', null, 'Your Library'),
    h('div', { class: 'tabs', role: 'tablist' }, TABS.map(([k, label]) => h('a', { class: 'tab' + (k === kind ? ' on' : ''), href: '#/library/' + k, role: 'tab', 'aria-selected': String(k === kind) }, label)))));
  const g = h('div', { class: 'grid' });
  const wait = spinner();
  v.append(g, wait);
  const empty = (iconName, text) => { if (!g.children.length) v.append(note(iconName, 'Nothing here yet', text)); };
  const addCards = items => g.append(...grid(items).children);

  if (kind === 'playlists') {
    let pl;
    try { pl = await sp.loadPlaylists(); }
    catch (e) {
      pl = keptPlaylists();
      if (!pl.length) throw e;
      v.insertBefore(h('p', { class: 'kept-note' }, 'Spotify isn\u2019t answering right now, so these are your playlists from last time.'), g);
    }
    addCards(pl);
    wait.remove();
    return empty('note', 'Playlists you make or save will show up here.');
  }
  if (kind === 'artists') {
    let after;
    const take = r => { const a = (r && r.artists) || {}; addCards(a.items || []); after = a.cursors && a.cursors.after; return !!(a.next && after); };
    const more = take(await sp.followedArtists());
    wait.remove();
    if (more) infinite(ctx.scroller, v, async () => take(await sp.followedArtists(after)));
    return empty('user', 'Artists you follow will show up here.');
  }
  const [load, key, iconName, text] = kind === 'albums'
    ? [sp.savedAlbums, 'album', 'disc', 'Albums you save will show up here.']
    : [sp.savedShows, 'show', 'mic', 'Podcasts you follow will show up here.'];
  let offset = 0;
  const take = page => { const items = (page && page.items) || []; addCards(items.map(x => x && x[key] && { ...x[key], type: key })); offset += items.length; return !!(page && page.next) && items.length > 0; };
  const more = take(await load(0));
  wait.remove();
  if (more) infinite(ctx.scroller, v, async () => take(await load(offset)));
  empty(iconName, text);
}

// ---- Local Files ----------------------------------------------------------------------------
export async function viewLocal(v, ctx) {
  ctx.theme({ key: 'local' });
  v.append(spinner());
  await loadLocal();
  let shown = [];
  const count = h('span', null, '');
  const host = h('div', { class: 'local-list' });
  const filter = h('input', { class: 'search', type: 'search', placeholder: 'Filter these songs', 'aria-label': 'Filter these songs', spellcheck: false, autocomplete: 'off' });
  const menu = t => [
    { label: 'Play', icon: 'play', onClick: () => playLocal(shown, shown.indexOf(t)) },
    { label: 'Play next', icon: 'queue', onClick: () => queueLocal(t) },
    { sep: true },
    { header: t.file.p },
  ];
  const rescan = async () => { toast('Looking through your music folders…'); await loadLocal(true); paint(); toast(plural(local.tracks.length, 'song') + ' found'); };
  const rescanBtn = () => h('button', { class: 'pill ghost', onclick: rescan }, icon('repeat', 16), h('span', null, 'Rescan'));

  function paint() {
    const places = local.roots.length ? local.roots.join(' · ') : 'your Music folder';
    if (local.error) { count.textContent = ''; host.replaceChildren(note('folder', 'Local Files aren’t available right now', local.error, rescanBtn())); return; }
    if (!local.tracks.length) {
      count.textContent = 'No songs yet';
      host.replaceChildren(note('folder', 'No music files found', 'Glasswave looked in: ' + places + '. Put MP3, M4A, FLAC, WAV or OGG files there, or list more folders in “Local folders.txt” inside the Glasswave folder.', rescanBtn()));
      return;
    }
    const q = filter.value.trim().toLowerCase();
    shown = !q ? local.tracks : local.tracks.filter(t => (t.name + ' ' + t.file.artist + ' ' + t.album.name + ' ' + t.file.base).toLowerCase().includes(q));
    count.textContent = (q ? shown.length + ' of ' : '') + plural(local.tracks.length, 'song') + (local.more ? ' (the first ' + local.tracks.length + ')' : '');
    if (!shown.length) { host.replaceChildren(note('search', 'Nothing matches', 'Try a different word.')); return; }
    const list = trackList({ showAlbum: true, play: i => playLocal(shown, i), items: menu });
    let at = 0;
    const more = () => { list.add(shown.slice(at, at + 300)); at += 300; return at < shown.length; };
    host.replaceChildren(list.el);
    if (more()) infinite(ctx.scroller, host, async () => more());
  }
  filter.addEventListener('input', debounce(paint, 160));
  v.replaceChildren(hero({
    kind: 'On this computer', title: 'Local Files', iconName: 'folder', images: [],
    lines: [count, h('span', { class: 'local-where', title: local.roots.join('\n') }, local.roots.length ? 'From ' + local.roots.join(' · ') : '')],
    actions: [playBig(() => { if (shown.length) playLocal(shown, 0); }), h('label', { class: 'search-wrap local-filter' }, icon('search', 18), filter), rescanBtn()],
  }), host);
  v.firstChild.classList.add('local-hero');
  paint();
  // Titles, artists and lengths are read from the files a little at a time; fill them in as they arrive.
  bus.on('local-meta', t => {
    if (!host.isConnected) return;
    for (const r of host.querySelectorAll('.trow[data-uri="' + CSS.escape(t.uri) + '"]')) {
      r.querySelector('.tn').textContent = t.name;
      r.querySelector('.tsub').textContent = (t.artists[0] && t.artists[0].name) || '';
      const al = r.querySelector('.talbum'); if (al) al.textContent = t.album.name || '';
      r.querySelector('.tdur').textContent = t.duration_ms ? fmtTime(t.duration_ms) : '';
    }
  });
  bus.on('local-sorted', () => { if (host.isConnected) paint(); });
  indexLocal(true);
}
