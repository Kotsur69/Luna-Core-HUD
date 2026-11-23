// ============================================================================
// God Mode pool rescue, end to end through one run controller (src/orchestra.js
// wired to src/orchestraRescue.js): the escalation ladder, emergency Opus and
// its effort, limit moves, the free hand-over - and today's Opus-only and
// Sonnet runs unchanged. Injected fakes only: no CLI, no git, no agy.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { createOrchestra } = require('../src/orchestra');

const turn = (text) => JSON.stringify({ type: 'assistant', message: { stop_reason: 'end_turn', content: [{ type: 'text', text }] } });
const e = (model, effort = 'plan') => ({ model, effort });

const LIVE = [
  { id: 'gemini-4-argon-medium', name: 'Gemini 4 Argon (Medium)' },
  { id: 'gemini-4-argon-high', name: 'Gemini 4 Argon (High)' },
  { id: 'gemini-4-hydrogen-medium', name: 'Gemini 4 Hydrogen (Medium)' },
];

function fakeAgyModels(list = LIVE) {
  const ids = list.map((m) => m.id);
  return {
    ensure: async () => list.map((m) => ({ ...m })),
    list: () => list.map((m) => ({ ...m })),
    isKnownId: (id) => ids.includes(id),
    resolveModelId: (model) => {
      const id = typeof model === 'string' && model.startsWith('agy:') ? model.slice(4) : null;
      return id && ids.includes(id) ? id : null;
    },
  };
}

const pkg = (id, model, extra = {}) => ({
  id,
  title: `T ${id}`,
  todoAts: [extra.at || 1],
  prompt: `do ${id}`,
  files: [`docs/${id}.md`],
  dependsOn: [],
  verify: 'npm test',
  model,
  effort: 'medium',
  modelReason: `${id} reason`,
  ...extra,
});

function setup({ packages, settings = {}, usage = null } = {}) {
  let clock = 1_000_000;
  let seq = 0;
  const log = { sessions: [], events: [], closed: [], lines: [] };
  const alive = new Set();
  const reading = { current: usage };
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
    closeSession: (id) => {
      log.closed.push(id);
      alive.delete(id);
    },
    finishPackage: async (p) => ({ ok: true, headSha: `${p.id}aaaaaaa` }),
    writePty: (sessionId) => alive.has(sessionId),
    sessionAlive: (id) => alive.has(id),
    workerSettings: () => ({ model: 'opus', effort: 'plan', permissionMode: 'bypassPermissions', integration: 'pr', allowedTools: [], ...settings }),
    saveWorkerModel: () => {},
    onRunEvent: (kind, data) => log.events.push([kind, data]),
    log: (line) => log.lines.push(line),
    sleep: async () => {},
    setTimer: () => ({}),
    clearTimer: () => {},
    agyModels: fakeAgyModels(),
    agyProfileId: () => 'agy-profile',
    codingProfileId: (preferred) => preferred || 'default-coding',
    usageReading: () => reading.current,
  });
  const ctx = { projectId: 'p1', repoPath: '/repo', profileId: 'cloud', env: {} };
  const flush = async (n = 6) => {
    for (let i = 0; i < n; i += 1) await new Promise((r) => setImmediate(r));
  };
  const view = (id) => orch.view().packages.find((p) => p.id === id);
  const last = () => log.sessions[log.sessions.length - 1];
  return { orch, log, ctx, flush, view, last, reading };
}

/** A started run: planned with `pool` (none = no pool), approved with it. */
async function started({ pool = null, workers = 'claude', ...opts }) {
  const s = setup(opts);
  const made = await s.orch.makePlan({ ...s.ctx, ...(pool ? { modelPool: pool } : {}) });
  assert.equal(made.ok, true, JSON.stringify(made));
  const res = await s.orch.launch({ planId: made.plan.id, integration: 'branches', workers, ...(pool ? { modelPool: pool } : {}) });
  assert.equal(res.ok, true, JSON.stringify(res));
  await s.flush();
  return s;
}

/** The package's worker hits LUNA_BLOCKED on its current tab. */
const block = (s, id, why = 'stuck') => s.orch.onTurnEnd(s.view(id).sessionId, turn(`LUNA_BLOCKED ${id}: ${why}`));

// ---- HARD RULE: today's runs are unchanged -------------------------------------------

test('regression: an Opus-only run (no pool) never escalates: resume once, then terminal, no rescue fields', async () => {
  const s = await started({ packages: [pkg('a', 'opus')] });
  block(s, 'a');
  assert.deepEqual([s.view('a').state, s.view('a').autoResumed], ['launched', true]);
  block(s, 'a');
  const a = s.view('a');
  assert.deepEqual([a.state, a.terminal, a.escalated, a.model], ['stalled', true, false, 'opus']);
  assert.equal(a.rescues, undefined);
  assert.equal(s.log.sessions.length, 2);
  assert.ok(s.log.sessions.every((x) => x.task.model === 'opus' && x.profileId === 'cloud'));
});

