// ============================================================================
// LunaCore - God Mode v2: the run's own deps for the merge integration
// ----------------------------------------------------------------------------
// orchestraFinalize.js calls integrateMerge with the self-check gate only.
// This wraps it with what only the run (orchestra.js) knows:
//   - each package's task text, for the merge fix-up brief,
//   - the fix-up worker (orchestraFixup.js, one at a time), each call counted,
//   - a stop check: a kill or a usage pause DURING the integration stops new
//     fix-ups (a run killed earlier and finished by hand is not "stopped").
// The count reaches integration.selfCheck.fixups through the self-check
// result (orchestraSelfCheck.js reads result.mergeFixups); the packages the
// fix-up kept in land on plan.integration.fixedUp, the ones merged only on
// the second pass (orchestraSecondPass.js) on .secondPass, for the report.
// ============================================================================

'use strict';

const MAX_IDS = 50;
const ID_RE = /^[a-z0-9-]{1,64}$/;

/** Package ids from an integration result: valid ones only, capped. */
const idList = (v) => (Array.isArray(v) ? v.filter((id) => typeof id === 'string' && ID_RE.test(id)).slice(0, MAX_IDS) : []);
/** Both id lists, each id once: a Retry pass adds to what an earlier pass recorded. */
const union = (a, b) => idList([...new Set([...idList(a), ...idList(b)])]);

function taskOf(plan, id) {
  const p = (plan.packages || []).find((x) => x.id === id);
  return p ? String(p.prompt || p.title || '') : '';
}

/**
 * Records what the integration did per package - only for one that went
 * through: a failed push or a red self-check merged nothing into the base.
 */
function recordLists(run, res) {
  if (!res || typeof res !== 'object' || res.ok !== true) return;
  const prev = run.integration || {};
  run.integration = { ...prev, fixedUp: union(prev.fixedUp, res.fixedUp), secondPass: union(prev.secondPass, res.secondPass) };
}

/**
 * @param {{getPlan: () => object|null, integrateMerge: Function,
 *   runSelfCheck?: Function, runFixup: (args:object) => Promise<{ok:boolean}>}} deps
 * @returns {{integrateMerge: Function, runSelfCheck: Function|undefined}}
 */
function createMergeRunDeps(deps) {
  // Fix-up workers the merge started, for the run they were started in: the
  // orchestra outlives runs, and a pr / branches run must not inherit them.
  let fixups = { planId: null, n: 0 };
  const countFor = (plan) => (plan && plan.id === fixups.planId ? fixups.n : 0);

  async function integrateMerge(args, extra) {
    const run = deps.getPlan();
    if (fixups.planId !== run.id) fixups = { planId: run.id, n: 0 };
    const killedBefore = run.killed === true;
    const packages = Array.isArray(args.packages) ? args.packages.map((p) => ({ ...p, task: taskOf(run, p.id) })) : args.packages;
    const res = await deps.integrateMerge(
      { ...args, repoPath: run.repoPath, packages },
      {
        ...extra,
        fixup: (fx) => {
          fixups = { ...fixups, n: fixups.n + 1 };
          return deps.runFixup(fx);
        },
        stopped: () => deps.getPlan() !== run || (run.killed === true && !killedBefore) || Boolean(run.pausedUntil),
      },
    );
    if (args.checkOnly !== true && deps.getPlan() === run) recordLists(run, res);
    return res;
  }

  async function runSelfCheck(args) {
    const res = await deps.runSelfCheck(args);
    return res && typeof res === 'object' ? { ...res, mergeFixups: countFor(deps.getPlan()) } : res;
  }

  return { integrateMerge, runSelfCheck: typeof deps.runSelfCheck === 'function' ? runSelfCheck : undefined };
}

module.exports = { createMergeRunDeps };
