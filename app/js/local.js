// Local Files: the music files on this computer.
//
// Glasswave's helper (the launcher) lists the songs in your Music folder and hands
// the sound to this window. Titles, artists and cover pictures are read here from
// the tags inside each file. Nothing about these files leaves the computer.

import { store, bus, debounce } from './util.js';
import * as player from './player.js';

const EXT = /\.(mp3|m4a|aac|flac|wav|ogg|oga|opus)$/i;
export const local = { ready: false, indexed: false, error: null, roots: [], tracks: [], more: false, at: 0 };
let pass = null;
let loading = null;

const metaCache = store.get('gw.localMeta', {});          // "path|size|changed" -> [title, artist, album, ms]
const saveMeta = debounce(() => store.set('gw.localMeta', metaCache), 1500);

const NO_HELPER = 'Glasswave’s helper isn’t running. Close Glasswave and start it again.';
const OLD_HELPER = 'Glasswave was updated. Close it completely and start it again to finish.';

// ---- talking to the helper ---------------------------------------------------------------
async function getPass(force) {
  if (pass && !force) return pass;
  let r;
  try { r = await fetch('/__local/token', { cache: 'no-store' }); } catch { throw new Error(NO_HELPER); }
  if (!r.ok || !(r.headers.get('content-type') || '').includes('json')) throw new Error(OLD_HELPER);
  pass = (await r.json()).token;
  return pass;
}
export async function helperGet(path, params = {}, again = true) {
  const t = await getPass();
  let r;
  try { r = await fetch(path + '?' + new URLSearchParams({ t, ...params }), { cache: 'no-store' }); } catch { throw new Error(NO_HELPER); }
  if (r.status === 403 && again) { await getPass(true); return helperGet(path, params, false); }
  return r;
}
const fileUrl = t => '/__local/file?t=' + pass + '&r=' + t.file.r + '&p=' + encodeURIComponent(t.file.p);

// ---- the list ----------------------------------------------------------------------------
const byName = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true });
function fromName(base) {
  let s = base.replace(/_/g, ' ').replace(/^\s*\d{1,3}\s*[-._)]\s*/, '').trim() || base;
  const parts = s.split(/\s+-\s+/);
  if (parts.length >= 2) return { artist: parts[0].trim(), title: parts.slice(1).join(' - ').trim() };
  return { artist: '', title: s };
}
function makeTrack([r, p, size, changed]) {
  const key = p + '|' + size + '|' + changed;
  const base = p.split('/').pop().replace(EXT, '');
  const folder = p.includes('/') ? p.split('/').slice(-2, -1)[0] : '';
  const guess = fromName(base);
  const t = { uri: 'local:' + r + ':' + p, type: 'track', is_file: true, rev: 0, album: { name: folder, images: [] }, artists: [], name: guess.title, duration_ms: 0,
    file: { r, p, key, base, artist: guess.artist, tagged: false } };
  applyMeta(t, metaCache[key]);
  if (!t.artists.length && guess.artist) t.artists = [{ name: guess.artist, id: null }];
  return t;
}
function applyMeta(t, m) {
  if (!m) return;
  if (m[0]) t.name = m[0];
  if (m[1]) { t.file.artist = m[1]; t.artists = [{ name: m[1], id: null }]; }
  if (m[2]) t.album.name = m[2];
  if (m[3]) t.duration_ms = m[3];
  t.file.tagged = true;
}

export function loadLocal(force) {
  if (loading) return loading;
  if (local.ready && !force && Date.now() - local.at < 5 * 60e3) return Promise.resolve(local);
  loading = (async () => {
    try {
      const r = await helperGet('/__local/list');
      if (!r.ok) throw new Error(OLD_HELPER);
      const data = await r.json();
      const old = new Map(local.tracks.map(t => [t.uri + '|' + t.file.key, t]));
      local.roots = data.roots || [];
      local.more = !!data.more;
      local.tracks = (data.files || []).map(f => old.get('local:' + f[0] + ':' + f[1] + '|' + f[1] + '|' + f[2] + '|' + f[3]) || makeTrack(f))
        .sort(byName);
      local.error = null;
      local.indexed = local.tracks.every(t => t.file.tagged);
    } catch (e) {
      local.error = e.message;
      if (!local.ready) local.tracks = [];
    }
    local.ready = true; local.at = Date.now(); loading = null;
    bus.emit('local-loaded');
    return local;
  })();
  return loading;
}