test('regression: Workers [Opus] (a one-model pool) behaves exactly like the Opus-only run', async () => {
  const s = await started({ pool: [e('opus')], packages: [pkg('a', 'opus')] });
  assert.equal(s.orch.view().modelPool, undefined, 'a one-model pool is no pool run');
  block(s, 'a');
  block(s, 'a');
  const a = s.view('a');
  assert.deepEqual([a.state, a.terminal, a.escalated, a.rescues], ['stalled', true, false, undefined]);
  assert.equal(s.log.sessions.length, 2);
});

test("regression: a Sonnet run escalates to Opus one effort step up, as today (the setting is ignored)", async () => {
  const s = await started({ packages: [pkg('a', 'sonnet')], settings: { model: 'sonnet', emergencyEffort: 'max' } });
  block(s, 'a');
  block(s, 'a');
  const a = s.view('a');
  assert.deepEqual([a.state, a.escalated, a.model, a.effort], ['launched', true, 'opus', 'high']);
  assert.equal(s.last().task.effort, 'high');
  assert.equal(a.rescues, undefined);
  block(s, 'a');
  assert.deepEqual([s.view('a').state, s.view('a').terminal], ['stalled', true]);
});

test('regression: a pool [Opus, Sonnet] escalates Sonnet -> Opus like today (step up), then stalls', async () => {
  const s = await started({ pool: [e('opus'), e('sonnet')], packages: [pkg('a', 'sonnet')] });
  block(s, 'a');
  block(s, 'a');
  const a = s.view('a');
  assert.deepEqual([a.model, a.effort, a.escalated, a.emergency], ['opus', 'high', true, false]);
  assert.deepEqual(a.rescues.map((r) => r.text), ['escalated: Sonnet -> Opus']);
  block(s, 'a');
  assert.deepEqual([s.view('a').state, s.view('a').terminal], ['stalled', true], 'Opus failing stalls as today');
});

// ---- 1. the escalation ladder ------------------------------------------------------

test('pool ladder: Sonnet -> Argon (agy, own profile + --model) -> Opus, each rung with a resume first', async () => {
  const s = await started({ pool: [e('opus'), e('sonnet'), e('agy-argon')], packages: [pkg('a', 'sonnet')] });
  block(s, 'a');
  assert.equal(s.view('a').autoResumed, true);
  block(s, 'a');
  let a = s.view('a');
  assert.deepEqual([a.state, a.model, a.escalated], ['launched', 'agy:gemini-4-argon-medium', true]);
  assert.deepEqual([s.last().profileId, s.last().task.model], ['agy-profile', 'agy:gemini-4-argon-medium']);
  assert.deepEqual([a.stalls, a.autoResumed], [0, false], 'a middle rung starts the ladder afresh');
  assert.deepEqual(a.rescues.map((r) => r.text), ['escalated: Sonnet -> Argon (agy)']);
  block(s, 'a');
  block(s, 'a');
  a = s.view('a');
  assert.deepEqual([a.model, a.effort, a.emergency], ['opus', 'high', false]);
  assert.deepEqual([s.last().profileId, s.last().task.model, s.last().task.effort], ['cloud', 'opus', 'high']);
  assert.deepEqual(a.rescues.map((r) => r.text), ['escalated: Sonnet -> Argon (agy)', 'escalated: Argon (agy) -> Opus']);
  block(s, 'a');
  assert.deepEqual([s.view('a').state, s.view('a').terminal], ['stalled', true]);
});

test('pool ladder: nothing stronger ticked -> Opus (Claude) as an emergency, at the Emergency Opus effort', async () => {
  const s = await started({
    pool: [e('sonnet'), e('agy-argon')],
    packages: [pkg('a', 'agy-argon')],
    settings: { emergencyEffort: 'xhigh' },
  });
  assert.equal(s.log.sessions[0].profileId, 'agy-profile');
  block(s, 'a');
  block(s, 'a');
  const a = s.view('a');
  assert.deepEqual([a.model, a.effort, a.emergency, a.escalated], ['opus', 'xhigh', true, true]);
  assert.deepEqual([s.last().profileId, s.last().task.model, s.last().task.effort], ['cloud', 'opus', 'xhigh']);
  assert.deepEqual(a.rescues.map((r) => r.text), ['escalated: Argon (agy) -> Opus (emergency, xhigh)']);
  assert.ok(s.log.events.some(([k, d]) => k === 'escalated' && /emergency/.test(d.text)));
});

