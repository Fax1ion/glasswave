// Playback. Audio plays in this window through Spotify's Web Playback SDK
// (Spotify Premium needed). When music is playing on another device instead,
// the same controls act as a remote for it.

import { DEMO, APP_NAME } from './config.js';
import { api } from './api.js';
import { getToken } from './auth.js';
import { store, toast, idOf, debounce, bus } from './util.js';
import { demoBackend } from './demo.js';

// ---- volume ---------------------------------------------------------------------------
// Hearing works on a curve, not a straight line: half the sound power does not sound half as
// loud. So for sound played on this computer, the bar's position is turned into loudness on a
// curve, which gives the bar's lower half to the quiet range (50% on the bar is about as loud
// as 13% used to be). Other Spotify devices (a phone, a speaker) get the bar's percent as it is,
// because they apply their own volume steps.
const CURVE = 3;
export const loudness = level => Math.pow(Math.min(1, Math.max(0, level)), CURVE);
function localLevel() {
  const level = store.get('gw.level', null);
  if (typeof level === 'number') return level;
  // From before the curve: keep the same loudness, so nothing jumps.
  const old = store.get('gw.volume', null);
  const kept = typeof old === 'number' ? Math.round(Math.pow(Math.min(1, Math.max(0, old)), 1 / CURVE) * 100) / 100 : 0.6;
  store.set('gw.level', kept);
  return kept;
}

export const state = {
  ready: false,          // this window's player is connected
  localId: null,         // this window's device id
  isLocal: false,        // sound is coming from this window
  device: null,          // { id, name, type } of whatever is playing
  track: null,
  paused: true,
  position: 0, duration: 0, ts: 0,
  shuffle: false, repeat: 'off',
  smart: false,          // Glasswave's Smart Shuffle is on (see smart.js)
  spotifySmart: false,   // Spotify's own Smart Shuffle was turned on in a Spotify app
  volume: localLevel(),  // where the volume bar sits, 0 to 1
  contextUri: null,
  problem: null,         // a message when the player can't start
  files: false,          // a music file from this computer is playing (Local Files)
};
const listeners = new Set();
export const subscribe = fn => { listeners.add(fn); return () => listeners.delete(fn); };
function emit() {
  state.smart = smartWanted && state.shuffle && !state.files && !isEpisode();
  for (const fn of listeners) { try { fn(state); } catch (e) { console.error(e); } }
}
const isEpisode = () => !!(state.track && state.track.type === 'episode');

// ---- Smart Shuffle ----------------------------------------------------------------------------
// Spotify doesn't let outside apps turn on its own Smart Shuffle, so Glasswave has its own
// (smart.js does the picking). The choice is remembered, and it only counts while shuffle is on:
// when shuffle is turned off anywhere, Smart Shuffle goes off too.
let smartWanted = store.get('gw.smart', false);
let askedSpotifyOff = 0;
function wantSmart(on) { smartWanted = !!on; store.set('gw.smart', smartWanted); }
function shuffleSeen() { if (!state.shuffle && smartWanted && state.track) wantSmart(false); }
export const positionNow = () => (state.files ? audio.currentTime * 1000 : state.paused ? state.position : Math.min(state.duration || Infinity, state.position + (Date.now() - state.ts)));
export const say = msg => toast(msg, { error: true });

let sdk = null;
let pollTimer = null;

// ---- start-up ----------------------------------------------------------------------
export function initPlayer() {
  if (DEMO) return demoBackend.init(state, emit);
  window.onSpotifyWebPlaybackSDKReady = () => {
    sdk = new window.Spotify.Player({
      name: APP_NAME,
      getOAuthToken: cb => { getToken().then(cb).catch(() => {}); },
      volume: loudness(state.volume),
      enableMediaSession: true,          // keyboard media keys and the Windows media pop-up
    });
    sdk.addListener('ready', ({ device_id }) => { state.ready = true; state.localId = device_id; state.problem = null; emit(); pollSoon(0); });
    sdk.addListener('not_ready', () => { state.ready = false; emit(); });
    sdk.addListener('player_state_changed', onSdkState);
    sdk.addListener('initialization_error', e => fail('This browser can’t play Spotify audio here (' + e.message + '). Chrome or Edge works best.'));
    sdk.addListener('authentication_error', e => fail('Spotify didn’t accept the sign-in for playback: ' + e.message));
    sdk.addListener('account_error', () => fail('Spotify says this account can’t play here. Playback in other apps needs Spotify Premium.'));
    sdk.addListener('playback_error', e => toast('Playback problem: ' + e.message, { error: true }));
    sdk.addListener('autoplay_failed', () => toast('Press play to start the sound.'));
    sdk.connect().then(ok => { if (!ok) fail('Couldn’t connect the player to Spotify.'); });
  };
  const s = document.createElement('script');
  s.src = 'https://sdk.scdn.co/spotify-player.js';
  s.async = true;
  s.onerror = () => fail('Couldn’t load Spotify’s player. Check your internet connection.');
  document.head.append(s);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) pollSoon(250); });
  pollSoon(400);
}
function fail(msg) { state.problem = msg; emit(); toast(msg, { error: true, ms: 7000 }); }

