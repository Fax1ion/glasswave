// Desktop-wide shortcuts: key combos for previous, play/pause and next that work wherever you
// are (in a game, say), not just while Glasswave is in front.
//
// The combos are chosen on the Settings page and kept in this browser profile. Glasswave's own
// window (the app) asks Windows to pass those keys to it from anywhere. In a browser tab they
// only work while Glasswave is in front, because browsers cannot listen to the whole desktop.

import { store, bus } from './util.js';

export const ACTIONS = [
  ['prev', 'Previous song'],
  ['toggle', 'Play / pause'],
  ['next', 'Next song'],
  ['fullscreen', 'Full screen'],
];

// Windows' numbers for the modifier keys.
const ALT = 1, CTRL = 2, SHIFT = 4, WIN = 8;
const MODIFIER_KEYS = new Set([16, 17, 18, 91, 92, 93, 224]);

// What the window reported for each combo: 'ok', 'taken' (another program has it), 'none',
// or 'old' (this window cannot do desktop-wide shortcuts until Glasswave is reopened).
export const status = { prev: 'none', toggle: 'none', next: 'none', fullscreen: 'none' };

export function getKeys() {
  const k = store.get('gw.hotkeys', {});
  return k && typeof k === 'object' ? k : {};
}

export function setKey(action, combo) {
  const keys = getKeys();
  if (combo) keys[action] = combo; else delete keys[action];
  store.set('gw.hotkeys', keys);
  bus.emit('hotkeys-changed');
}

// "prev=6,37;toggle=;next=6,39": what the window needs (modifiers, key) for each action.
export function encode(keys = getKeys()) {
  return ACTIONS.map(([a]) => a + '=' + (keys[a] ? keys[a].mods + ',' + keys[a].vk : '')).join(';');
}

const NAMES = {
  8: 'Backspace', 9: 'Tab', 13: 'Enter', 19: 'Pause', 32: 'Space', 33: 'Page Up', 34: 'Page Down', 35: 'End', 36: 'Home',
  37: '←', 38: '↑', 39: '→', 40: '↓', 45: 'Insert', 46: 'Delete', 106: 'Num *', 107: 'Num +', 109: 'Num -',
  110: 'Num .', 111: 'Num /', 144: 'Num Lock', 145: 'Scroll Lock', 173: 'Mute key', 174: 'Volume down key', 175: 'Volume up key',
  176: 'Next track key', 177: 'Previous track key', 178: 'Stop key', 179: 'Play/Pause key',
  186: ';', 187: '=', 188: ',', 189: '-', 190: '.', 191: '/', 192: '`', 219: '[', 220: '\\', 221: ']', 222: "'",
};
function keyName(vk, e) {
  if (NAMES[vk]) return NAMES[vk];
  if ((vk >= 48 && vk <= 57) || (vk >= 65 && vk <= 90)) return String.fromCharCode(vk);
  if (vk >= 96 && vk <= 105) return 'Num ' + (vk - 96);
  if (vk >= 112 && vk <= 135) return 'F' + (vk - 111);
  return e && e.key && e.key.length === 1 ? e.key.toUpperCase() : (e && e.code) || 'Key ' + vk;
}

export function label(combo) {
  const parts = [];
  if (combo.mods & CTRL) parts.push('Ctrl');
  if (combo.mods & ALT) parts.push('Alt');
  if (combo.mods & SHIFT) parts.push('Shift');
  if (combo.mods & WIN) parts.push('Win');
  parts.push(combo.name);
  return parts.join(' + ');
}

function modsOf(e) {
  return (e.altKey ? ALT : 0) | (e.ctrlKey ? CTRL : 0) | (e.shiftKey ? SHIFT : 0) | (e.metaKey ? WIN : 0);
}

// Keys that are fine on their own: function keys, media keys, Pause, Scroll Lock, Insert.
const ALONE_OK = vk => (vk >= 112 && vk <= 135) || (vk >= 173 && vk <= 179) || vk === 19 || vk === 145 || vk === 45;

// Reads a key press while a combo is being chosen. Gives:
//   { partial: 'Ctrl + Alt + ...' }     only modifier keys are down so far
//   { combo: { vk, mods, name } }        a usable combo
//   { error: '...' }                     a combo that would get in the way of normal typing
export function fromEvent(e) {
  const vk = e.keyCode || 0;
  const mods = modsOf(e);
  if (!vk || MODIFIER_KEYS.has(vk)) {
    const held = label({ mods, name: '' }).replace(/ \+ $/, '');
    return { partial: held ? held + ' + …' : '' };
  }
  const name = keyName(vk, e);
  if (!ALONE_OK(vk) && !(mods & (CTRL | ALT | WIN))) {
    return { error: (mods & SHIFT ? 'Shift + ' : '') + name + ' on its own would stop that key working everywhere else. Add Ctrl or Alt (for example Ctrl + Alt + ' + name + ').' };
  }
  return { combo: { vk, mods, name } };
}

export function same(a, b) {
  return !!a && !!b && a.vk === b.vk && a.mods === b.mods;
}

// For a browser tab: does this key press match one of the combos?
export function actionFor(e) {
  const keys = getKeys();
  const mods = modsOf(e);
  for (const [a] of ACTIONS) if (keys[a] && keys[a].vk === e.keyCode && keys[a].mods === mods) return a;
  return null;
}

export function setStatus(text) {
  for (const part of text.split(';')) {
    const [a, v] = part.split('=');
    if (a in status) status[a] = v || 'none';
  }
  bus.emit('hotkeys-status');
}
