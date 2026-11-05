// ============================================================================
// God Mode v2 per-worker finish (orchestraFinish.js): commit leftovers, refuse
// an empty branch, verify, push - with git and the verify command faked.
// Then push protection (pushSecrets.js) and the serial verify queue
// (verifyQueue.js).
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');

const { finishPackage, runVerify } = require('../src/orchestraFinish.js');
const secrets = require('../src/pushSecrets.js');
const { createVerifyQueue } = require('../src/verifyQueue.js');
const { createOrchestra, briefText } = require('../src/orchestra.js');
const { buildReport } = require('../src/orchestraReport.js');

/** Fake execFile for `git -C <root> ...`: answers by subcommand. */
function fakeGit(answers) {
  const calls = [];
  const execImpl = (_bin, args, _opts, cb) => {
    const sub = args.slice(2);
    calls.push(sub.join(' '));
    const a = answers[sub[0]] || { ok: true, stdout: '' };
    setImmediate(() => cb(a.ok ? null : new Error('x'), a.stdout || '', a.stderr || ''));
  };
  return { execImpl, calls };
}

const pkg = { id: 'a', root: '/wt/a', cwd: '/wt/a', branch: 'luna/a-1', baseSha: 'base', verify: 'npm test' };
const passVerify = async () => ({ ok: true, output: '' });

test('clean worktree with commits: verify, push, report HEAD', async () => {
  const git = fakeGit({
    'rev-list': { ok: true, stdout: '2\n' },
    'rev-parse': { ok: true, stdout: 'abc\n' },
    diff: { ok: true, stdout: 'src/x.js\n' },
  });
  const res = await finishPackage(pkg, { isDirImpl: () => true, execImpl: git.execImpl, verifyImpl: passVerify });
  assert.deepEqual(res, { ok: true, headSha: 'abc', files: ['src/x.js'] });
  assert.ok(git.calls.includes('push -u origin refs/heads/luna/a-1'));
  assert.ok(!git.calls.some((c) => c.startsWith('commit')), 'nothing to commit');
});

test('leftovers are committed as a wip commit before verifying', async () => {
  const git = fakeGit({ status: { ok: true, stdout: ' M src/x.js\n' }, 'rev-list': { ok: true, stdout: '1' } });
  await finishPackage(pkg, { isDirImpl: () => true, execImpl: git.execImpl, verifyImpl: passVerify });
  assert.ok(git.calls.includes('add -A'));
  assert.ok(git.calls.includes('commit -m chore: luna wip a'));
});

test('no commit past the base is refused before verify or push', async () => {
  let verified = false;
  const git = fakeGit({ 'rev-list': { ok: true, stdout: '0' } });
  const res = await finishPackage(pkg, { isDirImpl: () => true,
    execImpl: git.execImpl,
    verifyImpl: async () => {
      verified = true;
      return { ok: true, output: '' };
    },
  });
  assert.equal(res.stage, 'noCommits');
  assert.equal(verified, false);
  assert.ok(!git.calls.some((c) => c.startsWith('push')));
});

test('a red verify returns its output and does not push', async () => {
  const git = fakeGit({ 'rev-list': { ok: true, stdout: '1' } });
  const res = await finishPackage(pkg, { isDirImpl: () => true, execImpl: git.execImpl, verifyImpl: async () => ({ ok: false, output: 'FAIL' }) });
  assert.deepEqual(res, { ok: false, stage: 'verify', output: 'FAIL' });
  assert.ok(!git.calls.some((c) => c.startsWith('push')));
});

test('push failure reports git\'s first stderr line', async () => {
  const git = fakeGit({ 'rev-list': { ok: true, stdout: '1' }, push: { ok: false, stderr: 'fatal: no remote\nmore' } });
  const res = await finishPackage(pkg, { isDirImpl: () => true, execImpl: git.execImpl, verifyImpl: passVerify });
  assert.deepEqual(res, { ok: false, stage: 'push', detail: 'fatal: no remote' });
});

// ============================================================================
// Push protection. Every fake secret below is assembled at runtime: no
// secret-shaped literal may appear in the source (GitHub push protection
// would reject the push of this very file).
// ============================================================================

