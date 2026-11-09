// ============================================================================
// LunaCore - hybrid runs, execution side (FREE_GODMODE_V2_PLAN.md F6c, F6d)
// ----------------------------------------------------------------------------
// In a "Plan with free models in mind" run (orchestraWorkers.js) a package the
// planner marked "free" - and the guard (orchestraHybridGuard.js) left free -
// runs on the free CODING profile, never on auto:easy: only the best free
// models write code. Same worktree flow as a Claude package. Because a hybrid
// run integrates into the target branch (unlike a free-only run), a free
// package must pass a gate first:
//
//   1. verify passes          the normal loop, max rounds as today;
//   2. Claude review          one short read-only headless Sonnet review of
//                             the package diff (orchestraReview.js) -> pass /
//                             fail with reasons; a Claude usage limit is a
//                             wait for the reset (orchestraPlanWait.js);
//   3. pass                   the package counts as pushed and integrates like
//                             any Claude package (orchestraFinalize.js /
//                             orchestraIntegrate.js);
//      fail, or two stalls -> HANDED TO Sonnet in its current worktree: an
//                             upgrade, never a downgrade (Mati's rule).
//
// Waiting (Q9): a free package that hits its free limits waits ALONE - the
// rest of the run (Claude packages) keeps going. Once it has waited 1 hour
// while Claude packages depend on it, it is handed to Sonnet; with no Claude
// dependants it just waits for the reset.
//
// Every hand-over and review result is kept on the package (`hybrid`), so
// the run report (orchestraReport.js) shows per package: planned free?,
// guard upgrades, review result, hand-overs.
//
// The rules are pure functions; createHybridRun() holds the timers and talks
// to the run controller (src/orchestra.js wires it) through injected hooks.
// ============================================================================

'use strict';

const { resolveProfileChain } = require('./freechains');
const { storedWorkers } = require('./orchestraWorkers');
const { PLAN_PROFILE_ID } = require('./orchestraPlanRunLaunch');
const { planWaitDecision } = require('./orchestraPlanWait');
const { buildPackageReviewPrompt } = require('./orchestraReview');

/** The Claude model a free package is handed to. */
const HAND_OVER_MODEL = 'sonnet';
/** Stalls of a free package before it goes to Sonnet. */
const HAND_OVER_AFTER_STALLS = 2;
/** Q9: a free package waiting this long on free limits, with Claude dependants -> Sonnet. */
const FREE_WAIT_HAND_OVER_MS = 60 * 60 * 1000;
/** A free limit without a reset time: look again after this (orchestra DEFAULT_PAUSE_MS). */
const DEFAULT_FREE_WAIT_MS = 30 * 60 * 1000;
/** Resume a little after the reset, not on the second (like the run-wide pause). */
const RESUME_GRACE_MS = 60 * 1000;
/** The free model pool that never writes code. */
const EASY_POOL = 'auto:easy';
/** The preferred coding profile ("FreeLLMAPI - coding", auto:coding). */
const CODING_PROFILE_ID = 'freellm-chain';

const HAND_OVER_KINDS = Object.freeze(['reviewFail', 'twoStalls', 'freeWait']);
const REVIEW_RESULTS = Object.freeze(['pass', 'fail', 'error']);
const MAX_HAND_OVERS = 5;
const MAX_REASONS = 10;
const MAX_TEXT = 300;

