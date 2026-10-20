// ============================================================================
// LunaCore - Life dashboard: weekly goals store (main process, W4)
// ----------------------------------------------------------------------------
// config/life-goals.local.json:
//   {v: 1, weeks: {'2026-W43': [{text, status}]}}
//   up to 3 goals per ISO week, 1-140 chars each; status is set by hand:
//   'done' | 'partly' | 'notyet' (the default). An empty list = the week's
//   prompt was skipped, so it is not asked again. The newest MAX_WEEKS weeks
//   are kept. Writes are allowed for weeks near now only (EDIT_BACK weeks back,
//   one ahead). Persistence and the read/write contract: src/lifestore.js.
// ============================================================================

'use strict';

const { createStore, cleanText } = require('./lifestore');
const { ymd, isWeek, isoWeek, weekMonday, addDays, dayDiff } = require('./lifedays');

const MAX_GOALS = 3;
const MAX_TEXT = 140;
const MAX_WEEKS = 52;
const EDIT_BACK = 8;
const STATUSES = ['notyet', 'partly', 'done'];

const defaults = () => ({ v: 1, weeks: {} });

function goalOf(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const text = cleanText(raw.text, MAX_TEXT);
  return text ? { text, status: STATUSES.includes(raw.status) ? raw.status : 'notyet' } : null;
}

/** Sortable form of a week key: '2026-W43' sorts as a string already (zero-padded). */
function normalize(raw) {
  const src = raw && typeof raw === 'object' && raw.weeks && typeof raw.weeks === 'object' ? raw.weeks : {};
  const keys = Object.keys(src)
    .filter((k) => isWeek(k) && Array.isArray(src[k]))
    .sort()
    .slice(-MAX_WEEKS);
  return { v: 1, weeks: Object.fromEntries(keys.map((k) => [k, src[k].map(goalOf).filter(Boolean).slice(0, MAX_GOALS)])) };
}

function checkWeek(week, nowMs) {
  if (!isWeek(week)) throw new Error('bad week');
  const weeks = dayDiff(weekMonday(week), weekMonday(isoWeek(ymd(nowMs)))) / 7;
  if (weeks < -1 || weeks > EDIT_BACK) throw new Error('bad week');
}

const OPS = {
  /** Replaces a week's goals; a goal whose text is unchanged keeps its status. */
  set(s, d) {
    if (!Array.isArray(d.goals)) throw new Error('bad value');
    if (d.goals.length > MAX_GOALS) throw new Error('too many');
    const before = s.weeks[d.week] || [];
    const goals = d.goals.map((g) => {
      const text = cleanText(g, MAX_TEXT);
      if (!text) throw new Error('bad text');
      const prev = before.find((b) => b.text === text);
      return { text, status: prev ? prev.status : 'notyet' };
    });
    return { ...s, weeks: { ...s.weeks, [d.week]: goals } };
  },
  status(s, d) {
    const goals = s.weeks[d.week];
    if (!goals || !Number.isInteger(d.index) || d.index < 0 || d.index >= goals.length) throw new Error('not found');
    if (!STATUSES.includes(d.status)) throw new Error('bad value');
    return { ...s, weeks: { ...s.weeks, [d.week]: goals.map((g, i) => (i === d.index ? { ...g, status: d.status } : g)) } };
  },
};

const OP_NAMES = Object.keys(OPS);

const store = createStore({ fileName: 'life-goals.local.json', defaults, normalize });

const loadGoals = (file) => store.load(file);

function applyGoals(op, data, file, nowMs = Date.now()) {
  if (!OP_NAMES.includes(op)) throw new Error('bad op');
  if (!data || typeof data !== 'object') throw new Error('bad payload');
  checkWeek(data.week, nowMs);
  return store.update((cur) => OPS[op](cur, data), file);
}

/** done = 1, partly = 0.5, not yet = 0, averaged; null when the week has no goals. */
function goalsFraction(goals) {
  if (!Array.isArray(goals) || !goals.length) return null;
  return goals.reduce((sum, g) => sum + (g.status === 'done' ? 1 : g.status === 'partly' ? 0.5 : 0), 0) / goals.length;
}

/** This week's goals (null = not asked yet, [] = skipped) and last week's for a look back. */
function goalsView(s, nowMs = Date.now()) {
  const today = ymd(nowMs);
  const week = isoWeek(today);
  const lastWeek = isoWeek(addDays(today, -7));
  return { week, goals: s.weeks[week] || null, lastWeek, last: s.weeks[lastWeek] || null, isMonday: new Date(nowMs).getDay() === 1 };
}

module.exports = { loadGoals, applyGoals, goalsView, goalsFraction, normalize, OP_NAMES, MAX_GOALS, MAX_TEXT, STATUSES };
