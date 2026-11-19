// Smart Shuffle, made by Glasswave.
// Spotify doesn't let outside apps turn on its own Smart Shuffle, so this is Glasswave's version.
// With it on, Glasswave adds a song that fits what you're playing after every few songs. The songs
// are picked the same way as Home's "Recommended for you": from the genres and artists of what is
// playing and coming up, leaving out songs you already have. Picks are marked with a sparkle.
// Turning Smart Shuffle off skips any pick still waiting in the queue (Spotify gives outside apps
// no way to take a song back out of the queue).

import * as player from './player.js';
import { sp } from './api.js';
import { recommend } from './recs.js';
import { toast, bus } from './util.js';

const EVERY = 3;                  // one pick after this many of your own songs
const s = player.state;
const marks = new Set();          // songs Glasswave added; they keep the sparkle until they finish
const seen = new Set();           // songs heard or lined up while Smart Shuffle was on, never picked
let pool = [], building = null, count = 0, round = 0, lastUri, lastContext, wasOn = false, nothingFound = 0;

export const isPick = uri => !!uri && marks.has(uri);

export function initSmart() {
  player.subscribe(onState);
  bus.on('smart-on', () => {
    toast('Smart Shuffle is on. Glasswave adds a song that fits every few tracks, marked with a sparkle.', { ms: 5000 });
    count = 0;
    queuePick();                  // the first one plays right after this song, so you can hear it work
  });
}

function onState(st) {
  const uri = st.track ? st.track.uri : null;
  if (st.contextUri !== lastContext) { lastContext = st.contextUri; pool = []; count = 0; }    // a new playlist: new picks
  if (st.smart !== wasOn) { wasOn = st.smart; if (!wasOn) count = 0; bus.emit('smart-changed'); }
  if (uri === lastUri) return;
  const before = lastUri;
  lastUri = uri;
  if (before && marks.has(before)) { marks.delete(before); bus.emit('smart-changed'); }       // a pick has finished
  if (!uri) return;
  if (marks.has(uri)) {
    if (!st.smart) { marks.delete(uri); player.next(); }       // Smart Shuffle was turned off: skip the leftover pick
    return;
  }
  if (!st.smart) return;
  seen.add(uri);
  if (++count >= EVERY) { count = 0; queuePick(); }
}

const waiting = () => [...marks].filter(u => u !== lastUri).length;

async function queuePick() {
  if (!s.smart || waiting()) return;            // never more than one pick waiting
  if (!pool.length) await refill();
  if (!s.smart || waiting()) return;
  const t = pool.shift();
  if (!t) return;
  marks.add(t.uri);
  seen.add(t.uri);
  if (!(await player.addToQueue(t.uri, true))) { marks.delete(t.uri); return; }
  bus.emit('smart-changed');
}

// New picks, from the artists of the song playing and the songs coming up.
function refill() {
  if (building) return building;
  building = (async () => {
    let upcoming = [];
    try { upcoming = ((await player.getQueue()).queue || []).filter(t => t && t.uri && !marks.has(t.uri)); } catch { /* use what is playing */ }
    const songs = [s.track, ...upcoming].filter(t => t && t.uri && t.type !== 'episode');
    for (const t of songs) seen.add(t.uri);
    const tally = new Map();
    songs.forEach((t, i) => {
      const a = t.artists && t.artists[0];
      if (a && a.id) tally.set(a.id, (tally.get(a.id) || 0) + (i === 0 ? 3 : 1));
    });
    const ids = [...tally.entries()].sort((x, y) => y[1] - x[1]).slice(0, 5).map(x => x[0]);
    const artists = (await Promise.all(ids.map(id => sp.artist(id).catch(() => null)))).filter(Boolean);
    round++;
    const picks = await recommend({ artists, exclude: seen, count: 10, salt: 'smart|' + (s.contextUri || '') + '|' + round }).catch(() => []);
    pool = picks.filter(t => !seen.has(t.uri));
    if (!pool.length && ++nothingFound === 1) toast('Smart Shuffle couldn’t find songs to add for this right now. It will try again in a few songs.');
    if (pool.length) nothingFound = 0;
  })().finally(() => { building = null; });
  return building;
}
