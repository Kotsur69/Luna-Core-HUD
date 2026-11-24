// ============================================================================
// src/orchestraRescue.js (pure rules of a pool run's rescue) plus the pieces
// that carry its result: the restore of a stored run, the Emergency Opus
// effort pref, the per-model summary, the phone snapshot and the board lines.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const r = require('../src/orchestraRescue');
const sup = require('../src/orchestraSupervisor');
const { emergencyEffortOf } = require('../src/uiprefs');
const { poolModelSummary, poolSummaryLines, poolMoves, EMERGENCY_ROW } = require('../src/orchestraPoolSummary');
const { buildReport } = require('../src/orchestraReport');
const snap = require('../src/godmodesnapshot');

const e = (model, effort = 'plan') => ({ model, effort });
const poolPlan = (models, extra = {}) => ({ workerModel: 'plan', modelPool: models.map((m) => e(m)), ...extra });

// ---- the Emergency Opus effort -----------------------------------------------------

test('emergencyEffort: step = one step up capped at max (today\'s rule); fixed levels; low runs at medium', () => {
  assert.equal(r.emergencyEffort('step', 'medium'), 'high');
  assert.equal(r.emergencyEffort('step', 'max'), 'max');
  assert.equal(r.emergencyEffort(undefined, null), 'high', 'no effort counts as medium, one step up');
  assert.equal(r.emergencyEffort('xhigh', 'medium'), 'xhigh');
  assert.equal(r.emergencyEffort('medium', 'max'), 'medium', 'a fixed level is the level, even below the package');
  assert.equal(r.emergencyEffort('low', 'high'), 'medium', 'God Mode never runs below medium');
  assert.equal(r.emergencyEffort('bogus', 'high'), 'xhigh', 'an unknown setting is step');
  assert.deepEqual(r.EMERGENCY_EFFORTS, ['step', 'low', 'medium', 'high', 'xhigh', 'max']);
});

test('the pref: only the six values are stored; the main-side list matches the renderer selects', async () => {
  for (const v of r.EMERGENCY_EFFORTS) assert.equal(emergencyEffortOf(v), v);
  for (const v of ['plan', 'LOW', '', null, 3, 'xhigh ']) assert.equal(emergencyEffortOf(v), null);
  const { EMERGENCY_OPTIONS } = await import('../src/renderer/modules/orchestraWorkerModel.js');
  assert.deepEqual([...EMERGENCY_OPTIONS], [...r.EMERGENCY_EFFORTS]);
});

// ---- the ladder ------------------------------------------------------------------------

test('isPoolPlan / tickedKeys: only a 2+ model pool frozen as worker model plan', () => {
  assert.equal(r.isPoolPlan(poolPlan(['opus', 'sonnet'])), true);
  assert.equal(r.isPoolPlan(poolPlan(['opus'])), false);
  assert.equal(r.isPoolPlan({ workerModel: 'opus', modelPool: [e('opus'), e('sonnet')] }), false);
  assert.equal(r.isPoolPlan(null), false);
  assert.deepEqual(r.tickedKeys(poolPlan(['agy-hydrogen', 'sonnet', 'opus', 'agy-argon'])), ['opus', 'agy-argon', 'sonnet', 'agy-hydrogen']);
});

test('nextStrongerTicked follows Hydrogen / free < Sonnet < Argon < Neon < Opus (agy) < Opus', () => {
  const all = ['opus', 'agy-opus', 'agy-neon', 'agy-argon', 'sonnet', 'agy-hydrogen'];
  assert.equal(r.nextStrongerTicked('free', all), 'agy-hydrogen');
  assert.equal(r.nextStrongerTicked('agy-hydrogen', all), 'sonnet');
  assert.equal(r.nextStrongerTicked('sonnet', all), 'agy-argon');
  assert.equal(r.nextStrongerTicked('agy-argon', all), 'agy-neon');
  assert.equal(r.nextStrongerTicked('agy-neon', all), 'agy-opus');
  assert.equal(r.nextStrongerTicked('agy-opus', all), 'opus');
  assert.equal(r.nextStrongerTicked('opus', all), null);
  assert.equal(r.nextStrongerTicked('sonnet', ['agy-hydrogen', 'sonnet']), null);
  assert.equal(r.nextStrongerTicked(null, ['agy-hydrogen', 'agy-argon']), 'agy-argon', 'no key: the strongest, never the weakest');
});

