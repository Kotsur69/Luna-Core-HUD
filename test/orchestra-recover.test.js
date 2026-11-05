// ============================================================================
// God Mode recovery playbook (src/orchestraRecover.js): each row fixes its
// stall automatically within its attempt limit, the same cause after its fix
// asks Mati once (pl + en), fixes land in the stall history and the run
// report, unknown causes stall as before and are logged (secrets redacted).
// Fake secrets are assembled at runtime, never written as literals.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');

const rec = require('../src/orchestraRecover.js');
const { createOrchestra } = require('../src/orchestra.js');
const { buildReport } = require('../src/orchestraReport.js');
const { createVerifyQueue } = require('../src/verifyQueue.js');
const { finishPackage } = require('../src/orchestraFinish.js');

const MIN = 60 * 1000;
const tick = () => new Promise((r) => setImmediate(r));
const flush = async (n = 8) => {
  for (let i = 0; i < n; i += 1) await tick();
};
// A GitHub-token-shaped fake, built from parts.
const fakeToken = () => ['gh', 'p_', 'Z'.repeat(20), '9'.repeat(16)].join('');

const ROOT = path.join('/wt', 'a-1');

/** A recoverer over one in-memory package, every side effect recorded. */
function harness(opts = {}) {
  const clock = { t: 1_000_000 };
  const pkgs = new Map([['a', { id: 'a', root: ROOT, branch: 'luna/a-1', stallHistory: [], ...(opts.pkg || {}) }]]);
  const calls = [];
  const asks = [];
  const logs = [];
  const timers = [];
  const run = [];
  const recoverer = rec.createRecoverer({
    getPkg: (id) => pkgs.get(id),
    findByRoot: (dir) => [...pkgs.values()].find((p) => p.root === dir) || null,
    record: (id, entry) => {
      const p = pkgs.get(id);
      pkgs.set(id, { ...p, stallHistory: [...p.stallHistory, entry] });
    },
    recordRun: (entry) => run.push(entry),
    repoPath: () => '/repo',
    installDeps: async (root, o) => {
      calls.push(['install', root, o]);
      return opts.install ? opts.install(root) : { ok: true, output: 'added 300 packages' };
    },
    checkDeps: (root) => (opts.check ? opts.check(root) : { ok: true }),
    refinish: (id, extra) => calls.push(['refinish', id, extra]),
    fixupRound: (id, res) => calls.push(['fixup', id, res.stage]),
    renameBranch: async (root, from, to) => {
      calls.push(['rename', from, to]);
      return opts.rename ? opts.rename(to) : { ok: true };
    },
    setBranch: (id, branch) => pkgs.set(id, { ...pkgs.get(id), branch }),
    ghAuthOk: async () => (opts.auth === undefined ? true : opts.auth),
    stall: (id, reason, detail) => calls.push(['stall', id, reason, detail]),
    resumeHeld: () => calls.push(['resumeHeld']),
    holdUnfixed: (res, asked) => calls.push(['holdUnfixed', asked]),
    refinishRun: () => calls.push(['refinishRun']),
    failover: opts.failover,
    notify: (ask) => asks.push(ask),
    now: () => clock.t,
    setTimer: (fn, ms) => {
      const t = { fn, ms, cleared: false };
      timers.push(t);
      return t;
    },
    clearTimer: (t) => {
      if (t) t.cleared = true;
    },
    log: (line) => logs.push(line),
  });
  return {
    r: recoverer,
    pkg: (id = 'a') => pkgs.get(id),
    calls,
    asks,
    logs,
    timers,
    run,
    clock,
    /** Fires the newest pending timer; returns its delay. */
    fire: () => {
      const t = timers.filter((x) => !x.cleared).pop();
      t.cleared = true;
      t.fn();
      return t.ms;
    },
    attempts: (cause) => rec.attemptsFor(pkgs.get('a').stallHistory, cause),
  };
}

const names = (calls) => calls.map((c) => c[0]);

// ---- the playbook table -------------------------------------------------------

