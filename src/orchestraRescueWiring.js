// ============================================================================
// LunaCore - rescue of a God Mode "Workers" pool run, wired into one run
// ----------------------------------------------------------------------------
// The side-effecting half of src/orchestraRescue.js: it reads what the run
// knows right now (its pauses, the usage meter's reading, the live
// `agy models` list, the Emergency Opus effort setting) and turns a rescue
// target into the model and effort a package runs on. src/orchestra.js
// creates one per run controller:
//
//   wantsEscalation(pkg, reason)   a pool package that stalled twice and is not
//                                  on Opus (Claude) yet; null outside a pool run
//                                  (today's Sonnet -> Opus rule decides then)
//   escalation(pkg, reason)        the fields of its escalation, and the board line
//   handOver(pkg)                  the fields a hybrid free package's hand-over
//                                  sets in a pool run (null = Sonnet, as before)
//   moveOffLimits()                moves the not-started packages whose model is
//                                  out; returns the moves (the caller commits)
//
// Every move is logged, raised as a run event and kept on the package
// (pkg.rescues) for the board, the report and the phone.
// ============================================================================

'use strict';

const rules = require('./orchestraRescue');
const { concreteModel } = require('./orchestraPool');
const { poolUsageReadings } = require('./orchestraPoolUsage');
const { pausesOf } = require('./orchestraPauses');

const noop = () => {};

/**
 * @param {{
 *   planOf: () => (object|null),
 *   deps: {agyModels?: {list: () => object[]}, usageReading?: () => object},
 *   now: () => number,
 *   effortFor: (pkg:object) => string,
 *   emergencySetting: () => unknown,
 *   freeWaiting: () => boolean,
 *   isHybridFree: (pkg:object) => boolean,
 *   stallReasons: Set<string>,
 *   escalateAfterStalls: number,
 *   patch: (id:string, fields:object) => void,
 *   onRunEvent?: (kind:string, data?:object) => void,
 *   log?: (line:string) => void,
 * }} opts
 */
function createRescueWiring(opts) {
  const { planOf, deps, now, effortFor } = opts;
  const onRunEvent = opts.onRunEvent || noop;
  const log = opts.log || noop;

  const agyList = () => (deps.agyModels && typeof deps.agyModels.list === 'function' ? deps.agyModels.list() : []);

  /** What the run can move packages to right now. */
  function context() {
    const plan = planOf();
    const ticked = rules.tickedKeys(plan);
    const list = agyList();
    const pauses = pausesOf(plan);
    let readings = [];
    try {
      readings = deps.usageReading ? poolUsageReadings(plan.modelPool, deps.usageReading()) : [];
    } catch (err) {
      log(`[orchestra] pool usage reading failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    const out = rules.outKeys({ ticked, pauses, readings, freeWaiting: opts.freeWaiting() });
    const runnable = (k) => concreteModel(k, null, list) !== null;
    return { plan, ticked, list, out, available: rules.availableKeys(ticked, out, runnable), headroom: rules.claudeHeadroom(pauses) };
  }

  /**
   * The model and --effort a package runs on at a target. Opus taking over a
   * package not planned for it runs at the Emergency Opus effort; Sonnet at
   * its pool entry's level (else the package's own effort); an agy family on
   * its entry's variant, else the variant nearest the package's effort.
   */
  function resolve(pkg, key, list, plan) {
    return rules.resolveTarget({ pkg, key, pool: plan.modelPool, agyList: list, effort: effortFor(pkg), emergencySetting: opts.emergencySetting() });
  }

  /** The fields one move sets, or null when its target cannot run. */
  function moveFields(pkg, kind, from, target, reason, ctx) {
    const resolved = resolve(pkg, target.key, ctx.list, ctx.plan);
    if (!resolved || !resolved.model) return null;
    const move = { kind, from, to: target.key, emergency: target.emergency, model: resolved.model, effort: resolved.effort, at: now(), reason };
    const fields = rules.rescueFields(pkg, move);
    return { fields, text: rules.rescueText(fields.rescues[fields.rescues.length - 1]) };
  }

  /** True when a pool package's stall escalates it; null outside a pool run. */
  function wantsEscalation(pkg, reason) {
    const plan = planOf();
    if (!rules.isPoolPlan(plan) || !pkg) return null;
    return (
      !opts.isHybridFree(pkg) &&
      rules.rescueKeyOf(pkg) !== rules.OPUS &&
      (pkg.stalls || 0) >= opts.escalateAfterStalls &&
      opts.stallReasons.has(reason) &&
      !!pkg.root &&
      !!pkg.branch
    );
  }

  /**
   * The escalation of a stalled pool package: the next stronger ticked model,
   * else Opus as an emergency. An intermediate rung starts the stall ladder
   * afresh (one resume, then the next rung); the move to Opus keeps it, as
   * today's Sonnet -> Opus does. Null when nothing can take it.
   * @returns {{fields:object, text:string}|null}
   */
  function escalation(pkg, reason) {
    const ctx = context();
    const from = rules.rescueKeyOf(pkg);
    const target = rules.escalationTarget(from, ctx);
    if (!target) return null;
    const res = moveFields(pkg, 'escalate', from, target, reason, ctx);
    if (!res) return null;
    const ladder = target.key === rules.OPUS ? {} : { stalls: 0, autoResumed: false };
    // Logged by the caller once the new tab is open (src/orchestra.js escalate).
    return { fields: { ...res.fields, ...ladder }, text: res.text };
  }

  /**
   * A hybrid free package's hand-over target in a pool run: Sonnet when
   * ticked, else the next stronger ticked model, else emergency Opus. Null
   * outside a pool run - the hand-over goes to Sonnet as before.
   * @returns {object|null} the rescue fields (modelOverride, effortOverride, ...)
   */
  function handOver(pkg, kind) {
    if (!rules.isPoolPlan(planOf())) return null;
    const ctx = context();
    const from = rules.rescueKeyOf(pkg) || 'free';
    const res = moveFields(pkg, 'handOver', from, rules.handOverTarget(ctx), kind, ctx);
    if (!res) return null;
    log(`[orchestra] package ${pkg.id}: ${res.text}`);
    return res.fields;
  }

  /**
   * Moves every not-started pool package whose model is out (src/orchestraRescue.js
   * limitMoves). Started ones pause and resume as before.
   * @returns {{id:string, text:string}[]} the moves made (the caller commits)
   */
  function moveOffLimits() {
    const plan = planOf();
    if (!rules.isPoolPlan(plan) || !plan.started || plan.killed) return [];
    const ctx = context();
    const made = [];
    for (const m of rules.limitMoves(plan.packages, ctx)) {
      const pkg = plan.packages.find((p) => p.id === m.id);
      const res = pkg ? moveFields(pkg, 'limit', m.from, { key: m.to, emergency: m.emergency }, 'limit', ctx) : null;
      if (!res) continue;
      opts.patch(m.id, res.fields);
      log(`[orchestra] package ${m.id}: ${res.text}`);
      onRunEvent('limitMoved', { id: m.id, from: m.from, to: m.to, emergency: m.emergency });
      made.push({ id: m.id, text: res.text });
    }
    return made;
  }

  return { wantsEscalation, escalation, handOver, moveOffLimits };
}

module.exports = { createRescueWiring };
