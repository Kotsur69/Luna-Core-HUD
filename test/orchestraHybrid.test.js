// ============================================================================
// Free God Mode v2 F6c + F6d (FREE_GODMODE_V2_PLAN.md Slice F6): a hybrid
// run's free packages on 'FreeLLMAPI - coding', the read-only Claude review
// gate before one joins the run, hand-overs to Sonnet in the same worktree
// (review fail / two stalls / 1 h on free limits) and the report rows. The
// pure rules first, then the run controller with every side effect faked.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const hybrid = require('../src/orchestraHybrid');
const review = require('../src/orchestraReview');
const sup = require('../src/orchestraSupervisor');
const { createOrchestra } = require('../src/orchestra');
const { DEFAULT_PROTECTED } = require('../src/orchestraHybridGuard');
const { buildReport, renderRunReportHtml } = require('../src/orchestraReport');

const HOUR = 60 * 60 * 1000;
const MIN = 60 * 1000;
const T0 = 1_700_000_000_000;

/** A transcript fragment whose last finished assistant message says `text`. */
const turn = (text) =>
  JSON.stringify({ type: 'assistant', message: { stop_reason: 'end_turn', content: [{ type: 'text', text }] } });

// ---- pure rules --------------------------------------------------------------

const CHAINS = [
  { id: 'easy', models: ['auto:easy'] },
  { id: 'coding', models: ['auto:coding', 'some/other-model'] },
];

test('pickCodingProfileId: "FreeLLMAPI - coding", never auto:easy and never the easy-tasks profile', () => {
  const coding = { id: 'freellm-chain', fallbackChain: 'coding' };
  const other = { id: 'my-free', fallbackChain: 'coding' };
  const easyProfile = { id: 'freellm-auto', fallbackChain: 'coding' };
  const easyChain = { id: 'easy-chain', fallbackChain: 'easy' };
  const easyEnv = { id: 'easy-env', fallbackChain: 'coding', env: { ANTHROPIC_MODEL: 'auto:easy' } };
  assert.equal(hybrid.pickCodingProfileId([easyProfile, other, coding], [], CHAINS), 'freellm-chain');
  assert.equal(hybrid.pickCodingProfileId([easyProfile, easyChain, easyEnv, other], [], CHAINS), 'my-free');
  assert.equal(hybrid.pickCodingProfileId([easyProfile, easyChain, easyEnv], [], CHAINS), null);
  assert.equal(hybrid.pickCodingProfileId([{ id: 'claude-cloud' }], [], CHAINS), null, 'no chain, no free worker');
  // A template's chain counts like the profile's own.
  const viaTemplate = { id: 'freellm-chain', templateId: 'tpl' };
  assert.equal(hybrid.pickCodingProfileId([viaTemplate], [{ id: 'tpl', fallbackChain: 'coding' }], CHAINS), 'freellm-chain');
  assert.equal(hybrid.pickCodingProfileId([viaTemplate], [{ id: 'tpl', fallbackChain: 'easy' }], CHAINS), null);
});

test('runsFree: a free package of a hybrid run with a coding profile, until it is handed over', () => {
  const plan = { workers: 'hybrid', hybridProfileId: 'freellm-chain', packages: [] };
  const free = { id: 'a', model: 'free' };
  assert.equal(hybrid.runsFree(plan, free), true);
  assert.equal(hybrid.runsFree(plan, { ...free, modelOverride: 'sonnet' }), false, 'handed over');
  assert.equal(hybrid.runsFree(plan, { id: 'b', model: 'sonnet' }), false);
  assert.equal(hybrid.runsFree({ ...plan, hybridProfileId: 'freellm-auto' }, free), false, 'never the easy-tasks profile');
  assert.equal(hybrid.runsFree({ ...plan, hybridProfileId: undefined }, free), false);
  assert.equal(hybrid.runsFree({ ...plan, freeMode: true, workers: 'free' }, free), false, 'a free-only run is not hybrid');
  assert.equal(hybrid.runsFree({ ...plan, workers: undefined }, free), false, 'a Claude run');
});

