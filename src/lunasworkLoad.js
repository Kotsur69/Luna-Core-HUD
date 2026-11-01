// ============================================================================
// LunaCore - Luna's Work load test (docs/LUNAS_WORK_PLAN.md C8, LW 3.30)
// ----------------------------------------------------------------------------
// For apps with a backend, a SHORT stress run (ramping virtual users, under
// two minutes) against the STAGING copy, at two moments of a run:
//
//   complete  the Critic marks the "complete" milestone gate as reached
//   preShip   the Critic says SHIP (before the SHIP confirmation pass)
//
// afterCritic() runs in the critiquing phase of src/lunaswork.js:
//
//   1. trigger   only a staging profile, only a backend app (hasBackend():
//                ARCHITECTURE.md + repo layout), only the two moments above
//   2. target    loadTarget(): the profile's stagingUrl, never a production
//                host, never a loopback address (another app on this PC)
//   3. scenarios the API calls of TEST_PLAN.md's journeys ("GET /api/items"),
//                read-only methods only, same origin as stagingUrl
//   4. run       k6 when it is installed, else autocannon through npx (pinned)
//   5. verdict   p95 latency + error rate against the thresholds (defaults
//                here, optional loadP95Ms / loadErrorRate in the profile);
//                every breach is a bug card with the tool's summary as
//                evidence, and a breach before SHIP holds the SHIP pass
//
// TRUST BOUNDARY: the command line is fixed - the tool, LunaCore-owned file
// paths and nothing else. TEST_PLAN.md is model-written, so the scenarios
// only ever reach the tool through a JSON config file, and the URL host
// always comes from the pinned profile (src/lunasworkSettings.js).
//
// Each (iteration, moment) runs once: load.json in the run folder keeps the
// outcome, so a restart does not hammer staging again.
//
// The command runner / tool detection / docs / clock are injected, so the
// tests run fakes.
// ============================================================================

'use strict';

const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');
const paths = require('./paths');
const pack = require('./lunasworkPack');
const { applyCards } = require('./lunasworkCritic');
const { evidenceDirFor } = require('./lunasworkAdapters');
const { isStaging, runShell } = require('./lunasworkStaging');
const { runTag } = require('./todorows');

const RUN_ID_RE = /^[a-z0-9]{1,40}$/;
const STATE_FILE = 'load.json';
const LOAD_LOG = 'load.log';
const CONFIG_FILE = 'load-config.json';
const SUMMARY_FILE = 'load-summary.json';
const K6_SCRIPT_FILE = 'load-k6.js';
const AUTOCANNON_SCRIPT_FILE = 'load-autocannon.js';
// Pinned: npx never pulls a surprise major into a run.
const AUTOCANNON_VERSION = '8.0.0';
const DEFAULT_THRESHOLDS = Object.freeze({ p95Ms: 1000, errorRate: 0.01 });
// Ramp up, hold, ramp down: 100 s of load in all.
const STAGES = Object.freeze([
  { seconds: 20, target: 5 },
  { seconds: 60, target: 20 },
  { seconds: 20, target: 0 },
]);
// The tool's whole run, npx install included, before it is killed.
const RUN_TIMEOUT_MS = 5 * 60 * 1000;
const DETECT_TIMEOUT_MS = 10 * 1000;
const MAX_SCENARIOS = 10;
const MAX_PATH_CHARS = 200;
const MAX_STATE_ENTRIES = 20;
// Read-only calls only: a stress run must not fill staging with writes.
const LOAD_METHODS = ['GET', 'HEAD'];
const API_CALL_RE = /\b(GET|HEAD|POST|PUT|PATCH|DELETE)\s+`?(\/[^\s`'"<>)\]]*)/g;
const SAFE_PATH_RE = /^\/(?!\/)[A-Za-z0-9\-._~/%?=&+,:@]*$/;

