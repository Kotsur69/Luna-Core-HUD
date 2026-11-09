// ============================================================================
// LunaCore - Claude review of free branches (FREE_GODMODE_V2_PLAN.md Slice F5)
// ----------------------------------------------------------------------------
// Strictly opt-in: OFF by default, it changes nothing unless the board's run
// option "Claude review of luna-free/ branches" (options.freeReview) is ticked.
// When a free build run (orchestraFree.js) settles with it ticked:
//
//   - ONE read-only headless Claude review per pushed luna-free/* branch, its
//     diff against the base (orchestraReview.js, the same runner as the
//     hybrid gate, F6c);
//   - a Claude usage limit waits for the reset like the planner does
//     (orchestraPlanWait.js), then the remaining branches go on;
//   - the results go to docs/plans/<slug>/REVIEW.md in the repo: <slug> is
//     the approved plan the to-dos came from (F4), else the run's own slug
//     docs/plans/free-run-<run id>/.
//
// Nothing is merged, pushed or committed here: REVIEW.md is a file for Mati.
// The rules are pure; createFreeReviewer() runs the queue with injected I/O.
// ============================================================================

'use strict';

const { isSafeFreeBranch } = require('./orchestraFree');
const { planSlugOf } = require('./planTodoImport');
const { validateRunSlug, planFolder } = require('./orchestraPlanRun');
const { planWaitDecision } = require('./orchestraPlanWait');
const { buildBranchReviewPrompt } = require('./orchestraReview');

const REVIEW_FILE = 'REVIEW.md';
const RUN_SLUG_PREFIX = 'free-run-';
const FALLBACK_RUN_SLUG = 'free-run';
const STATES = Object.freeze(['running', 'waiting', 'done', 'failed']);
const VERDICTS = Object.freeze(['pass', 'fail', 'error']);
const SHA_RE = /^[0-9a-f]{7,40}$/i;
const MAX_RESULTS = 50;
const MAX_TEXT = 300;

