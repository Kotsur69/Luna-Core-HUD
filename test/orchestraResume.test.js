// ============================================================================
// God Mode resume after a PC shutdown + "Pause for shutdown"
// (src/orchestraResume.js): the pure decisions first, then the run controller
// driving them with every side effect (tabs, timers, disk) faked.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const r = require('../src/orchestraResume.js');
const sup = require('../src/orchestraSupervisor.js');
const { createOrchestra, RESUME_GRACE_MS } = require('../src/orchestra.js');
const { withAccountResume } = require('../src/launch.js');
const { buildReport } = require('../src/orchestraReport.js');

const UUID_A = '0a1b2c3d-1111-4222-8333-444455556666';
const UUID_B = '9f8e7d6c-aaaa-4bbb-8ccc-ddddeeeeffff';
const NOW = 1_000_000;
const root = (slug) => path.resolve('/p/.luna-worktrees/repo', slug);

// ---- pure decisions ------------------------------------------------------------

test('interruptedOnRestore: started, not killed, not settled -> a shutdown banner', () => {
  assert.deepEqual(r.interruptedOnRestore({ started: true }, NOW), { at: NOW, by: 'shutdown', resetAt: null });
  assert.equal(r.interruptedOnRestore({ started: true, killed: true }, NOW), null, 'killed');
  assert.equal(r.interruptedOnRestore({ started: false }, NOW), null, 'never started');
  assert.equal(r.interruptedOnRestore({ started: true, settled: true, integration: { state: 'done' } }, NOW), null, 'settled');
  assert.equal(r.interruptedOnRestore(null, NOW), null);
  assert.equal(r.interruptedOnRestore('garbage', NOW), null);
});

test('interruptedOnRestore: a settled run whose integration the shutdown cut still resumes', () => {
  const i = r.interruptedOnRestore({ started: true, settled: true, integration: { state: 'running' } }, NOW);
  assert.equal(i.by, 'shutdown');
});

test('interruptedOnRestore: a pause record survives a restart; an off-shape one does not', () => {
  const stored = { started: false, interrupted: { at: 5, by: 'pause', resetAt: null } };
  assert.deepEqual(r.interruptedOnRestore(stored, NOW), { at: 5, by: 'pause', resetAt: null });
  assert.equal(r.interruptedOnRestore({ started: false, interrupted: { at: 5, by: 'reboot' } }, NOW), null);
  assert.equal(r.interruptedOnRestore({ started: true, killed: true, interrupted: { at: 5, by: 'pause' } }, NOW), null);
});

test('interruptedOnRestore + resumeDeadline: countdown, or the usage-limit reset when later', () => {
  const plain = r.interruptedOnRestore({ started: true }, NOW);
  assert.equal(r.resumeDeadline(plain, NOW, 1000), NOW + r.RESUME_COUNTDOWN_MS);
  const limited = r.interruptedOnRestore({ started: true, pausedUntil: NOW + 3_600_000 }, NOW);
  assert.equal(limited.resetAt, NOW + 3_600_000);
  assert.equal(r.resumeDeadline(limited, NOW, 1000), NOW + 3_600_000 + 1000);
  const past = r.interruptedOnRestore({ started: true, pausedUntil: NOW - 1 }, NOW);
  assert.equal(past.resetAt, null, 'a reset already passed does not wait');
  const soon = r.interruptedOnRestore({ started: true, pausedUntil: NOW + 10 }, NOW);
  assert.equal(r.resumeDeadline(soon, NOW, 0), NOW + r.RESUME_COUNTDOWN_MS, 'never sooner than the countdown');
});

