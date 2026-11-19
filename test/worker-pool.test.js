// God Mode "Workers" pool: the shared rules (src/workerPool.js), the main-side
// rules (src/orchestraPool.js) and the ui pref boundary (src/uiprefs.js).
// The agy list below is a real `agy models` answer (2026-11-18): Argon,
// Hydrogen and Claude Opus 5.5 come in level variants, and "Orchestrator
// (Argon)" must never count as an Argon model.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const pool = require('../src/workerPool.js');
const rules = require('../src/orchestraPool.js');
const { EFFORTS } = require('../src/efforts.js');
const { modelPoolPrefOf } = require('../src/uiprefs.js');

const LIVE = [
  ['gemini-4-argon-medium', 'Gemini 4 Argon (Medium)'],
  ['gemini-4-argon-high', 'Gemini 4 Argon (High)'],
  ['gemini-4-argon-low', 'Gemini 4 Argon (Low)'],
  ['gemini-4-hydrogen-high', 'Gemini 4 Hydrogen (High)'],
  ['gemini-4-hydrogen-xhigh', 'Gemini 4 Hydrogen (XHigh)'],
  ['gemini-4-hydrogen-medium', 'Gemini 4 Hydrogen (Medium)'],
  ['gemini-4-hydrogen-low', 'Gemini 4 Hydrogen (Low)'],
  ['gemini-pro-orchestrator-g1-pro', 'Orchestrator (Argon)'],
  ['gemini-3.8-flash-high', 'Gemini 3.8 Flash (High)'],
  ['claude-opus-5-5-low', 'Claude Opus 5.5 (Low)'],
  ['claude-opus-5-5-medium', 'Claude Opus 5.5 (Medium)'],
  ['claude-opus-5-5-high', 'Claude Opus 5.5 (High)'],
  ['claude-sonnet-5-5-high', 'Claude Sonnet 5.5 (High)'],
].map(([id, name]) => ({ id, name }));

const e = (model, effort = 'plan') => ({ model, effort });

// ---- the shared shape ------------------------------------------------------------

test('the pool menu: ids, order, tiers and the strength order', () => {
  assert.deepEqual([...pool.POOL_MODELS], ['opus', 'sonnet', 'agy-opus', 'agy-neon', 'agy-argon', 'agy-hydrogen']);
  assert.deepEqual([...pool.STRENGTH_ORDER], ['opus', 'agy-opus', 'agy-neon', 'agy-argon', 'sonnet', 'agy-hydrogen', 'free']);
  assert.deepEqual(['opus', 'agy-opus', 'agy-neon', 'agy-argon'].map(pool.tierOf), ['hard', 'hard', 'hard', 'hard']);
  assert.deepEqual(['sonnet', 'agy-hydrogen', 'free'].map(pool.tierOf), ['easy', 'easy', 'easy']);
  assert.deepEqual(pool.DEFAULT_POOL, [{ model: 'opus', effort: 'plan' }]);
  assert.ok(Object.isFrozen(pool.POOL_MODEL_LIST) && Object.isFrozen(pool.DEFAULT_POOL));
});

test('POOL_EFFORTS is "plan" + src/efforts.js EFFORTS', () => {
  assert.deepEqual([...pool.POOL_EFFORTS], ['plan', ...EFFORTS]);
});

test('normalizePool: objects only, valid models, deduped, one free profile, effort plan by default', () => {
  assert.equal(pool.normalizePool('opus'), null);
  assert.equal(pool.normalizePool(null), null);
  assert.deepEqual(pool.normalizePool([]), []);
  assert.deepEqual(
    pool.normalizePool([
      { model: 'opus' },
      'sonnet',
      { model: 'sonnet', effort: 'high' },
      { model: 'opus', effort: 'plan' },
      { model: 'agy:gemini-4-argon-high' },
      { model: 'gpt-9' },
      { model: 'agy-argon', effort: 'low' },
      { model: 'free:freellm-chain' },
      { model: 'free:other-chain' },
      { model: 'free:../etc' },
      { model: 'free:' },
    ]),
    [e('opus'), e('sonnet', 'high'), e('free:freellm-chain')],
  );
  const many = Array.from({ length: 50 }, () => ({ model: 'opus' }));
  assert.equal(pool.normalizePool(many).length, 1);
});