test('approveProfile: free packages need a coding profile, a Claude-only plan needs none', () => {
  const plan = { packages: [{ id: 'a', model: 'free' }, { id: 'b', model: 'opus' }] };
  assert.deepEqual(hybrid.approveProfile(plan, 'freellm-chain'), { ok: true, profileId: 'freellm-chain' });
  assert.deepEqual(hybrid.approveProfile(plan, null), { ok: false, error: 'noFreeProfile' });
  assert.deepEqual(hybrid.approveProfile(plan, 'freellm-auto'), { ok: false, error: 'noFreeProfile' });
  assert.deepEqual(hybrid.approveProfile({ packages: [{ id: 'b', model: 'opus' }] }, null), { ok: true, profileId: null });
});

test('claudeDependants: pending Claude packages behind a free one, through other packages too', () => {
  const plan = {
    workers: 'hybrid',
    hybridProfileId: 'freellm-chain',
    packages: [
      { id: 'a', model: 'free', state: 'launched', dependsOn: [] },
      { id: 'b', model: 'free', state: 'pending', dependsOn: ['a'] },
      { id: 'c', model: 'sonnet', state: 'pending', dependsOn: ['b'] },
      { id: 'd', model: 'opus', state: 'pushed', dependsOn: ['a'] },
      { id: 'e', model: 'opus', state: 'pending', dependsOn: [] },
    ],
  };
  assert.deepEqual(hybrid.claudeDependants(plan, 'a'), ['c']);
  assert.deepEqual(hybrid.claudeDependants(plan, 'e'), []);
});

test('freeWaitStep: 59 min with Claude dependants waits, 60 min hands over, none waits for the reset', () => {
  const plan = (deps) => ({
    workers: 'hybrid',
    hybridProfileId: 'freellm-chain',
    packages: [
      { id: 'a', model: 'free', state: 'launched', dependsOn: [] },
      ...(deps ? [{ id: 'b', model: 'sonnet', state: 'pending', dependsOn: ['a'] }] : []),
    ],
  });
  const pkg = { id: 'a', model: 'free', hybrid: { freeWait: { since: T0, until: T0 + 3 * HOUR } } };
  assert.deepEqual(hybrid.freeWaitStep(plan(true), pkg, T0 + 59 * MIN), { action: 'wait', at: T0 + HOUR });
  assert.deepEqual(hybrid.freeWaitStep(plan(true), pkg, T0 + HOUR), { action: 'handOver', dependants: ['b'] });
  const resumeAt = T0 + 3 * HOUR + hybrid.RESUME_GRACE_MS;
  assert.deepEqual(hybrid.freeWaitStep(plan(false), pkg, T0 + 2 * HOUR), { action: 'wait', at: resumeAt });
  assert.deepEqual(hybrid.freeWaitStep(plan(false), pkg, resumeAt), { action: 'resume' });
  // The reset comes before the hour: it resumes even with dependants.
  const soon = { ...pkg, hybrid: { freeWait: { since: T0, until: T0 + 10 * MIN } } };
  assert.deepEqual(hybrid.freeWaitStep(plan(true), soon, T0 + 10 * MIN + hybrid.RESUME_GRACE_MS), { action: 'resume' });
  assert.deepEqual(hybrid.freeWaitStep(plan(true), { id: 'a' }, T0), { action: 'none' });
  // A wait with no known reset re-checks later; a repeat hit keeps the first time.
  assert.deepEqual(hybrid.startFreeWait({ id: 'a' }, null, T0).freeWait, { since: T0, until: T0 + hybrid.DEFAULT_FREE_WAIT_MS });
  assert.equal(hybrid.startFreeWait(pkg, T0 + 4 * HOUR, T0 + 30 * MIN).freeWait.since, T0);
});

test('reviewDecision: pass / fail with reasons, a Claude limit waits, anything else fails closed', () => {
  assert.deepEqual(hybrid.reviewDecision({ ok: true, verdict: 'pass', reasons: [] }, [], T0), { action: 'pass', reasons: [] });
  assert.deepEqual(hybrid.reviewDecision({ ok: true, verdict: 'fail', reasons: ['x'] }, [], T0), { action: 'fail', reasons: ['x'] });
  const resetSec = Math.floor((T0 + 2 * HOUR) / 1000);
  const wait = hybrid.reviewDecision({ ok: false, error: 'limit', detail: `limit reached|${resetSec}` }, [], T0);
  assert.equal(wait.action, 'wait');
  assert.ok(wait.resumeAt >= resetSec * 1000, 'not before the reset');
  assert.equal(hybrid.reviewDecision({ ok: false, error: 'badVerdict' }, [], T0).action, 'error');
  assert.equal(hybrid.reviewDecision(null, [], T0).action, 'error');
});