// ---- state from this window's player ----------------------------------------------------
function onSdkState(s) {
  if (state.files) { if (!s || s.paused || Date.now() - filesSince < 1500) return; stopFiles(); }
  if (!s) {                                    // playback moved away from this window
    if (state.isLocal) { state.isLocal = false; state.position = positionNow(); state.paused = true; emit(); pollSoon(300); }
    return;
  }
  const t = s.track_window && s.track_window.current_track;
  if (!state.isLocal) state.volume = localLevel();     // back on this computer: its own volume again
  state.isLocal = true;
  state.device = { id: state.localId, name: 'This computer', type: 'Computer' };
  state.track = t ? fromSdk(t) : null;
  state.paused = s.paused;
  state.position = s.position; state.duration = s.duration; state.ts = Date.now();
  state.shuffle = !!s.shuffle; shuffleSeen();
  state.repeat = ['off', 'context', 'track'][s.repeat_mode] || 'off';
  state.contextUri = (s.context && s.context.uri) || null;
  emit();
}
function fromSdk(t) {
  const album = t.album || {};
  return {
    uri: t.uri, id: t.id || idOf(t.uri), name: t.name, type: t.type || 'track', duration_ms: t.duration_ms,
    artists: (t.artists || []).map(a => ({ name: a.name, uri: a.uri, id: a.uri ? idOf(a.uri) : null })),
    album: { name: album.name, uri: album.uri, id: album.uri ? idOf(album.uri) : null, images: album.images || [] },
    images: album.images || [],
  };
}
function fromApi(item) {
  if (!item) return null;
  const images = (item.album && item.album.images) || item.images || (item.show && item.show.images) || [];
  return { ...item, artists: item.artists || (item.show ? [{ name: item.show.name, id: null }] : []), images };
}

// ---- state from Spotify's servers (other devices) ------------------------------------------
function pollSoon(ms) {
  if (DEMO) return;
  clearTimeout(pollTimer);
  if (ms == null) ms = document.hidden ? 60000 : state.isLocal ? 30000 : (state.device && !state.paused) ? 7000 : 15000;
  pollTimer = setTimeout(poll, ms);
}
async function poll() {
  try { applyRemote(await api('GET', '/me/player', { query: { additional_types: 'episode' } })); }
  catch { /* offline or signed out: try again later */ }
  pollSoon();
}
function applyRemote(p) {
  if (state.files) { if (!p || !p.device || !p.is_playing || Date.now() - filesSince < 1500) return; stopFiles(); }
  if (!p || !p.device) {                         // nothing is playing anywhere
    if (!state.isLocal && state.device) { state.device = null; state.position = positionNow(); state.paused = true; emit(); }
    return;
  }
  spotifySmartSeen(p);
  if (p.device.id === state.localId) {           // this window: the SDK already tells us everything
    state.shuffle = !!p.shuffle_state; state.repeat = p.repeat_state || 'off'; shuffleSeen();
    if (!state.isLocal && p.item) { state.track = fromApi(p.item); state.duration = p.item.duration_ms || 0; state.position = p.progress_ms || 0; state.ts = Date.now(); }
    return emit();
  }
  state.isLocal = false;
  state.device = { id: p.device.id, name: p.device.name, type: p.device.type };
  if (p.device.volume_percent != null) state.volume = p.device.volume_percent / 100;
  state.track = fromApi(p.item);
  state.paused = !p.is_playing;
  state.position = p.progress_ms || 0; state.duration = (p.item && p.item.duration_ms) || 0; state.ts = Date.now();
  state.shuffle = !!p.shuffle_state; state.repeat = p.repeat_state || 'off'; shuffleSeen();
  state.contextUri = (p.context && p.context.uri) || null;
  emit();
}
// Spotify reports its own Smart Shuffle (not in its documentation, but it's there). Outside apps
// can't turn it off, and while it's on, turning shuffle off from here does nothing.
function spotifySmartSeen(p) {
  state.spotifySmart = !!p.smart_shuffle;
  if (state.spotifySmart && askedSpotifyOff && Date.now() - askedSpotifyOff < 15000) {
    askedSpotifyOff = 0;
    toast('Smart Shuffle was turned on in a Spotify app, and Spotify only lets its own apps turn it off. Turn it off there, then Glasswave\u2019s shuffle button works again.', { ms: 9000 });
  }
}

