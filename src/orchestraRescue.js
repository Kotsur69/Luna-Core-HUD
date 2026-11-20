// ============================================================================
// LunaCore - rescue rules of a God Mode "Workers" pool run (pure)
// ----------------------------------------------------------------------------
// In a pool run (2+ ticked models, src/workerPool.js) a package that cannot
// go on where it was planned moves to another model. Three ways in:
//
//   escalate   a package stalled twice: the next STRONGER ticked model
//              (src/workerPool.js STRENGTH_ORDER, roughly Hydrogen / free <
//              Sonnet < Argon < Neon < Opus (agy) < Opus). Nothing stronger
//              ticked -> Opus on Claude as an emergency, even when Opus is not
//              ticked. A package already on Opus (Claude) stalls as before.
//   handOver   a hybrid free package (src/orchestraHybrid.js): Sonnet when
//              ticked, else the next stronger ticked model, else emergency Opus.
//   limit      a package that has not started yet whose model is out (its
//              backend is paused, or its own quota reads 100%): the nearest
//              stronger ticked model, else one of the same tier, else
//              emergency Opus while a Claude account has headroom; nothing
//              -> it waits for the reset as before.
//
// A free profile is never a target (free packages run only where the
// planner put them), and every target must be usable: ticked, not out, and
// runnable (an agy family with a live variant).
//
// Opus taking over a package that was not planned for Opus runs at the
// "Emergency Opus effort" setting: 'step' (one step up from the package's
// effort, capped at max - today's escalation rule) or a fixed level. 'low'
// is offered but God Mode never runs below medium (src/efforts.js), so it
// runs at medium, like any lower ask on a pool entry.
//
// Runs without a pool never get here: their escalation is today's
// Sonnet -> Opus in src/orchestra.js. Pure, no I/O.
// ============================================================================

'use strict';

const {
  STRENGTH_ORDER,
  POOL_FREE_KEY,
  normalizePool,
  isPoolRun,
  isPoolKey,
  poolKeys,
  runsOnOf,
  tierOf,
  poolModelName,
  clampClaudeEffort,
} = require('./workerPool');
const { nextEffort } = require('./efforts');

/** The Emergency Opus effort setting: one step up (today's escalation rule). */
const EMERGENCY_STEP = 'step';
/** The setting's values, in menu order. */
const EMERGENCY_EFFORTS = Object.freeze([EMERGENCY_STEP, 'low', 'medium', 'high', 'xhigh', 'max']);
/** The Claude model every emergency runs on. */
const OPUS = 'opus';
/** Rescue kinds a package's log keeps. */
const RESCUE_KINDS = Object.freeze(['escalate', 'handOver', 'limit']);
/** A package keeps this many rescue entries (a ladder has at most six rungs). */
const MAX_RESCUES = 8;
/** A quota reading at or above this is out. */
const OUT_PERCENT = 100;
const MAX_REASON_CHARS = 120;

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const rank = (key) => STRENGTH_ORDER.indexOf(key);

/** The setting as stored, else 'step'. */
function normalizeEmergencyEffort(value) {
  return EMERGENCY_EFFORTS.includes(value) ? value : EMERGENCY_STEP;
}

/**
 * The --effort Opus runs at when it takes over a package not planned for it.
 * @param {unknown} setting the Emergency Opus effort setting
 * @param {string|null} current the package's effort now (src/orchestra.js effortFor)
 * @returns {string} one of src/efforts.js EFFORTS
 */
function emergencyEffort(setting, current) {
  const s = normalizeEmergencyEffort(setting);
  if (s === EMERGENCY_STEP) return nextEffort(current);
  return clampClaudeEffort(OPUS, s) || nextEffort(current);
}

/** True for a run whose packages each run on a ticked pool model. */
function isPoolPlan(plan) {
  return isObj(plan) && plan.workerModel === 'plan' && isPoolRun(normalizePool(plan.modelPool));
}

/** The ticked planner keys of a pool run, strongest first ([] for any other run). */
function tickedKeys(plan) {
  return isPoolPlan(plan) ? poolKeys(normalizePool(plan.modelPool)) : [];
}

/** True when the pool ticks a Claude model (Opus or Sonnet). */
function poolHasClaude(plan) {
  return tickedKeys(plan).some((k) => runsOnOf(k) === 'claude');
}

/** The key a pool package stands on now: its last rescue's target, else its planned key. */
function rescueKeyOf(pkg) {
  if (!isObj(pkg)) return null;
  if (isPoolKey(pkg.rescueKey)) return pkg.rescueKey;
  return isPoolKey(pkg.poolModel) ? pkg.poolModel : null;
}

