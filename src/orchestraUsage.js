// ============================================================================
// LunaCore - God Mode token usage of one run (pure, additive bookkeeping)
// ----------------------------------------------------------------------------
// What a run's Claude calls reported, summed per source and per model. Nothing
// in God Mode decides anything from these numbers: they ride on the board view
// (`usage`) so Luna's Work can book a build's real tokens under its builder
// role (src/lunasworkWiring.js), and are otherwise ignored.
//
//   usageFromEnvelope(env, model)   a `claude -p --output-format json` result
//                                   envelope -> Usage, or null without numbers
//   usageFromTranscript(byModel)    a worker tab's transcript totals per model
//                                   (src/observer.js TranscriptWatcher) -> Usage
//   addUsage(a, b)                  both, summed (per model too)
//   cleanUsage(raw)                 re-validated (it crosses module borders)
//   createUsageBook()               one run's book:
//     begin(planId)                 a new run: everything before is dropped
//     add(source, usage)            a finished headless call
//     setSession(id, byModel)       a worker tab's running totals (latest wins;
//                                   a transcript that restarts is banked)
//     snapshot(planId)              {total, bySource} or null (no numbers yet)
//
// Usage = {calls, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens,
//          costUsd, byModel: {<model>: {the same six fields}}}
//
// costUsd is only ever what the CLI itself reported (total_cost_usd / the
// per-model costUSD). Worker tabs report tokens but no cost, so theirs is 0 -
// never an estimate from a price table.
// ============================================================================

'use strict';

const NUMBER_KEYS = ['calls', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'costUsd'];
const TOKEN_KEYS = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'];
const SOURCES = Object.freeze(['planner', 'workers', 'review']);
const MAX_MODELS = 24;
const MAX_MODEL_CHARS = 80;
const MAX_SESSIONS = 500;

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const count = (v) => (Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);
const money = (v) => (Number.isFinite(v) && v > 0 ? v : 0);

const emptyNumbers = () => ({ calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 });
const emptyUsage = () => ({ ...emptyNumbers(), byModel: {} });

function cleanNumbers(raw) {
  const r = isObj(raw) ? raw : {};
  return {
    calls: count(r.calls),
    inputTokens: count(r.inputTokens),
    outputTokens: count(r.outputTokens),
    cacheReadTokens: count(r.cacheReadTokens),
    cacheWriteTokens: count(r.cacheWriteTokens),
    costUsd: money(r.costUsd),
  };
}

const tokensOf = (n) => TOKEN_KEYS.reduce((sum, k) => sum + n[k], 0);
const hasNumbers = (n) => tokensOf(n) > 0 || n.costUsd > 0;

/** A model name as a safe, bounded key ('' = unusable). */
function modelKey(raw) {
  if (typeof raw !== 'string') return '';
  const key = raw.trim().slice(0, MAX_MODEL_CHARS);
  // An own, plain key only: never __proto__ and friends.
  return /^[A-Za-z0-9][A-Za-z0-9._:[\]/-]*$/.test(key) ? key : '';
}

function cleanByModel(raw) {
  const out = {};
  if (!isObj(raw)) return out;
  for (const [name, value] of Object.entries(raw).slice(0, MAX_MODELS)) {
    const key = modelKey(name);
    const numbers = cleanNumbers(value);
    if (key && hasNumbers(numbers)) out[key] = numbers;
  }
  return out;
}

/** @returns {{calls:number, inputTokens:number, outputTokens:number, cacheReadTokens:number, cacheWriteTokens:number, costUsd:number, byModel:object}} */
function cleanUsage(raw) {
  return { ...cleanNumbers(raw), byModel: cleanByModel(isObj(raw) ? raw.byModel : null) };
}

const addNumbers = (a, b) => Object.fromEntries(NUMBER_KEYS.map((k) => [k, a[k] + b[k]]));

/** Two usages summed, per model too. Never mutates its inputs. */
function addUsage(a, b) {
  const x = cleanUsage(a);
  const y = cleanUsage(b);
  const byModel = { ...x.byModel };
  for (const [model, numbers] of Object.entries(y.byModel)) {
    byModel[model] = byModel[model] ? addNumbers(byModel[model], numbers) : numbers;
  }
  return { ...addNumbers(x, y), byModel: cleanByModel(byModel) };
}

/** The envelope's `modelUsage` ({<model id>: {inputTokens, ..., costUSD}}) as byModel. */
function byModelFromEnvelope(modelUsage) {
  const out = {};
  if (!isObj(modelUsage)) return out;
  for (const [name, m] of Object.entries(modelUsage).slice(0, MAX_MODELS)) {
    const key = modelKey(name);
    if (!key || !isObj(m)) continue;
    const numbers = {
      calls: 0,
      inputTokens: count(m.inputTokens),
      outputTokens: count(m.outputTokens),
      cacheReadTokens: count(m.cacheReadInputTokens),
      cacheWriteTokens: count(m.cacheCreationInputTokens),
      costUsd: money(m.costUSD),
    };
    if (hasNumbers(numbers)) out[key] = numbers;
  }
  return out;
}

