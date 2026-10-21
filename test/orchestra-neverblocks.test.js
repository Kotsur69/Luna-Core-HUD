// ============================================================================
// God Mode never blocks 3/5: machinery auto-retry ladder, one automatic
// resume of a stalled worker, unattended approval timeout, and dependents of
// a terminal package marked blockedBy - pure rules plus the controller with
// git, tabs and timers faked.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const sup = require('../src/orchestraSupervisor.js');
const { createOrchestra, AUTO_RETRY_DELAY_MS, MAX_AUTO_RETRIES } = require('../src/orchestra.js');

const turn = (text) =>
  JSON.stringify({ type: 'assistant', message: { stop_reason: 'end_turn', content: [{ type: 'text', text }] } });

const pkg = (id, todoAts, extra = {}) => ({
  id,
  title: `T ${id}`,
  todoAts,
  prompt: `do ${id}`,
  files: [],
  dependsOn: [],
  verify: 'npm test',
  model: 'sonnet',
  ...extra,
});

// ---- pure rules --------------------------------------------------------------

test('shouldAutoResume: a resumable reason, once, only with a worktree', () => {
  const p = { autoResumed: false, root: '/wt/a', branch: 'luna/a' };
  for (const reason of ['noMarker', 'blocked', 'verifyFailed', 'timeout', 'noCommitsFailed']) {
    assert.equal(sup.shouldAutoResume(p, reason), true, reason);
  }
  for (const reason of ['needsApproval', 'noTab', 'pushFailed', 'restarted']) {
    assert.equal(sup.shouldAutoResume(p, reason), false, reason);
  }
  assert.equal(sup.shouldAutoResume({ ...p, autoResumed: true }, 'noMarker'), false);
  assert.equal(sup.shouldAutoResume({ ...p, root: null }, 'noMarker'), false);
});

test('withBlockedBy marks pending dependents of a terminal package, transitively, and clears them again', () => {
  const pkgs = [
    { id: 'a', state: 'stalled', terminal: true, dependsOn: [], blockedBy: null },
    { id: 'b', state: 'pending', terminal: false, dependsOn: ['a'], blockedBy: null },
    { id: 'c', state: 'pending', terminal: false, dependsOn: ['b'], blockedBy: null },
    { id: 'd', state: 'pending', terminal: false, dependsOn: [], blockedBy: null },
    { id: 'e', state: 'pushed', terminal: false, dependsOn: ['a'], blockedBy: null },
  ];
  const marked = sup.withBlockedBy(pkgs);
  assert.deepEqual(marked.map((p) => p.blockedBy), [null, 'a', 'a', null, null]);
  assert.equal(marked[3], pkgs[3], 'unchanged packages keep their identity');
  const cleared = sup.withBlockedBy(marked.map((p) => (p.id === 'a' ? { ...p, terminal: false } : p)));
  assert.deepEqual(cleared.map((p) => p.blockedBy), [null, null, null, null, null]);
  // A dependency cycle (refused by validatePlan, but stored files are untrusted) never loops.
  const cyc = sup.withBlockedBy([
    { id: 'x', state: 'pending', dependsOn: ['y'] },
    { id: 'y', state: 'pending', dependsOn: ['x'] },
  ]);
  assert.deepEqual(cyc.map((p) => p.blockedBy || null), [null, null]);
});

test('approvalExpired: a needsApproval stall older than the limit; 0 waits forever', () => {
  const p = { state: 'stalled', error: 'needsApproval', stalledAt: 0 };
  assert.equal(sup.approvalExpired(p, 30 * 60_000 + 1, 30), true);
  assert.equal(sup.approvalExpired(p, 30 * 60_000, 30), false);
  assert.equal(sup.approvalExpired(p, 1e12, 0), false);
  assert.equal(sup.approvalExpired({ ...p, error: 'noMarker' }, 1e12, 30), false);
  assert.equal(sup.approvalExpired({ ...p, stalledAt: null }, 1e12, 30), false);
});

test('normalizeOptions defaults and caps unattendedApprovalMin', () => {
  assert.deepEqual(sup.normalizeOptions(undefined), { unattendedApprovalMin: 30, sleepOnLimit: false, shutdownWhenDone: false });
  assert.deepEqual(sup.normalizeOptions({ unattendedApprovalMin: 0 }), { unattendedApprovalMin: 0, sleepOnLimit: false, shutdownWhenDone: false });
  assert.deepEqual(sup.normalizeOptions({ unattendedApprovalMin: 12.6 }), { unattendedApprovalMin: 13, sleepOnLimit: false, shutdownWhenDone: false });
  assert.deepEqual(sup.normalizeOptions({ unattendedApprovalMin: -5 }), { unattendedApprovalMin: 30, sleepOnLimit: false, shutdownWhenDone: false });
  assert.deepEqual(sup.normalizeOptions({ unattendedApprovalMin: 1e9 }), { unattendedApprovalMin: sup.MAX_APPROVAL_MIN, sleepOnLimit: false, shutdownWhenDone: false });
  assert.deepEqual(sup.normalizeOptions({ unattendedApprovalMin: '5' }), { unattendedApprovalMin: 30, sleepOnLimit: false, shutdownWhenDone: false });
});