test('every playbook row names an action and an attempt limit', () => {
  const expected = {
    depsMissing: ['npmCi', 1],
    secretFound: ['fixupRound', 1],
    pushBlocked: ['fixupRound', 1],
    branchTaken: ['pushRenamed', 2],
    network: ['retryBackoff', 3],
    auth: ['retryBackoff', 3],
    verifyTimeout: ['reverifyLonger', 1],
    verifyLoad: ['reverifyLonger', 1],
    stepHung: ['restartStep', 1],
    usageLimit: ['failover', null],
    wakeGit: ['retryLaunch', 1],
  };
  assert.deepEqual(Object.keys(rec.PLAYBOOK).sort(), Object.keys(expected).sort());
  for (const [cause, [action, max]] of Object.entries(expected)) {
    assert.equal(rec.PLAYBOOK[cause].action, action, cause);
    assert.equal(rec.PLAYBOOK[cause].maxAttempts, max, cause);
    assert.ok(rec.PLAYBOOK[cause].label, `${cause} has a label for the report`);
  }
  assert.deepEqual(rec.BACKOFF_MS, [1 * MIN, 5 * MIN, 15 * MIN]);
});

test('classify reads the cause from what git, npm and the tests said', () => {
  const c = rec.classify;
  assert.equal(c({ stage: 'verify', output: "Error: Cannot find module 'left-pad'\nRequire stack:" }), 'depsMissing');
  assert.equal(c({ stage: 'verify', output: 'code: MODULE_NOT_FOUND' }), 'depsMissing');
  assert.equal(c({ stage: 'verify', output: 'not ok 3 - x\n  error: test timed out after 30000ms' }), 'verifyLoad');
  assert.equal(c({ stage: 'verify', output: 'AssertionError [ERR_ASSERTION]: 1 !== 2' }), null, "a real failure is the worker's");
  assert.equal(c({ stage: 'verifyTimeout' }), 'verifyTimeout');
  assert.equal(c({ stage: 'secrets' }), 'secretFound');
  assert.equal(c({ stage: 'push', blocked: 'secret' }), 'pushBlocked');
  assert.equal(c({ stage: 'push', detail: ' ! [rejected]        luna/a-1 -> luna/a-1 (fetch first)' }), 'branchTaken');
  assert.equal(c({ stage: 'push', detail: "fatal: unable to access 'https://github.com/x/y/': Could not resolve host: github.com" }), 'network');
  assert.equal(c({ stage: 'push', detail: "fatal: Authentication failed for 'https://github.com/x/y/'" }), 'auth');
  assert.equal(c({ stage: 'fetch', detail: 'ssh: connect to host github.com port 22: Connection timed out' }), 'network');
  assert.equal(c({ stage: 'push', detail: 'fatal: something new' }), 'unknown');
  assert.equal(c({ stage: 'launch', error: 'notRepo', afterWake: true }), 'wakeGit');
  assert.equal(c({ stage: 'launch', error: 'notRepo', afterWake: false }), 'unknown');
});

// ---- one unit test per row ----------------------------------------------------

test('depsMissing: npm ci in the package worktree, verify again - once', async () => {
  const h = harness();
  const res = { ok: false, stage: 'verify', output: "Error: Cannot find module 'left-pad'" };
  assert.equal(h.r.onFinish(h.pkg(), res), true);
  await flush();
  assert.deepEqual(h.calls, [
    ['install', ROOT, { fresh: true }],
    ['refinish', 'a', {}],
  ]);
  assert.equal(h.attempts('depsMissing'), 1);
  assert.match(h.pkg().stallHistory[0].detail, /npm ci --ignore-scripts in the package worktree.*: ok/);
  // Comes back after its fix: no second install.
  assert.equal(h.r.onFinish(h.pkg(), res), false);
  await flush();
  assert.equal(h.calls.filter((c) => c[0] === 'install').length, 1);
});