/** A Stripe-test-shaped fake key, built at runtime. */
const fakeStripe = () => ['sk', 'test', 'Q'.repeat(12) + '7'.repeat(12)].join('_');

/** What GitHub prints when push protection blocks a branch (multi-line). */
function gh013Stderr(extraLine = '') {
  return [
    'remote: error: GH013: Repository rule violations found for refs/heads/luna/a-1.',
    'remote: ',
    'remote: - GITHUB PUSH PROTECTION',
    'remote:   ——————————',
    'remote:     Resolve the following violations before pushing again',
    'remote: ',
    'remote:     - Push cannot contain secrets',
    'remote: ',
    'remote:       —— Stripe Test API Secret Key ————',
    'remote:        locations:',
    'remote:          - commit: 1a2b3c4d5e6f7a8b9c0d',
    'remote:            path: test/pay.test.js:12',
    ...(extraLine ? [`remote:        ${extraLine}`] : []),
    'remote: ',
    'remote:      (?) To push, remove secret from commit(s) or follow this URL to allow the secret.',
    'remote:      https://github.com/o/r/security/secret-scanning/unblock-secret/2abc',
    'To github.com:o/r.git',
    ' ! [remote rejected] luna/a-1 -> luna/a-1 (push declined due to repository rule violations)',
    "error: failed to push some refs to 'github.com:o/r.git'",
  ].join('\n');
}

test('a multi-line GH013 rejection keeps every remote: line, redacted, in detail', async () => {
  const secret = fakeStripe();
  const git = fakeGit({
    'rev-list': { ok: true, stdout: '1' },
    'rev-parse': { ok: true, stdout: 'f00d\n' },
    push: { ok: false, stderr: gh013Stderr(`echo: ${secret}`) },
  });
  const res = await finishPackage(pkg, { isDirImpl: () => true, execImpl: git.execImpl, verifyImpl: passVerify });
  assert.equal(res.stage, 'push');
  assert.equal(res.blocked, 'secret');
  assert.match(res.detail, /GH013: Repository rule violations/);
  assert.match(res.detail, /Push cannot contain secrets/);
  assert.match(res.detail, /Stripe Test API Secret Key/);
  assert.match(res.detail, /path: test\/pay\.test\.js:12/);
  assert.match(res.detail, /commit: 1a2b3c4d5e6f7a8b9c0d/);
  assert.match(res.detail, /! \[remote rejected\]/);
  assert.ok(!res.detail.includes(secret), 'the secret value is redacted');
  assert.match(res.detail, /\[redacted stripeKey\]/);
  assert.equal(res.headSha, 'f00d', 'the rejected HEAD is reported');
  assert.equal(res.range, 'origin/luna/a-1..HEAD', 'the branch was pushed before: only commits past origin are rewritten');
});

test('a rejected push detail is capped at about 2000 chars', () => {
  const long = Array.from({ length: 300 }, (_, i) => `remote: line ${i} ${'x'.repeat(20)}`).join('\n');
  const detail = secrets.pushRejectionDetail(long);
  assert.ok(detail.length <= secrets.MAX_DETAIL_CHARS, `length ${detail.length}`);
  assert.match(detail, /line 0 /);
  assert.equal(secrets.pushRejectionDetail('fatal: no remote\nmore'), 'fatal: no remote');
  assert.equal(secrets.pushBlockKind(gh013Stderr()), 'secret');
  assert.equal(secrets.pushBlockKind('remote: error: GH013: Repository rule violations found\nremote: - Commit message must match'), 'rule');
  assert.equal(secrets.pushBlockKind('fatal: could not read from remote'), null);
});

/** `git log -p --unified=0` output adding `line` at test/pay.test.js:12. */
function logAdding(line) {
  return [
    `${secrets.COMMIT_MARK}1a2b3c4d5e6f7a8b9c0d1a2b3c4d5e6f7a8b9c0d`,
    '',
    'diff --git a/test/pay.test.js b/test/pay.test.js',
    'index 111..222 100644',
    '--- a/test/pay.test.js',
    '+++ b/test/pay.test.js',
    '@@ -11,0 +12,2 @@',
    `+${line}`,
    '+const ok = 1;',
    '',
  ].join('\n');
}

