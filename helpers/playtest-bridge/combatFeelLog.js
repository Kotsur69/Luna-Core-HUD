// ============================================================================
// LunaCore - the optional combatFeelLog of a Unity game's PlaytestDriver state
// ----------------------------------------------------------------------------
// A game may keep a ring buffer of combat timing samples and hand it back in
// its `playtest state` snapshot as `combatFeelLog`: an array of flat entries,
// every field optional:
//
//   hitStopFrames          int    frames the hit-stop froze the game
//   hitStopMs              number the same freeze in ms
//   hitStopIntendedFrames  int    what the attack data asked for
//   inputLatencyMs         number input press -> hitbox active
//   hitboxToVfxFrames      int    hitbox active -> VFX spawned (may be < 0)
//   timeScale              {from, to, reason, atMs}  one Time.timeScale change
//                          by the time-scale owner (reason e.g. "DeadSecond")
//
// The snapshot comes from the game, so the log is untrusted: only finite
// numbers in sane ranges and short plain strings pass; an entry with any
// malformed field is dropped whole; unknown keys are dropped; at most
// MAX_COMBAT_FEEL_ENTRIES (the newest) are kept.
// ============================================================================

'use strict';

const MAX_COMBAT_FEEL_ENTRIES = 200;
// Raw entries looked at, newest first: bounds the work on a huge array.
const MAX_RAW_SCAN = 1000;
const MAX_FRAMES = 600;
const MAX_DURATION_MS = 10_000;
const MAX_LATENCY_MS = 5_000;
const MAX_TIME_SCALE = 10;
// One day of play time, in ms.
const MAX_AT_MS = 24 * 60 * 60 * 1000;
const REASON_RE = /^[A-Za-z0-9 _.:-]{1,40}$/;

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const inRange = (v, min, max) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
const intInRange = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;

/** field -> check of its value. */
const NUMBER_FIELDS = Object.freeze({
  hitStopFrames: (v) => intInRange(v, 0, MAX_FRAMES),
  hitStopMs: (v) => inRange(v, 0, MAX_DURATION_MS),
  hitStopIntendedFrames: (v) => intInRange(v, 0, MAX_FRAMES),
  inputLatencyMs: (v) => inRange(v, 0, MAX_LATENCY_MS),
  hitboxToVfxFrames: (v) => intInRange(v, -MAX_FRAMES, MAX_FRAMES),
});

/** A timeScale transition, or null when any part is malformed. */
function parseTransition(raw) {
  if (!isObj(raw)) return null;
  if (!inRange(raw.from, 0, MAX_TIME_SCALE) || !inRange(raw.to, 0, MAX_TIME_SCALE)) return null;
  if (!inRange(raw.atMs, 0, MAX_AT_MS)) return null;
  if (raw.reason !== undefined && (typeof raw.reason !== 'string' || !REASON_RE.test(raw.reason))) return null;
  return { from: raw.from, to: raw.to, atMs: raw.atMs, ...(raw.reason !== undefined ? { reason: raw.reason } : {}) };
}

/** One clean entry, or null when it is malformed or carries nothing known. */
function parseEntry(raw) {
  if (!isObj(raw)) return null;
  const entry = {};
  for (const [key, valid] of Object.entries(NUMBER_FIELDS)) {
    if (raw[key] === undefined) continue;
    if (!valid(raw[key])) return null;
    entry[key] = raw[key];
  }
  if (raw.timeScale !== undefined) {
    const transition = parseTransition(raw.timeScale);
    if (!transition) return null;
    entry.timeScale = transition;
  }
  return Object.keys(entry).length ? entry : null;
}

/**
 * The clean combatFeelLog of a PlaytestDriver state snapshot.
 * @param {unknown} state the `playtest state` answer
 * @returns {object[]|null} null when the state has no combatFeelLog array
 */
function parseCombatFeelLog(state) {
  if (!isObj(state) || !Array.isArray(state.combatFeelLog)) return null;
  const entries = state.combatFeelLog.slice(-MAX_RAW_SCAN).map(parseEntry).filter(Boolean);
  return entries.slice(-MAX_COMBAT_FEEL_ENTRIES);
}

/**
 * The state with its combatFeelLog replaced by the clean one; any other
 * state is returned as it is (a game without the log is unchanged).
 */
function withCombatFeelLog(state) {
  const log = parseCombatFeelLog(state);
  return log === null ? state : { ...state, combatFeelLog: log };
}

module.exports = {
  MAX_COMBAT_FEEL_ENTRIES,
  parseCombatFeelLog,
  withCombatFeelLog,
};
