// ============================================================================
// Luna's Work run-end git hygiene (src/lunasworkRunCleanup.js) against a real
// temp repo with a bare origin. Covers: the run's worktrees are removed and
// its merged (and merged-then-rolled-back) branches deleted locally and on
// origin; a branch with unmerged work is kept and named in the run report;
// a worktree with an open tab stays; a luna/ branch the run never used is
// not touched; uncommitted LunaCore files in the checkout are reported; and
// nothing is removed while God Mode has a plan open on the project.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { createRunCleanup, runBranchesOf, withRunBranches, porcelainPaths, cleanupSection, MAX_RUN_BRANCHES } = require('../src/lunasworkRunCleanup');
const { buildRunReport, renderRunReportHtml } = require('../src/lunasworkReport');

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const exists = (cwd, ref) => {
  try {
    git(cwd, 'rev-parse', '--verify', '--quiet', ref);
    return true;
  } catch {
    return false;
  }
};

function makeRepo(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lw-rc-'));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true, maxRetries: 5 }).catch(() => {}));
  const origin = path.join(root, 'origin.git');
  const repo = path.join(root, 'game');
  git(root, 'init', '-q', '--bare', origin);
  git(root, 'clone', '-q', origin, repo);
  git(repo, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  git(repo, 'config', 'user.name', 'Luna Test');
  git(repo, 'config', 'user.email', 'luna@example.test');
  git(repo, 'config', 'commit.gpgsign', 'false');
  fs.mkdirSync(path.join(repo, 'design'));
  fs.writeFileSync(path.join(repo, 'design', 'DESIGN.md'), '# Design\n');
  fs.writeFileSync(path.join(repo, 'app.txt'), 'v1\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'initial');
  git(repo, 'push', '-q', 'origin', 'HEAD:refs/heads/main');
  return { root, origin, repo };
}

/** A God Mode package: its own worktree + luna/ branch with one commit; optionally pushed, merged, rolled back. */
function pkg(repo, root, name, { push = false, merge = false, rollBack = false } = {}) {
  const branch = `luna/${name}-abcde`;
  const wt = path.join(root, 'wts', name);
  git(repo, 'worktree', 'add', '-q', '-b', branch, wt, 'main');
  fs.writeFileSync(path.join(wt, `${name}.txt`), `${name}\n`);
  git(wt, 'add', '-A');
  git(wt, 'commit', '-q', '-m', `feat: ${name}`);
  if (push) git(wt, 'push', '-q', 'origin', `${branch}:refs/heads/${branch}`);
  if (merge) {
    git(repo, 'merge', '-q', '--no-ff', '-m', `Merge package ${name}`, branch);
    git(repo, 'push', '-q', 'origin', 'HEAD:refs/heads/main');
  }
  if (rollBack) {
    git(repo, 'revert', '--no-edit', '-m', '1', 'HEAD');
    git(repo, 'push', '-q', 'origin', 'HEAD:refs/heads/main');
  }
  return { branch, wt };
}

test('run end: worktrees removed, merged and rolled-back branches deleted, unmerged work kept and reported', async (t) => {
  const { root, origin, repo } = makeRepo(t);
  const merged = pkg(repo, root, 'merged', { push: true, merge: true });
  const rolled = pkg(repo, root, 'rolled', { push: true, merge: true, rollBack: true });
  const red = pkg(repo, root, 'red', { push: true });
  const open = pkg(repo, root, 'open', { merge: true });
  const foreign = pkg(repo, root, 'mati', { merge: true });
  // What LunaCore wrote into the checkout and never committed.
  fs.writeFileSync(path.join(repo, 'design', 'CONTRACTS.md'), '# Contracts\n');
  fs.writeFileSync(path.join(repo, '.gitattributes'), '*.unity merge=unityyamlmerge\n');

  const logs = [];
  const cleanup = createRunCleanup({ inUse: (root2) => path.resolve(root2) === path.resolve(open.wt), log: (l) => logs.push(l) });
  const run = { id: 'lwrc1', projectId: 'game', repoPath: repo, branches: [merged.branch, rolled.branch, red.branch, open.branch] };
  const res = await cleanup.atRunEnd(run);
  assert.equal(res.ok, true, JSON.stringify(res));

  // Worktrees: the run's go, the one with an open tab and Mati's own stay.
  for (const w of [merged, rolled, red]) assert.equal(fs.existsSync(w.wt), false, `${w.branch} worktree removed`);
  assert.ok(fs.existsSync(open.wt));
  assert.ok(fs.existsSync(foreign.wt), 'a branch the run never used is not touched');
  assert.equal(res.worktrees.removed.length, 3);
  assert.deepEqual(res.worktrees.kept.map((w) => [w.branch, w.reason]), [[open.branch, 'openTab']]);

  // Branches: merged and rolled back go (local + origin), unmerged work stays on both.
  assert.deepEqual(res.branches.deleted.sort(), [merged.branch, rolled.branch].sort());
  assert.deepEqual(res.remote.deleted.sort(), [merged.branch, rolled.branch].sort());
  for (const b of [merged.branch, rolled.branch]) {
    assert.equal(exists(repo, `refs/heads/${b}`), false);
    assert.equal(exists(origin, `refs/heads/${b}`), false);
  }
  assert.ok(exists(repo, `refs/heads/${red.branch}`) && exists(origin, `refs/heads/${red.branch}`), 'unmerged work kept');
  assert.ok(exists(repo, `refs/heads/${foreign.branch}`));
  assert.deepEqual(res.branches.kept.map((k) => [k.branch, k.reason]).sort(), [[open.branch, 'checkedOut'], [red.branch, 'notMerged']].sort());
  assert.deepEqual(res.remote.kept, [{ branch: red.branch, reason: 'notMerged' }]);

  // Uncommitted LunaCore files are logged and reported.
  assert.deepEqual(res.files.sort(), ['.gitattributes', 'design/CONTRACTS.md']);
  assert.ok(logs.some((l) => /left uncommitted LunaCore files in the checkout: .*design\/CONTRACTS\.md/.test(l)), logs.join('\n'));

  // The run report names the kept branches and why.
  const ended = { id: 'lwrc1', verdict: 'stop', repoPath: repo, laps: [], history: [], gitCleanup: res };
  const md = buildRunReport(ended, { now: 0 });
  assert.match(md, /## Branches and worktrees/);
  assert.match(md, /Removed 3 worktree\(s\); deleted 2 local and 2 origin branch\(es\)/);
  assert.match(md, /- Kept luna\/red-abcde \(local \+ origin\): unmerged work/);
  assert.match(md, /- Kept luna\/open-abcde \(local\): its worktree is still there/);
  assert.match(md, /- Worktree kept: .*open \(luna\/open-abcde\): a tab is open in it/);
  assert.match(md, /- Uncommitted in the checkout: design\/CONTRACTS\.md/);
  assert.ok(!buildRunReport(ended, { now: 0, forEmail: true }).includes(open.wt), 'no local path in the email');
  const html = renderRunReportHtml(ended, { now: 0 });
  assert.match(html, /Kept luna\/red-abcde \(local \+ origin\): unmerged work/);
  assert.match(html, /Worktree kept: open \(luna\/open-abcde\)/);
  assert.ok(!html.includes(path.join(root, 'wts')), 'the HTML is an email attachment too: no local path');
  assert.ok(logs.some((l) => /cleanup: 3 worktree\(s\) removed, 2 local \+ 2 origin branch\(es\) deleted, kept luna\//.test(l)), logs.join('\n'));
});

test('run end: nothing is removed while God Mode has a plan open on the project', async (t) => {
  const { root, repo } = makeRepo(t);
  const merged = pkg(repo, root, 'merged', { merge: true });
  const cleanup = createRunCleanup({ inUse: () => false, busy: (run) => run.projectId === 'game' });
  const res = await cleanup.atRunEnd({ id: 'lwrc2', projectId: 'game', repoPath: repo, branches: [merged.branch] });
  assert.equal(res.ok, true);
  assert.ok(fs.existsSync(merged.wt));
  assert.ok(exists(repo, `refs/heads/${merged.branch}`));
  assert.deepEqual(res.branches.kept, [{ branch: merged.branch, reason: 'godModeBusy' }]);
  assert.match(cleanupSection(res).items[0], /God Mode had a plan open/);
});

test('run end: without an open-tab check no worktree is removed; no branches or no repo is a no-op', async (t) => {
  const { root, repo } = makeRepo(t);
  const merged = pkg(repo, root, 'merged', { merge: true });
  const res = await createRunCleanup().atRunEnd({ id: 'lwrc3', repoPath: repo, branches: [merged.branch] });
  assert.ok(fs.existsSync(merged.wt));
  assert.deepEqual(res.worktrees.kept.map((w) => w.reason), ['openTab']);

  const none = await createRunCleanup({ inUse: () => false }).atRunEnd({ id: 'lwrc3', repoPath: repo, branches: [] });
  assert.equal(none.ok, true);
  assert.equal(cleanupSection(none), null, 'a clean run adds no report section');
  assert.deepEqual((await createRunCleanup().atRunEnd({ id: 'x', repoPath: 'relative' })).error, 'noRepo');
  assert.equal(cleanupSection(null), null);
});

test('runBranchesOf + withRunBranches: package and red integration branches, luna/ only, each once, capped', () => {
  const build = {
    plan: { packages: [{ id: 'a', branch: 'luna/a-abcde' }, { id: 'b', branch: null }, { id: 'c', branch: 'feature/x' }, null] },
    integration: { selfCheck: { pushedIntegrationBranch: 'luna/run-integration' } },
  };
  assert.deepEqual(runBranchesOf(build), ['luna/a-abcde', 'luna/run-integration']);
  assert.deepEqual(runBranchesOf(null), []);
  assert.deepEqual(withRunBranches(['luna/a-abcde', 7, '../x'], ['luna/a-abcde', 'luna/b-abcde']), ['luna/a-abcde', 'luna/b-abcde']);
  const many = Array.from({ length: MAX_RUN_BRANCHES + 5 }, (_, i) => `luna/p${i}-abcde`);
  const capped = withRunBranches(many);
  assert.equal(capped.length, MAX_RUN_BRANCHES);
  assert.equal(capped[capped.length - 1], many[many.length - 1], 'the newest are kept');
  assert.deepEqual(porcelainPaths(' M design/ASSETS.md\n?? design/CONTRACTS.md\nR  a.md -> design/b.md\n'), ['design/ASSETS.md', 'design/CONTRACTS.md', 'design/b.md']);
});