test('depsMissing: never installs in the main checkout; a failed install stalls installFailed', async () => {
  const main = harness({ pkg: { root: '/repo' } });
  main.r.onFinish(main.pkg(), { ok: false, stage: 'verify', output: 'Cannot find module x' });
  await flush();
  assert.ok(!names(main.calls).includes('install'), 'no npm ci outside a package worktree');
  assert.deepEqual(main.calls[0].slice(0, 3), ['stall', 'a', 'installFailed']);

  const broken = harness({ install: () => ({ ok: false, output: 'npm ERR! code ECONNRESET' }) });
  broken.r.onFinish(broken.pkg(), { ok: false, stage: 'verify', output: 'Cannot find module x' });
  await flush();
  assert.deepEqual(broken.calls[1], ['stall', 'a', 'installFailed', 'npm ERR! code ECONNRESET']);

  // npm can echo a registry URL with its token: never stored as-is.
  const token = fakeToken();
  const leaky = harness({ install: () => ({ ok: false, output: `npm ERR! 401 GET https://x/registry
npm ERR! NPM_TOKEN=${token}` }) });
  leaky.r.onFinish(leaky.pkg(), { ok: false, stage: 'verify', output: 'Cannot find module x' });
  await flush();
  assert.ok(!JSON.stringify(leaky.calls).includes(token), 'not in the stall detail');
  assert.ok(!JSON.stringify(leaky.pkg().stallHistory).includes(token), 'not in the history');
});

test('depsMissing on the hold: install in the held worktree, then Resume on its own', async () => {
  const h = harness();
  assert.equal(h.r.onHold({ dir: ROOT, detail: 'empty' }), true);
  await flush();
  assert.deepEqual(names(h.calls), ['install', 'resumeHeld']);
  assert.equal(h.r.onHold({ dir: ROOT, detail: 'empty' }), false, 'the limit is one install');
  assert.equal(h.r.onHold({ dir: '/elsewhere' }), false, 'only a package worktree');

  const still = harness({ check: () => ({ ok: false, detail: 'still empty' }) });
  still.r.onHold({ dir: ROOT });
  await flush();
  assert.deepEqual(names(still.calls), ['install', 'holdUnfixed']);
  assert.equal(still.asks.length, 1, 'asked once');
  assert.equal(still.calls[1][1], true, 'the hold message knows the ask went out');
});

test('secretFound and pushBlocked: one fix-up round each, then no more', () => {
  for (const [res, cause] of [
    [{ ok: false, stage: 'secrets', hits: [], range: 'b..HEAD' }, 'secretFound'],
    [{ ok: false, stage: 'push', blocked: 'secret', detail: 'GH013' }, 'pushBlocked'],
  ]) {
    const h = harness();
    assert.equal(h.r.onFinish(h.pkg(), res), true, cause);
    assert.deepEqual(h.calls, [['fixup', 'a', res.stage]]);
    assert.equal(h.attempts(cause), 1);
    assert.equal(h.r.onFinish(h.pkg(), res), false, `${cause}: a second round is not automatic`);
    assert.equal(h.calls.length, 1);
  }
});

test('branchTaken: push under a suffixed branch name, twice at most', async () => {
  const h = harness();
  const res = { ok: false, stage: 'push', detail: ' ! [rejected] luna/a-1 -> luna/a-1 (non-fast-forward)', headSha: 'abc1234' };
  assert.equal(h.r.onFinish(h.pkg(), res), true);
  await flush();
  assert.deepEqual(h.calls, [
    ['rename', 'luna/a-1', 'luna/a-1-r2'],
    ['refinish', 'a', { verifiedSha: 'abc1234' }],
  ]);
  assert.equal(h.pkg().branch, 'luna/a-1-r2');
  h.r.onFinish(h.pkg(), res);
  await flush();
  assert.deepEqual(h.calls[2], ['rename', 'luna/a-1-r2', 'luna/a-1-r3']);
  assert.equal(h.r.onFinish(h.pkg(), res), false, 'limit 2');
  assert.equal(rec.suffixedBranch('luna-free/x', 1), 'luna-free/x-r2');
  assert.equal(rec.suffixedBranch('main', 1), null, 'never a non-LunaCore branch');

  const refused = harness({ rename: () => ({ ok: false, detail: 'fatal: a branch named luna/a-1-r2 already exists' }) });
  refused.r.onFinish(refused.pkg(), res);
  await flush();
  assert.deepEqual(refused.calls[1].slice(0, 3), ['stall', 'a', 'pushFailed']);
});