// ---- controls ---------------------------------------------------------------------------
const remote = () => (!state.isLocal && state.device && state.device.id !== state.localId ? state.device.id : null);
const target = () => remote() || state.localId;
function unlockAudio() { try { if (sdk && sdk.activateElement) sdk.activateElement(); } catch { /* not needed */ } }

function explain(e) {
  if (e.status === 403 && /premium/i.test((e.reason || '') + e.message)) return 'Spotify Premium is needed to control playback.';
  if (e.status === 404) return 'No player is ready yet. Give it a second and press play again.';
  if (e.status === 429) return 'Spotify asked the app to slow down. Try again in a moment.';
  return e.message || 'Something went wrong.';
}
async function send(method, path, opts, quiet) {
  try { await api(method, path, opts); return true; }
  catch (e) { if (!quiet) toast(explain(e), { error: true }); return false; }
}

async function playRequest(body, quiet) {
  unlockAudio();
  const id = target();
  if (!id) { if (!quiet) toast(state.problem || 'The player is still starting. Try again in a moment.'); return false; }
  const ok = await send('PUT', '/me/player/play', { query: { device_id: id }, body }, quiet);
  if (ok) stopFiles();
  if (ok && id !== state.localId) pollSoon(700);
  return ok;
}
export function playContext(uri, offset, quiet) {
  if (DEMO) { stopFiles(); return Promise.resolve(demoBackend.playContext(uri, offset)); }
  const body = { context_uri: uri };
  if (typeof offset === 'number') body.offset = { position: offset };
  else if (offset) body.offset = { uri: offset };
  return playRequest(body, quiet);
}
export function playUris(uris, index = 0) {
  uris = uris.filter(Boolean);
  if (!uris.length) return Promise.resolve(false);
  if (DEMO) { stopFiles(); return Promise.resolve(demoBackend.playUris(uris, index)); }
  const from = Math.max(0, Math.min(index - 20, uris.length - 100));   // Spotify takes about 100 at a time
  return playRequest({ uris: uris.slice(from, from + 100), offset: { position: index - from } });
}

export async function toggle() {
  if (state.files) { if (audio.paused) audio.play().catch(() => {}); else audio.pause(); return; }
  if (DEMO) return demoBackend.toggle();
  unlockAudio();
  if (state.isLocal && sdk) return sdk.togglePlay();
  const id = remote();
  if (id) {
    const wasPaused = state.paused;
    state.position = positionNow(); state.ts = Date.now(); state.paused = !wasPaused; emit();
    await send('PUT', wasPaused ? '/me/player/play' : '/me/player/pause', { query: { device_id: id } });
    return pollSoon(700);
  }
  if (!state.localId) return toast(state.problem || 'The player is still starting. Try again in a moment.');
  // Nothing is active: wake this window's player and carry on where Spotify left off.
  const ok = await send('PUT', '/me/player', { body: { device_ids: [state.localId], play: true } }, true);
  if (!ok) toast('Pick something to play first.');
}
export function next() {
  if (state.files) return fileNext(false);
  if (DEMO) return demoBackend.next();
  if (state.isLocal && sdk) return sdk.nextTrack();
  return send('POST', '/me/player/next', { query: { device_id: target() } }).then(() => pollSoon(600));
}
export function prev() {
  if (state.files) return filePrev();
  if (DEMO) return demoBackend.prev();
  if (state.isLocal && sdk) return sdk.previousTrack();
  return send('POST', '/me/player/previous', { query: { device_id: target() } }).then(() => pollSoon(600));
}
export function seek(ms) {
  ms = Math.max(0, Math.round(ms));
  if (state.files) { audio.currentTime = ms / 1000; return; }
  if (DEMO) return demoBackend.seek(ms);
  state.position = ms; state.ts = Date.now(); emit();
  if (state.isLocal && sdk) return sdk.seek(ms);
  return send('PUT', '/me/player/seek', { query: { position_ms: ms, device_id: target() } });
}
const remoteVolume = debounce(v => send('PUT', '/me/player/volume', { query: { volume_percent: Math.round(v * 100), device_id: target() } }, true), 250);
export function setVolume(v) {
  v = Math.min(1, Math.max(0, v));
  state.volume = v; emit();
  if (DEMO) { store.set('gw.level', v); return; }
  if (!state.files && remote()) return remoteVolume(v);
  store.set('gw.level', v);
  if (audio) audio.volume = loudness(v);
  if (sdk) sdk.setVolume(loudness(v)).catch(() => {});
}
export function setShuffle(on) {
  if (state.files) { files.shuffle = on; store.set('gw.fileShuffle', on); reorder(); state.shuffle = on; return emit(); }
  if (DEMO) return demoBackend.setShuffle(on);
  state.shuffle = on; emit();
  return send('PUT', '/me/player/shuffle', { query: { state: on, device_id: target() } });
}
// The shuffle button: off, then shuffle, then Smart Shuffle, then off again.
// Music files from this computer and podcasts have plain shuffle only.
export function cycleShuffle() {
  if (state.files || isEpisode()) return setShuffle(!state.shuffle);
  if (state.spotifySmart) { askedSpotifyOff = Date.now(); setShuffle(false); return pollSoon(1500); }
  if (!state.shuffle) { wantSmart(false); return setShuffle(true); }
  if (!state.smart) { wantSmart(true); emit(); bus.emit('smart-on'); return; }
  wantSmart(false);
  return setShuffle(false);
}
export function cycleRepeat() {
  const mode = { off: 'context', context: 'track', track: 'off' }[state.repeat] || 'off';
  if (state.files) { files.repeat = mode; store.set('gw.fileRepeat', mode); state.repeat = mode; return emit(); }
  if (DEMO) return demoBackend.setRepeat(mode);
  state.repeat = mode; emit();
  return send('PUT', '/me/player/repeat', { query: { state: mode, device_id: target() } });
}

