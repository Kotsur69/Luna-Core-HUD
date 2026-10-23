// ============================================================================
// LunaCore - God Mode v2 to-do picker + failure diagnosis tests
// ----------------------------------------------------------------------------
// Picker: only ticked to-dos reach the planner (orchestraPlan.pickTodos,
// orchestra.makePlan, the renderer's orchestraPickRules.js). Diagnosis: every
// problem in a settled run gets what happened / why / how to fix + evidence
// in the report's "What went wrong" section (orchestraDiagnose.js).
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { pickTodos } = require('../src/orchestraPlan.js');
const { createOrchestra } = require('../src/orchestra.js');
const { buildReport, renderRunReportHtml } = require('../src/orchestraReport.js');
const { diagnosePackage, diagnoseIntegration, lastWordsFrom, outputTail } = require('../src/orchestraDiagnose.js');
const rules = require('../src/renderer/modules/orchestraPickRules.js');

const todo = (at, text, extra = {}) => ({ at, text, done: false, ...extra });

// ---- picker: main side -------------------------------------------------------

test('pickTodos: no selection = all, a selection keeps only known ats', () => {
  const open = [todo(1, 'a'), todo(2, 'b'), todo(3, 'c')];
  assert.equal(pickTodos(open, null), open);
  assert.deepEqual(pickTodos(open, [3, 1, 99, NaN]).map((t) => t.at), [1, 3]);
  assert.deepEqual(pickTodos(open, []), []);
});

function planSetup(todos) {
  const seen = [];
  const orch = createOrchestra({
    now: () => 1700000000000,
    readTodos: () => todos,
    dirtyCount: async () => 0,
    runPlanner: async ({ openTodos }) => {
      seen.push(openTodos.map((t) => t.at));
      return { ok: true, raw: { packages: openTodos.map((t) => ({ id: `p${t.at}`, title: t.text, todoAts: [t.at], prompt: 'x', files: [], dependsOn: [], verify: 'npm test', model: 'sonnet' })), notes: '' } };
    },
    addWorktree: async () => ({ ok: false, error: 'gitFailed' }),
    briefDir: () => '/cfg/tasks',
    writeBrief: () => true,
    createSession: () => ({ id: 's1' }),
  });
  return { orch, seen };
}

test('makePlan hands the planner only the ticked to-dos', async () => {
  const { orch, seen } = planSetup([todo(1, 'one'), todo(2, 'two'), todo(3, 'three', { manual: true })]);
  const ctx = { projectId: 'p', repoPath: '/repo', profileId: 'x', env: {} };
  const res = await orch.makePlan({ ...ctx, todoAts: [2, 3] });
  assert.equal(res.ok, true);
  assert.deepEqual(seen[0], [2], 'manual card 3 stays out even when ticked');
  assert.deepEqual(res.plan.packages.map((p) => p.id), ['p2']);
});

test('makePlan: a selection with nothing open left is refused', async () => {
  const { orch, seen } = planSetup([todo(1, 'one')]);
  const res = await orch.makePlan({ projectId: 'p', repoPath: '/repo', profileId: 'x', env: {}, todoAts: [42] });
  assert.deepEqual(res, { ok: false, error: 'noneSelected' });
  assert.equal(seen.length, 0, 'the planner never ran');
});

// ---- picker: renderer rules -----------------------------------------------------

test('pickable drops done and manual cards; manualCount counts open manual ones', () => {
  const list = [todo(1, 'a'), todo(2, 'b', { done: true }), todo(3, 'c', { manual: true })];
  assert.deepEqual(rules.pickable(list).map((t) => t.at), [1]);
  assert.equal(rules.manualCount(list), 1);
});

test('mergeSelection keeps choices and ticks only never-seen cards', () => {
  const cards = [todo(1, 'a'), todo(2, 'b'), todo(3, 'new')];
  const next = rules.mergeSelection(cards, new Set([1]), new Set([1, 2]));
  assert.deepEqual([...next].sort(), [1, 3]);
});

test('missingDeps flags ticked cards leaning on unticked open ones; withDeps adds them transitively', () => {
  const cards = [todo(1, 'base'), todo(2, 'mid', { dependsOn: [1] }), todo(3, 'top', { dependsOn: [2, 999] })];
  const missing = rules.missingDeps(cards, new Set([3]));
  assert.deepEqual([...missing.entries()], [[3, ['mid']]]);
  assert.deepEqual([...rules.withDeps(cards, new Set([3]))].sort(), [1, 2, 3]);
});

