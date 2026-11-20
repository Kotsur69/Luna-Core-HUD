// ============================================================================
// God Mode pool guards, end to end through one run controller (src/orchestra.js):
// per-kind parallel caps (src/orchestraKindCaps.js, agy counted over every
// run), the weak-model guard on the easiest agy tier, and the per-package
// model picked on Approve - plus the Opus-only and [Opus] runs unchanged.
// Injected fakes only: no CLI, no git, no agy.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { createOrchestra } = require('../src/orchestra');
const { createOrchestraRegistry } = require('../src/orchestraRegistry');
const kindCaps = require('../src/orchestraKindCaps');

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

function setup({ packages, settings = {}, elsewhere = null } = {}) {
  const clock = 1_000_000;
  let seq = 0;
  const log = { sessions: [], events: [], lines: [] };
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
    closeSession: (id) => alive.delete(id),
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
    usageReading: () => null,
    ...(elsewhere ? { agyWorkersElsewhere: elsewhere } : {}),
  });
  const ctx = { projectId: 'p1', repoPath: '/repo', profileId: 'cloud', env: {} };
  const flush = async (n = 6) => {
    for (let i = 0; i < n; i += 1) await new Promise((r) => setImmediate(r));
  };
  const view = (id) => orch.view().packages.find((p) => p.id === id);
  return { orch, log, ctx, flush, view };
}

/** A planned run (not started): planned with `pool` (none = no pool). */
async function planned({ pool = null, ...opts }) {
  const s = setup(opts);
  const made = await s.orch.makePlan({ ...s.ctx, ...(pool ? { modelPool: pool } : {}) });
  assert.equal(made.ok, true, JSON.stringify(made));
  return { ...s, planId: made.plan.id };
}

/** A started run: planned and approved with `pool`. */
async function started({ pool = null, workers = 'claude', approve = {}, ...opts }) {
  const s = await planned({ pool, ...opts });
  const res = await s.orch.launch({ planId: s.planId, integration: 'branches', workers, ...(pool ? { modelPool: pool } : {}), ...approve });
  assert.equal(res.ok, true, JSON.stringify(res));
  await s.flush();
  return s;
}

const launchedIds = (s) => s.orch.view().packages.filter((p) => p.state !== 'pending').map((p) => p.id);
const sessionModels = (s) => s.log.sessions.map((x) => [x.profileId, x.task.model]);

// ---- per-kind caps: pure rules ------------------------------------------------------

test('kind caps: settings are validated (1..3), defaults agy 2 and free = today\'s free cap', () => {
  assert.deepEqual(kindCaps.kindCaps({}), { agy: 2, free: 3 });
  assert.deepEqual(kindCaps.kindCaps({ agyMaxParallel: 1, freeMaxParallel: 2 }), { agy: 1, free: 2 });
  for (const bad of [0, 4, 1.5, '2', null, -1, NaN]) {
    assert.deepEqual(kindCaps.kindCaps({ agyMaxParallel: bad, freeMaxParallel: bad }), { agy: 2, free: 3 }, String(bad));
  }
});

test('kind caps: a full kind waits while another kind takes the free slot; claude has no cap of its own', () => {
  const pk = (id, kind, state = 'pending') => ({ id, kind, state });
  const packages = [pk('a1', 'agy', 'launched'), pk('a2', 'agy'), pk('a3', 'agy'), pk('c1', 'claude'), pk('c2', 'claude')];
  const readyOf = (list) => list.filter((p) => p.state === 'pending').slice(0, 3 - list.filter((p) => p.state === 'launched').length);
  const res = kindCaps.capReady(packages, {
    readyOf,
    isActive: (p) => p.state === 'launched',
    kindOf: (p) => p.kind,
    caps: { agy: 2, free: 3 },
  });
  assert.deepEqual(res.ready.map((p) => p.id), ['a2', 'c1']);
  assert.deepEqual(res.held, ['a3']);
  // Agy workers of other runs count: none left for this run.
  const other = kindCaps.capReady(packages, { readyOf, isActive: (p) => p.state === 'launched', kindOf: (p) => p.kind, caps: { agy: 2, free: 3 }, elsewhere: { agy: 1 } });
  assert.deepEqual(other.ready.map((p) => p.id), ['c1', 'c2']);
});

// ---- per-kind caps: through the controller --------------------------------------------

test('regression: an Opus-only run launches 3 at once (the global cap), never capped per kind', async () => {
  const s = await started({ packages: ['a', 'b', 'c', 'd'].map((id, i) => pkg(id, 'opus', { at: i + 1 })), settings: { agyMaxParallel: 1, freeMaxParallel: 1 } });
  assert.deepEqual(launchedIds(s), ['a', 'b', 'c']);
  assert.ok(s.log.sessions.every((x) => x.profileId === 'cloud' && x.task.model === 'opus'));
});