// ---- devices and queue ---------------------------------------------------------------------
export async function getDevices() {
  if (DEMO) return demoBackend.devices();
  const r = await api('GET', '/me/player/devices');
  return (r && r.devices) || [];
}
export async function transfer(id) {
  if (DEMO) { stopFiles(); return demoBackend.transfer(id); }
  unlockAudio();
  const ok = await send('PUT', '/me/player', { body: { device_ids: [id], play: true } });
  if (ok) { stopFiles(); pollSoon(900); }
}
export async function getQueue() {
  if (state.files) return { currently_playing: state.track, queue: files.order.slice(files.at + 1, files.at + 41).map(i => files.list[i]) };
  if (DEMO) return demoBackend.queue();
  const r = await api('GET', '/me/player/queue');
  return { currently_playing: fromApi(r && r.currently_playing), queue: ((r && r.queue) || []).map(fromApi).filter(Boolean) };
}
export async function addToQueue(uri, quiet) {
  if (DEMO) { const ok = demoBackend.addToQueue(uri); if (ok) { if (!quiet) toast('Added to queue'); bus.emit('queue-changed'); } return ok; }
  const id = target();
  if (!id) { if (!quiet) toast('Start playing something first, then add to the queue.'); return false; }
  const ok = await send('POST', '/me/player/queue', { query: { uri, device_id: id } }, quiet);
  if (ok) { if (!quiet) toast('Added to queue'); bus.emit('queue-changed'); }
  return ok;
}

// ---- music files on this computer (Local Files) ---------------------------------------------
// These play through an ordinary audio element in this window. Spotify is not involved:
// starting a file pauses Spotify, and starting anything from Spotify stops the file.
const audio = typeof Audio === 'function' ? new Audio() : null;
const files = { list: [], order: [], at: -1, shuffle: store.get('gw.fileShuffle', false), repeat: store.get('gw.fileRepeat', 'off') };
let filesSince = 0, fileErrors = 0;

