// ============================================================================
// Luna's Work wiring (src/lunasworkWiring.js): syncCheckout fast-forwards the
// project checkout to what God Mode merged on origin (the merge is pushed from
// a separate integration worktree, so the checkout would stay stale). Real git
// in temp folders: an origin, the project checkout, and a second clone that
// stands in for God Mode's push.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { removeDir, patientGitExecFile } = require('../test-support/under-load');

// syncCheckout and iterationDiff cap git at 15-30 s and have no runner seam;
// under load a real git here took longer. Patched before the modules load.
patientGitExecFile(require('child_process'));

const { syncCheckout, createAwake, meteredPass } = require('../src/lunasworkWiring');

// The machine's own autocrlf must not rewrite the test files' line endings.
const git = (cwd, ...args) =>
  execFileSync('git', ['-c', 'core.autocrlf=false', ...args], { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const read = (file) => fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');

function setupRepos() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lw-wiring-'));
  const origin = path.join(dir, 'origin.git');
  const checkout = path.join(dir, 'checkout');
  const other = path.join(dir, 'other');
  git(dir, 'init', '-q', '--bare', '-b', 'main', origin);
  git(dir, 'clone', '-q', origin, checkout);
  git(checkout, 'config', 'user.email', 'test@example.com');
  git(checkout, 'config', 'user.name', 'Test');
  git(checkout, 'config', 'core.autocrlf', 'false');
  git(checkout, 'checkout', '-q', '-b', 'main');
  fs.writeFileSync(path.join(checkout, 'app.js'), 'v1\n');
  fs.mkdirSync(path.join(checkout, 'design'));
  fs.writeFileSync(path.join(checkout, 'design', 'PLAYTEST_LOG.md'), '# log\n');
  git(checkout, 'add', '-A');
  git(checkout, 'commit', '-q', '-m', 'first');
  git(checkout, 'push', '-q', '-u', 'origin', 'main');
  git(dir, 'clone', '-q', '-b', 'main', origin, other);
  git(other, 'config', 'user.email', 'test@example.com');
  git(other, 'config', 'user.name', 'Test');
  git(other, 'config', 'core.autocrlf', 'false');
  /** God Mode's merge: a commit pushed to origin/main from elsewhere. */
  const pushFromElsewhere = (text) => {
    fs.writeFileSync(path.join(other, 'app.js'), text);
    git(other, 'commit', '-q', '-am', `merge ${text.trim()}`);
    git(other, 'push', '-q', 'origin', 'HEAD:refs/heads/main');
    return git(other, 'rev-parse', 'HEAD');
  };
  return { dir, checkout, pushFromElsewhere, done: () => removeDir(dir) };
}

test('syncCheckout fast-forwards the checkout to the merged origin branch', async () => {
  const r = setupRepos();
  try {
    const merged = r.pushFromElsewhere('v2\n');
    assert.notEqual(git(r.checkout, 'rev-parse', 'HEAD'), merged);
    assert.deepEqual(await syncCheckout(r.checkout), { ok: true });
    assert.equal(git(r.checkout, 'rev-parse', 'HEAD'), merged);
    assert.equal(read(path.join(r.checkout, 'app.js')), 'v2\n');
  } finally {
    await r.done();
  }
});

test("syncCheckout keeps the Critic's uncommitted design/ edits that the merge does not touch", async () => {
  const r = setupRepos();
  try {
    fs.writeFileSync(path.join(r.checkout, 'design', 'PLAYTEST_LOG.md'), '# log\n\n## Iteration 1\n');
    const merged = r.pushFromElsewhere('v2\n');
    assert.deepEqual(await syncCheckout(r.checkout), { ok: true });
    assert.equal(git(r.checkout, 'rev-parse', 'HEAD'), merged);
    assert.match(read(path.join(r.checkout, 'design', 'PLAYTEST_LOG.md')), /Iteration 1/);
  } finally {
    await r.done();
  }
});

test('syncCheckout never merges over local work: a diverged checkout is reported, left as it was', async () => {
  const r = setupRepos();
  try {
    fs.writeFileSync(path.join(r.checkout, 'local.txt'), 'mine\n');
    git(r.checkout, 'add', 'local.txt');
    git(r.checkout, 'commit', '-q', '-m', 'local work');
    const before = git(r.checkout, 'rev-parse', 'HEAD');
    r.pushFromElsewhere('v2\n');
    const res = await syncCheckout(r.checkout);
    assert.equal(res.ok, false);
    assert.match(res.detail, /no fast-forward/);
    assert.equal(git(r.checkout, 'rev-parse', 'HEAD'), before);
  } finally {
    await r.done();
  }
});

test('syncCheckout refuses a detached HEAD and a folder that is not a repo', async () => {
  const r = setupRepos();
  try {
    git(r.checkout, 'checkout', '-q', '--detach');
    assert.deepEqual(await syncCheckout(r.checkout), { ok: false, detail: 'not on a branch' });
    const plain = path.join(r.dir, 'plain');
    fs.mkdirSync(plain);
    assert.equal((await syncCheckout(plain)).ok, false);
  } finally {
    await r.done();
  }
});

test('createAwake holds one power-save blocker for the run and releases it once', () => {
  const calls = [];
  let started = false;
  const blocker = {
    start: (kind) => (calls.push(['start', kind]), (started = true), 7),
    isStarted: () => started,
    stop: (id) => (calls.push(['stop', id]), (started = false)),
  };
  const awake = createAwake(blocker);
  awake.hold();
  awake.hold();
  awake.release();
  awake.release();
  assert.deepEqual(calls, [['start', 'prevent-app-suspension'], ['stop', 7]]);
});

// ---- loop-hook deps (src/lunasworkHookDeps.js) ----------------------------------------

const { routesFromTestPlan, iterationDiff, createHookDeps } = require('../src/lunasworkHookDeps');

test('routesFromTestPlan: the root first, same-origin URLs and /paths, no other origin, no duplicates', () => {
  const md = [
    '### Quote',
    '1. Open /quote and fill the form (see `/quote/new`).',
    '2. Download http://localhost:3000/pdf?id=1, compare with https://example.com/other.',
    '3. Back to /quote.',
  ].join('\n');
  assert.deepEqual(routesFromTestPlan(md, 'http://localhost:3000/app'), [
    'http://localhost:3000/',
    'http://localhost:3000/pdf?id=1',
    'http://localhost:3000/quote',
    'http://localhost:3000/quote/new',
  ]);
  assert.deepEqual(routesFromTestPlan('', 'http://localhost:5173'), ['http://localhost:5173/']);
  assert.deepEqual(routesFromTestPlan('/a', 'not a url'), []);
  const many = Array.from({ length: 20 }, (_, i) => `/r${i}`).join(' ');
  assert.equal(routesFromTestPlan(many, 'http://localhost:3000').length, 8, 'capped');
});

test('iterationDiff: from the previous checkpoint tag when there is one, else the last commit', async () => {
  const r = setupRepos();
  try {
    git(r.checkout, 'tag', 'luna-work/lwtest1/iter-1');
    fs.writeFileSync(path.join(r.checkout, 'app.js'), 'v2\n');
    git(r.checkout, 'commit', '-q', '-am', 'second');
    fs.writeFileSync(path.join(r.checkout, 'app.js'), 'v3\n');
    git(r.checkout, 'commit', '-q', '-am', 'third');
    const fromTag = await iterationDiff(r.checkout, 'lwtest1', 2);
    assert.match(fromTag, /-v1\n\+v3/, 'iteration 2 = everything since the iter-1 tag');
    const lastCommit = await iterationDiff(r.checkout, 'lwtest1', 1);
    assert.match(lastCommit, /-v2\n\+v3/);
    // LW 2.23 commits the maps on top: the iteration diff looks past them.
    fs.mkdirSync(path.join(r.checkout, 'docs', 'CODEMAPS'), { recursive: true });
    fs.writeFileSync(path.join(r.checkout, 'docs', 'CODEMAPS', 'overview.md'), '# maps\n');
    git(r.checkout, 'add', '-A');
    git(r.checkout, 'commit', '-q', '-m', "docs(codemaps): refresh after Luna's Work iteration 1");
    const pastMaps = await iterationDiff(r.checkout, 'lwtest1', 1);
    assert.match(pastMaps, /-v2\n\+v3/);
    assert.ok(!pastMaps.includes('CODEMAPS'), 'the maps are left out');
    assert.ok(!(await iterationDiff(r.checkout, 'lwtest1', 2)).includes('CODEMAPS'));
    assert.equal(await iterationDiff(path.join(r.dir, 'nowhere'), 'lwtest1', 2), '');
  } finally {
    await r.done();
  }
});

test('createHookDeps: the second opinion is off without a CLI order; no review due means no call', async () => {
  const off = createHookDeps({ env: () => process.env, settings: () => ({ secondOpinionOrder: [] }) });
  assert.equal(await off.secondOpinion({ isGate: true, repoPath: os.tmpdir(), runId: 'lwtest1', iteration: 1 }), null);
  const on = createHookDeps({ env: () => process.env, settings: () => ({ secondOpinionOrder: ['codex'] }) });
  const notGate = await on.secondOpinion({ isGate: false, repoPath: os.tmpdir(), runId: 'lwtest1', iteration: 1 });
  assert.deepEqual(notGate, { skipped: true, note: 'second opinion skipped: not a milestone gate' });
  const reviews = await on.reviews({ iteration: 1, isGate: false, runId: 'lwtest1', repoPath: os.tmpdir() });
  assert.deepEqual(reviews.due, []);
  assert.equal(await on.lighthouse({ projectId: 'p', repoPath: os.tmpdir(), url: 'not a url' }), null);
  for (const key of ['refreshGraph', 'i18n', 'lighthouse', 'reviews', 'secondOpinion']) assert.equal(typeof on[key], 'function', key);
});

test('createHookDeps: a reviewer set to agy or agy:<id> runs the reviews with that model through the injected runner', async () => {
  const { DEFAULT_MODELS } = require('../src/lunasworkRules');
  const modelsSeen = [];
  const runClaude = async ({ args }) => {
    modelsSeen.push(args[args.indexOf('--model') + 1]);
    return { error: 'failed', detail: 'fake runner' };
  };
  const deps = createHookDeps({ env: () => process.env, settings: () => ({ secondOpinionOrder: [] }), runClaude });
  // Iteration 3: the security review is due.
  const agy = await deps.reviews({ iteration: 3, isGate: false, runId: 'lwtest1', repoPath: os.tmpdir(), models: { reviewer: 'agy' } });
  assert.deepEqual(agy.due, ['security']);
  assert.deepEqual(modelsSeen, ['agy']);
  modelsSeen.length = 0;
  await deps.reviews({ iteration: 3, isGate: false, runId: 'lwtest1', repoPath: os.tmpdir(), models: { reviewer: 'agy:gemini-4-argon-medium' } });
  assert.deepEqual(modelsSeen, ['agy:gemini-4-argon-medium']);

  // Any Claude choice keeps the reviews on runReviews' own default, as before.
  for (const reviewer of ['opus', 'auto', undefined]) {
    modelsSeen.length = 0;
    await deps.reviews({ iteration: 3, isGate: false, runId: 'lwtest1', repoPath: os.tmpdir(), models: { reviewer } });
    assert.deepEqual(modelsSeen, [DEFAULT_MODELS.reviewer], String(reviewer));
  }
  modelsSeen.length = 0;
  await deps.reviews({ iteration: 3, isGate: false, runId: 'lwtest1', repoPath: os.tmpdir() });
  assert.deepEqual(modelsSeen, [DEFAULT_MODELS.reviewer], 'no models at all');
});

test('meteredPass: a Playtester pass outside a run gets its own claude -p tokens as usage', async () => {
  const stdout = JSON.stringify({ type: 'result', total_cost_usd: 0.5, usage: { input_tokens: 120, output_tokens: 30, cache_read_input_tokens: 7 } });
  const fakeExec = (file, args, options, callback) => callback(null, stdout, '');
  const res = await meteredPass(async (meter) => {
    const exec = meter.exec('playtester', fakeExec);
    // The Playtester call and the design-match judge: both claude -p, both booked.
    await new Promise((resolve) => exec('claude', [], {}, resolve));
    await new Promise((resolve) => exec('claude', [], {}, resolve));
    // Anything that is not claude (the app's own commands) is not.
    await new Promise((resolve) => exec('git', [], {}, resolve));
    return { ok: true, report: {} };
  });
  assert.equal(res.ok, true);
  assert.deepEqual(res.usage, { calls: 2, inputTokens: 240, outputTokens: 60, cacheReadTokens: 14, cacheWriteTokens: 0, costUsd: 1 });

  const none = await meteredPass(async () => ({ ok: false, error: 'limit' }));
  assert.deepEqual(none, { ok: false, error: 'limit', usage: { calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 } });
  assert.equal(await meteredPass(async () => null), null);
});

// ---- the account reserve gate on headless steps ------------------------------------

const { createHeadlessRunner, createPlaytestOn } = require('../src/lunasworkWiring');
const { ACCOUNT_ENV } = require('../src/claudeaccounts');

const GATE_NOW = Date.UTC(2026, 10, 22, 12, 0, 0);
const RESERVE_RESET = GATE_NOW + 2 * 60 * 60 * 1000;
const HELD = 'acct-held';
const FREE = 'acct-free';
/** The reserve dep main builds: the held account until its window resets, null otherwise. */
const reserveUntil = (accountId) => (accountId === HELD ? RESERVE_RESET : null);
const envOn = (accountId) => ({ PATH: 'x', [ACCOUNT_ENV]: accountId });

/** A fake execClaude that records every call it was asked to spawn. */
function fakeExec(answer = { stdout: '{"result":"ok"}' }) {
  const calls = [];
  const exec = async (call) => {
    calls.push(call);
    return answer;
  };
  return { calls, exec };
}

test('runHeadless: an account held by its reserve spawns nothing and answers a limit with the reserve reset', async () => {
  const fake = fakeExec();
  const run = createHeadlessRunner({ exec: fake.exec, reserveUntil, now: () => GATE_NOW });
  const res = await run({ args: ['-p', '--model', 'sonnet'], prompt: 'hi', cwd: os.tmpdir(), env: envOn(HELD) });
  assert.equal(fake.calls.length, 0, 'no claude -p was spawned');
  assert.equal(res.error, 'limit');
  assert.equal(res.resumeAt, RESERVE_RESET);
  assert.equal(typeof res.detail, 'string');
  assert.match(res.detail, /reserve/);
});

test('runHeadless: a free account, an env without an account and a missing dep all spawn as before', async () => {
  const fake = fakeExec();
  const gated = createHeadlessRunner({ exec: fake.exec, reserveUntil, now: () => GATE_NOW });
  assert.deepEqual(await gated({ args: ['-p'], env: envOn(FREE) }), { stdout: '{"result":"ok"}' });
  assert.deepEqual(await gated({ args: ['-p'], env: { PATH: 'x' } }), { stdout: '{"result":"ok"}' });
  const ungated = createHeadlessRunner({ exec: fake.exec, now: () => GATE_NOW });
  assert.deepEqual(await ungated({ args: ['-p'], env: envOn(HELD) }), { stdout: '{"result":"ok"}' });
  assert.equal(fake.calls.length, 3);
});

test('runHeadless: a reserve that already reset, or a dep that throws, does not hold the step', async () => {
  const fake = fakeExec();
  const past = createHeadlessRunner({ exec: fake.exec, reserveUntil: () => GATE_NOW - 1, now: () => GATE_NOW });
  await past({ args: ['-p'], env: envOn(HELD) });
  const lines = [];
  const broken = createHeadlessRunner({
    exec: fake.exec,
    reserveUntil: () => { throw new Error('readings gone'); },
    now: () => GATE_NOW,
    log: (line) => lines.push(line),
  });
  await broken({ args: ['-p'], env: envOn(HELD) });
  assert.equal(fake.calls.length, 2);
  assert.match(lines.join('\n'), /readings gone/, 'the failed check is logged, not swallowed');
});

test('runHeadless: an agy call is never held by a Claude account reserve and gets the agy env', async () => {
  const fake = fakeExec();
  const agyEnv = { AGY: '1' };
  const run = createHeadlessRunner({ exec: fake.exec, agyEnv: () => agyEnv, reserveUntil, now: () => GATE_NOW });
  await run({ args: ['-p', '--model', 'agy'], env: envOn(HELD) });
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0].agyEnv, agyEnv);
});