test('regression: Workers [Opus] launches like the Opus-only run, other runs\' agy workers ignored', async () => {
  const s = await started({ pool: [e('opus')], packages: ['a', 'b', 'c'].map((id, i) => pkg(id, 'opus', { at: i + 1 })), elsewhere: () => 3 });
  assert.deepEqual(launchedIds(s), ['a', 'b', 'c']);
});

test('mixed pool: agy is capped at 2 (default) and the free slot goes to the Opus package behind', async () => {
  const s = await started({
    pool: [e('opus'), e('agy-argon')],
    packages: [pkg('a1', 'agy-argon', { at: 1 }), pkg('a2', 'agy-argon', { at: 2 }), pkg('a3', 'agy-argon', { at: 3 }), pkg('c', 'opus', { at: 4 })],
  });
  assert.deepEqual(launchedIds(s), ['a1', 'a2', 'c']);
  assert.equal(s.view('a3').state, 'pending');
  assert.deepEqual(sessionModels(s).map(([p]) => p).sort(), ['agy-profile', 'agy-profile', 'cloud']);
});

test('mixed pool: the agy setting is read (1) and Claude keeps the run-wide cap', async () => {
  const s = await started({
    pool: [e('opus'), e('sonnet'), e('agy-argon')],
    settings: { agyMaxParallel: 1 },
    packages: [pkg('a1', 'agy-argon', { at: 1 }), pkg('a2', 'agy-argon', { at: 2 }), pkg('c1', 'opus', { at: 3 }), pkg('c2', 'sonnet', { at: 4 })],
  });
  assert.deepEqual(launchedIds(s), ['a1', 'c1', 'c2']);
});

test('mixed pool: the free cap holds hybrid free packages back while Claude ones launch', async () => {
  const s = await started({
    pool: [e('sonnet'), e('free:freellm-chain')],
    workers: 'hybrid',
    settings: { freeMaxParallel: 1 },
    packages: [pkg('f1', 'free', { at: 1 }), pkg('f2', 'free', { at: 2 }), pkg('c', 'sonnet', { at: 3 })],
  });
  assert.deepEqual(launchedIds(s), ['f1', 'c']);
  assert.equal(s.view('f2').state, 'pending');
});

test('cross-run: agy workers of other runs fill the agy cap; the tick launches once they are gone', async () => {
  let others = 2;
  const s = await started({
    pool: [e('opus'), e('agy-argon')],
    elsewhere: () => others,
    packages: [pkg('a1', 'agy-argon', { at: 1 }), pkg('c', 'opus', { at: 2 })],
  });
  assert.deepEqual(launchedIds(s), ['c'], 'the other runs hold both agy slots');
  others = 1;
  s.orch.tick();
  await s.flush();
  assert.deepEqual(launchedIds(s).sort(), ['a1', 'c']);
});

test('cross-run: the registry sums the agy workers of every OTHER run', () => {
  const make = (n) => ({ activeAgyWorkers: () => n, view: () => null, isRunning: () => n > 0 });
  const counts = { p1: 1, p2: 2, p3: 0 };
  const reg = createOrchestraRegistry({ makeController: (projectId) => make(counts[projectId]) });
  for (const id of Object.keys(counts)) reg.ensure(id);
  assert.equal(reg.agyWorkersElsewhere('p1'), 2);
  assert.equal(reg.agyWorkersElsewhere('p2'), 1);
  assert.equal(reg.agyWorkersElsewhere('p3'), 3);
  assert.equal(reg.agyWorkersElsewhere(null), 3);
});

test('cross-run: a real run reports its active agy workers (any run kind) for the other runs', async () => {
  const s = await started({
    pool: [e('opus'), e('agy-argon')],
    packages: [pkg('a1', 'agy-argon', { at: 1 }), pkg('c', 'opus', { at: 2 })],
  });
  assert.equal(s.orch.activeAgyWorkers(), 1);
  const o = await started({ packages: [pkg('a', 'opus')] });
  assert.equal(o.orch.activeAgyWorkers(), 0);
});

// ---- weak-model guard (the easiest agy tier) -------------------------------------------

const weakGuard = require('../src/orchestraWeakGuard');
const { agyPoolKeysOfTier } = require('../src/agyFamilies');

const risky = (id, extra = {}) => pkg(id, 'agy-hydrogen', { files: ['docs/a.md', 'docs/b.md', 'docs/c.md'], ...extra });

test('weak guard: the guarded keys are the easiest agy tier from the family registry (Hydrogen), never Sonnet', () => {
  assert.deepEqual([...weakGuard.WEAK_KEYS], agyPoolKeysOfTier('easy'));
  assert.ok(weakGuard.isWeakKey('agy-hydrogen'));
  for (const k of ['sonnet', 'opus', 'agy-argon', 'agy-neon', 'agy-opus', 'free']) assert.equal(weakGuard.isWeakKey(k), false, k);
});