test('network: push again after 1, 5 and 15 min, then stop', async () => {
  const h = harness();
  const res = { ok: false, stage: 'push', detail: 'fatal: unable to access: Could not resolve host: github.com', headSha: 'abc1234' };
  const delays = [];
  for (let i = 0; i < 3; i += 1) {
    assert.equal(h.r.onFinish(h.pkg(), res), true);
    await flush();
    assert.equal(h.r.pending('a'), true, 'waiting for the timer');
    delays.push(h.fire());
  }
  assert.deepEqual(delays, [1 * MIN, 5 * MIN, 15 * MIN]);
  assert.deepEqual(
    h.calls.filter((c) => c[0] === 'refinish'),
    [1, 2, 3].map(() => ['refinish', 'a', { verifiedSha: 'abc1234' }]),
  );
  assert.equal(h.r.onFinish(h.pkg(), res), false, 'limit 3');
  assert.equal(h.attempts('network'), 3);
});

test('auth: gh auth status failing asks at once, a good one retries with backoff', async () => {
  const res = { ok: false, stage: 'push', detail: 'remote: Permission to x/y.git denied to bot.\nfatal: The requested URL returned error: 403' };
  const bad = harness({ auth: false });
  assert.equal(bad.r.onFinish(bad.pkg(), res), true);
  await flush();
  assert.deepEqual(bad.calls[0].slice(0, 3), ['stall', 'a', 'pushFailed']);
  assert.equal(bad.timers.length, 0, 'no retry with expired credentials');
  assert.match(bad.pkg().stallHistory[0].detail, /gh auth status: failed/);

  const good = harness({ auth: true });
  assert.equal(good.r.onFinish(good.pkg(), res), true);
  await flush();
  assert.equal(good.timers[0].ms, 1 * MIN);
  assert.ok(!names(good.calls).includes('stall'));
});

test('verifyTimeout and verifyLoad: verify again alone with a longer limit - once', () => {
  for (const res of [
    { ok: false, stage: 'verifyTimeout', detail: 'ran past the 30 min limit twice' },
    { ok: false, stage: 'verify', output: 'not ok 4 - slow\n  error: test timed out after 30000ms\nEBUSY: resource busy or locked' },
  ]) {
    const h = harness();
    assert.equal(h.r.onFinish(h.pkg(), res), true, res.stage);
    assert.deepEqual(h.calls, [['refinish', 'a', { verifyLimitMs: 60 * MIN, verifyReruns: 0 }]]);
    assert.equal(h.r.onFinish(h.pkg(), res), false, 'then it counts as failed');
  }
  const real = harness();
  assert.equal(real.r.onFinish(real.pkg(), { ok: false, stage: 'verify', output: 'AssertionError: expected 2' }), false);
  assert.deepEqual(real.calls, [], 'a real test failure goes to the worker untouched');
});

test('the verify queue honours the longer limit and the re-run count of a playbook re-run', async () => {
  const seen = [];
  const q = createVerifyQueue({
    runImpl: async (cmd, cwd, o) => {
      seen.push(o.timeoutMs);
      return { ok: false, output: 'slow', timedOut: true };
    },
  });
  const res = await q.run('npm test', '/wt/a', { limitMs: 60 * MIN, timeoutReruns: 0 });
  assert.deepEqual(seen, [60 * MIN], 'one run, with the longer limit');
  assert.equal(res.timedOut, true);
});

test('stepHung: a finish step that never settles after a wake is aborted and run again - once', async () => {
  const h = harness();
  const never = new Promise(() => {});
  let settled = null;
  h.r.guardStep('a', () => never).then((r) => {
    settled = r;
  });
  // No wake: never aborted, however long it runs.
  h.clock.t += 10 * 60 * MIN;
  h.r.tick();
  h.r.onWake();
  h.clock.t += rec.STEP_WAKE_GRACE_MS - 1;
  h.r.tick();
  await flush();
  assert.equal(settled, null, 'still inside the grace');
  h.clock.t += 2;
  h.r.tick();
  await flush();
  assert.equal(settled.stage, 'stepHung');
  assert.equal(h.r.onFinish(h.pkg(), settled), true);
  assert.deepEqual(h.calls, [['refinish', 'a', {}]]);
  assert.equal(h.r.onFinish(h.pkg(), settled), false, 'limit 1');

  // The abandoned step is told, so its queued verify is skipped.
  const z = harness();
  let handle = null;
  z.r.guardStep('a', (hd) => {
    handle = hd;
    return never;
  });
  await flush();
  assert.equal(handle.isAborted(), false);
  z.r.onWake();
  z.clock.t += rec.STEP_WAKE_GRACE_MS + 1;
  z.r.tick();
  assert.equal(handle.isAborted(), true);

  // Waiting in the verify queue / for the charger is not hanging.
  const w = harness();
  let waited = null;
  w.r.guardStep('a', () => never).then((r) => {
    waited = r;
  });
  w.r.onWake();
  w.r.stepWaiting('a');
  w.clock.t += 3 * rec.STEP_WAKE_GRACE_MS;
  w.r.tick();
  await flush();
  assert.equal(waited, null, 'a long queue wait after a wake is not aborted');

  // Progress (the verify starting) after the wake restarts the grace.
  const g = harness();
  let other = null;
  g.r.guardStep('a', () => never).then((r) => {
    other = r;
  });
  g.r.onWake();
  g.clock.t += rec.STEP_WAKE_GRACE_MS - 10;
  g.r.stepProgress('a');
  g.clock.t += 20;
  g.r.tick();
  await flush();
  assert.equal(other, null);
});

