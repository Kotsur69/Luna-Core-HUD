// Phone God Mode C/D: the pending plans read from `godmode` snapshot rows
// (mobile/src/snapmodel.js godmodePlansFrom), the per-plan draft and the
// godmode.launch payload (mobile/src/godmodeplanmodel.js), and the live run's
// projectId that the phone's Kill / Retry / Finish name.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { godmodePlansFrom, snapRows } from '../mobile/src/snapmodel.js';
import { planDraft, togglePackage, needsMergeConfirm, launchPayload, discardPayload, INTEGRATION_MODES } from '../mobile/src/godmodeplanmodel.js';

const require = createRequire(import.meta.url);
const { withLive, parseGodmodePeer } = require('../src/godmodesnapshot.js');

const NOW = 1_800_000_000_000;
const row = (machine, data, at = NOW) => ({ machine, data: { v: 2, at, runs: [], ...data }, updated_at: new Date(at).toISOString() });

const readyPlan = {
  planId: 'pabc123',
  projectId: 'p-luna',
  repoName: 'luna-core-hud',
  state: 'ready',
  errors: [],
  packages: [
    { id: 'a', title: 'First', deps: [], model: 'sonnet' },
    { id: 'b', title: 'Second', deps: ['a'], model: 'opus' },
  ],
  todos: ['Do the thing'],
};

test('godmodePlansFrom reads every PC plan with machine and stale', () => {
  const rows = snapRows([row('KT-PC', { plans: [readyPlan] }), row('Laptop', { plans: [{ ...readyPlan, planId: null, state: 'planning', packages: [] }] }, NOW - 10 * 60 * 1000)], NOW);
  const plans = godmodePlansFrom(rows, NOW);
  assert.equal(plans.length, 2);
  assert.equal(plans[0].machine, 'KT-PC');
  assert.equal(plans[0].stale, false);
  assert.deepEqual(plans[0].packages.map((p) => p.id), ['a', 'b']);
  assert.equal(plans[1].state, 'planning');
  assert.equal(plans[1].stale, true);
});

test('godmodePlansFrom drops junk and never trusts the writer', () => {
  const evil = {
    ...readyPlan,
    repoName: 'C:\\Users\\me\\repo',
    errors: ['failed in C:\\Users\\me\\secret\\file.js', 42],
    packages: [{ id: 'a', title: 'x\u0000y', deps: 'nope', model: 'sonnet' }, { title: 'no id' }, 'str'],
  };
  const rows = snapRows([row('KT-PC', { plans: [evil, { state: 'weird', projectId: 'x' }, { state: 'ready' }, null] })], NOW);
  const [plan, ...rest] = godmodePlansFrom(rows, NOW);
  assert.equal(rest.length, 0);
  assert.equal(plan.repoName, 'repo', 'only the folder name');
  assert.deepEqual(plan.errors, ['failed in file.js']);
  assert.deepEqual(plan.packages, [{ id: 'a', title: 'x y', deps: [], model: 'sonnet' }]);
  assert.deepEqual(godmodePlansFrom(snapRows([row('KT-PC', { plans: 'nope' })], NOW), NOW), []);
  assert.deepEqual(godmodePlansFrom(snapRows([{ machine: 'bad name!', data: { v: 2, at: NOW, runs: [], plans: [readyPlan] } }], NOW), NOW), []);
});

test('a ready plan without an id or packages reads as failed', () => {
  const rows = snapRows([row('KT-PC', { plans: [{ ...readyPlan, planId: null }, { ...readyPlan, projectId: 'p2', packages: [] }] })], NOW);
  const plans = godmodePlansFrom(rows, NOW);
  assert.deepEqual(plans.map((p) => p.state), ['failed', 'failed']);
  assert.deepEqual(plans[0].errors, ['noPlan']);
});

test('planDraft: fresh draft ticks every package; the same plan keeps its draft', () => {
  const fresh = planDraft(readyPlan, null);
  assert.deepEqual(fresh, { planId: 'pabc123', ticked: ['a', 'b'], integration: 'pr', free: false, releaseAfter: false });
  const edited = { ...togglePackage(fresh, 'a'), integration: 'merge', free: true, releaseAfter: true };
  assert.deepEqual(planDraft(readyPlan, edited), { ...edited });
  // A package gone from the plan drops out of the ticks.
  const smaller = { ...readyPlan, packages: [readyPlan.packages[0]] };
  assert.deepEqual(planDraft(smaller, fresh).ticked, ['a']);
  // A new plan for the project starts over.
  assert.deepEqual(planDraft({ ...readyPlan, planId: 'pnew' }, edited).ticked, ['a', 'b']);
  assert.equal(planDraft(readyPlan, { ...fresh, integration: 'yolo' }).integration, 'pr');
  assert.deepEqual(fresh.ticked, ['a', 'b'], 'togglePackage does not mutate');
});

test('launchPayload: ids only when some package is unticked, in plan order', () => {
  const draft = planDraft(readyPlan, null);
  assert.deepEqual(launchPayload(readyPlan, draft), { projectId: 'p-luna', planId: 'pabc123', integration: 'pr', free: false });
  const onlyB = togglePackage(draft, 'a');
  assert.deepEqual(launchPayload(readyPlan, onlyB).ids, ['b']);
  const reordered = { ...draft, ticked: ['b', 'a'] };
  assert.equal(launchPayload(readyPlan, reordered).ids, undefined, 'all ticked in any order = no ids');
  assert.equal(launchPayload(readyPlan, { ...draft, ticked: [] }), null);
});

test('launchPayload: releaseAfter only with a merge; merge needs a confirmation', () => {
  const draft = { ...planDraft(readyPlan, null), releaseAfter: true, free: true };
  assert.equal('releaseAfter' in launchPayload(readyPlan, draft), false);
  assert.equal(launchPayload(readyPlan, draft).free, true);
  const merge = { ...draft, integration: 'merge' };
  assert.equal(launchPayload(readyPlan, merge).releaseAfter, true);
  assert.equal(needsMergeConfirm(merge), true);
  assert.equal(needsMergeConfirm(draft), false);
  assert.deepEqual(INTEGRATION_MODES, ['pr', 'merge', 'branches']);
});

test('launchPayload refuses a plan that is not ready', () => {
  const draft = planDraft(readyPlan, null);
  assert.equal(launchPayload({ ...readyPlan, state: 'planning' }, draft), null);
  assert.equal(launchPayload({ ...readyPlan, state: 'failed' }, draft), null);
  assert.equal(launchPayload({ ...readyPlan, planId: null }, draft), null);
  assert.equal(launchPayload(readyPlan, null), null);
  assert.deepEqual(discardPayload(readyPlan), { projectId: 'p-luna' });
});

test('a live run carries its projectId for Kill / Retry / Finish; an off-shape one is dropped', () => {
  const live = { id: 'pabc123', title: 'repo', baseBranch: 'main', startedAt: NOW - 1000, state: 'running', packages: [] };
  const snap = withLive(null, { lives: [{ ...live, projectId: 'p-luna' }, { ...live, id: 'p2', projectId: 'bad id!' }] }, { machine: 'KT-PC', now: NOW });
  assert.equal(snap.lives[0].projectId, 'p-luna');
  assert.equal('projectId' in snap.lives[1], false);
  const peer = parseGodmodePeer({ machine: 'KT-PC', data: snap }, NOW);
  assert.equal(peer.lives[0].projectId, 'p-luna');
});