test('packagesToResume: only stalled restarted packages; chat when the transcript exists, else fresh', () => {
  const base = { root: root('a-1'), cwd: root('a-1'), branch: 'luna/a-1' };
  const packages = [
    { id: 'a', state: 'stalled', error: 'restarted', transcriptId: UUID_A, ...base },
    { id: 'b', state: 'stalled', error: 'restarted', transcriptId: UUID_B, ...base },
    { id: 'c', state: 'stalled', error: 'restarted', transcriptId: null, ...base },
    { id: 'd', state: 'stalled', error: 'restarted', transcriptId: null, root: null, branch: null },
    { id: 'e', state: 'stalled', error: 'needsApproval', transcriptId: UUID_A, ...base },
    { id: 'f', state: 'failed', error: 'launchThrew', ...base },
    { id: 'g', state: 'killed', error: null, ...base },
    { id: 'h', state: 'stalled', error: 'restarted', splitInto: ['h1'], ...base },
    { id: 'i', state: 'stalled', error: 'restarted', sessionId: 's9', ...base },
  ];
  const env = { planRun: false, sessionAlive: (id) => id === 's9', transcriptExists: (_cwd, id) => id === UUID_A };
  assert.deepEqual(r.packagesToResume(packages, env), [
    { id: 'a', how: 'chat', mode: 'resume' },
    { id: 'b', how: 'fresh', mode: 'reopen' },
    { id: 'c', how: 'fresh', mode: 'reopen' },
    { id: 'd', how: 'fresh', mode: 'requeue' },
    { id: 'i', how: 'chat', mode: 'nudge' },
  ]);
});

test('packagesToResume: a lockdown plan-run worker never resumes its chat', () => {
  const p = { id: 'a', state: 'stalled', error: 'restarted', transcriptId: UUID_A, root: root('a-1'), branch: 'luna-plan/a-1' };
  const env = { planRun: true, sessionAlive: () => true, transcriptExists: () => true };
  assert.deepEqual(r.packagesToResume([p], env), [{ id: 'a', how: 'fresh', mode: 'reopen' }]);
});

test('packagesToResume: a throwing transcript check falls back to fresh', () => {
  const p = { id: 'a', state: 'stalled', error: 'restarted', transcriptId: UUID_A, root: root('a-1'), branch: 'luna/a-1' };
  const env = {
    planRun: false,
    sessionAlive: () => false,
    transcriptExists: () => {
      throw new Error('EACCES');
    },
  };
  assert.deepEqual(r.packagesToResume([p], env), [{ id: 'a', how: 'fresh', mode: 'reopen' }]);
});

test('resumeBlocker: busy, a deps hold, low battery and Luna\'s Work keep the resume waiting', () => {
  const none = { busy: false, hold: null, batteryLow: false, lunasWork: false };
  assert.equal(r.resumeBlocker(none), null);
  assert.equal(r.resumeBlocker({ ...none, busy: true }), 'busy');
  assert.equal(r.resumeBlocker({ ...none, hold: { reason: 'noNodeModules' } }), 'noNodeModules');
  assert.equal(r.resumeBlocker({ ...none, batteryLow: true }), 'batteryLow');
  assert.equal(r.resumeBlocker({ ...none, lunasWork: true }), 'lunasWorkActive');
});

test('markPausedForShutdown: launched -> stalled restarted with history; due retries -> pending', () => {
  const packages = [
    { id: 'a', state: 'launched', sessionId: 's1', stallHistory: [] },
    { id: 'b', state: 'failed', error: 'noTab' },
    { id: 'c', state: 'pushed' },
  ];
  const out = r.markPausedForShutdown(packages, { stop: r.idsToStop(packages), requeue: new Set(['b']), nowMs: NOW });
  assert.equal(out[0].state, 'stalled');
  assert.equal(out[0].error, 'restarted');
  assert.equal(out[0].sessionId, 's1', 'tab kept');
  assert.equal(out[0].stallHistory.at(-1).reason, 'restarted');
  assert.equal(out[1].state, 'pending');
  assert.equal(out[2], packages[2], 'untouched packages are the same objects');
  assert.equal(packages[0].state, 'launched', 'input not mutated');
});

test('planIdPayload: plain object with a plan-id-shaped string, optional project scope', () => {
  assert.deepEqual(r.planIdPayload({ planId: 'plan-1' }), { ok: true, payload: { planId: 'plan-1' } });
  assert.deepEqual(r.planIdPayload({ planId: 'plan-1', projectId: null }), { ok: true, payload: { planId: 'plan-1', projectId: null } });
  assert.deepEqual(r.planIdPayload({ planId: 'p', projectId: 'proj' }).payload, { planId: 'p', projectId: 'proj' });
  const bad = { ok: false, error: 'badPayload' };
  for (const payload of [null, undefined, 'p', ['p'], {}, { planId: '' }, { planId: 7 }, { planId: '../x' }, { planId: 'x'.repeat(65) },
    { planId: 'p', projectId: 3 }, { planId: 'p', projectId: '' }, { planId: 'p', projectId: 'x'.repeat(201) }]) {
    assert.deepEqual(r.planIdPayload(payload), bad, JSON.stringify(payload));
  }
  assert.equal('extra' in r.planIdPayload({ planId: 'p', extra: 1 }).payload, false, 'nothing else is read');
});