test('poolKeys / strongestKey / poolWorkers', () => {
  const mixed = [e('agy-hydrogen'), e('free:freellm-chain'), e('opus'), e('sonnet')];
  assert.deepEqual(pool.poolKeys(mixed), ['opus', 'sonnet', 'agy-hydrogen', 'free']);
  assert.equal(pool.strongestKey(['sonnet', 'agy-argon']), 'agy-argon');
  assert.equal(pool.strongestKey([]), null);
  // A pool with a free profile runs hybrid; a lone free profile is Free only.
  assert.equal(pool.poolWorkers(mixed, 'claude'), 'hybrid');
  assert.equal(pool.poolWorkers([e('free:freellm-chain')], 'claude'), 'free');
  assert.equal(pool.poolWorkers([e('opus'), e('sonnet')], 'claude'), 'claude');
  assert.equal(pool.poolWorkers([e('opus'), e('sonnet')], 'hybrid'), 'hybrid');
  // Today's run and the modes that pick their own workers are untouched.
  assert.equal(pool.poolWorkers([e('opus')], 'claude'), 'claude');
  assert.equal(pool.poolWorkers([], 'hybrid'), 'hybrid');
  assert.equal(pool.poolWorkers(mixed, 'agy'), 'agy');
  assert.equal(pool.poolWorkers(mixed, 'free'), 'free');
});

test('poolFromPrefs: a saved pool wins; else the single Settings model (Opus by default); Fable / plan / agy = none', () => {
  assert.deepEqual(pool.poolFromPrefs(null), [e('opus')]);
  assert.deepEqual(pool.poolFromPrefs({ orchestraWorkerModel: 'opus' }), [e('opus')]);
  assert.deepEqual(pool.poolFromPrefs({ orchestraWorkerModel: 'sonnet' }), [e('sonnet')]);
  for (const single of ['fable', 'plan', 'agy', 'agy:gemini-4-argon-high']) {
    assert.deepEqual(pool.poolFromPrefs({ orchestraWorkerModel: single }), [], single);
  }
  assert.deepEqual(pool.poolFromPrefs({ orchestraWorkerModel: 'fable', orchestraModelPool: [e('opus'), e('agy-argon')] }), [e('opus'), e('agy-argon')]);
  assert.deepEqual(pool.poolFromPrefs({ orchestraWorkerModel: 'sonnet', orchestraModelPool: [] }), [e('sonnet')]);
});

test('togglePoolModel: add last, remove, a second free profile replaces the first', () => {
  let p = [e('opus')];
  p = pool.togglePoolModel(p, 'sonnet', true);
  p = pool.togglePoolModel(p, 'free:a-chain', true);
  p = pool.togglePoolModel(p, 'free:b-chain', true);
  assert.deepEqual(p, [e('opus'), e('sonnet'), e('free:b-chain')]);
  assert.deepEqual(pool.togglePoolModel(p, 'opus', false), [e('sonnet'), e('free:b-chain')]);
  assert.deepEqual(pool.togglePoolModel(p, 'gpt-9', true), p);
});

test('agy families come from the live list by name; Orchestrator (Argon) is no Argon model', () => {
  const ids = (family) => pool.agyFamilyVariants(LIVE, family).map((v) => v.id);
  assert.deepEqual(ids('argon'), ['gemini-4-argon-medium', 'gemini-4-argon-high', 'gemini-4-argon-low']);
  assert.deepEqual(ids('hydrogen'), ['gemini-4-hydrogen-high', 'gemini-4-hydrogen-xhigh', 'gemini-4-hydrogen-medium', 'gemini-4-hydrogen-low']);
  assert.deepEqual(ids('opus'), ['claude-opus-5-5-low', 'claude-opus-5-5-medium', 'claude-opus-5-5-high']);
  assert.deepEqual(ids('nothing'), []);
  assert.deepEqual(pool.agyFamilyVariants(LIVE, 'argon').map((v) => v.level), ['medium', 'high', 'low']);
});

