// God Mode "free providers" runs end to end with faked git/tabs: workers on
// the free profile, luna-free/ worktree branches, branches-only integration,
// and a push even after a failed verify (src/orchestraFinish.js).

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createOrchestra } = require('../src/orchestra');
const { finishPackage } = require('../src/orchestraFinish');
const { addWorktree } = require('../src/worktrees');
const { normalizeStoredPlan } = require('../src/orchestraSupervisor');

const pkg = { id: 'a', title: 'A', todoAts: [1], prompt: 'do', files: [], dependsOn: [], verify: 'npm test', model: 'sonnet' };

function setup({ freeProfileId = 'free-a', branchOverride = null, extraDeps = {} } = {}) {
  const log = { worktreeOpts: [], sessions: [] };
  const orch = createOrchestra({
    now: () => 1700000000000,
    readTodos: () => [{ at: 1, text: 'one', done: false }],
    dirtyCount: async () => 0,
    baseBranchOf: async () => 'main',
    runPlanner: async () => ({ ok: true, raw: { packages: [pkg], notes: '' }, costUsd: 0 }),
    addWorktree: async (repo, name, opts) => {
      log.worktreeOpts.push(opts);
      const branch = branchOverride || `${opts.branchPrefix || 'luna/'}${name}`;
      return { ok: true, root: `/wt/${name}`, cwd: `/wt/${name}`, branch };
    },
    removeWorktree: async () => ({ ok: true }),
    briefDir: () => '/cfg',
    writeBrief: () => true,
    createSession: (opts) => {
      log.sessions.push(opts);
      return { id: `s${log.sessions.length}` };
    },
    freeProfileId: () => freeProfileId,
    ...extraDeps,
  });
  return { orch, log };
}

const ctx = { projectId: 'p1', repoPath: '/repo', profileId: 'claude-cloud', env: {} };