test('escalationTarget: next stronger ticked, else Opus (emergency unless ticked), none from Opus', () => {
  assert.deepEqual(r.escalationTarget('sonnet', { ticked: ['sonnet', 'agy-argon'], available: ['agy-argon', 'sonnet'] }), { key: 'agy-argon', emergency: false });
  assert.deepEqual(r.escalationTarget('agy-argon', { ticked: ['agy-argon', 'sonnet'], available: ['agy-argon', 'sonnet'] }), { key: 'opus', emergency: true });
  // Opus ticked but out: still Opus, not an emergency (the pause handles the wait).
  assert.deepEqual(r.escalationTarget('agy-argon', { ticked: ['opus', 'agy-argon'], available: ['agy-argon'] }), { key: 'opus', emergency: false });
  assert.equal(r.escalationTarget('opus', { ticked: ['opus'], available: ['opus'] }), null);
});

test('handOverTarget: Sonnet when usable, else next stronger, else emergency Opus', () => {
  assert.deepEqual(r.handOverTarget({ ticked: ['opus', 'sonnet', 'free'], available: ['opus', 'sonnet'] }), { key: 'sonnet', emergency: false });
  assert.deepEqual(r.handOverTarget({ ticked: ['opus', 'free'], available: ['opus'] }), { key: 'opus', emergency: false });
  assert.deepEqual(r.handOverTarget({ ticked: ['agy-argon', 'free'], available: ['agy-argon'] }), { key: 'agy-argon', emergency: false });
  assert.deepEqual(r.handOverTarget({ ticked: ['agy-hydrogen', 'free'], available: [] }), { key: 'opus', emergency: true });
});

// ---- limits ------------------------------------------------------------------------------

test('outKeys: a paused backend, a free wait, a non-Claude reading at 100% (Claude only by its pause)', () => {
  const ticked = ['opus', 'agy-argon', 'sonnet', 'agy-hydrogen', 'free'];
  assert.deepEqual(r.outKeys({ ticked, pauses: { claude: {} } }), ['opus', 'sonnet']);
  assert.deepEqual(r.outKeys({ ticked, pauses: { agy: {} } }), ['agy-argon', 'agy-hydrogen']);
  assert.deepEqual(r.outKeys({ ticked, freeWaiting: true }), ['free']);
  const now = 5_000_000;
  const readings = [
    { key: 'agy-argon', percent: 100, rawPercent: 100, at: now },
    { key: 'opus', percent: 100, rawPercent: 100, at: now },
    { key: 'agy-hydrogen', percent: 99, rawPercent: 99, at: now },
  ];
  assert.deepEqual(r.outKeys({ ticked, readings, now }), ['agy-argon']);
  assert.equal(r.claudeHeadroom({ agy: {} }), true);
  assert.equal(r.claudeHeadroom({ claude: {} }), false);
  assert.equal(r.claudeHeadroom({ all: {} }), false);
});

