// ============================================================================
// LunaCore - Luna's Work token accounting (LW 2.17a, docs/LUNAS_WORK_PLAN.md #12)
// ----------------------------------------------------------------------------
// What every `claude -p --output-format json` call of a run cost, per role
// and per iteration, plus how long each phase took. Pure, except the meter.
//
//   usageFromStdout(stdout)    the JSON envelope's usage + total_cost_usd, or null
//   createUsageMeter()         collects usage between phase transitions:
//     runner(role, runClaude)  a runClaude({args, prompt, ...}) that records stdout's usage
//     exec(role, execImpl)     the same for a child_process.execFile-style function
//     add(role, usage)         records a usage directly (God Mode's planner cost)
//     drain()                  the entries since the last drain, cleared
//   closePhase(ledger, {iteration, phase, startedAt, at, entries})
//                              the ledger with the entries and the phase's time added
//   cleanLedger(raw)           a stored ledger, re-validated (run restore, IPC)
//   cardsSeries(laps)          cards opened / closed per iteration (the run's laps)
//
// ledger = {total, byRole:{role:Usage}, iterations:[{n, byRole, phases:{phase:ms}}]}
// Usage  = {calls, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, costUsd}
//
// The ledger is kept with the run (lunasworkRun.restoreRun) and summed by the
// controller in its one transition() - no step knows about it.
// ============================================================================

'use strict';

const { ROLES } = require('./lunasworkRules');

const USAGE_KEYS = ['calls', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'costUsd'];
const MAX_ITERATIONS = 200;
const MAX_PENDING = 500;
// A phase longer than a week is a clock jump, not work.
const MAX_PHASE_MS = 7 * 24 * 60 * 60 * 1000;
// Phases whose time is worth a bar; preprod / handed / done are not work of the run.
const TIMED_PHASES = ['directing', 'building', 'launching', 'playtesting', 'critiquing'];

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const count = (v) => (Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);
const money = (v) => (Number.isFinite(v) && v > 0 ? v : 0);

function emptyUsage() {
  return { calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 };
}

function cleanUsage(raw) {
  if (!isObj(raw)) return emptyUsage();
  return {
    calls: count(raw.calls),
    inputTokens: count(raw.inputTokens),
    outputTokens: count(raw.outputTokens),
    cacheReadTokens: count(raw.cacheReadTokens),
    cacheWriteTokens: count(raw.cacheWriteTokens),
    costUsd: money(raw.costUsd),
  };
}

function addUsage(a, b) {
  const x = cleanUsage(a);
  const y = cleanUsage(b);
  return Object.fromEntries(USAGE_KEYS.map((k) => [k, x[k] + y[k]]));
}

/** Every token of a usage, input side and output side together. */
function totalTokens(u) {
  const c = cleanUsage(u);
  return c.inputTokens + c.outputTokens + c.cacheReadTokens + c.cacheWriteTokens;
}

/** The result envelope of a `claude -p` stdout: one object, or the last `result` of a list. */
function envelopeOf(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(String(stdout || '').trim());
  } catch {
    return null;
  }
  if (Array.isArray(parsed)) return [...parsed].reverse().find((m) => isObj(m) && m.type === 'result') || null;
  return isObj(parsed) ? parsed : null;
}

/**
 * One call's usage from its stdout, or null when the output carries none.
 * @param {unknown} stdout
 */
function usageFromStdout(stdout) {
  const env = envelopeOf(stdout);
  if (!env) return null;
  const u = isObj(env.usage) ? env.usage : {};
  const usage = {
    calls: 1,
    inputTokens: count(u.input_tokens),
    outputTokens: count(u.output_tokens),
    cacheReadTokens: count(u.cache_read_input_tokens),
    cacheWriteTokens: count(u.cache_creation_input_tokens),
    costUsd: money(env.total_cost_usd),
  };
  return totalTokens(usage) || usage.costUsd ? usage : null;
}

function emptyLedger() {
  return { total: emptyUsage(), byRole: {}, iterations: [] };
}

function cleanRoleMap(raw) {
  const out = {};
  if (!isObj(raw)) return out;
  for (const role of ROLES) if (isObj(raw[role])) out[role] = cleanUsage(raw[role]);
  return out;
}

function cleanPhases(raw) {
  const out = {};
  if (!isObj(raw)) return out;
  for (const phase of TIMED_PHASES) {
    const ms = count(raw[phase]);
    if (ms) out[phase] = ms;
  }
  return out;
}

