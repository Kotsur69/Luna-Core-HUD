// ============================================================================
// LunaCore phone - review and launch a God Mode plan (pure; test/mobilegodmodeplan.test.mjs)
// ----------------------------------------------------------------------------
// Phone God Mode C. A host's `godmode` snapshot carries each project's plan
// not started yet (snapmodel.godmodePlansFrom). The God Mode page keeps a
// draft per plan - which packages are ticked, the integration mode, Claude or
// free workers, a release after a merge - across repaints, and turns it into
// the signed godmode.launch payload (src/hostgodmode.js launchPayload). It
// never builds HTML.
// ============================================================================

/** Every integration mode the PC accepts (src/orchestraSupervisor.js INTEGRATION_MODES). */
export const INTEGRATION_MODES = ['pr', 'merge', 'branches'];
/** The mode a new draft starts on: no merge without Mati picking it. */
export const DEFAULT_INTEGRATION = 'pr';

const ids = (plan) => (plan && Array.isArray(plan.packages) ? plan.packages.map((p) => p.id) : []);

/**
 * The draft for `plan`: `prev` kept while it belongs to the same plan (ticks
 * of packages that are gone are dropped), else a fresh one with every package
 * ticked.
 * @returns {{planId: string|null, ticked: string[], integration: string, free: boolean, releaseAfter: boolean}}
 */
export function planDraft(plan, prev) {
  const all = ids(plan);
  const planId = plan ? plan.planId : null;
  if (prev && prev.planId === planId) {
    return {
      planId,
      ticked: prev.ticked.filter((id) => all.includes(id)),
      integration: INTEGRATION_MODES.includes(prev.integration) ? prev.integration : DEFAULT_INTEGRATION,
      free: prev.free === true,
      releaseAfter: prev.releaseAfter === true,
    };
  }
  return { planId, ticked: all, integration: DEFAULT_INTEGRATION, free: false, releaseAfter: false };
}

/** `draft` with package `id` ticked or unticked. */
export function togglePackage(draft, id) {
  const ticked = draft.ticked.includes(id) ? draft.ticked.filter((x) => x !== id) : [...draft.ticked, id];
  return { ...draft, ticked };
}

/** Whether Launch needs the "Merge into main?" confirmation first. */
export const needsMergeConfirm = (draft) => draft.integration === 'merge';

/**
 * The godmode.launch payload, or null when the plan cannot launch (not
 * ready, no plan id, nothing ticked). `ids` goes out only when some package
 * is unticked; `releaseAfter` only with a merge.
 * @returns {{projectId: string, planId: string, ids?: string[], integration: string, free: boolean, releaseAfter?: boolean}|null}
 */
export function launchPayload(plan, draft) {
  if (!plan || plan.state !== 'ready' || !plan.planId || !plan.projectId || !draft) return null;
  const all = ids(plan);
  // Plan order, not tick order.
  const ticked = all.filter((id) => draft.ticked.includes(id));
  if (!ticked.length) return null;
  const integration = INTEGRATION_MODES.includes(draft.integration) ? draft.integration : DEFAULT_INTEGRATION;
  return {
    projectId: plan.projectId,
    planId: plan.planId,
    ...(ticked.length < all.length ? { ids: ticked } : {}),
    integration,
    free: draft.free === true,
    ...(integration === 'merge' ? { releaseAfter: draft.releaseAfter === true } : {}),
  };
}

/** The godmode.discard payload of a plan. */
export const discardPayload = (plan) => ({ projectId: plan.projectId });
