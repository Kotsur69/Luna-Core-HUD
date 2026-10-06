// ============================================================================
// God Mode v2 supervisor (ORCHESTRATOR_PLAN.md slice 4): the pure rules in
// orchestraSupervisor.js, then the run controller driving them with every
// side effect (git, tabs, timers, disk) faked.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const sup = require('../src/orchestraSupervisor.js');
const { createOrchestra } = require('../src/orchestra.js');
const { withTaskBrief } = require('../src/launch.js');

/** A transcript fragment whose last finished assistant message says `text`. */
const turn = (text) =>
  JSON.stringify({ type: 'assistant', message: { stop_reason: 'end_turn', content: [{ type: 'text', text }] } });

// ---- pure rules --------------------------------------------------------------

test('markerFrom reads only this package\'s marker from the final message', () => {
  assert.deepEqual(sup.markerFrom(turn('All good.\n\nLUNA_DONE a'), 'a'), { kind: 'done' });
  assert.deepEqual(sup.markerFrom(turn('`LUNA_DONE a`\nThanks!'), 'a'), { kind: 'done' }, 'code span + trailing line');
  assert.deepEqual(sup.markerFrom(turn('LUNA_BLOCKED a: no API key'), 'a'), { kind: 'blocked', reason: 'no API key' });
  assert.equal(sup.markerFrom(turn('LUNA_DONE b'), 'a'), null, 'another package\'s marker');
  assert.equal(sup.markerFrom(turn('LUNA_DONE ab'), 'a'), null, 'prefix of another id');
  assert.equal(sup.markerFrom(turn('I will print LUNA_DONE a when done.'), 'a'), null, 'mentioned, not printed');
  assert.equal(sup.markerFrom('{"type":"assistant","message":{"stop_reason":"tool_use"}}', 'a'), null);
  assert.equal(sup.markerFrom('not json', 'a'), null);
});

test('turnEndAction: finish on DONE, stall on BLOCKED, nudge until the cap', () => {
  assert.deepEqual(sup.turnEndAction({ nudges: 0 }, { kind: 'done' }), { type: 'finish' });
  assert.deepEqual(sup.turnEndAction({ nudges: 0 }, { kind: 'blocked', reason: 'x' }), {
    type: 'stall',
    reason: 'blocked',
    detail: 'x',
  });
  assert.deepEqual(sup.turnEndAction({ nudges: sup.MAX_NUDGES - 1 }, null), { type: 'nudge' });
  assert.deepEqual(sup.turnEndAction({ nudges: sup.MAX_NUDGES }, null), { type: 'stall', reason: 'noMarker' });
  assert.equal(sup.verifyFailAction({ verifyRounds: 0 }), 'retry');
  assert.equal(sup.verifyFailAction({ verifyRounds: sup.MAX_VERIFY_ROUNDS }), 'stall');
});

test('readyToLaunch honours pushed dependencies and free slots; isSettled ends the run', () => {
  const p = (id, state, dependsOn = []) => ({ id, state, dependsOn });
  const pkgs = [p('a', 'launched'), p('b', 'pending'), p('c', 'pending', ['a']), p('d', 'pending')];
  assert.deepEqual(sup.readyToLaunch(pkgs, 3).map((x) => x.id), ['b', 'd']);
  assert.deepEqual(sup.readyToLaunch(pkgs, 2).map((x) => x.id), ['b']);
  assert.deepEqual(sup.readyToLaunch([p('a', 'pushed'), p('c', 'pending', ['a'])], 3).map((x) => x.id), ['c']);
  assert.equal(sup.isSettled([p('a', 'stalled'), p('c', 'pending', ['a'])], 3), true, 'blocked on a stalled dep');
  assert.equal(sup.isSettled([p('a', 'pending')], 3), false, 'never started');
  assert.equal(sup.isSettled([p('a', 'finishing')], 3), false);
});