test('usageLimit: failover to another account, else pause until the reset - never escalated', () => {
  const free = harness({ failover: () => true });
  assert.equal(free.r.onUsageLimit(free.pkg(), 2_000_000), 'failover');
  const none = harness({ failover: () => false });
  for (let i = 0; i < 5; i += 1) assert.equal(none.r.onUsageLimit(none.pkg(), 2_000_000), 'pause');
  assert.equal(none.asks.length, 0, 'the pause resumes on its own');
  // Run-level (one account for the whole run): the package history keeps its room.
  assert.equal(none.run.length, 5);
  assert.match(none.run[0].detail, /^a: account failover.*paused until .* resumes on its own/);
  assert.deepEqual(none.pkg().stallHistory, []);
  assert.equal(rec.decide([], 'usageLimit').type, 'act', 'no attempt limit');
});

test('wakeGit: worktree notRepo / gitFailed just after a wake waits 30 s and retries once', () => {
  const h = harness();
  assert.equal(h.r.onLaunchFailed(h.pkg(), { error: 'notRepo' }), null, 'no wake, no playbook');
  h.r.onWake();
  h.clock.t += 60 * 1000;
  assert.deepEqual(h.r.onLaunchFailed(h.pkg(), { error: 'notRepo' }), { delayMs: 30 * 1000 });
  assert.equal(h.r.onLaunchFailed(h.pkg(), { error: 'gitFailed' }), null, 'once');
  assert.equal(h.r.onLaunchFailed(h.pkg(), { error: 'gitFailed', retryable: true }), null, 'the transient ladder owns retryable');
  assert.equal(h.r.onTerminal(h.pkg(), 'gitFailed'), true, 'then asked once');
  const late = harness();
  late.r.onWake();
  late.clock.t += rec.WAKE_WINDOW_MS + 1;
  assert.equal(late.r.onLaunchFailed(late.pkg(), { error: 'gitFailed' }), null, 'long after the wake');
});

test('integration fetch / push on the network: retried after a backoff, then asked once', () => {
  const h = harness();
  const integ = { state: 'failed', error: 'fetchFailed', detail: 'fatal: unable to access: Could not resolve host: github.com' };
  const delays = [];
  for (let i = 0; i < 3; i += 1) {
    assert.equal(h.r.onIntegration(integ), true);
    delays.push(h.fire());
  }
  assert.deepEqual(delays, [1 * MIN, 5 * MIN, 15 * MIN]);
  assert.equal(names(h.calls).filter((n) => n === 'refinishRun').length, 3);
  assert.equal(h.r.onIntegration(integ), false);
  assert.equal(h.r.onIntegration(integ), false);
  assert.equal(h.asks.length, 1, 'asked once');
  assert.equal(h.asks[0].pkgId, null);
  assert.deepEqual(h.run.map((e) => e.kind), ['recover', 'recover', 'recover', 'ask']);
  assert.equal(h.r.onIntegration({ state: 'failed', error: 'mergeFailed', detail: 'x' }), false);

  // Counted per plan: the next run gets its own attempts.
  const p = harness();
  for (let i = 0; i < 3; i += 1) p.r.onIntegration(integ, 'run1');
  assert.equal(p.r.onIntegration(integ, 'run1'), false);
  assert.equal(p.r.onIntegration(integ, 'run2'), true);
});

