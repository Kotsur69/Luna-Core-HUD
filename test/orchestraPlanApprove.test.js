// ============================================================================
// Free God Mode v2 F4a - "Approve plan" (src/orchestraPlanApprove.js) on a
// real throw-away git repo: merge into the base, to-dos imported once,
// refusals for paths outside docs/plans/<slug>/, a conflict, the wrong
// checkout - and nothing changed when refused.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { approveTarget, createPlanApprover, outsidePaths } = require('../src/orchestraPlanApprove.js');

const SLUG = 'demo-plan-ab12cd';
const BRANCH = 'luna-plan/synthesis-x1';
const PLAN_MD = ['# Plan', '## Tasks', '- [ ] First task', '  - Acceptance: `npm test`', '- [x] Done task', '- [ ] Second task', ''].join('\n');

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Luna Test',
  GIT_AUTHOR_EMAIL: 'luna@example.invalid',
  GIT_COMMITTER_NAME: 'Luna Test',
  GIT_COMMITTER_EMAIL: 'luna@example.invalid',
};

function git(repo, ...args) {
  return execFileSync('git', ['-C', repo, '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...args], {
    env: GIT_ENV,
    encoding: 'utf8',
    windowsHide: true,
  });
}

function write(repo, rel, text) {
  const abs = path.join(repo, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text);
}

/** A repo on `main` with one commit and a plan branch adding the plan folder (+ extra files). */
function makeRepo(t, { extra = {} } = {}) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-approve-'));
  t.after(() => fs.promises.rm(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  git(repo, 'init', '-q', '-b', 'main');
  // Repo-level, so the code under test (plain `git`) sees the same line endings.
  git(repo, 'config', 'core.autocrlf', 'false');
  write(repo, 'README.md', 'hello\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'init');
  git(repo, 'checkout', '-q', '-b', BRANCH);
  write(repo, `docs/plans/${SLUG}/PLAN.md`, PLAN_MD);
  write(repo, `docs/plans/${SLUG}/story.md`, '# Story\n');
  for (const [rel, text] of Object.entries(extra)) write(repo, rel, text);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'plan docs');
  git(repo, 'checkout', '-q', 'main');
  return repo;
}

const view = (over = {}) => ({
  id: 'p1',
  baseBranch: 'main',
  planRun: { runSlug: SLUG, ready: true, docs: [{ id: 'synthesis', file: 'PLAN.md', branch: BRANCH }] },
  ...over,
});

function approver() {
  const store = { list: [{ text: 'mine', done: false, at: 1 }], writes: 0, changed: 0 };
  const approve = createPlanApprover({
    readTodos: () => store.list,
    writeTodos: (_id, list) => {
      store.list = list;
      store.writes += 1;
      return true;
    },
    onTodosChanged: () => {
      store.changed += 1;
    },
    now: () => 1000,
  });
  return { approve, store };
}

test('approveTarget: only a ready plan run with PLAN.md on a safe luna-plan/ branch', () => {
  assert.deepEqual(approveTarget(view()), { ok: true, runSlug: SLUG, branch: BRANCH, base: 'main' });
  assert.equal(approveTarget({ id: 'x' }).error, 'notPlanRun');
  assert.equal(approveTarget(view({ planRun: { ...view().planRun, ready: false } })).error, 'notReady');
  assert.equal(approveTarget(view({ planRun: { ...view().planRun, docs: [] } })).error, 'noPlanDoc');
  assert.equal(approveTarget(view({ baseBranch: null })).error, 'noBase');
  const bad = (branch) => approveTarget(view({ planRun: { ...view().planRun, docs: [{ id: 's', file: 'PLAN.md', branch }] } })).error;
  assert.equal(bad('main'), 'unsafeBranch');
  assert.equal(bad('luna/feature'), 'unsafeBranch');
  assert.equal(bad('luna-plan/../main'), 'unsafeBranch');
});

test('outsidePaths keeps only paths outside docs/plans/<slug>/', () => {
  const z = [`docs/plans/${SLUG}/PLAN.md`, 'src/app.js', 'docs/plans/other/PLAN.md'].join('\0');
  assert.deepEqual(outsidePaths(z, SLUG), ['src/app.js', 'docs/plans/other/PLAN.md']);
});

test('approve merges the plan into main and imports unchecked tasks; approving twice adds nothing', async (t) => {
  const repo = makeRepo(t);
  const { approve, store } = approver();
  const res = await approve({ projectId: 'p', repoPath: repo, view: view() });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.deepEqual([res.alreadyMerged, res.created, res.skipped, res.checked], [false, 2, 0, 1]);
  assert.ok(fs.existsSync(path.join(repo, 'docs', 'plans', SLUG, 'PLAN.md')), 'PLAN.md is on main now');
  assert.match(git(repo, 'log', '-1', '--format=%s'), new RegExp(`approve plan ${SLUG}`));
  assert.deepEqual(store.list.map((x) => x.text), ['mine', 'First task', 'Second task']);
  assert.equal(store.changed, 1);

  const again = await approve({ projectId: 'p', repoPath: repo, view: view() });
  assert.deepEqual([again.ok, again.alreadyMerged, again.created, again.skipped], [true, true, 0, 2]);
  assert.equal(store.list.length, 3, 'no duplicates');
  assert.equal(store.writes, 1, 'nothing new to write');
});

test('a plan branch that touches anything outside its folder is refused and nothing is merged', async (t) => {
  const repo = makeRepo(t, { extra: { 'src/app.js': 'evil()\n' } });
  const head = git(repo, 'rev-parse', 'HEAD');
  const { approve, store } = approver();
  const res = await approve({ projectId: 'p', repoPath: repo, view: view() });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'outsidePlanFolder');
  assert.deepEqual(res.outside, ['src/app.js']);
  assert.equal(git(repo, 'rev-parse', 'HEAD'), head, 'main did not move');
  assert.equal(store.writes, 0, 'no to-dos');
});

