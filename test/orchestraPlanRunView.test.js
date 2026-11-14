'use strict';

// Free God Mode v2 plan runs - board view, report lines, sizing, restore.

const test = require('node:test');
const assert = require('node:assert/strict');

const view = require('../src/orchestraPlanRunView');
const core = require('../src/orchestraPlanRun');

const SLUG = 'auth-plan-x1';
const TOPICS = [
  { slug: 'auth-flow', question: 'How should sign-in work?' },
  { slug: 'data-model', question: 'What tables do we need?' },
];

function planWith(states, over = {}) {
  const packages = core.buildPlanRunPackages(SLUG, TOPICS, { goal: 'plan auth' }).map((p) => ({
    ...p,
    state: states[p.id] || 'pending',
    branch: `luna-plan/${p.id}`,
  }));
  return {
    id: 'run1',
    planRun: { runSlug: SLUG, request: 'plan auth', planner: 'free', topics: TOPICS, saved: [], flagged: [], ...over },
    packages,
  };
}

test('view: null for a build run or an unreadable plan-run block', () => {
  assert.equal(view.planRunView(null), null);
  assert.equal(view.planRunView({ packages: [] }), null);
  assert.equal(view.planRunView({ planRun: { runSlug: '../x' }, packages: [] }), null);
});

test('view: a fresh run shows topics and three pending phases', () => {
  const v = view.planRunView(planWith({}));
  assert.equal(v.runSlug, SLUG);
  assert.equal(v.folder, `docs/plans/${SLUG}/`);
  assert.equal(v.planner, 'free');
  assert.deepEqual(v.topics, [
    { slug: 'auth-flow', question: 'How should sign-in work?', state: 'pending' },
    { slug: 'data-model', question: 'What tables do we need?', state: 'pending' },
  ]);
  assert.deepEqual(v.phases, {
    topics: { state: 'pending', done: 0, total: 2 },
    critique: { state: 'pending' },
    synthesis: { state: 'pending' },
  });
  assert.deepEqual(v.docs, []);
  assert.equal(v.ready, false);
});

test('view: running, stalled and done phases; only saved docs are linked', () => {
  const plan = planWith({ 'auth-flow': 'pushed', 'data-model': 'launched' }, { saved: ['auth-flow'] });
  let v = view.planRunView(plan);
  assert.deepEqual(v.phases.topics, { state: 'running', done: 1, total: 2 });
  assert.deepEqual(v.docs, [{ id: 'auth-flow', file: 'auth-flow.md', path: `docs/plans/${SLUG}/auth-flow.md`, branch: 'luna-plan/auth-flow' }]);

  plan.packages[1] = { ...plan.packages[1], state: 'stalled', error: 'outsidePlanFolder', detail: 'src/x.js' };
  v = view.planRunView(plan);
  assert.equal(v.phases.topics.state, 'stalled');
  assert.deepEqual(v.stalls, [{ id: 'data-model', reason: 'outsidePlanFolder', detail: 'src/x.js' }]);
  assert.equal(v.topics[1].state, 'stalled');

  // A build-style stall reason is not a plan-guard stall.
  plan.packages[1] = { ...plan.packages[1], error: 'idle' };
  assert.deepEqual(view.planRunView(plan).stalls, []);
});

test('view: ready when synthesis is pushed', () => {
  const all = { 'auth-flow': 'pushed', 'data-model': 'pushed', critique: 'pushed', synthesis: 'pushed' };
  const v = view.planRunView(planWith(all, { saved: ['auth-flow', 'data-model', 'critique', 'synthesis'] }));
  assert.equal(v.ready, true);
  assert.deepEqual(v.docs.map((d) => d.file), ['auth-flow.md', 'data-model.md', 'CRITIQUE.md', 'PLAN.md']);
  assert.equal(v.phases.synthesis.state, 'done');
  assert.equal(view.planRunResult(v, 4), 'Plan ready to review - 4 of 4 documents written');
  assert.equal(view.planRunResult({ ...v, ready: false, docs: v.docs.slice(0, 1) }, 4), '1 of 4 plan documents written');
});

test('planDocFile / planDocsDir accept only names LunaCore made', () => {
  assert.equal(view.planDocFile({ planRun: { outputPath: 'docs/plans/a/PLAN.md' } }), 'PLAN.md');
  assert.equal(view.planDocFile({ planRun: { outputPath: 'docs/plans/a/Evil Name.md' } }), null);
  assert.equal(view.planDocFile({ planRun: { outputPath: 'docs/plans/a/x.sh' } }), null);
  assert.equal(view.planDocFile({ planRun: { outputPath: 'docs/plans/a/..' } }), null);
  assert.equal(view.planDocFile({}), null);
  assert.equal(view.planDocsDir('run1'), 'run1-plan');
  assert.equal(view.planDocsDir('../x'), null);
  assert.equal(view.planDocsDir(''), null);
});