test('withTranscriptIds: packages with a tab pick up its conversation id, validated', () => {
  const packages = [
    { id: 'a', state: 'launched', sessionId: 's1', transcriptId: null },
    { id: 'b', state: 'stalled', error: 'restarted', sessionId: 's2', transcriptId: UUID_A },
    { id: 'c', state: 'launched', sessionId: 's3', transcriptId: null },
    { id: 'd', state: 'pending', sessionId: null, transcriptId: null },
  ];
  const ids = { s1: UUID_A.toUpperCase(), s2: UUID_B, s3: 'not-a-uuid' };
  const out = r.withTranscriptIds(packages, (sid) => ids[sid]);
  assert.deepEqual(out.map((p) => p.transcriptId), [UUID_A, UUID_B, null, null], 'a paused tab after /clear too');
  assert.equal(r.withTranscriptIds(out, (sid) => ids[sid]), out, 'unchanged -> same array');
  const lines = [];
  const thrown = r.withTranscriptIds(packages, () => {
    throw new Error('gone');
  }, (l) => lines.push(l));
  assert.equal(thrown, packages);
  assert.match(lines[0], /gone/, 'a failing lookup is logged, not swallowed');
});

test('markPausedForShutdown leaves a failed or stalled package its own error', () => {
  const packages = [{ id: 'a', state: 'failed', error: 'gitFailed' }, { id: 'b', state: 'finishing' }];
  const out = r.markPausedForShutdown(packages, { stop: new Set(['a', 'b']), requeue: new Set(), nowMs: NOW });
  assert.equal(out[0], packages[0]);
  assert.deepEqual([out[1].state, out[1].error], ['stalled', 'restarted']);
});

test('normalizeStoredPlan keeps a UUID transcriptId only; history keeps how', () => {
  const stored = sup.normalizeStoredPlan({
    id: 'p1',
    repoPath: path.resolve('/r'),
    packages: [
      { id: 'a', transcriptId: UUID_A.toUpperCase(), stallHistory: [{ at: 1, kind: 'resume', reason: 'resumedAfterShutdown', how: 'chat' }] },
      { id: 'b', transcriptId: 'x; rm -rf /' },
      { id: 'c', stallHistory: [{ at: 1, reason: 'x', how: 'evil' }] },
    ],
  });
  assert.deepEqual(stored.packages.map((p) => p.transcriptId), [UUID_A, null, null]);
  assert.equal(stored.packages[0].stallHistory[0].how, 'chat');
  assert.equal('how' in stored.packages[2].stallHistory[0], false);
});

test('withAccountResume carries the shutdown message and keeps the worker flags', () => {
  const task = { briefPath: '/t/a.md', model: 'sonnet', effort: 'high', permissionMode: 'bypassPermissions' };
  const cmd = withAccountResume('claude', UUID_A, task, r.RESUME_SHUTDOWN_MESSAGE);
  assert.match(cmd, new RegExp(`^claude '${r.RESUME_SHUTDOWN_MESSAGE}'`));
  assert.match(cmd, /--model sonnet/);
  assert.match(cmd, /--effort high/);
  assert.match(cmd, /--permission-mode bypassPermissions/);
  assert.match(cmd, new RegExp(`--resume ${UUID_A}$`));
  assert.match(withAccountResume('claude', UUID_A, task, "it's unsafe"), /moved this session to another Claude account/);
  assert.match(withAccountResume('claude', UUID_A, null), /moved this session/, 'failover unchanged');
  assert.equal(withAccountResume('claude', UUID_A, { ...task, lockdown: true }, 'x'), null);
});