/**
 * The ticked keys that cannot take work now.
 * @param {{ticked:string[], pauses?:object, readings?:{key:string, percent:number}[], freeWaiting?:boolean}} input
 *   pauses: src/orchestraPauses.js pausesOf(); readings: src/orchestraPoolUsage.js
 *   poolUsageReadings(); freeWaiting: a hybrid free package waits on free limits
 * @returns {string[]}
 */
function outKeys({ ticked, pauses = {}, readings = [], freeWaiting = false }) {
  const p = isObj(pauses) ? pauses : {};
  const full = new Set(
    (Array.isArray(readings) ? readings : [])
      // Claude has two accounts behind one reading: only its pause says it is out.
      .filter((r) => isObj(r) && runsOnOf(r.key) !== 'claude' && Number.isFinite(r.percent) && r.percent >= OUT_PERCENT)
      .map((r) => r.key),
  );
  return (Array.isArray(ticked) ? ticked : []).filter((k) => {
    const on = runsOnOf(k);
    if (p[on]) return true;
    if (on === 'free' && freeWaiting) return true;
    return full.has(k);
  });
}

/** True while a Claude account has headroom: no whole-run and no Claude pause. */
function claudeHeadroom(pauses) {
  const p = isObj(pauses) ? pauses : {};
  return !p.all && !p.claude;
}

/**
 * The keys a package may move to: ticked, not out, runnable, never free.
 * @param {string[]} ticked
 * @param {string[]} out
 * @param {(key:string) => boolean} runnable an agy family needs a live variant
 */
function availableKeys(ticked, out, runnable = () => true) {
  const gone = new Set(Array.isArray(out) ? out : []);
  return (Array.isArray(ticked) ? ticked : []).filter((k) => k !== POOL_FREE_KEY && !gone.has(k) && runnable(k));
}

/** The nearest key stronger than `from` among `available`, else null. */
function nextStrongerTicked(from, available) {
  const r = rank(from);
  const list = Array.isArray(available) ? available : [];
  const stronger = STRENGTH_ORDER.filter((k) => list.includes(k) && (r < 0 || rank(k) < r));
  if (!stronger.length) return null;
  // An unknown key has no rank: the strongest usable model, never the weakest.
  return r < 0 ? stronger[0] : stronger[stronger.length - 1];
}

/** Opus on Claude as a target: an emergency unless Opus is ticked. */
const opusTarget = (ticked) => ({ key: OPUS, emergency: !ticked.includes(OPUS) });

/**
 * Where a stalled pool package escalates to; null when it is on Opus (Claude)
 * already - it stalls as before.
 * @param {string|null} from rescueKeyOf(pkg)
 * @param {{ticked:string[], available:string[]}} ctx
 * @returns {{key:string, emergency:boolean}|null}
 */
function escalationTarget(from, { ticked, available }) {
  if (from === OPUS) return null;
  const next = nextStrongerTicked(from, available);
  return next ? { key: next, emergency: false } : opusTarget(ticked);
}

/**
 * Where a hybrid free package goes on a hand-over: Sonnet when ticked, else
 * the next stronger ticked model, else emergency Opus.
 * @param {{ticked:string[], available:string[]}} ctx
 * @returns {{key:string, emergency:boolean}}
 */
function handOverTarget({ ticked, available }) {
  if (available.includes('sonnet')) return { key: 'sonnet', emergency: false };
  const next = nextStrongerTicked(POOL_FREE_KEY, available);
  return next ? { key: next, emergency: false } : opusTarget(ticked);
}

/**
 * Where a not-started package whose model is out moves: the nearest stronger
 * usable model, else the strongest usable one of the same tier, else
 * emergency Opus while Claude has headroom; null = it waits for the reset.
 * @param {string} from
 * @param {{ticked:string[], available:string[], headroom:boolean}} ctx
 * @returns {{key:string, emergency:boolean}|null}
 */
function limitMoveTarget(from, { ticked, available, headroom }) {
  const others = available.filter((k) => k !== from);
  const stronger = nextStrongerTicked(from, others);
  if (stronger) return { key: stronger, emergency: false };
  const sameTier = others.find((k) => tierOf(k) === tierOf(from));
  if (sameTier) return { key: sameTier, emergency: false };
  if (!headroom || from === OPUS) return null;
  return opusTarget(ticked);
}

/**
 * The limit moves due now: every pending package of a pool run whose key is
 * out. A package with a session, or past pending, pauses and resumes as before.
 * @param {object[]} packages
 * @param {{ticked:string[], out:string[], available:string[], headroom:boolean}} ctx
 * @returns {{id:string, from:string, to:string, emergency:boolean}[]}
 */