/** A stored ledger, re-validated; an empty one for anything else. */
function cleanLedger(raw) {
  if (!isObj(raw)) return emptyLedger();
  const byN = new Map();
  for (const it of Array.isArray(raw.iterations) ? raw.iterations : []) {
    if (!isObj(it) || !Number.isInteger(it.n) || it.n < 0) continue;
    byN.set(it.n, { n: it.n, byRole: cleanRoleMap(it.byRole), phases: cleanPhases(it.phases) });
  }
  return {
    total: cleanUsage(raw.total),
    byRole: cleanRoleMap(raw.byRole),
    iterations: [...byN.values()].sort((a, b) => a.n - b.n).slice(-MAX_ITERATIONS),
  };
}

/**
 * The ledger after a phase ends: the usage entries recorded during it (per
 * role, into the iteration it ran in) and the phase's wall time.
 * @param {unknown} ledger run.usage
 * @param {{iteration:number, phase:string|null, startedAt:number|null, at:number,
 *   entries?:{role:string, usage:object}[]}} ctx
 */
function closePhase(ledger, { iteration, phase, startedAt, at, entries = [] }) {
  const base = cleanLedger(ledger);
  const n = Number.isInteger(iteration) && iteration >= 0 ? iteration : 0;
  const known = (Array.isArray(entries) ? entries : []).filter((e) => isObj(e) && ROLES.includes(e.role) && isObj(e.usage));
  const ms = TIMED_PHASES.includes(phase) && Number.isFinite(startedAt) && Number.isFinite(at) ? at - startedAt : 0;
  const timed = ms > 0 && ms <= MAX_PHASE_MS;
  if (!known.length && !timed) return base;

  const addTo = (map, e) => ({ ...map, [e.role]: addUsage(map[e.role], e.usage) });
  const prev = base.iterations.find((it) => it.n === n) || { n, byRole: {}, phases: {} };
  const next = {
    n,
    byRole: known.reduce(addTo, prev.byRole),
    phases: timed ? { ...prev.phases, [phase]: (prev.phases[phase] || 0) + Math.round(ms) } : prev.phases,
  };
  return {
    total: known.reduce((sum, e) => addUsage(sum, e.usage), base.total),
    byRole: known.reduce(addTo, base.byRole),
    iterations: [...base.iterations.filter((it) => it.n !== n), next].sort((a, b) => a.n - b.n).slice(-MAX_ITERATIONS),
  };
}

/** Total time per phase across the run (ms). */
function phaseTotals(ledger) {
  const out = {};
  for (const it of cleanLedger(ledger).iterations) {
    for (const [phase, ms] of Object.entries(it.phases)) out[phase] = (out[phase] || 0) + ms;
  }
  return out;
}

/**
 * Cards opened (by the Critic) and closed (confirmed by the Playtester) per
 * iteration, from the run's laps (lunasworkRun.buildLap), with the totals.
 * @param {unknown} laps
 * @returns {{series:{n:number, opened:number, closed:number}[], opened:number, closed:number}}
 */
function cardsSeries(laps) {
  const series = (Array.isArray(laps) ? laps : [])
    .filter((l) => isObj(l) && Number.isInteger(l.n))
    .map((l) => ({
      n: l.n,
      opened: count(l.cardsOpened),
      closed: Array.isArray(l.cardsClosed) ? l.cardsClosed.length : count(l.cardsClosed),
    }));
  return {
    series,
    opened: series.reduce((s, r) => s + r.opened, 0),
    closed: series.reduce((s, r) => s + r.closed, 0),
  };
}

/**
 * Collects usage between the controller's phase transitions. One meter per
 * controller: there is one run at most, and its steps run one at a time.
 */
function createUsageMeter() {
  let pending = [];

  function add(role, usage) {
    if (!ROLES.includes(role) || !isObj(usage)) return;
    const clean = cleanUsage(usage);
    if (!clean.calls && !totalTokens(clean) && !clean.costUsd) return;
    pending = [...pending, { role, usage: clean }].slice(-MAX_PENDING);
  }

  function record(role, stdout) {
    const usage = usageFromStdout(stdout);
    if (usage) add(role, usage);
  }

  /** A runClaude that records its stdout's usage under `role`. */
  const runner = (role, runClaude) => async (call) => {
    const res = await runClaude(call);
    if (isObj(res) && typeof res.stdout === 'string') record(role, res.stdout);
    return res;
  };

  /** An execFile-compatible function that records the callback's stdout under `role`. */
  const exec = (role, execImpl) => (file, args, options, callback) =>
    execImpl(file, args, options, (error, stdout, stderr) => {
      if (file === 'claude') record(role, stdout);
      callback(error, stdout, stderr);
    });

  function drain() {
    const out = pending;
    pending = [];
    return out;
  }

  return { add, runner, exec, drain };
}

module.exports = {
  USAGE_KEYS,
  TIMED_PHASES,
  MAX_ITERATIONS,
  emptyUsage,
  cleanUsage,
  addUsage,
  totalTokens,
  usageFromStdout,
  emptyLedger,
  cleanLedger,
  closePhase,
  phaseTotals,
  cardsSeries,
  createUsageMeter,
};