test('scanAddedLines names kind, file, line and commit for each secret shape - never the value', () => {
  const shapes = {
    stripeKey: fakeStripe(),
    githubToken: ['ghp', 'A'.repeat(36)].join('_'),
    anthropicKey: ['sk', 'ant', 'api03', 'B'.repeat(30)].join('-'),
    awsKey: ['AKIA', 'C'.repeat(16)].join(''),
    googleKey: ['AIza', 'D'.repeat(35)].join(''),
    privateKey: ['-----BEGIN', 'RSA PRIVATE', 'KEY-----'].join(' '),
  };
  for (const [kind, value] of Object.entries(shapes)) {
    const hits = secrets.scanAddedLines(logAdding(`const k = '${value}';`));
    assert.deepEqual(hits.map((h) => [h.kind, h.file, h.line]), [[kind, 'test/pay.test.js', 12]], kind);
    assert.equal(hits[0].commit, '1a2b3c4d5e6f');
    assert.ok(!JSON.stringify(hits).includes(value), `${kind} value never in a hit`);
  }
  assert.deepEqual(secrets.scanAddedLines(logAdding('const k = process.env.STRIPE_KEY;')), []);
  // A removed line never counts.
  assert.deepEqual(secrets.scanAddedLines(logAdding('x').replace(/^\+x$/m, `-${fakeStripe()}`)), []);
});

test('a secret-shaped added line stops finish before verify and push, without the value', async () => {
  const secret = fakeStripe();
  let verified = false;
  const git = fakeGit({ 'rev-list': { ok: true, stdout: '1' }, log: { ok: true, stdout: logAdding(`const key = '${secret}';`) } });
  const res = await finishPackage({ ...pkg, scanSecrets: true }, {
    isDirImpl: () => true,
    execImpl: git.execImpl,
    verifyImpl: async () => {
      verified = true;
      return { ok: true, output: '' };
    },
  });
  assert.equal(res.stage, 'secrets');
  assert.deepEqual(res.hits.map((h) => `${h.file}:${h.line}`), ['test/pay.test.js:12']);
  assert.equal(verified, false, 'no long verify for a push that would be rejected');
  assert.ok(!git.calls.some((c) => c.startsWith('push')));
  assert.ok(git.calls.some((c) => c.startsWith('log -p') && c.includes('--remotes=origin')), 'only unpushed commits are scanned');
  assert.ok(!JSON.stringify(res).includes(secret));
  const text = secrets.secretScanText('a', res.hits, res.range);
  assert.match(text, /test\/pay\.test\.js:12/);
  assert.ok(!text.includes(secret));
});

test('a HEAD that GitHub already rejected is never pushed again unchanged', async () => {
  const git = fakeGit({ 'rev-list': { ok: true, stdout: '1' }, 'rev-parse': { ok: true, stdout: 'deadbeef\n' } });
  const res = await finishPackage({ ...pkg, pushBlockedSha: 'deadbeef' }, { isDirImpl: () => true, execImpl: git.execImpl, verifyImpl: passVerify });
  assert.equal(res.stage, 'push');
  assert.equal(res.blocked, 'unchanged');
  assert.ok(!git.calls.some((c) => c.startsWith('push')));
});

test('a verify that timed out is a verifyTimeout, not a verify failure, and is not pushed', async () => {
  const git = fakeGit({ 'rev-list': { ok: true, stdout: '1' } });
  const res = await finishPackage(pkg, {
    isDirImpl: () => true,
    execImpl: git.execImpl,
    verifyImpl: async () => ({ ok: false, output: 'partial', timedOut: true, reruns: 1 }),
  });
  assert.equal(res.stage, 'verifyTimeout');
  assert.equal(res.output, undefined, 'no test output to paste to a worker');
  assert.ok(!git.calls.some((c) => c.startsWith('push')));
});

// ---- runVerify: the timed-out process tree is stopped -----------------------