test('Neon (Argon\'s replacement) is its own family; Orchestrator (Neon) is no Neon model', () => {
  // The live `agy models` lines of 2026-11-19 that name Neon.
  const withNeon = [
    { id: 'gemini-4-neon-high', name: 'Gemini 4 Neon (High)' },
    { id: 'gemini-4-neon-xhigh', name: 'Gemini 4 Neon (XHigh)' },
    { id: 'gemini-4-neon-medium', name: 'Gemini 4 Neon (Medium)' },
    { id: 'gemini-4-neon-low', name: 'Gemini 4 Neon (Low)' },
    { id: 'gemini-pro-orchestrator-neon', name: 'Orchestrator (Neon)' },
    ...LIVE,
  ];
  const neon = pool.agyFamilyVariants(withNeon, 'neon');
  assert.deepEqual(neon.map((v) => v.id), ['gemini-4-neon-high', 'gemini-4-neon-xhigh', 'gemini-4-neon-medium', 'gemini-4-neon-low']);
  assert.equal(pool.agyVariantFor(neon, 'max'), 'gemini-4-neon-xhigh');
  assert.equal(pool.agyFamilyVariants(withNeon, 'argon').length, 3, 'Argon stays its own family');
  assert.equal(pool.strongestKey(['agy-argon', 'agy-neon', 'sonnet']), 'agy-neon');
  assert.equal(pool.poolModelName('agy-neon'), 'Neon (agy)');
  const res = rules.applyPool([{ id: 'a', model: 'agy-neon', effort: 'medium' }], [e('opus'), e('agy-neon')], { agyList: withNeon });
  assert.equal(res.packages[0].model, 'agy:gemini-4-neon-medium');
});

test('agyVariantFor: the level nearest the package effort; no effort aims at high', () => {
  const argon = pool.agyFamilyVariants(LIVE, 'argon');
  const hydrogen = pool.agyFamilyVariants(LIVE, 'hydrogen');
  assert.equal(pool.agyVariantFor(argon, 'medium'), 'gemini-4-argon-medium');
  assert.equal(pool.agyVariantFor(argon, null), 'gemini-4-argon-high');
  assert.equal(pool.agyVariantFor(argon, 'plan'), 'gemini-4-argon-high');
  assert.equal(pool.agyVariantFor(argon, 'xhigh'), 'gemini-4-argon-high');
  assert.equal(pool.agyVariantFor(hydrogen, 'max'), 'gemini-4-hydrogen-xhigh');
  assert.equal(pool.agyVariantFor([], 'high'), null);
});

test('cleanPoolOptions: only known ids, agy-shaped variants, well-formed free entries', () => {
  const clean = pool.cleanPoolOptions({
    models: [
      { model: 'agy-argon', available: true, variants: [{ id: 'agy:gemini-4-argon-high', name: 'Argon' }, { id: '--print', name: 'x' }], defaultVariant: 'agy:gemini-4-argon-high' },
      { model: 'gpt-9', available: true, variants: [] },
      { model: 'agy-hydrogen', available: 'yes', variants: [], defaultVariant: 'agy:not-listed' },
    ],
    free: [{ model: 'free:freellm-chain', name: '  FreeLLMAPI - coding  ', coding: true }, { model: 'free:bad id', name: 'x', coding: true }],
  });
  assert.deepEqual(clean, {
    models: [
      { model: 'agy-argon', available: true, variants: [{ id: 'agy:gemini-4-argon-high', name: 'Argon' }], defaultVariant: 'agy:gemini-4-argon-high' },
      { model: 'agy-hydrogen', available: false, variants: [], defaultVariant: null },
    ],
    free: [{ model: 'free:freellm-chain', name: 'FreeLLMAPI - coding', coding: true }],
  });
  assert.deepEqual(pool.cleanPoolOptions(null), { models: [], free: [] });
});

test('the ui pref boundary: valid entries or null', () => {
  assert.equal(modelPoolPrefOf(undefined), null);
  assert.equal(modelPoolPrefOf([]), null);
  assert.equal(modelPoolPrefOf({ model: 'opus' }), null);
  assert.deepEqual(modelPoolPrefOf([{ model: 'opus' }, { model: 'nope' }, { model: 'agy-argon', effort: 'plan' }]), [e('opus'), e('agy-argon')]);
});