test('report lines: a link to every doc, flagged tasks, plan-guard stalls', () => {
  const all = { 'auth-flow': 'pushed', 'data-model': 'stalled', critique: 'pending', synthesis: 'pending' };
  const plan = planWith(all, { saved: ['auth-flow'], flagged: [{ index: 2, text: 'Rewrite main', reasons: ['touches ~3383 lines'] }] });
  plan.packages[1] = { ...plan.packages[1], error: 'noSources', detail: null };
  const md = view.planRunReportLines({ id: 'run1', planRun: view.planRunView(plan) }).join('\n');
  assert.match(md, /## Plan documents/);
  assert.ok(md.includes(`- [auth-flow.md](run1-plan/auth-flow.md) - \`docs/plans/${SLUG}/auth-flow.md\` on \`luna-plan/auth-flow\``), md);
  assert.match(md, /### Flagged tasks\n\n- Task 3: Rewrite main - touches ~3383 lines/);
  assert.match(md, /### Plan guard\n\n- data-model: noSources/);
  assert.match(md, /not finished/);
  assert.deepEqual(view.planRunReportLines({ id: 'run1', planRun: null }), []);
});

test('report lines: no doc written yet says so', () => {
  const md = view.planRunReportLines({ id: 'run1', planRun: view.planRunView(planWith({})) }).join('\n');
  assert.match(md, /- No document was written/);
});

// ---------------------------------------------------------------------------
// Sizing
// ---------------------------------------------------------------------------

const fakeFs = (files) => ({
  repoRoot: '/repo',
  fileExists: (_abs, rel) => Object.prototype.hasOwnProperty.call(files, rel),
  lineCount: (_abs, rel) => files[rel] || 0,
});
const PLAN_PATH = `docs/plans/${SLUG}/PLAN.md`;
const SMALL = '## Tasks\n- [ ] Add the store\n  - Files: src/a.js\n  - Acceptance: `npm test`\n';
const BIG = '## Tasks\n- [ ] Rewrite main\n  - Files: src/main.js\n  - Acceptance: `npm test`\n';

test('sizing: small tasks accepted, a big one split once then flagged', () => {
  const fs = fakeFs({ 'src/a.js': 50, 'src/main.js': 3383 });
  assert.deepEqual(view.planSizingStep(SMALL, { ...fs, splitsSent: 0, planPath: PLAN_PATH }), { action: 'accept' });
  const split = view.planSizingStep(BIG, { ...fs, splitsSent: 0, planPath: PLAN_PATH });
  assert.equal(split.action, 'split');
  assert.match(split.brief, /Rewrite main/);
  const flag = view.planSizingStep(BIG, { ...fs, splitsSent: 1, planPath: PLAN_PATH });
  assert.equal(flag.action, 'flag');
  assert.equal(flag.flagged[0].index, 0);
  assert.equal(flag.flagged[0].text, 'Rewrite main');
  assert.match(flag.flagged[0].reasons.join(' '), /3383/);
});

test('sizing: an unreadable or task-less PLAN.md is flagged, never accepted', () => {
  const fs = fakeFs({});
  assert.equal(view.planSizingStep(null, { ...fs, planPath: PLAN_PATH }).action, 'flag');
  const empty = view.planSizingStep('# Plan\n## Summary\nnothing\n', { ...fs, planPath: PLAN_PATH });
  assert.equal(empty.action, 'flag');
  assert.match(empty.flagged[0].reasons[0], /Tasks/);
});

test('split round text: no commit step, ends with the done line', () => {
  const text = view.splitRoundText('synthesis', 'Split these tasks. Commit the change.');
  assert.doesNotMatch(text, /Commit the change/);
  assert.match(text, /LunaCore commits it for you/);
  assert.match(text, /LUNA_DONE synthesis`\.$/);
});

// ---------------------------------------------------------------------------
// Restore after a restart
// ---------------------------------------------------------------------------

test('stored package flag: absent stays absent, unreadable fails closed', () => {
  assert.equal(view.normalizeStoredPlanRunFlag(undefined), undefined);
  assert.equal(view.normalizeStoredPlanRunFlag(null), undefined);
  assert.deepEqual(view.normalizeStoredPlanRunFlag('x'), {});
  assert.deepEqual(view.normalizeStoredPlanRunFlag([1]), {});
  const flag = { runSlug: SLUG, role: 'topic', topic: 'auth-flow', outputPath: `docs/plans/${SLUG}/auth-flow.md`, extra: 1 };
  assert.deepEqual(view.normalizeStoredPlanRunFlag(flag), { runSlug: SLUG, role: 'topic', topic: 'auth-flow', outputPath: flag.outputPath });
  // An empty flag never passes the core's plan-run check: the guard stalls it.
  assert.equal(core.isPlanRunPackage({ planRun: view.normalizeStoredPlanRunFlag('x') }), false);
});

test('stored plan-run block: validated, capped, unknown fields dropped', () => {
  assert.equal(view.normalizeStoredPlanRun(null), null);
  assert.equal(view.normalizeStoredPlanRun({ runSlug: 'Bad Slug' }), null);
  const raw = {
    runSlug: SLUG,
    request: 'r'.repeat(25000),
    planner: 'evil',
    topics: [...TOPICS, { slug: 'plan', question: 'reserved' }],
    saved: ['auth-flow', '../x', 42],
    flagged: [{ index: 1, text: 'T', reasons: ['a', 3] }, { index: 'x', text: 'bad' }],
    hacked: true,
  };
  const res = view.normalizeStoredPlanRun(raw);
  assert.equal(res.request.length, 20000);
  assert.equal(res.planner, 'claude');
  assert.deepEqual(res.topics, TOPICS);
  assert.deepEqual(res.saved, ['auth-flow']);
  assert.deepEqual(res.flagged, [{ index: 1, text: 'T', reasons: ['a'] }]);
  assert.equal('hacked' in res, false);
});
