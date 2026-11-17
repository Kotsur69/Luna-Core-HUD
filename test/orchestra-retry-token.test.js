// ============================================================================
// God Mode: a manual Retry on a stalled tab that is still open must end with a
// worker that holds a valid lunacore intake token.
//
// A settled package's tab loses its scoped token on the next commit
// (orchestraFollowupsLaunch.js settledSessions -> intake.revokeScoped). Tokens
// are random and only their hashes are kept (intake.js issueToken), so a
// running claude process can never get its revoked token back. The Retry
// therefore reopens the package in a new tab, and opening a tab issues a
// fresh token (main: writeGodModeConfig -> server.issueToken).
// A settled package nobody retries keeps no live token.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { createOrchestra } = require('../src/orchestra.js');
const followupLaunch = require('../src/orchestraFollowupsLaunch.js');

/** A transcript fragment whose last finished assistant message says `text`. */
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

/**
 * A stand-in for the intake server's token book, with the same scoping rules
 * as intake.js: one token per session, revokeScoped matches run + package.
 */
function fakeIntake() {
  const tokens = new Map();
  let seq = 0;
  return {
    tokens,
    issue(sessionId, scope) {
      seq += 1;
      tokens.set(sessionId, { token: `t${seq}`, scope });
    },
    revoke(sessionId) {
      tokens.delete(sessionId);
    },
    revokeScoped(sessionId, { runId, packageId }) {
      const entry = tokens.get(sessionId);
      if (entry && entry.scope && entry.scope.runId === runId && entry.scope.packageId === packageId) tokens.delete(sessionId);
    },
    revokeRun(runId) {
      for (const [id, entry] of tokens) if (entry.scope && entry.scope.runId === runId) tokens.delete(id);
    },
    has: (sessionId) => tokens.has(sessionId),
  };
}

function setup({ packages, extraDeps = {} }) {
  let clock = 1_000_000;
  let seq = 0;
  const log = { sessions: [], writes: [], closed: [] };
  const timers = [];
  const alive = new Set();
  const intake = fakeIntake();
  const orch = createOrchestra({
    now: () => clock,
    readTodos: () => [1, 2, 3].map((at) => ({ at, text: `t${at}`, done: false })),
    dirtyCount: async () => 0,
    runPlanner: async () => ({ ok: true, raw: { packages, notes: '' }, costUsd: 0 }),
    addWorktree: async (repo, name) => ({ ok: true, root: path.join('/wt', name), cwd: path.join('/wt', name), branch: `luna/${name}` }),
    headSha: async () => 'base',
    briefDir: () => '/cfg/tasks',
    writeBrief: () => true,
    // Main issues the tab's scoped token when it opens a God Mode tab.
    createSession: (opts) => {
      seq += 1;
      const id = `s${seq}`;
      log.sessions.push(opts);
      alive.add(id);
      const gm = followupLaunch.godModeOf(opts.task);
      if (gm) intake.issue(id, followupLaunch.intakeScopeOf(gm));
      return { id };
    },
    // Main drops every token of a tab it closes.
    closeSession: (id) => {
      log.closed.push(id);
      alive.delete(id);
      intake.revoke(id);
    },
    sessionAlive: (id) => alive.has(id),
    writePty: (sessionId, text) => {
      log.writes.push([sessionId, text]);
      return alive.has(sessionId);
    },
    finishPackage: async () => ({ ok: true, headSha: 'abc' }),
    tickTodos: () => {},
    workerSettings: () => ({ model: 'opus', permissionMode: 'bypassPermissions' }),
    saveState: () => {},
    loadState: () => null,
    onRunEvent: () => {},
    setTimer: (fn, ms) => {
      const t = { fn, at: clock + ms, done: false };
      timers.push(t);
      return t;
    },
    clearTimer: (t) => {
      if (t) t.done = true;
    },
    ...followupLaunch.followupDeps(intake),
    ...extraDeps,
  });
  orch.restore();
  const ctx = { projectId: 'p1', repoPath: '/repo', profileId: 'cloud', env: {} };
  const flush = () => new Promise((r) => setImmediate(r));
  const view = (id) => orch.view().packages.find((p) => p.id === id);
  return { orch, log, ctx, flush, alive, intake, view };
}

async function started(opts) {
  const s = setup(opts);
  const { plan } = await s.orch.makePlan(s.ctx);
  await s.orch.launch({ planId: plan.id });
  return { ...s, planId: plan.id };
}

