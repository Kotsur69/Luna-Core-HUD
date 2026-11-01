// ============================================================================
// Luna's Work load test (src/lunasworkLoad.js, LW 3.30 / plan C8). Covers:
// backend detection from ARCHITECTURE.md + repo layout, the trigger rule (only
// the "complete" gate or the SHIP verdict, only backend apps on staging), the
// staging-only guard (no production, no loopback, no local launch URL),
// TEST_PLAN.md scenarios (read-only, same origin, never on the command line),
// thresholds + profile overrides, a breach becoming a card with the tool's
// summary as evidence, once per (iteration, moment), and SHIP held by a breach
// through the real controller. The tool runner is a fake throughout.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const S = require('../src/lunasworkSettings');
const {
  DEFAULT_THRESHOLDS,
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
} = require('../src/lunasworkLoad');
const { createAdapter } = require('../src/lunasworkAdapters');
const { createLunasWork } = require('../src/lunaswork');

const STAGING_URL = 'https://staging.example.test';
const RUN_ID = 'lwload1';
const CLOCK = 1_800_000_000_000;
const REPO = path.resolve(os.tmpdir(), 'lw-load-repo');
const PROFILE = S.validateProfile({ startCommand: 'npm start', url: 'http://localhost:3000', stagingUrl: STAGING_URL }).profile;
const NO_STAGING = S.validateProfile({ startCommand: 'npm start' }).profile;
const TEST_PLAN = [
  '### Browse quotes',
  '1. Open the app; the list calls GET /api/quotes and shows them.',
  '2. Open one: `GET /api/quotes/42?full=1`.',
  '3. Save it: POST /api/quotes with the form.',
  '4. Sneaky: GET //evil.example/x and GET /api/$(rm -rf ~).',
].join('\n');
const COMPLETE = { verdict: 'continue', milestone: { name: 'Milestone 3: Complete', passed: true, score: 80 } };
const SHIP = { verdict: 'ship', milestone: { name: 'Milestone 4: Polish', passed: true, score: 90 } };

function tmpDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const k6Summary = ({ count = 1200, p95 = 300, failed = 0 } = {}) => ({
  metrics: { http_reqs: { count }, http_req_duration: { avg: 120, 'p(95)': p95 }, http_req_failed: { passes: 0, fails: count, value: failed } },
});

/** The tool runner: records the call and writes the summary the real tool would. */
function fakeRunner(summary, { ok = true, detail = '' } = {}) {
  const r = { calls: [] };
  r.fn = async (o) => {
    r.calls.push(o);
    const file = /--summary-export "([^"]+)"/.exec(o.command) || /"([^"]+load-summary\.json)"/.exec(o.command);
    if (summary && file) fs.writeFileSync(file[1], JSON.stringify(summary));
    return { ok, code: ok ? 0 : 1, detail };
  };
  return r;
}

function harness(t, { summary = k6Summary(), runner = null, profile = PROFILE, architecture = 'Next.js with API routes and Postgres.', files = [], tool = 'k6' } = {}) {
  const runsRoot = tmpDir(t, 'lw-load-');
  const h = { todos: [], events: [], runner: runner || fakeRunner(summary) };
  h.run = { id: RUN_ID, iteration: 7, repoPath: REPO, profile };
  h.store = { read: () => h.todos, write: (list) => ((h.todos = list), true) };
  h.load = createLoadTest({
    runCommand: h.runner.fn,
    detectTool: async () => tool,
    readDoc: (repo, file) => (file === 'ARCHITECTURE.md' ? architecture : file === 'TEST_PLAN.md' ? TEST_PLAN : null),
    layout: () => files,
    runsRoot: () => runsRoot,
    now: () => CLOCK,
  });
  h.after = (critic) => h.load.afterCritic({ run: () => h.run, critic, logEvent: (text) => h.events.push(text), todoStore: h.store });
  h.runsRoot = runsRoot;
  return h;
}

// ---- has a backend --------------------------------------------------------------------