test('the run report lists every package resumed after a shutdown, chat or fresh', () => {
  const view = {
    id: 'p1',
    repoPath: '/r',
    workerModel: 'opus',
    permissionMode: 'bypassPermissions',
    integration: { state: 'done' },
    packages: [
      { id: 'a', state: 'pushed', stallHistory: [{ at: 0, reason: 'resumedAfterShutdown', how: 'chat' }] },
      { id: 'b', state: 'pushed', stallHistory: [{ at: 0, reason: 'resumedAfterShutdown', how: 'fresh' }] },
      { id: 'c', state: 'pushed', stallHistory: [] },
    ],
  };
  const lines = r.resumeReportLines(view);
  assert.equal(lines[1], '## Resumed after shutdown');
  assert.match(lines.join('\n'), /`a`: own chat reopened \(claude --resume\)/);
  assert.match(lines.join('\n'), /`b`: fresh worker with the resume brief/);
  assert.doesNotMatch(lines.join('\n'), /`c`/);
  assert.deepEqual(r.resumeReportLines({ packages: [{ id: 'c', stallHistory: [] }] }), []);
  assert.match(buildReport(view, { now: 0, suggestions: [] }), /## Resumed after shutdown/);
});

// ---- controller ----------------------------------------------------------------

const storedPkg = (id, extra = {}) => ({
  id,
  title: `T ${id}`,
  prompt: `do ${id}`,
  todoAts: [],
  dependsOn: [],
  verify: 'npm test',
  model: 'sonnet',
  state: 'launched',
  sessionId: `old-${id}`,
  root: root(`${id}-x1`),
  cwd: root(`${id}-x1`),
  branch: `luna/${id}-x1`,
  ...extra,
});

const storedRun = (packages, extra = {}) => ({
  id: 'plan-1',
  repoPath: path.resolve('/repo'),
  profileId: 'cloud',
  integrationMode: 'branches',
  started: true,
  killed: false,
  settled: false,
  workerModel: 'sonnet',
  permissionMode: 'bypassPermissions',
  packages,
  ...extra,
});

function setup({ stored, transcripts = [UUID_A], extraDeps = {} } = {}) {
  let clock = NOW;
  let seq = 0;
  const log = { sessions: [], writes: [], events: [], saved: null };
  const timers = [];
  const alive = new Set();
  const orch = createOrchestra({
    now: () => clock,
    readTodos: () => [],
    dirtyCount: async () => 0,
    addWorktree: async (repo, name) => ({ ok: true, root: root(name), cwd: root(name), branch: `luna/${name}` }),
    headSha: async () => 'base',
    briefDir: () => path.resolve('/cfg/tasks'),
    writeBrief: () => true,
    createSession: (opts) => {
      seq += 1;
      log.sessions.push(opts);
      alive.add(`s${seq}`);
      return { id: `s${seq}` };
    },
    writePty: (sessionId, text) => {
      log.writes.push([sessionId, text]);
      return alive.has(sessionId);
    },
    sessionAlive: (id) => alive.has(id),
    workerSettings: () => ({ model: 'sonnet', permissionMode: 'bypassPermissions', integration: 'branches' }),
    saveState: (data) => {
      log.saved = data;
    },
    loadState: () => stored,
    onRunEvent: (kind) => log.events.push(kind),
    transcriptExists: (_cwd, id) => transcripts.includes(id),
    setTimer: (fn, ms) => {
      const t = { fn, at: clock + ms, done: false };
      timers.push(t);
      return t;
    },
    clearTimer: (t) => {
      if (t) t.done = true;
    },
    ...extraDeps,
  });
  orch.restore();
  const advance = (ms) => {
    clock += ms;
    for (const t of timers) {
      if (!t.done && t.at <= clock) {
        t.done = true;
        t.fn();
      }
    }
  };
  const flush = async () => {
    for (let i = 0; i < 5; i += 1) await new Promise((res) => setImmediate(res));
  };
  const pkgOf = (id) => orch.view().packages.find((p) => p.id === id);
  return { orch, log, advance, flush, alive, pkgOf, now: () => clock };
}

test('restore: a started run shows the banner and resumes on its own after 60 s', async () => {
  const s = setup({
    stored: storedRun([
      storedPkg('a', { transcriptId: UUID_A }),
      storedPkg('b', { transcriptId: UUID_B }),
      storedPkg('c', { state: 'stalled', error: 'needsApproval' }),
      storedPkg('d', { state: 'pending', sessionId: null, root: null, cwd: null, branch: null }),
    ]),
  });
  const v = s.orch.view();
  assert.equal(v.started, false);
  assert.equal(v.interrupted.by, 'shutdown');
  assert.equal(v.interrupted.resumeAt, NOW + r.RESUME_COUNTDOWN_MS);
  assert.equal(v.interrupted.toResume, 2);
  assert.equal(s.log.saved.interrupted.by, 'shutdown', 'saved with the run');

  s.advance(r.RESUME_COUNTDOWN_MS - 1);
  await s.flush();
  assert.equal(s.log.sessions.length, 0, 'nothing before the countdown ends');

  s.advance(1);
  await s.flush();
  const after = s.orch.view();
  assert.equal(after.interrupted, null);
  assert.equal(after.started, true);
  const chat = s.log.sessions.find((o) => o.resumeId === UUID_A);
  assert.ok(chat, 'a: its own conversation reopened');
  assert.equal(chat.resumeMessage, r.RESUME_SHUTDOWN_MESSAGE);
  assert.equal(chat.task.model, 'sonnet', 'worker flags kept');
  assert.equal(chat.cwd, root('a-x1'));
  assert.equal(s.log.sessions.filter((o) => !o.resumeId).length, 2, 'b fresh (no transcript) + d launched by the pump');
  assert.equal(s.pkgOf('a').state, 'launched');
  assert.equal(s.pkgOf('b').state, 'launched');
  assert.equal(s.pkgOf('c').state, 'stalled', 'stalled for another reason: untouched');
  assert.equal(s.pkgOf('c').error, 'needsApproval');
  assert.equal(s.pkgOf('d').state, 'launched');
  const how = (id) => s.pkgOf(id).stallHistory.filter((e) => e.reason === 'resumedAfterShutdown').map((e) => e.how);
  assert.deepEqual(how('a'), ['chat']);
  assert.deepEqual(how('b'), ['fresh']);
  assert.ok(s.log.events.includes('resumedAfterShutdown'));
  assert.equal(s.log.saved.packages.find((p) => p.id === 'a').transcriptId, UUID_A);
});

test('restore: Cancel holds the run as today; manual Retry still works', async () => {
  const s = setup({ stored: storedRun([storedPkg('a', { transcriptId: UUID_A })]) });
  assert.deepEqual(s.orch.cancelResume({ planId: 'nope' }), { ok: false, error: 'noPlan' });
  assert.deepEqual(s.orch.cancelResume({ planId: 'plan-1' }), { ok: true });
  assert.equal(s.orch.view().interrupted, null);
  s.advance(r.RESUME_COUNTDOWN_MS * 2);
  await s.flush();
  assert.equal(s.log.sessions.length, 0, 'the cancelled countdown never fires');
  assert.equal(s.pkgOf('a').state, 'stalled');
  const res = await s.orch.retry({ planId: 'plan-1', id: 'a' });
  assert.equal(res.ok, true);
  assert.equal(s.pkgOf('a').state, 'launched');
});

test('restore: Resume now does not wait for the countdown', async () => {
  const s = setup({ stored: storedRun([storedPkg('a', { transcriptId: UUID_A })]) });
  const res = await s.orch.resumeInterrupted({ planId: 'plan-1' });
  assert.equal(res.ok, true);
  assert.equal(s.log.sessions.length, 1);
  assert.deepEqual(await s.orch.resumeInterrupted({ planId: 'plan-1' }), { ok: false, error: 'notInterrupted' });
  assert.deepEqual(await s.orch.resumeInterrupted({ planId: 'other' }), { ok: false, error: 'noPlan' });
});

test('restore: killed, settled and never-started runs get no banner', () => {
  for (const extra of [{ killed: true }, { settled: true, integration: { state: 'done' } }, { started: false }]) {
    const s = setup({ stored: storedRun([storedPkg('a')], extra) });
    assert.equal(s.orch.view().interrupted, null, JSON.stringify(extra));
  }
});

test('restore: a usage-limit pause still ahead waits for its reset', async () => {
  const resetAt = NOW + 2 * 3_600_000;
  const s = setup({ stored: storedRun([storedPkg('a', { transcriptId: UUID_A })], { pausedUntil: resetAt }) });
  const i = s.orch.view().interrupted;
  assert.equal(i.resetAt, resetAt);
  assert.equal(i.resumeAt, resetAt + RESUME_GRACE_MS);
  assert.equal(i.waiting, 'usageLimit');
  s.advance(r.RESUME_COUNTDOWN_MS);
  await s.flush();
  assert.equal(s.log.sessions.length, 0, 'not at 60 s');
  s.advance(resetAt + RESUME_GRACE_MS - s.now());
  await s.flush();
  assert.equal(s.log.sessions.length, 1, 'at the reset');
});

test('restore: an interrupted integration of a settled run runs again on resume', async () => {
  const s = setup({
    stored: storedRun([storedPkg('a', { state: 'pushed', sessionId: null, headSha: 'abcdef1' })], {
      settled: true,
      integration: { state: 'running' },
    }),
  });
  assert.equal(s.orch.view().integration.error, 'interrupted');
  assert.equal(s.orch.view().interrupted.by, 'shutdown');
  await s.orch.resumeInterrupted({ planId: 'plan-1' });
  await s.flush();
  const v = s.orch.view();
  assert.equal(v.settled, true);
  assert.notEqual(v.integration.error, 'interrupted', 'the integration ran again');
  assert.ok(s.log.events.includes('done'));
});

test('restore: low battery keeps the automatic resume waiting, the banner says why', async () => {
  let held = true;
  const subs = [];
  const battery = { isHeld: () => held, subscribe: (fn) => subs.push(fn), view: () => ({ held }), onRunStart: () => {} };
  const s = setup({ stored: storedRun([storedPkg('a', { transcriptId: UUID_A })]), extraDeps: { battery } });
  s.advance(r.RESUME_COUNTDOWN_MS);
  await s.flush();
  assert.equal(s.log.sessions.length, 0);
  assert.equal(s.orch.view().interrupted.waiting, 'batteryLow');
  held = false;
  for (const fn of subs) fn();
  await s.flush();
  assert.equal(s.log.sessions.length, 1, 'plugged in -> resumes');
});

test('restore: a stored pause record comes back with a countdown too', () => {
  const s = setup({ stored: storedRun([storedPkg('a', { state: 'stalled', error: 'restarted' })], { started: true, interrupted: { at: 7, by: 'pause' } }) });
  const i = s.orch.view().interrupted;
  assert.equal(i.by, 'pause');
  assert.equal(i.resumeAt, NOW + r.RESUME_COUNTDOWN_MS);
});

// A fresh run that is going: the stored run restored, then resumed by hand.
async function running(packages) {
  const s = setup({ stored: storedRun(packages) });
  await s.orch.resumeInterrupted({ planId: 'plan-1' });
  return s;
}

test('Pause for shutdown: Esc to every worker, stalled restarted, no new launches, safe to turn off', async () => {
  const s = await running([storedPkg('a', { transcriptId: UUID_A }), storedPkg('b', { state: 'pending', sessionId: null, root: null, cwd: null, branch: null, dependsOn: ['a'] })]);
  assert.equal(s.pkgOf('a').state, 'launched');
  const tab = s.pkgOf('a').sessionId;
  const writesBefore = s.log.writes.length;
  assert.deepEqual(s.orch.pauseForShutdown({ planId: 'nope' }), { ok: false, error: 'noPlan' });
  assert.deepEqual(s.orch.pauseForShutdown({ planId: 'plan-1' }), { ok: true });
  assert.deepEqual(s.log.writes.slice(writesBefore), [[tab, '\x1b']]);
  assert.equal(s.pkgOf('a').state, 'stalled');
  assert.equal(s.pkgOf('a').error, 'restarted');
  assert.equal(s.pkgOf('b').state, 'pending');
  const i = s.orch.view().interrupted;
  assert.equal(i.by, 'pause');
  assert.equal(i.resumeAt, null, 'no countdown in this session');
  assert.equal(i.safe, true);
  assert.equal(s.log.saved.interrupted.by, 'pause', 'run saved');
  assert.equal(s.orch.view().settled, false, 'a paused run does not settle');
  assert.deepEqual(s.orch.pauseForShutdown({ planId: 'plan-1' }), { ok: false, error: 'alreadyPaused' });

  // Resume without a shutdown: the live tab gets the message (same chat).
  const sessionsBefore = s.log.sessions.length;
  const res = await s.orch.resumeInterrupted({ planId: 'plan-1' });
  assert.equal(res.ok, true);
  assert.equal(s.log.sessions.length, sessionsBefore, 'no new tab');
  assert.deepEqual(s.log.writes.at(-1), [tab, r.RESUME_SHUTDOWN_MESSAGE]);
  assert.equal(s.pkgOf('a').state, 'launched');
  assert.deepEqual(s.pkgOf('a').stallHistory.filter((e) => e.reason === 'resumedAfterShutdown').map((e) => e.how), ['chat', 'chat']);
});

test('Pause for shutdown, then a real shutdown: the next start resumes the same way', async () => {
  const s = await running([storedPkg('a', { transcriptId: UUID_A })]);
  s.orch.pauseForShutdown({ planId: 'plan-1' });
  const saved = JSON.parse(JSON.stringify(s.log.saved));
  const next = setup({ stored: saved });
  const i = next.orch.view().interrupted;
  assert.equal(i.by, 'pause');
  next.advance(r.RESUME_COUNTDOWN_MS);
  await next.flush();
  const chat = next.log.sessions.find((o) => o.resumeId === UUID_A);
  assert.ok(chat, 'the worker chat reopened with --resume');
  assert.equal(next.pkgOf('a').state, 'launched');
});

test('Pause for shutdown is refused on a run that is not going', () => {
  const s = setup({ stored: storedRun([storedPkg('a')], { started: false }) });
  assert.deepEqual(s.orch.pauseForShutdown({ planId: 'plan-1' }), { ok: false, error: 'notRunning' });
});

test('a paused run never resumes on its own, and a LUNA_DONE then does not start a verify', async () => {
  const s = await running([storedPkg('a', { transcriptId: UUID_A })]);
  const tab = s.pkgOf('a').sessionId;
  s.orch.pauseForShutdown({ planId: 'plan-1' });
  const sessions = s.log.sessions.length;
  s.advance(10 * r.RESUME_COUNTDOWN_MS);
  await s.flush();
  assert.equal(s.log.sessions.length, sessions);
  assert.equal(s.orch.view().interrupted.by, 'pause', 'still paused');
  s.orch.onTurnEnd(tab, JSON.stringify({ type: 'assistant', message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'LUNA_DONE a' }] } }));
  await s.flush();
  assert.equal(s.pkgOf('a').state, 'stalled', 'no finish while paused');
});