test('outKeys: only a fresh, truly full reading is out - not a stale one, not a rounded-up 99.5%', () => {
  const ticked = ['agy-argon', 'agy-neon', 'free'];
  const now = 10_000_000;
  const at = (key, rawPercent, readAt) => ({ key, percent: Math.round(rawPercent), rawPercent, at: readAt });
  // A fresh real 100% still counts, also right at the age limit.
  assert.deepEqual(r.outKeys({ ticked, now, readings: [at('agy-argon', 100, now - 1000)] }), ['agy-argon']);
  assert.deepEqual(r.outKeys({ ticked, now, readings: [at('agy-argon', 100, now - r.MAX_READING_AGE_MS)] }), ['agy-argon']);
  // 99.5% shows as 100% but is not out.
  assert.deepEqual(r.outKeys({ ticked, now, readings: [at('agy-argon', 99.5, now)] }), []);
  // A stale 100% (older than the limit) is not out.
  assert.deepEqual(r.outKeys({ ticked, now, readings: [at('agy-argon', 100, now - r.MAX_READING_AGE_MS - 1)] }), []);
  // No time, a reading from the future, no clock: never out.
  assert.deepEqual(r.outKeys({ ticked, now, readings: [at('agy-argon', 100, null)] }), []);
  assert.deepEqual(r.outKeys({ ticked, now, readings: [at('agy-argon', 100, now + 60_000)] }), []);
  assert.deepEqual(r.outKeys({ ticked, readings: [at('agy-argon', 100, now)] }), []);
  // A rounded percent alone (no rawPercent) is never out.
  assert.deepEqual(r.outKeys({ ticked, now, readings: [{ key: 'agy-argon', percent: 100, at: now }] }), []);
  // A free profile's full fresh reading is out too.
  assert.deepEqual(r.outKeys({ ticked, now, readings: [at('free', 100, now)] }), ['free']);
  // A pause still makes a backend out whatever its reading says.
  assert.deepEqual(r.outKeys({ ticked, now, pauses: { agy: {} }, readings: [at('agy-argon', 10, now)] }), ['agy-argon', 'agy-neon']);
});

test('MAX_READING_AGE_MS covers a healthy usage meter: the others interval plus the longest backoff', () => {
  const usage = require('../src/usage');
  const othersEveryMs = new usage.UsageWatcher(() => {}).othersEveryMs;
  assert.ok(r.MAX_READING_AGE_MS >= othersEveryMs + usage.MAX_BACKOFF_MS, 'a healthy reading is never stale');
  assert.ok(r.MAX_READING_AGE_MS <= 30 * 60 * 1000, 'a stale reading does not linger for half an hour');
});

test('resolveTarget: a ticked Opus with its own fixed effort still takes over at the Emergency Opus effort', () => {
  const pool = [e('opus', 'low'), e('agy-argon')];
  const pkg = { id: 'a', poolModel: 'agy-argon' };
  // Fixed emergency setting: that level, not the pool entry's 'low' (medium).
  assert.deepEqual(r.resolveTarget({ pkg, key: 'opus', pool, agyList: [], effort: 'medium', emergencySetting: 'xhigh' }), { model: 'opus', effort: 'xhigh' });
  // Step: one up from the package's effort, again not the pool entry's level.
  assert.deepEqual(r.resolveTarget({ pkg, key: 'opus', pool, agyList: [], effort: 'high', emergencySetting: 'step' }), { model: 'opus', effort: 'xhigh' });
  const maxPool = [e('opus', 'max'), e('agy-argon')];
  assert.deepEqual(r.resolveTarget({ pkg, key: 'opus', pool: maxPool, agyList: [], effort: 'medium', emergencySetting: 'medium' }), { model: 'opus', effort: 'medium' });
  // A package planned for Opus keeps its own effort.
  const planned = { id: 'b', poolModel: 'opus' };
  assert.deepEqual(r.resolveTarget({ pkg: planned, key: 'opus', pool, agyList: [], effort: 'high', emergencySetting: 'xhigh' }), { model: 'opus', effort: 'high' });
});

test('availableKeys: ticked, not out, runnable, never free', () => {
  const ticked = ['opus', 'agy-neon', 'agy-argon', 'free'];
  assert.deepEqual(r.availableKeys(ticked, ['agy-argon'], (k) => k !== 'agy-neon'), ['opus']);
});

