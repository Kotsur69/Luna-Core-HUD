// ============================================================================
// LunaCore phone - review and launch a God Mode plan (pure; test/mobilegodmodeplan.test.mjs)
// ----------------------------------------------------------------------------
// Phone God Mode C. A host's `godmode` snapshot carries each project's plan
// not started yet (snapmodel.godmodePlansFrom). The God Mode page keeps a
// draft per plan - which packages are ticked, the integration mode, Claude or
// free workers, the Claude workers' model, a release after a merge - across repaints, and turns it into
// the signed godmode.launch payload (src/hostgodmode.js launchPayload). It
// never builds HTML.
// ============================================================================

/** Every integration mode the PC accepts (src/orchestraSupervisor.js INTEGRATION_MODES). */
export const INTEGRATION_MODES = ['pr', 'merge', 'branches'];
/** The mode a new draft starts on: no merge without Mati picking it. */
export const DEFAULT_INTEGRATION = 'pr';
import { WORKER_MODELS, WORKER_MODEL_NAMES, DEFAULT_WORKER_MODEL, AGY_MODEL, isWorkerModel, agyModelIdOf } from '../../src/workerModels.js';
import {
  normalizePool,
  isPoolRun,
  poolLabel,
  poolModelName,
  poolFreeProfileId,
  poolEffortLevel,
  POOL_FREE_KEY,
  POOL_MODEL_LIST,
  POOL_EFFORT_PLAN,
  claudePoolLevels,
  cleanPoolOptions,
  togglePoolModel,
  freeProfileIdOf,
} from '../../src/workerPool.js';
import { poolEntryOfKey } from '../../src/poolEffort.js';

/**
 * Every worker model the PC accepts, their product names and the PC's default
 * when the snapshot names none: the shared list (src/workerModels.js).
 */
export { WORKER_MODELS, WORKER_MODEL_NAMES, DEFAULT_WORKER_MODEL };

/** One of WORKER_MODELS or a well-formed 'agy:<id>' (the PC checks the id again), else null. */
const workerModelOf = (value) => (isWorkerModel(value) ? value : null);

/**
 * The worker-model select's ids: the shared list, with `current` after plain
 * 'agy' when it is an 'agy:<id>' variant the PC chose (the phone has no live
 * `agy models` list, so it offers only the one it was given).
 * @param {unknown} current
 * @returns {string[]}
 */
export function workerModelOptions(current) {
  const variant = agyModelIdOf(current) ? [current] : [];
  return WORKER_MODELS.flatMap((m) => (m === AGY_MODEL ? [m, ...variant] : [m]));
}

const ids = (plan) => (plan && Array.isArray(plan.packages) ? plan.packages.map((p) => p.id) : []);

/**
 * The draft for `plan`: `prev` kept while it belongs to the same plan (ticks
 * of packages that are gone are dropped), else a fresh one with every package
 * ticked, the worker model the PC's snapshot names (its saved pref) and the
 * plan's own "Workers" pool (none for a plan without one).
 * @returns {{planId: string|null, ticked: string[], integration: string, free: boolean, workerModel: string, releaseAfter: boolean,
 *   pool: {model: string, effort: string}[]}}
 */