test('a stored hybrid record keeps the review and hand-overs, never a wait in flight', () => {
  const raw = {
    review: { result: 'fail', reasons: ['one', 2, ''], at: 5 },
    handOvers: [{ kind: 'reviewFail', at: 6, detail: null }, { kind: 'bogus', at: 7 }],
    freeWait: { since: 1, until: 2 },
    reviewWait: { until: 3 },
    reviewing: true,
  };
  const back = hybrid.normalizeStoredHybrid(raw);
  assert.deepEqual(back.review, { result: 'fail', reasons: ['one', '2'], at: 5 });
  assert.deepEqual(back.handOvers, [{ kind: 'reviewFail', at: 6, detail: null }]);
  assert.equal(back.freeWait, null);
  assert.equal(back.reviewWait, null);
  assert.equal(back.reviewing, false);
  assert.equal(hybrid.normalizeStoredHybrid({ freeWait: { since: 1 } }), null);
  assert.equal(hybrid.normalizeStoredProfileId('freellm-auto'), null);
  assert.equal(hybrid.normalizeStoredProfileId('freellm-chain'), 'freellm-chain');
});

test('handOverBrief: the resume brief, why, and the review findings to fix', () => {
  const text = hybrid.handOverBrief('# Brief\n', { kind: 'reviewFail', reasons: ['breaks the API', ''] });
  assert.match(text, /^# Brief\n/);
  assert.match(text, /## Handed over to you/);
  assert.match(text, /a Claude review of its diff failed it/);
  assert.match(text, /- breaks the API/);
});

// ---- the review is read-only -------------------------------------------------

test('review args: a read-only headless Sonnet - Read/Grep/Glob only, no write tools, no MCP, no bypass', () => {
  const args = review.buildReviewArgs();
  const value = (flag) => args[args.indexOf(flag) + 1];
  assert.equal(args[0], '-p');
  assert.equal(value('--model'), 'sonnet');
  assert.equal(value('--tools'), 'Read,Grep,Glob');
  const denied = value('--disallowedTools').split(',');
  for (const tool of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash']) assert.ok(denied.includes(tool), tool);
  assert.ok(args.includes('--strict-mcp-config'));
  assert.ok(args.includes('--no-session-persistence'));
  for (const unsafe of ['--dangerously-skip-permissions', '--permission-mode', 'bypassPermissions', '--mcp-config', '--add-dir']) {
    assert.ok(!args.includes(unsafe), unsafe);
  }
});

function fakeExec(stdout, error = null) {
  const calls = [];
  const execImpl = (cmd, args, opts, cb) => {
    const call = { cmd, args, opts, stdin: null };
    calls.push(call);
    setImmediate(() => cb(error, stdout));
    return { stdin: { on() {}, end: (text) => (call.stdin = text) } };
  };
  return { execImpl, calls };
}

test('runReview: the prompt goes on stdin, the verdict comes back; a usage limit is "limit"', async () => {
  const ok = fakeExec(JSON.stringify({ is_error: false, structured_output: { verdict: 'fail', reasons: ['no test'] }, total_cost_usd: 0.02 }));
  const res = await review.runReview({ cwd: '/wt/a', env: { X: '1' }, prompt: 'PROMPT', execImpl: ok.execImpl });
  assert.deepEqual(res, { ok: true, verdict: 'fail', reasons: ['no test'], costUsd: 0.02 });
  assert.equal(ok.calls[0].cmd, 'claude');
  assert.deepEqual(ok.calls[0].args, review.buildReviewArgs());
  assert.equal(ok.calls[0].opts.cwd, '/wt/a');
  assert.equal(ok.calls[0].stdin, 'PROMPT');

  const limited = fakeExec(JSON.stringify({ is_error: true, result: 'Claude usage limit reached|1700007200' }));
  const lim = await review.runReview({ cwd: '/wt/a', env: {}, prompt: 'p', execImpl: limited.execImpl });
  assert.equal(lim.ok, false);
  assert.equal(lim.error, 'limit');

  const odd = fakeExec(JSON.stringify({ is_error: false, structured_output: { verdict: 'maybe' } }));
  assert.deepEqual(await review.runReview({ cwd: '/wt/a', env: {}, prompt: 'p', execImpl: odd.execImpl }), { ok: false, error: 'badVerdict' });

  const missing = fakeExec('', Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' }));
  assert.deepEqual(await review.runReview({ cwd: '/wt/a', env: {}, prompt: 'p', execImpl: missing.execImpl }), { ok: false, error: 'noClaude' });
});

test('readDiff: refuses option-shaped refs, reads stat + diff of base..head', async () => {
  const calls = [];
  const runGit = async (cwd, args) => {
    calls.push([cwd, args]);
    return { ok: true, stdout: args.includes('--stat') ? ' a.js | 1 +' : 'diff --git a/a.js b/a.js' };
  };
  assert.deepEqual(await review.readDiff({ cwd: '/wt/a', from: '--output=x', to: 'HEAD' }, runGit), { ok: false, error: 'badRef' });
  assert.equal(calls.length, 0);
  const res = await review.readDiff({ cwd: '/wt/a', from: 'abc1234', to: 'HEAD' }, runGit);
  assert.equal(res.ok, true);
  assert.equal(res.stat, ' a.js | 1 +');
  assert.ok(calls.every(([, args]) => args.includes('abc1234..HEAD')));
});

// ---- the run controller ------------------------------------------------------

const pkg = (id, extra = {}) => ({
  id,
  title: `T ${id}`,
  todoAts: [1],
  prompt: `do ${id}`,
  files: [`src/${id}.js`],
  dependsOn: [],
  verify: 'npm test',
  model: 'free',
  ...extra,
});

const PASS = { ok: true, verdict: 'pass', reasons: [] };

function setup({ packages, reviews = [PASS], extraDeps = {} } = {}) {
  let clock = T0;
  let seq = 0;
  const log = { sessions: [], writes: [], briefs: [], ticks: [], events: [], reviews: [], diffs: [], closed: [] };
  const timers = [];
  const alive = new Set();
  const queue = [...reviews];
  const orch = createOrchestra({
    now: () => clock,
    readTodos: () => [1, 2, 3].map((at) => ({ at, text: `t${at}`, done: false })),
    dirtyCount: async () => 0,
    baseBranchOf: async () => 'main',
    runPlanner: async () => ({ ok: true, raw: { packages, notes: '' }, costUsd: 0 }),
    addWorktree: async (repo, name) => ({ ok: true, root: path.join('/wt', name), cwd: path.join('/wt', name), branch: `luna/${name}` }),
    headSha: async () => 'base000',
    briefDir: () => '/cfg/tasks',
    writeBrief: (p, text) => {
      log.briefs.push([p, text]);
      return true;
    },
    createSession: (opts) => {
      seq += 1;
      log.sessions.push(opts);
      alive.add(`s${seq}`);
      return { id: `s${seq}` };
    },
    closeSession: (id) => {
      log.closed.push(id);
      alive.delete(id);
    },
    finishPackage: async () => ({ ok: true, headSha: 'abc1234' }),
    writePty: (sessionId, text) => {
      log.writes.push([sessionId, text]);
      return alive.has(sessionId);
    },
    sessionAlive: (id) => alive.has(id),
    tickTodos: (projectId, ats) => log.ticks.push([projectId, ats]),
    workerSettings: () => ({ model: 'plan', effort: 'plan', permissionMode: 'bypassPermissions', integration: 'branches', allowedTools: [] }),
    saveState: () => {},
    loadState: () => null,
    onRunEvent: (kind) => log.events.push(kind),
    setTimer: (fn, ms) => {
      const t = { fn, at: clock + ms, done: false };
      timers.push(t);
      return t;
    },
    clearTimer: (t) => {
      if (t) t.done = true;
    },
    freeProfileId: () => 'free-a',
    codingProfileId: () => 'free-coding',
    hybridProtected: () => DEFAULT_PROTECTED,
    freshEnv: () => ({ PATH: '/bin' }),
    usageLimits: () => [],
    reviewDiff: async (input) => {
      log.diffs.push(input);
      return { ok: true, diff: 'diff --git a/src/a.js b/src/a.js', stat: ' src/a.js | 1 +' };
    },
    runReview: async (input) => {
      log.reviews.push(input);
      return queue.length ? queue.shift() : PASS;
    },
    ...extraDeps,
  });
  orch.restore();
  const ctx = { projectId: 'p1', repoPath: '/repo', profileId: 'cloud', env: {} };
  const advance = (ms) => {
    clock += ms;
    for (const t of timers) {
      if (!t.done && t.at <= clock) {
        t.done = true;
        t.fn();
      }
    }
  };
  const flush = async (n = 4) => {
    for (let i = 0; i < n; i += 1) await new Promise((r) => setImmediate(r));
  };
  const byId = (id) => orch.view().packages.find((p) => p.id === id);
  return { orch, log, ctx, advance, flush, alive, byId, now: () => clock };
}

async function started(opts) {
  const s = setup(opts);
  const { plan } = await s.orch.makePlan({ ...s.ctx, workers: 'hybrid' });
  const res = await s.orch.launch({ planId: plan.id, ids: null, prompts: {}, workers: 'hybrid', integration: 'branches' });
  assert.equal(res.ok, true, `launch: ${res.error}`);
  return { ...s, planId: plan.id };
}

test('a free package runs on the coding profile (never auto:easy); a Claude package on the run profile', async () => {
  const s = await started({ packages: [pkg('a'), pkg('b', { model: 'sonnet' })] });
  const [a, b] = s.log.sessions;
  assert.equal(a.profileId, 'free-coding');
  assert.notEqual(a.profileId, 'freellm-auto');
  assert.equal(b.profileId, 'cloud');
  assert.equal(a.task.model, 'sonnet', 'the tier keys of the chain profile map Sonnet onto auto:coding');
  assert.equal(s.byId('a').hybrid.runsFree, true);
  assert.equal(s.byId('b').hybrid.runsFree, false);
});

test('review pass: the free package integrates like a Claude one, after one read-only review of its diff', async () => {
  const s = await started({ packages: [pkg('a')] });
  s.orch.onTurnEnd('s1', turn('LUNA_DONE a'));
  await s.flush();
  const a = s.byId('a');
  assert.equal(a.state, 'pushed');
  assert.equal(a.hybrid.review.result, 'pass');
  assert.deepEqual(s.log.ticks, [['p1', [1]]]);
  assert.equal(s.log.reviews.length, 1);
  const root = s.log.sessions[0].cwd;
  assert.equal(s.log.reviews[0].cwd, root, 'the review reads the package worktree');
  assert.deepEqual(s.log.reviews[0].env, { PATH: '/bin' });
  assert.match(s.log.reviews[0].prompt, /diff --git a\/src\/a\.js/);
  assert.deepEqual(s.log.diffs[0], { cwd: root, from: 'base000', to: 'abc1234' });
  assert.ok(s.log.events.includes('reviewing') && s.log.events.includes('reviewed'));
});

test('a Claude package is never reviewed', async () => {
  const s = await started({ packages: [pkg('b', { model: 'sonnet' })] });
  s.orch.onTurnEnd('s1', turn('LUNA_DONE b'));
  await s.flush();
  assert.equal(s.byId('b').state, 'pushed');
  assert.equal(s.log.reviews.length, 0);
  assert.equal(s.byId('b').hybrid.review, null);
});

test('review fail: handed to Sonnet from its own worktree with the findings; no second review', async () => {
  const s = await started({ packages: [pkg('a')], reviews: [{ ok: true, verdict: 'fail', reasons: ['breaks the API'] }] });
  s.orch.onTurnEnd('s1', turn('LUNA_DONE a'));
  await s.flush();
  const a = s.byId('a');
  assert.equal(a.state, 'launched');
  assert.equal(a.sessionId, 's2');
  assert.equal(a.hybrid.review.result, 'fail');
  assert.deepEqual(a.hybrid.handOvers.map((h) => h.kind), ['reviewFail']);
  assert.equal(a.hybrid.runsFree, false);
  const [free, sonnet] = s.log.sessions;
  assert.equal(sonnet.cwd, free.cwd, 'same worktree');
  assert.equal(sonnet.branch, free.branch, 'same branch');
  assert.equal(sonnet.profileId, 'cloud');
  assert.equal(sonnet.task.model, 'sonnet');
  const brief = s.log.briefs[s.log.briefs.length - 1][1];
  assert.match(brief, /## Handed over to you/);
  assert.match(brief, /breaks the API/);
  assert.deepEqual(s.log.ticks, [], 'not integrated');
  assert.deepEqual(s.log.closed, ['s1'], 'the free tab is closed');
  // Sonnet finishes: it integrates without another review.
  s.orch.onTurnEnd('s2', turn('LUNA_DONE a'));
  await s.flush();
  assert.equal(s.byId('a').state, 'pushed');
  assert.equal(s.log.reviews.length, 1);
});

test('a review that cannot run fails closed: handed to Sonnet, never integrated unreviewed', async () => {
  const s = await started({ packages: [pkg('a')], reviews: [{ ok: false, error: 'badVerdict' }] });
  s.orch.onTurnEnd('s1', turn('LUNA_DONE a'));
  await s.flush();
  const a = s.byId('a');
  assert.equal(a.state, 'launched');
  assert.equal(a.hybrid.review.result, 'error');
  assert.deepEqual(a.hybrid.handOvers.map((h) => h.kind), ['reviewFail']);
  assert.deepEqual(s.log.ticks, []);
});

test('review on a Claude limit waits for the reset (package stays finishing), then reviews again', async () => {
  const resetSec = Math.floor((T0 + 2 * HOUR) / 1000);
  const s = await started({ packages: [pkg('a')], reviews: [{ ok: false, error: 'limit', detail: `usage limit reached|${resetSec}` }, PASS] });
  s.orch.onTurnEnd('s1', turn('LUNA_DONE a'));
  await s.flush();
  let a = s.byId('a');
  assert.equal(a.state, 'finishing');
  assert.ok(a.hybrid.reviewWait.until >= resetSec * 1000);
  assert.equal(s.orch.view().settled, false, 'the run does not settle under a waiting review');
  assert.equal(s.orch.view().pausedUntil, null, 'the run is not paused');
  s.advance(HOUR);
  await s.flush();
  assert.equal(s.log.reviews.length, 1, 'not before the reset');
  s.advance(HOUR + 2 * MIN);
  await s.flush();
  a = s.byId('a');
  assert.equal(a.state, 'pushed');
  assert.equal(s.log.reviews.length, 2);
  assert.equal(a.hybrid.reviewWait, null);
});

test('kill while a review waits on the limit stops the package', async () => {
  const resetSec = Math.floor((T0 + HOUR) / 1000);
  const s = await started({ packages: [pkg('a')], reviews: [{ ok: false, error: 'limit', detail: `limit reached|${resetSec}` }] });
  s.orch.onTurnEnd('s1', turn('LUNA_DONE a'));
  await s.flush();
  assert.equal(s.byId('a').state, 'finishing');
  s.orch.kill();
  assert.equal(s.byId('a').state, 'killed');
  s.advance(2 * HOUR);
  await s.flush();
  assert.equal(s.log.reviews.length, 1, 'no review after the kill');
});

test('two stalls: the free package goes to Sonnet in its worktree, not to Opus', async () => {
  const s = await started({ packages: [pkg('a')] });
  s.orch.onTurnEnd('s1', turn('LUNA_BLOCKED a: cannot find the module'));
  s.advance(10_000);
  await s.flush();
  // First stall: the usual one automatic resume, still on the free worker.
  assert.equal(s.byId('a').sessionId, 's2');
  assert.equal(s.log.sessions[1].profileId, 'free-coding');
  s.orch.onTurnEnd('s2', turn('LUNA_BLOCKED a: still stuck'));
  s.advance(10_000);
  await s.flush();
  const a = s.byId('a');
  assert.equal(a.state, 'launched');
  assert.equal(a.sessionId, 's3');
  assert.deepEqual(a.hybrid.handOvers.map((h) => h.kind), ['twoStalls']);
  const sonnet = s.log.sessions[2];
  assert.equal(sonnet.profileId, 'cloud');
  assert.equal(sonnet.task.model, 'sonnet');
  assert.equal(sonnet.cwd, s.log.sessions[0].cwd, 'hand-over keeps the worktree');
  assert.equal(sonnet.branch, s.log.sessions[0].branch);
  assert.ok(!s.log.events.includes('escalated'), 'no Opus escalation');
});

// ---- F6d: waiting on free limits ------------------------------------------------

test('free limit with a Claude package depending on it: still waiting at 59 min, handed over at 60 min', async () => {
  const s = await started({ packages: [pkg('a'), pkg('b', { model: 'sonnet', dependsOn: ['a'] })] });
  assert.equal(s.log.sessions.length, 1, 'b waits for a');
  s.orch.onUsageLimit('s1', s.now() + 3 * HOUR);
  assert.equal(s.orch.view().pausedUntil, null, 'only the free package waits');
  assert.ok(s.byId('a').hybrid.freeWait);
  s.advance(59 * MIN);
  await s.flush();
  assert.equal(s.byId('a').sessionId, 's1');
  assert.ok(s.byId('a').hybrid.freeWait, 'still waiting at 59 min');
  assert.equal(s.log.sessions.length, 1);
  s.advance(MIN);
  await s.flush();
  const a = s.byId('a');
  assert.equal(a.sessionId, 's2');
  assert.equal(a.hybrid.freeWait, null);
  assert.deepEqual(a.hybrid.handOvers.map((h) => h.kind), ['freeWait']);
  assert.equal(s.log.sessions[1].profileId, 'cloud');
  assert.equal(s.log.sessions[1].task.model, 'sonnet');
  assert.equal(s.log.sessions[1].cwd, s.log.sessions[0].cwd);
});

test('free limit with no dependants: it waits past the hour for the reset, then resumes in its tab', async () => {
  const s = await started({ packages: [pkg('a')] });
  const reset = s.now() + 2 * HOUR;
  s.orch.onUsageLimit('s1', reset);
  s.advance(61 * MIN);
  await s.flush();
  assert.ok(s.byId('a').hybrid.freeWait, 'no hand-over without dependants');
  assert.equal(s.log.sessions.length, 1);
  assert.equal(s.log.writes.length, 0);
  s.advance(reset + hybrid.RESUME_GRACE_MS - s.now());
  await s.flush();
  assert.equal(s.byId('a').hybrid.freeWait, null);
  assert.deepEqual(s.log.writes.map(([id]) => id), ['s1']);
  assert.equal(s.log.writes[0][1], sup.RESUME_TEXT);
  assert.deepEqual(s.byId('a').hybrid.handOvers, []);
});

test('a closed tab or a kill ends the free wait: a retried worker is nudged and timed again', async () => {
  // b keeps the run going, so the closed package is retried, not finalized.
  const s = await started({ packages: [pkg('a'), pkg('b', { model: 'sonnet' })] });
  s.orch.onUsageLimit('s1', s.now() + 2 * HOUR);
  assert.ok(s.byId('a').hybrid.freeWait);
  s.orch.onSessionClosed('s1');
  assert.equal(s.byId('a').state, 'closed');
  assert.equal(s.byId('a').hybrid.freeWait, null);
  const again = await s.orch.retry({ planId: s.planId, id: 'a' });
  assert.equal(again.ok, true, String(again.error));
  assert.equal(s.byId('a').sessionId, 's3');
  assert.equal(s.log.sessions[2].profileId, 'free-coding', 'still the free worker');
  s.orch.onTurnEnd('s3', turn('still working'));
  s.advance(30_000);
  assert.ok(s.log.writes.some(([id, text]) => id === 's3' && /LUNA_DONE a/.test(text)), 'nudged again');
  s.advance(3 * HOUR);
  await s.flush();
  assert.ok(!s.log.writes.some(([id, text]) => id === 's1' && text === sup.RESUME_TEXT), 'the old wait timer is gone');

  const k = await started({ packages: [pkg('a')] });
  k.orch.onUsageLimit('s1', k.now() + 2 * HOUR);
  k.orch.kill();
  assert.equal(k.byId('a').state, 'killed');
  assert.equal(k.byId('a').hybrid.freeWait, null);
});

test('a free limit never pauses the run: Claude packages keep going and finish', async () => {
  const s = await started({ packages: [pkg('a'), pkg('b', { model: 'sonnet' })] });
  s.orch.onUsageLimit('s1', s.now() + 2 * HOUR);
  assert.equal(s.orch.view().pausedUntil, null);
  s.orch.onTurnEnd('s1', turn('hit the wall'));
  s.advance(30_000);
  s.orch.tick();
  assert.equal(s.log.writes.filter(([id]) => id === 's1').length, 0, 'no nudge into a waiting tab');
  assert.equal(s.byId('b').state, 'launched');
  s.orch.onTurnEnd('s2', turn('LUNA_DONE b'));
  await s.flush();
  assert.equal(s.byId('b').state, 'pushed');
  assert.equal(s.byId('a').state, 'launched');
  // A Claude worker's limit still pauses the run as before.
  const c = await started({ packages: [pkg('a'), pkg('b', { model: 'sonnet' })] });
  c.orch.onUsageLimit('s2', c.now() + HOUR);
  assert.ok(c.orch.view().pausedUntil);
});

// ---- report --------------------------------------------------------------------

test('report: one row per package - planned free, guard upgrade, review, hand-overs', async () => {
  const packages = [pkg('a'), pkg('ipc', { files: ['src/preload.js'] }), pkg('b', { model: 'opus' })];
  const s = await started({ packages, reviews: [{ ok: true, verdict: 'fail', reasons: ['no <test>'] }] });
  s.orch.onTurnEnd('s1', turn('LUNA_DONE a'));
  await s.flush();
  const view = s.orch.view();
  const md = buildReport(view, { now: s.now(), suggestions: [] });
  assert.match(md, /## Free packages \(hybrid run\)/);
  assert.match(md, /- 2 of 3 planned free; 0 passed the Claude review; 1 handed to Sonnet/);
  assert.match(md, /\| `a` \| yes \| - \| fail: no <test> \| to Sonnet \(review failed\) \|/);
  assert.match(md, /\| `ipc` \| yes \| to Sonnet: protected path \(preload\): src\/preload\.js \| - \| - \|/);
  assert.match(md, /\| `b` \| no \| - \| - \| - \|/);
  const html = renderRunReportHtml(view, { now: s.now() });
  assert.match(html, /Free packages \(hybrid run\)/);
  assert.match(html, /no &lt;test&gt;/);
  assert.doesNotMatch(html, /no <test>/);
  // Every hand-over kind has its own words.
  const rows = hybrid.hybridReportLines({
    workers: 'hybrid',
    packages: [{ id: 'x', model: 'free', hybrid: { handOvers: [{ kind: 'twoStalls' }, { kind: 'freeWait' }] } }],
  });
  assert.ok(rows.some((r) => r.includes('to Sonnet (stalled twice); to Sonnet (waited 1 h on free limits)')));
});

test('report: no hybrid section for a Claude-only or a free-only run', () => {
  assert.deepEqual(hybrid.hybridReportLines({ workers: 'claude', packages: [pkg('a')] }), []);
  assert.deepEqual(hybrid.hybridReportLines({ workers: 'free', freeMode: true, packages: [pkg('a')] }), []);
  assert.equal(hybrid.hybridReportRows({ workers: 'claude', packages: [] }), null);
});

test('a hybrid run round-trips its coding profile and the review / hand-over record', async () => {
  let saved = null;
  const s = await started({
    packages: [pkg('a')],
    reviews: [{ ok: true, verdict: 'fail', reasons: ['x'] }],
    extraDeps: { saveState: (data) => (saved = data) },
  });
  s.orch.onTurnEnd('s1', turn('LUNA_DONE a'));
  await s.flush();
  const back = sup.normalizeStoredPlan(JSON.parse(JSON.stringify(saved)));
  assert.equal(back.hybridProfileId, 'free-coding');
  const a = back.packages.find((p) => p.id === 'a');
  assert.equal(a.modelOverride, 'sonnet');
  assert.equal(a.hybrid.review.result, 'fail');
  assert.deepEqual(a.hybrid.handOvers.map((h) => h.kind), ['reviewFail']);
});