test('pool ladder: a Hydrogen package climbs past Sonnet only when Sonnet is ticked', async () => {
  const s = await started({ pool: [e('sonnet'), e('agy-hydrogen'), e('agy-argon')], packages: [pkg('a', 'agy-hydrogen')] });
  block(s, 'a');
  block(s, 'a');
  assert.deepEqual(s.view('a').rescues.map((r) => r.text), ['escalated: Hydrogen (agy) -> Sonnet']);
  assert.equal(s.last().task.model, 'sonnet');
});

// ---- 2. limits mid-run ---------------------------------------------------------------

test('limit: both Claude accounts out -> a not-started Opus package moves to a ticked model of the same tier', async () => {
  const s = await started({
    pool: [e('opus'), e('agy-argon')],
    packages: [pkg('a', 'opus'), pkg('b', 'opus', { at: 2, dependsOn: ['a'] })],
  });
  s.orch.onUsageLimit('s1', 1_000_000 + 60 * 60_000);
  await s.flush();
  const a = s.view('a');
  const b = s.view('b');
  assert.deepEqual([a.state, a.model, a.rescues], ['launched', 'opus', undefined], 'a running package pauses as before');
  assert.deepEqual([b.state, b.model], ['pending', 'agy:gemini-4-argon-medium']);
  assert.deepEqual(b.rescues.map((r) => r.text), ['Opus limit -> Argon (agy)']);
  assert.ok(s.log.lines.some((l) => /package b: Opus limit -> Argon \(agy\)/.test(l)));
  assert.ok(s.log.events.some(([k, d]) => k === 'limitMoved' && d.id === 'b'));
});

test('limit: no ticked model left and Claude has headroom -> Opus emergency at the setting', async () => {
  const s = await started({
    pool: [e('agy-argon'), e('agy-hydrogen')],
    packages: [pkg('a', 'agy-argon'), pkg('b', 'agy-hydrogen', { at: 2, dependsOn: ['a'] })],
  });
  s.orch.onUsageLimit('s1', 1_000_000 + 60 * 60_000);
  await s.flush();
  const b = s.view('b');
  assert.deepEqual([b.model, b.effort, b.emergency], ['opus', 'high', true]);
  assert.deepEqual(b.rescues.map((r) => r.text), ['Hydrogen (agy) limit -> Opus (emergency, high)']);
});

test('limit: Claude out and nothing else ticked -> the package waits for the reset (no move)', async () => {
  const s = await started({
    pool: [e('opus'), e('sonnet')],
    packages: [pkg('a', 'opus'), pkg('b', 'sonnet', { at: 2, dependsOn: ['a'] })],
  });
  s.orch.onUsageLimit('s1', 1_000_000 + 60 * 60_000);
  await s.flush();
  const b = s.view('b');
  assert.deepEqual([b.state, b.model, b.rescues], ['pending', 'sonnet', undefined]);
  assert.ok(s.orch.view().pausedUntil, 'the run waits until the reset');
});

test('limit: an agy weekly quota at 100% moves a not-started Argon package to the stronger ticked Opus', async () => {
  const usage = { others: [{ providerId: 'antigravity', status: 'ok', updatedAt: 1_000_000, limits: [{ model: 'Argon', window: 'weekly', percentUsed: 100 }] }] };
  const s = await started({ pool: [e('opus'), e('agy-argon')], packages: [pkg('a', 'agy-argon')], usage });
  const a = s.view('a');
  assert.deepEqual([a.state, a.model, a.effort, a.emergency], ['launched', 'opus', 'high', false]);
  assert.deepEqual([s.log.sessions[0].profileId, s.log.sessions[0].task.model], ['cloud', 'opus']);
  assert.deepEqual(a.rescues.map((r) => r.text), ['Argon (agy) limit -> Opus']);
});

test('limit: a stale 100% or a rounded-up 99.5% agy reading does not move a not-started Argon package', async () => {
  const MAX_AGE = require('../src/orchestraRescue').MAX_READING_AGE_MS;
  const argon = (percentUsed, updatedAt) => ({ others: [{ providerId: 'antigravity', status: 'ok', updatedAt, limits: [{ model: 'Argon', window: 'weekly', percentUsed }] }] });
  for (const [label, usage] of [
    ['stale 100%', argon(100, 1_000_000 - MAX_AGE - 1)],
    ['99.5% fresh', argon(99.5, 1_000_000)],
    ['100% with no time', argon(100, undefined)],
  ]) {
    const s = await started({ pool: [e('opus'), e('agy-argon')], packages: [pkg('a', 'agy-argon')], usage });
    const a = s.view('a');
    assert.deepEqual([a.state, a.model, a.rescues], ['launched', 'agy:gemini-4-argon-medium', undefined], label);
  }
});

// ---- free hand-over ----------------------------------------------------------------