const MOMENTS = { complete: 'complete', preShip: 'preShip' };

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
// eslint-disable-next-line no-control-regex
const oneLine = (v, max = 300) => String(v == null ? '' : v).replace(/[\x00-\x1f\x7f\s]+/g, ' ').trim().slice(0, max);
const errText = (err) => (err instanceof Error ? err.message : String(err));
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const pct = (rate) => `${Math.round(rate * 1000) / 10}%`;

// ---- has a backend (pure) --------------------------------------------------------------

// What ARCHITECTURE.md says when there is a backend.
const DOC_SIGNS = [
  { re: /\bapi (?:routes?|endpoints?|handlers?)\b/i, text: 'API routes' },
  { re: /\b(?:rest|graphql|http|json) api\b/i, text: 'an HTTP API' },
  { re: /\b(?:edge|serverless|cloud|lambda) functions?\b/i, text: 'server functions' },
  { re: /\b(?:express|fastify|fastapi|flask|django|nestjs|koa|hono|rails|laravel|spring boot)\b/i, text: 'a server framework' },
  { re: /\b(?:postgres(?:ql)?|mysql|sqlite|mongodb|supabase|firebase|prisma|drizzle|redis|database)\b/i, text: 'a database' },
  { re: /\b(?:backend|back-end|api server|web server)\b/i, text: 'a backend' },
];
// ... and when it says outright that there is none.
const NO_BACKEND_RE = /\b(?:no (?:backend|back-end|server|database|api)|static (?:site|export)|frontend[- ]only|client[- ]only)\b/i;

// Repo paths that only exist for a backend (posix, relative to the repo root).
const LAYOUT_MARKERS = [
  'app/api',
  'src/app/api',
  'pages/api',
  'src/pages/api',
  'api',
  'server',
  'src/server',
  'backend',
  'supabase/functions',
  'supabase/migrations',
  'netlify/functions',
  'functions',
  'prisma/schema.prisma',
  'migrations',
];

/**
 * Whether the app has a backend: API routes, a server, edge functions or a
 * database, from ARCHITECTURE.md and the repo layout. Pure. The layout wins:
 * a doc that says "no backend" next to an app/api folder is out of date.
 * @param {{architecture?:string, files?:string[]}} input files = existing LAYOUT_MARKERS
 * @returns {{backend:boolean, reasons:string[]}}
 */
function hasBackend({ architecture = '', files = [] } = {}) {
  const layout = (Array.isArray(files) ? files : [])
    .map((f) => String(f).replace(/\\/g, '/').replace(/\/+$/, ''))
    .filter((f) => LAYOUT_MARKERS.includes(f))
    .map((f) => `${f} in the repo`);
  if (layout.length) return { backend: true, reasons: [...new Set(layout)] };
  const doc = typeof architecture === 'string' ? architecture : '';
  if (!doc || NO_BACKEND_RE.test(doc)) return { backend: false, reasons: [] };
  const said = DOC_SIGNS.filter((s) => s.re.test(doc)).map((s) => `ARCHITECTURE.md names ${s.text}`);
  return { backend: said.length > 0, reasons: said };
}

/** The LAYOUT_MARKERS that exist in the repo. Never throws. */
function layoutOf(repoDir) {
  if (typeof repoDir !== 'string' || !repoDir) return [];
  return LAYOUT_MARKERS.filter((m) => {
    try {
      return fs.existsSync(path.join(repoDir, ...m.split('/')));
    } catch {
      return false;
    }
  });
}

// ---- the trigger rule (pure) -----------------------------------------------------------

const isCompleteGate = (name) => ` ${norm(name)} `.includes(' complete ');

/**
 * When a load test runs: a staging profile, a backend app, and either the
 * Critic's SHIP verdict or the "complete" milestone gate reached. Pure.
 * @param {{critic:object|null, profile:object|null, backend:boolean}} input
 * @returns {'complete'|'preShip'|null}
 */