test('backend: the repo layout decides first, ARCHITECTURE.md next', () => {
  assert.equal(hasBackend({ files: ['app/api'] }).backend, true);
  assert.equal(hasBackend({ files: ['supabase/functions/'] }).backend, true, 'a trailing slash still counts');
  assert.equal(hasBackend({ files: ['prisma/schema.prisma'], architecture: 'Static site, no backend.' }).backend, true, 'layout beats an outdated doc');
  assert.equal(hasBackend({ files: ['src/components'] }).backend, false, 'not a marker');
  assert.equal(hasBackend({ architecture: 'Edge functions on Supabase talk to Postgres.' }).backend, true);
  assert.equal(hasBackend({ architecture: 'A FastAPI server.' }).backend, true);
  assert.deepEqual(hasBackend({ architecture: 'Next.js static export, no backend. Data lives in a JSON file.' }), { backend: false, reasons: [] });
  assert.equal(hasBackend({ architecture: 'A canvas game in plain HTML.' }).backend, false);
  assert.equal(hasBackend({}).backend, false);
  assert.match(hasBackend({ files: ['pages/api'] }).reasons[0], /pages\/api in the repo/);
});

test('backend: layoutOf lists the markers that exist on disk', (t) => {
  const repo = tmpDir(t, 'lw-load-repo-');
  fs.mkdirSync(path.join(repo, 'app', 'api'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'prisma'));
  fs.writeFileSync(path.join(repo, 'prisma', 'schema.prisma'), 'model X {}');
  assert.deepEqual(layoutOf(repo).sort(), ['app/api', 'prisma/schema.prisma']);
  assert.deepEqual(layoutOf(''), []);
});

// ---- the trigger rule ------------------------------------------------------------------

test('trigger: only the "complete" gate or the SHIP verdict, only backend apps on staging', () => {
  const at = (critic, o = {}) => loadMoment({ critic, profile: PROFILE, backend: true, ...o });
  assert.equal(at(COMPLETE), 'complete');
  assert.equal(at(SHIP), 'preShip');
  assert.equal(at({ verdict: 'ship', milestone: { name: 'Milestone 3: Complete', passed: true } }), 'preShip', 'one run when both happen');
  assert.equal(at({ verdict: 'continue', milestone: { name: 'Milestone 3: Complete', passed: false } }), null, 'gate not reached');
  assert.equal(at({ verdict: 'continue', milestone: { name: 'Milestone 2: Core flows', passed: true } }), null, 'another gate');
  assert.equal(at({ verdict: 'continue', milestone: { name: 'Incomplete stuff', passed: true } }), null, 'whole words only');
  assert.equal(at({ verdict: 'continue', milestone: null }), null);
  assert.equal(at(COMPLETE, { backend: false }), null, 'no backend');
  assert.equal(at(SHIP, { backend: false }), null, 'no backend, not even before SHIP');
  assert.equal(at(COMPLETE, { profile: NO_STAGING }), null, 'no staging');
  assert.equal(at(null), null);
});

// ---- the staging-only guard ------------------------------------------------------------

test('guard: only the staging URL - never production, loopback or the local launch URL', () => {
  const target = (stagingUrl, extra = {}) => loadTarget({ ...PROFILE, stagingUrl, ...extra });
  assert.equal(target(STAGING_URL).ok, true);
  assert.equal(target('https://my-app-git-staging.vercel.app/app').url.origin, 'https://my-app-git-staging.vercel.app');
  for (const bad of ['https://prod.example.test', 'https://api-production.example.test', 'https://app.prod.example.test']) {
    assert.match(target(bad).reason, /looks like production/, bad);
  }
  for (const bad of ['http://localhost:3000', 'http://127.0.0.1:8080', 'http://[::1]:5173', 'http://app.localhost', 'http://0.0.0.0:4000']) {
    assert.match(target(bad).reason, /points at this PC/, bad);
  }
  assert.match(target('https://staging.example.test', { url: 'https://staging.example.test' }).reason, /local launch URL/);
  assert.match(target('ftp://staging.example.test').reason, /http\(s\)/);
  assert.match(target('https://user:pw@staging.example.test').reason, /credentials/);
  assert.match(loadTarget(NO_STAGING).reason, /no stagingUrl/);
  assert.equal(loadTarget(null).ok, false);
});