test('a role wrapper keeps the reserve resumeAt: the Director over the gated runner', async () => {
  const fake = fakeExec();
  const runClaude = createHeadlessRunner({ exec: fake.exec, reserveUntil, now: () => GATE_NOW });
  const { runDirector } = require('../src/lunasworkDirector');
  const Pack = require('../src/lunasworkPack');
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lw-wiring-dir-'));
  try {
    assert.equal(Pack.scaffoldPack(repoDir).ok, true);
    const list = [{ text: 'Card 1', done: false, at: 1, tags: ['run:gate-1', 'kind:feel', 'sev:medium'] }];
    const res = await runDirector({
      repoDir, runId: 'gate-1', iteration: 2, env: envOn(HELD), runClaude, log: () => {},
      todoStore: { read: () => list, write: () => assert.fail('no writes') },
    });
    assert.equal(fake.calls.length, 0);
    assert.equal(res.error, 'limit');
    assert.equal(res.resumeAt, RESERVE_RESET);
  } finally {
    await removeDir(repoDir);
  }
});

test('playtestOn: the Playtester call carries the reserve gate for its env', async () => {
  const seen = [];
  const runPlaytestImpl = async (opts) => {
    seen.push(opts);
    return { ok: true };
  };
  const meter = { exec: (_role, impl) => impl };
  const on = createPlaytestOn({
    env: () => envOn(HELD), freeEnv: () => ({ PATH: 'free' }), agyEnv: () => null,
    reserveUntil, now: () => GATE_NOW, run: runPlaytestImpl,
  });
  await on(meter)({ free: false, mode: 'explore' });
  await on(meter)({ free: true, mode: 'explore' });
  assert.equal(seen.length, 2);
  assert.equal(seen[0].env[ACCOUNT_ENV], HELD);
  const held = seen[0].gate(seen[0].env);
  assert.equal(held.error, 'limit');
  assert.equal(held.resumeAt, RESERVE_RESET);
  assert.equal(seen[1].gate(seen[1].env), null, 'the free providers have no Claude account to hold');
  assert.equal(seen[0].gate(envOn(FREE)), null);
});

test('createHookDeps: Lighthouse runs its claude -p through the injected (reserve-gated) runner', async () => {
  const calls = [];
  const runClaude = async (call) => {
    calls.push(call);
    return { error: 'limit', detail: 'the Claude account is at its usage reserve', resumeAt: RESERVE_RESET };
  };
  const deps = createHookDeps({ env: () => envOn(HELD), settings: () => ({ secondOpinionOrder: [] }), runClaude });
  const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'lw-wiring-lh-'));
  try {
    const res = await deps.lighthouse({ projectId: 'p', repoPath, url: 'http://localhost:3000' });
    assert.equal(calls.length, 1, 'the injected runner, never the default execClaude');
    assert.equal(calls[0].env[ACCOUNT_ENV], HELD);
    assert.deepEqual(res.results, []);
  } finally {
    await removeDir(repoPath);
  }
});