// ---- loop guard + ask once ------------------------------------------------------

test('the same cause after its fix escalates once with a pl + en notification and stops retrying', () => {
  const h = harness();
  const res = { ok: false, stage: 'verifyTimeout', detail: 'ran past the limit twice' };
  assert.equal(h.r.onFinish(h.pkg(), res), true);
  // The longer re-run timed out too: orchestra stalls it, nothing automatic left.
  assert.equal(h.r.onFinish(h.pkg(), res), false);
  assert.equal(h.r.onTerminal(h.pkg(), 'verifyTimeout'), true);
  assert.equal(h.r.onTerminal(h.pkg(), 'verifyTimeout'), false, 'once');
  assert.equal(h.asks.length, 1);
  const { text, tried, cause } = h.asks[0];
  assert.equal(cause, 'verifyTimeout');
  assert.equal(tried.length, 1);
  assert.match(text.en.title, /God Mode needs you/);
  assert.match(text.en.body, /^a: verify ran past its limit\. Tried: .*Next: run the verify command in .*a-1/);
  assert.match(text.pl.body, /^a: weryfikacja przekroczyla limit czasu\. Proba: .*Nastepny krok:/);
  assert.doesNotMatch(text.pl.body, /[ąćęłńóśźżĄĆĘŁŃÓŚŹŻ]/, 'pl without diacritics');
  assert.equal(h.calls.filter((c) => c[0] === 'refinish').length, 1, 'no more retries');

  // A manual Retry gives fresh attempts.
  h.r.onManualRetry('a');
  assert.equal(h.r.onFinish(h.pkg(), res), true);
});

test("a terminal stop without an automatic attempt keeps today's behaviour (no ask)", () => {
  const h = harness();
  assert.equal(h.r.onTerminal(h.pkg(), 'verifyTimeout'), false);
  assert.equal(h.r.onTerminal(h.pkg(), 'noMarker'), false, "worker reasons are not the playbook's");
  assert.equal(h.asks.length, 0);
  assert.equal(h.logs.length, 0);
});

test('every cause has an ask text in pl and en, and the board finds the open ask', async () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'i18n.js'), 'utf8');
  const texts = rec.parseAskTexts(src);
  for (const cause of Object.keys(rec.PLAYBOOK)) {
    for (const lang of ['pl', 'en']) {
      const body = texts[lang][`orch.recover.ask.${cause}`];
      assert.ok(body, `${lang} ${cause}`);
      assert.match(body, /\{pkg\}/, `${lang} ${cause} names the package`);
    }
  }
  assert.ok(texts.pl['orch.recover.title'] && texts.en['orch.recover.title']);
  assert.notEqual(texts.pl['orch.recover.ask.network'], texts.en['orch.recover.ask.network']);
  // Beside the related hold message.
  const hold = src.indexOf("'orch.noNodeModules'");
  assert.ok(src.indexOf("'orch.recover.title'", hold) - hold < 200);

  const { recoverAsk, RECOVER_ASK_CAUSES } = await import('../src/renderer/modules/orchestraState.js');
  assert.deepEqual([...RECOVER_ASK_CAUSES].sort(), Object.keys(rec.PLAYBOOK).sort());
  const asked = { stallHistory: [{ kind: 'recover', reason: 'network' }, { kind: 'ask', reason: 'network' }] };
  assert.deepEqual(recoverAsk(asked), { key: 'orch.recover.ask.network', cause: 'network' });
  assert.equal(recoverAsk({ stallHistory: [...asked.stallHistory, { kind: 'retry', reason: 'manual' }] }), null);
  assert.equal(recoverAsk({}), null);
});

// ---- unknown causes -------------------------------------------------------------

test('an unknown cause is logged with the full output, secret values redacted', () => {
  const h = harness();
  const token = fakeToken();
  const res = { ok: false, stage: 'push', detail: `remote: something LunaCore never saw\nremote: GH_TOKEN=${token}\nline 3` };
  assert.equal(h.r.onFinish(h.pkg(), res), false, 'stalls as before');
  assert.equal(h.logs.length, 1);
  assert.match(h.logs[0], /unknown stall cause \(push\)/);
  assert.match(h.logs[0], /something LunaCore never saw/);
  assert.match(h.logs[0], /line 3/, 'the whole output, not the first line');
  assert.ok(!h.logs[0].includes(token), 'never the secret value');
});