function limitMoves(packages, { ticked, out, available, headroom }) {
  const gone = new Set(out);
  if (!gone.size) return [];
  const moves = [];
  for (const p of Array.isArray(packages) ? packages : []) {
    if (!isObj(p) || p.state !== 'pending' || p.sessionId) continue;
    const from = rescueKeyOf(p);
    if (!from || !gone.has(from)) continue;
    const target = limitMoveTarget(from, { ticked, available, headroom });
    if (target) moves.push({ id: p.id, from, to: target.key, emergency: target.emergency });
  }
  return moves;
}

/** A key's product name ('Argon (agy)'), 'free' for a free profile. */
function keyLabel(key) {
  if (key === POOL_FREE_KEY) return 'free';
  return poolModelName(key) || String(key || '-');
}

/** The target's name: 'Opus (emergency, xhigh)', 'Opus (emergency)', 'Argon (agy)'. */
function targetLabel(entry) {
  const name = keyLabel(entry.to);
  if (!entry.emergency) return name;
  return entry.effort ? `${name} (emergency, ${entry.effort})` : `${name} (emergency)`;
}

const oneLine = (v, max) =>
  String(v == null ? '' : v)
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);

/**
 * One line for the board and the report:
 *   escalate  'escalated: Sonnet -> Argon (agy)'
 *   limit     'Argon (agy) limit -> Opus (emergency, xhigh)'
 *   handOver  'handed over: free -> Opus (emergency, high)'
 * @param {{kind:string, from:string, to:string, emergency?:boolean, effort?:string|null}} entry
 * @returns {string}
 */
function rescueText(entry) {
  if (!isObj(entry)) return '';
  const to = targetLabel(entry);
  if (entry.kind === 'limit') return `${keyLabel(entry.from)} limit -> ${to}`;
  if (entry.kind === 'handOver') return `handed over: ${keyLabel(entry.from)} -> ${to}`;
  return `escalated: ${keyLabel(entry.from)} -> ${to}`;
}

/**
 * The fields a rescue sets on a package: the model and effort it runs on
 * from now on (as overrides, like today's escalation), the key it stands on
 * and one more log entry.
 * @param {object} pkg
 * @param {{kind:string, from:string, to:string, emergency:boolean, model:string,
 *   effort:string|null, at:number, reason?:string|null}} move
 * @returns {object}
 */
function rescueFields(pkg, move) {
  const entry = {
    kind: move.kind,
    from: move.from,
    to: move.to,
    emergency: move.emergency === true,
    effort: move.effort || null,
    at: move.at,
    reason: move.reason ? oneLine(move.reason, MAX_REASON_CHARS) : null,
  };
  const prev = isObj(pkg) && Array.isArray(pkg.rescues) ? pkg.rescues : [];
  return {
    modelOverride: move.model,
    effortOverride: move.effort || null,
    rescueKey: move.to,
    emergency: entry.emergency,
    rescues: [...prev, entry].slice(-MAX_RESCUES),
  };
}

/** One stored rescue entry, checked; null when off-shape. */
function normalizeRescueEntry(raw) {
  if (!isObj(raw) || !RESCUE_KINDS.includes(raw.kind) || !isPoolKey(raw.from) || !isPoolKey(raw.to)) return null;
  const effort = clampClaudeEffort(OPUS, raw.effort);
  return {
    kind: raw.kind,
    from: raw.from,
    to: raw.to,
    emergency: raw.emergency === true,
    effort: effort || null,
    at: Number.isFinite(raw.at) ? raw.at : null,
    reason: typeof raw.reason === 'string' && raw.reason ? oneLine(raw.reason, MAX_REASON_CHARS) : null,
  };
}

/**
 * The rescue fields of a stored package (src/orchestraSupervisor.js
 * normalizePackage): none for a package that was never moved.
 * @param {object} raw
 * @returns {{rescueKey?:string, emergency?:boolean, rescues?:object[]}}
 */
function normalizeStoredRescue(raw) {
  if (!isObj(raw)) return {};
  const rescues = (Array.isArray(raw.rescues) ? raw.rescues : []).map(normalizeRescueEntry).filter(Boolean).slice(-MAX_RESCUES);
  if (!rescues.length || !isPoolKey(raw.rescueKey)) return {};
  return { rescueKey: raw.rescueKey, emergency: raw.emergency === true, rescues };
}

module.exports = {
  EMERGENCY_STEP,
  EMERGENCY_EFFORTS,
  OPUS,
  MAX_RESCUES,
  normalizeEmergencyEffort,
  emergencyEffort,
  isPoolPlan,
  tickedKeys,
  poolHasClaude,
  rescueKeyOf,
  outKeys,
  claudeHeadroom,
  availableKeys,
  nextStrongerTicked,
  escalationTarget,
  handOverTarget,
  limitMoveTarget,
  limitMoves,
  keyLabel,
  targetLabel,
  rescueText,
  rescueFields,
  normalizeRescueEntry,
  normalizeStoredRescue,
};
