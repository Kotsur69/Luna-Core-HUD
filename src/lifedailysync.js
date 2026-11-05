// ============================================================================
// LunaCore - Life daily stores shared between PCs (main)
// ----------------------------------------------------------------------------
// Check-in, habits, weekly goals and score settings sync through the cloud's
// `config` scope as four src/configsync.js providers. Why not the 'life'
// scope next to the budget: lifesync.js syncs exactly one store and a cloud
// scope has one publisher (cloudsync.published() replaces the whole body), so
// adding stores there means rebuilding lifesync's meta and publish path.
// configsync already merges several stores per scope with the same unit
// model (stamp/merge from lifesync.js: newest `u` wins per unit, a delete is
// a tombstone) and skips a store that fails without touching the others.
// The budget sync is untouched.
//
// Units (values are always plain objects):
//   life:ci:<YYYY-MM-DD>          one check-in day {sleep, energy}
//   life:hb:<habitId>             one habit definition (without its ticks)
//   life:ht:<habitId>:<YYYY-MM-DD> one ticked habit day, value {}
//   life:wg:<YYYY-Www>            one week's goals {goals: [{text, status}]}
//                                 (goals have no id, so a week is the unit)
//   life:score                    the score settings {weights, focusTargetH}
//
// - A missing local file is never "everything was deleted": the store reads
//   as fresh (no units, previous snapshot ignored) and takes its peers' data.
//   It publishes nothing of its own defaults, so a fresh PC's suggestion
//   habits or default weights can never beat (or resurrect) real data.
// - A file that exists but is unreadable throws; one that parses yet lost
//   rows to normalize() (a hand edit) throws 'suspect'. Either way configsync
//   skips that store before any write, as lifesync.js does for the budget.
// - Peer data is untrusted: every unit goes through the store's own
//   normalize() and is dropped unless it survives unchanged.
// ============================================================================

'use strict';

const checkin = require('./lifecheckin');
const habits = require('./lifehabits');
const goals = require('./lifegoals');
const score = require('./lifescoreprefs');
const { isDay, isWeek } = require('./lifedays');

const CI = 'life:ci:';
const HB = 'life:hb:';
const HT = 'life:ht:';
const WG = 'life:wg:';
const SCORE_KEY = 'life:score';
const CI_RE = /^life:ci:(\d{4}-\d{2}-\d{2})$/;
const HB_RE = /^life:hb:([a-z0-9-]{1,40})$/;
const HT_RE = /^life:ht:([a-z0-9-]{1,40}):(\d{4}-\d{2}-\d{2})$/;
const WG_RE = /^life:wg:(\d{4}-W\d{2})$/;

const isPlainObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

/** Key-order-independent deep form, for "survives normalize() unchanged". */
function sorted(v) {
  if (Array.isArray(v)) return v.map(sorted);
  if (!isPlainObject(v)) return v;
  return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted(v[k])]));
}
const same = (a, b) => JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));
const count = (obj) => (isPlainObject(obj) ? Object.keys(obj).length : 0);

// --- check-in: one unit per day ------------------------------------------------

const CHECKIN = {
  name: 'lifeCheckin',
  part: 'checkin',
  store: checkin.store,
  defaults: () => checkin.normalize(null),
  owns: (k) => k.startsWith(CI),
  toUnits: (s) => Object.entries(s.days).map(([d, e]) => [CI + d, e]),
  fromUnits: (units) => checkin.normalize({ days: Object.fromEntries(units.map(([k, v]) => [k.slice(CI.length), v])) }),
  valid(k, v) {
    const m = CI_RE.exec(k);
    if (!m || !isDay(m[1]) || !isPlainObject(v)) return null;
    const clean = checkin.normalize({ days: { [m[1]]: v } }).days[m[1]];
    return clean && same(clean, v) ? clean : null;
  },
  lossy: (raw, s) => !isPlainObject(raw) || !isPlainObject(raw.days) || count(raw.days) > count(s.days),
};

// --- habits: one unit per definition, one per ticked day --------------------------

const habitDef = (h) => ({ id: h.id, name: h.name, every: h.every, perWeek: h.perWeek, auto: h.auto });
const tickCount = (list) => list.reduce((n, h) => n + (h && Array.isArray(h.done) ? h.done.length : 0), 0);

const HABITS = {
  name: 'lifeHabits',
  part: 'habits',
  store: habits.store,
  defaults: () => habits.normalize(null),
  owns: (k) => k.startsWith(HB) || k.startsWith(HT),
  toUnits: (s) => s.habits.flatMap((h) => [[HB + h.id, habitDef(h)], ...h.done.map((d) => [`${HT}${h.id}:${d}`, {}])]),
  fromUnits(units) {
    const defs = [];
    const ticks = new Map();
    for (const [k, v] of units) {
      const t = HT_RE.exec(k);
      if (t) ticks.set(t[1], [...(ticks.get(t[1]) || []), t[2]]);
      else if (HB_RE.test(k)) defs.push(v);
    }
    // A tick whose habit is gone (deleted on another PC) is dropped here.
    return habits.normalize({ habits: defs.map((d) => ({ ...d, done: ticks.get(d.id) || [] })) });
  },
  valid(k, v) {
    if (!isPlainObject(v)) return null;
    const t = HT_RE.exec(k);
    if (t) return isDay(t[2]) && Object.keys(v).length === 0 ? {} : null;
    const m = HB_RE.exec(k);
    // 'life:hb:aaa' carrying id 'bbb' would take the real 'bbb' habit's place.
    if (!m || v.id !== m[1]) return null;
    // Only the built-in steps habit may auto-tick (as in lifehabits' restore op).
    if (v.auto === 'steps' && v.id !== 'steps') return null;
    const clean = habits.normalize({ habits: [{ ...v, done: [] }] }).habits[0];
    return clean && same(habitDef(clean), v) ? habitDef(clean) : null;
  },
  lossy: (raw, s) =>
    !isPlainObject(raw) || !Array.isArray(raw.habits) || raw.habits.length > s.habits.length || tickCount(raw.habits) > tickCount(s.habits),
};