test('guard: a refused target runs nothing and says why in the run log', async (t) => {
  const h = harness(t, { profile: { ...PROFILE, stagingUrl: 'http://localhost:4000' } });
  const res = await h.after(COMPLETE);
  assert.deepEqual(res, { ran: false, blocksShip: false, moment: 'complete', error: 'refused' });
  assert.equal(h.runner.calls.length, 0);
  assert.match(h.events[0], /load test: refused - stagingUrl points at this PC/);
});

// ---- scenarios + command ---------------------------------------------------------------

test('scenarios: TEST_PLAN API calls, read-only, same origin; writes listed as skipped', () => {
  const base = new URL(STAGING_URL);
  const { scenarios, skipped } = scenariosFrom(TEST_PLAN, base);
  assert.deepEqual(
    scenarios.map((s) => `${s.method} ${s.url}`),
    [`GET ${STAGING_URL}/api/quotes`, `GET ${STAGING_URL}/api/quotes/42?full=1`],
  );
  assert.deepEqual(skipped, ['POST /api/quotes']);
  assert.deepEqual(scenariosFrom('no calls here', base).scenarios, [{ method: 'GET', url: `${STAGING_URL}/`, path: '/' }], 'falls back to the root');
});

test('command: fixed - only LunaCore-owned paths, no scenario text', () => {
  const files = { config: 'C:\\runs\\c.json', summary: 'C:\\runs\\s.json', script: 'C:\\runs\\x.js' };
  assert.equal(toolCommand('k6', files), 'k6 run --quiet --no-color --summary-export "C:\\runs\\s.json" "C:\\runs\\x.js"');
  assert.equal(toolCommand('autocannon', files), 'npx --yes --package=autocannon@8.0.0 -- node "C:\\runs\\x.js" "C:\\runs\\c.json" "C:\\runs\\s.json"');
});

// ---- thresholds ------------------------------------------------------------------------

test('thresholds: sane defaults, a valid profile override wins', () => {
  assert.deepEqual(thresholdsFor(PROFILE), DEFAULT_THRESHOLDS);
  const custom = S.validateProfile({ startCommand: 'npm start', stagingUrl: STAGING_URL, loadP95Ms: 400, loadErrorRate: 0.05 }).profile;
  assert.deepEqual(thresholdsFor(custom), { p95Ms: 400, errorRate: 0.05 });
  assert.match(S.validateProfile({ startCommand: 'npm start', loadP95Ms: 10 }).reason, /loadP95Ms/);
  assert.match(S.validateProfile({ startCommand: 'npm start', loadP95Ms: 1.5 }).reason, /loadP95Ms/);
  assert.match(S.validateProfile({ startCommand: 'npm start', loadErrorRate: 2 }).reason, /loadErrorRate/);
  assert.match(S.validateProfile({ startCommand: 'npm start', loadErrorRate: '0.1' }).reason, /loadErrorRate/);
});

test('summary: k6 and autocannon read into one shape; breaches against the thresholds', () => {
  const k6 = normalizeSummary('k6', k6Summary({ count: 1000, p95: 1500, failed: 0.03 }));
  assert.deepEqual(k6, { tool: 'k6', requests: 1000, failed: 30, errorRate: 0.03, latencyMs: 1500, latencyLabel: 'p95' });
  const ac = normalizeSummary('autocannon', { requests: 200, failed: 1, latencyMs: 90 });
  assert.equal(ac.errorRate, 0.005);
  assert.equal(normalizeSummary('k6', { metrics: {} }), null);
  assert.equal(normalizeSummary('autocannon', null), null);
  assert.deepEqual(breachesOf(k6, DEFAULT_THRESHOLDS).map((b) => b.metric), ['latency', 'errorRate']);
  assert.deepEqual(breachesOf(ac, DEFAULT_THRESHOLDS), []);
  assert.deepEqual(breachesOf({ ...ac, requests: 0, errorRate: 0 }, DEFAULT_THRESHOLDS).map((b) => b.metric), ['errorRate'], 'no request is a failure');
});