/**
 * One headless call's usage from its parsed JSON envelope. The per-model
 * split (`modelUsage`) is the complete account - it includes the small side
 * calls the CLI makes on another model - so when it carries tokens the totals
 * are its sum; otherwise the totals are the envelope's `usage`, filed under
 * `model` (the alias the call was made with) when that is given.
 * @param {unknown} env the parsed envelope
 * @param {string} [model] the --model the call ran with
 * @returns {object|null} a Usage, or null when the envelope carries no numbers
 */
function usageFromEnvelope(env, model) {
  if (!isObj(env)) return null;
  const costUsd = money(env.total_cost_usd);
  const split = byModelFromEnvelope(env.modelUsage);
  const splitTotal = Object.values(split).reduce(addNumbers, emptyNumbers());
  if (tokensOf(splitTotal) > 0) {
    return { ...splitTotal, calls: 1, costUsd: costUsd || splitTotal.costUsd, byModel: split };
  }
  const u = isObj(env.usage) ? env.usage : {};
  const numbers = {
    calls: 1,
    inputTokens: count(u.input_tokens),
    outputTokens: count(u.output_tokens),
    cacheReadTokens: count(u.cache_read_input_tokens),
    cacheWriteTokens: count(u.cache_creation_input_tokens),
    costUsd,
  };
  if (!hasNumbers(numbers)) return null;
  const key = modelKey(model);
  return { ...numbers, byModel: key ? { [key]: { ...numbers, calls: 0 } } : {} };
}

/**
 * A worker tab's transcript totals ({<model>: {input, output, cacheRead,
 * cacheWrite}}, a Map or a plain object) as a Usage. Tokens only: a tab
 * reports no cost and no call count.
 * @param {unknown} byModel
 * @returns {object} a Usage (all zero when there is nothing)
 */
function usageFromTranscript(byModel) {
  const entries = byModel instanceof Map ? [...byModel.entries()] : isObj(byModel) ? Object.entries(byModel) : [];
  const split = {};
  for (const [name, t] of entries.slice(0, MAX_MODELS)) {
    const key = modelKey(name);
    if (!key || !isObj(t)) continue;
    const numbers = {
      calls: 0,
      inputTokens: count(t.input),
      outputTokens: count(t.output),
      cacheReadTokens: count(t.cacheRead),
      cacheWriteTokens: count(t.cacheWrite),
      costUsd: 0,
    };
    if (hasNumbers(numbers)) split[key] = numbers;
  }
  return { ...Object.values(split).reduce(addNumbers, emptyNumbers()), byModel: split };
}

/** True when any counter of `next` is below `prev`'s: the transcript started over. */
function wentBack(prev, next) {
  if (TOKEN_KEYS.some((k) => next[k] < prev[k])) return true;
  return Object.entries(prev.byModel).some(([model, n]) => {
    const now = next.byModel[model];
    return !now || TOKEN_KEYS.some((k) => now[k] < n[k]);
  });
}

/**
 * One run's usage book. Headless calls are added once, when they end; worker
 * tabs report running totals, so the latest reading per tab replaces the one
 * before - except when a tab's transcript starts over (a /clear, a resumed
 * conversation), where the old reading is kept and the new one counts on top.
 */
function createUsageBook() {
  let planId = null;
  let bySource = {};
  /** @type {Map<string, {banked:object, last:object}>} */
  let sessions = new Map();

  function begin(id) {
    planId = typeof id === 'string' && id ? id : null;
    bySource = {};
    sessions = new Map();
  }

  function add(source, usage) {
    if (!SOURCES.includes(source) || !isObj(usage)) return;
    const clean = cleanUsage(usage);
    if (!hasNumbers(clean)) return;
    bySource = { ...bySource, [source]: addUsage(bySource[source], clean) };
  }

  function setSession(sessionId, byModel) {
    if (typeof sessionId !== 'string' || !sessionId) return;
    const next = usageFromTranscript(byModel);
    const prev = sessions.get(sessionId);
    if (!prev) {
      if (!hasNumbers(next) || sessions.size >= MAX_SESSIONS) return;
      sessions.set(sessionId, { banked: emptyUsage(), last: next });
      return;
    }
    sessions.set(sessionId, wentBack(prev.last, next) ? { banked: addUsage(prev.banked, prev.last), last: next } : { banked: prev.banked, last: next });
  }

  /** @returns {{total:object, bySource:object}|null} */
  function snapshot(id) {
    if (!planId || id !== planId) return null;
    const workers = [...sessions.values()].reduce((sum, s) => addUsage(addUsage(sum, s.banked), s.last), cleanUsage(bySource.workers));
    const all = { ...bySource, ...(hasNumbers(workers) ? { workers } : {}) };
    const sources = Object.keys(all);
    if (!sources.length) return null;
    return { total: sources.reduce((sum, s) => addUsage(sum, all[s]), emptyUsage()), bySource: all };
  }

  return { begin, add, setSession, snapshot };
}

module.exports = {
  SOURCES,
  emptyUsage,
  cleanUsage,
  addUsage,
  usageFromEnvelope,
  usageFromTranscript,
  createUsageBook,
};