const oneLine = (v, max = MAX_TEXT) =>
  String(v == null ? '' : v)
    .replace(/[\x00-\x1f\x7f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

// ---- who runs free -----------------------------------------------------------

/** True for a build run whose Workers choice is "Plan with free models in mind". */
function isHybridPlan(plan) {
  return !!plan && !plan.freeMode && !plan.planRun && storedWorkers(plan) === 'hybrid';
}

/** True when the planner marked the package free (whether or not it stayed free). */
function plannedFree(pkg) {
  return !!pkg && (pkg.model === 'free' || !!(isObject(pkg.hybridGuard) && pkg.hybridGuard.from === 'free'));
}

/** A profile id a free package may run on: any id but the easy-tasks profile. */
function isCodingProfileId(id) {
  return typeof id === 'string' && id.length > 0 && id.length <= 200 && id !== PLAN_PROFILE_ID;
}

/**
 * True when this package runs on a free worker now: a hybrid run with a
 * coding profile picked at Approve, a package still marked free after the
 * guard, and not handed to Claude yet.
 */
function runsFree(plan, pkg) {
  return isHybridPlan(plan) && isCodingProfileId(plan.hybridProfileId) && !!pkg && pkg.model === 'free' && !pkg.modelOverride;
}

/** True when a profile's free models may write code: a chain, and never auto:easy. */
function isCodingProfile(profile, providers, chains) {
  if (!profile || !isCodingProfileId(profile.id)) return false;
  const chain = resolveProfileChain(profile, providers, chains);
  const models = chain && Array.isArray(chain.models) ? chain.models : [];
  if (!models.length) return false;
  const easy = (m) => String(m || '').trim().toLowerCase() === EASY_POOL;
  if (models.some(easy)) return false;
  return !(profile.env && easy(profile.env.ANTHROPIC_MODEL));
}

/**
 * The profile hybrid free packages run on: "FreeLLMAPI - coding" when it is
 * a coding profile, else the first profile that is. Never the easy-tasks
 * profile, never a chain with auto:easy in it. Null = none configured.
 * @param {object[]} profiles
 * @param {object[]} providers
 * @param {object[]} chains
 * @param {string} [preferredId]
 * @returns {string|null}
 */
function pickCodingProfileId(profiles, providers, chains, preferredId = CODING_PROFILE_ID) {
  const list = Array.isArray(profiles) ? profiles : [];
  const ok = (p) => isCodingProfile(p, providers, chains);
  const preferred = list.find((p) => p && p.id === preferredId);
  if (preferred && ok(preferred)) return preferred.id;
  const first = list.find(ok);
  return first ? first.id : null;
}

/**
 * Approve of a hybrid run: the coding profile its free packages run on.
 * A plan without free packages needs none.
 * @param {{packages:object[]}} plan
 * @param {string|null} codingProfileId
 * @returns {{ok:true, profileId:string|null}|{ok:false, error:'noFreeProfile'}}
 */
function approveProfile(plan, codingProfileId) {
  const needs = (plan.packages || []).some((p) => p.model === 'free' && !p.modelOverride);
  if (!needs) return { ok: true, profileId: null };
  return isCodingProfileId(codingProfileId) ? { ok: true, profileId: codingProfileId } : { ok: false, error: 'noFreeProfile' };
}

// ---- the package's hybrid record -----------------------------------------------

const EMPTY = Object.freeze({ review: null, handOvers: [], freeWait: null, reviewWait: null, reviewing: false });

/** The package's hybrid record with defaults (never mutated in place). */
function hybridOf(pkg) {
  const h = pkg && isObject(pkg.hybrid) ? pkg.hybrid : {};
  return {
    review: isObject(h.review) ? h.review : null,
    handOvers: Array.isArray(h.handOvers) ? h.handOvers : [],
    freeWait: isObject(h.freeWait) ? h.freeWait : null,
    reviewWait: isObject(h.reviewWait) ? h.reviewWait : null,
    reviewing: h.reviewing === true,
  };
}

const withHybrid = (pkg, fields) => ({ ...hybridOf(pkg), ...fields });

/** True while a free package waits on its free limits. */
const isFreeWaiting = (pkg) => !!hybridOf(pkg).freeWait;

/**
 * A stored hybrid record back to its shape, or null. Waits and a review in
 * flight are not restored: after a restart no timer runs (the package comes
 * back stalled and Retry starts it again).
 */
function normalizeStoredHybrid(raw) {
  if (!isObject(raw)) return null;
  const at = (v) => (Number.isFinite(v) ? v : null);
  const r = raw.review;
  const review =
    isObject(r) && REVIEW_RESULTS.includes(r.result)
      ? {
          result: r.result,
          reasons: (Array.isArray(r.reasons) ? r.reasons : []).map((x) => oneLine(x)).filter(Boolean).slice(0, MAX_REASONS),
          at: at(r.at),
          ...(typeof r.error === 'string' && r.error ? { error: oneLine(r.error, 64) } : {}),
        }
      : null;
  const handOvers = (Array.isArray(raw.handOvers) ? raw.handOvers : [])
    .filter((h) => isObject(h) && HAND_OVER_KINDS.includes(h.kind))
    .map((h) => ({ kind: h.kind, at: at(h.at), detail: typeof h.detail === 'string' && h.detail ? oneLine(h.detail) : null }))
    .slice(-MAX_HAND_OVERS);
  if (!review && !handOvers.length) return null;
  return { ...EMPTY, review, handOvers };
}

/** A stored plan's coding profile id, or null. */
function normalizeStoredProfileId(raw) {
  return isCodingProfileId(raw) ? raw : null;
}

// ---- hand-over -----------------------------------------------------------------

/**
 * The second stall of a free package (for a reason a stronger model can get
 * past) hands it to Sonnet instead of the usual Opus escalation.
 * @param {object} plan
 * @param {{stalls?:number, root:string|null, branch:string|null}} pkg after the stall was counted
 * @param {string} reason
 * @param {Set<string>} stallReasons orchestraSupervisor ESCALATE_REASONS
 */
function shouldHandOverOnStall(plan, pkg, reason, stallReasons) {
  return (
    runsFree(plan, pkg) &&
    (pkg.stalls || 0) >= HAND_OVER_AFTER_STALLS &&
    !!stallReasons &&
    stallReasons.has(reason) &&
    !!pkg.root &&
    !!pkg.branch
  );
}

/**
 * The fields a hand-over sets: Sonnet from now on (modelOverride), Claude's
 * own ladder - one resume, then Opus - starts afresh, and the hand-over is
 * kept for the report.
 */
function handOverFields(pkg, kind, at, detail = null) {
  const prev = hybridOf(pkg);
  const entry = { kind, at, detail: detail ? oneLine(detail) : null };
  return {
    modelOverride: HAND_OVER_MODEL,
    stalls: 0,
    autoResumed: false,
    hybrid: { ...prev, freeWait: null, reviewWait: null, reviewing: false, handOvers: [...prev.handOvers, entry].slice(-MAX_HAND_OVERS) },
  };
}

const HAND_OVER_WHY = {
  reviewFail: 'a Claude review of its diff failed it',
  twoStalls: 'it stalled twice',
  freeWait: 'it waited 1 hour on free-model limits while Claude packages depend on it',
};

/**
 * The brief of the Sonnet worker that takes a free package over: the normal
 * resume brief plus why, and the review findings when there are any.
 * @param {string} text a briefText(pkg, branch, {resume:true}) result
 * @param {{kind:string, detail?:string|null, reasons?:string[]}} handOver
 */
function handOverBrief(text, { kind, detail = null, reasons = [] }) {
  const findings = (Array.isArray(reasons) ? reasons : []).map((r) => oneLine(r)).filter(Boolean).slice(0, MAX_REASONS);
  return [
    String(text || '').trimEnd(),
    '',
    '## Handed over to you',
    `A free model worked on this package first. LunaCore handed it to you because ${HAND_OVER_WHY[kind] || 'the free worker could not finish it'}${
      detail ? ` (${oneLine(detail)})` : ''
    }.`,
    'Its work so far is in this worktree (`git log`, `git diff`): keep what is right, fix or redo what is not.',
    ...(findings.length ? ['', 'Review findings to fix:', ...findings.map((r) => `- ${r}`)] : []),
    '',
  ].join('\n');
}

// ---- Q9: waiting on free limits --------------------------------------------------

/** The reset of a free limit, or a re-check after DEFAULT_FREE_WAIT_MS. */
function freeWaitUntil(resetsAt, now) {
  return Number.isFinite(resetsAt) && resetsAt > now ? resetsAt : now + DEFAULT_FREE_WAIT_MS;
}

/** The record of a (continued) free wait: the first hit's time stays. */
function startFreeWait(pkg, resetsAt, now) {
  const prev = hybridOf(pkg);
  const since = prev.freeWait && Number.isFinite(prev.freeWait.since) ? prev.freeWait.since : now;
  return { ...prev, freeWait: { since, until: freeWaitUntil(resetsAt, now) } };
}

/**
 * Claude packages still waiting on this one, directly or through other
 * packages: pending, not given up on, not running free themselves.
 * @returns {string[]}
 */
function claudeDependants(plan, id) {
  const packages = plan && Array.isArray(plan.packages) ? plan.packages : [];
  const out = [];
  const seen = new Set([id]);
  const queue = [id];
  while (queue.length) {
    const cur = queue.shift();
    for (const p of packages) {
      if (seen.has(p.id) || !Array.isArray(p.dependsOn) || !p.dependsOn.includes(cur)) continue;
      seen.add(p.id);
      queue.push(p.id);
      if (p.state === 'pending' && !p.terminal && !runsFree(plan, p)) out.push(p.id);
    }
  }
  return out;
}

/**
 * What a free wait does now: resume at the reset (+ grace), hand over to
 * Sonnet after 1 hour when Claude packages depend on it, else keep waiting.
 * @returns {{action:'none'}|{action:'resume'}|{action:'handOver', dependants:string[]}|{action:'wait', at:number}}
 */
function freeWaitStep(plan, pkg, now) {
  const wait = hybridOf(pkg).freeWait;
  if (!wait) return { action: 'none' };
  const resumeAt = wait.until + RESUME_GRACE_MS;
  if (now >= resumeAt) return { action: 'resume' };
  const dependants = claudeDependants(plan, pkg.id);
  if (!dependants.length) return { action: 'wait', at: resumeAt };
  const handAt = wait.since + FREE_WAIT_HAND_OVER_MS;
  if (now >= handAt) return { action: 'handOver', dependants };
  return { action: 'wait', at: Math.min(resumeAt, handAt) };
}

// ---- the review gate -------------------------------------------------------------

/**
 * A review result -> what the gate does. A Claude usage limit waits for the
 * reset like the planner; any other failure fails closed (a free package
 * never integrates unreviewed) and goes to Sonnet.
 * @param {{ok:boolean, verdict?:string, reasons?:string[], error?:string, detail?:string}} res
 * @returns {{action:'pass'|'fail', reasons:string[]}|{action:'wait', resumeAt:number}|{action:'error', error:string, detail:string|null}}
 */
function reviewDecision(res, limits, now) {
  if (res && res.ok) return { action: res.verdict === 'pass' ? 'pass' : 'fail', reasons: Array.isArray(res.reasons) ? res.reasons : [] };
  const failed = res && typeof res === 'object' ? res : { ok: false, error: 'failed' };
  const wait = planWaitDecision({ res: { ...failed, ok: false }, limits, now });
  if (wait.action === 'wait') return { action: 'wait', resumeAt: wait.resumeAt };
  return { action: 'error', error: oneLine(failed.error || 'failed', 64), detail: failed.detail ? oneLine(failed.detail) : null };
}

// ---- board + report ----------------------------------------------------------------

/** What the board shows of a package in a hybrid run (null in any other run). */
function packageView(plan, pkg) {
  if (!isHybridPlan(plan)) return null;
  const h = hybridOf(pkg);
  return {
    plannedFree: plannedFree(pkg),
    runsFree: runsFree(plan, pkg),
    review: h.review ? { ...h.review, reasons: [...h.review.reasons] } : null,
    handOvers: h.handOvers.map((x) => ({ ...x })),
    freeWait: h.freeWait ? { ...h.freeWait } : null,
    reviewWait: h.reviewWait ? { ...h.reviewWait } : null,
    reviewing: h.reviewing,
  };
}

const GUARD_TEXT = {
  noFiles: () => 'no files listed',
  tooManyFiles: (r) => `${r.n} files (max 2)`,
  protected: (r) => `protected path (${r.kind}): ${r.file}`,
  noVerify: () => 'no acceptance test or verify',
};
const HAND_OVER_TEXT = { reviewFail: 'review failed', twoStalls: 'stalled twice', freeWait: 'waited 1 h on free limits' };

const cell = (v) => oneLine(v).replace(/\|/g, '\\|') || '-';

function guardCell(guard) {
  if (!isObject(guard) || !Array.isArray(guard.reasons) || !guard.reasons.length) return '-';
  const reasons = guard.reasons.map((r) => (r && GUARD_TEXT[r.code] ? GUARD_TEXT[r.code](r) : oneLine(r && r.code, 32)));
  return `to Sonnet: ${reasons.join('; ')}`;
}

function reviewCell(review) {
  if (!isObject(review)) return '-';
  const why = Array.isArray(review.reasons) && review.reasons.length ? `: ${review.reasons.join('; ')}` : '';
  const error = review.result === 'error' && review.error ? ` (${review.error})` : '';
  return `${review.result}${error}${why}`;
}

function handOverCell(handOvers) {
  const list = Array.isArray(handOvers) ? handOvers : [];
  if (!list.length) return '-';
  return list.map((h) => `to Sonnet (${HAND_OVER_TEXT[h.kind] || oneLine(h.kind, 32)})`).join('; ');
}

const isHybridView = (view) => isObject(view) && view.workers === 'hybrid' && view.freeMode !== true;
const viewPackages = (view) => (Array.isArray(view.packages) ? view.packages : []).filter(isObject);
const viewHybrid = (p) => (isObject(p.hybrid) ? p.hybrid : {});
const viewPlannedFree = (p) => viewHybrid(p).plannedFree === true || plannedFree(p);

/**
 * The run report's "Free packages" section for a hybrid run, one row per
 * package; [] for any other run.
 * @param {{workers?:string, freeMode?:boolean, packages?:object[]}} view orchestra view()
 * @returns {string[]} markdown lines
 */
function hybridReportLines(view) {
  if (!isHybridView(view)) return [];
  const packages = viewPackages(view);
  const rows = packages.map((p) => {
    const h = viewHybrid(p);
    return `| \`${cell(p.id)}\` | ${viewPlannedFree(p) ? 'yes' : 'no'} | ${cell(guardCell(p.hybridGuard))} | ${cell(reviewCell(h.review))} | ${cell(handOverCell(h.handOvers))} |`;
  });
  const planned = packages.filter(viewPlannedFree).length;
  const passed = packages.filter((p) => isObject(viewHybrid(p).review) && viewHybrid(p).review.result === 'pass').length;
  const handed = packages.filter((p) => Array.isArray(viewHybrid(p).handOvers) && viewHybrid(p).handOvers.length).length;
  return [
    '',
    '## Free packages (hybrid run)',
    '',
    `- ${planned} of ${packages.length} planned free; ${passed} passed the Claude review; ${handed} handed to Sonnet`,
    '',
    '| Package | Planned free | Guard upgrade | Review | Hand-overs |',
    '|---|---|---|---|---|',
    ...rows,
  ];
}

/**
 * The same rows for the HTML report: [package, planned free, guard, review, hand-overs].
 * @returns {string[][]|null} null for any other run
 */
function hybridReportRows(view) {
  if (!isHybridView(view)) return null;
  return viewPackages(view).map((p) => {
    const h = viewHybrid(p);
    return [oneLine(p.id, 64), viewPlannedFree(p) ? 'yes' : 'no', guardCell(p.hybridGuard), oneLine(reviewCell(h.review)) || '-', handOverCell(h.handOvers)];
  });
}

// ---- the controller side -------------------------------------------------------------

/**
 * The hybrid part of one run controller: the review gate, hand-overs and
 * the per-package free waits. Timers and the clock are injected.
 * @param {{
 *   getPlan: () => object|null, findPkg: (id:string) => object|null,
 *   patch: (id:string, fields:object) => void, commit: () => void, kick: () => void,
 *   now: () => number, setTimer: Function, clearTimer: Function,
 *   onRunEvent?: (kind:string, data?:object) => void, log?: (line:string) => void,
 *   stallReasons: Set<string>, resumeText: string,
 *   cancelNudge: (id:string) => void, writePty: (sessionId:string, text:string, opts?:object) => boolean,
 *   briefText: (pkg:object, branch:string, opts:object) => string,
 *   reopen: (pkg:object, text:string) => {ok:boolean, error?:string},
 *   landPushed: (id:string) => void, stall: (id:string, reason:string, detail?:string|null) => void,
 *   runReview?: Function, reviewDiff?: Function, reviewEnv?: () => object|null,
 *   usageLimits?: () => object[],
 * }} deps
 */
function createHybridRun(deps) {
  const { now, setTimer, clearTimer } = deps;
  const onRunEvent = deps.onRunEvent || (() => {});
  const log = deps.log || (() => {});
  /** pkgId -> free-wait timer */
  const freeTimers = new Map();
  /** pkgId -> review retry timer (Claude limit) */
  const reviewTimers = new Map();

  const plan = () => deps.getPlan();
  const unref = (t) => {
    if (t && typeof t.unref === 'function') t.unref();
    return t;
  };

  function dropTimer(map, id) {
    const t = map.get(id);
    if (t) clearTimer(t);
    map.delete(id);
  }

  /** The tab profile of a package: the coding profile while it runs free. */
  function profileFor(pkg, fallbackProfileId) {
    const p = plan();
    return runsFree(p, pkg) ? p.hybridProfileId : fallbackProfileId;
  }

  /**
   * Hands a free package to Sonnet in its worktree. The fields land first,
   * so even when no tab opens, a Retry reopens it on Sonnet.
   * @returns {boolean} the Sonnet tab opened
   */
  function handOver(pkg, kind, { detail = null, reasons = [] } = {}) {
    dropTimer(freeTimers, pkg.id);
    dropTimer(reviewTimers, pkg.id);
    deps.patch(pkg.id, handOverFields(pkg, kind, now(), detail));
    const fresh = deps.findPkg(pkg.id);
    const text = handOverBrief(deps.briefText(fresh, fresh.branch, { resume: true }), { kind, detail, reasons });
    const res = deps.reopen(fresh, text);
    onRunEvent('handedOver', { id: pkg.id, kind, ok: res.ok === true });
    if (!res.ok) log(`[hybrid] hand-over of ${pkg.id} to Sonnet could not open a tab: ${res.error || 'failed'}`);
    return res.ok === true;
  }

  /** stall(): the second stall of a free package goes to Sonnet. */
  function wantsHandOver(pkg, reason) {
    return shouldHandOverOnStall(plan(), pkg, reason, deps.stallReasons);
  }

  // ---- review gate ----

  /**
   * finish() after a passed verify: a free package is reviewed before it
   * counts as pushed. True = the review owns the package now.
   */
  function gate(id) {
    const p = plan();
    const pkg = deps.findPkg(id);
    if (!pkg || !runsFree(p, pkg)) return false;
    deps.patch(id, { hybrid: withHybrid(pkg, { reviewing: true, reviewWait: null }) });
    onRunEvent('reviewing', { id });
    startReview(p.id, id);
    return true;
  }

  function startReview(planId, id) {
    review(planId, id).catch((err) => {
      log(`[hybrid] review of ${id} failed: ${err instanceof Error ? err.message : String(err)}`);
      settleReview(planId, id, { ok: false, error: 'failed' });
    });
  }

  async function runOneReview(pkg) {
    if (!deps.runReview || !deps.reviewDiff) return { ok: false, error: 'unavailable' };
    const diff = await deps.reviewDiff({ cwd: pkg.root, from: pkg.baseSha, to: pkg.headSha || 'HEAD' });
    if (!diff || !diff.ok) return { ok: false, error: 'noDiff', detail: diff && diff.error ? diff.error : null };
    const env = deps.reviewEnv ? deps.reviewEnv() : null;
    if (!env) return { ok: false, error: 'noEnv' };
    const prompt = buildPackageReviewPrompt({ ...pkg, diff: diff.diff, stat: diff.stat });
    return deps.runReview({ cwd: pkg.root, env, prompt });
  }

  async function review(planId, id) {
    const res = await runOneReview(deps.findPkg(id));
    settleReview(planId, id, res);
  }

  function settleReview(planId, id, res) {
    const p = plan();
    if (!p || p.id !== planId) return;
    const pkg = deps.findPkg(id);
    if (!pkg || pkg.state !== 'finishing') return;
    // Killed while the review ran: stopped like a running worker is.
    if (p.killed) {
      deps.patch(id, { state: 'killed', hybrid: withHybrid(pkg, { reviewing: false, reviewWait: null }) });
      deps.commit();
      return;
    }
    const decision = reviewDecision(res, deps.usageLimits ? deps.usageLimits() : [], now());
    if (decision.action === 'wait') {
      deps.patch(id, { hybrid: withHybrid(pkg, { reviewing: false, reviewWait: { until: decision.resumeAt } }) });
      dropTimer(reviewTimers, id);
      reviewTimers.set(id, unref(setTimer(() => retryReview(planId, id), Math.max(0, decision.resumeAt - now()))));
      onRunEvent('reviewWait', { id, until: decision.resumeAt });
      deps.commit();
      return;
    }
    const result = decision.action === 'pass' ? 'pass' : decision.action === 'fail' ? 'fail' : 'error';
    const reasons = (decision.reasons || []).map((r) => oneLine(r)).filter(Boolean).slice(0, MAX_REASONS);
    const record = { result, reasons, at: now(), ...(result === 'error' ? { error: decision.error } : {}) };
    deps.patch(id, { hybrid: withHybrid(pkg, { reviewing: false, reviewWait: null, review: record }) });
    onRunEvent('reviewed', { id, result });
    if (result === 'pass') {
      deps.landPushed(id);
      return;
    }
    const detail = result === 'error' ? `review could not run: ${decision.error}${decision.detail ? ` - ${decision.detail}` : ''}` : null;
    if (!handOver(deps.findPkg(id), 'reviewFail', { detail, reasons })) {
      deps.stall(id, 'handOverFailed', detail || reasons[0] || null);
      return;
    }
    deps.commit();
  }

  function retryReview(planId, id) {
    reviewTimers.delete(id);
    const p = plan();
    const pkg = deps.findPkg(id);
    if (!p || p.id !== planId || !pkg || pkg.state !== 'finishing') return;
    if (p.killed) {
      settleReview(planId, id, { ok: false, error: 'killed' });
      return;
    }
    deps.patch(id, { hybrid: withHybrid(pkg, { reviewing: true, reviewWait: null }) });
    deps.commit();
    startReview(planId, id);
  }

  // ---- Q9 free waits ----

  /**
   * A free worker hit its free limits: only this package waits. False = not
   * a free package of a hybrid run (the usual run-wide pause applies).
   */
  function onUsageLimit(pkg, resetsAt) {
    const p = plan();
    if (!p || p.killed || !runsFree(p, pkg) || pkg.state !== 'launched') return false;
    deps.cancelNudge(pkg.id);
    const hybrid = startFreeWait(pkg, resetsAt, now());
    deps.patch(pkg.id, { hybrid });
    armFreeWait(pkg.id);
    onRunEvent('freeWait', { id: pkg.id, until: hybrid.freeWait.until });
    deps.commit();
    return true;
  }

  function armFreeWait(id) {
    dropTimer(freeTimers, id);
    const step = freeWaitStep(plan(), deps.findPkg(id), now());
    const at = step.action === 'wait' ? step.at : now();
    freeTimers.set(id, unref(setTimer(() => fireFreeWait(id), Math.max(0, at - now()))));
  }

  /** The wait is over: the time spent waiting is not working time. */
  function endFreeWait(pkg) {
    const wait = hybridOf(pkg).freeWait;
    const waited = wait ? Math.max(0, now() - wait.since) : 0;
    const credit = Math.max(0, Math.min(waited, now() - (pkg.startedAt || now())));
    deps.patch(pkg.id, { pausedMs: (pkg.pausedMs || 0) + credit, hybrid: withHybrid(pkg, { freeWait: null }) });
  }

  function fireFreeWait(id) {
    freeTimers.delete(id);
    const p = plan();
    const pkg = deps.findPkg(id);
    if (!p || p.killed || !pkg || pkg.state !== 'launched' || !isFreeWaiting(pkg)) return;
    const step = freeWaitStep(p, pkg, now());
    if (step.action === 'resume') {
      endFreeWait(pkg);
      if (!deps.writePty(pkg.sessionId, deps.resumeText, { paste: true })) {
        deps.stall(id, 'noTab');
        return;
      }
      onRunEvent('freeResumed', { id });
      deps.commit();
      return;
    }
    if (step.action === 'handOver') {
      const minutes = Math.round((now() - hybridOf(pkg).freeWait.since) / 60000);
      const detail = `${minutes} min on free limits; waiting on it: ${step.dependants.join(', ')}`;
      if (!handOver(pkg, 'freeWait', { detail })) {
        deps.stall(id, 'handOverFailed', detail);
        return;
      }
      deps.commit();
      deps.kick();
      return;
    }
    armFreeWait(id);
  }

  /** The package moved on (finished, stalled, handed over): no wait left. */
  function forget(id) {
    dropTimer(freeTimers, id);
    const pkg = deps.findPkg(id);
    if (pkg && isFreeWaiting(pkg)) endFreeWait(pkg);
  }

  /**
   * Kill / discard / a new plan: every timer goes. Returns the packages
   * whose review was waiting for the Claude limit (the caller stops them).
   * @returns {string[]}
   */
  function cancelAll() {
    // forget() also ends the wait record: a later Retry starts clean.
    for (const id of [...freeTimers.keys()]) forget(id);
    const waiting = [...reviewTimers.keys()];
    for (const id of waiting) dropTimer(reviewTimers, id);
    return waiting;
  }

  return {
    profileFor,
    // Only while its wait timer is armed: a stale record never silences the watchdog.
    isWaiting: (pkg) => !!pkg && freeTimers.has(pkg.id) && runsFree(plan(), pkg) && isFreeWaiting(pkg),
    wantsHandOver,
    handOver,
    gate,
    onUsageLimit,
    forget,
    cancelAll,
    view: (pkg) => packageView(plan(), pkg),
  };
}

module.exports = {
  HAND_OVER_MODEL,
  HAND_OVER_AFTER_STALLS,
  FREE_WAIT_HAND_OVER_MS,
  DEFAULT_FREE_WAIT_MS,
  RESUME_GRACE_MS,
  CODING_PROFILE_ID,
  EASY_POOL,
  HAND_OVER_KINDS,
  isHybridPlan,
  plannedFree,
  runsFree,
  isCodingProfileId,
  isCodingProfile,
  pickCodingProfileId,
  approveProfile,
  hybridOf,
  normalizeStoredHybrid,
  normalizeStoredProfileId,
  shouldHandOverOnStall,
  handOverFields,
  handOverBrief,
  freeWaitUntil,
  startFreeWait,
  claudeDependants,
  freeWaitStep,
  reviewDecision,
  packageView,
  hybridReportLines,
  hybridReportRows,
  createHybridRun,
};