/** Manual timers on a fake clock. */
function fakeClock(start = 0) {
  let clock = start;
  const timers = [];
  return {
    now: () => clock,
    timers,
    setTimer: (fn, ms) => {
      const t = { fn, at: clock + ms, done: false };
      timers.push(t);
      return t;
    },
    clearTimer: (t) => {
      if (t) t.done = true;
    },
    advance(ms) {
      clock += ms;
      for (const t of timers.slice()) {
        if (!t.done && t.at <= clock) {
          t.done = true;
          t.fn();
        }
      }
    },
  };
}

const tick = () => new Promise((r) => setImmediate(r));

test('runVerify past its limit kills the whole process tree and reports timedOut', async () => {
  const clk = fakeClock();
  const killed = [];
  let callback = null;
  const execImpl = (_cmd, opts, cb) => {
    assert.equal(opts.timeout, undefined, 'the timeout is ours, not exec killing only the shell');
    callback = cb;
    return { pid: 4242 };
  };
  const pending = runVerify('npm test', '/wt/a', execImpl, {
    timeoutMs: 1000,
    setTimer: clk.setTimer,
    clearTimer: clk.clearTimer,
    killTree: async (pid) => {
      killed.push(pid);
      // The killed tree ends the shell: exec calls back with an error.
      setImmediate(() => callback(Object.assign(new Error('killed'), { killed: true }), 'ok 1', ''));
      return { ok: true };
    },
  });
  clk.advance(999);
  assert.deepEqual(killed, []);
  clk.advance(1);
  const res = await pending;
  assert.deepEqual(killed, [4242], 'procTree.killTree got the child pid');
  assert.equal(res.ok, false);
  assert.equal(res.timedOut, true);
  assert.match(res.output, /process tree was stopped/);
});

test('runVerify gives up after the kill grace when the killed shell never calls back', async () => {
  const clk = fakeClock();
  const pending = runVerify('npm test', '/wt/a', () => ({ pid: 7 }), {
    timeoutMs: 1000,
    setTimer: clk.setTimer,
    clearTimer: clk.clearTimer,
    killTree: async () => ({ ok: false }),
  });
  clk.advance(1000);
  clk.advance(60 * 1000);
  const res = await pending;
  assert.equal(res.timedOut, true);
});

// ---- the serial verify queue -------------------------------------------------

/** A runImpl whose runs end only when the test says so. */
function manualRuns() {
  const runs = [];
  const runImpl = (command, cwd, opts) =>
    new Promise((resolve) => {
      runs.push({ cwd, opts, resolve });
    });
  return { runs, runImpl };
}

test('two packages finishing together verify one after the other', async () => {
  const m = manualRuns();
  const q = createVerifyQueue({ runImpl: m.runImpl });
  const phases = [];
  const a = q.run('npm test', '/wt/a', { onQueued: () => phases.push('a:queued'), onStart: () => phases.push('a:start') });
  const b = q.run('npm test', '/wt/b', { onQueued: () => phases.push('b:queued'), onStart: () => phases.push('b:start') });
  await tick();
  assert.deepEqual(m.runs.map((r) => r.cwd), ['/wt/a'], 'b waits while a runs');
  assert.equal(q.waiting(), 1);
  m.runs[0].resolve({ ok: true, output: 'a ok' });
  assert.equal((await a).ok, true);
  await tick();
  assert.deepEqual(m.runs.map((r) => r.cwd), ['/wt/a', '/wt/b']);
  m.runs[1].resolve({ ok: false, output: 'b red' });
  const rb = await b;
  assert.deepEqual([rb.ok, rb.output, rb.timedOut], [false, 'b red', false]);
  assert.deepEqual(phases, ['a:queued', 'b:queued', 'a:start', 'b:start']);
});