test('limitMoveTarget: stronger first, then the same tier, then Opus emergency only with Claude headroom', () => {
  assert.deepEqual(r.limitMoveTarget('agy-argon', { ticked: ['agy-neon', 'agy-argon'], available: ['agy-neon'], headroom: true }), { key: 'agy-neon', emergency: false });
  assert.deepEqual(r.limitMoveTarget('opus', { ticked: ['opus', 'agy-argon'], available: ['agy-argon'], headroom: false }), { key: 'agy-argon', emergency: false });
  assert.deepEqual(r.limitMoveTarget('agy-neon', { ticked: ['agy-neon', 'agy-argon'], available: ['agy-argon'], headroom: true }), { key: 'agy-argon', emergency: false });
  assert.deepEqual(r.limitMoveTarget('agy-argon', { ticked: ['agy-argon', 'agy-hydrogen'], available: [], headroom: true }), { key: 'opus', emergency: true });
  assert.equal(r.limitMoveTarget('sonnet', { ticked: ['opus', 'sonnet'], available: [], headroom: false }), null);
  // A weaker model of another tier is never a limit target.
  assert.equal(r.limitMoveTarget('agy-argon', { ticked: ['agy-argon', 'agy-hydrogen'], available: ['agy-hydrogen'], headroom: false }), null);
});

test('limitMoves: only pending packages without a session, on an out key', () => {
  const pkgs = [
    { id: 'a', state: 'pending', poolModel: 'agy-argon' },
    { id: 'b', state: 'launched', poolModel: 'agy-argon', sessionId: 's1' },
    { id: 'c', state: 'pending', poolModel: 'sonnet' },
    { id: 'd', state: 'pending', poolModel: 'sonnet', rescueKey: 'agy-argon' },
  ];
  const ctx = { ticked: ['opus', 'agy-argon', 'sonnet'], out: ['agy-argon'], available: ['opus', 'sonnet'], headroom: true };
  assert.deepEqual(r.limitMoves(pkgs, ctx), [
    { id: 'a', from: 'agy-argon', to: 'opus', emergency: false },
    { id: 'd', from: 'agy-argon', to: 'opus', emergency: false },
  ]);
  assert.deepEqual(r.limitMoves(pkgs, { ...ctx, out: [] }), []);
});

// ---- the log ---------------------------------------------------------------------------

test('rescueText: the board / report line of each kind', () => {
  assert.equal(r.rescueText({ kind: 'escalate', from: 'sonnet', to: 'agy-argon' }), 'escalated: Sonnet -> Argon (agy)');
  assert.equal(r.rescueText({ kind: 'escalate', from: 'agy-argon', to: 'opus', emergency: true }), 'escalated: Argon (agy) -> Opus (emergency)');
  assert.equal(r.rescueText({ kind: 'limit', from: 'agy-argon', to: 'opus', emergency: true, effort: 'xhigh' }), 'Argon (agy) limit -> Opus (emergency, xhigh)');
  assert.equal(r.rescueText({ kind: 'handOver', from: 'free', to: 'sonnet' }), 'handed over: free -> Sonnet');
});

test('rescueFields: overrides + key + capped log, never mutating the package', () => {
  let p = { id: 'a', poolModel: 'sonnet', rescues: [] };
  const frozen = JSON.stringify(p);
  const f = r.rescueFields(p, { kind: 'escalate', from: 'sonnet', to: 'opus', emergency: true, model: 'opus', effort: 'high', at: 5, reason: 'blocked\nnow' });
  assert.equal(JSON.stringify(p), frozen);
  assert.deepEqual(f, {
    modelOverride: 'opus',
    effortOverride: 'high',
    rescueKey: 'opus',
    emergency: true,
    rescues: [{ kind: 'escalate', from: 'sonnet', to: 'opus', emergency: true, effort: 'high', at: 5, reason: 'blocked now' }],
  });
  for (let i = 0; i < 20; i += 1) p = { ...p, ...r.rescueFields(p, { kind: 'limit', from: 'sonnet', to: 'opus', model: 'opus', at: i }) };
  assert.equal(p.rescues.length, r.MAX_RESCUES);
});

