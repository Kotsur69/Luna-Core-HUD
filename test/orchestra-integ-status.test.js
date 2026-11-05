// ============================================================================
// LunaCore - God Mode integration status regression tests
// ----------------------------------------------------------------------------
// Bug: the Finish run panel kept "Integration (Merge into base branch)
// running..." after the merge was pushed and integration.state was 'done'.
// The finalizer's last commit went out while isRunning() was still true and
// the board trusted that flag over the stored state. Covers the pure status
// derivation (renderer orchestraIntegStatus.js) and the settled broadcast
// (orchestra.js afterFinalize).
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { integrationStatus, fmtElapsed } = require('../src/renderer/modules/orchestraIntegStatus.js');
const { createOrchestra } = require('../src/orchestra.js');

const mergeRun = (integration, packages = [{ id: 'a', merged: true }, { id: 'b', merged: true }]) => ({
  integrationMode: 'merge',
  baseBranch: 'main',
  packages,
  integration,
});

test('a settled run with integration.state done renders done, not running, even with running: true', () => {
  const s = integrationStatus(mergeRun({ state: 'done', running: true, headSha: 'abcdef1234567', skipped: [] }), 1000);
  assert.equal(s.kind, 'done');
  assert.equal(s.sha, 'abcdef1');
  assert.equal(s.base, 'main');
  assert.equal(s.elapsedMs, null);
});

test('a merge that skipped packages is partial: N of M', () => {
  const plan = mergeRun({ state: 'done', partial: true, skipped: [{ id: 'b' }], headSha: 'ff00ff00' }, [
    { id: 'a', merged: true },
    { id: 'b', merged: false },
  ]);
  const s = integrationStatus(plan, 0);
  assert.equal(s.kind, 'partial');
  assert.equal(s.merged, 1);
  assert.equal(s.total, 2);
});

test('a failed integration carries its error and detail', () => {
  const s = integrationStatus(mergeRun({ state: 'failed', running: true, error: 'pushFailed', detail: 'rejected' }), 0);
  assert.equal(s.kind, 'failed');
  assert.equal(s.error, 'pushFailed');
  assert.equal(s.detail, 'rejected');
});

test('only a step whose state is running shows elapsed time', () => {
  const s = integrationStatus(mergeRun({ state: 'running', startedAt: 10_000 }), 75_000);
  assert.equal(s.kind, 'running');
  assert.equal(s.elapsedMs, 65_000);
  assert.equal(fmtElapsed(s.elapsedMs), '1m 05s');
  assert.equal(integrationStatus(mergeRun({ state: 'running' }), 5).elapsedMs, null);
});

test('no integration yet is null; pr mode done is plain done', () => {
  assert.equal(integrationStatus(mergeRun({ state: 'idle' }), 0), null);
  assert.equal(integrationStatus(null, 0), null);
  const pr = integrationStatus({ integrationMode: 'pr', packages: [], integration: { state: 'done', skipped: [] } }, 0);
  assert.equal(pr.kind, 'done');
});

test('fmtElapsed formats seconds, minutes and hours', () => {
  assert.equal(fmtElapsed(9_000), '9s');
  assert.equal(fmtElapsed(3_723_000), '1h 02m');
  assert.equal(fmtElapsed(-5), '0s');
});

// ---- the controller broadcasts the settled view --------------------------------

const turn = (text) =>
  JSON.stringify({ type: 'assistant', message: { stop_reason: 'end_turn', content: [{ type: 'text', text }] } });
const pkg = (id, todoAts) => ({ id, title: `T ${id}`, todoAts, prompt: `do ${id}`, files: [], dependsOn: [], verify: 'npm test', model: 'opus' });

test('after merge-to-base finishes, the last broadcast view is settled (running false, state done, sha)', async () => {
  const views = [];
  let seq = 0;
  const alive = new Set();
  const orch = createOrchestra({
    now: () => 1_700_000_000_000,
    readTodos: () => [{ at: 1, text: 't1', done: false }],
    dirtyCount: async () => 0,
    baseBranchOf: async () => 'main',
    runPlanner: async () => ({ ok: true, raw: { packages: [pkg('a', [1])], notes: '' }, costUsd: 0 }),
    addWorktree: async (_repo, name) => ({ ok: true, root: path.join('/wt', name), cwd: path.join('/wt', name), branch: `luna/${name}` }),
    headSha: async () => 'base0000',
    briefDir: () => '/cfg/tasks',
    writeBrief: () => true,
    createSession: () => {
      seq += 1;
      alive.add(`s${seq}`);
      return { id: `s${seq}` };
    },
    closeSession: (id) => alive.delete(id),
    finishPackage: async (p) => ({ ok: true, headSha: `${p.id}5678aaa`, files: [] }),
    writePty: (id) => alive.has(id),
    sessionAlive: (id) => alive.has(id),
    workerSettings: () => ({ model: 'opus', permissionMode: 'bypassPermissions', integration: 'merge', allowedTools: [] }),
    integrateMerge: async () => ({ ok: true, merged: ['a'], skipped: [], headSha: 'cafe1234beef' }),
    removeWorktree: async () => ({ ok: true }),
    writeReport: (id) => `/cfg/runs/${id}.md`,
    sleep: async () => {},
    setTimer: () => null,
    clearTimer: () => {},
    confirmMerge: async () => true,
    onChange: (v) => views.push(v),
  });
  const { plan } = await orch.makePlan({ projectId: 'p1', repoPath: '/repo', profileId: 'cloud', env: {} });
  await orch.launch({ planId: plan.id, integration: 'merge' });
  orch.onTurnEnd('s1', turn('LUNA_DONE a'));
  for (let i = 0; i < 30; i += 1) await new Promise((r) => setImmediate(r));

  const last = views[views.length - 1];
  assert.equal(last.integration.state, 'done');
  assert.equal(last.integration.running, false, 'the settled view went out after the finalizer went idle');
  const s = integrationStatus(last, Date.now());
  assert.equal(s.kind, 'done');
  assert.equal(s.sha, 'cafe123');
});
