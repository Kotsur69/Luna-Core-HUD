// ============================================================================
// LunaCore - God Mode on the Antigravity CLI (`agy`)
// ----------------------------------------------------------------------------
// The one place that knows how a God Mode run uses agy:
//
//   PLANNERS / AGY             the shared allow-list of planner names
//   packageRunsAgy(plan, pkg)  does this package's worker tab run on the agy
//                              profile (workers 'agy', worker model 'agy', a
//                              hybrid or 'plan' / pool-run package whose own
//                              pick is agy;
//                              every test is isAgyModel, so 'agy:<id>'
//                              variants count too)
//   packageAgyModel(plan, pkg) which agy choice it runs: 'agy' or 'agy:<id>'
//   runAgyVariants(plan, ...)  the 'agy:<id>' variants a run needs (Approve
//                              checks them against the live list)
//   runUsesAgy(plan)           do the run's helper jobs (diff review, conflict
//                              resolution, self-check, post-merge worker) run
//                              on agy instead of claude
//   approveAgyProfile(...)     the agy profile a run needs at Approve, or the
//                              clear refusal 'noAgyProfile'
//   runAgyPrint(...)           one headless `agy --print` call, prompt on stdin
//   agyJsonPrompt / parseAgyJson
//                              agy has no --json-schema: the JSON contract goes
//                              into the prompt and the answer is parsed from
//                              its text, then checked by the caller's own
//                              validator exactly like a Claude answer
//
// A headless call is agy with its prompt piped on stdin and NO `--print`:
// checked live against agy 1.5.12 (2026-11-19), `--print` takes the prompt
// as its VALUE, so a bare `--print` fails ("flag needs an argument") and
// `--print --model X` runs "--model" as the prompt. Piped stdin alone runs one
// turn non-interactively and exits, and keeps long prompts clear of the
// Windows command-line limit. `--mode accept-edits` auto-accepts file edits.
// ============================================================================

'use strict';

const { execFile } = require('child_process');
const { storedWorkers } = require('./orchestraWorkers');
const { AGY_MODEL } = require('./claudeModels');
const { isAgyModel, isAgyModelId } = require('./workerModels');
const { runsOnOf } = require('./workerPool');
const { tickedKeys } = require('./orchestraRescue');

/** The agy name, as a planner, a Workers choice and a package / worker model. */
const AGY = AGY_MODEL;
/** God Mode planners (the picker, orchestra:plan, Plan only, the phone). */
const PLANNERS = Object.freeze(['claude', AGY, 'free']);
const AGY_BIN = 'agy';
const AGY_EDIT_ARGS = Object.freeze(['--mode', 'accept-edits']);
const MAX_DETAIL_CHARS = 300;
const DEFAULT_MAX_BUFFER = 20 * 1024 * 1024;
/** agy's own limit wording is unknown; these are the common ones. */
const LIMIT_RE = /\b(rate.?limit|quota|resource.?exhausted|429)\b/i;

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const oneLine = (v, max = MAX_DETAIL_CHARS) =>
  String(v == null ? '' : v)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);

/** One of PLANNERS, else null (an unknown name is refused, never coerced). */
function normalizePlanner(value) {
  return PLANNERS.includes(value) ? value : null;
}

/**
 * True when this package's worker tab runs on the agy profile.
 * Workers 'agy' puts every package there; in a hybrid run the planner's
 * 'agy' pick does (until a hand-over overrides it); worker model 'agy'
 * (Settings, Approve) does for a Claude-only or hybrid run.
 * @param {object|null} plan
 * @param {object|null} pkg
 * @returns {boolean}
 */
function packageRunsAgy(plan, pkg) {
  if (!isObj(plan) || plan.planRun || plan.freeMode === true) return false;
  const workers = storedWorkers(plan);
  if (workers === AGY) return true;
  if (workers === 'free') return false;
  const p = isObj(pkg) ? pkg : {};
  if (typeof p.modelOverride === 'string' && p.modelOverride) return isAgyModel(p.modelOverride);
  if (picksOwnModel(workers, plan.workerModel) && isAgyModel(p.model)) return true;
  return isAgyModel(plan.workerModel);
}

/**
 * True when a run lets each package's own pick decide where it runs: a
 * hybrid run, or worker model 'plan' (Planner's pick, a worker-model pool -
 * src/orchestraPool.js). Elsewhere the run's single model decides.
 */