// ---- through the run controller -------------------------------------------------

const turn = (text) =>
  JSON.stringify({ type: 'assistant', message: { stop_reason: 'end_turn', content: [{ type: 'text', text }] } });

/** A one-package God Mode run; finish(p, n) decides each finishPackage result. */
async function oneRun(finish) {
  let seq = 0;
  const log = { writes: [], finishes: [], events: [], installs: [], asks: [], lines: [], timers: [] };
  const alive = new Set();
  const orch = createOrchestra({
    now: () => 1_000_000,
    readTodos: () => [{ at: 1, text: 't1', done: false }],
    dirtyCount: async () => 0,
    runPlanner: async () => ({
      ok: true,
      raw: { packages: [{ id: 'a', title: 'A', todoAts: [1], prompt: 'do a', files: [], dependsOn: [], verify: 'npm test', model: 'opus' }], notes: '' },
      costUsd: 0,
    }),
    addWorktree: async (repo, name) => ({ ok: true, root: path.join('/wt', name), cwd: path.join('/wt', name), branch: `luna/${name}` }),
    headSha: async () => 'base',
    briefDir: () => '/cfg/tasks',
    writeBrief: () => true,
    createSession: () => {
      seq += 1;
      alive.add(`s${seq}`);
      return { id: `s${seq}` };
    },
    finishPackage: async (p) => {
      log.finishes.push({ ...p });
      return finish(p, log.finishes.length);
    },
    installDeps: async (root, opts) => {
      log.installs.push([root, opts || {}]);
      return { ok: true, output: '' };
    },
    checkDeps: () => ({ ok: true, needed: true }),
    writePty: (sessionId, text) => {
      log.writes.push([sessionId, text]);
      return alive.has(sessionId);
    },
    sessionAlive: (id) => alive.has(id),
    workerSettings: () => ({ model: 'opus', permissionMode: 'bypassPermissions' }),
    onRunEvent: (kind) => log.events.push(kind),
    notifyRecover: (ask) => log.asks.push(ask),
    log: (line) => log.lines.push(line),
    setTimer: (fn, ms) => {
      const t = { fn, ms };
      log.timers.push(t);
      return t;
    },
    clearTimer: () => {},
  });
  orch.restore();
  const { plan } = await orch.makePlan({ projectId: 'p1', repoPath: '/repo', profileId: 'cloud', env: {} });
  await orch.launch({ planId: plan.id });
  const done = async () => {
    orch.onTurnEnd('s1', turn('LUNA_DONE a'));
    await flush(12);
  };
  const view = () => orch.view().packages[0];
  return { orch, log, done, view };
}