export function planDraft(plan, prev) {
  const all = ids(plan);
  const planId = plan ? plan.planId : null;
  const snapModel = workerModelOf(plan && plan.workerModel) || DEFAULT_WORKER_MODEL;
  if (prev && prev.planId === planId) {
    return {
      planId,
      ticked: prev.ticked.filter((id) => all.includes(id)),
      integration: INTEGRATION_MODES.includes(prev.integration) ? prev.integration : DEFAULT_INTEGRATION,
      free: prev.free === true,
      workerModel: workerModelOf(prev.workerModel) || snapModel,
      releaseAfter: prev.releaseAfter === true,
      pool: normalizePool(prev.pool) || [],
    };
  }
  return { planId, ticked: all, integration: DEFAULT_INTEGRATION, free: false, workerModel: snapModel, releaseAfter: false, pool: planPool(plan) || [] };
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
 * is unticked; `workerModel` only for Claude workers; `releaseAfter` only
 * with a merge.
 * @returns {{projectId: string, planId: string, ids?: string[], integration: string, free: boolean, workerModel?: string, releaseAfter?: boolean}|null}
 */
export function launchPayload(plan, draft) {
  if (!plan || plan.state !== 'ready' || !plan.planId || !plan.projectId || !draft) return null;
  const all = ids(plan);
  // Plan order, not tick order.
  const ticked = all.filter((id) => draft.ticked.includes(id));
  if (!ticked.length) return null;
  const integration = INTEGRATION_MODES.includes(draft.integration) ? draft.integration : DEFAULT_INTEGRATION;
  const free = draft.free === true;
  const workerModel = workerModelOf(draft.workerModel);
  // A changed "Workers" pool replaces the single model (the PC checks it again,
  // strictly); the plan's own pool untouched goes out as before (workerModel).
  const pool = free ? [] : changedPool(plan, draft.pool);
  return {
    projectId: plan.projectId,
    planId: plan.planId,
    ...(ticked.length < all.length ? { ids: ticked } : {}),
    integration,
    free,
    ...(pool.length ? { modelPool: pool } : !free && workerModel ? { workerModel } : {}),
    ...(integration === 'merge' ? { releaseAfter: draft.releaseAfter === true } : {}),
  };
}

/** The godmode.discard payload of a plan. */
export const discardPayload = (plan) => ({ projectId: plan.projectId });

// ---- The "Workers" pool picker ---------------------------------------------------
// The phone ticks pool models and an effort per model before Launch. The menu
// is the PC's (the plan's snapshot `poolOptions`: agy families with their live
// variants); without one only the Claude models are offered. Free profiles
// stay on the PC. The PC refuses a pool it cannot run as sent.

/** The menu rows: [{model, name, available, efforts}] in menu order. */
export function poolMenu(plan) {
  const menu = plan && plan.poolOptions ? cleanPoolOptions(plan.poolOptions).models : [];
  return POOL_MODEL_LIST.map((m) => {
    if (m.runsOn === 'claude') return { model: m.id, name: m.name, available: true, efforts: [POOL_EFFORT_PLAN, ...claudePoolLevels(m.id)] };
    const opt = menu.find((o) => o.model === m.id);
    const available = !!(opt && opt.available);
    return { model: m.id, name: m.name, available, efforts: [POOL_EFFORT_PLAN, ...(available ? opt.variants.map((v) => v.id) : [])] };
  });
}

/** An effort choice's text: 'plan' -> null (the UI says "Per plan"), an agy variant -> its level or id. */
export function poolEffortText(model, effort) {
  if (effort === POOL_EFFORT_PLAN) return null;
  return poolEffortLevel({ model, effort }) || effort;
}

/** The draft with a pool model ticked or unticked (only an available menu model can be ticked). */
export function togglePoolEntry(plan, draft, model) {
  const row = poolMenu(plan).find((r) => r.model === model);
  const list = normalizePool(draft.pool) || [];
  const on = !list.some((e) => e.model === model);
  if (!row || freeProfileIdOf(model) || (on && !row.available)) return draft;
  return { ...draft, pool: togglePoolModel(list, model, on) };
}

/** The draft with a ticked model's effort set (only one its menu row offers). */
export function setPoolEntryEffort(plan, draft, model, effort) {
  const row = poolMenu(plan).find((r) => r.model === model);
  if (!row || !row.efforts.includes(effort)) return draft;
  const list = normalizePool(draft.pool) || [];
  return { ...draft, pool: list.map((e) => (e.model === model ? { model, effort } : e)) };
}

const samePool = (a, b) => a.length === b.length && a.every((e, i) => e.model === b[i].model && e.effort === b[i].effort);

/**
 * The pool a launch sends: [] when nothing is ticked or the plan's own pool
 * is untouched; else the ticked entries (a plan's free profile stays in it -
 * the phone can neither add nor drop one).
 */
function changedPool(plan, pool) {
  const list = (normalizePool(pool) || []).map((e) => ({ model: e.model, effort: e.effort }));
  return samePool(list, planPool(plan) || []) ? [] : list;
}

// ---- Read-only "Workers" pool (a pool plan only) ------------------------------

/** The pool of a pool plan (2+ valid entries, src/workerPool.js), else null. */
function planPool(plan) {
  const pool = plan ? normalizePool(plan.modelPool) : null;
  return pool && isPoolRun(pool) ? pool : null;
}

/**
 * The pool's read-only line text ('Opus + Sonnet + Argon (agy)'), or null for
 * a plan without a pool - its card stays as it was.
 * @returns {string|null}
 */
export function poolLine(plan) {
  const pool = planPool(plan);
  return pool ? poolLabel(pool) : null;
}

/**
 * A package's model as its plan card shows it. A pool plan names the pool
 * model ('Argon (agy)'; the planner key 'free' = the pool's free profile),
 * with the effort its pool entry fixes ('Opus - xhigh'; an agy variant the
 * pool chose as 'Argon (agy) - medium'); a plan without a pool keeps the
 * raw value it always showed.
 * @returns {string}
 */
export function packageModelLine(plan, pkg) {
  const model = pkg && typeof pkg.model === 'string' ? pkg.model : '';
  const pool = planPool(plan);
  if (!pool || !model) return model;
  if (model === POOL_FREE_KEY) return poolFreeProfileId(pool) || model;
  // A package on an agy variant the pool chose ('agy:<id>' only - 'plan' is no model).
  const variantOf = model.startsWith('agy:') ? pool.find((e) => e.effort === model) : null;
  if (variantOf) return `${poolModelName(variantOf.model)} - ${poolEffortLevel(variantOf)}`;
  const name = poolModelName(model) || model;
  const level = poolEffortLevel(poolEntryOfKey(pool, model));
  return level ? `${name} - ${level}` : name;
}