function picksOwnModel(workers, workerModel) {
  return workers === 'hybrid' || workerModel === 'plan';
}

/**
 * Which agy choice a package that runs on agy (packageRunsAgy) uses: 'agy'
 * (agy's own default model) or an 'agy:<id>' variant. Most specific first:
 * a hand-over / escalation override, then the package's own agy pick (only
 * in a hybrid or agy-workers run, as in packageRunsAgy: a Claude-only run
 * never lets a package pick its agy model), then the run's worker model.
 * Only the shape is checked here; main checks the id against the live
 * `agy models` list (src/agymodels.js) before it reaches an argv.
 * @param {object|null} plan
 * @param {object|null} pkg
 * @returns {string}
 */
function packageAgyModel(plan, pkg) {
  const p = isObj(pkg) ? pkg : {};
  const override = typeof p.modelOverride === 'string' && p.modelOverride ? p.modelOverride : null;
  if (override) return isAgyModel(override) ? override : AGY;
  const workers = isObj(plan) ? storedWorkers(plan) : null;
  const run = isObj(plan) ? plan.workerModel : null;
  if ((picksOwnModel(workers, run) || workers === AGY) && isAgyModel(p.model)) return p.model;
  return isAgyModel(run) ? run : AGY;
}

/**
 * Where a pool run's helper jobs run: 'claude' whenever the pool ticks a
 * Claude model, 'agy' when it ticks agy models but no Claude one, null for
 * any other run (and a pool of free models only). A free model never
 * reviews, resolves or fixes up.
 * @param {object|null} plan
 * @returns {'claude'|'agy'|null}
 */
function poolSideJobs(plan) {
  const ons = tickedKeys(plan).map(runsOnOf);
  if (ons.includes('claude')) return 'claude';
  return ons.includes('agy') ? 'agy' : null;
}

/**
 * True when the run's own headless helper jobs (reviews, the integration /
 * merge-conflict worker, the post-DONE fix-up) run on agy: a pool run on
 * agy only when it ticks no Claude model (poolSideJobs); any other run when
 * its workers or its planner is agy.
 * @param {object|null} plan
 * @returns {boolean}
 */
function runUsesAgy(plan) {
  if (!isObj(plan) || plan.freeMode === true) return false;
  const pool = poolSideJobs(plan);
  if (pool) return pool === AGY;
  return storedWorkers(plan) === AGY || plan.buildPlanner === AGY || isAgyModel(plan.workerModel);
}

/** The packages of a plan (objects only). */
const packagesOf = (plan) => (isObj(plan) && Array.isArray(plan.packages) ? plan.packages.filter(isObj) : []);

/**
 * Approve: the agy profile the run needs, fixed for the run. Nothing on agy
 * needs none; anything on agy without a profile is refused with a reason.
 * @param {{packages?:object[]}} plan
 * @param {{workers:string, workerModel?:string|null, agyProfileId:string|null}} input
 * @returns {{ok:true, profileId:string|null}|{ok:false, error:'noAgyProfile'}}
 */
function approveAgyProfile(plan, { workers, workerModel = null, agyProfileId }) {
  const packages = packagesOf(plan);
  const needs =
    workers === AGY ||
    (workers !== 'free' && isAgyModel(workerModel)) ||
    (workers !== 'free' && picksOwnModel(workers, workerModel) && packages.some((p) => isAgyModel(p.model) && !p.modelOverride)) ||
    (workers !== 'free' && packages.some((p) => isAgyModel(p.modelOverride)));
  if (!needs) return { ok: true, profileId: null };
  const id = typeof agyProfileId === 'string' && agyProfileId ? agyProfileId : null;
  return id ? { ok: true, profileId: id } : { ok: false, error: 'noAgyProfile' };
}

/**
 * Approve: every 'agy:<id>' variant the run would hand agy, deduplicated, so
 * main can check each against the live `agy models` list before the run
 * starts. Plain 'agy' needs no check and is left out.
 * @param {{packages?:object[]}} plan
 * @param {{workers:string, workerModel?:string|null}} input
 * @returns {string[]}
 */
function runAgyVariants(plan, { workers, workerModel = null }) {
  if (workers === 'free') return [];
  // The plan as the run will hold it: Approve's Workers and worker model.
  const asRun = { ...(isObj(plan) ? plan : {}), workerModel, workers };
  const out = new Set();
  for (const p of packagesOf(plan)) {
    if (!packageRunsAgy(asRun, p)) continue;
    const choice = packageAgyModel(asRun, p);
    if (choice !== AGY) out.add(choice);
  }
  return [...out];
}