// ---- diagnosis -------------------------------------------------------------------

test('every package code gets what / why / fix; unknown codes still explain themselves', () => {
  for (const error of ['blocked', 'noMarker', 'timeout', 'verifyFailed', 'pushFailed', 'approvalTimeout', 'restarted']) {
    const d = diagnosePackage({ state: 'stalled', error });
    assert.ok(d.what && d.why && d.fix, error);
  }
  assert.match(diagnosePackage({ state: 'killed' }).what, /kill switch/);
  assert.match(diagnosePackage({ state: 'stalled', error: 'brandNew' }).fix, /Retry/);
  assert.match(diagnoseIntegration('conflictFailed').fix, /by hand/);
});

test('lastWordsFrom quotes the final assistant message; outputTail keeps the end', () => {
  const line = JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Tried X.\nShould I drop the old API?' }] },
  });
  assert.match(lastWordsFrom(`${line}\n`), /Should I drop the old API\?/);
  assert.equal(lastWordsFrom(''), '');
  const out = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n');
  assert.equal(outputTail(out).split('\n').length, 12);
  assert.match(outputTail(out), /line 29$/);
});

const failedView = () => ({
  id: 'pabc',
  repoPath: '/repo',
  baseBranch: 'main',
  workerModel: 'opus',
  permissionMode: 'bypassPermissions',
  integrationMode: 'merge',
  integration: { state: 'failed', error: 'verifyFailed', detail: '2 failing', skipped: [{ id: 'b', stage: 'conflict', detail: 'CONFLICT', files: ['src/x.js'] }] },
  options: {},
  runStartedAt: 1,
  pausedTotalMs: 0,
  overlaps: [],
  packages: [
    { id: 'a', title: 'A', state: 'pushed', branch: 'luna/a' },
    { id: 'b', title: 'B', state: 'pushed', branch: 'luna/b' },
    {
      id: 'c',
      title: 'C',
      state: 'stalled',
      error: 'verifyFailed',
      detail: 'not ok 3',
      branch: 'luna/c',
      verify: 'npm test',
      verifyRounds: 2,
      escalated: true,
      terminal: true,
      lastWords: 'Fixed the parser / LUNA_DONE c',
      verifyTail: 'ok 1\nnot ok 3 - adds\n  expected 2\x1b[2J',
    },
  ],
});

test('report: What went wrong explains each problem with evidence, right after Needs you', () => {
  const md = buildReport(failedView(), { now: 2, suggestions: [] });
  const start = md.indexOf('\n## What went wrong\n');
  assert.ok(start > md.indexOf('\n## Needs you\n') && start < md.indexOf('\n## Manual actions\n'));
  const wrong = md.slice(start, md.indexOf('\n## Manual actions\n'));
  assert.match(wrong, /### `b` B - left out of the merge \(conflict\)/);
  assert.match(wrong, /### `c` C - stalled \(verifyFailed\)/);
  assert.match(wrong, /What happened: The worker said it was done, but the verify command kept failing/);
  assert.match(wrong, /How to fix: Run the verify command in the worktree/);
  assert.match(wrong, /Verify command: `npm test`/);
  assert.match(wrong, /Already tried: escalation to Opus, 2 verify fix-up rounds/);
  assert.match(wrong, /Worker's last words: "Fixed the parser/);
  assert.match(wrong, / {4}not ok 3 - adds/);
  assert.match(wrong, /### Integration - verifyFailed/);
  // eslint-disable-next-line no-control-regex
  assert.doesNotMatch(wrong, /[\x00-\x09\x0b-\x1f\x7f]/, 'no control characters from test output');
});

test('report: a clean run says Nothing under What went wrong; HTML carries the section escaped', () => {
  const clean = { ...failedView(), integration: { state: 'done', skipped: [] }, packages: [{ id: 'a', title: 'A', state: 'pushed' }] };
  assert.match(buildReport(clean, { now: 2, suggestions: [] }), /## What went wrong\n\nNothing\./);
  const view = failedView();
  view.packages[2].lastWords = '<script>alert(1)</script>';
  const html = renderRunReportHtml(view, { now: 2 });
  assert.match(html, /<h2>What went wrong<\/h2>/);
  assert.match(html, /How to fix: Run the verify command/);
  assert.doesNotMatch(html, /<script>alert/);
});