// ---- playing -----------------------------------------------------------------------------
export async function playLocal(list, index = 0) {
  try { await getPass(); } catch (e) { return player.say(e.message); }
  for (const t of list) t.url = fileUrl(t);
  player.playFiles(list, index);
}
export async function queueLocal(t) {
  try { await getPass(); } catch (e) { return player.say(e.message); }
  t.url = fileUrl(t);
  player.queueFile(t);
}

// A song Spotify lists as "local" inside one of your playlists: find the same song here.
const norm = s => (s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
export function findLocal(t) {
  if (!t || !local.tracks.length) return null;
  const title = norm(t.name), artist = norm(t.artists && t.artists[0] && t.artists[0].name);
  if (!title) return null;
  let best = null, top = 0;
  for (const f of local.tracks) {
    let s = 0;
    if (norm(f.name) === title) s = 3;
    else if (title.length >= 4 && norm(f.file.base).includes(title)) s = 1.5;
    else continue;
    const fa = norm(f.file.artist);
    if (artist && fa) s += (fa === artist || fa.includes(artist) || artist.includes(fa)) ? 2 : -1;
    if (t.duration_ms && f.duration_ms && Math.abs(t.duration_ms - f.duration_ms) < 3000) s += 1;
    if (s > top) { top = s; best = f; }
  }
  return top >= 1.5 ? best : null;
}

// ---- reading the tags inside a file ----------------------------------------------------------
async function bytes(t, from, to) {
  if (!pass) await getPass();
  const r = await fetch(fileUrl(t), { headers: { Range: 'bytes=' + from + '-' + to }, cache: 'no-store' });
  if (!r.ok) throw new Error('unreadable');
  return new Uint8Array(await r.arrayBuffer());
}
const safe = (b, i) => ((b[i] & 127) << 21) | ((b[i + 1] & 127) << 14) | ((b[i + 2] & 127) << 7) | (b[i + 3] & 127);
const be32 = (b, i) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
const latin = (b, i, n) => String.fromCharCode(...b.subarray(i, i + n));
const FRAMES = { TIT2: 'title', TT2: 'title', TPE1: 'artist', TP1: 'artist', TALB: 'album', TAL: 'album', APIC: 'picture', PIC: 'picture' };

function tagText(b) {
  if (b.length < 2) return '';
  const enc = b[0], data = b.subarray(1);
  let label = 'windows-1252';
  if (enc === 1) label = (data[0] === 0xfe && data[1] === 0xff) ? 'utf-16be' : 'utf-16le';
  else if (enc === 2) label = 'utf-16be';
  else if (enc === 3) label = 'utf-8';
  try { return new TextDecoder(label).decode(data).split('\0')[0].trim(); } catch { return ''; }
}
function tagPicture(b, ver) {
  const enc = b[0];
  let i = 1, mime = '';
  if (ver === 2) { mime = latin(b, 1, 3) === 'PNG' ? 'image/png' : 'image/jpeg'; i = 4; }
  else { const z = b.indexOf(0, 1); if (z < 0) return null; mime = latin(b, 1, z - 1); i = z + 1; }
  i++;                                                       // kind of picture (front cover, ...)
  if (enc === 1 || enc === 2) { while (i + 1 < b.length && (b[i] || b[i + 1])) i += 2; i += 2; }
  else { while (i < b.length && b[i]) i++; i++; }
  const data = b.subarray(i);
  if (data.length < 64) return null;
  if (!mime.includes('/')) mime = data[0] === 0x89 ? 'image/png' : 'image/jpeg';
  return new Blob([data], { type: mime });
}
export function parseId3(b, wantPicture) {
  const out = { size: 0 };
  if (b.length < 10 || b[0] !== 0x49 || b[1] !== 0x44 || b[2] !== 0x33) return out;
  const ver = b[3], flags = b[5];
  out.size = 10 + safe(b, 6);
  if (ver < 2 || ver > 4 || (flags & 0x80)) return out;
  let pos = 10;
  if (ver > 2 && (flags & 0x40)) pos += ver === 4 ? safe(b, 10) : 4 + be32(b, 10);
  const end = Math.min(out.size, b.length), idLen = ver === 2 ? 3 : 4, headLen = ver === 2 ? 6 : 10;
  while (pos + headLen <= end && b[pos] !== 0) {
    const id = latin(b, pos, idLen);
    const size = ver === 2 ? ((b[pos + 3] << 16) | (b[pos + 4] << 8) | b[pos + 5]) : ver === 4 ? safe(b, pos + 4) : be32(b, pos + 4);
    const body = pos + headLen;
    if (size <= 0 || body + size > b.length) break;
    const key = FRAMES[id];
    if (key === 'picture') { if (wantPicture && !out.picture) out.picture = tagPicture(b.subarray(body, body + size), ver); }
    else if (key && !out[key]) out[key] = tagText(b.subarray(body, body + size));
    pos = body + size;
  }
  return out;
}
async function readTags(t, wantPicture) {
  if (!/\.mp3$/i.test(t.file.p)) return {};
  let b = await bytes(t, 0, 65535);
  let tag = parseId3(b, wantPicture);
  if (tag.size > b.length && (!tag.title || (wantPicture && !tag.picture))) {
    b = await bytes(t, 0, Math.min(tag.size, 8 * 1048576) - 1);
    tag = parseId3(b, wantPicture);
  }
  return tag;
}
function remember(t, tag, ms) {
  const m = metaCache[t.file.key] || ['', '', '', 0];
  if (tag.title) m[0] = tag.title;
  if (tag.artist) m[1] = tag.artist;
  if (tag.album) m[2] = tag.album;
  if (ms) m[3] = Math.round(ms);
  metaCache[t.file.key] = m;
  applyMeta(t, m);
  saveMeta();
}
export function learnDuration(t, ms) {
  if (!t || !t.file || !ms || Math.abs((t.duration_ms || 0) - ms) < 500) return;
  remember(t, {}, ms);
  bus.emit('local-meta', t);
}

// The song that is playing: make sure its real title and cover picture are showing.
const pictures = [];
export async function dressTrack(t) {
  if (!t || !t.file || t.file.dressed) return;
  t.file.dressed = true;
  try {
    const tag = await readTags(t, true);
    remember(t, tag, 0);
    if (tag.picture) {
      const url = URL.createObjectURL(tag.picture);
      t.album.images = t.images = [{ url, width: 600, height: 600 }];
      pictures.push(t);
      if (pictures.length > 30) { const old = pictures.shift(); if (old !== player.state.track) { URL.revokeObjectURL(old.album.images[0].url); old.album.images = old.images = []; old.file.dressed = false; } }
    }
  } catch { /* the file plays fine without its tags */ }
  t.rev++;                                   // "this song's details are as good as they will get": lyrics can be looked up now
  bus.emit('local-meta', t);
  player.refresh();
}

// Quietly reads the titles and artists inside the files (quick), and, for the Local Files
// page, each song's length (slower). Everything learned is kept, so this happens once per file.
let indexing = null, wantLengths = false;
const probe = typeof Audio === 'function' ? new Audio() : null;
const pause = ms => new Promise(r => setTimeout(r, ms));
function lengthOf(t) {
  return new Promise(resolve => {
    if (!probe) return resolve(0);
    const done = ms => { clearTimeout(timer); probe.onloadedmetadata = probe.onerror = null; probe.removeAttribute('src'); probe.load(); resolve(ms); };
    const timer = setTimeout(() => done(0), 4000);
    probe.preload = 'metadata';
    probe.onloadedmetadata = () => done(isFinite(probe.duration) ? probe.duration * 1000 : 0);
    probe.onerror = () => done(0);
    probe.src = fileUrl(t);
  });
}
export function indexLocal(withLengths) {
  if (withLengths) wantLengths = true;
  if (indexing) return indexing;
  indexing = (async () => {
    try {
      await getPass();
      let n = 0;
      for (const t of local.tracks.slice()) {
        if (t.file.tagged) continue;
        let tag = {};
        try { tag = await readTags(t, false); } catch { /* plays fine without its tags */ }
        remember(t, tag, 0);
        bus.emit('local-meta', t);
        if (++n % 10 === 0) await pause(document.hidden ? 250 : 12);
      }
      // Real titles are known now, so put the list back into A to Z order if that changed anything.
      const sorted = local.tracks.slice().sort(byName);
      if (sorted.some((t, i) => t !== local.tracks[i])) { local.tracks = sorted; bus.emit('local-sorted'); }
      if (!local.indexed) { local.indexed = true; bus.emit('local-indexed'); }
      if (wantLengths) {
        for (const t of local.tracks.slice()) {
          if (t.duration_ms) continue;
          const ms = await lengthOf(t);
          if (ms) { remember(t, {}, ms); bus.emit('local-meta', t); }
          await pause(document.hidden ? 250 : 15);
        }
      }
    } catch { /* the helper went away: carry on next time */ }
    indexing = null;
  })();
  return indexing;
}

bus.on('file-playing', t => { dressTrack(t); });
bus.on('file-length', ({ track, ms }) => learnDuration(track, ms));