test('one queue for every run: verifies of two projects never overlap', async () => {
  let running = 0;
  let maxRunning = 0;
  const slowRun = async () => {
    running += 1;
    maxRunning = Math.max(maxRunning, running);
    await tick();
    running -= 1;
    return { ok: true, output: '' };
  };
  const shared = createVerifyQueue({ runImpl: slowRun });
  await Promise.all([shared.run('npm test', '/p1/a'), shared.run('npm test', '/p2/b'), shared.run('npm test', '/p1/c')]);
  assert.equal(maxRunning, 1);
  assert.equal(shared.waiting(), 0);
  // The process-wide instance is a singleton.
  const { sharedVerifyQueue } = require('../src/verifyQueue.js');
  assert.equal(sharedVerifyQueue(), sharedVerifyQueue());
});

test('a timed-out tree that could not be stopped is not re-run next to itself', async () => {
  let calls = 0;
  const q = createVerifyQueue({
    runImpl: async () => {
      calls += 1;
      return { ok: false, output: '', timedOut: true, killFailed: true };
    },
  });
  const res = await q.run('npm test', '/wt/a');
  assert.deepEqual([res.timedOut, res.reruns, calls], [true, 0, 1]);
});

test('a verify of a killed run is skipped when its turn comes', async () => {
  const m = manualRuns();
  const q = createVerifyQueue({ runImpl: m.runImpl });
  let killed = false;
  const a = q.run('npm test', '/p1/a');
  const b = q.run('npm test', '/p1/b', { isCancelled: () => killed });
  await tick();
  killed = true;
  m.runs[0].resolve({ ok: true, output: '' });
  await a;
  const rb = await b;
  assert.equal(rb.cancelled, true);
  assert.equal(m.runs.length, 1, 'b never ran');
  const git = fakeGit({ 'rev-list': { ok: true, stdout: '1' } });
  const fin = await finishPackage(pkg, { isDirImpl: () => true, execImpl: git.execImpl, verifyImpl: async () => rb });
  assert.equal(fin.stage, 'verifyCancelled');
});

test('queue time does not count toward the verify limit', async () => {
  const clk = fakeClock();
  const LIMIT = 30 * 60 * 1000;
  const children = [];
  const execImpl = (cmd, opts, cb) => {
    const child = { pid: 100 + children.length, cwd: opts.cwd, cb };
    children.push(child);
    return child;
  };
  const killed = [];
  const q = createVerifyQueue({
    execImpl,
    now: clk.now,
    setTimer: clk.setTimer,
    clearTimer: clk.clearTimer,
    killTree: async (pid) => killed.push(pid),
    limitMs: LIMIT,
  });
  const a = q.run('npm test', '/wt/a');
  const b = q.run('npm test', '/wt/b');
  await tick();
  // a runs 25 min (inside the limit) while b waits in the queue.
  clk.advance(25 * 60 * 1000);
  children[0].cb(null, 'a ok', '');
  assert.equal((await a).ok, true);
  await tick();
  assert.equal(children.length, 2, 'b started once a finished');
  // 50 min after b was queued, but only 25 min after it started: not timed out.
  clk.advance(25 * 60 * 1000);
  assert.deepEqual(killed, []);
  children[1].cb(null, 'b ok', '');
  const res = await b;
  assert.equal(res.ok, true);
  assert.equal(res.timedOut, false);
  assert.equal(res.waitedMs, 25 * 60 * 1000, 'the wait is reported separately');
});

test('a timed-out verify is re-run once, then reported as a timeout - never as a test failure', async () => {
  let calls = 0;
  const flaky = createVerifyQueue({
    runImpl: async () => {
      calls += 1;
      return calls === 1 ? { ok: false, output: 'slow', timedOut: true } : { ok: true, output: 'ok' };
    },
  });
  const res = await flaky.run('npm test', '/wt/a');
  assert.deepEqual([res.ok, res.timedOut, res.reruns, calls], [true, false, 1, 2]);

  let hung = 0;
  const stuck = createVerifyQueue({
    runImpl: async () => {
      hung += 1;
      return { ok: false, output: 'still running', timedOut: true };
    },
  });
  const twice = await stuck.run('npm test', '/wt/b');
  assert.deepEqual([twice.ok, twice.timedOut, twice.reruns, hung], [false, true, 1, 2], 'exactly one re-run');
  // finishPackage turns it into a verifyTimeout, never a 'verify' failure.
  const git = fakeGit({ 'rev-list': { ok: true, stdout: '1' } });
  const fin = await finishPackage(pkg, { isDirImpl: () => true, execImpl: git.execImpl, verifyImpl: () => stuck.run('npm test', '/wt/a') });
  assert.equal(fin.stage, 'verifyTimeout');
  assert.match(fin.detail, /twice/);
});