test('a merge conflict is aborted and refused; the checkout stays clean', async (t) => {
  const repo = makeRepo(t);
  write(repo, `docs/plans/${SLUG}/PLAN.md`, '# A different plan on main\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'conflicting plan');
  const head = git(repo, 'rev-parse', 'HEAD');
  const { approve, store } = approver();
  const res = await approve({ projectId: 'p', repoPath: repo, view: view() });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'mergeConflict');
  assert.equal(git(repo, 'rev-parse', 'HEAD'), head);
  assert.equal(git(repo, 'status', '--porcelain'), '', 'merge aborted, nothing left behind');
  assert.equal(store.writes, 0);
});

test('a checkout on another branch is refused (the merge would land elsewhere)', async (t) => {
  const repo = makeRepo(t);
  git(repo, 'checkout', '-q', '-b', 'feature');
  const { approve } = approver();
  const res = await approve({ projectId: 'p', repoPath: repo, view: view() });
  assert.deepEqual([res.ok, res.error, res.detail], [false, 'notOnBase', 'feature']);
});

test("a merge the user has in progress is never merged over or aborted", async (t) => {
  const repo = makeRepo(t);
  git(repo, 'checkout', '-q', '-b', 'side');
  write(repo, 'README.md', 'side\n');
  git(repo, 'commit', '-q', '-am', 'side');
  git(repo, 'checkout', '-q', 'main');
  write(repo, 'README.md', 'main\n');
  git(repo, 'commit', '-q', '-am', 'main');
  assert.throws(() => git(repo, 'merge', '-q', 'side'), 'the user merge conflicts and stays in progress');
  const { approve, store } = approver();
  const res = await approve({ projectId: 'p', repoPath: repo, view: view() });
  assert.deepEqual([res.ok, res.error], [false, 'mergeInProgress']);
  assert.ok(fs.existsSync(path.join(repo, '.git', 'MERGE_HEAD')), "the user's merge is still there");
  assert.equal(store.writes, 0);
});