test('a chat resume refused for node_modules is held for the hold\'s Resume (heldRetry)', async () => {
  const dir = root('a-x1');
  const s = setup({
    stored: storedRun([storedPkg('a', { transcriptId: UUID_A })]),
    extraDeps: { checkDeps: () => ({ ok: false, dir, detail: 'empty', missing: null }) },
  });
  await s.orch.resumeInterrupted({ planId: 'plan-1' });
  assert.equal(s.log.sessions.length, 0, 'no tab on a broken node_modules');
  assert.equal(s.orch.view().hold.reason, 'noNodeModules');
  assert.equal(s.log.saved.packages[0].heldRetry, true);
});

test('a chat resume main could not build as --resume is reported as fresh', async () => {
  let seq = 0;
  const s = setup({
    stored: storedRun([storedPkg('a', { transcriptId: UUID_A })]),
    extraDeps: { createSession: () => ({ id: `n${(seq += 1)}`, transcriptId: UUID_B }) },
  });
  await s.orch.resumeInterrupted({ planId: 'plan-1' });
  const hist = s.pkgOf('a').stallHistory.filter((e) => e.reason === 'resumedAfterShutdown');
  assert.deepEqual(hist.map((e) => e.how), ['fresh']);
});

test('blocked automatic resumes keep one recheck chain; plugging in resumes once', async () => {
  let held = true;
  const subs = [];
  const battery = { isHeld: () => held, subscribe: (fn) => subs.push(fn), view: () => ({ held }), onRunStart: () => {} };
  const s = setup({ stored: storedRun([storedPkg('a', { transcriptId: UUID_A })]), extraDeps: { battery } });
  s.advance(r.RESUME_COUNTDOWN_MS);
  for (let i = 0; i < 3; i += 1) {
    for (const fn of subs) fn();
    s.advance(r.RESUME_RECHECK_MS);
  }
  await s.flush();
  held = false;
  for (const fn of subs) fn();
  s.advance(5 * r.RESUME_RECHECK_MS);
  await s.flush();
  assert.equal(s.log.sessions.length, 1, 'resumed exactly once');
});

test('Kill after Pause for shutdown ends the interruption', async () => {
  const s = await running([storedPkg('a', { transcriptId: UUID_A })]);
  s.orch.pauseForShutdown({ planId: 'plan-1' });
  assert.equal(s.orch.kill(), true);
  assert.equal(s.orch.view().interrupted, null);
});
