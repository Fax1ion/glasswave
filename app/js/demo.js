// Demo mode: made-up artists and songs so the app can be explored (and tested)
// without a Spotify account. Open the app with ?demo to use it. No audio plays.

import { ApiError, sleep } from './util.js';

function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}
const R = rng(20261113);
const int = n => Math.floor(R() * n);

function art(seed) {
  const r = rng(seed * 7919 + 13);
  const h1 = Math.floor(r() * 360), h2 = (h1 + 40 + Math.floor(r() * 120)) % 360;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 300"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${h1} 82% 60%)"/><stop offset="1" stop-color="hsl(${h2} 78% 30%)"/></linearGradient></defs><rect width="300" height="300" fill="url(#g)"/><circle cx="${Math.round(60 + r() * 180)}" cy="${Math.round(60 + r() * 180)}" r="${Math.round(50 + r() * 70)}" fill="hsl(${(h1 + 180) % 360} 90% 70%)" opacity=".35"/><circle cx="${Math.round(r() * 300)}" cy="${Math.round(r() * 300)}" r="${Math.round(30 + r() * 60)}" fill="#fff" opacity=".18"/></svg>`;
  return [{ url: 'data:image/svg+xml,' + encodeURIComponent(svg), width: 300, height: 300 }];
}
const ext = { spotify: 'https://open.spotify.com/' };

const ARTIST_NAMES = ['Neon Harbor', 'Vela Sundae', 'Kite & Ash', 'Marlowe Drift', 'Odessa Bloom', 'The Quiet Arcade', 'Juno Vale', 'Static Orchard', 'Lumen Parade', 'Tidewater Kids'];
const A1 = ['Midnight', 'Paper', 'Violet', 'Slow', 'Electric', 'Golden', 'Hollow', 'Northern', 'Velvet', 'Silver'];
const A2 = ['Gardens', 'Signals', 'Weather', 'Rooms', 'Motion', 'Harbor', 'Echoes', 'Season', 'Arcade', 'Tides'];
const T1 = ['Falling', 'Chasing', 'Waking', 'Holding', 'Burning', 'Drifting', 'Counting', 'Painting', 'Leaving', 'Dancing'];
const T2 = ['Daylight', 'Static', 'Rivers', 'Shadows', 'Satellites', 'Neon', 'Summer', 'Glass', 'Thunder', 'Cities'];
const GENRES = ['indie pop', 'dream pop', 'synthwave', 'alt r&b', 'lo-fi', 'electronic', 'bedroom pop'];

const artists = [], albums = [], tracks = [], byUri = new Map();
ARTIST_NAMES.forEach((name, i) => {
  const a = { id: 'ar' + i, name, type: 'artist', uri: 'spotify:artist:ar' + i, images: art(100 + i), genres: [GENRES[i % GENRES.length], GENRES[(i + 3) % GENRES.length]], external_urls: ext };
  artists.push(a);
  for (let j = 0; j < 3; j++) {
    const single = j === 2;
    const id = `al${i}_${j}`;
    const simple = { id, name: `${A1[(i + j * 3) % 10]} ${A2[(i * 3 + j) % 10]}`, type: 'album', album_type: single ? 'single' : 'album', uri: 'spotify:album:' + id, images: art(1000 + i * 10 + j), artists: [{ id: a.id, name: a.name, uri: a.uri, type: 'artist' }], release_date: `${2019 + ((i + j * 2) % 8)}-0${1 + ((i + j) % 9)}-1${j}`, external_urls: ext };
    const n = single ? 2 : 8 + int(4);
    const list = [];
    for (let k = 0; k < n; k++) {
      const tid = `${id}_${k}`;
      const t = { id: tid, name: `${T1[(i + k + j) % 10]} ${T2[(i * 2 + k * 3 + j) % 10]}`, type: 'track', uri: 'spotify:track:' + tid, duration_ms: 150000 + int(120000), explicit: int(9) === 0, track_number: k + 1, artists: simple.artists, album: simple, external_urls: ext, is_playable: true };
      list.push(t); tracks.push(t); byUri.set(t.uri, t);
    }
    albums.push({ ...simple, total_tracks: n, _tracks: list });
  }
});

const shows = ['Deep Focus Radio', 'Small Hours'].map((name, i) => {
  const id = 'sh' + i;
  const s = { id, name, type: 'show', uri: 'spotify:show:' + id, images: art(5000 + i), description: 'A made-up podcast for the demo.', external_urls: ext };
  s._episodes = Array.from({ length: 12 }, (_, k) => {
    const e = { id: `${id}_e${k}`, name: `Episode ${12 - k}: ${T1[(k + i) % 10]} ${T2[(k * 2 + i) % 10]}`, type: 'episode', uri: `spotify:episode:${id}_e${k}`, duration_ms: 1200000 + int(1800000), images: s.images, release_date: `2026-${String(11 - (k % 10)).padStart(2, '0')}-0${1 + (k % 9)}`, description: 'Demo episode.', show: { id, name, uri: s.uri }, external_urls: ext, is_playable: true };
    byUri.set(e.uri, e);
    return e;
  });
  return s;
});

const me = { id: 'demo', display_name: 'Demo Listener', images: [], uri: 'spotify:user:demo', type: 'user' };
const shuffled = (arr, seed) => { const r = rng(seed), a = arr.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const PL_NAMES = ['Late Night Drive', 'Focus Glass', 'Rainy Window', 'Gym Surge', 'Sunday Slow', 'Pixel Dreams', 'Road Trip 26', 'Chill Coding', 'Fresh Finds Weekly'];
const playlists = PL_NAMES.map((name, i) => {
  const other = i === PL_NAMES.length - 1;
  return { id: 'pl' + i, name, description: other ? 'An editor-made mix (track list hidden, like real ones).' : 'Demo playlist &amp; friends', type: 'playlist', uri: 'spotify:playlist:pl' + i, images: art(3000 + i), owner: other ? { id: 'curator', display_name: 'Curator' } : { id: me.id, display_name: me.display_name }, collaborative: false, public: false, external_urls: ext, _tracks: shuffled(tracks, 77 + i).slice(0, other ? 40 : 14 + i * 9) };
});
let liked = shuffled(tracks, 5).slice(0, 130);
const saved = new Set([...liked.map(t => t.uri), ...albums.filter((_, i) => i % 4 === 0).map(a => a.uri), ...artists.filter((_, i) => i % 2 === 0).map(a => a.uri), shows[0].uri, ...playlists.map(p => p.uri)]);

const plView = p => ({ ...p, _tracks: undefined, items: { total: p._tracks.length }, tracks: { total: p._tracks.length } });
const albumView = a => ({ ...a, _tracks: undefined });
const showView = s => ({ ...s, _episodes: undefined, total_episodes: s._episodes.length });
function page(arr, q = {}, wrap = x => x) {
  const offset = Number(q.offset) || 0, limit = Number(q.limit) || 20;
  return { items: arr.slice(offset, offset + limit).map(wrap), total: arr.length, offset, limit, next: offset + limit < arr.length ? 'more' : null };
}
const find = (arr, id) => { const o = arr.find(x => x.id === id); if (!o) throw new ApiError(404, 'Not found'); return o; };
const date = i => new Date(Date.UTC(2026, 10, 12) - i * 864e5).toISOString();

export async function demoApi(method, path, { query = {}, body } = {}) {
  await sleep(40 + Math.random() * 90);
  let m;
  const is = (meth, re) => method === meth && (m = path.match(re));

  if (is('GET', /^\/me$/)) return me;
  if (is('GET', /^\/me\/playlists$/)) return page(playlists.filter(p => saved.has(p.uri)), query, plView);
  if (is('POST', /^\/me\/playlists$/)) {
    const id = 'pl' + Date.now();
    const p = { id, name: body.name, description: body.description || '', type: 'playlist', uri: 'spotify:playlist:' + id, images: [], owner: { id: me.id, display_name: me.display_name }, collaborative: false, public: false, external_urls: ext, _tracks: [] };
    playlists.unshift(p); saved.add(p.uri);
    return plView(p);
  }
  if (is('GET', /^\/playlists\/([^/]+)$/)) return plView(find(playlists, m[1]));
  if (is('PUT', /^\/playlists\/([^/]+)$/)) { Object.assign(find(playlists, m[1]), body); return null; }
  if (is('GET', /^\/playlists\/([^/]+)\/items$/)) {
    const p = find(playlists, m[1]);
    if (p.owner.id !== me.id) throw new ApiError(403, 'Forbidden');
    return page(p._tracks, query, (t) => ({ added_at: date(3), is_local: false, item: t }));
  }
  if (is('POST', /^\/playlists\/([^/]+)\/items$/)) { const p = find(playlists, m[1]); for (const u of body.uris) if (byUri.has(u)) p._tracks.push(byUri.get(u)); return { snapshot_id: 'demo' }; }
  if (is('DELETE', /^\/playlists\/([^/]+)\/items$/)) { const p = find(playlists, m[1]); const gone = new Set(body.items.map(i => i.uri)); p._tracks = p._tracks.filter(t => !gone.has(t.uri)); return { snapshot_id: 'demo' }; }

  if (is('GET', /^\/me\/tracks$/)) return page(liked, query, (t) => ({ added_at: date(1), track: t }));
  if (is('GET', /^\/me\/albums$/)) return page(albums.filter(a => saved.has(a.uri)), query, a => ({ added_at: date(2), album: albumView(a) }));
  if (is('GET', /^\/me\/shows$/)) return page(shows.filter(s => saved.has(s.uri)), query, s => ({ added_at: date(2), show: showView(s) }));
  if (is('GET', /^\/me\/following$/)) { const items = artists.filter(a => saved.has(a.uri)); return { artists: { items, total: items.length, next: null, cursors: { after: null } } }; }
  if (is('GET', /^\/me\/library\/contains$/)) return String(query.uris || '').split(',').map(u => saved.has(u));
  if (is('PUT', /^\/me\/library$/)) { for (const u of String(query.uris).split(',')) { saved.add(u); const t = byUri.get(u); if (t && t.type === 'track' && !liked.includes(t)) liked.unshift(t); } return null; }
  if (is('DELETE', /^\/me\/library$/)) { for (const u of String(query.uris).split(',')) { saved.delete(u); liked = liked.filter(t => t.uri !== u); } return null; }

  if (is('GET', /^\/albums\/([^/]+)$/)) { const a = find(albums, m[1]); return { ...albumView(a), tracks: page(a._tracks.map(t => ({ ...t, album: undefined })), { limit: 50 }) }; }
  if (is('GET', /^\/albums\/([^/]+)\/tracks$/)) return page(find(albums, m[1])._tracks.map(t => ({ ...t, album: undefined })), query);
  if (is('GET', /^\/artists\/([^/]+)$/)) return find(artists, m[1]);
  if (is('GET', /^\/artists\/([^/]+)\/albums$/)) { const g = String(query.include_groups || 'album,single').split(','); return page(albums.filter(a => a.artists[0].id === m[1] && g.includes(a.album_type)), query, albumView); }
  if (is('GET', /^\/shows\/([^/]+)$/)) { const s = find(shows, m[1]); return { ...showView(s), episodes: page(s._episodes, { limit: 50 }) }; }
  if (is('GET', /^\/shows\/([^/]+)\/episodes$/)) return page(find(shows, m[1])._episodes, query);

  if (is('GET', /^\/search$/)) {
    const q = String(query.q || '').toLowerCase(), types = String(query.type || '').split(',');
    const genre = (q.match(/genre:"([^"]+)"/) || [])[1], by = (q.match(/artist:"([^"]+)"/) || [])[1];
    const f = arr => arr.filter(x => {
      if (genre) return x.type === 'track' && (artists.find(a => a.id === x.artists[0].id).genres || []).includes(genre);
      if (by) return (x.artists || []).some(a => a.name.toLowerCase() === by);
      return x.name.toLowerCase().includes(q) || (x.artists || []).some(a => a.name.toLowerCase().includes(q));
    });
    const out = {};
    if (types.includes('track')) out.tracks = page(f(tracks), query);
    if (types.includes('artist')) out.artists = page(f(artists), query);
    if (types.includes('album')) out.albums = page(f(albums), query, albumView);
    if (types.includes('playlist')) out.playlists = page(f(playlists), query, plView);
    if (types.includes('show')) out.shows = page(f(shows), query, showView);
    return out;
  }
  if (is('GET', /^\/me\/top\/tracks$/)) return page(shuffled(tracks, 9), query);
  if (is('GET', /^\/me\/top\/artists$/)) return page(shuffled(artists, 11), query);
  if (is('GET', /^\/me\/player\/recently-played$/)) return { items: shuffled(tracks, 21).slice(0, 30).map((t, i) => ({ track: t, played_at: date(i / 10), context: { type: 'album', uri: t.album.uri } })) };
  throw new ApiError(404, 'Demo mode has no answer for ' + method + ' ' + path);
}

// ---- pretend player ---------------------------------------------------------------
let S = null, emit = () => {}, endTimer = null;
const sim = { list: [], idx: 0, extra: [], context: null };
const DEVICES = [
  { id: 'demo-local', name: 'This computer', type: 'Computer' },
  { id: 'demo-speaker', name: 'Living Room Speaker', type: 'Speaker' },
  { id: 'demo-phone', name: 'Phone', type: 'Smartphone' },
];
const now = () => (S.paused ? S.position : Math.min(S.duration, S.position + (Date.now() - S.ts)));

function contextTracks(uri) {
  const [, kind, id, tail] = uri.split(':');
  if (kind === 'album') return find(albums, id)._tracks;
  if (kind === 'playlist') return find(playlists, id)._tracks;
  if (kind === 'artist') return tracks.filter(t => t.artists[0].id === id);
  if (kind === 'show') return find(shows, id)._episodes;
  if (kind === 'user' && tail === 'collection') return liked;
  return [];
}
function start(list, idx, context) {
  if (!list.length) return false;
  sim.list = S.shuffle && context ? shuffled(list, Date.now() % 1e6) : list.slice();
  sim.idx = S.shuffle && context ? 0 : Math.max(0, idx);
  sim.context = context || null;
  load(true);
  return true;
}
function load(playing) {
  const t = sim.list[sim.idx];
  S.track = t ? { ...t, images: t.album ? t.album.images : t.images } : null;
  S.duration = t ? t.duration_ms : 0;
  S.position = 0; S.ts = Date.now(); S.paused = !playing || !t; S.contextUri = sim.context;
  arm(); emit();
}
function arm() {
  clearTimeout(endTimer);
  if (!S.paused && S.track) endTimer = setTimeout(() => demoBackend.next(true), Math.max(200, S.duration - now()));
}

export const demoBackend = {
  init(state, emitFn) {
    S = state; emit = emitFn;
    S.ready = true; S.localId = 'demo-local'; S.isLocal = true; S.device = { ...DEVICES[0] };
    sim.list = shuffled(tracks, 3).slice(0, 12); sim.idx = 0; load(false);
  },
  playContext(uri, offset) {
    const list = contextTracks(uri);
    let idx = 0;
    if (typeof offset === 'number') idx = offset;
    else if (offset) { idx = list.findIndex(t => t.uri === offset); if (idx < 0) idx = 0; }
    return start(list, idx, uri);
  },
  playUris(uris, index = 0) { return start(uris.map(u => byUri.get(u)).filter(Boolean), index, null); },
  toggle() { if (!S.track) return; S.position = now(); S.ts = Date.now(); S.paused = !S.paused; arm(); emit(); },
  next(auto) {
    if (auto && S.repeat === 'track') return load(true);
    if (sim.extra.length) { sim.list.splice(sim.idx + 1, 0, sim.extra.shift()); }
    if (sim.idx + 1 < sim.list.length) { sim.idx++; load(true); }
    else if (S.repeat === 'context') { sim.idx = 0; load(true); }
    else { S.position = 0; S.ts = Date.now(); S.paused = true; arm(); emit(); }
  },
  prev() { if (now() > 3000 || sim.idx === 0) { S.position = 0; S.ts = Date.now(); arm(); emit(); } else { sim.idx--; load(true); } },
  seek(ms) { S.position = ms; S.ts = Date.now(); arm(); emit(); },
  setVolume() {},
  setShuffle(b) { S.shuffle = b; emit(); },
  setRepeat(mode) { S.repeat = mode; emit(); },
  devices() { return DEVICES.map(d => ({ ...d, is_active: d.id === S.device.id })); },
  transfer(id) { const d = DEVICES.find(x => x.id === id); if (!d) return; S.device = { ...d }; S.isLocal = id === 'demo-local'; emit(); },
  queue() { return { currently_playing: sim.list[sim.idx] || null, queue: [...sim.extra, ...sim.list.slice(sim.idx + 1)].slice(0, 30) }; },
  addToQueue(uri) { const t = byUri.get(uri); if (t) sim.extra.push(t); return !!t; },
};
