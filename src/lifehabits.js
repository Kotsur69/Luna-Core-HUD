// ============================================================================
// LunaCore - Life dashboard: habits store (main process)
// ----------------------------------------------------------------------------
// config/life-habits.local.json:
//   {v: 1, habits: [{id, name, every 'day'|'week', perWeek 1-7, auto, done}]}
//   name   '' = a built-in suggestion, localized by id in the renderer
//   perWeek how many days a week an 'every: week' habit needs (7 for daily)
//   auto   'steps' = also done on days YAZIO's steps reached the goal
//          (computed in lifeipc.js, never written here); '' otherwise
//   done   ticked days 'YYYY-MM-DD', sorted, the newest MAX_DONE kept
// A missing file starts with four suggestions (gym, steps, water, no late
// snacks), all editable and deletable. Writes go through a fixed op table
// that validates every field; ticks are allowed for today and yesterday only.
// Persistence and the read/write contract: src/lifestore.js.
// ============================================================================

'use strict';

const { createStore, cleanText, newId } = require('./lifestore');
const { ymd, isDay, addDays } = require('./lifedays');

const MAX_HABITS = 30;
const MAX_NAME = 40;
const MAX_DONE = 400;
const ID_RE = /^[a-z0-9-]{1,40}$/;
const EVERY = ['day', 'week'];
const AUTO = ['', 'steps'];

const SUGGESTIONS = [
  { id: 'gym', every: 'week', perWeek: 3, auto: '' },
  { id: 'steps', every: 'day', perWeek: 7, auto: 'steps' },
  { id: 'water', every: 'day', perWeek: 7, auto: '' },
  { id: 'snacks', every: 'day', perWeek: 7, auto: '' },
];

const defaults = () => ({ v: 1, habits: SUGGESTIONS.map((h) => ({ ...h, name: '', done: [] })) });

/** A stored habit with every field valid, or null. */
function habitOf(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || !ID_RE.test(raw.id)) return null;
  const name = raw.name === '' ? '' : cleanText(raw.name, MAX_NAME);
  if (name === null || !EVERY.includes(raw.every)) return null;
  const perWeek = raw.every === 'day' ? 7 : raw.perWeek;
  if (!Number.isInteger(perWeek) || perWeek < 1 || perWeek > 7) return null;
  const auto = AUTO.includes(raw.auto) ? raw.auto : '';
  const done = [...new Set(Array.isArray(raw.done) ? raw.done.filter(isDay) : [])].sort().slice(-MAX_DONE);
  return { id: raw.id, name, every: raw.every, perWeek, auto, done };
}

function normalize(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.habits)) return defaults();
  const seen = new Set();
  const habits = [];
  for (const h of raw.habits) {
    const clean = habitOf(h);
    if (!clean || seen.has(clean.id)) continue;
    seen.add(clean.id);
    habits.push(clean);
    if (habits.length >= MAX_HABITS) break;
  }
  return { v: 1, habits };
}

// --- ops ------------------------------------------------------------------------

function nameOf(v) {
  const s = cleanText(v, MAX_NAME);
  if (s === null) throw new Error('bad text');
  return s;
}

function scheduleOf(d) {
  if (!EVERY.includes(d.every)) throw new Error('bad value');
  if (d.every === 'day') return { every: 'day', perWeek: 7 };
  if (!Number.isInteger(d.perWeek) || d.perWeek < 1 || d.perWeek > 7) throw new Error('bad value');
  return { every: 'week', perWeek: d.perWeek };
}

function findIndex(s, id) {
  const i = typeof id === 'string' ? s.habits.findIndex((h) => h.id === id) : -1;
  if (i < 0) throw new Error('not found');
  return i;
}

const replaceAt = (list, i, row) => list.map((x, j) => (j === i ? row : x));

const OPS = {
  add(s, d) {
    if (s.habits.length >= MAX_HABITS) throw new Error('too many');
    const row = { id: newId(), name: nameOf(d.name), ...scheduleOf(d), auto: '', done: [] };
    return { ...s, habits: [...s.habits, row] };
  },
  edit(s, d) {
    const i = findIndex(s, d.id);
    const cur = s.habits[i];
    const name = d.name === undefined ? cur.name : nameOf(d.name);
    const schedule = d.every === undefined ? { every: cur.every, perWeek: cur.perWeek } : scheduleOf(d);
    return { ...s, habits: replaceAt(s.habits, i, { ...cur, name, ...schedule }) };
  },
  remove(s, d) {
    const i = findIndex(s, d.id);
    return { ...s, habits: s.habits.filter((_, j) => j !== i) };
  },
  /** Undo of remove: the row as it was, back at its place. */
  restore(s, d) {
    const clean = habitOf(d.habit);
    if (!clean) throw new Error('bad value');
    // Only the built-in steps habit may auto-tick; the renderer cannot grant it.
    const builtIn = SUGGESTIONS.find((h) => h.id === clean.id);
    const row = { ...clean, auto: builtIn ? builtIn.auto : '' };
    if (s.habits.some((h) => h.id === row.id)) throw new Error('bad id');
    if (s.habits.length >= MAX_HABITS) throw new Error('too many');
    const at = Number.isInteger(d.index) ? Math.max(0, Math.min(d.index, s.habits.length)) : s.habits.length;
    return { ...s, habits: [...s.habits.slice(0, at), row, ...s.habits.slice(at)] };
  },
  tick(s, d, nowMs) {
    const i = findIndex(s, d.id);
    const today = ymd(nowMs);
    if (!isDay(d.date) || (d.date !== today && d.date !== addDays(today, -1))) throw new Error('bad date');
    if (typeof d.on !== 'boolean') throw new Error('bad value');
    const cur = s.habits[i];
    const rest = cur.done.filter((x) => x !== d.date);
    const done = d.on ? [...rest, d.date].sort() : rest;
    return { ...s, habits: replaceAt(s.habits, i, { ...cur, done }) };
  },
};

const OP_NAMES = Object.keys(OPS);

const store = createStore({ fileName: 'life-habits.local.json', defaults, normalize });

const loadHabits = (file) => store.load(file);

/** One validated change, saved. Throws a fixed error message on bad input. */
function applyHabits(op, data, file, nowMs = Date.now()) {
  if (!OP_NAMES.includes(op)) throw new Error('bad op');
  if (!data || typeof data !== 'object') throw new Error('bad payload');
  return store.update((cur) => OPS[op](cur, data, nowMs), file);
}

module.exports = { loadHabits, applyHabits, normalize, OP_NAMES, MAX_HABITS, MAX_NAME };
