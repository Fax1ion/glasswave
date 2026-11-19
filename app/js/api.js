// Talks to the Spotify Web API (the 2026 Development Mode set of endpoints).
// Reads are cached for a short time so moving around the app feels instant
// and stays well inside Spotify's request limits.

import { DEMO } from './config.js';
import { getToken, forceRefresh } from './auth.js';
import { ApiError, sleep, clamp, bus, report } from './util.js';
import { demoApi } from './demo.js';

const BASE = 'https://api.spotify.com/v1';
const cache = new Map();                       // key -> { t, p }
export const session = { me: null, playlists: [] };

// When Spotify says "too many requests" it can ask an app to wait a while. During that wait no
// request is sent at all (knocking again only makes the wait longer), and the app says so.
export const limit = { until: 0 };
let strikes = 0;
function waitFor(seconds, path) {
  strikes++;
  // Spotify does not always say how long. Then wait longer each time it happens: 30 s, 1 min, 2 min ... 10 min.
  const s = seconds > 0 ? seconds : Math.min(600, 30 * Math.pow(2, strikes - 1));
  limit.until = Date.now() + s * 1000;
  report('Spotify asked Glasswave to wait ' + (seconds > 0 ? seconds + ' s' : '(no time given; waiting ' + s + ' s)') + ' after ' + path);
  bus.emit('spotify-wait', s);
}
export const waiting = () => Math.max(0, limit.until - Date.now());

export async function api(method, path, opts = {}, attempt = 0) {
  if (DEMO) return demoApi(method, path, opts);
  if (Date.now() < limit.until) throw new ApiError(429, 'Spotify asked Glasswave to wait a little before asking again.', 'waiting');
  const url = new URL(BASE + path);
  const q = opts.query;
  if (q) for (const k in q) if (q[k] !== undefined && q[k] !== null && q[k] !== '') url.searchParams.set(k, q[k]);
  const token = await getToken();
  const init = { method, headers: { Authorization: 'Bearer ' + token } };
  if (opts.body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(opts.body);
  }
  let res;
  try { res = await fetch(url, init); }
  catch { throw new ApiError(0, 'Can’t reach Spotify. Check your internet connection.'); }

  if (res.status === 401 && attempt === 0) {      // token ran out mid-flight: refresh once
    await forceRefresh();
    return api(method, path, opts, 1);
  }
  if (res.status === 429) {                       // asked to slow down
    const asked = Number(res.headers.get('Retry-After')) || 0;
    if (asked <= 8 && attempt < 2) {                // a short wait: wait, then try again
      await sleep(clamp(asked || 1.5, 1, 8) * 1000);
      return api(method, path, opts, attempt + 1);
    }
    waitFor(asked, path);                           // a long wait: stop asking until it is over
    throw new ApiError(429, 'Spotify asked Glasswave to wait a little before asking again.', 'waiting');
  }
  if (res.ok) strikes = 0;
  const text = await res.text();
  let data = null;
  if (text) { try { data = JSON.parse(text); } catch { data = null; } }
  if (!res.ok) {
    const msg = (data && data.error && data.error.message) || res.statusText || '';
    // Spotify has been lowering page sizes; if a limit is refused, retry with a small one.
    if (res.status === 400 && q && q.limit > 10 && /limit/i.test(msg) && attempt < 3) {
      return api(method, path, { ...opts, query: { ...q, limit: 10 } }, 3);
    }
    if (res.status >= 500 || res.status === 403) report('Spotify answered ' + res.status + ' to ' + path + (msg ? ': ' + msg : ''));
    throw new ApiError(res.status, msg, data && data.error && data.error.reason);
  }
  return data;
}

// Cached GET.
export function get(path, query, ttl = 60e3) {
  const key = path + '?' + (query ? new URLSearchParams(clean(query)).toString() : '');
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < ttl) return hit.p;
  const p = api('GET', path, { query });
  cache.set(key, { t: Date.now(), p });
  p.catch(() => cache.delete(key));
  if (cache.size > 400) cache.delete(cache.keys().next().value);
  return p;
}
function clean(q) {
  const o = {};
  for (const k in q) if (q[k] !== undefined && q[k] !== null && q[k] !== '') o[k] = q[k];
  return o;
}
export function invalidate(...prefixes) {
  for (const k of [...cache.keys()]) if (prefixes.some(p => k.startsWith(p))) cache.delete(k);
}