test('hand-over in a pool without Sonnet: the free package goes to the next stronger ticked model', async () => {
  const s = await started({
    pool: [e('agy-argon'), e('free:freellm-chain')],
    workers: 'hybrid',
    packages: [pkg('c', 'free')],
  });
  assert.equal(s.log.sessions[0].profileId, 'freellm-chain');
  block(s, 'c');
  block(s, 'c');
  const c = s.view('c');
  assert.equal(c.model, 'agy:gemini-4-argon-medium');
  assert.equal(s.last().profileId, 'agy-profile');
  assert.deepEqual(c.rescues.map((r) => r.text), ['handed over: free -> Argon (agy)']);
});

test('hand-over in a pool with Sonnet ticked goes to Sonnet, as before', async () => {
  const s = await started({
    pool: [e('opus'), e('sonnet'), e('free:freellm-chain')],
    workers: 'hybrid',
    packages: [pkg('c', 'free')],
  });
  block(s, 'c');
  block(s, 'c');
  assert.deepEqual([s.view('c').model, s.last().task.model], ['sonnet', 'sonnet']);
  assert.deepEqual(s.view('c').rescues.map((r) => r.text), ['handed over: free -> Sonnet']);
});

test('hand-over: Hydrogen (stronger than free) takes it; with Hydrogen out, Opus emergency at the setting', async () => {
  const s = await started({ pool: [e('agy-hydrogen'), e('free:freellm-chain')], workers: 'hybrid', packages: [pkg('c', 'free')] });
  block(s, 'c');
  block(s, 'c');
  assert.deepEqual(s.view('c').rescues.map((r) => r.text), ['handed over: free -> Hydrogen (agy)']);

  // Hydrogen shares the Gemini quota: at 100% it is out.
  const usage = { others: [{ providerId: 'antigravity', status: 'ok', updatedAt: 1_000_000, limits: [{ model: 'Gemini', window: 'daily', percentUsed: 100 }] }] };
  const t = await started({
    pool: [e('agy-hydrogen'), e('free:freellm-chain')],
    workers: 'hybrid',
    packages: [pkg('c', 'free')],
    settings: { emergencyEffort: 'max' },
    usage,
  });
  block(t, 'c');
  block(t, 'c');
  const c = t.view('c');
  assert.deepEqual([c.model, c.effort, c.emergency, t.last().task.model, t.last().task.effort], ['opus', 'max', true, 'opus', 'max']);
  assert.deepEqual(c.rescues.map((r) => r.text), ['handed over: free -> Opus (emergency, max)']);
});

// ---- 4. side jobs ----------------------------------------------------------------------

test('side jobs: a pool with a Claude model reviews on Claude even with the agy planner; an agy-only pool on agy', async () => {
  const agyRules = require('../src/orchestraAgy');
  const pool = (models) => ({ workerModel: 'plan', modelPool: models.map((m) => e(m)) });
  assert.equal(agyRules.runUsesAgy({ ...pool(['opus', 'agy-argon']), buildPlanner: 'agy' }), false);
  assert.equal(agyRules.runUsesAgy(pool(['sonnet', 'free:freellm-chain'])), false);
  assert.equal(agyRules.runUsesAgy(pool(['agy-argon', 'agy-hydrogen'])), true);
  assert.equal(agyRules.runUsesAgy(pool(['agy-hydrogen', 'free:freellm-chain'])), true, 'a free model never reviews');
  // Any other run: today's rule.
  assert.equal(agyRules.runUsesAgy({ workerModel: 'opus' }), false);
  assert.equal(agyRules.runUsesAgy({ workerModel: 'opus', buildPlanner: 'agy' }), true);
  assert.equal(agyRules.runUsesAgy({ workerModel: 'agy:gemini-4-argon-medium' }), true);
});

// ---- 5. report + view ------------------------------------------------------------------

test('the per-model summary and the report name every move', async () => {
  const { poolSummaryLines, poolModelSummary } = require('../src/orchestraPoolSummary');
  const s = await started({
    pool: [e('sonnet'), e('agy-argon')],
    packages: [pkg('a', 'agy-argon'), pkg('b', 'sonnet', { at: 2 })],
    settings: { emergencyEffort: 'xhigh' },
  });
  block(s, 'a');
  block(s, 'a');
  const view = s.orch.view();
  const rows = poolModelSummary(view, 1_000_000);
  const byKey = Object.fromEntries(rows.map((r) => [r.key, r]));
  assert.deepEqual(Object.keys(byKey), ['agy-argon', 'sonnet', 'opus-emergency']);
  assert.deepEqual([byKey['agy-argon'].planned, byKey['agy-argon'].escalated, byKey['agy-argon'].emergency], [1, 1, 1]);
  assert.equal(byKey['opus-emergency'].name, 'Opus (emergency)');
  const text = poolSummaryLines(view, 1_000_000).join('\n');
  assert.match(text, /## Per model \(pool run\)/);
  assert.match(text, /`a`: escalated: Argon \(agy\) -> Opus \(emergency, xhigh\)/);
});