// ---- orchestra routing: fix-up rounds, no blind retries ----------------------

const turn = (text) =>
  JSON.stringify({ type: 'assistant', message: { stop_reason: 'end_turn', content: [{ type: 'text', text }] } });

/** A one-package God Mode run with every side effect faked; finish() decides each finishPackage result. */
async function oneRun(finish) {
  let seq = 0;
  const log = { writes: [], finishes: [], events: [] };
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
    finishPackage: async (p, hooks) => {
      log.finishes.push({ ...p });
      return finish(p, hooks, log.finishes.length);
    },
    writePty: (sessionId, text) => {
      log.writes.push([sessionId, text]);
      return alive.has(sessionId);
    },
    sessionAlive: (id) => alive.has(id),
    workerSettings: () => ({ model: 'opus', permissionMode: 'bypassPermissions' }),
    onRunEvent: (kind) => log.events.push(kind),
    setTimer: () => ({}),
    clearTimer: () => {},
  });
  orch.restore();
  const { plan } = await orch.makePlan({ projectId: 'p1', repoPath: '/repo', profileId: 'cloud', env: {} });
  await orch.launch({ planId: plan.id });
  const done = async () => {
    orch.onTurnEnd('s1', turn('LUNA_DONE a'));
    for (let i = 0; i < 4; i += 1) await tick();
  };
  const view = () => orch.view().packages[0];
  return { orch, log, done, view };
}

test('a secret found before the first push goes back to the worker as a fix-up round, without the value', async () => {
  const secret = fakeStripe();
  const hits = secrets.scanAddedLines(logAdding(`const key = '${secret}';`));
  const r = await oneRun(async (_p, _h, n) => (n === 1 ? { ok: false, stage: 'secrets', hits, range: 'base..HEAD' } : { ok: true, headSha: 'abc' }));
  await r.done();
  assert.equal(r.view().state, 'launched', 'not a terminal stall');
  assert.equal(r.view().scanFixup, true);
  assert.ok(r.log.events.includes('secretFixup'));
  const pasted = r.log.writes.map(([, t]) => t).join('\n');
  assert.match(pasted, /test\/pay\.test\.js:12/);
  assert.ok(!pasted.includes(secret), 'the value is never printed');
  assert.ok(!JSON.stringify(r.orch.view()).includes(secret));
  assert.equal(r.log.finishes[0].scanSecrets, true, 'the first finish scans');
  await r.done();
  assert.equal(r.log.finishes[1].scanSecrets, false, 'after its round, GitHub decides');
  assert.equal(r.view().state, 'pushed');
});

test('GH013 is never retried unchanged: one fix-up round, one more push, then a terminal stall with the full detail', async () => {
  const detail = secrets.pushRejectionDetail(gh013Stderr());
  const blocked = { ok: false, stage: 'push', blocked: 'secret', detail, headSha: 'f00d', range: 'base..HEAD' };
  const r = await oneRun(async () => blocked);
  await r.done();
  assert.equal(r.view().state, 'launched', 'first rejection -> fix-up round');
  assert.equal(r.log.finishes.length, 1, 'no automatic re-push of the same commits');
  const round = r.log.writes.map(([, t]) => t).find((t) => /GH013/.test(t));
  assert.ok(round, 'the worker got the rejection');
  assert.match(round, /path: test\/pay\.test\.js:12/);
  assert.match(round, /git reset --soft base/);
  assert.match(round, /never reached origin/);

  await r.done();
  assert.equal(r.log.finishes[1].pushBlockedSha, 'f00d', 'the rejected HEAD is handed over, so it is never pushed as-is');
  const v = r.view();
  assert.deepEqual([v.state, v.error, v.terminal], ['stalled', 'pushBlocked', true]);
  assert.match(v.detail, /GH013/);
  assert.match(v.detail, /Stripe Test API Secret Key/);
  assert.match(v.detail, /path: test\/pay\.test\.js:12/);
  assert.equal(r.log.finishes.length, 2);

  const md = buildReport(r.orch.view(), { now: 2, suggestions: [] });
  assert.match(md, /stalled \(pushBlocked\)/);
  assert.match(md, /GitHub push protection rejected the branch/);
  assert.match(md, /Stripe Test API Secret Key/);
  assert.match(md, /path: test\/pay\.test\.js:12/);
});

