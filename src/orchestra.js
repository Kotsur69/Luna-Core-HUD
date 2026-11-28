// ============================================================================
// LunaCore - God Mode v2 run controller (DONE_ORCHESTRATOR_PLAN.md slices 3 + 4)
// ----------------------------------------------------------------------------
// One plan at a time lives here, in the main process: the renderer only ever
// sees a view of it and refers to it by id, so it can approve, edit a prompt,
// retry or kill - never name a folder, a branch or a profile.
//
// Slice 3: plan -> review -> launch. Launching a package = a fresh worktree
// (src/worktrees.js) + a brief file + a normal tab whose `claude` starts with
// "read your brief" as its first message (launch.js withTaskBrief).
//
// Slice 4 (supervisor + finish): Approve STARTS the run - every package whose
// dependencies are pushed launches as a worker slot frees up. Per worker:
//   turn end    -> LUNA_DONE: finish (orchestraFinish.js: commit leftovers,
//                  verify ourselves, push the branch, tick its to-dos)
//                  no marker: nudge, max 3 -> stalled
//   usage limit -> RUN-wide pause (the limit is per account), one timer,
//                  every worker told to continue once it resets
//   approval    -> that worker stalled, the others keep going
//   2 h working -> stalled
// Second pass: scheduled start (now / HH:MM / when the 5 h window resets),
// Sonnet -> Opus escalation after two stalls, a live file-overlap guard fed by
// each worker's git status, and approval stalls logged as allow-rule
// suggestions. Slice 5: once the run settles, orchestraFinalize.js opens PRs /
// merges / does nothing (per run), removes pushed worktrees, notes stalled
// packages on their to-dos and writes the report.
// Rules live in orchestraSupervisor.js (pure); timers, tabs and git are here
// behind injected deps. The run is written to orchestra.local.json on every
// transition; after a restart running packages come back stalled with their
// worktrees, and Retry picks them up.
// ============================================================================

'use strict';

const path = require('path');
const { validatePlan, estimatePlan, pickTodos, plannerEffortOf, plannerModelOf, MAX_PARALLEL, MAX_PROMPT_CHARS, PLANNER_MODEL } = require('./orchestraPlan');
const { lastWordsFrom, handbackFrom, outputTail } = require('./orchestraDiagnose');
const sup = require('./orchestraSupervisor');
const { DEFAULT_EFFORT, isEffort, normalizeEffort, nextEffort } = require('./efforts');
const { createFinalizer, ABORT_FINISH_AFTER_MS, postMergeContext, slugOf } = require('./orchestraFinalize');
const { createFixupRunner } = require('./orchestraFixup');
const briefMemoryRules = require('./orchestraBriefMemory');
const workerBrief = require('./workerBrief');
const followupLaunch = require('./orchestraFollowupsLaunch');
const { normalizeFollowupEntries, followupBriefLines } = require('./orchestraFollowups');
const pushSecrets = require('./pushSecrets');
const { unityRuleLines } = require('./orchestraBriefUnity');
const { createMergeRunDeps } = require('./orchestraMergeRun');
const { planWaitDecision, createPlanWaiter } = require('./orchestraPlanWait');
// A planner limit with another Claude account free: replan after this long.
const ACCOUNT_SWITCH_RETRY_MS = 3000;
const { FREE_BRANCH_PREFIX, isSafeFreeBranch, freeRunSettings, integrationFor, maxParallelFor } = require('./orchestraFree');
const {
  cleanupFailedLaunch,
  earlierWorktrees,
  clearEarlierLaunches,
  withLeftover,
  sweepOrphanBranches,
} = require('./orchestraCleanup');
const { launchRetryDecision, createResumeGate } = require('./orchestraLaunchRetry');
const { createPowerFlow } = require('./orchestraPower');
const { createPowerCtl } = require('./powerctl');
const { createSleepWatch, sleepCredit, recordSleep } = require('./orchestraSleep');
const { createRecoverer } = require('./orchestraRecover');
const { createHoldWatch } = require('./orchestraHoldWatch');
const { holdCause } = require('./orchestraDeps');
// Free God Mode v2 plan runs: lockdown + branches, start, view (logic lives there).
const planLaunch = require('./orchestraPlanRunLaunch');
const planStart = require('./orchestraPlanRunStart');
const planView = require('./orchestraPlanRunView');
const { ROLE_SYNTHESIS, planPath: planDocPath } = require('./orchestraPlanRun');
// Free God Mode v2 build runs: plan context, free planner, auto-split (logic lives there).
const planBuild = require('./orchestraPlanBuild');
const autoSplit = require('./orchestraAutoSplit');
// Hybrid runs (F6): the "Workers" choice and the guard over "free" packages.
const workersRules = require('./orchestraWorkers');
// The run's worker model (Approve screen / phone) and the model each package runs on.
const workerModelRules = require('./orchestraWorkerModel');
const hybridGuard = require('./orchestraHybridGuard');
// Hybrid runs, execution side (F6c/F6d) and the opt-in free-branch review (F5).
const hybridRules = require('./orchestraHybrid');
// Antigravity (agy) runs: which packages and helper jobs go to agy.
const agyRules = require('./orchestraAgy');
const { agyModelIdOf } = require('./workerModels');
// "Workers" pools (2+ ticked worker models): planned for, routed per package.
const { createPoolWiring } = require('./orchestraPoolWiring');
const { poolWorkers } = require('./workerPool');
// Per-model efforts of a pool (src/orchestraPoolEffort.js) and its usage line's numbers.
const poolEffortRules = require('./orchestraPoolEffort');
const { poolUsageReadings } = require('./orchestraPoolUsage');
// Pool rescue (src/orchestraRescue.js): escalation ladder, limit moves, emergency Opus.
const { createRescueWiring } = require('./orchestraRescueWiring');
const rescueRules = require('./orchestraRescue');
// Per-kind parallel caps of a mixed pool run (agy counted over every run).
const kindCapRules = require('./orchestraKindCaps');
const editorSlots = require('./orchestraEditorSlots');
// A package's model + effort picked on the Approve board (pool runs).
const packageModelRules = require('./orchestraPackageModel');
const { createFreeReviewer } = require('./orchestraFreeReview');
// Token bookkeeping of a run (additive: nothing here decides anything).
const { createUsageBook } = require('./orchestraUsage');
const resumeRules = require('./orchestraResume');
// Usage-limit pauses, one per backend plus the whole-run one (pure helpers).
const pauseRules = require('./orchestraPauses');
// Opt-in, fixed per plan (options abBuild / selfHeal / contextGuard): A/B
// builds, self-healing workers, predictive context routing (logic lives there).
const variantRules = require('./orchestraVariants');
const { createVariantRunner } = require('./orchestraVariantRun');
const { createHealer } = require('./orchestraHeal');
const { createContextGuard, contextResumeSection } = require('./orchestraContextGuard');
const { createVerifySemaphore, DEFAULT_VERIFY_CONCURRENCY } = require('./worktrees');

/**
 * The runPlanner args. A Claude plan without plan docs gets exactly the args
 * it always had; the free planner, plan docs, a follow-up request and a
 * hybrid run add keys - and so does a planner model other than the default.
 */
function plannerArgs({ cwd, env, openTodos, effort, model, planner, planDocs, extraPrompt, hybrid, abBuild, pool = null, agyModel = null, poolEfforts = null, poolUsage = null }) {
  return {
    cwd,
    env,
    openTodos,
    effort,
    ...(model && model !== PLANNER_MODEL && planner === 'claude' ? { model } : {}),
    ...(planner === 'free' || planner === 'agy' ? { planner } : {}),
    ...(planDocs && planDocs.length ? { planDocs } : {}),
    ...(extraPrompt ? { extraPrompt } : {}),
    ...(hybrid === true ? { hybrid: true } : {}),
    ...(abBuild === true ? { abBuild: true } : {}),
    // A pool run: the planner keys it may name (orchestraPlan.js plannerPool).
    ...(Array.isArray(pool) && pool.length ? { pool } : {}),
    // The agy planner's --model id (live-checked); none = agy's default model.
    ...(planner === 'agy' && agyModel ? { agyModel } : {}),
    // A pool run's fixed per-model efforts and current usage (prompt lines); none = no key.
    ...(Array.isArray(pool) && pool.length && Array.isArray(poolEfforts) && poolEfforts.length ? { poolEfforts } : {}),
    ...(Array.isArray(pool) && pool.length && Array.isArray(poolUsage) && poolUsage.length ? { poolUsage } : {}),
  };
}

// LunaCore's own folder under userDir() for worker launch files that are not
// briefs (the plan workers' --mcp-config). Briefs live in the worker's cwd
// (src/workerBrief.js).
const BRIEF_DIR = 'tasks';
// A turn end and the usage-limit error that ended it arrive in one transcript
// fragment, the limit second; the nudge waits this long so the pause can
// cancel it instead of spending a nudge on a wall.
const NUDGE_DELAY_MS = 5000;
// No reset time parsed from the limit message -> look again after this.
const DEFAULT_PAUSE_MS = 30 * 60 * 1000;
// Resume a little after the reset, not on the second.
const RESUME_GRACE_MS = 60 * 1000;
// A turn that ended while a background process of the worker's own still
// ran (a test suite) is not nudged: LunaCore waits for the process to report
// back, at most this long, so a stuck process cannot hold the package forever.
const BACKGROUND_WAIT_MS = 30 * 60 * 1000;
// A launch that failed on machinery (worktree, brief, tab) is tried again
// by itself after this long, at most sup.MAX_AUTO_RETRIES times.
const AUTO_RETRY_DELAY_MS = 2 * 60 * 1000;
const ESC = '\x1b';

/**
 * The brief a worker reads first: LunaCore's own fixed contract around the
 * planner's prompt, so the rules do not depend on the planner remembering
 * them.
 * @param {{id:string, title:string, prompt:string, verify:string}} pkg
 * @param {string} branch
 * @param {{resume?:boolean, escalation?:{reason:string, detail:string|null},
 *   depMerge?:{branches:string[], files:string[]}|null, memory?:string|null, followups?:boolean}} [opts] depMerge
 *   defaults to the package's recorded one, so a resume brief keeps it;
 *   memory = the "## Project memory" section (src/memoryinject.js), or none;
 *   followups = the run's plan.followups (the follow-up to-do section only when true)
 * @returns {string}
 */
function briefText(pkg, branch, opts = {}) {
  // A plan-run worker has no shell: its own brief, no verify, no git.
  if (pkg.planRun) return planLaunch.planBriefText(pkg, branch, opts);
  const esc = opts.escalation;
  const depMerge = opts.depMerge !== undefined ? opts.depMerge : pkg.depMerge;
  return [
    `# LunaCore task: ${pkg.title}`,
    '',
    ...depMergeSection(pkg, depMerge, opts.resume),
    `Package \`${pkg.id}\` of a God Mode plan. You are in an isolated git worktree on branch \`${branch}\`.`,
    ...(opts.resume
      ? [
          '',
          'RESUMING: an earlier session already worked on this. Check `git status` and `git log` first and continue from there.',
          RESUME_COMMIT_RULE,
        ]
      : []),
    ...(esc
      ? [
          '',
          `ESCALATED: the previous worker stalled twice on this package (last reason: ${esc.reason}${
            esc.detail ? ` - ${esc.detail}` : ''
          }). Find out why before you continue.`,
        ]
      : []),
    '',
    pkg.prompt,
    '',
    ...(opts.memory ? [opts.memory, ''] : []),
    ...followupBriefLines(opts.followups),
    '## Verify',
    pkg.verify ? `Run \`${pkg.verify}\` and fix until it passes.` : "Check your work with the project's tests before you finish.",
    'Run the verify command in the foreground and wait for it to finish. Do not end your turn while a test run (or any other command) of yours is still running in the background: an ended turn tells LunaCore you stopped.',
    FOREGROUND_TEST_RULE,
    '',
    '## Rules',
    '- Work only in this worktree. Do not push, merge or switch branches.',
    `- ${DEPS_RULE}`,
    `- ${COMMIT_EARLY_RULE}`,
    '- When the work is done and verified, commit it on this branch with a conventional commit message.',
    pushSecrets.FAKE_SECRET_RULE,
    ...unityRuleLines(pkg),
    `- End your final message with the line \`LUNA_DONE ${pkg.id}\`, or \`LUNA_BLOCKED ${pkg.id}: <reason>\` if you cannot finish.`,
    '',
  ].join('\n');
}

// LunaCore installs every package worktree's dependencies before the worker
// starts (orchestraDeps.js). A worker that links node_modules to the main
// checkout empties it when the worktree is removed.
const DEPS_RULE =
  'Dependencies are already installed in this worktree (node_modules). Do not link node_modules to another checkout and do not reinstall, delete or replace them. If they look broken, stop and end with LUNA_BLOCKED.';

// A worker that finished but never committed loses its work when the working
// cap stops it and LunaCore restarts it for 'timeout'.
const COMMIT_EARLY_RULE =
  "Commit early: as soon as the brief's must-haves pass their targeted tests, commit them on this branch. Then keep extending and commit again after each further slice, so a stop at the working cap loses nothing.";

// A turn that ends while `npm test` runs in the background reads as a
// noMarker stall (no LUNA_DONE line), so the final run stays in the foreground.
const FOREGROUND_TEST_RULE =
  'Run the final `npm test` detached with its output in a log file (on Windows: `Start-Process cmd /c "npm test > <log> 2>&1 & echo done > <done-file>"`), then poll with waits of under 10 minutes each (about 570 s) for the done marker or a `# fail` line in the log. The full suite takes about 20 minutes, so start it only once. Never end your turn while the suite is still running, and do not end it before the commit and the LUNA_DONE / LUNA_BLOCKED line are done.';

// A resumed worker secures what the previous session left before new work.
const RESUME_COMMIT_RULE =
  'Before anything else: run the test files the earlier session touched, then the full suite, then commit what passes. Only then continue with new work.';

// A noMarker restart usually means the previous turn ended while a test run
// was still going: its log and a drafted commit may already be there.
const NO_MARKER_RESUME_NOTE =
  "The previous turn ended without a LUNA_DONE line, often while a test run was still going. First check whether the previous session's saved test log finished green and whether a drafted commit message is waiting; if so, commit and finish instead of starting over.";

/** A package a 'noNodeModules' hold keeps waiting (verify, launch, restart or Retry). */
const isHeld = (p) => p.awaitingDeps === true || !!p.heldResume || p.heldLaunch === true || p.heldRetry === true;

// One line of model-facing text from git output: no control characters.
const oneLine = (v) => String(v).replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 300);

/**
 * The first section of a brief whose dependency branches could not all be
 * merged at launch: the worker merges them itself before its task.
 * @param {{id:string, verify:string}} pkg
 * @param {{branches:string[], files:string[]}|null|undefined} depMerge
 * @param {boolean} [resume]
 * @returns {string[]}
 */
function depMergeSection(pkg, depMerge, resume) {
  if (!depMerge || !Array.isArray(depMerge.branches) || !depMerge.branches.length) return [];
  const files = Array.isArray(depMerge.files) ? depMerge.files : [];
  const verify = pkg.verify ? `\`${pkg.verify}\`` : "the project's tests";
  return [
    '## Before your task: merge the dependency branches',
    `Your worktree starts from one dependency; these branches could not be merged automatically${
      resume ? ' (skip the ones `git log` shows as already merged)' : ''
    }:`,
    ...depMerge.branches.map((b) => `- \`git merge --no-edit ${oneLine(b)}\``),
    ...(files.length ? ['', `Conflicting files: ${files.map((f) => `\`${oneLine(f)}\``).join(', ')}.`] : []),
    '',
    `For each branch above run the merge, resolve every conflict keeping the intent of BOTH sides, run ${verify}, and commit the merge. Only then start the task.`,
    `If you truly cannot resolve it, end with \`LUNA_BLOCKED ${pkg.id}: dependency merge\`.`,
    '',
  ];
}

/**
 * What a worker has to merge itself, or null when the launch merged every
 * dependency branch (cleanly or with the headless resolver).
 * @param {object|null|undefined} merged mergeDeps result
 * @param {string[]} branches the branches that were asked for
 * @returns {{strategy:'worker', branches:string[], files:string[]}|null}
 */
function workerDepMerge(merged, branches) {
  if (merged && merged.ok) return null;
  const failed = merged && Array.isArray(merged.failed) && merged.failed.length ? merged.failed : [merged || {}];
  const named = failed.map((f) => f.branch).filter((b) => branches.includes(b));
  const files = [];
  for (const f of failed) {
    for (const file of Array.isArray(f.files) ? f.files : []) {
      if (typeof file === 'string' && !files.includes(file)) files.push(file);
    }
  }
  // A result without branch names (older shape): hand the worker all of them.
  return { strategy: 'worker', branches: (named.length ? named : branches).slice(0, 10), files: files.slice(0, 10) };
}

// Where in a launch each failure code happened (the board's failure block).
const FAILURE_STAGES = {
  briefFailed: 'brief',
  noTab: 'tab',
  launchThrew: 'launch',
  unsafeBranch: 'worktree',
  depMergeFailed: 'depMerge',
  conflict: 'depMerge',
  depVerifyFailed: 'depVerify',
};

/**
 * The structured record of a failed launch the board renders: code, stage,
 * the dependency branch involved, the conflicting files, when it happened.
 * @param {{error?:string, detail?:string|null, depMerge?:object|null}} result
 * @param {string|null} depBranch the dependency the worktree started from
 * @param {number} at
 */
function failureOf(result, depBranch, at) {
  const code = result.error || 'failed';
  const dm = result.depMerge && Array.isArray(result.depMerge.branches) ? result.depMerge : null;
  return {
    code,
    stage: FAILURE_STAGES[code] || 'worktree',
    branch: (dm && dm.branches[0]) || depBranch || null,
    files: dm && Array.isArray(dm.files) ? dm.files.slice(0, sup.MAX_FAILURE_FILES) : [],
    detail: result.detail || null,
    at,
  };
}

/**
 * A resume brief for an automatic restart after a stall: the normal brief
 * plus why the previous session stopped, so the new one starts there.
 * @param {string} text a briefText() result
 * @param {string} reason the stall reason (noMarker, blocked, ...)
 * @param {string|null} detail
 * @returns {string}
 */
function withStallNote(text, reason, detail) {
  return [
    text.trimEnd(),
    '',
    '## Why you were restarted',
    `The previous session on this package stalled (reason: ${reason}${detail ? ` - ${detail}` : ''}). Find out why before you continue.`,
    ...(reason === 'noMarker' ? [NO_MARKER_RESUME_NOTE] : []),
    '',
  ].join('\n');
}

/**
 * Luna's Work hook: the to-dos a plan is built from when the caller names
 * the cards itself. Each entry is a card's `at` or a card object; only open,
 * non-manual store cards count (their `at` is what gets ticked later), in
 * the given order, each once. A given object's fields (e.g. a builder brief
 * in `details`) override the stored card's.
 * @param {Array<object>} allOpen open, non-manual store cards
 * @param {Array<number|object>} cards
 * @returns {Array<object>}
 */
function givenCards(allOpen, cards) {
  const open = new Map(allOpen.map((t) => [t.at, t]));
  const out = [];
  const seen = new Set();
  for (const c of cards) {
    const isObject = !!c && typeof c === 'object';
    const at = isObject ? c.at : c;
    if (!Number.isFinite(at) || seen.has(at) || !open.has(at)) continue;
    seen.add(at);
    const stored = open.get(at);
    out.push(isObject ? { ...stored, ...c, at, text: typeof c.text === 'string' && c.text ? c.text : stored.text } : stored);
  }
  return out;
}

/**
 * A planned package with its fresh run state (makePlan and makePlanRun).
 * @param {object} p a validatePlan() / buildPlanRunPackages() package
 */
function runPackage(p) {
  return {
    ...p,
    state: 'pending',
    sessionId: null,
    branch: null,
    root: null,
    cwd: null,
    briefPath: null,
    baseSha: null,
    headSha: null,
    error: null,
    detail: null,
    nudges: 0,
    verifyRounds: 0,
    startedAt: null,
    pausedMs: 0,
    stalls: 0,
    stallHistory: [],
    escalated: false,
    // A weak-model guard move (src/orchestraWeakGuard.js) is planned as an override; nothing else is.
    modelOverride: p.weakGuard ? p.modelOverride || null : null,
    effortOverride: p.weakGuard ? p.effortOverride || null : null,
    touched: [],
    prUrl: null,
    merged: false,
    cleaned: false,
    autoRetries: 0,
    autoResumed: false,
    terminal: false,
    blockedBy: null,
    stalledAt: null,
    failure: null,
    // Push protection (pushSecrets.js): one fix-up round each for the
    // pre-push secret scan and for a GH013 rejection.
    scanFixup: false,
    pushFixup: false,
    pushBlockedSha: null,
    pushBlockDetail: null,
    // 'queued' | 'running' while finishing (verifyQueue.js), else null.
    verifyPhase: null,
  };
}

/**
 * @param {{
 *   runPlanner: Function, addWorktree: Function, createSession: Function,
 *   readTodos: Function, dirtyCount: Function, writeBrief: Function,
 *   removeBrief?: (file:string) => boolean, now?: () => number,
 *   finishPackage?: Function, headSha?: Function, writePty?: Function,
 *   sessionAlive?: Function, tickTodos?: Function, workerSettings?: Function, workerTools?: Function,
 *   saveState?: Function, loadState?: Function, onChange?: Function, onLive?: Function,
 *   onRunEvent?: Function, setTimer?: Function, clearTimer?: Function,
 *   closeSession?: Function, usageResetAt?: () => number|null,
 *   baseBranchOf?: Function, mergeDeps?: Function, createPr?: Function,
 *   integrateMerge?: Function, removeWorktree?: Function, updateTodos?: Function,
 *   writeReport?: Function, notify?: Function, putSnapshot?: Function, sleep?: Function,
 *   runSelfCheck?: Function, pushBranch?: Function, deleteBranch?: Function,
 *   listOwnBranches?: Function, worktreeBranches?: Function, log?: Function,
 *   power?: object, awake?: {release:Function, restore:Function}, flush?: Function,
 *   notifyPower?: Function, appendReport?: Function, otherRunsActive?: () => boolean,
 *   repoBusy?: (repoPath:string) => boolean, powerFlow?: ReturnType<typeof createPowerFlow>,
 * }} deps
 *   workerTools: (pkg) => kit|null - a Luna's Work build's tool kit for one
 *   package's tab (lunasworkBuild.workerTools); null = plain God Mode.
 *   worktreeEditors: () => {max, needs(pkg), close(root, repoPath)}|null - a
 *   Luna's Work Unity build's packages with their own worktree editor: at most
 *   `max` hold a slot at once, and their editors close when they settle
 *   (src/orchestraEditorSlots.js); null = no cap, as before.
 *   repoBusy: multi God Mode (orchestraRegistry.js) - another project's run
 *   holds this repo, so makePlan refuses with 'repoBusy'.
 *   powerFlow: multi God Mode A3 - the registry's ONE sleep / shutdown flow
 *   over every run. Without it the controller builds its own from `power`,
 *   `awake`, `flush`, `notifyPower` and `appendReport` (a single run).
 */