function loadMoment({ critic, profile, backend }) {
  if (!isStaging(profile) || backend !== true || !isObj(critic)) return null;
  if (critic.verdict === 'ship') return MOMENTS.preShip;
  const m = critic.milestone;
  if (isObj(m) && m.passed === true && isCompleteGate(m.name)) return MOMENTS.complete;
  return null;
}

// ---- the staging-only guard (pure) -----------------------------------------------------

const LOOPBACK_HOSTS = new Set(['localhost', '0.0.0.0', '::', '::1', '[::]', '[::1]']);

function isLoopback(host) {
  const h = host.toLowerCase();
  if (LOOPBACK_HOSTS.has(h) || h.endsWith('.localhost')) return true;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  return /^\[?::ffff:127\./.test(h);
}

const isProdHost = (host) => host.toLowerCase().split(/[.-]/).some((label) => label === 'prod' || label === 'production');

/**
 * The URL a load test may hit: the profile's stagingUrl, and only when it is
 * not production, not a loopback address and not the local launch URL.
 * @param {object|null} profile the run's pinned profile
 * @returns {{ok:true, url:URL}|{ok:false, reason:string}}
 */
function loadTarget(profile) {
  if (!isStaging(profile)) return { ok: false, reason: 'no stagingUrl in the profile' };
  let url;
  try {
    url = new URL(profile.stagingUrl);
  } catch {
    return { ok: false, reason: 'stagingUrl is not a URL' };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return { ok: false, reason: `stagingUrl must be http(s), not ${url.protocol}` };
  if (url.username || url.password) return { ok: false, reason: 'stagingUrl must not carry credentials' };
  if (isLoopback(url.hostname)) return { ok: false, reason: `stagingUrl points at this PC (${url.hostname}), not at staging` };
  if (isProdHost(url.hostname)) return { ok: false, reason: `stagingUrl looks like production (${url.hostname})` };
  if (typeof profile.url === 'string') {
    try {
      if (new URL(profile.url).origin === url.origin) return { ok: false, reason: 'stagingUrl is the local launch URL' };
    } catch {
      // A broken launch URL cannot be the staging one.
    }
  }
  return { ok: true, url };
}

// ---- scenarios (pure) ------------------------------------------------------------------

/**
 * The API calls of TEST_PLAN.md's journeys, as requests on the staging origin.
 * Writes are skipped (listed), anything that could leave the origin is dropped;
 * no call at all falls back to the staging root.
 * @param {string} testPlan TEST_PLAN.md text (model-written: never trusted)
 * @param {URL} base the staging URL from loadTarget()
 * @returns {{scenarios:Array<{method:string, url:string, path:string}>, skipped:string[]}}
 */
function scenariosFrom(testPlan, base) {
  const seen = new Set();
  const scenarios = [];
  const skipped = [];
  for (const m of String(testPlan || '').matchAll(API_CALL_RE)) {
    const method = m[1];
    const raw = m[2].replace(/[.,;:]+$/, '');
    const call = `${method} ${raw}`;
    if (seen.has(call)) continue;
    seen.add(call);
    if (!LOAD_METHODS.includes(method)) {
      skipped.push(call.slice(0, MAX_PATH_CHARS));
      continue;
    }
    if (raw.length > MAX_PATH_CHARS || !SAFE_PATH_RE.test(raw)) continue;
    let url;
    try {
      url = new URL(raw, base);
    } catch {
      continue;
    }
    if (url.origin !== base.origin) continue;
    if (scenarios.length < MAX_SCENARIOS) scenarios.push({ method, url: url.href, path: `${url.pathname}${url.search}` });
  }
  if (!scenarios.length) scenarios.push({ method: 'GET', url: base.href, path: `${base.pathname}${base.search}` });
  return { scenarios, skipped: skipped.slice(0, MAX_SCENARIOS) };
}

// ---- thresholds + verdict (pure) -------------------------------------------------------

/** Defaults, with the profile's loadP95Ms / loadErrorRate on top when valid. */
function thresholdsFor(profile) {
  const p = isObj(profile) ? profile : {};
  return {
    p95Ms: Number.isFinite(p.loadP95Ms) && p.loadP95Ms > 0 ? p.loadP95Ms : DEFAULT_THRESHOLDS.p95Ms,
    errorRate: Number.isFinite(p.loadErrorRate) && p.loadErrorRate >= 0 && p.loadErrorRate <= 1 ? p.loadErrorRate : DEFAULT_THRESHOLDS.errorRate,
  };
}

/**
 * The tool's summary file -> one shape: {tool, requests, failed, errorRate, latencyMs, latencyLabel}.
 * k6: --summary-export JSON; autocannon: what AUTOCANNON_SCRIPT writes.
 * @returns {object|null} null when the file is not a summary
 */
function normalizeSummary(tool, raw) {
  if (!isObj(raw)) return null;
  if (tool === 'k6') {
    const metrics = isObj(raw.metrics) ? raw.metrics : {};
    const duration = isObj(metrics.http_req_duration) ? metrics.http_req_duration : {};
    const failed = isObj(metrics.http_req_failed) ? metrics.http_req_failed : {};
    const reqs = isObj(metrics.http_reqs) ? metrics.http_reqs : {};
    const requests = Number.isFinite(reqs.count) ? reqs.count : null;
    const latencyMs = Number.isFinite(duration['p(95)']) ? duration['p(95)'] : null;
    const errorRate = Number.isFinite(failed.value) ? failed.value : Number.isFinite(failed.rate) ? failed.rate : null;
    if (requests === null || latencyMs === null || errorRate === null) return null;
    return { tool, requests, failed: Math.round(requests * errorRate), errorRate, latencyMs, latencyLabel: 'p95' };
  }
  if (tool === 'autocannon') {
    const { requests, failed, latencyMs } = raw;
    if (![requests, failed, latencyMs].every(Number.isFinite)) return null;
    return { tool, requests, failed, errorRate: requests > 0 ? failed / requests : 1, latencyMs, latencyLabel: 'p97.5' };
  }
  return null;
}

/**
 * Which thresholds a summary breaks. Pure. No request at all is a full error rate.
 * @returns {Array<{metric:'latency'|'errorRate', value:number, limit:number}>}
 */
function breachesOf(summary, thresholds) {
  const out = [];
  if (summary.latencyMs > thresholds.p95Ms) out.push({ metric: 'latency', value: summary.latencyMs, limit: thresholds.p95Ms });
  const rate = summary.requests > 0 ? summary.errorRate : 1;
  if (rate > thresholds.errorRate) out.push({ metric: 'errorRate', value: rate, limit: thresholds.errorRate });
  return out;
}

// ---- cards -----------------------------------------------------------------------------

const MOMENT_TEXT = { complete: 'the "complete" milestone gate', preShip: 'the SHIP verdict' };

function summaryLines(summary, scenarios) {
  return [
    `${summary.tool} summary: ${summary.requests} requests, ${summary.failed} failed (${pct(summary.errorRate)}), ${summary.latencyLabel} latency ${Math.round(summary.latencyMs)} ms.`,
    `Load: ${STAGES.map((s) => `${s.target} VUs for ${s.seconds}s`).join(' -> ')}.`,
    `Scenarios: ${scenarios.map((s) => `${s.method} ${s.path}`).join(', ')}.`,
  ];
}

function breachCard(breach, o) {
  const latency = breach.metric === 'latency';
  return {
    kind: 'bug',
    severity: 'high',
    text: latency
      ? `Load test on staging: ${o.summary.latencyLabel} latency above ${breach.limit} ms under load`
      : `Load test on staging: error rate above ${pct(breach.limit)} under load`,
    details: [
      `Iteration ${o.iteration}, at ${MOMENT_TEXT[o.moment]}: ${latency ? `${o.summary.latencyLabel} latency ${Math.round(breach.value)} ms (limit ${breach.limit} ms)` : `error rate ${pct(breach.value)} (limit ${pct(breach.limit)})`}.`,
      `Target: ${o.target} (staging).`,
      ...summaryLines(o.summary, o.scenarios),
      `Summary: ${o.summaryFile}`,
      `Log: ${o.logFile}`,
    ].join('\n'),
    acceptance: latency
      ? [`The next load test on staging keeps ${o.summary.latencyLabel} latency at or below ${breach.limit} ms`]
      : [`The next load test on staging keeps the error rate at or below ${pct(breach.limit)}`],
    files: [],
    updatesCardId: null,
  };
}

function failedRunCard(o) {
  return {
    kind: 'bug',
    severity: 'medium',
    text: "Load test on staging could not run - fix it so Luna's Work can stress the backend",
    details: [`Iteration ${o.iteration}, at ${MOMENT_TEXT[o.moment]}: ${oneLine(o.detail, 300)}.`, `Tool: ${o.tool}.`, `Log: ${o.logFile}`].join('\n'),
    acceptance: ['The next load test on staging runs and writes a summary'],
    files: [],
    updatesCardId: null,
  };
}

/** One card unless an open one with the same text is there already. @returns {boolean} filed */
function fileCard(store, runId, card) {
  const tag = runTag(runId);
  if (!store || !tag) return false;
  try {
    const list = store.read();
    if ((Array.isArray(list) ? list : []).some((t) => isObj(t) && !t.done && t.text === card.text)) return false;
    return applyCards(store, [card], tag).created.length > 0;
  } catch {
    return false;
  }
}

// ---- the tools -------------------------------------------------------------------------

// Fixed k6 script: the scenarios come from the config file, never the command line.
const K6_SCRIPT = `import http from 'k6/http';
import { sleep } from 'k6';

const config = JSON.parse(open(__ENV.LUNA_LOAD_CONFIG));

export const options = {
  stages: config.stages.map((s) => ({ duration: s.seconds + 's', target: s.target })),
  discardResponseBodies: true,
  summaryTrendStats: ['avg', 'med', 'p(95)', 'max'],
};

export default function () {
  for (const s of config.scenarios) http.request(s.method, s.url, null, { timeout: '10s' });
  sleep(1);
}
`;

// Fixed autocannon runner, started by npx with autocannon's .bin on PATH.
const AUTOCANNON_SCRIPT = `'use strict';
const fs = require('fs');
const path = require('path');

function findAutocannon() {
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (!/node_modules[\\\\/]\\.bin[\\\\/]?$/.test(dir)) continue;
    const pkg = path.join(dir, '..', 'autocannon');
    if (fs.existsSync(path.join(pkg, 'package.json'))) return require(pkg);
  }
  throw new Error('autocannon not found on PATH');
}

async function main() {
  const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  const autocannon = findAutocannon();
  const out = { tool: 'autocannon', requests: 0, failed: 0, latencyMs: 0 };
  for (const stage of config.stages.filter((s) => s.target > 0)) {
    const r = await autocannon({
      url: config.origin,
      connections: stage.target,
      duration: stage.seconds,
      timeout: 10,
      requests: config.scenarios.map((s) => ({ method: s.method, path: s.path })),
    });
    out.requests += r.requests.total;
    out.failed += (r.errors || 0) + (r.timeouts || 0) + (r.non2xx || 0);
    out.latencyMs = Math.max(out.latencyMs, r.latency.p97_5 || 0);
  }
  fs.writeFileSync(process.argv[3], JSON.stringify(out));
}

main().catch((err) => {
  console.error(err && err.message ? err.message : String(err));
  process.exit(1);
});
`;

const q = (p) => `"${p}"`;

/** The fixed command of a tool: LunaCore-owned paths only. */
function toolCommand(tool, files) {
  if (tool === 'k6') return `k6 run --quiet --no-color --summary-export ${q(files.summary)} ${q(files.script)}`;
  return `npx --yes --package=autocannon@${AUTOCANNON_VERSION} -- node ${q(files.script)} ${q(files.config)} ${q(files.summary)}`;
}

/** k6 when it answers, else autocannon (npx). Never rejects. */
function detectTool() {
  return new Promise((resolve) => {
    childProcess.execFile('k6', ['version'], { timeout: DETECT_TIMEOUT_MS, windowsHide: true }, (err) => resolve(err ? 'autocannon' : 'k6'));
  });
}

// ---- disk -------------------------------------------------------------------------------

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeFile(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, 'utf8');
}

function runDirFor(runsRoot, runId) {
  if (typeof runId !== 'string' || !RUN_ID_RE.test(runId)) throw new Error('runId must be 1-40 lowercase letters or digits');
  return path.join(path.resolve(runsRoot), `lunaswork-${runId}`);
}

function cleanState(raw) {
  const runs = (isObj(raw) && Array.isArray(raw.runs) ? raw.runs : [])
    .filter((r) => isObj(r) && Number.isInteger(r.iteration) && Object.values(MOMENTS).includes(r.moment))
    .slice(-MAX_STATE_ENTRIES);
  return { runs };
}

// ---- the flow ---------------------------------------------------------------------------

/**
 * @param {{runCommand?:(o:{command:string, cwd:string, env:object, logFile:string, timeoutMs:number})=>Promise<{ok:boolean, code?:number|null, detail?:string}>,
 *   detectTool?:()=>Promise<'k6'|'autocannon'>, readDoc?:(repoDir:string, file:string)=>string|null,
 *   layout?:(repoDir:string)=>string[], runsRoot?:()=>string, now?:()=>number, log?:(line:string)=>void}} [deps]
 */
function createLoadTest(deps = {}) {
  const runCommand = deps.runCommand || runShell;
  const pickTool = deps.detectTool || detectTool;
  const readDoc = deps.readDoc || ((repoDir, file) => pack.readPackFile(repoDir, file));
  const layout = deps.layout || layoutOf;
  const runsRoot = deps.runsRoot || (() => path.join(paths.userDir(), 'runs'));
  const now = deps.now || Date.now;
  const log = deps.log || (() => {});

  const docOf = (repoDir, file) => {
    try {
      const text = readDoc(repoDir, file);
      return typeof text === 'string' ? text : '';
    } catch {
      return '';
    }
  };

  /** Runs the tool once and reads its summary. Never throws. */
  async function stress(o) {
    const files = {
      config: path.join(o.dir, CONFIG_FILE),
      summary: path.join(o.dir, SUMMARY_FILE),
      script: path.join(o.dir, o.tool === 'k6' ? K6_SCRIPT_FILE : AUTOCANNON_SCRIPT_FILE),
    };
    try {
      writeFile(files.config, JSON.stringify({ origin: o.target.origin, stages: STAGES, scenarios: o.scenarios }, null, 2));
      writeFile(files.script, o.tool === 'k6' ? K6_SCRIPT : AUTOCANNON_SCRIPT);
      fs.rmSync(files.summary, { force: true });
    } catch (err) {
      return { ok: false, detail: `files not written: ${errText(err)}`, files };
    }
    let res;
    try {
      res = await runCommand({
        command: toolCommand(o.tool, files),
        cwd: o.dir,
        env: { LUNA_LOAD_CONFIG: files.config, K6_NO_USAGE_REPORT: 'true' },
        logFile: o.logFile,
        timeoutMs: RUN_TIMEOUT_MS,
      });
    } catch (err) {
      res = { ok: false, detail: errText(err) };
    }
    const summary = normalizeSummary(o.tool, readJson(files.summary));
    if (summary) return { ok: true, summary, files };
    const detail = isObj(res) ? oneLine(res.detail || (res.ok ? 'no summary written' : `exit ${res.code}`), 300) : 'no result';
    return { ok: false, detail: detail || 'no summary written', files };
  }

  /**
   * The critiquing phase's load step. No staging, no backend, not the right
   * moment: nothing happens. Never throws.
   * @param {{run:()=>object, critic:object, logEvent:(text:string)=>void, todoStore:{read:Function, write:Function}}} ctx
   * @returns {Promise<{ran:boolean, moment?:string, blocksShip:boolean, breaches?:object[], error?:string}>}
   */
  async function afterCritic(ctx) {
    const idle = { ran: false, blocksShip: false };
    try {
      const run = ctx.run();
      if (!isStaging(run.profile)) return idle;
      const backend = hasBackend({ architecture: docOf(run.repoPath, 'ARCHITECTURE.md'), files: layout(run.repoPath) });
      const moment = loadMoment({ critic: ctx.critic, profile: run.profile, backend: backend.backend });
      if (!moment) return idle;
      const note = (text) => ctx.logEvent(`load test: ${text}`);
      const target = loadTarget(run.profile);
      if (!target.ok) {
        note(`refused - ${target.reason}`);
        return { ...idle, moment, error: 'refused' };
      }

      const stateFile = path.join(runDirFor(runsRoot(), run.id), STATE_FILE);
      const state = cleanState(readJson(stateFile));
      const before = state.runs.find((r) => r.iteration === run.iteration && r.moment === moment);
      if (before) return { ran: true, moment, blocksShip: before.blocksShip === true, breaches: before.breaches || [] };

      const dir = evidenceDirFor(runsRoot(), run.id, run.iteration);
      const logFile = path.join(dir, LOAD_LOG);
      const { scenarios, skipped } = scenariosFrom(docOf(run.repoPath, 'TEST_PLAN.md'), target.url);
      const tool = await pickTool();
      note(`${tool} on ${target.url.origin} at ${MOMENT_TEXT[moment]} (${backend.reasons.slice(0, 2).join(', ')}; ${scenarios.length} scenario(s)${skipped.length ? `, writes skipped: ${skipped.length}` : ''})`);
      const res = await stress({ dir, tool, target: target.url, scenarios, logFile });
      const base = { iteration: run.iteration, moment, logFile };

      let outcome;
      if (!res.ok) {
        note(`did not run (${oneLine(res.detail, 200)})`);
        fileCard(ctx.todoStore, run.id, failedRunCard({ ...base, tool, detail: res.detail }));
        outcome = { ran: true, moment, blocksShip: false, breaches: [], error: 'runFailed' };
      } else {
        const breaches = breachesOf(res.summary, thresholdsFor(run.profile));
        const o = { ...base, summary: res.summary, scenarios, target: target.url.origin, summaryFile: res.files.summary };
        for (const b of breaches) fileCard(ctx.todoStore, run.id, breachCard(b, o));
        note(`${breaches.length ? `${breaches.length} threshold(s) broken` : 'thresholds held'} - ${summaryLines(res.summary, scenarios)[0]}`);
        outcome = { ran: true, moment, blocksShip: moment === MOMENTS.preShip && breaches.length > 0, breaches };
      }
      const entry = { iteration: run.iteration, moment, at: now(), tool, blocksShip: outcome.blocksShip, breaches: outcome.breaches, ...(outcome.error ? { error: outcome.error } : {}) };
      try {
        writeFile(stateFile, JSON.stringify({ runs: [...state.runs, entry].slice(-MAX_STATE_ENTRIES) }, null, 2) + '\n');
      } catch (err) {
        log(`[lunaswork] ${stateFile} not written: ${errText(err)}`);
      }
      return outcome;
    } catch (err) {
      log(`[lunaswork] load test failed: ${errText(err)}`);
      return { ...idle, error: 'failed' };
    }
  }

  return { afterCritic };
}

module.exports = {
  DEFAULT_THRESHOLDS,
  STAGES,
  AUTOCANNON_VERSION,
  LAYOUT_MARKERS,
  hasBackend,
  layoutOf,
  loadMoment,
  loadTarget,
  scenariosFrom,
  thresholdsFor,
  normalizeSummary,
  breachesOf,
  toolCommand,
  createLoadTest,
};