// ---- the flow (fake runner) ------------------------------------------------------------

test('flow: a breach becomes a card with the tool summary as evidence; scenarios only in the config file', async (t) => {
  const h = harness(t, { summary: k6Summary({ count: 900, p95: 2400, failed: 0 }) });
  const res = await h.after(COMPLETE);
  assert.equal(res.ran, true);
  assert.equal(res.moment, 'complete');
  assert.equal(res.blocksShip, false, 'the complete gate never holds SHIP');
  assert.equal(h.runner.calls.length, 1);
  const call = h.runner.calls[0];
  assert.match(call.command, /^k6 run /);
  assert.doesNotMatch(call.command, /api\/quotes|staging\.example/, 'nothing from TEST_PLAN or the URL on the command line');
  const config = JSON.parse(fs.readFileSync(call.env.LUNA_LOAD_CONFIG, 'utf8'));
  assert.equal(config.scenarios.length, 2);
  assert.ok(config.scenarios.every((s) => s.url.startsWith(`${STAGING_URL}/`)));
  assert.equal(h.todos.length, 1);
  const card = h.todos[0];
  assert.match(card.text, /Load test on staging: p95 latency above 1000 ms/);
  assert.match(card.details, /p95 latency 2400 ms \(limit 1000 ms\)/);
  assert.match(card.details, /k6 summary: 900 requests, 0 failed \(0%\), p95 latency 2400 ms/);
  assert.match(card.details, /GET \/api\/quotes/);
  assert.match(card.details, /load-summary\.json/);
  assert.ok(card.tags.includes(`run:${RUN_ID}`));
  assert.ok(h.events.some((e) => /load test: 1 threshold\(s\) broken/.test(e)));
});

test('flow: thresholds held - no card; before SHIP nothing is held', async (t) => {
  const h = harness(t);
  const res = await h.after(SHIP);
  assert.deepEqual(res, { ran: true, moment: 'preShip', blocksShip: false, breaches: [] });
  assert.deepEqual(h.todos, []);
  assert.ok(h.events.some((e) => /thresholds held/.test(e)));
});

test('flow: a breach before SHIP holds it; the same moment never runs twice (restart)', async (t) => {
  const h = harness(t, { summary: k6Summary({ failed: 0.2 }) });
  const first = await h.after(SHIP);
  assert.equal(first.blocksShip, true);
  assert.match(h.todos[0].text, /error rate above 1% under load/);
  assert.match(h.todos[0].details, /error rate 20% \(limit 1%\)/);
  const again = await h.after(SHIP);
  assert.equal(again.blocksShip, true, 'the stored outcome');
  assert.equal(h.runner.calls.length, 1, 'staging is not hammered again');
  assert.equal(h.todos.length, 1);
  h.run = { ...h.run, iteration: 8 };
  await h.after(SHIP);
  assert.equal(h.runner.calls.length, 2, 'a new iteration runs again');
  assert.equal(h.todos.length, 1, 'the open card is not duplicated');
});

test('flow: autocannon through npx when k6 is missing; a run without a summary is a card, not a hold', async (t) => {
  const h = harness(t, { tool: 'autocannon', runner: fakeRunner(null, { ok: false, detail: 'npm ERR! network' }) });
  const res = await h.after(SHIP);
  assert.equal(res.error, 'runFailed');
  assert.equal(res.blocksShip, false);
  assert.match(h.runner.calls[0].command, /^npx --yes --package=autocannon@8\.0\.0 -- node /);
  assert.match(h.todos[0].text, /could not run/);
  assert.match(h.todos[0].details, /npm ERR! network/);
});

test('flow: no backend or no staging - nothing runs, nothing logged', async (t) => {
  const plain = harness(t, { architecture: 'A static site, no backend.' });
  assert.deepEqual(await plain.after(SHIP), { ran: false, blocksShip: false });
  const local = harness(t, { profile: NO_STAGING, files: ['app/api'] });
  assert.deepEqual(await local.after(COMPLETE), { ran: false, blocksShip: false });
  assert.equal(plain.runner.calls.length + local.runner.calls.length, 0);
  assert.deepEqual([...plain.events, ...local.events], []);
});

