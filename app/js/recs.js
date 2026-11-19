// Recommendations, made by Glasswave itself.
// Spotify's own recommendation feed is not open to outside apps, so this builds
// picks from what is allowed: the genres of artists you listen to (looked up
// through Spotify search), plus more songs by those artists, minus what you
// already have.

import { sp, session } from './api.js';
import { store, pickImg } from './util.js';

const today = () => new Date().toISOString().slice(0, 10);
function hash(str) { let x = 2166136261; for (let i = 0; i < str.length; i++) x = Math.imul(x ^ str.charCodeAt(i), 16777619); return x >>> 0; }
function rng(seed) { let s = seed >>> 0; return () => { s = (s + 0x6D2B79F5) >>> 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function shuffle(arr, rnd) { const a = arr.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
const found = r => ((r && r.tracks && r.tracks.items) || []).filter(t => t && t.uri && t.is_playable !== false);

// Small copies of songs and albums, so a day's picks can be remembered without filling up storage.
const slimImages = images => { const url = pickImg(images, 300); return url ? [{ url, width: 300, height: 300 }] : []; };
export const slimTrack = t => ({
  id: t.id, uri: t.uri, name: t.name, type: 'track', duration_ms: t.duration_ms, explicit: !!t.explicit,
  artists: (t.artists || []).map(a => ({ id: a.id, name: a.name })),
  album: t.album ? { id: t.album.id, name: t.album.name, uri: t.album.uri, images: slimImages(t.album.images) } : null,
  external_urls: t.external_urls,
});
export const slimAlbum = a => ({
  id: a.id, uri: a.uri, name: a.name, type: 'album', album_type: a.album_type, release_date: a.release_date,
  images: slimImages(a.images), artists: (a.artists || []).map(x => ({ id: x.id, name: x.name })),
});

// artists: [{ id, name, genres }] in order of how much you listen to them.
export async function recommend({ artists, exclude, count = 12, salt = '' }) {
  artists = (artists || []).filter(a => a && a.name);
  exclude = exclude || new Set();
  if (!artists.length) return [];
  const rnd = rng(hash(today() + '|' + salt));

  // 1. Your strongest genres, weighted towards the artists you play most.
  const tally = new Map();
  artists.forEach((a, i) => (a.genres || []).forEach(g => tally.set(g, (tally.get(g) || 0) + (artists.length - i))));
  const genres = shuffle([...tally.entries()].sort((x, y) => y[1] - x[1]).slice(0, 6).map(x => x[0]), rnd).slice(0, 3);

  // 2. Ask Spotify search for songs in those genres, and for songs by a few of your artists.
  const jobs = genres.map(async g => {
    const q = `genre:"${g.replace(/"/g, '')}"`;
    const offset = Math.floor(rnd() * 4) * 10;
    let list = found(await sp.search(q, 'track', offset).catch(() => null));
    if (!list.length && offset) list = found(await sp.search(q, 'track', 0).catch(() => null));
    return list;
  });
  const byArtist = shuffle(artists.slice(0, 8), rnd).slice(0, genres.length >= 2 ? 1 : 3);
  for (const a of byArtist) jobs.push(sp.search(`artist:"${a.name.replace(/"/g, '')}"`, 'track', 0).then(found).catch(() => []));
  const pools = (await Promise.all(jobs)).map(list => shuffle(list, rnd));

  // 3. Deal the pools out in turn; skip repeats and anything you already have here.
  //    No more than two songs per artist at first; extra ones only fill gaps at the end.
  const seen = new Set(), perArtist = new Map(), out = [], spare = [];
  for (let i = 0; out.length < count * 2 && pools.some(p => p.length); i++) {
    const t = pools[i % pools.length].shift();
    if (!t) continue;
    const key = (t.name + '|' + ((t.artists && t.artists[0] && t.artists[0].name) || '')).toLowerCase();
    const who = (t.artists && t.artists[0] && (t.artists[0].id || t.artists[0].name)) || '?';
    if (exclude.has(t.uri) || seen.has(key)) continue;
    seen.add(key);
    if ((perArtist.get(who) || 0) >= 2) { spare.push(t); continue; }
    perArtist.set(who, (perArtist.get(who) || 0) + 1);
    out.push(t);
  }
  while (out.length < count + 4 && spare.length) out.push(spare.shift());
  if (!out.length) return [];

  // 4. Leave out songs already in your Liked Songs, unless that would leave too few.
  let fresh = out;
  try {
    const have = await sp.contains(out.map(t => t.uri));
    fresh = out.filter((t, i) => !have[i]);
    if (fresh.length < Math.min(4, out.length)) fresh = out;
  } catch { /* keep them all */ }
  return fresh.slice(0, count).map(slimTrack);
}

// Home: one set of picks per day, remembered on this computer. force = true makes a new set.
export async function homeRecs(topArtists, exclude, force) {
  const me = session.me && session.me.id;
  const saved = store.get('gw.recs', null);
  if (!force && saved && saved.day === today() && saved.me === me && saved.tracks && saved.tracks.length) return saved.tracks;
  const tracks = await recommend({ artists: topArtists, exclude, count: 14, salt: force ? String(Date.now()) : 'home' });
  if (tracks.length) store.set('gw.recs', { day: today(), me, tracks });
  return tracks;
}

// Home: recent releases from the artists you play most. Also remembered for the day.
export async function freshReleases(topArtists) {
  const me = session.me && session.me.id;
  const saved = store.get('gw.fresh', null);
  if (saved && saved.day === today() && saved.me === me) return saved.albums || [];
  const since = new Date(Date.now() - 150 * 864e5).toISOString().slice(0, 10);
  // Singles and albums are asked for separately so an artist's newest single is never crowded out.
  const jobs = [];
  for (const a of (topArtists || []).filter(x => x && x.id).slice(0, 5)) {
    jobs.push(sp.artistAlbums(a.id, 'single', 0, 4).then(r => (r && r.items) || []).catch(() => []));
    jobs.push(sp.artistAlbums(a.id, 'album', 0, 2).then(r => (r && r.items) || []).catch(() => []));
  }
  const lists = await Promise.all(jobs);
  const seen = new Set(), albums = [];
  for (const a of lists.flat()) {
    if (!a || !a.id || seen.has(a.id) || !a.release_date || a.release_date.length < 10 || a.release_date < since) continue;
    seen.add(a.id);
    albums.push(slimAlbum(a));
  }
  albums.sort((x, y) => (x.release_date < y.release_date ? 1 : -1));
  const out = albums.slice(0, 14);
  store.set('gw.fresh', { day: today(), me, albums: out });
  return out;
}

// A playlist's picks, kept while the app is open.
const playlistCache = new Map();
export async function playlistRecs(playlistId, tracks, force) {
  if (!force && playlistCache.has(playlistId)) return playlistCache.get(playlistId);
  const counts = new Map();
  for (const t of tracks.slice(0, 150)) for (const a of (t.artists || []).slice(0, 1)) if (a && a.id) counts.set(a.id, (counts.get(a.id) || 0) + 1);
  const ids = [...counts.entries()].sort((x, y) => y[1] - x[1]).slice(0, 4).map(x => x[0]);
  const artists = (await Promise.all(ids.map(id => sp.artist(id).catch(() => null)))).filter(Boolean);
  const out = await recommend({ artists, exclude: new Set(tracks.map(t => t.uri)), count: 8, salt: playlistId + (force ? Date.now() : '') });
  playlistCache.set(playlistId, out);
  return out;
}