test('Approve with free: workers on the free profile, luna-free/ branches, branches-only', async () => {
  const { orch, log } = setup();
  const { plan } = await orch.makePlan(ctx);
  const res = await orch.launch({ planId: plan.id, ids: null, prompts: {}, integration: 'merge', free: true });
  assert.equal(res.ok, true);
  assert.equal(res.plan.freeMode, true);
  assert.equal(res.plan.integrationMode, 'branches', 'merge is never honoured on a free run');
  assert.equal(log.worktreeOpts[0].branchPrefix, 'luna-free/');
  assert.equal(log.sessions[0].profileId, 'free-a');
  assert.match(log.sessions[0].branch, /^luna-free\//);
});

test('free without a chain profile is refused before anything launches', async () => {
  const { orch, log } = setup({ freeProfileId: null });
  const { plan } = await orch.makePlan(ctx);
  const res = await orch.launch({ planId: plan.id, ids: null, prompts: {}, free: true });
  assert.deepEqual(res, { ok: false, error: 'noFreeProfile' });
  assert.equal(log.sessions.length, 0);
});

test('a free package whose worktree is not on a luna-free/ branch never starts', async () => {
  const { orch, log } = setup({ branchOverride: 'main' });
  const { plan } = await orch.makePlan(ctx);
  const res = await orch.launch({ planId: plan.id, ids: null, prompts: {}, free: true });
  assert.equal(log.sessions.length, 0);
  const view = res.plan || orch.view();
  assert.equal(view.packages[0].error, 'unsafeBranch');
});

test('a normal run keeps luna/ branches and the session profile', async () => {
  const { orch, log } = setup();
  const { plan } = await orch.makePlan(ctx);
  await orch.launch({ planId: plan.id, ids: null, prompts: {}, integration: 'branches' });
  assert.equal(log.worktreeOpts[0].branchPrefix, undefined);
  assert.equal(log.sessions[0].profileId, 'claude-cloud');
});

test('a stored free run stays branches-only after a restart', () => {
  const restored = normalizeStoredPlan({
    id: 'p1', repoPath: process.cwd(), profileId: 'free-a', freeMode: true, integrationMode: 'merge',
    packages: [{ ...pkg, state: 'pending' }],
  });
  assert.equal(restored.freeMode, true);
  assert.equal(restored.integrationMode, 'branches');
});

// --- finish + worktree git (faked) ----------------------------------------------------

function fakeGit(responses = {}) {
  const calls = [];
  const execImpl = (cmd, rawArgs, opts, cb) => {
    // runGit prefixes every call with `-C <cwd>`.
    const args = rawArgs[0] === '-C' ? rawArgs.slice(2) : rawArgs;
    calls.push(args.join(' '));
    const hit = Object.entries(responses).find(([k]) => args.join(' ').startsWith(k));
    const r = hit ? hit[1] : { stdout: '' };
    cb(r.error || null, r.stdout || '', r.stderr || '');
  };
  return { execImpl, calls };
}

test('finishPackage pushes a free branch even when verify fails', async () => {
  const { execImpl, calls } = fakeGit({ 'status --porcelain': { stdout: '' }, 'rev-list': { stdout: '2\n' } });
  const res = await finishPackage(
    { id: 'a', root: '/wt/a', cwd: '/wt/a', branch: 'luna-free/a-1', baseSha: 'abc1234', verify: 'npm test', pushOnVerifyFail: true },
    { execImpl, isDirImpl: () => true, verifyImpl: async () => ({ ok: false, output: 'boom' }) },
  );
  assert.equal(res.stage, 'verify');
  assert.equal(res.pushed, true);
  assert.ok(calls.some((c) => c === 'push -u origin refs/heads/luna-free/a-1'));
});

test('finishPackage on a normal run does not push after a failed verify', async () => {
  const { execImpl, calls } = fakeGit({ 'status --porcelain': { stdout: '' }, 'rev-list': { stdout: '2\n' } });
  const res = await finishPackage(
    { id: 'a', root: '/wt/a', cwd: '/wt/a', branch: 'luna/a-1', baseSha: 'abc1234', verify: 'npm test' },
    { execImpl, isDirImpl: () => true, verifyImpl: async () => ({ ok: false, output: 'boom' }) },
  );
  assert.equal(res.stage, 'verify');
  assert.ok(!calls.some((c) => c.startsWith('push')));
});

test('addWorktree honours only the known branch prefixes', async () => {
  const fsImpl = { existsSync: () => false, readdirSync: () => [] };
  const run = async (branchPrefix) => {
    const { execImpl, calls } = fakeGit({ 'rev-parse --show-toplevel': { stdout: '/repo\n' }, 'rev-parse --verify': { stdout: 'abc\n' } });
    const res = await addWorktree('/repo', 'pkg one', { execImpl, fsImpl, branchPrefix });
    return { res, add: calls.find((c) => c.startsWith('worktree add')) };
  };
  assert.equal((await run('luna-free/')).res.branch, 'luna-free/pkg-one');
  assert.equal((await run(undefined)).res.branch, 'luna/pkg-one');
  assert.equal((await run('main')).res.branch, 'luna/pkg-one', 'an unknown prefix falls back to luna/');
});

// --- Free God Mode v2 F2a / F3: the free chain's limit and real model -----------------

const http = require('http');
const { FallbackProxy } = require('../src/fallbackproxy');
const { RequestPacer } = require('../src/freePacer');
const { usageLimitFrom } = require('../src/observer');
const { SHIM_TOKEN_HEADER } = require('../src/sessionenv');
const { RESUME_TEXT } = require('../src/orchestraSupervisor');

/** Fake clock + timers for a run that pauses and resumes. */
function clocked() {
  const c = { t: new Date(2026, 10, 8, 14, 7, 30).getTime(), timers: [], writes: [], events: [] };
  c.deps = {
    now: () => c.t,
    setTimer: (fn, ms) => {
      const timer = { fn, at: c.t + ms, done: false };
      c.timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => {
      if (timer) timer.done = true;
    },
    writePty: (sessionId, text) => {
      c.writes.push([sessionId, text]);
      return true;
    },
    sessionAlive: () => true,
    onRunEvent: (kind) => c.events.push(kind),
  };
  c.advance = (ms) => {
    c.t += ms;
    for (const timer of c.timers) {
      if (!timer.done && timer.at <= c.t) {
        timer.done = true;
        timer.fn();
      }
    }
  };
  return c;
}

/** What the proxy answers once every model of the chain is out (real gateway bodies). */
async function exhaustedAnswer(now) {
  const gateway = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '720' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'All models rate-limited after 2 attempts. Soonest cooldown reset ~12m. Last error: 429' } }));
    });
  });
  await new Promise((r) => gateway.listen(0, '127.0.0.1', r));
  const proxy = new FallbackProxy({
    upstream: `http://127.0.0.1:${gateway.address().port}`,
    chain: { id: 'free-coding', models: ['a', 'b'] },
    now,
    pacer: new RequestPacer({ now, minGapMs: 0 }),
  });
  const { port, token } = await proxy.start();
  try {
    return await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/v1/messages', headers: { [SHIM_TOKEN_HEADER]: token } }, (res) => {
        const chunks = [];
        res.on('data', (ch) => chunks.push(ch));
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
      });
      req.on('error', reject);
      req.end('{"model":"a","messages":[]}');
    });
  } finally {
    await proxy.stop();
    gateway.close();
  }
}