// ---- main-side rules -------------------------------------------------------------

test('livePool: an agy family the live list lacks is left out and logged', () => {
  const lines = [];
  const raw = [e('opus'), e('agy-argon'), e('agy-hydrogen')];
  const withoutHydrogen = LIVE.filter((m) => !m.id.includes('hydrogen'));
  assert.deepEqual(rules.livePool(raw, withoutHydrogen, (l) => lines.push(l)), [e('opus'), e('agy-argon')]);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /agy-hydrogen/);
  assert.equal(rules.livePool('x', LIVE), null);
});

test('applyPool: in-pool picks resolve to their worker model; out-of-pool and guard upgrades go to the strongest', () => {
  const packages = [
    { id: 'css', model: 'agy-hydrogen', poolModel: 'agy-hydrogen', effort: 'medium', state: 'pending' },
    { id: 'ipc', model: 'agy-argon', poolModel: 'agy-argon', effort: null, state: 'pending' },
    { id: 'copy', model: 'free', poolModel: 'free', effort: 'medium', state: 'pending' },
    // The hybrid guard moved it to Sonnet, which this pool does not tick.
    { id: 'guarded', model: 'sonnet', poolModel: 'free', hybridGuard: { from: 'free' }, state: 'pending' },
    { id: 'escalated', model: 'agy-argon', modelOverride: 'opus', state: 'pending' },
  ];
  const res = rules.applyPool(packages, [e('opus'), e('agy-argon'), e('agy-hydrogen'), e('free:freellm-chain')], { agyList: LIVE });
  assert.equal(res.ok, true);
  const by = Object.fromEntries(res.packages.map((p) => [p.id, p]));
  assert.equal(by.css.model, 'agy:gemini-4-hydrogen-medium');
  assert.equal(by.ipc.model, 'agy:gemini-4-argon-high');
  assert.equal(by.copy.model, 'free');
  assert.equal(by.guarded.model, 'opus');
  assert.equal(by.guarded.poolModel, 'opus');
  // A guard move is no planner pick: the card's guard line explains it, no "planner picked" line.
  assert.equal(by.guarded.poolFrom, undefined);
  // Rescue: an override keeps the package exactly as it was.
  assert.equal(by.escalated, packages[4]);
  assert.deepEqual(res.moved, [{ id: 'guarded', from: 'sonnet', to: 'opus' }]);
});

test('applyPool: re-applying a resolved plan with a new pool keeps in-pool picks and moves the rest', () => {
  const first = rules.applyPool([{ id: 'a', model: 'agy-argon', poolModel: 'agy-argon', effort: 'medium' }], [e('opus'), e('agy-argon')], { agyList: LIVE });
  assert.equal(first.packages[0].model, 'agy:gemini-4-argon-medium');
  const again = rules.applyPool(first.packages, [e('opus'), e('agy-argon')], { agyList: LIVE });
  assert.equal(again.packages[0].model, 'agy:gemini-4-argon-medium');
  assert.deepEqual(again.moved, []);
  const narrowed = rules.applyPool(first.packages, [e('sonnet'), e('agy-hydrogen')], { agyList: LIVE });
  assert.equal(narrowed.packages[0].model, 'sonnet');
  assert.deepEqual(narrowed.moved, [{ id: 'a', from: 'agy-argon', to: 'sonnet' }]);
  // A second move keeps the planner's FIRST out-of-pool pick for the report.
  const planned = [{ id: 'b', model: 'opus', poolModel: 'opus', poolFrom: 'fable' }];
  const moved = rules.applyPool(planned, [e('sonnet'), e('agy-hydrogen')], { agyList: LIVE });
  assert.equal(moved.packages[0].poolFrom, 'fable');
});

test('applyPool: the agy variant follows the worker effort the caller gives', () => {
  const pkgs = [{ id: 'a', model: 'agy-argon', effort: null }];
  const effortOf = (p) => p.effort || 'medium';
  const res = rules.applyPool(pkgs, [e('opus'), e('agy-argon')], { agyList: LIVE, effortOf });
  assert.equal(res.packages[0].model, 'agy:gemini-4-argon-medium');
});