test('timedOut excludes paused time', () => {
  assert.equal(sup.timedOut({ startedAt: 0, pausedMs: 0 }, sup.WORKER_CAP_MS + 1), true);
  assert.equal(sup.timedOut({ startedAt: 0, pausedMs: 10 }, sup.WORKER_CAP_MS + 1), false);
  assert.equal(sup.timedOut({ startedAt: null, pausedMs: 0 }, 1e12), false);
});

test('a stored plan round-trips, a broken one is null, a restart stalls running work', () => {
  assert.equal(sup.normalizeStoredPlan(null), null);
  assert.equal(sup.normalizeStoredPlan({ id: 'p', repoPath: '/r', packages: [] }), null);
  assert.equal(sup.normalizeStoredPlan('garbage'), null);
  const stored = sup.normalizeStoredPlan({
    id: 'p1',
    repoPath: '/r',
    todoText: [[1, 'one'], ['bad']],
    packages: [
      { id: 'a', state: 'launched', sessionId: 's1', root: '/wt/a' },
      { id: 'b', state: 'pushed', sessionId: 's2' },
      { id: 'c', state: 'nonsense' },
      { nope: true },
    ],
  });
  assert.deepEqual([...stored.todoText.entries()], [[1, 'one']]);
  assert.deepEqual(stored.packages.map((p) => p.state), ['launched', 'pushed', 'pending']);
  const back = sup.restoreAfterRestart(stored);
  assert.deepEqual(back.packages.map((p) => [p.state, p.error, p.sessionId]), [
    ['stalled', 'restarted', null],
    ['pushed', null, null],
    ['pending', null, null],
  ]);
  assert.deepEqual(sup.normalizeStoredPlan(JSON.parse(JSON.stringify(sup.serializePlan(stored)))).packages, stored.packages);
});

test('withTaskBrief adds the worker permission mode unless the profile decides it', () => {
  const task = { briefPath: '/t/a.md', permissionMode: 'bypassPermissions' };
  assert.match(withTaskBrief('claude', task), /--permission-mode bypassPermissions$/);
  assert.doesNotMatch(withTaskBrief('claude --dangerously-skip-permissions', task), /--permission-mode/);
  assert.doesNotMatch(withTaskBrief('claude --permission-mode plan', task), /bypassPermissions/);
  assert.doesNotMatch(withTaskBrief('claude', { ...task, permissionMode: 'default' }), /--permission-mode/);
  assert.doesNotMatch(withTaskBrief('claude', { ...task, permissionMode: 'x; rm -rf' }), /--permission-mode/);
});

// ---- controller ----------------------------------------------------------------

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

