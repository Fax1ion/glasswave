// Lyrics.
//
// They come from lrclib.net, a free public lyrics site that needs no account.
// Only the song's title, artist, album and length are sent. Spotify's own lyrics
// are kept inside Spotify's apps and are not offered to outside players.

import { DEMO } from './config.js';
import { store } from './util.js';
import { helperGet } from './local.js';

const SITE = 'https://lrclib.net/api/';
const memory = new Map();
const saved = store.get('gw.lyrics', {});          // song -> { at, k, s }
let direct = true;                                 // set to false when the browser may not ask the site itself

// ---- asking -------------------------------------------------------------------------------
async function ask(kind, params) {
  const query = new URLSearchParams(params).toString();
  if (direct) {
    const stop = new AbortController();
    const timer = setTimeout(() => stop.abort(), 9000);
    try {
      const r = await fetch(SITE + kind + '?' + query, { signal: stop.signal, referrerPolicy: 'no-referrer', credentials: 'omit' });
      clearTimeout(timer);
      if (r.status === 404) return null;
      if (r.ok) return await r.json();
      throw new Error('The lyrics site answered ' + r.status);
    } catch (e) {
      clearTimeout(timer);
      if (!(e instanceof TypeError)) throw e;
      direct = false;                              // blocked or unreachable from the page: go through the helper
    }
  }
  let r;
  try { r = await helperGet('/__lyrics', { kind, ...params }); } catch (e) { direct = true; throw e; }
  if (r.status === 404) return null;
  if (!r.ok || !(r.headers.get('content-type') || '').includes('json')) { direct = true; throw new Error('The lyrics site could not be reached'); }
  return r.json();
}

// "Song - 2011 Remaster" and "Song (feat. Someone)" are filed under plain "Song".
const tidy = s => (s || '')
  .replace(/\s+[-–]\s+(\d{4}\s+)?(remaster(ed)?|mono|stereo|single|radio|live|bonus|deluxe|version|edit|mix)\b.*$/i, '')
  .replace(/\s*[([](feat\.?|ft\.?|with|from|remaster(ed)?|live|bonus|deluxe|\d{4})[^)\]]*[)\]]/gi, '')
  .trim();

function parseTimed(text) {
  const lines = [];
  for (const raw of text.split(/\r?\n/)) {
    const stamps = [];
    let rest = raw;
    for (;;) {
      const m = /^\s*\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/.exec(rest);
      if (!m) break;
      stamps.push(Number(m[1]) * 60000 + Number(m[2]) * 1000 + (m[3] ? Number((m[3] + '00').slice(0, 3)) : 0));
      rest = rest.slice(m[0].length);
    }
    if (!stamps.length) continue;
    const words = rest.replace(/<\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?>/g, '').trim();
    for (const t of stamps) lines.push({ t, text: words });
  }
  lines.sort((a, b) => a.t - b.t);
  return lines.filter((l, i) => l.text || (i > 0 && lines[i - 1].text));       // one pause mark between verses is enough
}
function build(k, s) {
  if (k === 'synced') { const lines = parseTimed(s || ''); if (lines.length > 1) return { kind: 'synced', lines }; k = 'none'; }
  if (k === 'plain') return { kind: 'plain', lines: (s || '').split(/\r?\n/).map(text => ({ text: text.trim() })) };
  return { kind: k };
}
function keep(key, k, s) {
  saved[key] = { at: Date.now(), k, s };
  const keys = Object.keys(saved);
  if (keys.length > 40) { keys.sort((a, b) => saved[a].at - saved[b].at); for (const old of keys.slice(0, keys.length - 40)) delete saved[old]; }
  store.set('gw.lyrics', saved);
}
function pick(found) {
  if (!found) return ['none', ''];
  if (found.syncedLyrics) return ['synced', found.syncedLyrics];
  if (found.plainLyrics) return ['plain', found.plainLyrics];
  return [found.instrumental ? 'instrumental' : 'none', ''];
}

// Made-up lines for the demo, so the lyrics view can be tried without any real song.
const DEMO_LINES = ['Light spills over the glass', 'Colours move when the music moves', 'This is a demo line, not a real lyric', '',
  'Every bar slides into the next', 'Hold the note and let it drift', 'Words would follow the song right here', '',
  'Quiet now, then loud again', 'The wave comes back around'];
function demoLyrics(track, ms) {
  let n = 0;
  for (const ch of track.uri) n = (n * 31 + ch.charCodeAt(0)) >>> 0;
  if (n % 4 === 0) return { kind: 'none' };
  if (n % 4 === 1) return { kind: 'plain', lines: DEMO_LINES.map(text => ({ text })) };
  const step = Math.max(2500, Math.min(6000, (ms || 180000) / (DEMO_LINES.length * 3)));
  const lines = [];
  for (let i = 0; i < DEMO_LINES.length * 3 && (i + 1) * step < (ms || 180000); i++) lines.push({ t: Math.round((i + 0.6) * step), text: DEMO_LINES[i % DEMO_LINES.length] });
  return { kind: 'synced', lines };
}

// ---- the one thing the rest of the app calls -------------------------------------------------
// Gives { kind: 'synced' | 'plain' | 'instrumental' | 'none' | 'error', lines? }.
export async function lyricsFor(track, lengthMs) {
  if (!track || !track.uri || track.type === 'episode') return { kind: 'none' };
  const key = track.uri;
  if (memory.has(key)) return memory.get(key);
  const ms = lengthMs || track.duration_ms || 0;
  if (DEMO && !track.is_file) { const d = demoLyrics(track, ms); memory.set(key, d); return d; }
  const old = saved[key];
  if (old && (old.k !== 'none' || Date.now() - old.at < 3 * 864e5)) { const d = build(old.k, old.s); memory.set(key, d); return d; }

  const title = track.name || '';
  const artist = (track.artists && track.artists[0] && track.artists[0].name) || '';
  const album = (track.album && track.album.name) || '';
  const seconds = Math.round(ms / 1000);
  try {
    let found = null;
    if (title && artist && seconds) found = await ask('get', { track_name: title, artist_name: artist, album_name: album, duration: String(seconds) });
    if (!found || !(found.syncedLyrics || found.plainLyrics || found.instrumental)) {
      const params = { track_name: tidy(title) || title };
      if (artist) params.artist_name = artist;
      const list = (await ask('search', params)) || [];
      const near = x => !seconds || !x.duration || Math.abs(x.duration - seconds) <= 4;
      const fits = (Array.isArray(list) ? list : []).filter(x => x && near(x) && (artist || seconds));
      found = fits.find(x => x.syncedLyrics) || fits.find(x => x.plainLyrics) || fits.find(x => x.instrumental) || found;
    }
    const [k, s] = pick(found);
    keep(key, k, s);
    const d = build(k, s);
    memory.set(key, d);
    if (memory.size > 60) memory.delete(memory.keys().next().value);
    return d;
  } catch (e) {
    return { kind: 'error', message: e.message };
  }
}