test('applyPool: an agy family with no live variant is not usable; a pool with nothing usable is refused', () => {
  const res = rules.applyPool([{ id: 'a', model: 'agy-argon' }], [e('sonnet'), e('agy-argon')], { agyList: [] });
  assert.equal(res.packages[0].model, 'sonnet');
  assert.deepEqual(rules.applyPool([{ id: 'a', model: 'agy-argon' }], [e('agy-argon'), e('agy-hydrogen')], { agyList: [] }), { ok: false, error: 'badAgyModel' });
});

test('approveChoice: none / one model = today\'s single value / a pool run', () => {
  assert.deepEqual(rules.approveChoice(null, LIVE), { kind: 'none' });
  assert.deepEqual(rules.approveChoice([], LIVE), { kind: 'none' });
  assert.deepEqual(rules.approveChoice([e('opus')], LIVE), { kind: 'single', workerModel: 'opus' });
  assert.deepEqual(rules.approveChoice([e('sonnet')], LIVE), { kind: 'single', workerModel: 'sonnet' });
  assert.deepEqual(rules.approveChoice([e('agy-argon')], LIVE), { kind: 'single', workerModel: 'agy:gemini-4-argon-high' });
  assert.deepEqual(rules.approveChoice([e('agy-argon')], []), { kind: 'error', error: 'badAgyModel' });
  assert.deepEqual(rules.approveChoice([e('free:freellm-chain')], LIVE), { kind: 'single', workers: 'free', freeProfileId: 'freellm-chain' });
  const two = [e('opus'), e('free:freellm-chain')];
  assert.deepEqual(rules.approveChoice(two, LIVE), { kind: 'pool', pool: two, freeProfileId: 'freellm-chain' });
});

test('poolOptions: agy families by their live variants, free profiles with a chain (coding or not)', () => {
  const profiles = [
    { id: 'claude-cloud', name: 'Claude' },
    { id: 'freellm-chain', name: 'FreeLLMAPI - coding' },
    { id: 'freellm-easy', name: 'FreeLLMAPI - easy' },
  ];
  const out = rules.poolOptions({
    agyList: LIVE.filter((m) => !m.id.includes('hydrogen')),
    profiles,
    isFreeProfile: (p) => p.id.startsWith('freellm'),
    isCodingProfile: (p) => p.id === 'freellm-chain',
  });
  const argon = out.models.find((m) => m.model === 'agy-argon');
  assert.equal(argon.available, true);
  assert.equal(argon.variants.length, 3);
  assert.equal(argon.defaultVariant, 'agy:gemini-4-argon-high');
  assert.equal(out.models.find((m) => m.model === 'agy-hydrogen').available, false);
  assert.equal(out.models.find((m) => m.model === 'opus').available, true);
  assert.deepEqual(out.free, [
    { model: 'free:freellm-chain', name: 'FreeLLMAPI - coding', coding: true },
    { model: 'free:freellm-easy', name: 'FreeLLMAPI - easy', coding: false },
  ]);
});

test('the run report: a pool run lists model and reason per package; any other run adds nothing', () => {
  assert.deepEqual(rules.poolReportLines({ packages: [{ id: 'a' }] }), []);
  const lines = rules.poolReportLines({
    modelPool: [e('opus'), e('sonnet')],
    packages: [
      { id: 'css', poolModel: 'sonnet', model: 'sonnet', modelReason: 'one CSS file' },
      { id: 'ipc', poolModel: 'opus', model: 'opus', modelReason: 'new IPC | handler', poolFrom: 'fable' },
    ],
  });
  const text = lines.join('\n');
  assert.match(text, /## Worker models \(pool run\)/);
  assert.match(text, /- Pool: Opus \+ Sonnet/);
  assert.match(text, /\| `css` \| Sonnet \| sonnet \| one CSS file \|/);
  assert.match(text, /planner picked fable \(not in the pool\); new IPC \\\| handler/);
});
