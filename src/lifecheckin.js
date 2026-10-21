// ============================================================================
// LunaCore - Life dashboard: daily check-in store (main process)
// ----------------------------------------------------------------------------
// config/life-checkin.local.json:
//   {v: 1, days: {'YYYY-MM-DD': {sleep, energy}}}
//   sleep  hours slept, 0-16 in 0.5 steps, or null
//   energy 1-5, or null
// A day with both null = the prompt was skipped that day (asked, answered
// "not now"), so the first dashboard open of the day asks only once. The
// newest MAX_DAYS days are kept. Only today and the last EDIT_DAYS days can
// be written. Persistence and the read/write contract: src/lifestore.js.
// ============================================================================

'use strict';

const { createStore } = require('./lifestore');
const { ymd, isDay, addDays, dayDiff } = require('./lifedays');

const MAX_DAYS = 400;
const EDIT_DAYS = 14;
const MAX_SLEEP = 16;
const MAX_ENERGY = 5;

const defaults = () => ({ v: 1, days: {} });

const validSleep = (v) => v === null || (typeof v === 'number' && v >= 0 && v <= MAX_SLEEP && Number.isInteger(v * 2));
const validEnergy = (v) => v === null || (Number.isInteger(v) && v >= 1 && v <= MAX_ENERGY);

/** {sleep, energy} with both fields valid, or null. */
function entryOf(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const sleep = raw.sleep === undefined ? null : raw.sleep;
  const energy = raw.energy === undefined ? null : raw.energy;
  return validSleep(sleep) && validEnergy(energy) ? { sleep, energy } : null;
}

/** Valid days only, the newest MAX_DAYS, sorted by date. */
function normalize(raw) {
  const src = raw && typeof raw === 'object' && raw.days && typeof raw.days === 'object' ? raw.days : {};
  const days = Object.keys(src)
    .filter((d) => isDay(d) && entryOf(src[d]))
    .sort()
    .slice(-MAX_DAYS);
  return { v: 1, days: Object.fromEntries(days.map((d) => [d, entryOf(src[d])])) };
}

const store = createStore({ fileName: 'life-checkin.local.json', defaults, normalize });

const loadCheckin = (file) => store.load(file);

/**
 * Writes one day. Throws 'bad date' (not today or the last EDIT_DAYS days),
 * 'bad value' (a field out of range), 'unreadable' (the file cannot be read).
 */
function setCheckin(date, entry, file, nowMs = Date.now()) {
  const today = ymd(nowMs);
  if (!isDay(date)) throw new Error('bad date');
  const back = dayDiff(date, today);
  if (back < 0 || back > EDIT_DAYS) throw new Error('bad date');
  const clean = entry && typeof entry === 'object' ? entryOf(entry) : null;
  if (!clean || entry.sleep === undefined || entry.energy === undefined) throw new Error('bad value');
  return store.update((cur) => ({ ...cur, days: { ...cur.days, [date]: clean } }), file);
}

/** What the renderer gets: today's entry (null = not asked yet) + today and the last 14 days. */
function checkinView(s, nowMs = Date.now()) {
  const today = ymd(nowMs);
  const days = Array.from({ length: EDIT_DAYS + 1 }, (_, i) => {
    const date = addDays(today, -i);
    const e = s.days[date];
    return { date, sleep: e ? e.sleep : null, energy: e ? e.energy : null, answered: Boolean(e) };
  });
  return { today, entry: s.days[today] || null, days };
}

module.exports = { loadCheckin, setCheckin, checkinView, normalize, EDIT_DAYS };