test('a stored run keeps its rescues and Emergency Opus effort across a restart; junk is dropped', () => {
  const raw = {
    id: 'run-1',
    repoPath: path.resolve('/repo'),
    profileId: 'cloud',
    workerModel: 'plan',
    modelPool: [e('sonnet'), e('agy-argon')],
    emergencyEffort: 'xhigh',
    packages: [
      {
        id: 'a',
        poolModel: 'agy-argon',
        model: 'agy:gemini-4-argon-medium',
        modelOverride: 'opus',
        effortOverride: 'xhigh',
        rescueKey: 'opus',
        emergency: true,
        rescues: [
          { kind: 'escalate', from: 'agy-argon', to: 'opus', emergency: true, effort: 'xhigh', at: 7, reason: 'blocked' },
          { kind: 'bogus', from: 'x', to: 'y' },
        ],
      },
      { id: 'b', poolModel: 'sonnet', model: 'sonnet', rescueKey: 'nope', rescues: 'x' },
    ],
  };
  const plan = sup.normalizeStoredPlan(raw);
  assert.equal(plan.emergencyEffort, 'xhigh');
  const [a, b] = plan.packages;
  assert.deepEqual([a.rescueKey, a.emergency, a.modelOverride, a.effortOverride], ['opus', true, 'opus', 'xhigh']);
  assert.deepEqual(a.rescues, [{ kind: 'escalate', from: 'agy-argon', to: 'opus', emergency: true, effort: 'xhigh', at: 7, reason: 'blocked' }]);
  assert.deepEqual([b.rescueKey, b.rescues], [undefined, undefined]);
  // 'step' is kept too (a restart must not pick up a changed setting); an older run carries no key.
  assert.equal(sup.normalizeStoredPlan({ ...raw, emergencyEffort: 'step' }).emergencyEffort, 'step');
  assert.equal(sup.normalizeStoredPlan({ ...raw, emergencyEffort: undefined }).emergencyEffort, undefined);
  assert.equal(sup.normalizeStoredPlan({ ...raw, emergencyEffort: 'bogus' }).emergencyEffort, undefined);
});

// ---- 5. per-model summary, report, phone ----------------------------------------------------

const T0 = 1_000_000;
const MIN = 60_000;
const summaryView = () => ({
  id: 'run-1',
  repoPath: path.resolve('/repo'),
  workerModel: 'plan',
  permissionMode: 'bypassPermissions',
  integrationMode: 'branches',
  integration: { state: 'idle' },
  modelPool: [e('sonnet'), e('agy-argon')],
  packages: [
    { id: 'a', state: 'pushed', poolModel: 'sonnet', startedAt: T0, finishedAt: T0 + 10 * MIN, todos: [] },
    {
      id: 'b',
      state: 'pushed',
      poolModel: 'agy-argon',
      rescueKey: 'opus',
      emergency: true,
      startedAt: T0,
      finishedAt: T0 + 20 * MIN,
      rescues: [{ kind: 'escalate', from: 'agy-argon', to: 'opus', emergency: true, effort: 'xhigh', at: T0 + 5 * MIN }],
      todos: [],
    },
    {
      id: 'c',
      state: 'stalled',
      terminal: true,
      poolModel: 'agy-argon',
      rescueKey: 'sonnet',
      startedAt: T0,
      finishedAt: T0 + 3 * MIN,
      rescues: [{ kind: 'limit', from: 'agy-argon', to: 'sonnet', at: T0 + MIN }],
      todos: [],
    },
  ],
});

test('poolModelSummary: planned / landed / stalled / escalated / emergency / limit moves / wall time per model', () => {
  const rows = poolModelSummary(summaryView(), T0 + 30 * MIN);
  assert.deepEqual(rows, [
    { key: 'agy-argon', name: 'Argon (agy)', planned: 2, landed: 0, stalled: 0, escalated: 1, emergency: 1, limitMoves: 1, wallMs: 0 },
    { key: 'sonnet', name: 'Sonnet', planned: 1, landed: 1, stalled: 1, escalated: 0, emergency: 0, limitMoves: 0, wallMs: 13 * MIN },
    { key: EMERGENCY_ROW, name: 'Opus (emergency)', planned: 0, landed: 1, stalled: 0, escalated: 0, emergency: 1, limitMoves: 0, wallMs: 20 * MIN },
  ]);
  assert.equal(poolModelSummary({ modelPool: [e('opus')], packages: [] }), null, 'no pool run, no summary');
  assert.equal(poolModelSummary({ ...summaryView(), workerModel: 'opus' }), null, 'a pool that is not the run model (a plan run) has no rows');
  assert.deepEqual(poolMoves(summaryView()).map((m) => [m.id, m.text]), [
    ['c', 'Argon (agy) limit -> Sonnet'],
    ['b', 'escalated: Argon (agy) -> Opus (emergency, xhigh)'],
  ]);
});