test('a missing-dependencies verify failure is fixed by npm ci in the worktree and the package continues', async () => {
  const r = await oneRun((p, n) =>
    n === 1
      ? { ok: false, stage: 'verify', output: "Error: Cannot find module 'left-pad'\nRequire stack:\n- test/x.test.js" }
      : { ok: true, headSha: 'f00d' },
  );
  const root = r.log.installs[0][0];
  r.log.installs.length = 0;
  await r.done();
  assert.deepEqual(r.log.installs, [[root, { fresh: true }]], 'npm ci in the package worktree, from scratch');
  assert.notEqual(root, '/repo');
  assert.equal(r.log.finishes.length, 2, 'verified again after the install');
  assert.equal(r.view().state, 'pushed');
  assert.ok(!r.log.writes.some(([, t]) => /Cannot find module/.test(t)), 'never pasted to the worker as a test failure');
  assert.deepEqual(r.log.asks, []);

  const md = buildReport(r.orch.view(), { now: 2_000_000, suggestions: [] });
  assert.match(md, /## Automatic fixes/);
  assert.match(md, /`a` `depsMissing`: fixed automatically - `npm ci --ignore-scripts in the package worktree, then verify again: ok`/);
});

test('a GH013 rejection gets one fix-up round, not repeated identical retries, then one pl + en ask', async () => {
  const blocked = {
    ok: false,
    stage: 'push',
    blocked: 'secret',
    detail: 'remote: error: GH013: Repository rule violations found\nremote: - Push cannot contain secrets',
    headSha: 'f00d',
  };
  const r = await oneRun(() => blocked);
  await r.done();
  assert.equal(r.view().state, 'launched', 'first rejection -> one fix-up round with the worker');
  assert.equal(r.log.finishes.length, 1);
  assert.equal(r.log.writes.filter(([, t]) => /GH013/.test(t)).length, 1);

  await r.done();
  const v = r.view();
  assert.deepEqual([v.state, v.error, v.terminal], ['stalled', 'pushBlocked', true]);
  assert.equal(r.log.finishes.length, 2, 'no third push');
  assert.equal(r.log.writes.filter(([, t]) => /GH013/.test(t)).length, 1, 'no second round');
  assert.equal(r.log.asks.length, 1, 'asked once');
  assert.equal(r.log.events.filter((k) => k === 'recoverAsk').length, 1);
  assert.match(r.log.asks[0].text.en.body, /GitHub rejected the push \(GH013\)/);
  assert.match(r.log.asks[0].text.pl.body, /GitHub odrzucil push \(GH013\)/);

  const md = buildReport(r.orch.view(), { now: 2_000_000, suggestions: [] });
  assert.match(md, /`pushBlocked`: fixed automatically - `one fix-up worker round/);
  assert.match(md, /`pushBlocked`: asked you once/);
});

test('a push the network refused is retried after the backoff without verifying the same HEAD again', async () => {
  const r = await oneRun((p, n) =>
    n === 1
      ? { ok: false, stage: 'push', detail: "fatal: unable to access 'https://github.com/x/y/': Could not resolve host: github.com", headSha: 'beef1234' }
      : { ok: true, headSha: 'beef1234' },
  );
  await r.done();
  assert.equal(r.view().state, 'finishing', 'waiting for the retry, not stalled');
  const retry = r.log.timers.find((t) => t.ms === 1 * MIN);
  assert.ok(retry, 'scheduled 1 min out');
  retry.fn();
  await flush(12);
  assert.equal(r.log.finishes.length, 2);
  assert.equal(r.log.finishes[1].verifiedSha, 'beef1234', 'the verified HEAD skips its verify');
  assert.equal(r.view().state, 'pushed');
});

test('finishPackage skips the verify of a HEAD that already passed it', async () => {
  const execImpl = (cmd, args, opts, cb) => {
    if (args.includes('rev-parse')) return cb(null, 'beef1234\n', '');
    if (args.includes('rev-list')) return cb(null, '1\n', '');
    return cb(null, '', '');
  };
  let verified = 0;
  const verifyImpl = async () => {
    verified += 1;
    return { ok: true, output: '' };
  };
  const pkg = { id: 'a', root: '/wt/a', cwd: '/wt/a', branch: 'luna/a', baseSha: 'base', verify: 'npm test' };
  const res = await finishPackage({ ...pkg, verifiedSha: 'beef1234' }, { isDirImpl: () => true, execImpl, verifyImpl });
  assert.equal(res.ok, true);
  assert.equal(verified, 0);
  await finishPackage({ ...pkg, verifiedSha: 'other00' }, { isDirImpl: () => true, execImpl, verifyImpl });
  assert.equal(verified, 1, 'a different HEAD is verified');
});

test('an unknown cause stalls as before, with its diagnosis, and logs stderr', async () => {
  const token = fakeToken();
  const r = await oneRun(() => ({ ok: false, stage: 'push', detail: `error: hook declined\nremote: token=${token}\nremote: see docs` }));
  await r.done();
  const v = r.view();
  assert.deepEqual([v.state, v.error, v.terminal], ['stalled', 'pushFailed', true], "today's behaviour");
  assert.deepEqual(r.log.asks, [], 'nothing was tried, nothing asked');
  const logged = r.log.lines.filter((l) => /unknown stall cause/.test(l));
  assert.ok(logged.length >= 1);
  assert.match(logged[0], /hook declined[\s\S]*see docs/);
  assert.ok(!r.log.lines.some((l) => l.includes(token)), 'secret value redacted');
  const md = buildReport(r.orch.view(), { now: 2_000_000, suggestions: [] });
  assert.match(md, /## What went wrong/);
  assert.match(md, /## Automatic fixes\n\nNone\./);
});