function setup({ packages, finish = async () => ({ ok: true, headSha: 'abc' }), stored = null, settings } = {}) {
  let clock = 1_000_000;
  let seq = 0;
  const log = { sessions: [], writes: [], ticks: [], events: [], saved: null, finishes: [] };
  const timers = [];
  const alive = new Set();
  const orch = createOrchestra({
    now: () => clock,
    readTodos: () => [1, 2, 3, 4].map((at) => ({ at, text: `t${at}`, done: false })),
    dirtyCount: async () => 0,
    runPlanner: async () => ({ ok: true, raw: { packages, notes: '' }, costUsd: 0 }),
    addWorktree: async (repo, name) => ({ ok: true, root: path.join('/wt', name), cwd: path.join('/wt', name), branch: `luna/${name}` }),
    headSha: async () => 'base',
    briefDir: () => '/cfg/tasks',
    writeBrief: () => true,
    createSession: (opts) => {
      seq += 1;
      log.sessions.push(opts);
      alive.add(`s${seq}`);
      return { id: `s${seq}` };
    },
    finishPackage: async (p) => {
      log.finishes.push(p.id);
      return finish(p);
    },
    writePty: (sessionId, text) => {
      log.writes.push([sessionId, text]);
      return alive.has(sessionId);
    },
    sessionAlive: (id) => alive.has(id),
    tickTodos: (projectId, ats) => log.ticks.push([projectId, ats]),
    workerSettings: () => settings || { model: 'opus', permissionMode: 'bypassPermissions' },
    saveState: (data) => {
      log.saved = data;
    },
    loadState: () => stored,
    onRunEvent: (kind) => log.events.push(kind),
    setTimer: (fn, ms) => {
      const t = { fn, at: clock + ms, done: false };
      timers.push(t);
      return t;
    },
    clearTimer: (t) => {
      if (t) t.done = true;
    },
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
  const flush = () => new Promise((r) => setImmediate(r));
  const state = () => orch.view().packages.map((p) => p.state);
  return { orch, log, ctx, advance, flush, alive, state };
}

async function started(opts) {
  const s = setup(opts);
  const { plan } = await s.orch.makePlan(s.ctx);
  await s.orch.launch({ planId: plan.id });
  return { ...s, planId: plan.id };
}

test('LUNA_DONE finishes, ticks the to-dos and launches the dependent package', async () => {
  const s = await started({ packages: [pkg('a', [1]), pkg('b', [2], { dependsOn: ['a'] })] });
  assert.deepEqual(s.state(), ['launched', 'pending']);
  s.orch.onTurnEnd('s1', turn('done\nLUNA_DONE a'));
  await s.flush();
  await s.flush();
  assert.deepEqual(s.state(), ['pushed', 'launched']);
  assert.deepEqual(s.log.ticks, [['p1', [1]]]);
  assert.equal(s.orch.view().packages[0].headSha, 'abc');
  assert.equal(s.log.sessions[1].task.model, 'opus');
  s.orch.onTurnEnd('s2', turn('LUNA_DONE b'));
  await s.flush();
  await s.flush();
  assert.deepEqual(s.state(), ['pushed', 'pushed']);
  assert.ok(s.log.events.includes('done'));
  assert.equal(s.log.saved.packages[1].state, 'pushed', 'every transition is persisted');
});

test('the planner\'s per-package model is used when settings say "plan"', async () => {
  const s = await started({ packages: [pkg('a', [1])], settings: { model: 'plan', permissionMode: 'acceptEdits' } });
  assert.equal(s.log.sessions[0].task.model, 'sonnet');
  assert.equal(s.log.sessions[0].task.permissionMode, 'acceptEdits');
});

test('no marker -> delayed nudge, capped, then stalled', async () => {
  const s = await started({ packages: [pkg('a', [1])] });
  for (let i = 0; i < sup.MAX_NUDGES; i += 1) {
    s.orch.onTurnEnd('s1', turn('working on it'));
    s.advance(10_000);
  }
  assert.equal(s.log.writes.filter(([, t]) => /LUNA_DONE a/.test(t)).length, sup.MAX_NUDGES);
  s.orch.onTurnEnd('s1', turn('still working'));
  assert.equal(s.orch.view().packages[0].state, 'launched', 'the stall waits like a nudge');
  s.advance(10_000);
  assert.equal(s.orch.view().packages[0].state, 'stalled');
  assert.equal(s.orch.view().packages[0].error, 'noMarker');
});

test('a usage limit pauses the whole run, cancels the pending nudge and resumes every worker', async () => {
  const s = await started({ packages: [pkg('a', [1]), pkg('b', [2])] });
  s.orch.onTurnEnd('s1', turn('hit the wall'));
  s.orch.onUsageLimit('s1', 1_000_000 + 3_600_000);
  s.advance(10_000);
  assert.equal(s.log.writes.length, 0, 'the nudge was cancelled by the pause');
  assert.ok(s.orch.view().pausedUntil);
  s.advance(3_700_000);
  assert.equal(s.orch.view().pausedUntil, null);
  assert.deepEqual(s.log.writes.map(([id]) => id).sort(), ['s1', 's2']);
  assert.ok(s.log.events.includes('resumed'));
});

test('verify failure goes back to the worker, then stalls after the cap', async () => {
  const s = await started({
    packages: [pkg('a', [1])],
    finish: async () => ({ ok: false, stage: 'verify', output: 'FAIL x.test.js' }),
  });
  for (let i = 0; i < sup.MAX_VERIFY_ROUNDS; i += 1) {
    s.orch.onTurnEnd('s1', turn('LUNA_DONE a'));
    await s.flush();
    assert.equal(s.orch.view().packages[0].state, 'launched');
  }
  assert.equal(s.log.writes.filter(([, t]) => /FAIL x\.test\.js/.test(t)).length, sup.MAX_VERIFY_ROUNDS);
  s.orch.onTurnEnd('s1', turn('LUNA_DONE a'));
  await s.flush();
  assert.deepEqual([s.orch.view().packages[0].state, s.orch.view().packages[0].error], ['stalled', 'verifyFailed']);
});

test('a push failure or an empty branch stalls with the stage as the reason', async () => {
  const s = await started({ packages: [pkg('a', [1])], finish: async () => ({ ok: false, stage: 'noCommits', detail: '' }) });
  s.orch.onTurnEnd('s1', turn('LUNA_DONE a'));
  await s.flush();
  assert.equal(s.orch.view().packages[0].error, 'noCommitsFailed');
  assert.deepEqual(s.log.ticks, [], 'nothing ticked');
});

test('approval prompt stalls one worker; a later LUNA_DONE on its tab still finishes it', async () => {
  const s = await started({ packages: [pkg('a', [1]), pkg('b', [2])] });
  s.orch.onApproval('s1');
  assert.deepEqual(s.state(), ['stalled', 'launched']);
  s.orch.onTurnEnd('s1', turn('LUNA_DONE a'));
  await s.flush();
  assert.equal(s.state()[0], 'pushed');
});

test('kill switch: Esc to every worker, no new launches, retry picks a package back up', async () => {
  const s = await started({ packages: [pkg('a', [1]), pkg('b', [2], { dependsOn: ['a'] })] });
  assert.equal(s.orch.kill(), true);
  assert.deepEqual(s.state(), ['killed', 'pending']);
  assert.deepEqual(s.log.writes, [['s1', '\x1b']]);
  assert.equal(s.orch.isRunning(), false);

  const res = await s.orch.retry({ planId: s.planId, id: 'a' });
  assert.equal(res.ok, true);
  assert.deepEqual(s.state(), ['launched', 'pending']);
  assert.equal(s.log.sessions.length, 1, 'tab still open -> nudged, not relaunched');
  assert.equal((await s.orch.retry({ planId: s.planId, id: 'b' })).error, 'notRetryable');
});

test('retry after a restart reopens the package in its own worktree with a resume brief', async () => {
  const s = await started({ packages: [pkg('a', [1])] });
  const saved = JSON.parse(JSON.stringify(s.log.saved));
  const r = setup({ packages: [], stored: saved });
  assert.deepEqual(r.state(), ['stalled']);
  assert.equal(r.orch.view().packages[0].error, 'restarted');
  const res = await r.orch.retry({ planId: saved.id, id: 'a' });
  assert.equal(res.ok, true);
  assert.equal(r.log.sessions[0].cwd, saved.packages[0].cwd);
  assert.equal(r.log.sessions[0].branch, saved.packages[0].branch);
});

test('closing a worker tab frees its slot; discard is refused while a worker runs', async () => {
  const s = await started({ packages: [pkg('a', [1]), pkg('b', [2]), pkg('c', [3]), pkg('d', [4])] });
  assert.deepEqual(s.state(), ['launched', 'launched', 'launched', 'pending']);
  assert.equal(s.orch.discard().error, 'runActive');
  s.orch.onSessionClosed('s2');
  await s.flush();
  assert.deepEqual(s.state(), ['launched', 'closed', 'launched', 'launched']);
});

test('a worker over its working time stalls on tick', async () => {
  const s = await started({ packages: [pkg('a', [1])] });
  s.advance(sup.WORKER_CAP_MS + 1);
  s.orch.tick();
  assert.equal(s.orch.view().packages[0].error, 'timeout');
});

// ---- regressions from the slice 4 review ------------------------------------

test('a usage limit right after a no-marker turn wins over the noMarker stall', async () => {
  const s = await started({ packages: [pkg('a', [1])] });
  for (let i = 0; i < sup.MAX_NUDGES; i += 1) {
    s.orch.onTurnEnd('s1', turn('working'));
    s.advance(10_000);
  }
  s.orch.onTurnEnd('s1', turn('hit the wall'));
  s.orch.onUsageLimit('s1', null);
  s.advance(10_000);
  assert.equal(s.orch.view().packages[0].state, 'launched');
  assert.ok(s.orch.view().pausedUntil);
  assert.equal((await s.orch.retry({ planId: s.planId, id: 'a' })).error, 'notRetryable');
});

test('kill during an in-flight launch stops that tab and launches nothing more', async () => {
  const s = setup({ packages: [pkg('a', [1]), pkg('b', [2])] });
  const { plan } = await s.orch.makePlan(s.ctx);
  const launching = s.orch.launch({ planId: plan.id });
  s.orch.kill();
  await launching;
  assert.deepEqual(s.state(), ['killed', 'pending']);
  assert.equal(s.log.sessions.length, 1);
  assert.deepEqual(s.log.writes, [['s1', '\x1b']]);
});

test('closing the tab of a finishing package lets the finish complete', async () => {
  let release;
  const s = await started({ packages: [pkg('a', [1])], finish: () => new Promise((r) => (release = r)) });
  s.orch.onTurnEnd('s1', turn('LUNA_DONE a'));
  s.orch.onSessionClosed('s1');
  assert.equal(s.orch.view().packages[0].state, 'finishing');
  assert.equal((await s.orch.retry({ planId: s.planId, id: 'a' })).error, 'notRetryable');
  release({ ok: true, headSha: 'abc' });
  await s.flush();
  assert.equal(s.orch.view().packages[0].state, 'pushed');
});

test('retry of an approval stall types nothing into the prompt; retry is refused while paused', async () => {
  const s = await started({ packages: [pkg('a', [1]), pkg('b', [2])] });
  s.orch.onApproval('s1');
  assert.equal((await s.orch.retry({ planId: s.planId, id: 'a' })).ok, true);
  assert.deepEqual(s.log.writes, []);
  s.orch.onApproval('s1');
  s.orch.onUsageLimit('s2', null);
  assert.equal((await s.orch.retry({ planId: s.planId, id: 'a' })).error, 'paused');
});

test('a run that settled reopens when a stalled package finishes by hand', async () => {
  const s = await started({ packages: [pkg('a', [1])] });
  s.orch.onApproval('s1');
  await s.flush();
  assert.equal(s.orch.view().settled, true);
  s.orch.onTurnEnd('s1', turn('LUNA_DONE a'));
  await s.flush();
  await s.flush();
  assert.equal(s.orch.view().packages[0].state, 'pushed');
  assert.ok(s.log.events.includes('done'));
});

test('restored worktree locations must have the shape LunaCore creates', () => {
  const base = { id: 'p', repoPath: path.resolve('/r') };
  const good = sup.normalizeStoredPlan({
    ...base,
    packages: [{ id: 'a', state: 'stalled', root: path.resolve('/x/.luna-worktrees/r/a-1'), cwd: path.resolve('/x/.luna-worktrees/r/a-1/sub'), branch: 'luna/a-1', baseSha: 'abcdef1' }],
  }).packages[0];
  assert.equal(good.branch, 'luna/a-1');
  assert.equal(good.briefPath, null, 'never restored');
  const bad = (fields) => sup.normalizeStoredPlan({ ...base, packages: [{ id: 'a', state: 'stalled', ...fields }] }).packages[0];
  const wt = path.resolve('/x/.luna-worktrees/r/a-1');
  assert.equal(bad({ root: path.resolve('/Users/me'), branch: 'luna/a-1' }).root, null);
  assert.equal(bad({ root: wt, branch: '--receive-pack=evil' }).root, null);
  assert.equal(bad({ root: wt, branch: 'luna/a-1', cwd: path.resolve('/etc') }).cwd, wt);
  assert.equal(bad({ root: wt, branch: 'luna/a-1', baseSha: '--all' }).baseSha, null);
  assert.equal(bad({ verify: 'npm test\nrm -rf /' }).verify, '');
  assert.equal(sup.normalizeStoredPlan({ ...base, packages: [{ id: '../x' }] }), null);
});