// --- weekly goals: one unit per week -------------------------------------------------

const goalCount = (weeks) => Object.values(weeks).reduce((n, list) => n + (Array.isArray(list) ? list.length : 0), 0);

const GOALS = {
  name: 'lifeGoals',
  part: 'goals',
  store: goals.store,
  defaults: () => goals.normalize(null),
  owns: (k) => k.startsWith(WG),
  toUnits: (s) => Object.entries(s.weeks).map(([w, list]) => [WG + w, { goals: list }]),
  fromUnits: (units) => goals.normalize({ weeks: Object.fromEntries(units.map(([k, v]) => [k.slice(WG.length), v.goals])) }),
  valid(k, v) {
    const m = WG_RE.exec(k);
    if (!m || !isWeek(m[1]) || !isPlainObject(v) || Object.keys(v).length !== 1 || !Array.isArray(v.goals)) return null;
    const clean = goals.normalize({ weeks: { [m[1]]: v.goals } }).weeks[m[1]];
    return clean && same(clean, v.goals) ? { goals: clean } : null;
  },
  lossy: (raw, s) =>
    !isPlainObject(raw) || !isPlainObject(raw.weeks) || count(raw.weeks) > count(s.weeks) || goalCount(raw.weeks) > goalCount(s.weeks),
};

// --- score settings: one unit for the whole object -------------------------------------

const scoreValue = (s) => ({ weights: s.weights, focusTargetH: s.focusTargetH });

const SCORE = {
  name: 'lifeScore',
  part: 'score',
  store: score.store,
  defaults: () => score.normalize(null),
  owns: (k) => k === SCORE_KEY,
  toUnits: (s) => [[SCORE_KEY, scoreValue(s)]],
  fromUnits(units) {
    const unit = units.find(([k]) => k === SCORE_KEY);
    return score.normalize(unit ? unit[1] : {});
  },
  valid(k, v) {
    if (k !== SCORE_KEY || !isPlainObject(v) || Object.keys(v).length !== 2) return null;
    const clean = scoreValue(score.normalize(v));
    return same(clean, v) ? clean : null;
  },
  // Weights the file has but normalize() replaced by defaults must not go out as an edit.
  lossy: (raw, s) => !isPlainObject(raw) || !same(scoreValue(s), { weights: raw.weights, focusTargetH: raw.focusTargetH }),
};

const SPECS = [CHECKIN, HABITS, GOALS, SCORE];
const PART_OF = Object.fromEntries(SPECS.map((s) => [s.name, s.part]));

/** One configsync provider for a daily store kept in `file`. */
function createLifeProvider(spec, file) {
  // The store's untouched defaults (suggestion habits, equal score weights):
  // configsync stamps them 0 on a first sync, so they never beat real data.
  const defaults = new Map(spec.toUnits(spec.defaults()).map(([k, v]) => [k, JSON.stringify(sorted(v))]));
  const isDefault = (k, v) => defaults.get(k) === JSON.stringify(sorted(v));
  return {
    name: spec.name,
    owns: spec.owns,
    valid: spec.valid,
    read(now) {
      const local = spec.store.readForSync(file);
      if (!local.exists) return { units: [], base: 0, fresh: true };
      if (spec.lossy(local.raw, local.data)) throw new Error('suspect');
      const units = spec.toUnits(local.data);
      const base = Math.floor(Math.min(local.mtimeMs, now));
      // A default the existing file no longer has was deleted here (a removed
      // suggestion habit): on a first sync it goes out as a delete. configsync
      // reads `gone` only when it has no snapshot of this store yet.
      const have = new Set(units.map(([k]) => k));
      const gone = Object.fromEntries([...defaults.keys()].filter((k) => !have.has(k)).map((k) => [k, base]));
      return { units, base, gone, isDefault };
    },
    // Through normalize() once more: drops orphan ticks and keeps the store's caps.
    // Nothing merged -> nothing kept: a fresh PC must not invent default units.
    resolve: (merged) => (merged.length ? spec.toUnits(spec.fromUnits(merged)) : []),
    write(units) {
      spec.store.update(() => spec.fromUnits(units), file);
    },
  };
}

/**
 * The four providers for startConfigSync().
 * @param {{checkin?:string, habits?:string, goals?:string, score?:string}} files
 *   per-part file overrides (tests); the stores' own files by default
 */
const lifeProviders = (files = {}) => SPECS.map((s) => createLifeProvider(s, files[s.part] || s.store.defaultFile()));

/** configsync's changed provider names -> the renderer's daily parts ('checkin', 'habits', ...). */
const lifeParts = (names) => names.filter((n) => Object.hasOwn(PART_OF, n)).map((n) => PART_OF[n]);

module.exports = { lifeProviders, lifeParts, CHECKIN, HABITS, GOALS, SCORE };