// ---- through the real controller -------------------------------------------------------

test('controller: a load-test breach before SHIP holds the SHIP pass', async (t) => {
  const runsRoot = tmpDir(t, 'lw-load-ctl-');
  const h = { todos: [{ at: 1, text: 'card 1', done: false, tags: [`run:${RUN_ID}`], size: 'S' }], playtests: [], stored: null, ctl: null };
  const runner = fakeRunner(k6Summary({ p95: 5000 }));
  const deps = {
    store: { load: () => h.stored, save: (d) => ((h.stored = JSON.parse(JSON.stringify(d))), true) },
    settings: () => ({ models: {}, freeFallback: false, projects: {} }),
    projectOf: (id) => ({ id, repoPath: REPO }),
    profileFor: () => PROFILE,
    packStatus: () => ({ complete: true }),
    godModeActive: () => false,
    todoStore: () => ({ read: () => h.todos, write: (list) => ((h.todos = list), true) }),
    director: async () => ({ ok: true, cards: h.todos.filter((x) => !x.done && x.at === 1), model: 'opus', modelReason: 'setting' }),
    build: async (o) => {
      const ats = new Set(o.cards.map((c) => c.at));
      h.todos = h.todos.map((x) => (ats.has(x.at) ? { ...x, done: true } : x));
      return {
        ok: true,
        planId: 'p1',
        integration: { state: 'done', error: null, skipped: [], selfCheck: { tests: 'passed', fixups: 0, pushedIntegrationBranch: null } },
        plan: { packages: [{ id: 'pk', merged: true, todos: o.cards.map((c) => c.text) }] },
      };
    },
    createAdapter: (name, o) =>
      createAdapter(name, {
        ...o,
        runsRoot,
        spawn: () => assert.fail('nothing is launched locally with staging'),
        fetch: async () => ({ status: 200 }),
        now: () => 0,
        sleep: async () => {},
      }),
    playtest: async (o) => {
      h.playtests.push(o.mode || 'explore');
      return { ok: true, model: 'sonnet', modelReason: 'x', report: { findings: [], scores: [], journeys: [{ name: 'j', passed: true }], screens: [] } };
    },
    shipGate: () => ({ allPassed: true }),
    critic: async () => {
      h.ctl.stop();
      return { ok: true, verdict: 'ship', model: 'opus', modelReason: 'x', milestone: { name: 'Polish', passed: true, score: 95 }, next: null, allPassed: true };
    },
    newRunId: () => RUN_ID,
    now: () => CLOCK,
    setTimer: () => ({}),
    clearTimer: () => {},
    staging: {
      runsRoot: () => runsRoot,
      git: async (cwd, args) => (args[0] === 'rev-parse' ? { ok: true, out: 'a'.repeat(40), err: '' } : { ok: true, out: '', err: '' }),
      runCommand: async () => ({ ok: true, code: 0, detail: '' }),
    },
    load: {
      runCommand: runner.fn,
      detectTool: async () => 'k6',
      readDoc: (repo, file) => (file === 'ARCHITECTURE.md' ? 'API routes on Supabase.' : ''),
      layout: () => [],
      runsRoot: () => runsRoot,
    },
  };
  h.ctl = createLunasWork(deps);
  const started = await h.ctl.start({ projectId: 'game' });
  assert.equal(started.ok, true, JSON.stringify(started));
  await h.ctl.idle();
  assert.equal(h.stored.phase, 'done');
  assert.equal(runner.calls.length, 1, 'one load test before SHIP');
  assert.equal(h.playtests.length, 1, 'no SHIP confirmation pass after a breach');
  assert.notEqual(h.stored.verdict, 'ship');
  assert.ok(h.stored.log.some((e) => /SHIP held: the load test on staging broke a threshold/.test(e.text)));
  assert.ok(h.todos.some((x) => /Load test on staging: p95 latency above/.test(x.text)));
});