test('a verify timeout stalls without pasting anything to the worker as a test failure', async () => {
  const r = await oneRun(async () => ({ ok: false, stage: 'verifyTimeout', detail: '`npm test` ran past the 30 min limit twice' }));
  await r.done();
  const v = r.view();
  assert.deepEqual([v.state, v.error, v.verifyRounds], ['stalled', 'verifyTimeout', 0]);
  assert.ok(!r.log.writes.some(([, t]) => /FAILED/.test(t)), 'nothing pasted as a failure');
});

test('the board shows "waiting to verify" while the package sits in the queue (pl + en)', async () => {
  const { pkgStateKey } = await import('../src/renderer/modules/orchestraState.js');
  let release;
  const gate = new Promise((r) => {
    release = r;
  });
  const seen = [];
  let run = null;
  run = await oneRun(async (_p, hooks) => {
    hooks.onQueued({ ahead: 0 });
    seen.push(run.view().verifyPhase);
    hooks.onQueued({ ahead: 1 });
    seen.push(run.view().verifyPhase);
    assert.equal(hooks.isCancelled(), false);
    hooks.onStart();
    seen.push(run.view().verifyPhase);
    await gate;
    return { ok: true, headSha: 'abc' };
  });
  run.orch.onTurnEnd('s1', turn('LUNA_DONE a'));
  await tick();
  assert.deepEqual(seen, [null, 'queued', 'running'], 'no "waiting" flash on an empty queue');
  assert.equal(pkgStateKey({ state: 'finishing', verifyPhase: 'queued' }), 'waitingVerify');
  assert.equal(pkgStateKey({ state: 'finishing', verifyPhase: 'running' }), 'finishing');
  assert.equal(pkgStateKey(null), 'pending');
  release();
  for (let i = 0; i < 4; i += 1) await tick();
  assert.equal(run.view().verifyPhase, null);

  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'i18n.js'), 'utf8');
  const enAt = src.indexOf('\n  en: {');
  const pl = src.slice(0, enAt);
  const en = src.slice(enAt);
  for (const key of ['orch.state.waitingVerify', 'orch.pkgerr.pushBlocked', 'orch.pkgerr.secretFound', 'orch.pkgerr.verifyTimeout']) {
    const plLine = pl.split('\n').find((l) => l.includes(`'${key}'`));
    assert.ok(plLine, `pl ${key}`);
    assert.ok(en.includes(`'${key}'`), `en ${key}`);
    assert.doesNotMatch(plLine, /[^\x00-\x7f]/, 'pl without diacritics');
  }
  assert.match(pl, /'orch\.state\.waitingVerify': 'czeka na weryfikacje'/);
  assert.match(en, /'orch\.state\.waitingVerify': 'waiting to verify'/);
});

test('the worker brief says fake secrets are assembled at runtime', () => {
  const text = briefText({ id: 'a', title: 'A', prompt: 'p', verify: 'npm test' }, 'luna/a-1');
  assert.match(text, /not even a fake one in a test/);
  assert.match(text, /Assemble fake secrets at runtime/);
});

test('this test file holds no secret-shaped literal', () => {
  const self = fs.readFileSync(__filename, 'utf8');
  const asAdded = self.split(/\r?\n/).map((l) => `+${l}`).join('\n');
  const log = [`${secrets.COMMIT_MARK}0`, '+++ b/self.js', '@@ -0,0 +1,1 @@', asAdded].join('\n');
  assert.deepEqual(secrets.scanAddedLines(log), []);
});