function createOrchestra(deps) {
  const now = deps.now || Date.now;
  const noop = () => {};
  const finishPackage = deps.finishPackage || (async () => ({ ok: false, stage: 'push', detail: 'unavailable' }));
  const headSha = deps.headSha || (async () => null);
  const writePty = deps.writePty || (() => false);
  const sessionAlive = deps.sessionAlive || (() => false);
  const tickTodos = deps.tickTodos || noop;
  const workerSettings =
    deps.workerSettings ||
    (() => ({ model: 'opus', effort: 'plan', permissionMode: 'bypassPermissions', integration: 'pr', allowedTools: [] }));
  const closeSession = deps.closeSession || noop;
  // Saves the ui pref orchestraWorkerModel (uiprefs.writeUiPrefs in the wiring).
  const saveWorkerModel = deps.saveWorkerModel || noop;
  // Merging into the base branch pushes it: main asks Mati natively. No
  // dialog available = no merge. {release: true} - the same dialog also
  // names the release cut after the merge ("Create a new release after finish").
  const confirmMerge = (extra = {}) =>
    deps.confirmMerge
      ? Promise.resolve(deps.confirmMerge(plan.baseBranch, { release: extra.release === true })).then((yes) => yes === true, () => false)
      : Promise.resolve(false);
  const saveState = deps.saveState || noop;
  const onChange = deps.onChange || noop;
  const onLive = deps.onLive || noop;
  const onRunEvent = deps.onRunEvent || noop;
  const setTimer = deps.setTimer || setTimeout;
  const clearTimer = deps.clearTimer || clearTimeout;
  const log = deps.log || noop;
  // Bounded concurrency semaphore for post-DONE verification suites across parallel
  // worktrees (default 1 heavy test suite at a time). Production wiring shares one
  // process-wide semaphore across projects and end-of-run self-checks.
  const verifySemaphore = deps.verifySemaphore || createVerifySemaphore({ maxConcurrency: deps.verifyConcurrency });
  // Package worktree dependencies (orchestraDeps.js): install after
  // addWorktree, check before a worker starts and before the post-DONE verify.
  const rawInstallDeps = deps.installDeps || (async () => ({ ok: true, output: '' }));
  const rawCheckDeps = deps.checkDeps || (() => ({ ok: true, needed: false }));
  // A plan run runs no code and no verify: no package worktree needs node_modules.
  const installDeps = (root, opts) => (plan && plan.planRun ? Promise.resolve({ ok: true, output: '' }) : rawInstallDeps(root, opts));
  const checkDeps = (root) => (plan && plan.planRun ? { ok: true, needed: false } : rawCheckDeps(root));

  /** @type {null|object} */
  let plan = null;
  let busy = false;
  // The repo a makePlan in flight plans for (no plan exists yet), so a second
  // project cannot plan the same repo meanwhile.
  let planningRepo = null;
  let pumping = false;
  // A settled package's worktree editors are closed (src/orchestraEditorSlots.js);
  // a package held for an editor slot may launch once that is done.
  const editorReaper = editorSlots.createEditorReaper({
    isSettled: (p) => sup.SETTLED_STATES.has(p.state),
    onClosed: () => {
      if (plan && plan.started && !plan.killed && !pumping) kick();
    },
    log,
  });
  /** pkgId -> pending nudge timer (also the bounded wait on a background process) */
  const nudgeTimers = new Map();
  /** sessionId -> background processes the worker started that have not reported back */
  const backgroundOpen = new Map();
  /** sessionId -> when the worker last showed activity (its git status changed) */
  const lastActivity = new Map();
  /** pkgId -> scheduled automatic relaunch after a machinery failure */
  const retryTimers = new Map();
  /** pkgIds whose auto-split planner call is in flight (Q8): the run stays open */
  const splitting = new Set();
  /** pkgId -> automatic retries spent on a git that did not answer (orchestraLaunchRetry.js) */
  const transientRetries = new Map();
  // Launches wait a little right after a system resume.
  const resumeGate = createResumeGate({ now });
  /** pause key ('all' | 'claude' | 'agy' | 'free') -> its resume timer (orchestraPauses.js) */
  const resumeTimers = new Map();
  // A 'noNodeModules' hold checks its folders again every minute and resumes
  // on its own once they pass (orchestraHoldWatch.js).
  const holdWatch = createHoldWatch({
    isHeld: () => !!(plan && plan.hold && plan.hold.reason === 'noNodeModules' && !plan.killed),
    dirs: () => heldDirs(),
    check: (dir) => checkDeps(dir),
    // orchestraDeps.installInFlight: no resume while an install fills the folder.
    busy: (dir) => !!(deps.depsBusy && deps.depsBusy(dir)),
    resume: () => (plan ? resumeRun({ planId: plan.id }) : { ok: false, error: 'noPlan' }),
    onStill: (res) => {
      if (!plan || !plan.hold || !res.dir) return;
      const next = { ...plan.hold, ...holdFields(res) };
      if (next.dir === plan.hold.dir && next.detail === plan.hold.detail && next.cause === plan.hold.cause) return;
      plan.hold = next;
      commit();
    },
    intervalMs: deps.holdRecheckMs,
    setTimer: (fn, ms) => setTimer(fn, ms),
    clearTimer: (t) => clearTimer(t),
    log,
  });
  // The last "model X answered by Y" a free run logged (onFreeRoute).
  let lastFreeRoute = null;
  let scheduleTimer = null;
  // Planning that hit the 5 h / weekly limit waits for the reset and then
  // plans on its own (orchestraPlanWait.js).
  const planWaiter = createPlanWaiter({
    setTimer,
    clearTimer,
    now,
    onChange: deps.onPlanWait || noop,
    replan: (ctx) => (ctx && ctx.planRunRequest ? makePlanRun(ctx) : makePlan(ctx)),
  });

  // The end-of-run self-check's one fix-up worker (orchestraFixup.js): a
  // tab, never a package.
  const fixup = createFixupRunner({
    getPlan: () => plan,
    createSession: (opts) => deps.createSession(opts),
    writeBrief: (file, text) => deps.writeBrief(file, text),
    removeBrief: (file) => (typeof deps.removeBrief === 'function' ? deps.removeBrief(file) : false),
    closeSession: (id) => closeSession(id),
    sessionAlive: (id) => sessionAlive(id),
    profileId: () => {
      if (!plan) return null;
      if (!plan.planRun && agyRules.runUsesAgy(plan)) return plan.agyProfileId || (deps.agyProfileId ? deps.agyProfileId() : null);
      return plan.profileId;
    },
    strictProfile: () => !!plan && !plan.planRun && (agyRules.runUsesAgy(plan) || plan.freeMode === true),
    strictBackend: () => {
      if (!plan || plan.planRun) return null;
      if (agyRules.runUsesAgy(plan)) return 'agy';
      if (plan.freeMode === true) return 'free';
      return null;
    },
    // The run's (frozen) worker model and permission mode; 'plan' has no single model -> CLI default.
    model: () => {
      if (plan && !plan.planRun && agyRules.runUsesAgy(plan)) return agyRules.packageRunsAgy(plan, {}) ? taskModelFor({}) : agyRules.AGY;
      const m = (plan && plan.workerModel) || workerSettings().model;
      return m && m !== 'plan' ? m : null;
    },
    // A forced Settings level, else the routine default.
    effort: () => normalizeEffort(plan && plan.workerEffort) || DEFAULT_EFFORT,
    permissionMode: () => (plan && plan.permissionMode) || workerSettings().permissionMode || null,
    setTimer: (fn, ms) => setTimer(fn, ms),
    clearTimer: (t) => clearTimer(t),
    revokeFollowups: deps.revokeFollowups,
  });

  // The merge's own deps (orchestraMergeRun.js): task text, the same fix-up
  // worker for a package red after its merge, the stop check, the count.
  const mergeRun = createMergeRunDeps({
    getPlan: () => plan,
    integrateMerge: deps.integrateMerge,
    runSelfCheck: deps.runSelfCheck,
    runFixup: (args) => fixup.run(args),
  });

  const finalizer = createFinalizer({
    getPlan: () => plan,
    patch: (id, fields) => patch(id, fields),
    commit: () => commit(),
    view: () => view(),
    onRunEvent: (...args) => onRunEvent(...args),
    now,
    createPr: deps.createPr ? (args) => deps.createPr({ ...args, repoPath: plan.repoPath }) : null,
    integrateMerge: deps.integrateMerge ? mergeRun.integrateMerge : null,
    runSelfCheck: mergeRun.runSelfCheck,
    pushBranch: deps.pushBranch,
    runFixup: (args) => fixup.run(args),
    checkCommand: () => workerSettings().checkCommand,
    // A Luna's Work Unity build (lunasworkBuild.js workerSettings): its self-check rule.
    unityBuild: () => workerSettings().unityBuild || null,
    currentBaseBranch: deps.baseBranchOf ? () => deps.baseBranchOf(plan.repoPath) : null,
    removeWorktree: deps.removeWorktree,
    closeSession,
    sessionAlive,
    updateTodos: deps.updateTodos,
    writeReport: deps.writeReport,
    notify: deps.notify,
    putSnapshot: deps.putSnapshot,
    onReport: deps.onReport,
    onHandbackScan: deps.onHandbackScan,
    // One memory-log line per package with brief memories (src/orchestraBriefMemory.js).
    logBriefOutcome: deps.logBriefOutcome || null,
    sleep: deps.sleep,
    onIdle: () => afterFinalize(),
    // The integrate watchdog (default: orchestraFinalize integrateTimeoutFor)
    // and the per-pass process scope whose children it kills (src/procTree.js).
    integrateTimeoutMs: deps.integrateTimeoutMs,
    createScope: deps.createProcessScope || null,
    drainMs: deps.integrateDrainMs,
    // An aborted pass's fix-up tab goes too: it edits the integration worktree.
    onAbort: () => fixup.abort(),
    // After a merge landed: the post-merge step implementations
    // (orchestraFinalize.js POST_MERGE_STEPS, built by orchestraPostMerge.js).
    postMerge: deps.postMerge || null,
  });
  // The process-wide battery guard (orchestraPower.js createBatteryGuard):
  // low on battery, no new worker or verify starts until the PC is plugged in.
  const battery = deps.battery || null;
  const batteryHeld = () => !!(battery && battery.isHeld());
  // PC sleeps are not worker time (orchestraSleep.js). deps.tickMs = the
  // watchdog interval; it turns on the missed-'suspend' gap check.
  const sleepWatch = createSleepWatch({ now, tickMs: deps.tickMs });
  // The recovery playbook (orchestraRecover.js): a known environment stall
  // gets its automatic fix; Mati is asked once when that did not help.
  const recover = createRecoverer({
    getPkg: (id) => findPkg(id),
    findByRoot: (dir) => (plan ? plan.packages.find((p) => p.root && path.resolve(p.root) === path.resolve(dir)) : null) || null,
    record: (id, entry) => {
      const p = findPkg(id);
      if (!p) return;
      patch(id, { stallHistory: sup.withHistoryEntry(p.stallHistory, entry) });
      commit();
    },
    recordRun: (entry) => {
      if (!plan) return;
      plan.recoveries = sup.withHistoryEntry(plan.recoveries, entry);
      commit();
    },
    repoPath: () => (plan ? plan.repoPath : null),
    installDeps: (root, opts) => installDeps(root, opts),
    checkDeps: (root) => checkDeps(root),
    refinish: (id, extra) => refinish(id, extra),
    fixupRound: (id, res) => (res.stage === 'secrets' ? onSecretsFound(id, res) : onPushBlocked(id, res)),
    renameBranch: deps.renameBranch,
    setBranch: (id, branch) => patch(id, { branch }),
    ghAuthOk: deps.ghAuthOk,
    stall: (id, reason, detail, extra) => {
      if (!plan || !findPkg(id)) return;
      if (extra) patch(id, extra);
      stall(id, reason, detail);
    },
    resumeHeld: () => resumeHeldRun(),
    // The automatic install did not fix the hold: the usual message (no second toast).
    holdUnfixed: (res, asked) => onRunEvent('noNodeModules', { ...holdFields(res), asked }),
    refinishRun: () => {
      if (!plan) return;
      // The retried pass may still sleep / shut the PC down when done.
      if (plan.settled) settledFinalize = true;
      background(finishRun({ planId: plan.id }).then((r) => r.ok || log(`[recover] finish run refused: ${r.error}`)), 'finishRun');
    },
    // Account failover already ran in main (claudefailover.js failoverTab)
    // before a limit reaches the run, so the playbook goes straight to the pause.
    notify: (ask) => {
      onRunEvent('recoverAsk', { id: ask.pkgId, cause: ask.cause });
      if (deps.notifyRecover) deps.notifyRecover(ask);
    },
    now,
    setTimer: (fn, ms) => setTimer(fn, ms),
    clearTimer: (t) => clearTimer(t),
    log,
  });

  // The run's token usage (orchestraUsage.js): the planner's and the
  // reviewer's `claude -p` envelopes and the worker tabs' transcript totals.
  const usageBook = createUsageBook();
  /** deps.runReview, with the review's reported tokens booked; the result is untouched. */
  const meteredReview = deps.runReview
    ? async (args) => {
        // An agy run's reviews (hybrid gate, free review, A/B critic) run on
        // agy too (orchestraAgy.js runUsesAgy) - never silently on Claude.
        const agyRun = agyRules.runUsesAgy(plan);
        const agyEnv = agyRun && deps.agyEnv ? deps.agyEnv() : null;
        if (agyRun && !agyEnv) return { ok: false, error: 'noAgyProfile' };
        const res = await deps.runReview(agyRun ? { ...args, cli: 'agy', env: agyEnv } : args);
        if (res && res.ok && res.usage) usageBook.add('review', res.usage);
        return res;
      }
    : null;

  // Hybrid runs (orchestraHybrid.js): free packages on the coding profile,
  // the Claude review gate, hand-overs to Sonnet, per-package free waits.
  const hybridRun = hybridRules.createHybridRun({
    getPlan: () => plan,
    findPkg: (id) => findPkg(id),
    patch: (id, fields) => patch(id, fields),
    commit: () => commit(),
    kick: () => kick(),
    now,
    setTimer: (fn, ms) => setTimer(fn, ms),
    clearTimer: (t) => clearTimer(t),
    onRunEvent: (...args) => onRunEvent(...args),
    log,
    stallReasons: sup.ESCALATE_REASONS,
    resumeText: sup.RESUME_TEXT,
    cancelNudge: (id) => cancelNudge(id),
    writePty: (sessionId, text, opts) => writePty(sessionId, text, opts),
    // A hand-over brief is a resume brief: same project memory as the first start.
    briefText: (pkg, branch, opts = {}) => runBrief(pkg, branch, opts.resume ? { ...opts, memory: projectMemoryFor(pkg) } : opts),
    reopen: (pkg, text) => reopenInWorktree(pkg, text),
    landPushed: (id) => landPushed(id),
    stall: (id, reason, detail) => stall(id, reason, detail),
    runReview: meteredReview,
    reviewDiff: deps.reviewDiff || null,
    reviewEnv: () => (deps.freshEnv ? deps.freshEnv() : null),
    usageLimits: () => (deps.usageLimits ? deps.usageLimits() : []),
    // A pool run hands over to Sonnet when ticked, else up the pool (src/orchestraRescue.js).
    handOverTarget: (pkg, kind) => rescue.handOver(pkg, kind),
  });
  // F5: Claude review of a settled free run's luna-free/ branches, opt-in.
  const freeReviewer = createFreeReviewer({
    getPlan: () => plan,
    setState: (state) => {
      if (!plan) return;
      plan.freeReview = state;
      commit();
    },
    runReview: meteredReview,
    reviewDiff: deps.reviewDiff || null,
    reviewEnv: () => (deps.freshEnv ? deps.freshEnv() : null),
    usageLimits: () => (deps.usageLimits ? deps.usageLimits() : []),
    readTodos: (projectId) => deps.readTodos(projectId),
    writeDoc: deps.writeReviewDoc || null,
    now,
    setTimer: (fn, ms) => setTimer(fn, ms),
    clearTimer: (t) => clearTimer(t),
    onRunEvent: (...args) => onRunEvent(...args),
    log,
  });

  // The three opt-in evolutions, each on only when its plan option is.
  const planOption = (key) => !!plan && sup.normalizeOptions(plan.options)[key] === true;
  const allPaused = () => !!plan && !!pauseRules.pausesOf(plan)[pauseRules.ALL];
  const runLive = (id) => !!plan && !plan.killed && (!id ? !allPaused() : !isPackagePaused(findPkg(id)));
  /** One more entry on a package's history (report evidence); the caller commits. */
  const recordEntry = (id, entry) => {
    const p = findPkg(id);
    if (p) patch(id, { stallHistory: sup.withHistoryEntry(p.stallHistory, entry) });
  };
  // Self-heal (orchestraHeal.js): a known environment stall gets one fix, then one resume.
  const healer = createHealer({
    enabled: () => planOption('selfHeal'),
    live: runLive,
    getPkg: (id) => findPkg(id),
    patch: (id, fields) => patch(id, fields),
    record: recordEntry,
    commit: () => commit(),
    // The worktree's own install (orchestraDeps.js), never a link to another checkout.
    // Warm the live agy model list before resuming a matching agy:<id> package after deps heal.
    installDeps: async (root) => {
      const res = await installDeps(root, { fresh: true });
      const matching = res && res.ok && plan ? plan.packages.filter((p) => p.root === root) : [];
      if (matching.length) await agyModelsReady(matching);
      return res;
    },
    resume: (id, section) => healResume(id, section),
    giveUp: (id, reason, detail) => afterStall(id, reason, detail),
    onEvent: (kind, data) => onRunEvent(kind, data),
    now,
    setTimer: (fn, ms) => setTimer(fn, ms),
    clearTimer: (t) => clearTimer(t),
    log,
  });
  // Predictive context routing (orchestraContextGuard.js): /compact before the context fills.
  const contextGuard = createContextGuard({
    enabled: () => planOption('contextGuard'),
    live: runLive,
    pkgBySession: (sessionId) => bySession(sessionId),
    // Keys only where no permission prompt can be open: Enter would answer one blindly.
    canType: () => !!plan && plan.permissionMode === 'bypassPermissions',
    writePty: (sessionId, text) => writePty(sessionId, text),
    patch: (id, fields) => patch(id, fields),
    record: recordEntry,
    commit: () => commit(),
    onEvent: (kind, data) => onRunEvent(kind, data),
    now,
    log,
  });
  // A/B builds (orchestraVariantRun.js): parked variants, the critic, the winner's adoption.
  const variantRun = createVariantRunner({
    getPlan: () => plan,
    findPkg: (id) => findPkg(id),
    patch: (id, fields) => patch(id, fields),
    record: recordEntry,
    commit: () => commit(),
    removePackages: (ids) => {
      plan.packages = plan.packages.filter((p) => !ids.includes(p.id));
    },
    finishGroup: (id) => background(finish(id), 'finish'),
    stallGroup: (id, reason, detail) => stallGroup(id, reason, detail),
    runReview: meteredReview,
    reviewDiff: deps.reviewDiff || null,
    reviewEnv: () => (deps.freshEnv ? deps.freshEnv() : null),
    repoPath: () => plan.repoPath,
    closeSession: (id) => closeSession(id),
    sessionAlive: (id) => sessionAlive(id),
    removeWorktree: deps.removeWorktree || null,
    setTimer: (fn, ms) => setTimer(fn, ms),
    now,
    onEvent: (kind, data) => onRunEvent(kind, data),
    log,
  });

  // Sleep at the usage limit / shut down when done (orchestraPower.js): the
  // registry's shared flow, or this run's own.
  const approvalsPending = () =>
    plan.packages.some((p) => p.state === 'stalled' && p.error === 'needsApproval' && p.sessionId && sessionAlive(p.sessionId));
  const powerFlow = deps.powerFlow || createPowerFlow({
    power: deps.power || createPowerCtl({ platform: 'unsupported' }),
    getRun: () =>
      plan
        ? {
            planId: plan.id,
            pausedUntil: effectivePausedUntil(),
            killed: plan.killed,
            approvalsPending: approvalsPending(),
            options: sup.normalizeOptions(plan.options),
          }
        : null,
    awake: deps.awake,
    flush: deps.flush,
    notify: deps.notifyPower,
    appendReport: deps.appendReport,
    onChange: () => onChange(view()),
    graceMs: RESUME_GRACE_MS,
    now,
    setTimer,
    clearTimer,
    log,
  });
  // A run a PC shutdown cut (or "Pause for shutdown"): banner, countdown and
  // resume (orchestraResume.js). The deps below are this controller's own steps.
  const shutdownResume = resumeRules.createShutdownResume({
    getPlan: () => plan,
    patch: (id, fields) => patch(id, fields),
    commit: () => commit(),
    pump: () => pump(),
    now,
    setTimer: (fn, ms) => setTimer(fn, ms),
    clearTimer: (t) => clearTimer(t),
    isBusy: () => isBusy(),
    finalizing: () => finalizer.isRunning(),
    batteryHeld: () => batteryHeld(),
    // Luna's Work resumes its own build after a restart: no second driver.
    autoBlocked: () => !!(deps.autoResumeBlocked && deps.autoResumeBlocked()),
    sessionAlive: (id) => sessionAlive(id),
    transcriptExists: (cwd, id) => !!(deps.transcriptExists && deps.transcriptExists(cwd, id)),
    nudgeLive: (pkg, text) => {
      patch(pkg.id, { ...freshRun(), state: 'launched' });
      return writePty(pkg.sessionId, text, { paste: true }) ? { ok: true } : { ok: false, error: 'noTab' };
    },
    // Held for node_modules: the hold's Resume reopens it (as Retry does).
    reopenChat: (pkg, text) => heldOnDeps(pkg, reopenChat(pkg, text)),
    reopenFresh: (pkg) => heldOnDeps(pkg, reopenInWorktree(pkg, runBrief(pkg, pkg.branch, { resume: true }))),
    requeue: (pkg) => patch(pkg.id, { state: 'pending', error: null, detail: null }),
    beforeResume: () => {
      freezeSettings();
      if (!plan) return undefined;
      const needsAgy = plan.packages.some((p) => agyRules.packageRunsAgy(plan, p) && agyRules.packageAgyModel(plan, p) !== agyRules.AGY);
      return needsAgy ? agyModelsReady(plan.packages) : undefined;
    },
    stopForPause: () => stopForPause(),
    escWorker: (sessionId) => writePty(sessionId, ESC),
    afterPause: () => {
      if (deps.flush) deps.flush();
      background(powerFlow.refresh(), 'sleep');
    },
    onRunEvent: (...args) => onRunEvent(...args),
    graceMs: RESUME_GRACE_MS,
    log,
  });
  const isBusy = () => busy || pumping || finalizer.isRunning() || shutdownResume.isResuming();

  /** Ready packages whose kind, or worktree editor slot, was full at the last look (the tick retries them). */
  let kindHeld = false;

  function launchableReady() {
    kindHeld = false;
    if (!plan || allPaused()) return [];
    const max = maxParallelFor(plan, MAX_PARALLEL);
    // Mask paused pending packages so they do not fill slots ahead of unpaused backends,
    // while active paused packages keep their parallel slots.
    const masked = pauseRules.hasPauses(pauseRules.pausesOf(plan))
      ? plan.packages.map((p) => (p.state === 'pending' && isPackagePaused(p) ? { ...p, state: 'paused_skip' } : p))
      : plan.packages;
    const readyOf = (pkgs) => kindCappedReady(pkgs, max);
    // Only a Luna's Work Unity build caps its own worktree editors (src/orchestraEditorSlots.js).
    const editors = editorPolicy();
    if (!editors) return readyOf(masked);
    const capped = editorSlots.capEditorLaunches(masked, { readyOf, isActive: sup.isActive, needs: editors.needs, max: editors.max, closing: editorReaper.closing() });
    if (capped.held.length) kindHeld = true;
    return capped.ready;
  }

  /** The ready list under the global cap, and per kind in a pool run (sets kindHeld). */
  function kindCappedReady(pkgs, max) {
    // Every run but a pool run launches exactly as before: the global cap only.
    if (!kindCapRules.usesKindCaps(plan)) return sup.readyToLaunch(pkgs, max);
    const capped = kindCapRules.capReady(pkgs, {
      readyOf: (list) => sup.readyToLaunch(list, max),
      isActive: sup.isActive,
      kindOf: packageKind,
      caps: kindCapRules.kindCaps(workerSettings()),
      elsewhere: { agy: agyWorkersElsewhere() },
    });
    if (capped.held.length) kindHeld = true;
    return capped.ready;
  }

  /** A Luna's Work Unity build's worktree editor policy {max, needs, close} (deps.worktreeEditors), or null. */
  function editorPolicy() {
    if (typeof deps.worktreeEditors !== 'function') return null;
    let policy = null;
    try {
      policy = editorSlots.editorPolicyOf(deps.worktreeEditors());
    } catch (err) {
      log(`[orchestra] worktree editor policy not read: ${err instanceof Error ? err.message : String(err)}`);
    }
    return policy ? { ...policy, needs: editorSlots.safeNeeds(policy.needs, log) } : null;
  }

  /** Closes the worktree editors of editor packages that settled (commit runs after every transition). */
  function sweepWorktreeEditors() {
    const editors = plan ? editorPolicy() : null;
    if (editors) editorReaper.sweep(plan.packages, plan.repoPath, editors, editors.needs);
  }

  /** The kind of worker a package runs on: 'agy', 'free' (a hybrid free package) or 'claude'. */
  function packageKind(pkg) {
    if (agyRules.packageRunsAgy(plan, pkg)) return kindCapRules.KIND_AGY;
    return isHybridFreePackage(pkg) ? kindCapRules.KIND_FREE : kindCapRules.KIND_CLAUDE;
  }

  /** agy workers running in the other God Mode runs (multi God Mode); 0 when unknown. */
  function agyWorkersElsewhere() {
    if (typeof deps.agyWorkersElsewhere !== 'function') return 0;
    try {
      const n = deps.agyWorkersElsewhere();
      return Number.isInteger(n) && n > 0 ? n : 0;
    } catch (err) {
      log(`[orchestra] counting other runs' agy workers failed: ${err instanceof Error ? err.message : String(err)}`);
      return 0;
    }
  }

  /** agy workers this run has going now (any run kind): the other runs' agy cap counts them. */
  function activeAgyWorkers() {
    if (!plan || plan.killed) return 0;
    return plan.packages.filter((p) => sup.isActive(p) && agyRules.packageRunsAgy(plan, p)).length;
  }

  /**
   * The power flow's pause: the whole-run pause, or - when no unpaused
   * worker runs or could launch - the earliest backend reset (plan.pausedUntil).
   */
  function effectivePausedUntil() {
    const pauses = plan ? pauseRules.pausesOf(plan) : {};
    if (!pauseRules.hasPauses(pauses)) return null;
    if (pauses[pauseRules.ALL]) return plan.pausedUntil;
    const unpausedRunning = plan.packages.some((p) => sup.isActive(p) && !isPackagePaused(p));
    return unpausedRunning || launchableReady().length > 0 ? null : plan.pausedUntil;
  }
  // Set when a run settles on its own; only such a run may shut the PC down.
  let settledFinalize = false;
  // Luna's Work hook: makePlan's optional ctx.onRunSettled, bound to the plan
  // it made and fired once when that run's finalize goes idle. Not saved:
  // after a restart Luna's Work resumes on its own.
  /** @type {null|{planId:string, fn:Function}} */
  let runSettledHook = null;
  // LW 2.12: `${pkgId}|${file}` already sent an ownership stop, so a worker
  // is told once per file. Not saved: a restarted run is held anyway.
  const ownershipNudged = new Set();
  const background = (promise, where) =>
    promise.catch((err) => onRunEvent('error', { where, message: err instanceof Error ? err.message : String(err) }));
  // A battery change repaints the board; plugged in, what waited launches.
  if (battery) {
    battery.subscribe(() => {
      if (!plan) return;
      onChange(view());
      if (!batteryHeld()) {
        kick();
        shutdownResume.poke();
      }
    });
  }

  /**
   * Brings back the run saved by the previous LunaCore. Not in the
   * constructor: main builds this before app.whenReady(), when the user
   * config folder is not dependable yet. The restored run is held (not
   * started) - nothing launches at boot until Mati presses Approve or Retry.
   */
  function restore() {
    const raw = deps.loadState ? deps.loadState() : null;
    const normalized = deps.loadState ? sup.normalizeStoredPlan(raw) : null;
    // Folders saved on another PC / under another user name re-homed here.
    const stored = normalized && deps.resolvePath ? sup.rehomePlanPaths(normalized, deps.resolvePath, deps.resolveFile) : normalized;
    if (!stored || plan) return false;
    plan = { ...sup.restoreAfterRestart(stored, now()), started: false, killed: false, pauses: {}, pausedUntil: null, pauseStartedAt: null, settled: false };
    // Restart recovery: no session of this run keeps an intake token (matched by run id, never by session id).
    if (deps.revokeRunFollowups) revokeQuietly(() => deps.revokeRunFollowups(plan.id));
    // Tokens are not stored with the run: the book starts empty and counts what runs from here on.
    usageBook.begin(plan.id);
    // A held run is held anyway after a restart; Approve / Retry check again.
    releaseHold();
    // A schedule Mati armed survives a restart; one already missed does not
    // start the run late - the run stays held.
    if (plan.scheduledAt && plan.scheduledAt > now()) armSchedule(plan.scheduledAt);
    else plan.scheduledAt = null;
    // A started run the shutdown cut: the banner's countdown resumes it.
    shutdownResume.onRestore(resumeRules.interruptedOnRestore(raw, now()));
    commit();
    // Branches older builds left behind for this plan's packages.
    sweepBranches().catch(noop);
    return true;
  }

  /**
   * Deletes this plan's orphaned `luna/<pkgId>-<stamp>` branches (no
   * worktree, not recorded on a package, no own commits) and logs them.
   * @returns {Promise<{ok:boolean, deleted:string[], kept:Array<{branch:string, error:string}>, error?:string}>}
   */
  async function sweepBranches() {
    if (!plan || !deps.deleteBranch || !deps.listOwnBranches || !deps.worktreeBranches) {
      return { ok: false, deleted: [], kept: [], error: 'unavailable' };
    }
    const res = await sweepOrphanBranches({
      repoPath: plan.repoPath,
      packages: plan.packages,
      git: { listOwnBranches: deps.listOwnBranches, worktreeBranches: deps.worktreeBranches, deleteBranch: deps.deleteBranch },
    });
    if (res.deleted.length) log(`deleted orphan branches: ${res.deleted.join(', ')}`);
    if (!res.ok) log(`branch sweep failed: ${res.error}`);
    return res;
  }

  /**
   * effectivePausedUntil() for view(), which runs on every commit: its
   * launchableReady() look rewrites kindHeld, the flag the tick reads to
   * retry kind-capped packages - a view must not change that.
   */
  function waitingUntilForView() {
    const held = kindHeld;
    try {
      return effectivePausedUntil();
    } finally {
      kindHeld = held;
    }
  }

  function view() {
    if (!plan) return null;
    return {
      id: plan.id,
      projectId: plan.projectId,
      notes: plan.notes,
      warnings: plan.warnings,
      errors: plan.errors,
      estimate: plan.estimate,
      costUsd: plan.costUsd,
      // Tokens the run's Claude calls reported so far ({total, bySource}), or
      // null. Read by Luna's Work only; kept in memory, not with the stored run.
      usage: usageBook.snapshot(plan.id),
      // null on a plan stored before the picker had the select.
      plannerEffort: plan.plannerEffort || null,
      dirty: plan.dirty,
      // The planner's model: the picker's choice, opus on every plan without one.
      model: plannerModelOf(plan.plannerModel),
      // A pool plan reads 'plan' before Approve, so a phone that sends the view's
      // model back keeps the pool (approvePool) instead of one Settings model.
      workerModel: plan.workerModel || (Array.isArray(plan.modelPool) ? 'plan' : workerSettings().model),
      // The "Workers" pool of a pool run ([{model, effort}]); no key on any other plan.
      ...(Array.isArray(plan.modelPool) ? { modelPool: plan.modelPool.map((e) => ({ ...e })) } : {}),
      workerEffort: plan.workerEffort || workerSettings().effort || 'plan',
      permissionMode: plan.permissionMode || workerSettings().permissionMode,
      integrationMode: plan.integrationMode || workerSettings().integration,
      baseBranch: plan.baseBranch,
      started: plan.started,
      killed: plan.killed,
      settled: plan.settled,
      pausedUntil: plan.pausedUntil,
      // The whole run waits for a usage reset (no unpaused worker runs or could
      // launch), else null. Luna's Work reads it to report its build as limited.
      waitingUntil: waitingUntilForView(),
      // Cut by a PC shutdown or "Pause for shutdown": the board's resume banner.
      interrupted: shutdownResume.view(),
      // A machine problem holding the whole run ('noNodeModules'); Resume clears it.
      hold: plan.hold
        ? {
          reason: plan.hold.reason,
          dir: plan.hold.dir,
          detail: plan.hold.detail || null,
          // Why node_modules fails ('missing' | 'empty' | 'unresolved') and the missing package.
          cause: plan.hold.cause || null,
          missing: plan.hold.missing || null,
          at: plan.hold.at,
        }
        : null,
      scheduledAt: plan.scheduledAt,
      // The morning report's Timeline (orchestraReport.js).
      runStartedAt: plan.runStartedAt || null,
      pausedTotalMs: plan.pausedTotalMs || 0,
      // Each PC sleep during the run: [{start, durationMs}] (orchestraSleep.js).
      sleeps: Array.isArray(plan.sleeps) ? plan.sleeps.map((s) => ({ ...s })) : [],
      // Run-level automatic fixes (integration retries, orchestraRecover.js).
      recoveries: Array.isArray(plan.recoveries) ? plan.recoveries.map((e) => ({ ...e })) : [],
      // The run option "Sessions may file new to-dos" and the cards they filed (the report's section).
      followups: plan.followups === true,
      followupsFiled: normalizeFollowupEntries(plan.followupsFiled, plan.id),
      freeMode: plan.freeMode === true,
      // D1 / agy: who planned this build run ('claude' for every older plan).
      buildPlanner: plan.buildPlanner === 'free' || plan.buildPlanner === 'agy' ? plan.buildPlanner : 'claude',
      // F6 "Workers": claude / hybrid / free (older plans migrate from the tick).
      workers: workersRules.storedWorkers(plan),
      // F5: the opt-in review of a free run's branches (null = none ran).
      freeReview: plan.freeReview ? { ...plan.freeReview } : null,
      // Plan runs (orchestraPlanRunView.js): topics, progress, stalls, flagged tasks, docs.
      planRun: planView.planRunView(plan),
      options: sup.normalizeOptions(plan.options),
      integration: {
        ...plan.integration,
        running: finalizer.isRunning(),
        // From then on the board offers "Abort finish".
        abortAfter:
          finalizer.isRunning() && Number.isFinite((plan.integration || {}).startedAt)
            ? plan.integration.startedAt + ABORT_FINISH_AFTER_MS
            : null,
      },
      power: powerFlow.view(),
      battery: battery ? battery.view() : null,
      overlaps: sup.liveOverlaps(plan.packages),
      suggestions: sup.allowSuggestions(plan.approvalLog).filter((s) => !(plan.allowedTools || []).includes(s.rule)),
      tally: sup.tally(plan.packages),
      packages: plan.packages.map((p) => ({
        id: p.id,
        title: p.title,
        prompt: p.prompt,
        files: p.files,
        dependsOn: p.dependsOn,
        verify: p.verify,
        model: p.modelOverride || p.model,
        // The board's model badge tells an override from the planner's pick.
        modelOverride: p.modelOverride || null,
        // A pool run: the ticked model it runs on, the planner's reason, the pick it was moved from.
        ...(p.poolModel ? { poolModel: p.poolModel, modelReason: p.modelReason || '', poolFrom: p.poolFrom || null } : {}),
        // F6 guard: why a "free" package was upgraded to Sonnet (null = it was not).
        hybridGuard: p.hybridGuard || null,
        // Weak-model guard: why a package planned on the easiest agy tier moved up (none = it did not).
        ...(p.weakGuard ? { weakGuard: p.weakGuard } : {}),
        // The model + effort Mati picked on Approve (none = the planner's / pool's).
        ...(p.modelPick ? { modelPick: p.modelPick } : {}),
        // F6c/F6d: free worker, review, hand-overs, free wait (null outside hybrid runs).
        hybrid: hybridRun.view(p),
        effort: p.effortOverride || p.effort || null,
        todos: p.todoAts.map((at) => plan.todoText.get(at) || String(at)),
        state: p.state,
        sessionId: p.sessionId,
        // The agy model an Antigravity worker runs on (null otherwise or unknown).
        agyModel: agyModelShown(p),
        branch: p.branch,
        headSha: p.headSha,
        error: p.error,
        detail: p.detail,
        nudges: p.nudges,
        verifyRounds: p.verifyRounds,
        startedAt: p.startedAt,
        finishedAt: p.finishedAt || null,
        stalls: p.stalls,
        stallHistory: p.stallHistory || [],
        escalated: p.escalated,
        // A pool run's rescues (src/orchestraRescue.js): escalations, limit moves, hand-overs.
        ...(Array.isArray(p.rescues) && p.rescues.length
          ? { rescueKey: p.rescueKey || null, emergency: p.emergency === true, rescues: p.rescues.map((r) => ({ ...r, text: rescueRules.rescueText(r) })) }
          : {}),
        prUrl: p.prUrl,
        merged: p.merged,
        // Repo-relative paths the package changed (Luna's Work's bug-test rule).
        touched: p.touched || [],
        cleaned: p.cleaned,
        depMerge: p.depMerge || null,
        autoRetries: p.autoRetries || 0,
        autoResumed: p.autoResumed === true,
        terminal: p.terminal === true,
        blockedBy: p.blockedBy || null,
        failure: p.failure || null,
        lastWords: p.lastWords || null,
        ...(p.handback ? { handback: p.handback } : {}),
        verifyTail: p.verifyTail || null,
        awaitingDeps: p.awaitingDeps === true,
        verifyPhase: p.state === 'finishing' ? p.verifyPhase || null : null,
        scanFixup: p.scanFixup === true,
        pushFixup: p.pushFixup === true,
        // Q8 auto-split: being split now, made by a split, replaced by a split.
        splitting: p.splitting === true,
        splitOf: p.splitOf || null,
        splitInto: Array.isArray(p.splitInto) ? [...p.splitInto] : null,
        ...evolutionViews(p),
      })),
    };
  }

  /** A package's A/B, self-heal and context-guard views: keys only when there is something to show. */
  function evolutionViews(p) {
    const ab = variantRun.view(p);
    const heal = healer.view(p);
    const context = contextGuard.view(p);
    return { ...(ab ? { ab } : {}), ...(heal ? { heal } : {}), ...(context ? { context } : {}) };
  }

  /** Writes the run to disk and tells the renderer. Every transition ends here. */
  function commit() {
    // blockedBy follows terminal / state on every transition, never stale.
    if (plan) plan.packages = sup.withBlockedBy(plan.packages);
    // Each live worker's conversation id rides along, for a resume after a shutdown.
    if (plan && deps.transcriptIdOf) plan.packages = resumeRules.withTranscriptIds(plan.packages, deps.transcriptIdOf, log);
    // A settled package's tab loses its scoped intake token (orchestraFollowupsLaunch.js).
    if (plan && deps.revokeFollowups) revokeQuietly(() => deps.revokeFollowups(followupLaunch.settledSessions(plan, sup.SETTLED_STATES)));
    // A settled package's own Unity editor (a Luna's Work Unity build) is closed.
    sweepWorktreeEditors();
    saveState(plan ? sup.serializePlan(plan) : null);
    const v = view();
    onChange(v);
    // The phone's live run view (godmodelivepub.js throttles): the repo and
    // worktree roots ride along only so godmodesnapshot can cut paths out.
    try {
      onLive(
        v && {
          ...v,
          repoPath: plan.repoPath,
          roots: plan.packages.map((p) => p.root).filter(Boolean),
          packages: v.packages.map((p, i) => ({ ...p, pausedMs: plan.packages[i].pausedMs || 0 })),
        },
      );
    } catch (err) {
      log(`[orchestra] live snapshot failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** A token revocation never stops a transition; a failure is logged. */
  function revokeQuietly(fn) {
    try {
      fn();
    } catch (err) {
      log(`[orchestra] follow-up token not revoked: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** The cards this run's sessions filed (orchestraFollowups.js ledger), or null for another run. */
  function followupsFiled(runId) {
    if (!plan || plan.id !== runId) return null;
    return normalizeFollowupEntries(plan.followupsFiled, plan.id);
  }

  /** Stores the run's follow-up record with the run. @returns {boolean} */
  function noteFollowups(runId, entries) {
    if (!plan || plan.id !== runId) return false;
    plan.followupsFiled = normalizeFollowupEntries(entries, plan.id);
    commit();
    return true;
  }

  const findPkg = (id) => (plan ? plan.packages.find((p) => p.id === id) : null);
  const bySession = (sessionId) => (plan && sessionId ? plan.packages.find((p) => p.sessionId === sessionId) : null);

  /** When a state change lands: stamped on settling, cleared on a relaunch (report timeline). */
  const finishStamp = (p, fields) =>
    'state' in fields && fields.state !== p.state ? { finishedAt: sup.SETTLED_STATES.has(fields.state) ? now() : null } : {};

  function patch(id, fields) {
    plan.packages = plan.packages.map((p) => (p.id === id ? { ...p, ...fields, ...finishStamp(p, fields) } : p));
  }

  function cancelNudge(id) {
    const timer = nudgeTimers.get(id);
    if (timer) clearTimer(timer);
    nudgeTimers.delete(id);
  }

  function clearSchedule() {
    if (scheduleTimer) clearTimer(scheduleTimer);
    scheduleTimer = null;
  }

  function cancelAutoRetry(id) {
    const timer = retryTimers.get(id);
    if (timer) clearTimer(timer);
    retryTimers.delete(id);
  }

  function clearAllTimers() {
    for (const id of [...nudgeTimers.keys()]) cancelNudge(id);
    for (const id of [...retryTimers.keys()]) cancelAutoRetry(id);
    recover.cancel('run');
    hybridRun.cancelAll();
    freeReviewer.cancel();
    healer.cancelAll();
    variantRun.cancelAll();
    contextGuard.clear();
    backgroundOpen.clear();
    lastActivity.clear();
    clearResumeTimers();
    holdWatch.cancel();
    clearSchedule();
    shutdownResume.dispose();
  }

  /** Worker settings + integration mode, frozen when the run starts. */
  function freezeSettings() {
    const s = workerSettings();
    plan.workerModel = plan.workerModel || s.model;
    plan.workerEffort = plan.workerEffort || (isEffort(s.effort) ? s.effort : 'plan');
    plan.permissionMode = plan.permissionMode || s.permissionMode;
    plan.integrationMode = plan.integrationMode || s.integration || 'pr';
    if (!plan.allowedTools) plan.allowedTools = (s.allowedTools || []).filter(sup.isAllowRule);
    plan.emergencyEffort = rescueRules.normalizeEmergencyEffort(plan.emergencyEffort || s.emergencyEffort);
  }

  // A hybrid "free" package runs on Sonnet until free workers take them (F6);
  // a 'plan' package the planner gave no model runs on Opus (the board's badge says the same).
  const modelFor = (pkg) => workerModelRules.packageModelOf(pkg, plan.workerModel);

  /**
   * The Approve screen's / phone's worker model, before the run starts or is
   * scheduled only: it becomes the run's choice (frozen by freezeSettings)
   * and the saved pref. Anything not on the allow-list is ignored - the pref
   * decides, as before. A Free-only run has no Claude workers, so it saves
   * nothing either.
   */
  function applyWorkerModel(asked, workers) {
    const model = workerModelRules.normalizeWorkerModel(asked);
    // A plan run keeps its own worker pool (orchestraPlanRunStart.js).
    if (!model || plan.started || plan.scheduledAt || plan.planRun || workers === 'free') return;
    plan.workerModel = model;
    try {
      saveWorkerModel(model);
    } catch (err) {
      log(`[orchestra] worker model pref not saved: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  // "Workers" pools (src/orchestraPoolWiring.js): planned for, then routed per package.
  const poolRun = createPoolWiring({ planOf: () => plan, deps, log, workerSettings, now, guardRules: (repoPath) => protectedRules(repoPath) });
  // Pool rescue: escalation up the ticked models, limit moves, emergency Opus.
  const rescue = createRescueWiring({
    planOf: () => plan,
    deps,
    now,
    effortFor: (pkg) => effortFor(pkg),
    emergencySetting: () => (plan && plan.emergencyEffort) || workerSettings().emergencyEffort,
    freeWaiting: () => !!plan && plan.packages.some((p) => sup.isActive(p) && hybridRun.isWaiting(p)),
    isHybridFree: (pkg) => isHybridFreePackage(pkg),
    stallReasons: sup.ESCALATE_REASONS,
    escalateAfterStalls: sup.ESCALATE_AFTER_STALLS,
    patch: (id, fields) => patch(id, fields),
    onRunEvent: (...args) => onRunEvent(...args),
    log,
  });
  /**
   * Does this stall escalate? A pool run asks its rescue rules; any other run
   * keeps today's rule (a Sonnet worker, twice stalled, once to Opus).
   */
  const wantsEscalation = (pkg, reason) => {
    const pooled = rescue.wantsEscalation(pkg, reason);
    if (pooled !== null) return pooled;
    return packageRunsClaude(pkg) && sup.shouldEscalate(pkg, modelFor(pkg), reason);
  };

  /**
   * Escalation override, then the level a pool's Claude model fixes, then a
   * forced Settings level, then the planner's pick, then medium. An agy pool
   * entry only selects the variant (the model); claudePoolEffort is null for
   * it, so an agy tab gets the package's own effort as --effort.
   */
  const effortFor = (pkg) =>
    normalizeEffort(pkg.effortOverride) ||
    poolEffortRules.claudePoolEffort(plan.modelPool, pkg) ||
    normalizeEffort(plan.workerEffort) ||
    normalizeEffort(pkg.effort) ||
    DEFAULT_EFFORT;

  /**
   * Runs the planner for one project. Replaces any previous plan, except one
   * whose run still has a worker going.
   * Optional hooks exist for Luna's Work; God Mode never sets them and
   * is unchanged without them: `cards` (card `at`s or card objects, see
   * givenCards) replaces the open-card / todoAts selection,
   * `onRunSettled(result)` is called once when this plan's run settles, and
   * `ownership` (LW 2.12, `{path|glob: owner}` with owner = package id or
   * card `at`) stops a worker that edits a file another package owns.
   * @param {{projectId:string|null, repoPath:string, profileId:string, env:object,
   *   todoAts?:number[]|null, plannerEffort?:string, plannerModel?:string, cards?:Array<number|object>, onRunSettled?:Function,
   *   ownership?:object|object[]}} ctx
   */
  async function makePlan(ctx) {
    if (isBusy()) return { ok: false, error: 'busy' };
    if (plan && plan.packages.some(sup.isActive)) return { ok: false, error: 'runActive' };
    // One run per repo across projects - checked here, so a replan after a
    // limit wait is refused too when another project took the repo meanwhile.
    if (deps.repoBusy && deps.repoBusy(ctx.repoPath)) return { ok: false, error: 'repoBusy' };
    // A manual item is the user's own job: the planner never sees it.
    const allOpen = deps.readTodos(ctx.projectId).filter((t) => !t.done && t.manual !== true);
    if (!allOpen.length) return { ok: false, error: 'noTodos' };
    // The picker's selection rides in ctx, so a limit-wait replan keeps it.
    const openTodos = Array.isArray(ctx.cards) ? givenCards(allOpen, ctx.cards) : pickTodos(allOpen, ctx.todoAts);
    if (!openTodos.length) return { ok: false, error: 'noneSelected' };
    // A manual (re-)plan replaces a pending wait; the waiter's own replan
    // is in state 'planning' and keeps it.
    if (planWaiter.isWaiting()) planWaiter.clear();

    const plannerEffort = plannerEffortOf(ctx.plannerEffort);
    // The picker's planner model (allow-listed; anything else = opus).
    const plannerModel = plannerModelOf(ctx.plannerModel);
    // D1: "Planner: Claude / Free". Plan to-dos bring their PLAN.md (F4b).
    const planner = planBuild.plannerOf(ctx.planner);
    // The God Mode settings' opt-in switches, fixed for this plan.
    const settings = workerSettings();
    const planDocs = readPlanDocs(ctx.repoPath, openTodos);
    // Every planner call of this plan that reported tokens (a free sizing
    // round calls it twice); booked once the plan exists.
    const plannerUsage = [];
    busy = true;
    planningRepo = ctx.repoPath;
    try {
      // "Workers" pool (2+ ticked models, never for the free planner): read
      // after `busy`, since checking agy families against the live list may
      // wait on `agy models`. No pool asked = no await, the call as before.
      const pool = planner !== 'free' && ctx.modelPool ? await poolRun.livePlanPool(ctx.modelPool) : null;
      // The agy planner's model (Opus / Neon / Argon / Hydrogen on agy), resolved
      // against the live list; none picked = agy's own default, as before.
      const agyModel = planner === 'agy' && ctx.plannerAgyModel ? await poolRun.agyPlannerModelId(ctx.plannerAgyModel, plannerEffort) : null;
      // F6 "Workers": a free planner is always free-only; hybrid plans with
      // Claude; a pool with a free profile runs hybrid (src/workerPool.js).
      const asked = workersRules.planWorkers(ctx.workers, planner);
      const workers = pool ? poolWorkers(pool.pool, asked) : asked;
      const hybrid = workers === 'hybrid';
      // A/B builds need a Claude planner and Claude workers on one model; a
      // Luna's Work build (cards) never gets them.
      const abBuild = settings.abBuild === true && planner === 'claude' && workers === 'claude' && !pool && !Array.isArray(ctx.cards);
      // A pool run's fixed per-model efforts and each ticked model's usage now
      // (the meter's latest reading); none = the prompt as before.
      const poolEfforts = pool ? pool.efforts : null;
      const poolUsage = pool && deps.usageReading ? poolUsageReadings(pool.pool, deps.usageReading()) : null;
      const callPlanner = async (extraPrompt) => {
        // The picker's planner effort and model ride in ctx too, so a limit-wait
        // or account-failover replan plans at the same level on the same model.
        const res = await deps.runPlanner(
          plannerArgs({
            cwd: ctx.repoPath, env: ctx.env, openTodos, effort: plannerEffort, model: plannerModel, planner, planDocs, extraPrompt, hybrid, abBuild,
            pool: pool ? pool.keys : null, agyModel, poolEfforts, poolUsage,
          }),
        );
        if (res && res.ok && res.usage) plannerUsage.push(res.usage);
        return res;
      };
      const [res, dirty, baseBranch] = await Promise.all([
        callPlanner(null),
        deps.dirtyCount(ctx.repoPath),
        deps.baseBranchOf ? deps.baseBranchOf(ctx.repoPath) : null,
      ]);
      // Only the Claude planner waits for its window; a free or agy one just fails.
      if (!res.ok && planner !== 'claude') return res;
      if (!res.ok) {
        const limits = deps.usageLimits ? deps.usageLimits() : [];
        const decision = planWaitDecision({ res, limits, now: now() });
        if (decision.action !== 'wait') return res;
        // Another Claude account is free (src/claudeaccounts.js): plan again
        // in a moment on it - the env is rebuilt, the old one carries the
        // limited account's token.
        if (deps.accountFailover && deps.accountFailover(decision.resumeAt || null)) {
          const retryCtx = deps.freshEnv ? { ...ctx, env: deps.freshEnv() } : ctx;
          planWaiter.arm(retryCtx, { ...decision, resumeAt: now() + ACCOUNT_SWITCH_RETRY_MS, source: 'account' });
          return { ok: false, error: 'waiting', planWait: planWaiter.view() };
        }
        planWaiter.arm(ctx, decision);
        return { ok: false, error: 'waiting', planWait: planWaiter.view() };
      }
      const built = await plannedPackages({ res, openTodos, planner, callPlanner, repoPath: ctx.repoPath, hybrid, abBuild, pool });
      const { checked } = built;
      for (const w of checked.warnings) {
        if (w.code === 'outOfPool') log(`[orchestra] package ${w.id}: ${w.from || 'no model'} is not in the Workers pool, runs on ${w.to}`);
      }
      const ownership = sup.normalizeOwnership(ctx.ownership);
      clearAllTimers();
      ownershipNudged.clear();
      plan = {
        id: `p${now().toString(36)}`,
        projectId: ctx.projectId,
        repoPath: ctx.repoPath,
        profileId: ctx.profileId,
        notes: checked.notes,
        warnings: checked.warnings,
        errors: checked.errors,
        estimate: estimatePlan(checked.packages, openTodos),
        costUsd: built.costUsd,
        plannerEffort,
        // Only a plan made on another model than the default carries the key.
        ...(plannerModel !== PLANNER_MODEL && planner !== 'free' ? { plannerModel } : {}),
        // A free planner makes a free-only run (D1) that may auto-split (Q8).
        // An agy planner is kept too: the run's helper jobs then run on agy (orchestraAgy.js).
        ...(planner !== 'claude' ? { buildPlanner: planner } : {}),
        // F6 "Workers"; a Claude-only plan carries no key (as before the selector).
        ...(workers !== 'claude' ? { workers } : {}),
        // The "Workers" pool the plan was made for; only a pool run carries the key.
        ...(pool ? { modelPool: pool.pool } : {}),
        dirty,
        // Opt-in: sessions may file follow-up cards (orchestraFollowups.js); off unless asked for.
        followups: ctx.followups === true,
        workerModel: null,
        workerEffort: null,
        permissionMode: null,
        allowedTools: null,
        integrationMode: null,
        freeMode: false,
        baseBranch: sup.isBaseBranch(baseBranch) ? baseBranch : null,
        scheduledAt: null,
        approvalLog: [],
        options: sup.normalizeOptions({
          unattendedApprovalMin: workerSettings().unattendedApprovalMin,
          sleepOnLimit: false,
          shutdownWhenDone: false,
          abBuild,
          selfHeal: settings.selfHeal === true,
          contextGuard: settings.contextGuard === true,
        }),
        integration: { state: 'idle', error: null, detail: null, at: null },
        started: false,
        killed: false,
        settled: false,
        pauses: {},
        pausedUntil: null,
        pauseStartedAt: null,
        hold: null,
        runStartedAt: null,
        pausedTotalMs: 0,
        sleeps: [],
        todoText: new Map(openTodos.map((t) => [t.at, t.text])),
        // LW 2.12: only a plan made with an ownership map carries the key.
        ...(ownership ? { ownership } : {}),
        packages: checked.packages.map(runPackage),
      };
      runSettledHook = typeof ctx.onRunSettled === 'function' ? { planId: plan.id, fn: ctx.onRunSettled } : null;
      usageBook.begin(plan.id);
      for (const usage of plannerUsage) usageBook.add('planner', usage);
      commit();
      return { ok: true, plan: view() };
    } finally {
      busy = false;
      planningRepo = null;
    }
  }

  /** PLAN.md of every plan the to-dos came from (F4b), read in main. */
  function readPlanDocs(repoPath, todos) {
    if (!deps.readPlanDoc) return [];
    return planBuild
      .planSlugsOf(todos)
      .map((slug) => ({ slug, text: deps.readPlanDoc(repoPath, slug) }))
      .filter((d) => typeof d.text === 'string');
  }

  /** Strict sizing of packages against the repo; no fs helpers = accepted. */
  const sizeOf = (repoPath, packages) => (deps.sizePackages ? deps.sizePackages(repoPath, packages) : { ok: true, failing: [] });

  /**
   * The planner's answer -> validated packages. The free planner also gets
   * strict sizing with ONE resize round (flagged after that); every package
   * built from plan to-dos links the plan and its acceptance tests.
   */
  async function plannedPackages({ res, openTodos, planner, callPlanner, repoPath, hybrid = false, abBuild = false, pool = null }) {
    const opts = { ...(hybrid ? { hybrid: true } : {}), ...(abBuild ? { abBuild: true } : {}), ...(pool ? { pool: pool.keys } : {}) };
    const validate = (raw) => validatePlan(raw, openTodos, Object.keys(opts).length ? opts : undefined);
    let checked = validate(res.raw);
    let costUsd = res.costUsd;
    if (planner === 'free') {
      const round = await planBuild.freeSizingRound({ checked, costUsd, rerun: callPlanner, validate, size: (pkgs) => sizeOf(repoPath, pkgs) });
      checked = { ...round.checked, warnings: [...round.checked.warnings, ...round.warnings] };
      costUsd = round.costUsd;
    }
    const linked = planBuild.withPlanLinks(checked.packages, openTodos);
    // F6 guard: after the plan links, so a plan's acceptance tests count as verify.
    const guarded = hybrid ? hybridGuard.applyHybridGuard(linked, protectedRules(repoPath)) : linked;
    // A pool run: each package on the model its worker runs on (after the
    // guard, so a free package it upgraded stays on a ticked Claude model).
    // The weak-model guard runs there too (src/orchestraWeakGuard.js).
    const pooled = pool ? poolRun.applyPlanPool(guarded, pool, protectedRules(repoPath)) : null;
    const packages = pooled ? pooled.packages : guarded;
    if (pooled && pooled.warnings.length) checked = { ...checked, warnings: [...checked.warnings, ...pooled.warnings] };
    // A/B builds: a package with two variants becomes its group plus one package per variant.
    if (abBuild) {
      const expanded = variantRules.expandVariants(packages);
      return { checked: { ...checked, packages: expanded.packages, warnings: [...checked.warnings, ...expanded.warnings] }, costUsd };
    }
    return { checked: { ...checked, packages }, costUsd };
  }

  /** The repo's protected paths (config + repo extension); none wired = built-in defaults. */
  const protectedRules = (repoPath) => (deps.hybridProtected ? deps.hybridProtected(repoPath) : hybridGuard.DEFAULT_PROTECTED);

  /**
   * Q8: a free-planned package that stalled twice goes back to the free
   * planner to be split (orchestraAutoSplit.js). Async; the package stays
   * stalled (and the run open) until the answer is in. False = no free
   * planner env, the stall is handled as usual.
   */
  function startAutoSplit(pkg, reason, detail) {
    const env = deps.freePlannerEnv ? deps.freePlannerEnv() : null;
    if (!env || splitting.has(pkg.id) || !deps.runPlanner) return false;
    splitting.add(pkg.id);
    patch(pkg.id, { splitting: true });
    onRunEvent('autoSplit', { id: pkg.id, reason });
    const planId = plan.id;
    background(
      runAutoSplit(planId, pkg.id, { reason, detail, env }).finally(() => splitting.delete(pkg.id)),
      'autoSplit',
    );
    return true;
  }

  async function runAutoSplit(planId, id, { reason, detail, env }) {
    const live = () => plan && plan.id === planId && !plan.killed;
    const before = findPkg(id);
    const worktree = deps.worktreeState && before.root ? await deps.worktreeState(before.root, before.baseSha) : null;
    const todos = autoSplit.splitTodos(before, deps.readTodos(plan.projectId), plan.todoText);
    const request = autoSplit.buildSplitRequest({ pkg: before, reason, detail, worktree });
    const planDocs = readPlanDocs(plan.repoPath, todos);
    const call = (extra) =>
      deps.runPlanner(
        plannerArgs({ cwd: plan.repoPath, env, openTodos: todos, effort: null, planner: 'free', planDocs, extraPrompt: extra ? `${request}\n${extra}` : request }),
      );
    const res = await call(null);
    if (!live()) return;
    let outcome = { ok: false, error: res.ok ? 'invalid' : res.error || 'failed' };
    let warnings = [];
    if (res.ok) {
      const validate = (raw) => validatePlan(raw, todos);
      const round = await planBuild.freeSizingRound({
        checked: validate(res.raw),
        costUsd: null,
        rerun: call,
        validate,
        size: (pkgs) => sizeOf(plan.repoPath, pkgs),
      });
      if (!live()) return;
      warnings = round.warnings;
      const split = autoSplit.checkSplit(round.checked);
      outcome = split.ok
        ? autoSplit.applySplit(plan.packages, id, planBuild.withPlanLinks(split.packages, todos), { toRun: runPackage })
        : split;
    }
    finishAutoSplit(id, reason, outcome, warnings);
  }

  function finishAutoSplit(id, reason, outcome, warnings) {
    const old = findPkg(id);
    if (outcome.ok) {
      plan.packages = sup.withBlockedBy(outcome.packages.map((p) => (p.id === id ? { ...p, splitting: false } : p)));
      if (warnings.length) plan.warnings = [...plan.warnings, ...warnings];
      if (old && old.sessionId && sessionAlive(old.sessionId)) closeSession(old.sessionId);
      onRunEvent('autoSplitDone', { id, into: outcome.ids });
    } else {
      patch(id, { splitting: false, splitFailed: true });
      markTerminal(id, reason);
      onRunEvent('autoSplitFailed', { id, error: outcome.error });
    }
    commit();
    kick();
  }

  /**
   * A topic split that hit a Claude limit: wait for the reset (or switch to a
   * free Claude account), like makePlan. Returns the refusal to hand back.
   */
  function armPlanWait(ctx, res) {
    const limits = deps.usageLimits ? deps.usageLimits() : [];
    const decision = planWaitDecision({ res, limits, now: now() });
    if (decision.action !== 'wait') return res;
    if (deps.accountFailover && deps.accountFailover(decision.resumeAt || null)) {
      const retryCtx = deps.freshEnv ? { ...ctx, env: deps.freshEnv() } : ctx;
      planWaiter.arm(retryCtx, { ...decision, resumeAt: now() + ACCOUNT_SWITCH_RETRY_MS, source: 'account' });
    } else {
      planWaiter.arm(ctx, decision);
    }
    return { ok: false, error: 'waiting', planWait: planWaiter.view() };
  }

  /**
   * The agy "Plan only" planner's `--model` id: the saved family resolved
   * against the live `agy models` list, the same way makePlan does (a plan
   * run has no planner effort, so the default level picks the variant). No
   * pick, or a family the live list lacks: null, logged - agy's default model.
   * @param {unknown} key ctx.plannerAgyModel
   * @returns {Promise<string|null>}
   */
  async function planRunAgyModel(key) {
    const id = key ? await poolRun.agyPlannerModelId(key, null) : null;
    if (!id) log('[orchestra] Plan only: the agy planner runs on agy\'s default model');
    return id;
  }

  /**
   * Free God Mode v2 plan run (orchestraPlanRunStart.js): ONE topic split,
   * then the topic -> critique -> synthesis packages start right away (Q6),
   * locked down on the plan profile (orchestraPlanRunLaunch.js).
   * @param {{projectId:string|null, repoPath:string, env:object, request:string,
   *   planner:'claude'|'free', planRunRequest:true}} ctx validated in main
   */
  async function makePlanRun(ctx) {
    if (isBusy()) return { ok: false, error: 'busy' };
    if (plan && plan.packages.some(sup.isActive)) return { ok: false, error: 'runActive' };
    if (deps.repoBusy && deps.repoBusy(ctx.repoPath)) return { ok: false, error: 'repoBusy' };
    const profile = deps.planProfile ? deps.planProfile() : null;
    const settings = planLaunch.planRunSettings({ profileExists: !!profile });
    if (!settings.ok) return { ok: false, error: settings.error };
    // Refused up front: a worker that could not be locked down never starts.
    if (!planLaunch.canLockdown(profile.command)) return { ok: false, error: 'noLockdown' };
    if (!deps.runTopicSplit) return { ok: false, error: 'failed' };
    if (planWaiter.isWaiting()) planWaiter.clear();

    busy = true;
    planningRepo = ctx.repoPath;
    try {
      const agyModel = ctx.planner === 'agy' ? await planRunAgyModel(ctx.plannerAgyModel) : null;
      const [res, dirty, baseBranch] = await Promise.all([
        deps.runTopicSplit({ cwd: ctx.repoPath, env: ctx.env, request: ctx.request, planner: ctx.planner, ...(agyModel ? { model: agyModel } : {}) }),
        deps.dirtyCount(ctx.repoPath),
        deps.baseBranchOf ? deps.baseBranchOf(ctx.repoPath) : null,
      ]);
      // Only the Claude planner waits for its window; a free one just fails.
      if (!res.ok) return ctx.planner === 'claude' ? armPlanWait(ctx, res) : res;
      const runSlug = planStart.deriveRunSlug(ctx.request, now());
      const built = planStart.planRunSetup({ request: ctx.request, raw: res.raw, runSlug });
      if (!built.ok) return { ok: false, error: built.error, errors: built.errors };
      clearAllTimers();
      ownershipNudged.clear();
      plan = {
        ...planStart.planRunState({
          id: `p${now().toString(36)}`,
          ctx,
          settings,
          runSlug,
          built,
          costUsd: res.costUsd,
          dirty,
          baseBranch: sup.isBaseBranch(baseBranch) ? baseBranch : null,
          options: sup.normalizeOptions({ unattendedApprovalMin: workerSettings().unattendedApprovalMin, sleepOnLimit: false, shutdownWhenDone: false }),
          estimate: estimatePlan(built.packages, []),
          packages: built.packages.map(runPackage),
        }),
        followups: ctx.followups === true,
      };
      runSettledHook = null;
      // Q6: no review step - the run starts now.
      freezeSettings();
      plan.started = true;
      plan.runStartedAt = now();
      commit();
    } finally {
      busy = false;
      planningRepo = null;
    }
    await pump();
    return { ok: true, plan: view() };
  }

  /**
   * A plan-run package pushed its doc: a copy goes next to the run report
   * (deps.planDocs), and PLAN.md's tasks are sized - ONE split round back to
   * the synthesis worker, then flagged on the board. True when the package
   * went back to work (the split round).
   */
  function onPlanDocPushed(id) {
    const pkg = findPkg(id);
    const docs = deps.planDocs;
    if (!docs || !plan.planRun || !pkg) return false;
    const file = planView.planDocFile(pkg);
    const text = file ? docs.read(pkg) : null;
    if (typeof text === 'string' && docs.save(plan.id, file, text)) {
      plan.planRun = { ...plan.planRun, saved: [...new Set([...(plan.planRun.saved || []), id])] };
    }
    if (pkg.planRun.role !== ROLE_SYNTHESIS) return false;
    const alive = sessionAlive(pkg.sessionId);
    const step = docs.sizing(text, {
      root: pkg.root,
      // No live worker to send the split to: straight to the board.
      splitsSent: alive ? pkg.planSplits || 0 : Infinity,
      planPath: planDocPath(plan.planRun.runSlug),
    });
    if (step.action === 'split') {
      patch(id, { state: 'launched', planSplits: (pkg.planSplits || 0) + 1, nudges: 0 });
      writePty(pkg.sessionId, planView.splitRoundText(id, step.brief), { paste: true });
      return true;
    }
    plan.planRun = { ...plan.planRun, flagged: step.action === 'flag' ? step.flagged : [] };
    return false;
  }

  const isHybridFreePackage = (pkg) =>
    !!plan && !plan.planRun && hybridRules.isHybridPlan(plan) && !!pkg && pkg.model === 'free' && !pkg.modelOverride;

  const packageRunsClaude = (pkg) =>
    !!plan && !plan.freeMode && !plan.planRun && !agyRules.packageRunsAgy(plan, pkg) && !isHybridFreePackage(pkg);

  /** Profile id for a package's worker tab; null refuses a launch instead of falling back to Claude. */
  function profileForPackage(pkg) {
    if (!plan.planRun && agyRules.packageRunsAgy(plan, pkg)) {
      const agyId = plan.agyProfileId || (deps.agyProfileId ? deps.agyProfileId() : null);
      if (!agyId) log(`[orchestra] ${pkg.id} runs on agy but no agy profile is set; refusing to fall back to Claude`);
      return agyId || null;
    }
    if (!plan.planRun && plan.freeMode) {
      const freeId = plan.profileId || (deps.freeProfileId ? deps.freeProfileId() : null);
      if (!freeId) log(`[orchestra] ${pkg.id} runs on a free profile but none is set; refusing to fall back to Claude`);
      return freeId || null;
    }
    if (isHybridFreePackage(pkg)) {
      // Match hybridRules.runsFree: refuse to launch unless the plan itself carries a valid coding profile.
      const codingId = hybridRules.isCodingProfileId(plan.hybridProfileId) ? plan.hybridProfileId : null;
      if (!codingId) log(`[orchestra] ${pkg.id} runs free in a hybrid run but plan.hybridProfileId is missing or invalid; refusing to fall back to Claude`);
      return codingId;
    }
    return plan.profileId;
  }

  /** @param {{resumeId?:string, resumeMessage?:string}} [resume] reopen this conversation instead (main-only opts) */
  function openTab(pkg, cwd, branch, briefPath, resume = {}) {
    const profileId = profileForPackage(pkg);
    if (!profileId) return null;
    const runsAgy = !plan.planRun && agyRules.packageRunsAgy(plan, pkg);
    const runsFree = !plan.planRun && (plan.freeMode === true || isHybridFreePackage(pkg));
    const strict = runsAgy || runsFree;
    const strictBackend = runsAgy ? 'agy' : runsFree ? 'free' : null;
    const task = plan.planRun
      ? planLaunch.planWorkerTask({
          briefPath,
          runSlug: plan.planRun.runSlug,
          mcpConfigPath: deps.planMcpConfigPath ? deps.planMcpConfigPath() : null,
        })
      : withKit(pkg, { briefPath, model: taskModelFor(pkg), effort: effortFor(pkg), permissionMode: plan.permissionMode, allowedTools: plan.allowedTools || [] });
    return deps.createSession({
      ...resume,
      ...(strict ? { strictProfile: true } : {}),
      ...(strictBackend ? { strictBackend } : {}),
      profileId,
      projectId: plan.projectId,
      cwd,
      branch,
      // The God Mode marker: a scoped intake token, never the tab's full one (orchestraFollowupsLaunch.js).
      task: followupLaunch.godModeTask(task, { runId: plan.id, packageId: pkg.id, followups: plan.followups === true }),
    });
  }

  /**
   * The model a worker task carries. On agy: its agy choice, an 'agy:<id>'
   * variant only while the live `agy models` list (deps.agyModels,
   * src/agymodels.js) holds the id - else plain 'agy', agy's default model.
   * On Claude: packageModelOf.
   */
  function taskModelFor(pkg) {
    if (!agyRules.packageRunsAgy(plan, pkg)) return modelFor(pkg);
    const chosen = agyRules.packageAgyModel(plan, pkg);
    if (chosen === agyRules.AGY) return chosen;
    if (deps.agyModels && deps.agyModels.resolveModelId(chosen)) return chosen;
    return poolFamilyFallback(pkg, chosen) || agyRules.AGY;
  }

  /**
   * A pool package whose agy variant left the live list: its family's live
   * variant instead of agy's own default model, with a board note. Null
   * outside a pool family, or when the family has no live variant either.
   */
  function poolFamilyFallback(pkg, chosen) {
    if (!deps.agyModels || pkg.modelOverride) return null;
    const fallback = poolEffortRules.familyFallback(pkg, deps.agyModels.list(), effortFor(pkg));
    if (!fallback || !deps.agyModels.resolveModelId(fallback)) return null;
    log(`[orchestra] package ${pkg.id}: agy variant ${chosen} is not in the live \`agy models\` list; runs on ${fallback}`);
    const note = { code: poolEffortRules.NOTE_VARIANT_GONE, id: pkg.id, from: chosen, to: fallback };
    plan.warnings = poolEffortRules.withNotes(plan.warnings, [note]);
    return fallback;
  }

  /**
   * Before packages that name an agy variant (re)start: the agy model list,
   * read once if no call has worked yet (one ensure() for all of them).
   * @param {object[]} pkgs
   */
  async function agyModelsReady(pkgs) {
    if (!deps.agyModels || !plan) return;
    const named = (p) => p && agyRules.packageRunsAgy(plan, p) && agyRules.packageAgyModel(plan, p) !== agyRules.AGY;
    if (pkgs.some(named)) await deps.agyModels.ensure();
  }

  /**
   * The agy model a package's worker runs on, for its card: the variant's id
   * when the live list holds it, else what the tab's agy transcript reports
   * (src/agytranscript.js), else null. Null for a package not on agy.
   */
  function agyModelShown(pkg) {
    if (!pkg.sessionId || !agyRules.packageRunsAgy(plan, pkg)) return null;
    const id = agyModelIdOf(agyRules.packageAgyModel(plan, pkg));
    if (id && deps.agyModels && deps.agyModels.isKnownId(id)) return id;
    return deps.sessionAgyModel ? deps.sessionAgyModel(pkg.sessionId) : null;
  }

  /** A Luna's Work build's tool kit on top of a package's task (deps.workerTools); the task as is otherwise. */
  function withKit(pkg, task) {
    let kit = null;
    try {
      kit = deps.workerTools ? deps.workerTools(pkg) : null;
    } catch (err) {
      log(`[orchestra] tool kit for ${pkg.id} not applied: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!kit || typeof kit !== 'object') return task;
    const list = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);
    return {
      ...task,
      allowedTools: [...task.allowedTools, ...list(kit.allowedTools)],
      disallowedTools: list(kit.disallowedTools),
      mcpConfigPath: typeof kit.mcpConfigPath === 'string' ? kit.mcpConfigPath : null,
      addDirs: list(kit.addDirs),
    };
  }

  /** openTab from a sync path (timer, watcher callback): never throws. */
  function safeOpenTab(pkg, cwd, branch, briefPath, resume) {
    try {
      return openTab(pkg, cwd, branch, briefPath, resume);
    } catch (err) {
      log(`[orchestra] could not open a tab for ${pkg.id}: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  // Evidence from an earlier attempt would explain the wrong failure: cleared too.
  const freshRun = () => ({
    nudges: 0,
    verifyRounds: 0,
    startedAt: now(),
    pausedMs: 0,
    error: null,
    detail: null,
    lastWords: null,
    verifyTail: null,
    // A new tab is a new conversation; commit() reads its id from the session.
    transcriptId: null,
  });
  // Context guard: the resume brief carried the progress summary, so the mark is spent.
  const spentContextMark = (pkg) => (pkg && pkg.contextResume ? { contextResume: null } : {});
  // A/B: a variant that works again is no longer built; its next finish parks it anew.
  const spentAbBuild = (pkg) => (pkg && pkg.abBuilt ? { abBuilt: null } : {});

  /**
   * Worktree + brief + tab for one package. Never throws. A failure after
   * the worktree was made removes the worktree AND its branch, and records
   * a structured `failure` for the board.
   */
  async function launchOne(pkg, stamp) {
    const made = { wt: null, base: null, depBranch: null };
    // A fresh launch replaces any held one (its worktree is cleared below).
    if (pkg.heldLaunch) patch(pkg.id, { heldLaunch: false });
    let leftovers = Array.isArray(pkg.leftovers) ? pkg.leftovers : [];
    // Awaited only when there is something to clear: a plain launch reaches
    // git without yielding first.
    if (earlierWorktrees(pkg).length) {
      const earlier = await clearEarlierLaunches(cleanupGit(), plan.repoPath, pkg);
      for (const e of earlier.errors) log(`earlier launch of ${pkg.id} not fully cleaned up: ${e}`);
      leftovers = earlier.kept;
      const gone = earlier.rootCleared ? { root: null, cwd: null, branch: null, briefPath: null, baseSha: null } : {};
      patch(pkg.id, { ...gone, leftovers });
    }
    let result;
    try {
      result = await launchOneUnsafe(pkg, stamp, made);
    } catch (err) {
      result = { state: 'failed', error: 'launchThrew', detail: err instanceof Error ? err.message.slice(0, 300) : null };
    }
    if (result.state !== 'failed') return { ...result, failure: null };
    const failure = failureOf(result, made.depBranch, now());
    if (!made.wt) return { ...result, failure };
    const cleaned = await cleanupFailedLaunch(cleanupGit(), plan.repoPath, made.wt, made.base);
    if (cleaned.error) log(`failed launch of ${pkg.id} not fully cleaned up: ${cleaned.error}`);
    // Worktree gone: Retry starts a fresh launch instead of reopening it.
    // Still there: remembered, so the next launch clears it first.
    const gone = cleaned.removed
      ? { branch: null, root: null, cwd: null, briefPath: null, baseSha: null }
      : { leftovers: withLeftover(leftovers, { root: made.wt.root, branch: made.wt.branch || null, base: made.base }) };
    return { ...result, ...gone, failure };
  }

  function cleanupGit() {
    return { removeWorktree: deps.removeWorktree, deleteBranch: deps.deleteBranch };
  }

  /**
   * A dependent builds on its dependencies' work: its worktree starts from
   * the first dependency's pushed head and merges the others in. A merge
   * that neither git nor the headless resolver can finish never fails the
   * package: the worker gets it as the first step of its brief.
   */
  async function launchOneUnsafe(pkg, stamp, made) {
    // The brief's memory query is embedded while git and the install work (bounded, src/memoryinject.js).
    const memoryWarm = warmProjectMemory(pkg);
    const pushedDeps = pkg.dependsOn.map(findPkg).filter((d) => d && d.state === 'pushed' && d.branch);
    const baseDep = pushedDeps.find((d) => d.headSha) || null;
    made.depBranch = baseDep ? baseDep.branch : null;
    const createWorktree =
      deps.worktreePool && typeof deps.worktreePool.acquire === 'function'
        ? (repo, name, opts) => deps.worktreePool.acquire(repo, name, { ...opts, linkNodeModules: false })
        : deps.addWorktree;
    const wt = await createWorktree(plan.repoPath, `${pkg.id}-${stamp}`, {
      base: baseDep ? baseDep.headSha : undefined,
      ...(plan.freeMode ? { branchPrefix: FREE_BRANCH_PREFIX } : {}),
      ...(plan.planRun ? { branchPrefix: planLaunch.PLAN_BRANCH_PREFIX } : {}),
    });
    if (!wt.ok) {
      // git got as far as creating the folder: launchOne() cleans it up.
      if (wt.root) made.wt = { root: wt.root, branch: wt.branch || null };
      return { state: 'failed', error: wt.error, detail: wt.detail || null, retryable: wt.retryable === true };
    }
    // From here on every failure is cleaned up by launchOne().
    made.wt = wt;
    made.base = baseDep ? baseDep.headSha : null;
    // A free run never works on (or pushes) the target branch.
    if (plan.freeMode && !isSafeFreeBranch(wt.branch, plan.baseBranch)) {
      return { state: 'failed', error: 'unsafeBranch', detail: wt.branch || null };
    }
    // Nor does a plan run (orchestraPlanRunLaunch.js): luna-plan/ only.
    if (plan.planRun && !planLaunch.isSafePlanBranch(wt.branch, plan.baseBranch)) {
      return { state: 'failed', error: 'unsafeBranch', detail: wt.branch || null };
    }
    const others = pushedDeps.filter((d) => d !== baseDep).map((d) => d.branch);
    let depMerge = null;
    if (others.length && deps.mergeDeps) {
      // mergeDeps aborts what it cannot merge, so the worktree is clean on the
      // base dependency's head plus whatever did merge.
      depMerge = workerDepMerge(await deps.mergeDeps(wt.root, others), others);
    }
    const baseSha = await headSha(wt.root);
    // After any dependency merges: the branch has no own work beyond this yet.
    if (baseSha) made.base = baseSha;
    const briefPath = briefPathFor(wt.cwd, wt.root);
    const where = { branch: wt.branch, root: wt.root, cwd: wt.cwd, briefPath, baseSha, depMerge };
    // The worktree's own dependencies, before the worker starts. A failed
    // install keeps the worktree (Retry installs again) and stalls the package.
    const installed = await installDeps(wt.root);
    if (!installed.ok) return { ...where, ...installFailedFields(installed.output) };
    const ready = checkDeps(wt.root);
    // No package is stalled for a machine problem: the run holds and Resume
    // starts this worker in the same worktree.
    if (!ready.ok) return { ...where, state: 'pending', heldLaunch: true, held: ready };
    await agyModelsReady([pkg]);
    if (memoryWarm) await memoryWarm;
    return startWorker(pkg, where);
  }

  /**
   * Starts embedding a package's memory query ahead of its brief, or null
   * without a warmer. The promise never rejects and settles within the
   * injector's timeout; the brief falls back to keywords on its own.
   */
  function warmProjectMemory(pkg) {
    if (typeof deps.warmProjectMemory !== 'function') return null;
    try {
      return Promise.resolve(deps.warmProjectMemory(plan.repoPath, pkg)).catch((err) => log(`project memory not prepared for ${pkg.id}: ${(err && err.message) || err}`));
    } catch (err) {
      log(`project memory not prepared for ${pkg.id}: ${(err && err.message) || err}`);
      return null;
    }
  }

  /**
   * Brief + tab for a package whose worktree is ready.
   * @param {object} pkg
   * @param {{branch:string, root:string, cwd:string, briefPath:string, baseSha:string|null, depMerge:object|null}} where
   */
  function startWorker(pkg, where) {
    // The brief's memories count for the package only once a worker got it (src/orchestraBriefMemory.js).
    const known = findPkg(pkg.id);
    const unseen = { briefMemory: (known && known.briefMemory) || null, briefOutcome: (known && known.briefOutcome) || null };
    if (!where.briefPath || !deps.writeBrief(where.briefPath, runBrief(pkg, where.branch, { depMerge: where.depMerge, memory: projectMemoryFor(pkg) }))) {
      return { ...where, ...unseen, state: 'failed', error: 'briefFailed' };
    }
    // Same folder briefPathFor() used: the first message names the brief relative to it.
    let session;
    try {
      session = openTab(pkg, where.cwd || where.root, where.branch, where.briefPath);
    } catch (err) {
      patch(pkg.id, unseen);
      throw err;
    }
    if (!session) return { ...where, ...unseen, state: 'failed', error: 'noTab' };
    return { ...where, ...freshRun(), state: 'launched', sessionId: session.id, heldLaunch: false };
  }

  /**
   * A worker's brief file: inside the folder its tab starts in
   * (src/workerBrief.js), named after its worktree. Always recomputed, never
   * taken from the saved run, so only that folder is ever written to.
   * @param {string|null} cwd the tab's cwd (null: the worktree root)
   * @param {string} root the package worktree
   * @returns {string|null} null when the folder is unusable (callers fail with briefFailed)
   */
  function briefPathFor(cwd, root) {
    try {
      return workerBrief.briefPathIn(cwd || root, path.basename(String(root || '')));
    } catch (err) {
      log(`[orchestra] no brief path for ${String(root)}: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  /**
   * Deletes a package's brief (finished or discarded run); never throws. The
   * path is recomputed from the worktree, never taken from the saved run.
   */
  function dropBrief(pkg) {
    if (!pkg || !pkg.root || typeof deps.removeBrief !== 'function') return;
    const file = briefPathFor(pkg.cwd, pkg.root);
    if (!file) return;
    try {
      deps.removeBrief(file);
    } catch (err) {
      log(`[orchestra] brief of ${pkg.id} not removed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** briefText with this run's follow-up option: every worker brief of the run goes through here. */
  function runBrief(pkg, branch, opts = {}) {
    return briefText(pkg, branch, { ...opts, followups: !!plan && plan.followups === true });
  }

  /**
   * The brief's project memory section, or null. Memory never stops a worker
   * from starting. The memories it shows stay on the package (`briefMemory`)
   * for the run's brief-outcome lines (src/orchestraBriefMemory.js).
   */
  function projectMemoryFor(pkg) {
    if (typeof deps.projectMemory !== 'function') return null;
    try {
      const { text, briefMemory } = briefMemoryRules.readInjection(deps.projectMemory(plan.repoPath, pkg));
      const current = briefMemory ? findPkg(pkg.id) : null;
      if (current) patch(pkg.id, briefMemoryRules.injectedFields(current.briefMemory, briefMemory));
      return text;
    } catch (err) {
      log(`project memory unavailable for ${pkg.id}: ${(err && err.message) || err}`);
      return null;
    }
  }

  /** The brief of a reopened worker: RESUMING, with the same project memory section as a first start. */
  function resumeBrief(pkg, extra = {}) {
    const text = runBrief(pkg, pkg.branch, { ...extra, resume: true, memory: projectMemoryFor(pkg) });
    // Context guard: a session that ran out of context without /compact resumes with its progress.
    const context = contextResumeSection(pkg);
    return context ? `${text}\n\n${context}\n` : text;
  }

  /** Self-heal: the stalled worker reopens once in its worktree, told what was fixed. */
  function healResume(id, section) {
    const pkg = findPkg(id);
    if (!pkg) return false;
    const text = `${withStallNote(resumeBrief(pkg), pkg.error, pkg.detail)}\n\n${section}\n`;
    return reopenInWorktree(pkg, text).ok;
  }

  /** A failed dependency install: its own error, the last line and the output tail. */
  function installFailedFields(output) {
    const lines = String(output || '')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    return {
      state: 'stalled',
      error: 'installFailed',
      detail: (lines.pop() || 'npm ci failed').slice(0, 300),
      verifyTail: outputTail(output),
      stalledAt: now(),
    };
  }

  /**
   * The safety net before a worker starts or a verify runs: the package's
   * node_modules must hold its dependencies. A held run passes nothing.
   * @returns {boolean}
   */
  function depsReady(pkg) {
    if (plan.hold) return false;
    const res = checkDeps(pkg && pkg.root);
    if (res.ok) return true;
    holdRun(res);
    return false;
  }

  /**
   * Holds the WHOLE run: no launch, no reopen and no verify until Resume.
   * Workers already running carry on in their own worktrees.
   * @param {{dir:string, detail?:string}} res a failed checkNodeModules
   */
  function holdRun(res) {
    // A killed run holds nothing: Retry checks again.
    if (plan.hold || plan.killed) return;
    plan.hold = { reason: 'noNodeModules', ...holdFields(res), at: now() };
    // Fixed by hand or by a late install: the run resumes on its own.
    holdWatch.arm();
    // The playbook installs the package worktree's dependencies and resumes;
    // Mati is told only when it cannot.
    if (!recover.onHold(res)) onRunEvent('noNodeModules', holdFields(res));
  }

  /** What a hold / its message carries from a failed checkNodeModules. */
  function holdFields(res) {
    return { dir: res.dir, detail: res.detail || null, cause: holdCause(res), missing: res.missing || null };
  }

  /** Every folder a 'noNodeModules' hold is about: its own and each held package's. */
  function heldDirs() {
    if (!plan || !plan.hold) return [];
    return [...new Set([plan.hold.dir, ...plan.packages.filter(isHeld).map((p) => p.root)].filter(Boolean))];
  }

  /** Drops the hold and every package's waiting flag (restart, kill). */
  function releaseHold() {
    plan.hold = null;
    holdWatch.cancel();
    plan.packages = plan.packages.map((p) =>
      isHeld(p) ? { ...p, awaitingDeps: false, heldResume: null, heldLaunch: false, heldRetry: false } : p,
    );
  }

  async function launchPackages(chosen) {
    // Awaited only right after a resume: a plain launch reaches git without yielding.
    if (resumeGate.waitMs() > 0) await settleAfterResume();
    const stamp = now().toString(36).slice(-5);
    for (const pkg of chosen) {
      // Kill / whole-run pause / hold / low battery while an earlier launch was awaiting git: stop here.
      if (plan.killed || allPaused() || plan.hold || plan.interrupted || batteryHeld()) break;
      if (isPackagePaused(pkg)) continue;
      cancelAutoRetry(pkg.id);
      const before = findPkg(pkg.id) || pkg;
      const { retryable, held, ...result } = await launchOne(before, stamp);
      if (plan.killed && result.state === 'launched') {
        // The kill landed during this very launch: the tab exists, stop it too.
        writePty(result.sessionId, ESC);
        patch(pkg.id, { ...result, state: 'killed' });
      } else if (plan.interrupted && result.state === 'launched') {
        // "Pause for shutdown" landed during this launch. An Esc this early
        // would reach a CLI that has not started yet: the new tab closes, the
        // resume opens a fresh worker in the same worktree.
        patch(pkg.id, { ...result, sessionId: null });
        plan.packages = resumeRules.markPausedForShutdown(plan.packages, { stop: new Set([pkg.id]), requeue: new Set(), nowMs: now() });
        closeSession(result.sessionId);
      } else {
        patch(pkg.id, result);
        if (result.state === 'failed') onLaunchFailed(before, { ...result, retryable });
        else transientRetries.delete(pkg.id);
        if (held) holdRun(held);
        // Killed during the install: no held launch to resume, the next
        // launch clears this worktree like any earlier one.
        if (held && plan.killed) patch(pkg.id, { heldLaunch: false });
        if (result.state === 'stalled') {
          // An install failure: nothing automatic installs again, Retry does.
          markTerminal(pkg.id, result.error);
          onRunEvent('stalled', { id: pkg.id, reason: result.error });
        }
      }
      commit();
    }
  }

  /** Right after a system resume git is slow to answer: wait it out first. */
  async function settleAfterResume() {
    // One wait, capped by the gate: a clock that stands still or steps back never loops.
    const wait = resumeGate.waitMs();
    if (wait <= 0) return;
    await new Promise((resolve) => {
      const timer = setTimer(resolve, wait);
      if (timer && typeof timer.unref === 'function') timer.unref();
    });
  }

  /**
   * Machinery auto-retry: a failed launch is tried again by itself after
   * AUTO_RETRY_DELAY_MS, at most MAX_AUTO_RETRIES times. The same error +
   * detail twice in a row means it will not fix itself: terminal. A git that
   * did not answer (result.retryable) backs off instead and is never terminal
   * on a repeat (orchestraLaunchRetry.js).
   * @param {object} before the package as it was before this launch
   * @param {{error?:string, detail?:string|null}} result
   */
  function onLaunchFailed(before, result) {
    if (plan.killed) return;
    // Just after a wake: the playbook's own wait-and-retry-once comes first.
    const wake = recover.onLaunchFailed(before, result);
    if (wake) {
      armAutoRetry(before.id, wake.delayMs);
      return;
    }
    const transientTries = transientRetries.get(before.id) || 0;
    const decision = launchRetryDecision({
      before,
      result,
      transientTries,
      maxRetries: sup.MAX_AUTO_RETRIES,
      delayMs: AUTO_RETRY_DELAY_MS,
    });
    if (decision.action === 'terminal') {
      markTerminal(before.id, result.error || 'failed');
      return;
    }
    // A git that did not answer has its own ladder (backoff, no repeat rule).
    if (decision.transient) transientRetries.set(before.id, transientTries + 1);
    else patch(before.id, { autoRetries: (before.autoRetries || 0) + 1 });
    armAutoRetry(before.id, decision.delayMs);
  }

  function armAutoRetry(id, delayMs) {
    const timer = setTimer(() => fireAutoRetry(id), delayMs);
    // A real timer must not keep a test process (or a quitting app) alive.
    if (timer && typeof timer.unref === 'function') timer.unref();
    retryTimers.set(id, timer);
  }

  /** The scheduled relaunch: back to pending, the pump launches it in a free slot. */
  function fireAutoRetry(id) {
    retryTimers.delete(id);
    const pkg = plan ? findPkg(id) : null;
    if (!pkg || plan.killed || pkg.state !== 'failed') return;
    // error/detail stay until the launch result replaces them: the next
    // failure is compared against them.
    patch(id, { state: 'pending' });
    onRunEvent('autoRetry', { id, attempt: pkg.autoRetries });
    commit();
    kick();
  }

  /**
   * Nothing automatic will pick this package up again: flag it and mark
   * every pending dependent blockedBy it, so the board says why they wait.
   */
  function markTerminal(id, reason) {
    patch(id, { terminal: true });
    plan.packages = sup.withBlockedBy(plan.packages);
    onRunEvent('terminal', { id, reason });
    // A known cause whose automatic fix already ran: Mati is asked once.
    recover.onTerminal(findPkg(id), reason);
  }

  /** An A/B group neither of whose variants was built: stalled for good (it has no worker to resume). */
  function stallGroup(id, reason, detail) {
    const p = findPkg(id);
    if (!p) return;
    const stallHistory = sup.withHistoryEntry(p.stallHistory, { at: now(), kind: 'stall', reason, detail });
    patch(id, { state: 'stalled', error: reason, detail, stalledAt: now(), stallHistory });
    markTerminal(id, reason);
    onRunEvent('stalled', { id, reason });
    commit();
  }

  /** Ends the run once nothing more can happen on its own, then finalizes it. */
  function checkSettled() {
    if (!plan.started || plan.killed || plan.settled || plan.interrupted || !sup.isSettled(plan.packages, maxParallelFor(plan, MAX_PARALLEL))) return;
    // A scheduled automatic relaunch keeps the run open, and so does a split
    // in flight, a self-heal under way or an A/B critic still deciding.
    if (retryTimers.size || splitting.size || healer.busy() || variantRun.busy()) return;
    plan.settled = true;
    settledFinalize = true;
    const allPushed = plan.packages.every((p) => p.state === 'pushed');
    onRunEvent(allPushed ? 'done' : 'needYou', sup.tally(plan.packages));
    startFinalize();
  }

  function startFinalize() {
    finalizer
      .finalize()
      .catch((err) => onRunEvent('error', { where: 'finalize', message: err instanceof Error ? err.message : String(err) }));
  }

  /**
   * The finalizer went idle. A run that settled on its own ('done' /
   * 'needYou') may now shut the PC down - never a killed one, never with a
   * package, finalize or another God Mode run still going.
   */
  function afterFinalize() {
    // The finalizer's last commit went out while isRunning() was still true;
    // the board and the phone get the settled view (running: false) now.
    if (plan) commit();
    // F5 (opt-in): a settled free run's branches get one Claude review each.
    freeReviewer.start();
    fireRunSettled();
    // A fetch / push the network or auth refused is run again after a backoff.
    const integ = plan && !plan.killed ? plan.integration : null;
    if (integ && integ.state === 'done') recover.onIntegrationOk();
    else if (integ) recover.onIntegration(integ, plan.id);
    if (!settledFinalize || !plan) return;
    settledFinalize = false;
    if (!plan.settled || plan.killed) return;
    // Read again after the flush: a replaced or discarded plan, or another
    // run that started meanwhile, stops the shutdown.
    const settledPlan = plan;
    const busyNow = () =>
      isBusy() ||
      recover.pending('run') ||
      plan !== settledPlan ||
      plan.packages.some(sup.isActive) ||
      !!(deps.otherRunsActive && deps.otherRunsActive());
    background(powerFlow.afterFinalize({ busy: busyNow(), stillBusy: busyNow, planId: plan.id }), 'shutdown');
  }

  /**
   * Luna's Work hook: the plan's onRunSettled, at most once per plan, with
   * the integration (merge / self-check) result. Cleared before the call so
   * a later idle never repeats it; a throw or rejection is only logged.
   */
  function fireRunSettled() {
    const hook = runSettledHook;
    if (!hook || !plan || hook.planId !== plan.id) return;
    runSettledHook = null;
    const result = { planId: plan.id, killed: plan.killed, integration: { ...plan.integration }, plan: view() };
    const failed = (err) => log(`[orchestra] onRunSettled failed: ${err instanceof Error ? err.message : String(err)}`);
    try {
      Promise.resolve(hook.fn(result)).catch(failed);
    } catch (err) {
      failed(err);
    }
  }

  /** Launches whatever is ready, while slots are free. Re-entrancy safe. */
  async function pump() {
    // On battery while the run goes: one warning per battery period.
    if (battery && plan && plan.started && !plan.killed && !plan.settled) battery.onRunStart();
    if (!plan || !plan.started || plan.killed || allPaused() || plan.hold || plan.interrupted || pumping || batteryHeld()) return;
    pumping = true;
    try {
      // A/B groups whose variants are done get decided (a restart or a kill may have left one).
      variantRun.evaluateAll();
      // A pool run: not-started packages whose model is out move first (src/orchestraRescue.js).
      rescue.moveOffLimits();
      let ready = launchableReady();
      while (ready.length && !plan.killed && !allPaused() && !plan.hold && !plan.interrupted && !batteryHeld()) {
        await launchPackages(ready);
        rescue.moveOffLimits();
        ready = launchableReady();
      }
      // Again before settling: a variant may have finished while the launches ran.
      variantRun.evaluateAll();
      checkSettled();
      commit();
    } finally {
      pumping = false;
    }
  }

  /** pump() from a sync path: never leaves a rejection unhandled. */
  function kick() {
    pump().catch((err) => onRunEvent('error', { where: 'pump', message: err instanceof Error ? err.message : String(err) }));
  }

  /**
   * Approve (ids null) starts the run: every ready package launches and the
   * supervisor launches the rest as dependencies get pushed. Launch with ids
   * starts named pending packages by hand, dependencies or not. Prompt edits
   * from the review overlay apply before launch.
   * @param {unknown} payload {planId, ids?: string[]|null, prompts?: {[id]: string}}
   * @param {{mergeConfirmed?: boolean}} [trusted] main-only, never from a
   *   payload: mergeConfirmed = the merge was already confirmed (the phone's
   *   Face ID-signed godmode.launch IS the confirmation), so the native
   *   dialog is skipped. orchestra:launch (renderer IPC) never passes it.
   */
  /** The worker effort a picked agy family's variant aims at (as the pool wiring's effortOf). */
  const pickEffortOf = (p) => normalizeEffort(workerSettings().effort) || normalizeEffort(p.effort) || DEFAULT_EFFORT;

  /**
   * Approve's per-package model picks (o.packageModels), checked in main:
   * only before the start, only for a pool run, each one within the ticked
   * pool plus Opus (src/orchestraPackageModel.js). An agy pick is checked
   * against the live `agy models` list.
   * @returns {Promise<{ok:true, picks:object|null, agyList:object[]}|{ok:false, error:string}>}
   */
  async function checkedPackagePicks(o, poolChoice, planAtApprove) {
    if (o.packageModels === undefined || o.packageModels === null) return { ok: true, picks: null, agyList: [] };
    if (plan.started || plan.scheduledAt || plan.planRun || poolChoice.kind !== 'pool') return { ok: false, error: 'badPackageModel' };
    let agyList = [];
    if (packageModelRules.picksNeedAgy(o.packageModels)) {
      if (!deps.agyModels) return { ok: false, error: 'badPackageModel' };
      await deps.agyModels.ensure();
      if (plan !== planAtApprove || plan.started || plan.killed || isBusy() || allPaused() || plan.hold) return { ok: false, error: 'busy' };
      agyList = deps.agyModels.list();
    }
    const checked = packageModelRules.checkPackagePicks(o.packageModels, { packages: poolChoice.packages, pool: poolChoice.pool, agyList });
    if (!checked.ok) return checked;
    if (Object.keys(checked.picks).length) log(`[orchestra] Approve: per-package models ${Object.entries(checked.picks).map(([id, v]) => `${id}=${v.model}/${v.effort}`).join(', ')}`);
    return { ok: true, picks: checked.picks, agyList };
  }

  async function launch(payload, trusted = {}) {
    const o = payload && typeof payload === 'object' ? payload : {};
    const mergeConfirmed = Boolean(trusted) && trusted.mergeConfirmed === true;
    if (!plan || o.planId !== plan.id) return { ok: false, error: 'noPlan' };
    if (plan.errors.length) return { ok: false, error: 'planErrors' };
    if (isBusy()) return { ok: false, error: 'busy' };
    if (allPaused()) return { ok: false, error: 'paused' };
    if (plan.hold) return { ok: false, error: plan.hold.reason };
    // Approve still starts a held run (it launches once plugged in); a
    // launch by hand would start a worker now.
    if (Array.isArray(o.ids) && batteryHeld()) return { ok: false, error: 'batteryLow' };
    const mode = sup.INTEGRATION_MODES.includes(o.integration) ? o.integration : null;
    let startAt = null;
    if (o.schedule != null && !Array.isArray(o.ids) && !plan.started) {
      const when = sup.scheduleTime(o.schedule, now(), deps.usageResetAt ? deps.usageResetAt() : null);
      if (!when.ok) return { ok: false, error: when.error };
      startAt = when.at;
    }

    const edits = o.prompts && typeof o.prompts === 'object' ? o.prompts : {};
    const applyPromptEdits = (pkgs) =>
      pkgs.map((p) => {
        const edited = typeof edits[p.id] === 'string' ? edits[p.id].trim().slice(0, MAX_PROMPT_CHARS) : '';
        // An undecided A/B group runs no worker: its variants carry the prompts.
        return p.state === 'pending' && edited && !variantRules.isUndecidedGroup(p) ? { ...p, prompt: edited } : p;
      });

    const chosen = Array.isArray(o.ids)
      ? plan.packages.filter(
          // An undecided A/B group never launches itself: its variants do (orchestraVariants.js).
          (p) => (p.state === 'pending' || p.state === 'failed') && o.ids.includes(p.id) && !variantRules.isUndecidedGroup(p),
        )
      : null;
    if (chosen ? !chosen.length : !launchableReady().length) {
      const blockedByPause = !chosen && sup.readyToLaunch(plan.packages, maxParallelFor(plan, MAX_PARALLEL)).length > 0;
      return { ok: false, error: blockedByPause ? 'paused' : 'nothingToLaunch' };
    }
    if (chosen && chosen.every(isPackagePaused)) return { ok: false, error: 'paused' };

    // "Workers" (F6; "Free only" = orchestraFree.js): chosen at Approve, fixed
    // for the run. A free-planned run is always a free run (D1: "Free only").
    // A named Workers value must be on the allow-list: refused, never coerced to Claude.
    if (!plan.started && o.workers !== undefined && o.workers !== null && !workersRules.normalizeWorkers(o.workers)) {
      return { ok: false, error: 'badWorkers' };
    }
    // "Workers" pool (src/orchestraPool.js): 0 or 1 ticked model is today's
    // single value, 2+ a pool run. A named pool must be an array.
    if (!plan.started && o.modelPool !== undefined && o.modelPool !== null && !Array.isArray(o.modelPool)) {
      return { ok: false, error: 'badModelPool' };
    }
    const approved = plan.started ? workersRules.storedWorkers(plan) : workersRules.approveWorkers(plan, o);
    const planAtApprove = plan;
    const pendingPool = poolRun.approvePool(o, approved);
    const poolChoice = pendingPool instanceof Promise ? await pendingPool : pendingPool;
    // The `agy models` read let other calls in: a replaced, started or busy plan is not this Approve's.
    if (pendingPool instanceof Promise && (plan !== planAtApprove || plan.started || plan.killed || isBusy() || allPaused() || plan.hold)) {
      return { ok: false, error: 'busy' };
    }
    if (poolChoice.kind === 'error') return { ok: false, error: poolChoice.error };
    // Awaited only when picks were sent: today's Approve keeps its synchronous
    // start, so a Kill right after Approve still finds the run starting.
    const sentPicks = o.packageModels !== undefined && o.packageModels !== null;
    const packagePicks = sentPicks ? await checkedPackagePicks(o, poolChoice, planAtApprove) : { ok: true, picks: null, agyList: [] };
    if (!packagePicks.ok) return packagePicks;
    // The await let other calls in: a replaced, started or killed plan is not this Approve's.
    if (sentPicks && (plan !== planAtApprove || plan.started || plan.killed || isBusy() || allPaused() || plan.hold)) {
      return { ok: false, error: 'busy' };
    }
    const workers = poolChoice.workers || approved;
    // The run model Approve asks for: a pool run's 'plan', a one-model pool's value, else the select's.
    const askedModel = poolChoice.workerModel || o.workerModel;
    // A/B variants (orchestraVariants.js) are built and judged on Claude only:
    // a plan that has them is refused as a free run (replan without A/B for that).
    if (!plan.started && workers === 'free' && variantRules.hasGroups(plan.packages)) return { ok: false, error: 'abNeedsClaude' };

    // Stage Approve settings without mutating `plan` until every check and prompt resolves.
    const stageConfig = !plan.started && !plan.planRun;
    let hasNextWorkers = false;
    let nextWorkers = plan.workers;
    let hasNextHybridProfileId = false;
    let nextHybridProfileId = plan.hybridProfileId;
    let hasNextAgyProfileId = false;
    let nextAgyProfileId = plan.agyProfileId;
    let stagedPackages = null;
    let nextFree = null;

    if (stageConfig) {
      hasNextWorkers = true;
      nextWorkers = workers === 'claude' ? undefined : workers;
      const sourcePackages = applyPromptEdits(poolChoice.packages || plan.packages);
      // Mati's per-package picks from the Approve board become the planned models.
      const picked = packagePicks.picks
        ? packageModelRules.applyPackagePicks(sourcePackages, packagePicks.picks, { agyList: packagePicks.agyList, effortOf: pickEffortOf })
        : sourcePackages;
      stagedPackages = picked.map((p) => ({ ...p }));
      const staged = { ...plan, packages: stagedPackages };
      if (nextWorkers === undefined) delete staged.workers;
      else staged.workers = nextWorkers;

      const coding = workers === 'hybrid'
        ? hybridRules.approveProfile(staged, deps.codingProfileId ? poolRun.codingProfileFor(poolChoice.freeProfileId) : null)
        : { ok: true, profileId: null };
      if (!coding.ok) return { ok: false, error: coding.error };
      hasNextHybridProfileId = true;
      nextHybridProfileId = coding.profileId || undefined;

      // Antigravity (agy): the agy profile its packages run on, fixed for the
      // run - refused with a clear reason when none is configured.
      // The model the run will freeze: Approve's pick, else the plan's, else Settings (Ctrl+L).
      const runModel = workerModelRules.normalizeWorkerModel(askedModel) || plan.workerModel || workerSettings().model || null;
      const agy = agyRules.approveAgyProfile(staged, {
        workers,
        workerModel: runModel,
        agyProfileId: deps.agyProfileId ? deps.agyProfileId() : null,
      });
      if (!agy.ok) return { ok: false, error: agy.error };
      // Every 'agy:<id>' the run would hand agy must be on the live `agy models` list.
      const variants = agyRules.runAgyVariants(staged, { workers, workerModel: runModel });
      if (variants.length) {
        if (!deps.agyModels) return { ok: false, error: 'badAgyModel' };
        await deps.agyModels.ensure();
        if (plan !== planAtApprove || plan.started || plan.killed || isBusy() || allPaused() || plan.hold) {
          return { ok: false, error: 'busy' };
        }
        // A planner's per-package pick the list does not hold (Mati has no
        // per-package picker to fix it): plain agy, logged by resolveModelId.
        for (const p of staged.packages) {
          if (!p.modelOverride && agyModelIdOf(p.model) && !deps.agyModels.resolveModelId(p.model)) p.model = agyRules.AGY;
        }
        // Mati's own picks (the run model, an override) are refused instead.
        const left = agyRules.runAgyVariants(staged, { workers, workerModel: runModel });
        if (left.some((v) => !deps.agyModels.isKnownId(agyModelIdOf(v)))) return { ok: false, error: 'badAgyModel' };
      }
      hasNextAgyProfileId = true;
      nextAgyProfileId = agy.profileId || undefined;
    }

    const wantsFree = workers === 'free';
    if (wantsFree && !plan.started && !plan.freeMode && !plan.planRun) {
      // A one-model pool's free profile is preferred (kept only when it has a chain).
      const free = freeRunSettings({ freeProfileId: deps.freeProfileId ? poolRun.freeProfileFor(poolChoice.freeProfileId) : null });
      if (!free.ok) return { ok: false, error: free.error };
      nextFree = { freeMode: true, profileId: free.profileId, integrationMode: free.integrationMode };
    }

    const previewPlan = nextFree || hasNextWorkers
      ? { ...plan, ...(nextFree || {}), ...(hasNextWorkers && nextWorkers !== undefined ? { workers: nextWorkers } : {}) }
      : plan;
    if (hasNextWorkers && nextWorkers === undefined) delete previewPlan.workers;

    const wanted = planLaunch.planIntegrationFor(previewPlan, integrationFor(previewPlan, mode));
    // "Create a new release after finish": merge runs only, set at Approve
    // (confirmed natively with the merge), stored as options.releaseAfter.
    const release = o.releaseAfter === true && wanted === 'merge' && !plan.started;
    if (wanted === 'merge' && !plan.started && !mergeConfirmed) {
      const okMerge = await confirmMerge({ release });
      if (!okMerge) return { ok: false, error: 'mergeDeclined' };
      if (plan !== planAtApprove || plan.started || plan.killed || isBusy() || allPaused() || plan.hold) {
        return { ok: false, error: 'busy' };
      }
    }

    // After every refusal above: a refused or declined launch saves nothing.
    if (hasNextWorkers) {
      if (nextWorkers === undefined) delete plan.workers;
      else plan.workers = nextWorkers;
    }
    if (hasNextHybridProfileId) {
      if (nextHybridProfileId === undefined) delete plan.hybridProfileId;
      else plan.hybridProfileId = nextHybridProfileId;
    }
    if (hasNextAgyProfileId) {
      if (nextAgyProfileId === undefined) delete plan.agyProfileId;
      else plan.agyProfileId = nextAgyProfileId;
    }
    if (nextFree) {
      plan.freeMode = nextFree.freeMode;
      plan.profileId = nextFree.profileId;
      plan.integrationMode = nextFree.integrationMode;
    }
    if (wanted && !plan.started) plan.integrationMode = wanted;
    if (!plan.started) {
      const { releaseAfter: _previous, ...rest } = plan.options || {};
      plan.options = sup.normalizeOptions(release ? { ...rest, releaseAfter: true } : rest);
    }
    // A pool run is frozen as worker model 'plan' + plan.modelPool and saves
    // no single-model pref; anything else is the single model as before.
    if (poolChoice.kind === 'pool') {
      plan.packages = stagedPackages || applyPromptEdits(poolChoice.packages);
      plan.workerModel = 'plan';
      plan.modelPool = poolChoice.pool;
    } else {
      plan.packages = stagedPackages || applyPromptEdits(plan.packages);
      if (!plan.started && !plan.scheduledAt && !plan.planRun) delete plan.modelPool;
      applyWorkerModel(askedModel, workers);
      // A one-model pool's Claude level: every package is on that model, so it is the run's effort.
      if (poolChoice.workerEffort && !plan.started && !plan.scheduledAt && !plan.planRun) plan.workerEffort = poolChoice.workerEffort;
    }
    // agy variants of Approve's pool that fell back to "Per plan" (src/orchestraPoolEffort.js).
    if (poolChoice.notes) plan.warnings = poolEffortRules.withNotes(plan.warnings, poolChoice.notes);
    if (startAt) {
      freezeSettings();
      plan.scheduledAt = startAt;
      armSchedule(startAt);
      commit();
      return { ok: true, plan: view() };
    }

    busy = true;
    try {
      freezeSettings();
      clearSchedule();
      // Approve by hand on a run the shutdown cut ends its banner.
      shutdownResume.drop();
      plan.scheduledAt = null;
      plan.killed = false;
      plan.settled = false;
      plan.started = true;
      if (!plan.runStartedAt) plan.runStartedAt = now();
      if (chosen) {
        const launchChosen = chosen.map((p) => findPkg(p.id)).filter((p) => p && !isPackagePaused(p));
        // A launch by hand starts the automatic ladder afresh.
        for (const p of launchChosen) {
          cancelAutoRetry(p.id);
          transientRetries.delete(p.id);
          patch(p.id, { autoRetries: 0, terminal: false });
        }
        plan.packages = sup.withBlockedBy(plan.packages);
        await launchPackages(launchChosen.map((p) => findPkg(p.id)).filter(Boolean));
      }
    } finally {
      busy = false;
    }
    await pump();
    return { ok: true, plan: view() };
  }

  /** Idea #2: the held run starts by itself at `at`. */
  function armSchedule(at) {
    clearSchedule();
    scheduleTimer = setTimer(startScheduled, Math.max(0, at - now()));
  }

  function startScheduled() {
    scheduleTimer = null;
    if (!plan || !plan.scheduledAt) return;
    if (plan.started || plan.errors.length) {
      plan.scheduledAt = null;
      commit();
      return;
    }
    if (isBusy()) {
      // Mati is mid-action on the board; try again shortly.
      scheduleTimer = setTimer(startScheduled, NUDGE_DELAY_MS);
      return;
    }
    plan.scheduledAt = null;
    freezeSettings();
    plan.killed = false;
    plan.settled = false;
    plan.started = true;
    if (!plan.runStartedAt) plan.runStartedAt = now();
    onRunEvent('scheduledStart');
    commit();
    kick();
  }

  /** Cancels a scheduled start; the plan stays as it was. */
  function unschedule(payload) {
    const o = payload && typeof payload === 'object' ? payload : {};
    if (!plan || o.planId !== plan.id) return { ok: false, error: 'noPlan' };
    clearSchedule();
    plan.scheduledAt = null;
    commit();
    return { ok: true, plan: view() };
  }

  function stall(id, reason, detail = null) {
    cancelNudge(id);
    hybridRun.forget(id);
    const before = findPkg(id);
    forgetSession(before.sessionId);
    const stalls = (before.stalls || 0) + 1;
    // Each stall is kept (time, reason, short detail), not only the last error.
    const stallHistory = sup.withHistoryEntry(before.stallHistory, { at: now(), kind: 'stall', reason, detail });
    patch(id, { state: 'stalled', error: reason, detail, stalls, stallHistory, stalledAt: now() });
    // Self-heal (opt-in): a known environment error gets one bounded fix and
    // one resume first; the ladder below runs when that is not possible.
    if (!plan.killed && !isPackagePaused(findPkg(id)) && !plan.hold && !plan.planRun && healer.tryHeal(findPkg(id), reason, detail)) {
      commit();
      return;
    }
    afterStall(id, reason, detail);
  }

  /**
   * What happens to a stalled package: auto-split, hand-over, escalation,
   * one automatic resume, or (nothing left) terminal. Also the self-heal's
   * way out when its fix did not get the worker going again.
   */
  function afterStall(id, reason, detail) {
    const pkg = findPkg(id);
    if (!plan || !pkg) return;
    const live = !plan.killed && !isPackagePaused(pkg);
    // Q8: a free-planned run splits a package that stalled twice; Claude
    // runs never get here (shouldAutoSplit) and escalate as before.
    if (live && autoSplit.shouldAutoSplit(plan, pkg, reason) && startAutoSplit(pkg, reason, detail)) {
      commit();
      return;
    }
    // F6c: a hybrid free package that stalled twice goes to Sonnet, not Opus.
    if (live && hybridRun.wantsHandOver(pkg, reason)) {
      if (!hybridRun.handOver(pkg, 'twoStalls', { detail: detail ? `${reason}: ${detail}` : reason })) {
        markTerminal(id, reason);
        onRunEvent('stalled', { id, reason });
      }
      commit();
      kick();
      return;
    }
    const wantsEscalate = live && wantsEscalation(pkg, reason);
    const wantsResume = live && sup.shouldAutoResume(pkg, reason);
    if (wantsEscalate && escalate(pkg, reason, detail)) {
      commit();
      return;
    }
    if (wantsResume && autoResume(pkg, reason, detail)) {
      commit();
      return;
    }
    if ((wantsEscalate || wantsResume) && plan.hold) {
      // The restart waits for Resume instead of being spent on a broken node_modules.
      patch(id, { heldResume: { reason, detail } });
      commit();
      return;
    }
    // A permission prompt still waits for Mati (or the unattended timeout);
    // any other stall here has used up its automatic chances.
    if (live && reason !== 'needsApproval') markTerminal(id, reason);
    onRunEvent('stalled', { id, reason });
    commit();
    kick();
  }

  /**
   * Reopens a package in its own worktree with a fresh brief, like Retry
   * does for a closed tab. The new tab opens first; a still-open old tab is
   * closed after the package points at the new one.
   * @returns {{ok:true} | {ok:false, error:'briefFailed'|'noTab'}}
   */
  function reopenInWorktree(pkg, text) {
    if (!depsReady(pkg)) return { ok: false, error: 'noNodeModules' };
    // Recomputed, never taken from the saved run: only the worktree's own
    // brief folder is ever written to.
    const briefPath = briefPathFor(pkg.cwd, pkg.root);
    if (!briefPath || !deps.writeBrief(briefPath, text)) return { ok: false, error: 'briefFailed' };
    const session = safeOpenTab(pkg, pkg.cwd || pkg.root, pkg.branch, briefPath);
    if (!session) return { ok: false, error: 'noTab' };
    const old = pkg.sessionId;
    patch(pkg.id, { ...freshRun(), state: 'launched', sessionId: session.id, briefPath, ...spentContextMark(pkg), ...spentAbBuild(pkg) });
    if (old && old !== session.id && sessionAlive(old)) closeSession(old);
    return { ok: true };
  }

  /**
   * A resume after a shutdown: the worker's own conversation reopened in its
   * worktree (`claude --resume`, main keeps the model / effort / permission
   * flags via launch.js withAccountResume) with `text` as its first message.
   * @returns {{ok:true} | {ok:false, error:'noNodeModules'|'noTranscript'|'briefFailed'|'noTab'}}
   */
  function reopenChat(pkg, text) {
    const transcriptId = resumeRules.normalizeTranscriptId(pkg.transcriptId);
    if (!transcriptId) return { ok: false, error: 'noTranscript' };
    if (!depsReady(pkg)) return { ok: false, error: 'noNodeModules' };
    // The brief stays readable (and current) should the worker look again.
    const briefPath = briefPathFor(pkg.cwd, pkg.root);
    if (!briefPath || !deps.writeBrief(briefPath, runBrief(pkg, pkg.branch, { resume: true }))) return { ok: false, error: 'briefFailed' };
    const session = safeOpenTab(pkg, pkg.cwd || pkg.root, pkg.branch, briefPath, { resumeId: transcriptId, resumeMessage: text });
    if (!session) return { ok: false, error: 'noTab' };
    // Main could not build a --resume command (a profile that decides its own
    // session): the tab started on its task, i.e. the resume brief just written.
    const resumed = typeof session.transcriptId !== 'string' || session.transcriptId === transcriptId;
    const old = pkg.sessionId;
    patch(pkg.id, { ...freshRun(), state: 'launched', sessionId: session.id, briefPath, transcriptId: resumed ? transcriptId : null });
    if (old && old !== session.id && sessionAlive(old)) closeSession(old);
    return { ok: true, ...(resumed ? {} : { how: 'fresh' }) };
  }

  /** A reopen refused for node_modules waits for the hold's Resume (heldRetry), like Retry. */
  function heldOnDeps(pkg, res) {
    if (!res.ok && res.error === 'noNodeModules') patch(pkg.id, { heldRetry: true });
    return res;
  }

  /**
   * "Pause for shutdown"'s stop of this controller's own machinery: every
   * timer, the reviews waiting and the playbook backoffs. Returns the
   * packages to stop with the workers and those an auto-retry was due for.
   * @returns {{stop:Set<string>, requeue:Set<string>}}
   */
  function stopForPause() {
    const requeue = new Set(retryTimers.keys());
    const stop = new Set([...hybridRun.cancelAll()].filter((id) => (findPkg(id) || {}).state === 'finishing'));
    for (const p of plan.packages) if (recover.pending(p.id)) stop.add(p.id);
    for (const id of stop) recover.cancel(id);
    clearAllTimers();
    for (const p of plan.packages) if (p.sessionId && (stop.has(p.id) || p.state === 'launched')) forgetSession(p.sessionId);
    settledFinalize = false;
    return { stop, requeue };
  }

  /** IPC orchestra:pauseForShutdown - {planId}, cross-checked here too. */
  function pauseForShutdown(payload) {
    const o = payload && typeof payload === 'object' ? payload : {};
    if (!plan || o.planId !== plan.id) return { ok: false, error: 'noPlan' };
    return shutdownResume.pause();
  }

  /** IPC orchestra:resumeInterrupted - "Resume now" on the banner. */
  function resumeInterrupted(payload) {
    const o = payload && typeof payload === 'object' ? payload : {};
    if (!plan || o.planId !== plan.id) return Promise.resolve({ ok: false, error: 'noPlan' });
    return shutdownResume.resume({ manual: true }).then((res) => (res.ok ? { ...res, plan: view() } : res));
  }

  /** IPC orchestra:cancelResume - the banner's Cancel: held as after any restart. */
  function cancelResume(payload) {
    const o = payload && typeof payload === 'object' ? payload : {};
    if (!plan || o.planId !== plan.id) return { ok: false, error: 'noPlan' };
    return shutdownResume.cancel();
  }

  /**
   * One automatic resume of a stalled worker, told why it stalled.
   * @returns {boolean} false when the tab could not be reopened (stays stalled)
   */
  function autoResume(pkg, reason, detail) {
    const text = withStallNote(resumeBrief(pkg), reason, detail);
    if (!reopenInWorktree(pkg, text).ok) return false;
    patch(pkg.id, { autoResumed: true });
    onRunEvent('autoResumed', { id: pkg.id, reason });
    return true;
  }

  /**
   * Idea #6: the stalled Sonnet worker's tab is closed and the package
   * restarts once on Opus in the same worktree, told why. In a pool run it
   * restarts on the next stronger ticked model instead (Opus as an
   * emergency when nothing stronger is ticked; src/orchestraRescue.js).
   * @returns {boolean} false when the new tab could not be opened (stays stalled)
   */
  function escalate(pkg, reason, detail) {
    if (!depsReady(pkg)) return false;
    const poolRunning = rescueRules.isPoolPlan(plan);
    const pooled = poolRunning ? rescue.escalation(pkg, reason) : null;
    if (poolRunning && !pooled) return false;
    const briefPath = briefPathFor(pkg.cwd, pkg.root);
    const text = resumeBrief(pkg, { escalation: { reason, detail } });
    if (!briefPath || !deps.writeBrief(briefPath, text)) return false;
    const old = pkg.sessionId;
    // New tab first: closing the old one first could leave main opening an
    // empty replacement tab when it was the last one.
    // One effort step up as well, capped at max (a pool run: the rescue's effort).
    const modelOverride = pooled ? pooled.fields.modelOverride : 'opus';
    const effortOverride = pooled ? pooled.fields.effortOverride : nextEffort(effortFor(pkg));
    const session = safeOpenTab({ ...pkg, modelOverride, effortOverride }, pkg.cwd || pkg.root, pkg.branch, briefPath);
    if (!session) return false;
    // Re-pointed before the close, so the old tab's close is not read as this package's.
    patch(pkg.id, {
      ...freshRun(),
      state: 'launched',
      sessionId: session.id,
      briefPath,
      ...(pooled ? pooled.fields : {}),
      modelOverride,
      effortOverride,
      escalated: true,
      ...spentContextMark(pkg),
      ...spentAbBuild(pkg),
    });
    if (old && sessionAlive(old)) closeSession(old);
    if (pooled) log(`[orchestra] package ${pkg.id}: ${pooled.text}`);
    onRunEvent('escalated', { id: pkg.id, reason, ...(pooled ? { text: pooled.text } : {}) });
    return true;
  }

  /**
   * Turn ended without a marker. Decided after NUDGE_DELAY_MS, not at once:
   * the usage-limit error that ended the turn arrives right after it, and the
   * pause it starts must win over both a nudge and a noMarker stall.
   */
  function sendNudge(id) {
    nudgeTimers.delete(id);
    const pkg = plan ? findPkg(id) : null;
    if (!pkg || pkg.state !== 'launched' || pkg.awaitingDeps || isPackagePaused(pkg) || plan.killed || hybridRun.isWaiting(pkg)) return;
    const action = sup.turnEndAction(pkg, null);
    if (action.type === 'stall') {
      stall(id, action.reason);
      return;
    }
    if (!writePty(pkg.sessionId, sup.nudgeText(pkg.id), { paste: true })) {
      stall(id, 'noTab');
      return;
    }
    patch(id, { nudges: pkg.nudges + 1 });
    commit();
  }

  /**
   * The verify queue's hooks (verifyQueue.js) for the board: 'queued' reads
   * "waiting to verify", 'running' the usual verifying. Ignored once the run
   * or the package moved on.
   */
  function verifyHooks(planId, id) {
    const set = (phase) => {
      const p = plan && plan.id === planId ? findPkg(id) : null;
      if (!p || p.state !== 'finishing' || p.verifyPhase === phase) return;
      patch(id, { verifyPhase: phase });
      commit();
    };
    return {
      // Only when something is ahead: an empty queue starts at once.
      onQueued: (info) => {
        recover.stepWaiting(id);
        if ((info && info.ahead > 0) || batteryHeld()) set('queued');
      },
      // Low on battery a new verify waits for the charger (verifyQueue.js).
      whenAllowed: () => {
        recover.stepWaiting(id);
        return battery ? battery.whenAllowed() : Promise.resolve();
      },
      onStart: () => {
        recover.stepProgress(id);
        set('running');
      },
      onRerun: () => recover.stepProgress(id),
      // The playbook's longer re-run of a timed-out verify (orchestraRecover.js).
      limitMs: (findPkg(id) || {}).verifyLimitMs || undefined,
      timeoutReruns: (findPkg(id) || {}).verifyReruns,
      // A killed or discarded run's verify is skipped once its turn comes.
      isCancelled: () => !plan || plan.id !== planId || plan.killed === true,
    };
  }

  /**
   * One push-protection fix-up round: `text` goes to the worker's open tab,
   * or into a fresh brief in a reopened tab in its worktree.
   * @returns {boolean} false when neither worked
   */
  function sendFixup(pkg, text, fields) {
    if (plan.killed) return false;
    if (sessionAlive(pkg.sessionId) && writePty(pkg.sessionId, text, { paste: true })) {
      patch(pkg.id, { ...fields, state: 'launched', nudges: 0 });
      return true;
    }
    if (!pkg.root || !pkg.branch) return false;
    const brief = `${resumeBrief(pkg)}\n## LunaCore fix-up round\n\n${text}\n`;
    if (!reopenInWorktree(pkg, brief).ok) return false;
    patch(pkg.id, fields);
    return true;
  }

  /** The pre-push scan found secret shapes: one fix-up round (file:line, never the value). */
  function onSecretsFound(id, res) {
    const pkg = findPkg(id);
    const detail = pushSecrets.hitsSummary(res.hits);
    const stallHistory = sup.withHistoryEntry(pkg.stallHistory, { at: now(), kind: 'fixup', reason: 'secretFound', detail });
    if (!sendFixup(pkg, pushSecrets.secretScanText(pkg.id, res.hits, res.range), { scanFixup: true, stallHistory })) {
      stall(id, 'secretFound', detail);
      return;
    }
    onRunEvent('secretFixup', { id });
    commit();
  }

  /**
   * GitHub rejected the push with GH013. Never pushed again unchanged: one
   * fix-up round (rewrite only the unpushed commits), then one more push; a
   * second rejection - or a HEAD the worker did not change - stops the package.
   */
  function onPushBlocked(id, res) {
    const pkg = findPkg(id);
    const detail = res.blocked === 'unchanged' && pkg.pushBlockDetail ? `${res.detail}\n${pkg.pushBlockDetail}` : res.detail;
    const capped = String(detail || '').slice(0, pushSecrets.MAX_DETAIL_CHARS) || null;
    if (res.blocked === 'unchanged' || pkg.pushFixup) {
      stall(id, 'pushBlocked', capped);
      return;
    }
    const firstRule = String(res.detail || '').split('\n').find((l) => /GH013|secret|rule/i.test(l)) || res.detail;
    const stallHistory = sup.withHistoryEntry(pkg.stallHistory, { at: now(), kind: 'fixup', reason: 'pushBlocked', detail: firstRule });
    const fields = { pushFixup: true, pushBlockedSha: res.headSha || null, pushBlockDetail: capped, stallHistory };
    if (!sendFixup(pkg, pushSecrets.pushBlockText(pkg.id, res.detail, res.range, res.blocked), fields)) {
      stall(id, 'pushBlocked', capped);
      return;
    }
    onRunEvent('pushFixup', { id });
    commit();
  }

  async function finish(id) {
    cancelNudge(id);
    hybridRun.forget(id);
    // The worker got going on its own: a self-heal still under way is not needed.
    healer.cancel(id);
    // The post-DONE verify runs a plain `npm test` in the worktree: not
    // without its dependencies. The package waits for Resume, unstalled.
    if (!depsReady(findPkg(id))) {
      patch(id, { awaitingDeps: true });
      commit();
      return;
    }
    if (findPkg(id).awaitingDeps) patch(id, { awaitingDeps: false });
    // A package finishing after the run settled (Mati unblocked it by hand)
    // reopens the run, so its end gets its own cue.
    plan.settled = false;
    patch(id, { state: 'finishing', error: null, detail: null, verifyPhase: null });
    commit();
    let res;
    try {
      const before = findPkg(id);
      const needsVerify = typeof before.verify === 'string' && before.verify.trim().length > 0;
      // Under the wake watchdog: a step that never settles is aborted (stepHung).
      // Track the acquired slot outside guardStep so an early abort releases it
      // immediately instead of permanently leaking the semaphore slot.
      let activeSlot = null;
      try {
        res = await recover.guardStep(id, async (step) => {
          const hooks = verifyHooks(plan.id, id);
          const cancelled = () => step.isAborted() || hooks.isCancelled();
          const runFinish = () =>
            finishPackage(
              {
                ...before,
                pushOnVerifyFail: plan.freeMode === true,
                // Once per package: after its fix-up round, GitHub's own check decides.
                scanSecrets: !before.scanFixup && !before.pushFixup,
                // An A/B variant is verified, never pushed: only the critic's pick is.
                ...(before.abOf ? { skipPush: true } : {}),
              },
              { ...hooks, isCancelled: cancelled },
            );
          if (!needsVerify) return runFinish();
          const slot = await verifySemaphore.acquire({
            onQueued: (info) => hooks.onQueued(info),
            onStart: (info) => {
              if (info && info.waited) hooks.onStart(info);
            },
            isCancelled: cancelled,
          });
          if (!slot.acquired) {
            return { ok: false, stage: 'verifyCancelled', detail: 'the run was stopped before this verify started' };
          }
          activeSlot = slot;
          try {
            if (cancelled()) {
              return { ok: false, stage: 'verifyCancelled', detail: 'the run was stopped before this verify started' };
            }
            return await runFinish();
          } finally {
            slot.release();
            if (activeSlot === slot) activeSlot = null;
          }
        });
      } finally {
        if (activeSlot) {
          activeSlot.release();
          activeSlot = null;
        }
      }
    } catch (err) {
      res = { ok: false, stage: 'push', detail: err instanceof Error ? err.message : 'finish failed' };
    }
    const pkg = findPkg(id);
    if (!plan || !pkg) return;
    // The playbook's verify overrides are spent by this run.
    patch(id, { verifyPhase: null, verifyLimitMs: null, verifyReruns: undefined, verifiedSha: null });
    // A known environment cause gets its automatic fix (orchestraRecover.js).
    if (!plan.killed && recover.onFinish(findPkg(id), res)) {
      commit();
      return;
    }

    if (res.stage === 'secrets') {
      onSecretsFound(id, res);
      return;
    }
    if (res.stage === 'push' && res.blocked) {
      onPushBlocked(id, res);
      return;
    }
    // A verify that ran past its limit twice is no test failure: it is never
    // pasted to the worker as one.
    if (res.stage === 'verifyTimeout') {
      stall(id, 'verifyTimeout', res.detail || null);
      return;
    }
    // Killed while waiting for its verify: stopped like a running worker is.
    if (res.stage === 'verifyCancelled') {
      patch(id, { state: 'killed' });
      commit();
      return;
    }
    if (res.ok) {
      const touched = sup.mergeTouched(pkg.touched, sup.relTouched(pkg.root, res.files || []));
      patch(id, { headSha: res.headSha || null, error: null, detail: null, touched, terminal: false });
      // A/B variant: parked until its twin is done, then the critic decides (orchestraVariantRun.js).
      if (variantRun.onBuilt(id, res)) {
        commit();
        return;
      }
      // F6c gate: a hybrid free package is reviewed by Claude before it counts as pushed.
      if (hybridRun.gate(id)) {
        commit();
        return;
      }
      landPushed(id);
      return;
    }
    // The plan-run finish guard says why itself: outsidePlanFolder / noSources / badPlanRun.
    if (res.stage === 'planGuard') {
      stall(id, res.reason || 'planGuardFailed', res.detail || null);
      return;
    }
    if (res.stage !== 'verify') {
      stall(id, `${res.stage}Failed`, res.detail || null);
      return;
    }
    const lastLine = String(res.output || '').trim().split(/\r?\n/).pop() || '';
    if (plan.killed || sup.verifyFailAction(pkg) === 'stall' || !sessionAlive(pkg.sessionId)) {
      patch(id, { verifyTail: outputTail(res.output) });
      stall(id, 'verifyFailed', lastLine.slice(0, 300));
      return;
    }
    patch(id, { state: 'launched', verifyRounds: pkg.verifyRounds + 1, nudges: 0 });
    writePty(pkg.sessionId, sup.verifyFailText(pkg.id, pkg.verify, res.output), { paste: true });
    commit();
  }

  /** A verified, pushed package lands: to-dos ticked, dependants may launch. */
  function landPushed(id) {
    const pkg = findPkg(id);
    if (!pkg || pkg.state === 'pushed') return;
    patch(id, { state: 'pushed', terminal: false });
    // The package is finished: its brief goes. Every later reopen writes a fresh one.
    dropBrief(pkg);
    // A plan doc: copied next to the report; PLAN.md's tasks sized (one split round).
    if (pkg.planRun && onPlanDocPushed(id)) {
      commit();
      return;
    }
    tickTodos(plan.projectId, pkg.todoAts);
    commit();
    kick();
  }

  /** The playbook runs a package's finish again (verify / push), with its overrides. */
  function refinish(id, extra = {}) {
    if (!plan || !findPkg(id)) return;
    if (plan.killed) {
      patch(id, { state: 'killed' });
      commit();
      return;
    }
    patch(id, { verifiedSha: null, verifyLimitMs: null, verifyReruns: undefined, ...extra });
    background(finish(id), 'finish');
  }

  /** The playbook's install fixed the held node_modules: Resume on its own. */
  function resumeHeldRun(tries = 0) {
    if (!plan || !plan.hold) return;
    resumeRun({ planId: plan.id }).then((r) => {
      if (r.ok) return;
      if (r.error === 'busy' && tries < 3) setTimer(() => resumeHeldRun(tries + 1), NUDGE_DELAY_MS);
      else log(`[recover] automatic resume refused: ${r.error}`);
    }, noop);
  }

  /**
   * A worker tab finished a turn. Running -> act on the marker. A stalled
   * package whose tab is still open finishes too if it now says LUNA_DONE:
   * Mati answered its prompt by hand and it carried on.
   * @param {string} sessionId
   * @param {string} fragment transcript text of the turn
   */
  function onTurnEnd(sessionId, fragment) {
    if (fixup.onTurnEnd(sessionId, fragment)) return;
    const pkg = bySession(sessionId);
    if (!pkg || plan.killed) return;
    // Evidence for the report's "What went wrong": what the worker said last.
    const lastWords = lastWordsFrom(fragment);
    const handback = handbackFrom(fragment);
    if (lastWords || handback) {
      patch(pkg.id, { ...(lastWords ? { lastWords } : {}), ...(handback ? { handback } : {}) });
    }
    // LUNA_DONE already came; the verify waits for Resume.
    if (pkg.awaitingDeps) {
      commit();
      return;
    }
    const marker = sup.markerFrom(fragment, pkg.id);
    const background = trackBackground(sessionId, fragment);
    if (pkg.state === 'stalled') {
      // Paused for shutdown: no verify / push now; the resume asks again.
      if (marker && marker.kind === 'done' && !plan.interrupted) finish(pkg.id);
      return;
    }
    if (pkg.state !== 'launched') return;
    const action = sup.turnEndAction(pkg, marker);
    if (action.type === 'finish') finish(pkg.id);
    else if (action.type === 'stall' && action.reason === 'blocked') stall(pkg.id, action.reason, action.detail || null);
    else if (!isPackagePaused(pkg) && !hybridRun.isWaiting(pkg)) {
      cancelNudge(pkg.id);
      if (background.length) {
        // The turn ended on a background process of the worker's own (a test
        // run): its report back starts the next turn. No nudge is spent;
        // after BACKGROUND_WAIT_MS the process is given up on and the usual
        // nudge follows.
        onRunEvent('waitingOnBackground', { id: pkg.id, tasks: background.length });
        const armedAt = now();
        nudgeTimers.set(pkg.id, setTimer(() => giveUpOnBackground(pkg.id, sessionId, armedAt), BACKGROUND_WAIT_MS));
        return;
      }
      // No marker: nudge or noMarker stall, decided after the delay.
      nudgeTimers.set(pkg.id, setTimer(() => sendNudge(pkg.id), NUDGE_DELAY_MS));
    }
  }

  /**
   * The PC slept (orchestraSleep.js): the active packages get the slept
   * time back on pausedMs, the run logs it. Never credits the part an open
   * usage-limit pause covers - resume() credits that pause whole.
   * @param {null|{start:number, durationMs:number, source:string}} sleep
   */
  function applySleep(sleep) {
    if (!sleep || !plan) return false;
    recover.onWake();
    const t = now();
    const pauses = pauseRules.pausesOf(plan);
    for (const p of plan.packages.filter(sup.isActive)) {
      // Up to the start of the pauses holding this package; theirs is credited at their resume.
      const credit = sleepCredit(sleep, p, { now: t, pauseStartedAt: pauseRules.heldSince(pauses, p, matchesPauseScope) });
      if (credit > 0) patch(p.id, { pausedMs: (p.pausedMs || 0) + credit });
    }
    // Only a sleep during the run is the run's (a later report counts them).
    if (plan.runStartedAt && (plan.packages.some(sup.isActive) || finalizer.isRunning())) {
      plan.sleeps = recordSleep(plan.sleeps, sleep);
    }
    onRunEvent('slept', { start: sleep.start, durationMs: sleep.durationMs, source: sleep.source });
    commit();
    return true;
  }

  /** A sleep the watchdog gap reveals, credited before anything reads the clock. */
  const catchUpSleep = () => applySleep(sleepWatch.onTick());

  /** electron powerMonitor 'suspend'. */
  function onSystemSuspend() {
    sleepWatch.onSuspend();
  }

  /** The session's still-running background processes after this fragment. */
  function trackBackground(sessionId, fragment) {
    const open = sup.openBackgroundTasks(fragment, backgroundOpen.get(sessionId) || []);
    if (open.length) backgroundOpen.set(sessionId, open);
    else backgroundOpen.delete(sessionId);
    return open;
  }

  /**
   * The bounded wait ran out: forget the process (it never reported) and
   * nudge - unless the worker got busy again meanwhile (its git status
   * changed): then a new turn is under way and its end decides.
   */
  function giveUpOnBackground(id, sessionId, armedAt) {
    nudgeTimers.delete(id);
    backgroundOpen.delete(sessionId);
    if ((lastActivity.get(sessionId) || 0) > armedAt) return;
    sendNudge(id);
  }

  /** Drops what LunaCore tracked about one worker tab's turns. */
  function forgetSession(sessionId) {
    if (!sessionId) return;
    backgroundOpen.delete(sessionId);
    lastActivity.delete(sessionId);
    contextGuard.forget(sessionId);
  }

  /** Held by an open pause: the whole-run one, or its own backend's (orchestraPauses.js). */
  function isPackagePaused(pkg) {
    return Boolean(plan && pkg && pauseRules.holdingKeys(pauseRules.pausesOf(plan), pkg, matchesPauseScope).length);
  }

  /** Whether the package runs on the backend a pause key names ('all' / null: every package). */
  function matchesPauseScope(pkg, scope) {
    if (!scope || scope === pauseRules.ALL) return true;
    if (scope === 'claude') return packageRunsClaude(pkg);
    if (scope === 'agy') return !plan.planRun && agyRules.packageRunsAgy(plan, pkg);
    if (scope === 'free') return !plan.planRun && (plan.freeMode === true || hybridRules.runsFree(plan, pkg) || isHybridFreePackage(pkg));
    return true;
  }

  function cancelScopedNudges(scope) {
    for (const id of [...nudgeTimers.keys()]) {
      const p = findPkg(id);
      if (!p || matchesPauseScope(p, scope)) cancelNudge(id);
    }
  }

  function clearResumeTimers() {
    for (const t of resumeTimers.values()) clearTimer(t);
    resumeTimers.clear();
  }

  /** (Re-)arms the resume of one pause key at its reset plus grace. */
  function armResume(key, until) {
    if (resumeTimers.has(key)) clearTimer(resumeTimers.get(key));
    resumeTimers.set(key, setTimer(() => resume(key), until - now() + RESUME_GRACE_MS));
  }

  /**
   * One pause ends at its reset. Its packages get the paused span back on
   * pausedMs (minus any part another open pause still covers) and, once no
   * other pause holds them, RESUME_TEXT. Every other backend is untouched.
   * @param {string} key 'all' | 'claude' | 'agy' | 'free'
   */
  function resume(key) {
    resumeTimers.delete(key);
    if (!plan || !pauseRules.pausesOf(plan)[key]) return;
    // A resume timer that fired on the wake, before 'resume' / the tick: the
    // sleep is credited first, while the pause is still open.
    catchUpSleep();
    const t = now();
    const pauses = pauseRules.pausesOf(plan);
    const ended = pauses[key];
    const rest = pauseRules.withoutPause(pauses, key);
    for (const p of plan.packages.filter(sup.isActive)) {
      if (!matchesPauseScope(p, key)) continue;
      const stillHeld = pauseRules.holdingKeys(rest, p, matchesPauseScope).map((k) => rest[k].startedAt);
      const credit = pauseRules.resumeCredit(ended, stillHeld, p.startedAt, t);
      if (credit > 0) patch(p.id, { pausedMs: (p.pausedMs || 0) + credit });
      // Another backend's or the whole-run pause still holds it: it resumes with that one.
      if (stillHeld.length) continue;
      // A free package waiting on its own free limits resumes at its own reset.
      if (p.state === 'launched' && !hybridRun.isWaiting(p)) writePty(p.sessionId, sup.RESUME_TEXT, { paste: true });
    }
    Object.assign(plan, pauseRules.withRunPauses(plan, rest, t));
    onRunEvent('resumed', { scope: key });
    commit();
    kick();
    background(powerFlow.refresh(), 'sleep');
  }

  /**
   * electron powerMonitor 'resume': timers may not have counted the sleep.
   * The slept time is credited to the workers first. An integrate step in
   * flight is treated as interrupted (its children may be gone, its promise
   * may never settle): aborted, and finalize runs once more.
   * Each pause past its reset resumes now; one before it re-arms its timer.
   */
  function onSystemResume() {
    applySleep(sleepWatch.onResume());
    recover.onWake();
    interruptFinalize();
    resumeGate.onResume();
    // The resume-after-shutdown countdown is wall-clock: a sleep may have eaten it.
    shutdownResume.onWake();
    background(powerFlow.onSystemResume(), 'sleep');
    if (!plan) return;
    const pauses = Object.entries(pauseRules.pausesOf(plan)).sort((a, b) => a[1].until - b[1].until);
    for (const [key, entry] of pauses) {
      if (now() >= entry.until) {
        if (resumeTimers.has(key)) clearTimer(resumeTimers.get(key));
        resume(key);
      } else armResume(key, entry.until);
    }
  }

  /** After a wake an integrate step in flight is aborted and run again (logged as a fix). */
  function interruptFinalize() {
    if (!finalizer.interrupt()) return;
    onRunEvent('finalizeInterrupted');
    if (plan) {
      const detail = 'finalize step in flight at a wake: aborted and run again';
      plan.recoveries = sup.withHistoryEntry(plan.recoveries, { at: now(), kind: 'recover', reason: 'stepHung', detail });
    }
  }

  /**
   * The usage limit hit a worker and its tab could not move to another
   * account: the packages on that worker's backend wait until its reset
   * (a plan run's whole run waits). Other backends keep going.
   * @param {string} sessionId
   * @param {number|null} resetsAt epoch ms, when the CLI said
   */
  function onUsageLimit(sessionId, resetsAt) {
    const pkg = bySession(sessionId);
    if (!pkg || !sup.isActive(pkg) || plan.killed) return;
    // Q9: a hybrid free package waits alone; Claude packages keep going.
    if (hybridRun.onUsageLimit(pkg, resetsAt)) return;
    // A plan run's workers belong to no single backend pause: the whole run waits.
    const scope = plan.planRun
      ? null
      : agyRules.packageRunsAgy(plan, pkg)
        ? 'agy'
        : plan.freeMode || isHybridFreePackage(pkg)
          ? 'free'
          : 'claude';
    const until = Number.isFinite(resetsAt) && resetsAt > now() ? resetsAt : now() + DEFAULT_PAUSE_MS;
    // The same backend already waits at least that long: another worker's report of the same limit.
    const open = pauseRules.pausesOf(plan)[pauseRules.keyOf(scope)];
    if (open && open.until >= until) return;
    // Every new limit is logged (plan.recoveries); a Claude one may move to another stored account first.
    if (recover.onUsageLimit(pkg, until) === 'failover' && scope !== 'agy' && scope !== 'free') return;
    pauseUntil(until, scope);
  }

  /**
   * Multi God Mode A3: every Claude account is out, so the registry pauses
   * runs that have live Claude workers until the earliest reset - never pure
   * agy or free runs.
   * @param {number|null} resetsAt epoch ms
   * @returns {boolean} the run is paused now
   */
  function pauseExternal(resetsAt) {
    if (!plan || !plan.started || plan.killed) return false;
    if (!plan.packages.some((p) => sup.isActive(p) && packageRunsClaude(p))) return false;
    pauseUntil(resetsAt, 'claude');
    return true;
  }

  /**
   * Pauses one backend's packages (scope 'claude' | 'agy' | 'free') or the
   * whole run (null) until `resetsAt` (+ grace). Each backend keeps its own
   * reset and timer; a longer pause of the same backend already set wins.
   */
  function pauseUntil(resetsAt, scope = null) {
    const until = Number.isFinite(resetsAt) && resetsAt > now() ? resetsAt : now() + DEFAULT_PAUSE_MS;
    const key = pauseRules.keyOf(scope);
    const next = pauseRules.withPause(pauseRules.pausesOf(plan), key, until, now());
    if (!next.changed) return;
    cancelScopedNudges(key);
    Object.assign(plan, pauseRules.withRunPauses(plan, next.pauses, now()));
    armResume(key, until);
    onRunEvent('paused', { until, scope: key });
    // A pool run moves its not-started packages off the paused backend now
    // and launches them where they went (src/orchestraRescue.js limitMoves).
    const moved = rescue.moveOffLimits();
    commit();
    if (moved.length) kick();
    background(powerFlow.onPaused(), 'sleep');
  }

  /**
   * A worker sits on a permission prompt - it needs Mati, the rest go on.
   * The tool it asked about is logged (idea #5) as an allow-rule suggestion.
   * @param {string} sessionId
   * @param {string|null} [rule] e.g. `Bash(npx tsc:*)`, from the transcript
   */
  function onApproval(sessionId, rule = null, example = null) {
    const pkg = bySession(sessionId);
    if (!pkg || pkg.state !== 'launched' || plan.killed) return;
    const entry = { pkgId: pkg.id, rule: sup.isAllowRule(rule) ? rule : null, example: sup.cleanExample(example) };
    plan.approvalLog = [...(plan.approvalLog || []), entry].slice(-sup.MAX_APPROVAL_LOG);
    stall(pkg.id, 'needsApproval', entry.rule);
  }

  /**
   * Free God Mode v2 F3: which model really answered a free worker
   * (src/fallbackproxy.js onRoute). A free run with live workers writes a
   * line to its run log each time that changes, and every refused
   * substitution, so the report shows who actually wrote the code.
   * @param {{chainId:string, model:string, routedVia:string|null, substituted:boolean}} info
   */
  function onFreeRoute(info) {
    if (!plan || !plan.freeMode || !plan.started || plan.killed || plan.settled) return;
    if (!info || typeof info.model !== 'string' || !plan.packages.some(sup.isActive)) return;
    const real = info.routedVia || info.model;
    const key = `${info.chainId}|${info.model}|${real}`;
    if (!info.substituted && key === lastFreeRoute) return;
    if (!info.substituted) lastFreeRoute = key;
    const detail = info.substituted
      ? `${info.chainId}: ${info.model} was answered by ${real} - refused, next model tried`
      : `${info.chainId}: ${info.model} answered by ${real}`;
    plan.recoveries = sup.withHistoryEntry(plan.recoveries, {
      at: now(), kind: 'free', reason: info.substituted ? 'freeSubstituted' : 'freeModel', detail,
    });
    commit();
  }

  /** True when the tab is one of this run's workers (cheap pre-check for main). */
  function ownsSession(sessionId) {
    return !!bySession(sessionId);
  }

  /**
   * A tab's transcript token totals per model (src/observer.js). Booked only
   * for this run's own tabs - a package worker or the fix-up worker; any other
   * tab is ignored. Bookkeeping only: no commit, no board repaint.
   * @param {string} sessionId
   * @param {unknown} byModel {<model>: {input, output, cacheRead, cacheWrite}}
   * @returns {boolean} true when the tab was this run's
   */
  /**
   * A worker tab's transcript totals; `context` ({tokens, limit}: how full
   * its context is now) feeds the context guard when the plan has it on.
   */
  function onSessionUsage(sessionId, byModel, context = null) {
    if (!plan || !(bySession(sessionId) || fixup.owns(sessionId))) return false;
    if (byModel) usageBook.setSession(sessionId, byModel);
    if (context) contextGuard.onSample(sessionId, context);
    return true;
  }

  /**
   * Idea #7: a worker's git status changed. Its files are kept relative to
   * its worktree; a NEW pair of workers sharing a file is announced once.
   * @param {string} sessionId
   * @param {string[]} absFiles
   */
  function onFiles(sessionId, absFiles) {
    const pkg = bySession(sessionId);
    if (!pkg || !pkg.root || !sup.isActive(pkg)) return;
    // Activity: a background wait that runs out does not nudge a busy worker.
    lastActivity.set(sessionId, now());
    const touched = sup.mergeTouched(pkg.touched, sup.relTouched(pkg.root, absFiles));
    if (touched === pkg.touched) return;
    const key = (o) => `${o.a}|${o.b}`;
    const before = new Set(sup.liveOverlaps(plan.packages).map(key));
    patch(pkg.id, { touched });
    for (const o of sup.liveOverlaps(plan.packages)) {
      if (!before.has(key(o))) onRunEvent('overlap', o);
    }
    if (plan.ownership) guardOwnership(findPkg(pkg.id));
    commit();
  }

  /**
   * LW 2.12: a worker that changed a file another package owns is told to
   * revert it at once - before the owner's worker touches the same file -
   * and the board gets an 'ownership' event. Only with a plan.ownership map.
   */
  function guardOwnership(pkg) {
    const fresh = sup
      .ownershipViolations(pkg, pkg.touched, plan.ownership, plan.packages)
      .filter((v) => !ownershipNudged.has(`${pkg.id}|${v.file}`));
    if (!fresh.length || pkg.state !== 'launched' || isPackagePaused(pkg) || plan.killed) return;
    for (const v of fresh) ownershipNudged.add(`${pkg.id}|${v.file}`);
    const sent = writePty(pkg.sessionId, sup.ownershipText(pkg.id, fresh), { paste: true });
    onRunEvent('ownership', { id: pkg.id, files: fresh, nudged: sent === true });
  }

  /**
   * "Finish run" by hand (a killed run, or one Mati wants to wrap up with a
   * stalled package left): integrate, clean up, report. Optional mode
   * override from the board's selector.
   * @param {unknown} payload {planId, integration?}
   */
  async function finishRun(payload) {
    const o = payload && typeof payload === 'object' ? payload : {};
    if (!plan || o.planId !== plan.id) return { ok: false, error: 'noPlan' };
    if (isBusy()) return { ok: false, error: 'busy' };
    if (plan.packages.some(sup.isActive)) return { ok: false, error: 'runActive' };
    if (!plan.packages.some((p) => p.state !== 'pending')) return { ok: false, error: 'nothingToLaunch' };
    const planAtFinish = plan;
    let nextIntegration = plan.integrationMode;
    if (sup.INTEGRATION_MODES.includes(o.integration) && integrationFor(plan, o.integration) !== plan.integrationMode) {
      if (o.integration === 'merge' && !(await confirmMerge())) return { ok: false, error: 'mergeDeclined' };
      if (plan !== planAtFinish || isBusy() || plan.packages.some(sup.isActive)) return { ok: false, error: 'busy' };
      nextIntegration = o.integration;
    }
    if (!plan.planRun && agyRules.runUsesAgy(plan)) {
      busy = true;
      try {
        await agyModelsReady([...plan.packages, {}]);
      } finally {
        busy = false;
      }
      if (plan !== planAtFinish || isBusy() || plan.packages.some(sup.isActive)) return { ok: false, error: 'busy' };
    }
    plan.integrationMode = nextIntegration;
    freezeSettings();
    clearSchedule();
    plan.scheduledAt = null;
    await finalizer.finalize();
    return { ok: true, plan: view() };
  }

  /**
   * "Abort finish": ends this run's integrate step when it has run past
   * ABORT_FINISH_AFTER_MS. Its process tree is killed, the pass settles as
   * failed ('abortedByUser') and reports; then the board is free and Retry
   * works again. Never trusts the payload beyond the plan id.
   * @param {unknown} payload {planId}
   */
  function abortFinalize(payload) {
    const o = payload && typeof payload === 'object' ? payload : {};
    if (!plan || o.planId !== plan.id) return { ok: false, error: 'noPlan' };
    if (!finalizer.isRunning()) return { ok: false, error: 'notFinishing' };
    const startedAt = plan.integration && plan.integration.startedAt;
    if (!Number.isFinite(startedAt) || now() - startedAt < ABORT_FINISH_AFTER_MS) return { ok: false, error: 'tooEarly' };
    if (!finalizer.abort('abortedByUser')) return { ok: false, error: 'notAbortable' };
    onRunEvent('finalizeAborted');
    return { ok: true };
  }

  /**
   * Called every minute or so: workers over their working time stall. A
   * sleep the tick gap reveals is credited first, so a wake never reads as
   * hours of work.
   */
  function tick() {
    // A sleep only the tick gap revealed ('resume' never came): same as a resume.
    if (catchUpSleep()) interruptFinalize();
    recover.tick();
    if (!plan || allPaused() || plan.killed) return;
    for (const p of plan.packages) {
      if (p.state === 'launched' && !p.awaitingDeps && !hybridRun.isWaiting(p) && !isPackagePaused(p) && sup.timedOut(p, now())) stall(p.id, 'timeout');
    }
    expireApprovals();
    // A pool package waiting for its kind's cap: another run's agy worker may
    // have finished meanwhile (this run hears nothing of it), so look again.
    if (kindHeld && plan.started && !pumping) kick();
  }

  /**
   * Unattended approvals: a worker that has sat on a permission prompt
   * longer than plan.options.unattendedApprovalMin loses its tab. Nothing is
   * ever approved or typed into the prompt; the rule it asked about stays in
   * approvalLog as an allow-rule suggestion for the morning.
   */
  function expireApprovals() {
    const limit = sup.normalizeOptions(plan.options).unattendedApprovalMin;
    if (!limit) return;
    let changed = false;
    for (const p of plan.packages) {
      if (isPackagePaused(p) || !sup.approvalExpired(p, now(), limit) || !p.sessionId || !sessionAlive(p.sessionId)) continue;
      const sid = p.sessionId;
      // detail keeps the logged rule (onApproval put it there).
      patch(p.id, { error: 'approvalTimeout' });
      markTerminal(p.id, 'approvalTimeout');
      closeSession(sid);
      changed = true;
    }
    if (!changed) return;
    commit();
    kick();
  }

  /**
   * Kill switch: no new workers, Esc to every running one, worktrees kept.
   * @returns {boolean} false when there was no run to stop
   */
  function kill() {
    if (!plan || !plan.started) return false;
    // A review waiting for the Claude limit stops with the run.
    const reviewsWaiting = hybridRun.cancelAll();
    clearAllTimers();
    plan.scheduledAt = null;
    plan.killed = true;
    // A run paused for shutdown and then killed is no longer resumable.
    shutdownResume.drop();
    // A running fix-up worker stops with the run: its tab closes, the base stays unpushed.
    fixup.abort();
    // Every pause ends; a kill during a usage-limit pause still counts the pause so far.
    Object.assign(plan, pauseRules.withRunPauses(plan, {}, now()));
    for (const p of plan.packages.filter((x) => x.state === 'launched')) {
      writePty(p.sessionId, ESC);
      patch(p.id, { state: 'killed' });
    }
    for (const id of reviewsWaiting) {
      if ((findPkg(id) || {}).state === 'finishing') patch(id, { state: 'killed' });
    }
    // Parked A/B variants stop with the run; their verified build is kept for the decision.
    variantRun.onKill();
    // Waiting on a playbook backoff: stopped too, its timer dropped.
    for (const p of plan.packages.filter((x) => recover.pending(x.id))) {
      recover.cancel(p.id);
      patch(p.id, { state: 'killed' });
    }
    settledFinalize = false;
    // A kill ends the hold too: Retry checks node_modules again.
    releaseHold();
    // Shared flow: another run may still be paused and allow the sleep, or
    // have settled and asked for the shutdown already counting down.
    background(powerFlow.refresh(), 'sleep');
    background(powerFlow.refreshShutdown(), 'shutdown');
    onRunEvent('killed');
    commit();
    return true;
  }

  /**
   * Picks a stalled / closed / killed / failed package back up: opens a new
   * tab in its existing worktree (closing a still-open one, whose intake
   * token was revoked when it settled), or (never got a worktree) nudges a
   * still-open tab or queues it for a fresh launch.
   * @param {unknown} payload {planId, id}
   */
  async function retry(payload) {
    const o = payload && typeof payload === 'object' ? payload : {};
    if (!plan || o.planId !== plan.id) return { ok: false, error: 'noPlan' };
    const isRetryablePkg = (p) =>
      !!p &&
      (sup.RETRYABLE_STATES.has(p.state) || p.state === 'failed') &&
      p.splitting !== true &&
      !(Array.isArray(p.splitInto) && p.splitInto.length);
    const pkg = typeof o.id === 'string' ? findPkg(o.id) : null;
    if (!isRetryablePkg(pkg)) return { ok: false, error: 'notRetryable' };
    // A/B (orchestraVariants.js): an undecided group has no worker of its own,
    // and a built variant keeps its build - it parks again, no new worker.
    const abAction = variantRules.retryAction(pkg, plan.packages);
    if (abAction && abAction.refuse) return { ok: false, error: abAction.refuse };
    if (isBusy()) return { ok: false, error: 'busy' };
    if (isPackagePaused(pkg)) return { ok: false, error: 'paused' };
    if (plan.hold) return { ok: false, error: plan.hold.reason };
    // A settled package's tab lost its scoped intake token (commit ->
    // revokeFollowups) and a running claude cannot pick up a new one, so a
    // still-open tab is replaced by a new one in the same worktree (a fresh
    // token, like an automatic restart). Nudging is left for a live tab whose
    // package has no worktree on record, which reopenInWorktree cannot use.
    const liveTab = !!(pkg.sessionId && sessionAlive(pkg.sessionId));
    const nudgeOnly = liveTab && !(pkg.root && pkg.branch);
    if (!nudgeOnly && batteryHeld()) return { ok: false, error: 'batteryLow' };
    // A self-heal still under way is replaced by this Retry.
    healer.cancel(pkg.id);

    const planAtRetry = plan;
    const killedBefore = plan.killed;
    freezeSettings();
    if (abAction && abAction.keep) {
      // Parked again with its verified build; the pump decides the group once its twin is done.
      patch(pkg.id, { state: 'finishing', error: null, detail: null });
    } else if (nudgeOnly) {
      patch(pkg.id, { ...freshRun(), state: 'launched', ...spentAbBuild(pkg) });
      // A tab stalled on a permission prompt: Mati answers it there. Pasting
      // a nudge + Enter now would land IN the prompt and answer it blindly.
      if (pkg.error !== 'needsApproval') writePty(pkg.sessionId, sup.nudgeText(pkg.id), { paste: true });
    } else if (liveTab) {
      // The worker ran in this worktree until now, so its node_modules is as
      // it was: no install (one would also race the old tab's processes).
      // reopenInWorktree closes the old tab once the new one is open; a
      // failure leaves the old tab and the stall untouched.
      if (!plan.planRun && agyRules.packageRunsAgy(plan, pkg) && agyRules.packageAgyModel(plan, pkg) !== agyRules.AGY) {
        busy = true;
        try {
          await agyModelsReady([pkg]);
        } finally {
          busy = false;
        }
        const afterWarm = plan ? findPkg(pkg.id) : null;
        if (plan !== planAtRetry || (plan.killed && !killedBefore) || !isRetryablePkg(afterWarm) || isPackagePaused(afterWarm) || plan.hold) {
          if (plan) commit();
          return {
            ok: false,
            error: !plan || plan !== planAtRetry || (plan.killed && !killedBefore) || !isRetryablePkg(afterWarm)
              ? 'notRetryable'
              : isPackagePaused(afterWarm)
                ? 'paused'
                : plan.hold.reason,
          };
        }
      }
      const current = findPkg(pkg.id);
      const reopened = reopenInWorktree(current, resumeBrief(current));
      if (!reopened.ok) {
        if (reopened.error === 'noNodeModules') patch(pkg.id, { heldRetry: true });
        commit();
        return { ok: false, error: reopened.error };
      }
    } else if (pkg.root && pkg.branch) {
      // A new worker in the old worktree: install what is missing first
      // (an earlier install failed, or an older build never installed).
      const installed = await installForRetry(pkg);
      if (!installed.ok) return installed;
      const current = plan ? findPkg(pkg.id) : null;
      // The install / model warm can take minutes: a kill, pause, hold or state change that landed meanwhile wins.
      if (plan !== planAtRetry || (plan.killed && !killedBefore) || !isRetryablePkg(current) || isPackagePaused(current) || plan.hold) {
        if (plan) commit();
        return {
          ok: false,
          error: !plan || plan !== planAtRetry || (plan.killed && !killedBefore) || !isRetryablePkg(current)
            ? 'notRetryable'
            : isPackagePaused(current)
              ? 'paused'
              : plan.hold.reason,
        };
      }
      const reopened = reopenInWorktree(current, resumeBrief(current));
      if (!reopened.ok) {
        // Held for node_modules: Resume reopens it, no second Retry needed.
        if (reopened.error === 'noNodeModules') patch(pkg.id, { heldRetry: true });
        commit();
        return { ok: false, error: reopened.error };
      }
    } else {
      patch(pkg.id, { state: 'pending', error: null, detail: null });
    }
    // A Retry by hand: the package is back in play, its dependents unblocked.
    cancelAutoRetry(pkg.id);
    transientRetries.delete(pkg.id);
    // Fresh playbook attempts for every cause.
    recover.onManualRetry(pkg.id);
    // Mati may have fixed (or allowed) a GH013 by hand: the push gets a fresh
    // fix-up round and the rejected HEAD may be pushed again.
    patch(pkg.id, { terminal: false, autoRetries: 0, pushFixup: false, pushBlockedSha: null, pushBlockDetail: null });
    plan.packages = sup.withBlockedBy(plan.packages);
    // A Retry by hand takes over from the shutdown banner (the others stay stalled).
    shutdownResume.drop();
    // Only once the package is back in play does the run resume.
    plan.started = true;
    if (!plan.runStartedAt) plan.runStartedAt = now();
    plan.killed = false;
    plan.settled = false;
    settledFinalize = false;
    commit();
    await pump();
    return { ok: true, plan: view() };
  }

  /**
   * Retry's install in an existing worktree, holding `busy` so nothing else
   * acts on the run meanwhile. A failure stalls the package with the output.
   * @returns {Promise<{ok:true} | {ok:false, error:'installFailed'}>}
   */
  async function installForRetry(pkg) {
    busy = true;
    const planAtInstall = plan;
    let installed;
    try {
      // After a failed install a partial node_modules would make the
      // install a no-op: start from scratch.
      installed = await installDeps(pkg.root, { fresh: pkg.error === 'installFailed' });
      const current = plan && plan === planAtInstall ? findPkg(pkg.id) : null;
      if (installed.ok && current && !plan.planRun && agyRules.packageRunsAgy(plan, current) && agyRules.packageAgyModel(plan, current) !== agyRules.AGY) {
        await agyModelsReady([current]);
      }
    } finally {
      busy = false;
    }
    if (installed.ok) return { ok: true };
    if (!plan || plan !== planAtInstall) return { ok: false, error: 'installFailed' };
    patch(pkg.id, { ...installFailedFields(installed.output), terminal: true });
    plan.packages = sup.withBlockedBy(plan.packages);
    onRunEvent('stalled', { id: pkg.id, reason: 'installFailed' });
    commit();
    return { ok: false, error: 'installFailed' };
  }

  /**
   * Resume after a 'noNodeModules' hold: every folder the hold is about is
   * checked again; still broken -> stays held. Then the held work goes on:
   * held launches start their worker, deferred verifies run, held automatic
   * restarts happen, and the pump launches the rest.
   * @param {unknown} payload {planId}
   */
  async function resumeRun(payload) {
    const o = payload && typeof payload === 'object' ? payload : {};
    if (!plan || o.planId !== plan.id) return { ok: false, error: 'noPlan' };
    if (!plan.hold || plan.killed) return { ok: false, error: 'notHeld' };
    const initialWaiting = plan.packages.filter(isHeld);
    if (allPaused() || initialWaiting.some(isPackagePaused)) return { ok: false, error: 'paused' };
    if (isBusy()) return { ok: false, error: 'busy' };
    for (const dir of heldDirs()) {
      const res = checkDeps(dir);
      if (!res.ok) {
        plan.hold = { ...plan.hold, ...holdFields(res) };
        // Still broken: the watch keeps checking and resumes once it is fixed.
        holdWatch.arm();
        commit();
        return { ok: false, error: 'noNodeModules', plan: view() };
      }
    }
    const planAtResume = plan;
    // A held launch starts its worker below: an agy variant needs the live list first.
    busy = true;
    try {
      await agyModelsReady(initialWaiting);
    } finally {
      busy = false;
    }
    if (!plan || plan !== planAtResume) return { ok: false, error: 'noPlan' };
    if (!plan.hold || plan.killed) return { ok: false, error: 'notHeld' };
    const waiting = plan.packages.filter(isHeld);
    if (allPaused() || waiting.some(isPackagePaused)) return { ok: false, error: 'paused' };
    if (isBusy()) return { ok: false, error: 'busy' };
    plan.hold = null;
    holdWatch.cancel();
    onRunEvent('resumed', { reason: 'noNodeModules' });
    for (const p of waiting) resumeHeld(p.id);
    commit();
    for (const p of waiting) {
      const current = findPkg(p.id);
      if (current && current.awaitingDeps) background(finish(p.id), 'finish');
    }
    await pump();
    // A shutdown resume that waited on this hold goes on now.
    shutdownResume.poke();
    return { ok: true, plan: view() };
  }

  /** One package the hold kept waiting: a held launch or restart goes on now. */
  function resumeHeld(id) {
    const p = findPkg(id);
    if (p.heldLaunch) {
      const before = p;
      // The brief path is recomputed: a run saved by an older LunaCore kept it outside the worktree.
      const result = startWorker(p, { branch: p.branch, root: p.root, cwd: p.cwd, briefPath: briefPathFor(p.cwd, p.root), baseSha: p.baseSha, depMerge: p.depMerge || null });
      if (result.state === 'failed') {
        // The worktree stays recorded: the automatic relaunch clears it first.
        patch(id, { ...result, heldLaunch: false, failure: failureOf(result, null, now()) });
        onLaunchFailed(before, result);
      } else {
        patch(id, result);
      }
      return;
    }
    if (p.heldRetry) {
      patch(id, { heldRetry: false });
      const reopened = reopenInWorktree(findPkg(id), resumeBrief(p));
      if (reopened.ok) {
        patch(id, { terminal: false, autoRetries: 0 });
        plan.packages = sup.withBlockedBy(plan.packages);
      } else if (reopened.error === 'noNodeModules') {
        // Held again: the next Resume reopens it.
        patch(id, { heldRetry: true });
      } else {
        patch(id, { error: reopened.error, detail: null });
      }
      return;
    }
    if (p.heldResume) {
      const { reason, detail } = p.heldResume;
      patch(id, { heldResume: null });
      const pkg = findPkg(id);
      const restarted =
        (wantsEscalation(pkg, reason) && escalate(pkg, reason, detail)) ||
        (sup.shouldAutoResume(pkg, reason) && autoResume(pkg, reason, detail));
      // Held again: the next Resume restarts it; otherwise it has had its chance.
      if (!restarted && plan.hold) patch(id, { heldResume: { reason, detail } });
      else if (!restarted) markTerminal(id, reason);
    }
  }

  /** A closed tab leaves its worktree; the board says so and the slot frees. */
  function onSessionClosed(sessionId) {
    if (fixup.onSessionClosed(sessionId)) return true;
    const pkg = bySession(sessionId);
    if (!pkg) return false;
    cancelNudge(pkg.id);
    // A free wait (F6d) ends with its tab; Retry reopens it without one.
    hybridRun.forget(pkg.id);
    // A FINISHING package keeps finishing - verify and push need no tab, and
    // marking it closed would let Retry open a second writer in its worktree.
    patch(pkg.id, { sessionId: null, ...(pkg.state === 'launched' ? { state: 'closed' } : {}) });
    commit();
    kick();
    return true;
  }

  /**
   * Live run options (sleepOnLimit, shutdownWhenDone): only known boolean
   * keys are applied, anything else is dropped. Allowed before, during and
   * while paused.
   * @param {unknown} patchRaw
   */
  function setOptions(patchRaw) {
    if (!plan) return { ok: false, error: 'noPlan' };
    const changes = sup.optionsPatch(patchRaw);
    if (!Object.keys(changes).length) return { ok: false, error: 'badOptions' };
    plan.options = sup.normalizeOptions({ ...plan.options, ...changes });
    onRunEvent('options', { ...plan.options });
    commit();
    // F5 ticked after the run settled: the review starts now.
    if (changes.freeReview === true && !finalizer.isRunning()) freeReviewer.start();
    // Handback scanner ticked after the run settled: scan now and refresh the report if cards were filed.
    // Skip if a retried package is active (finalize will run the scan once it settles).
    if (
      changes.scanHandbacks === true &&
      !isBusy() &&
      !finalizer.isRunning() &&
      !plan.packages.some(sup.isActive) &&
      plan.integration &&
      (plan.integration.state === 'done' || plan.integration.state === 'failed') &&
      typeof deps.onHandbackScan === 'function'
    ) {
      const runId = plan.id;
      const reportText = finalizer.draftReport(runId);
      background(
        Promise.resolve()
          .then(() => deps.onHandbackScan(runId, reportText))
          .then((res) => {
            if (res && res.filed > 0) finalizer.refreshReport(runId);
          }),
        'handbackScan',
      );
    }
    background(powerFlow.onOptions(plan.options), 'options');
    return { ok: true, options: { ...plan.options } };
  }

  /**
   * The current run as a settled-run ledger entry when its merge landed
   * (orchestraCleanup.js), else null - the start-up cleanup sweep.
   */
  function landedRun() {
    const integ = plan && plan.integration;
    if (!integ || plan.integrationMode !== 'merge' || integ.state !== 'done' || !plan.baseBranch) return null;
    if (!Number.isFinite(integ.at) || !plan.packages.some((p) => p.merged === true)) return null;
    return { ...postMergeContext(plan, { skipped: integ.skipped }, slugOf(plan)), settledAt: integ.at };
  }

  /**
   * What "Release now" needs about the run on the board, or null without
   * one: its project and checkout, the base and the head its merge landed.
   */
  function releaseTarget() {
    if (!plan) return null;
    const integ = plan.integration || {};
    const done = integ.postMerge && integ.postMerge.release;
    return {
      planId: plan.id,
      projectId: plan.projectId,
      repoPath: plan.repoPath,
      base: plan.baseBranch,
      headSha: integ.headSha || null,
      landed: plan.integrationMode === 'merge' && integ.state === 'done' && !!integ.headSha,
      releaseAfter: sup.normalizeOptions(plan.options).releaseAfter === true,
      released: !!(done && done.released === true),
      busy: isBusy(),
    };
  }

  /**
   * This run's slice of the shared power view (orchestraPower.js
   * aggregatePowerRun): planning or finalizing counts as live, like a
   * started run that is neither killed nor settled. Null with no plan and
   * nothing going.
   */
  function powerState() {
    const working = isBusy();
    if (!plan) {
      return working
        ? { planId: null, live: true, settled: false, pausedUntil: null, killed: false, approvalsPending: false, options: sup.normalizeOptions(null) }
        : null;
    }
    return {
      planId: plan.id,
      live: working || (plan.started === true && !plan.killed && !plan.settled),
      settled: plan.settled === true,
      pausedUntil: effectivePausedUntil(),
      killed: plan.killed === true,
      approvalsPending: approvalsPending(),
      options: sup.normalizeOptions(plan.options),
    };
  }

  /** The tabs of this run's workers that are running right now (registry.pauseAll). */
  const workerSessions = () =>
    plan ? plan.packages.filter((p) => p.state === 'launched' && p.sessionId).map((p) => p.sessionId) : [];

  /**
   * F4a: "Approve plan" merged the plan and imported its tasks (main,
   * orchestraPlanApprove.js); the board shows the outcome. Plan runs only.
   * @param {string} planId
   * @param {{created:number, skipped:number}} result
   */
  function notePlanApproved(planId, result) {
    if (!plan || plan.id !== planId || !plan.planRun) return false;
    const n = (v) => (Number.isInteger(v) && v >= 0 ? v : 0);
    plan.planRun = { ...plan.planRun, approved: { at: now(), created: n(result && result.created), skipped: n(result && result.skipped) } };
    commit();
    return true;
  }

  function discard() {
    if (isBusy()) return { ok: false, error: 'busy' };
    if (plan && plan.packages.some(sup.isActive)) return { ok: false, error: 'runActive' };
    clearAllTimers();
    if (plan && deps.revokeRunFollowups) revokeQuietly(() => deps.revokeRunFollowups(plan.id));
    // A worktree kept after the run (stalled, killed, closed) loses its brief with the run.
    if (plan) for (const p of plan.packages) dropBrief(p);
    plan = null;
    commit();
    return { ok: true };
  }

  return {
    restore,
    makePlan,
    launch,
    view,
    discard,
    retry,
    resumeRun,
    resumeInterrupted,
    cancelResume,
    pauseForShutdown,
    kill,
    tick,
    onTurnEnd,
    onUsageLimit,
    onFreeRoute,
    pauseExternal,
    powerState,
    workerSessions,
    onApproval,
    onFiles,
    ownsSession,
    onSessionUsage,
    onSessionClosed,
    followupsFiled,
    noteFollowups,
    unschedule,
    finishRun,
    setOptions,
    onSystemSuspend,
    onSystemResume,
    abortFinalize,
    cancelSleep: () => powerFlow.cancelSleep(),
    cancelShutdown: () => powerFlow.cancelShutdown(),
    checkWake: () => powerFlow.checkWake(),
    sweepBranches,
    landedRun,
    // The run email after finalize: "Resend report email" and pending sends (godmodePending.js).
    emailSummary: (planId) => finalizer.emailSummary(planId),
    emailResult: (planId, res) => finalizer.emailResult(planId, res),
    // "Release now" on the finished run (src/orchestraFinishIpc.js).
    releaseTarget,
    recordRelease: (planId, result) => finalizer.recordPostMerge(planId, 'release', result),
    runFixup: (args) => fixup.run(args),
    makePlanRun,
    notePlanApproved,
    planWait: () => planWaiter.view(),
    cancelPlanWait: () => planWaiter.cancel(),
    isBusy,
    isRunning: () => !!plan && plan.started && !plan.killed && plan.packages.some(sup.isActive),
    // Multi God Mode: this run's agy workers, for the other runs' agy cap.
    activeAgyWorkers,
    verifyStats: () => verifySemaphore.stats(),
    // Multi God Mode's same-repo guard (orchestraRegistry.repoBusy).
    repoPath: () => (plan ? plan.repoPath : null),
    planningRepo: () => planningRepo,
  };
}

module.exports = {
  createOrchestra,
  briefText,
  withStallNote,
  BRIEF_DIR,
  NUDGE_DELAY_MS,
  BACKGROUND_WAIT_MS,
  RESUME_GRACE_MS,
  AUTO_RETRY_DELAY_MS,
  MAX_AUTO_RETRIES: sup.MAX_AUTO_RETRIES,
  DEFAULT_VERIFY_CONCURRENCY,
};