test('a free run whose chain is exhausted pauses until the chain resets and resumes on its own', async () => {
  const c = clocked();
  const { orch } = setup({ extraDeps: c.deps });
  const { plan } = await orch.makePlan(ctx);
  await orch.launch({ planId: plan.id, ids: null, prompts: {}, free: true });
  const answer = await exhaustedAnswer(c.deps.now);
  assert.equal(answer.status, 429);
  // The CLI's transcript entry for that 429 (live check, claude 2.1.319).
  const entry = JSON.stringify({
    type: 'assistant',
    isApiErrorMessage: true,
    apiErrorStatus: 429,
    message: { model: '<synthetic>', content: [{ type: 'text', text: `API Error: Server is temporarily limiting requests (not your usage limit) · ${JSON.parse(answer.body).error.message}` }] },
  });
  const limit = usageLimitFrom(entry, c.t);
  const expected = Math.ceil((c.t + 12 * 60 * 1000) / 60000) * 60000;
  assert.equal(limit.resetsAt, expected);
  orch.onUsageLimit('s1', limit.resetsAt);
  assert.equal(orch.view().pausedUntil, expected);
  assert.ok(c.events.includes('paused'));
  c.advance(11 * 60 * 1000);
  assert.equal(c.writes.length, 0, 'still waiting');
  c.advance(3 * 60 * 1000);
  assert.equal(orch.view().pausedUntil, null);
  assert.deepEqual(c.writes, [['s1', RESUME_TEXT]]);
  assert.ok(c.events.includes('resumed'));
});

test('a free run logs which model really answered, once per change, and every substitution', async () => {
  const c = clocked();
  const { orch } = setup({ extraDeps: c.deps });
  const { plan } = await orch.makePlan(ctx);
  await orch.launch({ planId: plan.id, ids: null, prompts: {}, free: true });
  const route = (model, routedVia, substituted = false) => orch.onFreeRoute({ chainId: 'free-coding', model, routedVia, substituted, at: c.t });
  route('a', 'nvidia/nemotron-3-ultra');
  route('a', 'nvidia/nemotron-3-ultra');
  route('a', 'groq/llama-3.3-70b', true);
  route('b', 'openrouter/gpt-oss-120b');
  const lines = orch.view().recoveries.filter((e) => e.kind === 'free').map((e) => [e.reason, e.detail]);
  assert.deepEqual(lines, [
    ['freeModel', 'free-coding: a answered by nvidia/nemotron-3-ultra'],
    ['freeSubstituted', 'free-coding: a was answered by groq/llama-3.3-70b - refused, next model tried'],
    ['freeModel', 'free-coding: b answered by openrouter/gpt-oss-120b'],
  ]);
});

test('a normal (Claude) run ignores free-model route events', async () => {
  const c = clocked();
  const { orch } = setup({ extraDeps: c.deps });
  const { plan } = await orch.makePlan(ctx);
  await orch.launch({ planId: plan.id, ids: null, prompts: {} });
  orch.onFreeRoute({ chainId: 'free-coding', model: 'a', routedVia: 'x/y', substituted: false });
  assert.equal(orch.view().recoveries.filter((e) => e.kind === 'free').length, 0);
});