test('a settled package\'s still-open tab loses its token, and keeps it lost without a Retry', async () => {
  // b keeps the run going.
  const s = await started({ packages: [pkg('a', [1]), pkg('b', [2])] });
  assert.equal(s.intake.has('s1'), true, 'a running worker holds a token');
  s.orch.onApproval('s1');
  await s.flush();
  assert.equal(s.view('a').state, 'stalled');
  assert.equal(s.alive.has('s1'), true, 'the stalled tab is still open');
  assert.equal(s.intake.has('s1'), false, 'revoked at the stall');
  // Time passes, other packages move: nothing gives the stalled tab its token back.
  s.orch.onTurnEnd('s2', turn('working'));
  await s.flush();
  assert.equal(s.intake.has('s1'), false);
  assert.equal(s.intake.has('s2'), true, 'the other worker keeps its own');
});

test('a manual Retry on an approval stall with its tab open starts a new tab that holds a token', async () => {
  const s = await started({ packages: [pkg('a', [1]), pkg('b', [2])] });
  s.orch.onApproval('s1');
  await s.flush();
  assert.equal(s.intake.has('s1'), false);

  const res = await s.orch.retry({ planId: s.planId, id: 'a' });
  assert.equal(res.ok, true);
  const a = s.view('a');
  assert.equal(a.state, 'launched');
  assert.notEqual(a.sessionId, 's1', 'a new tab, not the token-less old one');
  assert.equal(s.intake.has(a.sessionId), true, 'the new worker holds a valid token');
  assert.deepEqual(s.intake.tokens.get(a.sessionId).scope, { scope: 'godmode', runId: s.planId, packageId: 'a' });
  assert.deepEqual(s.log.closed, ['s1'], 'the old tab is closed');
  assert.deepEqual(s.log.writes, [], 'nothing typed into the old tab\'s permission prompt');
  // The new tab works in the same worktree and branch, from a resume brief.
  const opened = s.log.sessions[s.log.sessions.length - 1];
  assert.equal(opened.cwd, s.log.sessions[0].cwd);
  assert.equal(opened.branch, s.log.sessions[0].branch);
});

test('a manual Retry on a killed package whose tab is still open starts a new tab that holds a token', async () => {
  const s = await started({ packages: [pkg('a', [1])] });
  assert.equal(s.orch.kill(), true);
  await s.flush();
  assert.equal(s.view('a').state, 'killed');
  assert.equal(s.alive.has('s1'), true);
  assert.equal(s.intake.has('s1'), false, 'a killed package keeps no live token');

  const res = await s.orch.retry({ planId: s.planId, id: 'a' });
  assert.equal(res.ok, true);
  const a = s.view('a');
  assert.equal(a.state, 'launched');
  assert.notEqual(a.sessionId, 's1');
  assert.equal(s.intake.has(a.sessionId), true);
  assert.equal(s.alive.has('s1'), false);
});

test('the new tab\'s worker finishes the package as usual; the old tab no longer counts', async () => {
  const s = await started({ packages: [pkg('a', [1]), pkg('b', [2])] });
  s.orch.onApproval('s1');
  await s.flush();
  await s.orch.retry({ planId: s.planId, id: 'a' });
  const sid = s.view('a').sessionId;
  // A late close event for the old tab does not touch the package.
  s.orch.onSessionClosed('s1');
  assert.equal(s.view('a').state, 'launched');
  s.orch.onTurnEnd(sid, turn('LUNA_DONE a'));
  await s.flush();
  await s.flush();
  assert.equal(s.view('a').state, 'pushed');
  await s.flush();
  assert.equal(s.intake.has(sid), false, 'settled again: its token is revoked');
});

test('a Retry that cannot reopen the tab keeps the stall and the revoked token', async () => {
  let fail = false;
  const s = await started({ packages: [pkg('a', [1]), pkg('b', [2])], extraDeps: { writeBrief: () => !fail } });
  s.orch.onApproval('s1');
  await s.flush();
  fail = true;
  const res = await s.orch.retry({ planId: s.planId, id: 'a' });
  assert.deepEqual([res.ok, res.error], [false, 'briefFailed']);
  assert.equal(s.view('a').state, 'stalled');
  assert.equal(s.view('a').sessionId, 's1');
  assert.equal(s.alive.has('s1'), true, 'the old tab is left as it was');
  assert.equal(s.intake.has('s1'), false);
});