test('stored never-blocks fields are validated; a legacy plan loads with defaults', () => {
  const legacy = sup.normalizeStoredPlan({ id: 'p', repoPath: path.resolve('/r'), packages: [{ id: 'a', state: 'stalled' }] });
  assert.deepEqual(legacy.options, { unattendedApprovalMin: 30, sleepOnLimit: false, shutdownWhenDone: false });
  const lp = legacy.packages[0];
  assert.deepEqual([lp.autoRetries, lp.autoResumed, lp.terminal, lp.blockedBy, lp.stalledAt], [0, false, false, null, null]);

  const stored = sup.normalizeStoredPlan({
    id: 'p',
    repoPath: path.resolve('/r'),
    options: { unattendedApprovalMin: 45, junk: 1 },
    packages: [
      { id: 'a', state: 'failed', autoRetries: 99, autoResumed: true, terminal: true, stalledAt: 5 },
      { id: 'b', state: 'pending', autoRetries: -1, autoResumed: 'yes', terminal: 1, blockedBy: 'a' },
      { id: 'c', state: 'pending', blockedBy: '../evil' },
    ],
  });
  assert.deepEqual(stored.options, { unattendedApprovalMin: 45, sleepOnLimit: false, shutdownWhenDone: false });
  assert.deepEqual(
    stored.packages.map((p) => [p.autoRetries, p.autoResumed, p.terminal, p.blockedBy, p.stalledAt]),
    [
      [MAX_AUTO_RETRIES, true, true, null, 5],
      [0, false, false, 'a', null],
      [0, false, false, null, null],
    ],
  );
});

// ---- controller ----------------------------------------------------------------