function fileSync() {
  if (!state.files) return;
  state.paused = audio.paused || audio.ended;
  state.position = audio.currentTime * 1000; state.ts = Date.now();
  if (isFinite(audio.duration) && audio.duration > 0) state.duration = audio.duration * 1000;
  emit();
}
if (audio) {
  audio.preload = 'auto';
  for (const ev of ['play', 'playing', 'pause', 'seeked', 'waiting', 'durationchange']) audio.addEventListener(ev, fileSync);
  audio.addEventListener('loadedmetadata', () => {
    fileSync(); fileErrors = 0;
    if (state.files && isFinite(audio.duration)) bus.emit('file-length', { track: state.track, ms: audio.duration * 1000 });
  });
  audio.addEventListener('ended', () => { if (state.files) fileNext(true); });
  audio.addEventListener('error', () => {
    if (!state.files || !audio.getAttribute('src')) return;
    toast('That file couldn’t be played. It may have moved, or its format isn’t supported.', { error: true });
    if (++fileErrors < 3 && files.at + 1 < files.order.length) fileNext(true); else { state.paused = true; emit(); }
  });
}
function hushSpotify() {
  if (state.files || state.paused) return;
  if (DEMO) return demoBackend.toggle();
  if (state.isLocal && sdk) sdk.pause().catch(() => {});
  else if (remote()) send('PUT', '/me/player/pause', { query: { device_id: remote() } }, true);
}
function stopFiles() {
  if (!state.files) return;
  state.files = false;
  try { audio.pause(); } catch { /* nothing was playing */ }
}
function mediaInfo(t) {
  if (!('mediaSession' in navigator) || !t) return;
  try {
    navigator.mediaSession.metadata = new window.MediaMetadata({
      title: t.name, artist: (t.artists || []).map(a => a.name).join(', '), album: (t.album && t.album.name) || '',
      artwork: ((t.album && t.album.images) || []).map(im => ({ src: im.url })),
    });
    navigator.mediaSession.setActionHandler('play', () => toggle());
    navigator.mediaSession.setActionHandler('pause', () => toggle());
    navigator.mediaSession.setActionHandler('nexttrack', () => next());
    navigator.mediaSession.setActionHandler('previoustrack', () => prev());
  } catch { /* media keys are a nicety */ }
}
function startFile(pos, play = true) {
  hushSpotify();
  files.at = pos;
  const t = files.list[files.order[pos]];
  filesSince = Date.now();
  if (!state.files) state.volume = localLevel();
  state.files = true; state.track = t; state.isLocal = false; state.device = null; state.contextUri = null;
  state.position = 0; state.duration = t.duration_ms || 0; state.ts = Date.now(); state.paused = !play;
  state.shuffle = files.shuffle; state.repeat = files.repeat;
  audio.src = t.url; audio.volume = loudness(state.volume);
  if (audioCtx && audioCtx.state !== 'running') audioCtx.resume().catch(() => {});
  if (play) audio.play().catch(() => { state.paused = true; emit(); });
  mediaInfo(t);
  emit();
  bus.emit('file-playing', t);
}
function reorder() {
  const cur = files.order[files.at];
  let order = files.list.map((_, i) => i);
  if (files.shuffle) {
    order = order.filter(i => i !== cur);
    for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
    order.unshift(cur);
    files.at = 0;
  } else files.at = cur;
  files.order = order;
}
function fileNext(auto) {
  if (auto && files.repeat === 'track') { audio.currentTime = 0; audio.play().catch(() => {}); return; }
  if (files.at + 1 < files.order.length) return startFile(files.at + 1);
  if (!auto || files.repeat === 'context') return startFile(0);
  audio.pause(); audio.currentTime = 0; fileSync();                // the end of the list
}
function filePrev() {
  if (audio.currentTime > 3 || files.at <= 0) { audio.currentTime = 0; return; }
  startFile(files.at - 1);
}
export function playFiles(list, index = 0) {
  if (!audio || !list.length) return;
  files.list = list.slice();
  files.order = files.list.map((_, i) => i);
  files.at = Math.max(0, Math.min(index, list.length - 1));
  if (files.shuffle) reorder();
  startFile(files.at);
}
export function queueFile(t) {
  if (!state.files) return playFiles([t], 0);
  files.list.push(t);
  files.order.splice(files.at + 1, 0, files.list.length - 1);
  toast('Playing next');
  emit();
  bus.emit('queue-changed');
}
// Something about the current song changed (its cover picture arrived, say).
export function refresh() { if (state.files) mediaInfo(state.track); emit(); }

// The visualizer's ear for a playing file: how loud each pitch is at this instant.
let audioCtx = null, analyserNode = null;
export function fileAnalyser() {
  if (!audio) return null;
  if (!analyserNode) {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      audioCtx = new AC();
      const source = audioCtx.createMediaElementSource(audio);
      analyserNode = audioCtx.createAnalyser();
      analyserNode.fftSize = 2048; analyserNode.minDecibels = -90; analyserNode.maxDecibels = -10; analyserNode.smoothingTimeConstant = 0.5;
      source.connect(analyserNode);
      analyserNode.connect(audioCtx.destination);
    } catch { analyserNode = null; return null; }
  }
  if (audioCtx.state !== 'running') audioCtx.resume().catch(() => {});
  return { node: analyserNode, rate: audioCtx.sampleRate };
}