const chunks = (arr, n) => { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; };
const LIB = ['/me/library', '/me/tracks', '/me/albums', '/me/following', '/me/shows', '/me/playlists'];

export const sp = {
  me: () => get('/me', null, 36e5),

  // ---- playlists
  async loadPlaylists(force) {
    if (force) invalidate('/me/playlists');
    const out = [];
    let offset = 0;
    for (let i = 0; i < 10; i++) {
      const page = await get('/me/playlists', { limit: 50, offset }, 5 * 60e3);
      const items = (page && page.items) || [];
      out.push(...items.filter(Boolean));
      offset += items.length;
      if (!page || !page.next || !items.length) break;
    }
    session.playlists = out;
    return out;
  },
  playlist: id => get('/playlists/' + id, null, 60e3),
  playlistItems: (id, offset = 0) => get(`/playlists/${id}/items`, { limit: 50, offset, additional_types: 'track,episode' }, 60e3),
  async addToPlaylist(id, uris) {
    const r = await api('POST', `/playlists/${id}/items`, { body: { uris } });
    invalidate('/playlists/' + id, '/me/playlists');
    return r;
  },
  async removeFromPlaylist(id, uris) {
    const r = await api('DELETE', `/playlists/${id}/items`, { body: { items: uris.map(uri => ({ uri })) } });
    invalidate('/playlists/' + id, '/me/playlists');
    return r;
  },
  async createPlaylist(name, description = '') {
    const r = await api('POST', '/me/playlists', { body: { name, description, public: false } });
    invalidate('/me/playlists');
    return r;
  },
  async editPlaylist(id, fields) {
    await api('PUT', '/playlists/' + id, { body: fields });
    invalidate('/playlists/' + id, '/me/playlists');
  },

  // ---- your library
  liked: (offset = 0) => get('/me/tracks', { limit: 50, offset }, 60e3),
  savedAlbums: (offset = 0) => get('/me/albums', { limit: 50, offset }, 120e3),
  followedArtists: after => get('/me/following', { type: 'artist', limit: 50, after }, 120e3),
  savedShows: (offset = 0) => get('/me/shows', { limit: 50, offset }, 120e3),
  async contains(uris) {
    const out = [];
    for (const part of chunks(uris, 40)) {
      const r = await get('/me/library/contains', { uris: part.join(',') }, 30e3);
      out.push(...(Array.isArray(r) ? r : part.map(() => false)));
    }
    return out;
  },
  async save(uris) {
    for (const part of chunks(uris, 40)) await api('PUT', '/me/library', { query: { uris: part.join(',') } });
    invalidate(...LIB);
  },
  async unsave(uris) {
    for (const part of chunks(uris, 40)) await api('DELETE', '/me/library', { query: { uris: part.join(',') } });
    invalidate(...LIB);
  },

  // ---- catalog
  album: id => get('/albums/' + id, null, 10 * 60e3),
  albumTracks: (id, offset = 0) => get(`/albums/${id}/tracks`, { limit: 50, offset }, 10 * 60e3),
  artist: id => get('/artists/' + id, null, 10 * 60e3),
  artistAlbums: (id, groups, offset = 0, limit = 50) => get(`/artists/${id}/albums`, { include_groups: groups, limit, offset }, 10 * 60e3),
  show: id => get('/shows/' + id, null, 5 * 60e3),
  showEpisodes: (id, offset = 0) => get(`/shows/${id}/episodes`, { limit: 50, offset }, 5 * 60e3),
  search: (q, types, offset = 0) => get('/search', { q, type: types, limit: 10, offset }, 120e3),

  // ---- personal
  top: (type, limit = 20) => get('/me/top/' + type, { time_range: 'short_term', limit }, 10 * 60e3),
  recent: () => get('/me/player/recently-played', { limit: 50 }, 45e3),
};