const oneLine = (v, max = MAX_TEXT) =>
  String(v == null ? '' : v)
    .replace(/[\x00-\x1f\x7f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/** The run's own plan folder slug: free-run-<run id>. */
function runSlugFor(planId) {
  const tail = String(planId || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30);
  const slug = `${RUN_SLUG_PREFIX}${tail}`;
  return tail && validateRunSlug(slug).ok ? slug : FALLBACK_RUN_SLUG;
}

/** docs/plans/<slug>/REVIEW.md (a valid slug only; planFolder throws otherwise). */
function reviewDocPath(slug) {
  return `${planFolder(slug)}${REVIEW_FILE}`;
}

/** The pushed luna-free/* branches of a free run, each once. */
function reviewTargets(plan) {
  if (!plan || plan.freeMode !== true || !Array.isArray(plan.packages)) return [];
  const seen = new Set();
  const out = [];
  for (const p of plan.packages) {
    if (p.state !== 'pushed' || !isSafeFreeBranch(p.branch, plan.baseBranch) || !SHA_RE.test(String(p.headSha || ''))) continue;
    if (seen.has(p.branch)) continue;
    seen.add(p.branch);
    out.push(p);
  }
  return out;
}

/** The approved plan a package's to-dos came from, or null. */
function slugOfPackage(pkg, todosByAt) {
  for (const at of Array.isArray(pkg.todoAts) ? pkg.todoAts : []) {
    const slug = planSlugOf(todosByAt.get(at));
    if (slug) return slug;
  }
  return null;
}

/**
 * The branches to review, grouped by the REVIEW.md they land in.
 * @param {object} plan
 * @param {Array<object>} todos the project's to-dos (done ones too)
 * @returns {Array<{slug:string, path:string, packages:object[]}>}
 */
function reviewGroups(plan, todos) {
  const byAt = new Map((Array.isArray(todos) ? todos : []).filter((t) => t && Number.isFinite(t.at)).map((t) => [t.at, t]));
  const runSlug = runSlugFor(plan.id);
  const groups = new Map();
  for (const p of reviewTargets(plan)) {
    const slug = slugOfPackage(p, byAt) || runSlug;
    if (!groups.has(slug)) groups.set(slug, { slug, path: reviewDocPath(slug), packages: [] });
    groups.get(slug).packages.push(p);
  }
  return [...groups.values()];
}

/**
 * True when a settled free run should be reviewed now: the option is ticked,
 * there is something to review and no review ran (or one failed outright).
 */
function wantsReview(plan) {
  if (!plan || plan.freeMode !== true || plan.settled !== true || plan.killed) return false;
  if (!isObject(plan.options) || plan.options.freeReview !== true) return false;
  if (plan.freeReview && plan.freeReview.state !== 'failed') return false;
  return reviewTargets(plan).length > 0;
}

const VERDICT_LABEL = { pass: 'PASS', fail: 'NEEDS WORK', error: 'NOT REVIEWED' };

/**
 * One REVIEW.md.
 * @param {{planId:string, base:string|null, at:number, entries:Array<{pkg:object, res:object}>}} input
 * @returns {string} markdown
 */
function reviewDocText({ planId, base, at, entries }) {
  const when = Number.isFinite(at) ? new Date(at).toISOString().replace('T', ' ').slice(0, 16) : '-';
  const lines = [
    '# Claude review of free branches',
    '',
    `- Run \`${oneLine(planId, 64)}\`${base ? `, base \`${oneLine(base, 120)}\`` : ''}, reviewed ${when} UTC`,
    '- One read-only headless Claude (Sonnet) review per `luna-free/*` branch. Nothing was merged.',
  ];
  for (const { pkg, res } of entries) {
    const verdict = res && res.ok ? res.verdict : 'error';
    lines.push('', `## \`${oneLine(pkg.branch, 200)}\` - ${VERDICT_LABEL[verdict] || 'NOT REVIEWED'}`, '');
    lines.push(`- Package \`${oneLine(pkg.id, 64)}\`: ${oneLine(pkg.title, 200)}`);
    if (pkg.headSha) lines.push(`- Commit \`${String(pkg.headSha).slice(0, 7)}\``);
    if (res && res.ok) {
      const reasons = (Array.isArray(res.reasons) ? res.reasons : []).map((r) => oneLine(r)).filter(Boolean);
      lines.push('', ...(reasons.length ? reasons.map((r) => `- ${r}`) : ['- No findings.']));
    } else {
      lines.push(`- The review could not run: ${oneLine((res && res.error) || 'failed', 64)}${res && res.detail ? ` - ${oneLine(res.detail)}` : ''}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

/** A stored review state back to its shape; one in flight does not survive a restart. */
function normalizeStoredFreeReview(raw) {
  if (!isObject(raw) || !STATES.includes(raw.state) || raw.state === 'running' || raw.state === 'waiting') return null;
  const n = (v) => (Number.isInteger(v) && v >= 0 ? Math.min(v, MAX_RESULTS) : 0);
  return {
    state: raw.state,
    total: n(raw.total),
    done: n(raw.done),
    resumeAt: null,
    files: (Array.isArray(raw.files) ? raw.files : [])
      .filter((f) => typeof f === 'string' && /^docs\/plans\/[a-z0-9-]+\/REVIEW\.md$/.test(f))
      .slice(0, MAX_RESULTS),
    results: (Array.isArray(raw.results) ? raw.results : [])
      .filter((r) => isObject(r) && typeof r.branch === 'string' && VERDICTS.includes(r.verdict))
      .map((r) => ({ branch: oneLine(r.branch, 200), verdict: r.verdict }))
      .slice(0, MAX_RESULTS),
    error: typeof raw.error === 'string' && raw.error ? oneLine(raw.error, 64) : null,
    at: Number.isFinite(raw.at) ? raw.at : null,
  };
}

/**
 * The review queue of one run controller.
 * @param {{
 *   getPlan: () => object|null, setState: (state:object) => void,
 *   runReview?: Function, reviewDiff?: Function, reviewEnv?: () => object|null,
 *   usageLimits?: () => object[], readTodos?: (projectId:string|null) => object[],
 *   writeDoc?: (repoPath:string, relPath:string, text:string) => boolean,
 *   now: () => number, setTimer: Function, clearTimer: Function,
 *   onRunEvent?: Function, log?: Function,
 * }} deps
 */
function createFreeReviewer(deps) {
  const { now, setTimer, clearTimer } = deps;
  const log = deps.log || (() => {});
  const onRunEvent = deps.onRunEvent || (() => {});
  /** @type {null|{planId:string, repoPath:string, base:string|null, groups:object[], queue:object[], results:object[], state:object}} */
  let job = null;
  let timer = null;

  const live = () => {
    const p = deps.getPlan();
    return !!job && !!p && p.id === job.planId && !p.killed;
  };

  function set(fields) {
    job.state = { ...job.state, ...fields };
    deps.setState({ ...job.state, files: [...job.state.files], results: [...job.state.results] });
  }

  /** Starts the reviews when the run wants them. @returns {boolean} started */
  function start() {
    const plan = deps.getPlan();
    if (job || !wantsReview(plan)) return false;
    let todos = [];
    try {
      todos = deps.readTodos ? deps.readTodos(plan.projectId) : [];
    } catch (err) {
      log(`[free review] to-dos unreadable: ${err instanceof Error ? err.message : String(err)}`);
    }
    const groups = reviewGroups(plan, todos);
    const queue = groups.flatMap((g) => g.packages.map((pkg) => ({ slug: g.slug, pkg })));
    job = {
      planId: plan.id,
      repoPath: plan.repoPath,
      base: plan.baseBranch || null,
      groups,
      queue,
      results: [],
      state: { state: 'running', total: queue.length, done: 0, resumeAt: null, files: [], results: [], error: null, at: now() },
    };
    set({});
    onRunEvent('freeReview', { state: 'running', total: queue.length });
    run();
    return true;
  }

  function run() {
    step().catch((err) => {
      log(`[free review] failed: ${err instanceof Error ? err.message : String(err)}`);
      if (job) end({ state: 'failed', error: 'failed' });
    });
  }

  async function reviewOne(pkg) {
    if (!deps.runReview || !deps.reviewDiff) return { ok: false, error: 'unavailable' };
    const from = job.base || pkg.baseSha;
    const diff = await deps.reviewDiff({ cwd: job.repoPath, from, to: pkg.headSha, mergeBase: !!job.base });
    if (!diff || !diff.ok) return { ok: false, error: 'noDiff', detail: diff && diff.error ? diff.error : null };
    const env = deps.reviewEnv ? deps.reviewEnv() : null;
    if (!env) return { ok: false, error: 'noEnv' };
    const prompt = buildBranchReviewPrompt({ branch: pkg.branch, base: from, diff: diff.diff, stat: diff.stat, titles: [pkg.title] });
    return deps.runReview({ cwd: job.repoPath, env, prompt });
  }

  async function step() {
    while (job && job.queue.length) {
      if (!live()) return stop();
      const item = job.queue[0];
      const res = await reviewOne(item.pkg);
      if (!live()) return stop();
      if (!res || !res.ok) {
        const wait = planWaitDecision({ res: { ...(res || {}), ok: false }, limits: deps.usageLimits ? deps.usageLimits() : [], now: now() });
        if (wait.action === 'wait') {
          set({ state: 'waiting', resumeAt: wait.resumeAt });
          onRunEvent('freeReview', { state: 'waiting', until: wait.resumeAt });
          timer = setTimer(resumeQueue, Math.max(0, wait.resumeAt - now()));
          if (timer && typeof timer.unref === 'function') timer.unref();
          return undefined;
        }
      }
      job.queue.shift();
      job.results.push({ slug: item.slug, pkg: item.pkg, res: res || { ok: false, error: 'failed' } });
      const verdict = res && res.ok ? res.verdict : 'error';
      set({ state: 'running', done: job.results.length, resumeAt: null, results: [...job.state.results, { branch: item.pkg.branch, verdict }] });
    }
    if (job) writeDocs();
    return undefined;
  }

  function resumeQueue() {
    timer = null;
    if (!live()) {
      stop();
      return;
    }
    set({ state: 'running', resumeAt: null });
    run();
  }

  function writeDocs() {
    const files = [];
    let failed = false;
    for (const g of job.groups) {
      const entries = job.results.filter((r) => r.slug === g.slug);
      if (!entries.length) continue;
      const text = reviewDocText({ planId: job.planId, base: job.base, at: now(), entries });
      const ok = deps.writeDoc ? deps.writeDoc(job.repoPath, g.path, text) === true : false;
      if (ok) files.push(g.path);
      else failed = true;
    }
    end(failed && !files.length ? { state: 'failed', error: 'writeFailed', files } : { state: 'done', files, error: failed ? 'writeFailed' : null });
  }

  function end(fields) {
    set({ ...fields, resumeAt: null });
    onRunEvent('freeReview', { state: fields.state, files: fields.files || [] });
    job = null;
  }

  /** The run went away (killed, replaced): the queue stops, nothing is written. */
  function stop() {
    if (timer) clearTimer(timer);
    timer = null;
    job = null;
    return undefined;
  }

  return {
    start,
    cancel: stop,
    isRunning: () => !!job,
  };
}

module.exports = {
  REVIEW_FILE,
  runSlugFor,
  reviewDocPath,
  reviewTargets,
  reviewGroups,
  wantsReview,
  reviewDocText,
  normalizeStoredFreeReview,
  createFreeReviewer,
};