function setup({ packages, settings, addWorktree } = {}) {
  let clock = 1_000_000;
  let seq = 0;
  const log = { sessions: [], writes: [], events: [], worktrees: [], briefs: new Map(), closed: [], finishes: [] };
  const timers = [];
  const alive = new Set();
  const orch = createOrchestra({
    now: () => clock,
    readTodos: () => [1, 2, 3, 4].map((at) => ({ at, text: `t${at}`, done: false })),
    dirtyCount: async () => 0,
    runPlanner: async () => ({ ok: true, raw: { packages, notes: '' }, costUsd: 0 }),
    addWorktree: async (repo, name, opts) => {
      log.worktrees.push(name);
      if (addWorktree) {
        const res = addWorktree(name, log.worktrees.length);
        if (res) return res;
      }
      return { ok: true, root: path.join('/wt', name), cwd: path.join('/wt', name), branch: `luna/${name}` };
    },
    headSha: async () => 'base',
    briefDir: () => '/cfg/tasks',
    writeBrief: (file, text) => {
      log.briefs.set(file, text);
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
    finishPackage: async (p) => {
      log.finishes.push(p.id);
      return { ok: true, headSha: `${p.id}aaaaaaa` };
    },
    writePty: (sessionId, text) => {
      log.writes.push([sessionId, text]);
      return alive.has(sessionId);
    },
    sessionAlive: (id) => alive.has(id),
    workerSettings: () => settings || { model: 'opus', permissionMode: 'bypassPermissions' },
    onRunEvent: (kind, data) => log.events.push([kind, data]),
    sleep: async () => {},
    setTimer: (fn, ms) => {
      const t = { fn, at: clock + ms, done: false };
      timers.push(t);
      return t;
    },
    clearTimer: (t) => {
      if (t) t.done = true;
    },
  });
  const ctx = { projectId: 'p1', repoPath: '/repo', profileId: 'cloud', env: {} };
  const advance = (ms) => {
    clock += ms;
    for (const t of [...timers]) {
      if (!t.done && t.at <= clock) {
        t.done = true;
        t.fn();
      }
    }
  };
  const flush = async (n = 4) => {
    for (let i = 0; i < n; i += 1) await new Promise((r) => setImmediate(r));
  };
  const view = (id) => orch.view().packages.find((p) => p.id === id);
  return { orch, log, ctx, advance, flush, alive, view };
}

async function started(opts) {
  const s = setup(opts);
  const { plan } = await s.orch.makePlan(s.ctx);
  await s.orch.launch({ planId: plan.id });
  return { ...s, planId: plan.id };
}

test('a launch failure is retried after 2 min and stops when the same error repeats', async () => {
  const s = await started({ packages: [pkg('a', [1])], addWorktree: () => ({ ok: false, error: 'gitFailed' }) });
  let a = s.view('a');
  assert.deepEqual([a.state, a.error, a.autoRetries, a.terminal], ['failed', 'gitFailed', 1, false]);
  assert.equal(s.log.events.some(([k]) => k === 'needYou'), false, 'a scheduled retry keeps the run open');

  s.advance(AUTO_RETRY_DELAY_MS - 1);
  await s.flush();
  assert.equal(s.log.worktrees.length, 1, 'not before 2 minutes');
  s.advance(1);
  await s.flush();
  assert.equal(s.log.worktrees.length, 2);
  a = s.view('a');
  assert.deepEqual([a.state, a.error, a.terminal], ['failed', 'gitFailed', true], 'same error twice -> terminal');

  s.advance(10 * AUTO_RETRY_DELAY_MS);
  await s.flush();
  assert.equal(s.log.worktrees.length, 2, 'nothing more is tried');
  assert.ok(s.log.events.some(([k]) => k === 'needYou'), 'the run settles once nothing is scheduled');
});

test('different launch errors are retried at most twice, then terminal', async () => {
  const errors = ['gitFailed', 'exists', 'notRepo', 'badName'];
  const s = await started({
    packages: [pkg('a', [1])],
    addWorktree: (_name, n) => ({ ok: false, error: errors[n - 1] }),
  });
  for (let i = 0; i < MAX_AUTO_RETRIES; i += 1) {
    s.advance(AUTO_RETRY_DELAY_MS);
    await s.flush();
  }
  assert.equal(s.log.worktrees.length, 1 + MAX_AUTO_RETRIES);
  const a = s.view('a');
  assert.deepEqual([a.state, a.error, a.autoRetries, a.terminal], ['failed', 'notRepo', MAX_AUTO_RETRIES, true]);
  s.advance(AUTO_RETRY_DELAY_MS);
  await s.flush();
  assert.equal(s.log.worktrees.length, 1 + MAX_AUTO_RETRIES);
});

test('a launch that fails once and works on the automatic retry runs normally', async () => {
  const s = await started({
    packages: [pkg('a', [1])],
    addWorktree: (_name, n) => (n === 1 ? { ok: false, error: 'gitFailed' } : null),
  });
  s.advance(AUTO_RETRY_DELAY_MS);
  await s.flush();
  const a = s.view('a');
  assert.deepEqual([a.state, a.error, a.autoRetries, a.terminal], ['launched', null, 1, false]);
});

test('kill cancels a scheduled automatic retry', async () => {
  const s = await started({
    packages: [pkg('a', [1]), pkg('b', [2])],
    addWorktree: (name) => (name.startsWith('b') ? { ok: false, error: 'gitFailed' } : null),
  });
  assert.equal(s.view('b').state, 'failed');
  s.orch.kill();
  s.advance(AUTO_RETRY_DELAY_MS * 3);
  await s.flush();
  assert.equal(s.log.worktrees.filter((n) => n.startsWith('b')).length, 1);
  assert.equal(s.view('b').terminal, false, 'a kill is not a give-up');
});

test('an Opus worker that stalls with noMarker is resumed once automatically, then terminal', async () => {
  const s = await started({ packages: [pkg('a', [1])] });
  const exhaust = (sid) => {
    for (let i = 0; i <= sup.MAX_NUDGES; i += 1) {
      s.orch.onTurnEnd(sid, turn('working'));
      s.advance(10_000);
    }
  };
  exhaust('s1');
  let a = s.view('a');
  assert.deepEqual([a.state, a.autoResumed, a.sessionId], ['launched', true, 's2']);
  assert.deepEqual(s.log.closed, ['s1'], 'the stuck tab is closed after the new one opened');
  assert.equal(s.log.sessions[1].cwd, s.log.sessions[0].cwd, 'same worktree');
  assert.equal(s.log.sessions[1].branch, s.log.sessions[0].branch);
  const brief = s.log.briefs.get(s.log.sessions[1].task.briefPath);
  assert.match(brief, /RESUMING/);
  assert.match(brief, /noMarker/, 'the resume brief names the stall reason');
  assert.ok(s.log.events.some(([k]) => k === 'autoResumed'));

  exhaust('s2');
  a = s.view('a');
  assert.deepEqual([a.state, a.error, a.terminal], ['stalled', 'noMarker', true]);
  assert.equal(s.log.sessions.length, 2, 'no third tab');
});

test('a blocked worker is resumed with the blocker in its brief', async () => {
  const s = await started({ packages: [pkg('a', [1])] });
  s.orch.onTurnEnd('s1', turn('LUNA_BLOCKED a: missing API key'));
  assert.equal(s.view('a').state, 'launched');
  assert.match(s.log.briefs.get(s.log.sessions[1].task.briefPath), /missing API key/);
});

test('a Sonnet worker: resume, then Opus escalation, then terminal', async () => {
  const s = await started({ packages: [pkg('a', [1])], settings: { model: 'sonnet', permissionMode: 'bypassPermissions' } });
  s.orch.onTurnEnd('s1', turn('LUNA_BLOCKED a: one'));
  assert.deepEqual([s.view('a').state, s.view('a').autoResumed, s.view('a').model], ['launched', true, 'sonnet']);
  s.orch.onTurnEnd('s2', turn('LUNA_BLOCKED a: two'));
  assert.deepEqual([s.view('a').state, s.view('a').escalated, s.view('a').model], ['launched', true, 'opus']);
  s.orch.onTurnEnd('s3', turn('LUNA_BLOCKED a: three'));
  assert.deepEqual([s.view('a').state, s.view('a').terminal], ['stalled', true]);
});

test('a needsApproval stall older than 30 min closes its tab as approvalTimeout; nothing is approved', async () => {
  const s = await started({ packages: [pkg('a', [1])] });
  s.orch.onApproval('s1', 'Bash(npx tsc:*)', 'npx tsc --noEmit');
  s.advance(29 * 60_000);
  s.orch.tick();
  assert.deepEqual([s.view('a').error, s.log.closed], ['needsApproval', []]);
  s.advance(2 * 60_000);
  s.orch.tick();
  const a = s.view('a');
  assert.deepEqual([a.state, a.error, a.detail, a.terminal], ['stalled', 'approvalTimeout', 'Bash(npx tsc:*)', true]);
  assert.deepEqual(s.log.closed, ['s1']);
  assert.deepEqual(s.log.writes, [], 'nothing is ever typed into the prompt');
  assert.deepEqual(s.orch.view().suggestions.map((x) => x.rule), ['Bash(npx tsc:*)'], 'the rule stays a suggestion');
  assert.equal(s.orch.view().options.unattendedApprovalMin, 30);
  s.orch.tick();
  assert.deepEqual(s.log.closed, ['s1'], 'closed once');
});

test('unattendedApprovalMin 0 waits for Mati forever', async () => {
  const s = await started({
    packages: [pkg('a', [1])],
    settings: { model: 'opus', permissionMode: 'bypassPermissions', unattendedApprovalMin: 0 },
  });
  s.orch.onApproval('s1', 'Edit');
  s.advance(10 * 60 * 60_000);
  s.orch.tick();
  assert.deepEqual([s.view('a').error, s.view('a').terminal, s.log.closed], ['needsApproval', false, []]);
});

test('dependents of a terminal package show blockedBy and launch after a successful morning Retry', async () => {
  const s = await started({
    packages: [pkg('a', [1]), pkg('b', [2], { dependsOn: ['a'] }), pkg('c', [3], { dependsOn: ['b'] }), pkg('d', [4])],
  });
  s.orch.onTurnEnd('s1', turn('LUNA_BLOCKED a: one'));
  const resumed = s.view('a').sessionId;
  s.orch.onTurnEnd(resumed, turn('LUNA_BLOCKED a: two'));
  await s.flush();
  assert.equal(s.view('a').terminal, true);
  assert.deepEqual(['b', 'c', 'd'].map((id) => [s.view(id).state, s.view(id).blockedBy]), [
    ['pending', 'a'],
    ['pending', 'a'],
    ['launched', null],
  ]);

  // Morning: Mati retries a; its dependents are unblocked and start on their own once it pushes.
  assert.equal((await s.orch.retry({ planId: s.planId, id: 'a' })).ok, true);
  assert.equal(s.view('a').terminal, false);
  assert.deepEqual(['b', 'c'].map((id) => s.view(id).blockedBy), [null, null]);
  s.orch.onTurnEnd(s.view('a').sessionId, turn('LUNA_DONE a'));
  await s.flush();
  assert.equal(s.view('a').state, 'pushed');
  assert.equal(s.view('b').state, 'launched');
});

test('a terminal package finished by hand on its open tab clears terminal and its dependents start', async () => {
  const s = await started({ packages: [pkg('a', [1]), pkg('b', [2], { dependsOn: ['a'] })] });
  s.orch.onTurnEnd('s1', turn('LUNA_BLOCKED a: one'));
  s.orch.onTurnEnd('s2', turn('LUNA_BLOCKED a: two'));
  await s.flush();
  assert.equal(s.view('b').blockedBy, 'a');
  // Mati answers in the still-open tab; the worker carries on and finishes.
  s.orch.onTurnEnd('s2', turn('LUNA_DONE a'));
  await s.flush();
  assert.deepEqual([s.view('a').state, s.view('a').terminal], ['pushed', false]);
  assert.deepEqual([s.view('b').state, s.view('b').blockedBy], ['launched', null]);
});