test('the morning report carries the per-model table and every move; a run without a pool does not', () => {
  const md = buildReport(summaryView(), { now: T0 + 30 * MIN, suggestions: [] });
  assert.match(md, /## Per model \(pool run\)/);
  assert.match(md, /\| Opus \(emergency\) \| 0 \| 1 \| 0 \| 0 \| 1 \| 0 \| 20 min \|/);
  assert.match(md, /- `c`: Argon \(agy\) limit -> Sonnet/);
  const plain = { ...summaryView(), modelPool: undefined, workerModel: 'opus' };
  assert.doesNotMatch(buildReport(plain, { now: T0 + 30 * MIN, suggestions: [] }), /Per model/);
  assert.deepEqual(poolSummaryLines(plain), []);
});

test('the phone snapshot: live and finished runs carry cleaned per-model rows; a plain run carries none', () => {
  const view = { ...summaryView(), started: true, runStartedAt: T0, projectId: 'p1' };
  const live = snap.liveEntry(view, { now: T0 + 30 * MIN });
  assert.equal(live.poolModels.length, 3);
  assert.deepEqual(live.poolModels[2], { key: EMERGENCY_ROW, name: 'Opus (emergency)', planned: 0, landed: 1, stalled: 0, escalated: 0, emergency: 1, limitMoves: 0, wallMs: 20 * MIN });
  const run = snap.runEntry(view, { now: T0 + 30 * MIN });
  assert.equal(run.poolModels.length, 3);
  assert.equal(snap.liveEntry({ ...view, modelPool: undefined }, { now: T0 }).poolModels, undefined);
  // The reader side: an untrusted row is cleaned.
  assert.deepEqual(snap.cleanPoolModels([{ key: 'BAD KEY' }, { key: 'sonnet', name: 'x\u0000y', planned: -3, landed: 1e9, wallMs: 'x' }]), [
    { key: 'sonnet', name: 'x y', planned: 0, landed: 1000, stalled: 0, escalated: 0, emergency: 0, limitMoves: 0, wallMs: 0 },
  ]);
  assert.equal(snap.cleanPoolModels('nope'), null);
});

test('the board lines name the models', async () => {
  const { rescueLines } = await import('../src/renderer/modules/orchestraRescueLines.js');
  const tEn = (key, p = {}) => {
    const en = {
      'orch.rescue.escalate': 'escalated: {from} -> {to}',
      'orch.rescue.limit': '{from} limit -> {to}',
      'orch.rescue.handOver': 'handed over: {from} -> {to}',
      'orch.rescue.emergency': '{name} (emergency)',
      'orch.rescue.emergencyEffort': '{name} (emergency, {effort})',
      'orch.pkgModel.free': 'free model',
    }[key];
    return en.replace(/\{(\w+)\}/g, (_, k) => p[k]);
  };
  const pkg = {
    rescues: [
      { kind: 'escalate', from: 'sonnet', to: 'agy-argon' },
      { kind: 'limit', from: 'agy-argon', to: 'opus', emergency: true, effort: 'xhigh' },
      { kind: 'handOver', from: 'free', to: 'opus', emergency: true },
      { kind: 'nope', from: 'free', to: 'opus' },
    ],
  };
  assert.deepEqual(rescueLines(pkg, tEn), [
    'escalated: Sonnet -> Argon (agy)',
    'Argon (agy) limit -> Opus (emergency, xhigh)',
    'handed over: free model -> Opus (emergency)',
  ]);
  assert.deepEqual(rescueLines({}, tEn), []);
});