test('weak guard: a Hydrogen package with 3 files moves to the next stronger ticked model, reason on the board', async () => {
  const s = await planned({ pool: [e('opus'), e('agy-hydrogen')], packages: [risky('h')] });
  const h = s.view('h');
  assert.deepEqual(h.weakGuard, { from: 'agy-hydrogen', reasons: [{ code: 'tooManyFiles', n: 3 }] });
  assert.deepEqual([h.model, h.rescueKey, h.emergency], ['opus', 'opus', false]);
  assert.deepEqual(h.rescues.map((r) => r.text), ['guard: Hydrogen (agy) -> Opus']);
  assert.ok(s.log.lines.some((l) => l.includes('package h: weak-model guard')));
  const res = await s.orch.launch({ planId: s.planId, integration: 'branches', workers: 'claude', modelPool: [e('opus'), e('agy-hydrogen')] });
  assert.equal(res.ok, true, JSON.stringify(res));
  await s.flush();
  assert.deepEqual(sessionModels(s), [['cloud', 'opus']]);
});

test('weak guard: a protected path moves Hydrogen to Sonnet, the nearest stronger ticked model', async () => {
  const s = await started({
    pool: [e('opus'), e('sonnet'), e('agy-hydrogen')],
    packages: [pkg('h', 'agy-hydrogen', { files: ['src/main.js'] })],
  });
  const h = s.view('h');
  assert.equal(h.weakGuard.reasons[0].code, 'protected');
  assert.deepEqual([h.model, h.rescues.map((r) => r.text)], ['sonnet', ['guard: Hydrogen (agy) -> Sonnet']]);
  assert.deepEqual(sessionModels(s), [['cloud', 'sonnet']]);
});

test('weak guard: nothing stronger ticked -> Opus as an emergency at the Emergency Opus effort', async () => {
  const s = await started({
    pool: [e('agy-hydrogen'), e('free:freellm-chain')],
    workers: 'hybrid',
    settings: { emergencyEffort: 'max' },
    packages: [pkg('h', 'agy-hydrogen', { verify: '' })],
  });
  const h = s.view('h');
  assert.deepEqual(h.weakGuard.reasons, [{ code: 'noVerify' }]);
  assert.deepEqual([h.model, h.emergency], ['opus', true]);
  assert.deepEqual(h.rescues.map((r) => r.text), ['guard: Hydrogen (agy) -> Opus (emergency, max)']);
  assert.equal(s.log.sessions[0].task.model, 'opus');
  assert.equal(s.log.sessions[0].task.effort, 'max');
});

test('weak guard: a safe Hydrogen package stays on Hydrogen; Sonnet and Argon are never guarded', async () => {
  const s = await started({
    pool: [e('sonnet'), e('agy-argon'), e('agy-hydrogen')],
    packages: [
      pkg('h', 'agy-hydrogen', { at: 1 }),
      pkg('s', 'sonnet', { at: 2, files: ['src/main.js', 'a', 'b'] }),
      pkg('a', 'agy-argon', { at: 3, files: ['src/preload.js'], verify: '' }),
    ],
  });
  for (const id of ['h', 's', 'a']) assert.equal(s.view(id).weakGuard, undefined, id);
  assert.deepEqual([s.view('h').model, s.view('s').model, s.view('a').model], ['agy:gemini-4-hydrogen-medium', 'sonnet', 'agy:gemini-4-argon-medium']);
});

test('weak guard: Approve with another pool takes the plan-time move back and guards anew', async () => {
  const s = await planned({ pool: [e('opus'), e('agy-hydrogen')], packages: [risky('h')] });
  assert.equal(s.view('h').model, 'opus');
  const res = await s.orch.launch({ planId: s.planId, integration: 'branches', workers: 'claude', modelPool: [e('sonnet'), e('agy-hydrogen')] });
  assert.equal(res.ok, true, JSON.stringify(res));
  await s.flush();
  const h = s.view('h');
  assert.deepEqual([h.model, h.rescues.map((r) => r.text)], ['sonnet', ['guard: Hydrogen (agy) -> Sonnet']]);
});

test('weak guard: the stored record survives a restart only in shape', () => {
  assert.deepEqual(weakGuard.normalizeStoredWeakGuard({ from: 'agy-hydrogen', reasons: [{ code: 'noFiles' }, { code: 'x' }] }), {
    from: 'agy-hydrogen',
    reasons: [{ code: 'noFiles' }],
  });
  for (const bad of [null, {}, { from: 'sonnet', reasons: [{ code: 'noFiles' }] }, { from: 'agy-hydrogen', reasons: [] }]) {
    assert.equal(weakGuard.normalizeStoredWeakGuard(bad), null);
  }
});

test('regression: an Opus-only run never runs the weak guard (no pool)', async () => {
  const s = await started({ packages: [pkg('a', 'opus', { files: ['src/main.js', 'b', 'c'], verify: '' })] });
  const a = s.view('a');
  assert.deepEqual([a.model, a.weakGuard, a.rescues], ['opus', undefined, undefined]);
});