/**
 * argv of one headless agy call (never a shell string).
 * @param {{edits?:boolean, model?:string|null}} [opts]
 *   edits: auto-accept file edits (resolver, fix-up, worker jobs);
 *   model: an agy model id (`agy models`), already checked against the live list
 * @returns {string[]}
 */
function agyPrintArgs({ edits = false, model = null } = {}) {
  // No --print: it would swallow the next token as the prompt (header).
  return [...(edits ? AGY_EDIT_ARGS : []), ...(isAgyModelId(model) ? ['--model', model] : [])];
}

/**
 * The JSON contract appended to a prompt for agy, which cannot be handed a
 * --json-schema: the same schema, as text the model must follow.
 * @param {string} prompt
 * @param {object} schema
 * @returns {string}
 */
function agyJsonPrompt(prompt, schema) {
  return [
    String(prompt || ''),
    '',
    'Answer with exactly ONE JSON object and nothing else: no prose before or after it, no code fence.',
    'The object must match this JSON schema:',
    JSON.stringify(schema),
  ].join('\n');
}

/** The first parseable JSON object in a model's text answer, else null. */
function extractJsonObject(text) {
  const s = String(text || '').trim();
  const tryParse = (t) => {
    try {
      const v = JSON.parse(t);
      return isObj(v) ? v : null;
    } catch {
      return null;
    }
  };
  const whole = tryParse(s);
  if (whole) return whole;
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const fenced = fence ? tryParse(fence[1].trim()) : null;
  if (fenced) return fenced;
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  return start >= 0 && end > start ? tryParse(s.slice(start, end + 1)) : null;
}

/**
 * agy's text answer as a planner-shaped result. agy reports no cost.
 * @param {string} stdout
 * @returns {{ok:true, raw:object, costUsd:null}|{ok:false, error:'badJson'}}
 */
function parseAgyJson(stdout) {
  const raw = extractJsonObject(stdout);
  return raw ? { ok: true, raw, costUsd: null } : { ok: false, error: 'badJson' };
}

/**
 * One headless agy call in `cwd`, prompt on stdin (no `--print`). Always resolves.
 * @param {{cwd:string, env:object, prompt:string, timeout:number, edits?:boolean,
 *   model?:string|null, execImpl?:Function, maxBuffer?:number}} args
 *   model: an agy model id the caller checked against the live list (src/agymodels.js)
 * @returns {Promise<{ok:true, stdout:string}|{ok:false, error:'noAgy'|'timeout'|'limit'|'failed', detail?:string}>}
 */
function runAgyPrint({ cwd, env, prompt, timeout, edits = false, model = null, execImpl = execFile, maxBuffer = DEFAULT_MAX_BUFFER }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = execImpl(AGY_BIN, agyPrintArgs({ edits, model }), { cwd, env, timeout, maxBuffer, windowsHide: true }, (error, stdout, stderr) => {
        if (error && error.code === 'ENOENT') return resolve({ ok: false, error: 'noAgy', detail: 'agy not found' });
        if (error && error.killed) return resolve({ ok: false, error: 'timeout' });
        if (error) {
          const detail = oneLine(stderr || error.message);
          return resolve({ ok: false, error: LIMIT_RE.test(detail) ? 'limit' : 'failed', detail });
        }
        resolve({ ok: true, stdout: String(stdout || '') });
      });
    } catch (err) {
      resolve({ ok: false, error: 'failed', detail: oneLine(err instanceof Error ? err.message : err) });
      return;
    }
    if (child && child.stdin) {
      // A child that died early must not crash main; the exec callback reports it.
      child.stdin.on('error', () => {});
      child.stdin.end(String(prompt || ''));
    }
  });
}

module.exports = {
  AGY,
  AGY_BIN,
  PLANNERS,
  normalizePlanner,
  picksOwnModel,
  packageRunsAgy,
  packageAgyModel,
  runUsesAgy,
  poolSideJobs,
  approveAgyProfile,
  runAgyVariants,
  agyPrintArgs,
  agyJsonPrompt,
  extractJsonObject,
  parseAgyJson,
  runAgyPrint,
};
