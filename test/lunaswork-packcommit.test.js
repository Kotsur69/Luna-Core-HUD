// ============================================================================
// Luna's Work: committing the design pack (src/lunasworkPackCommit.js) against
// a real temp git repo with a local bare origin. Covers: design files the
// Critic wrote are committed and pushed, only those files are staged even with
// other dirty / staged / untracked files around, no commit when design/ is
// unchanged, a failed push is reported (not thrown) and retried, the
// checkpoint tag holds the pack commit, and a rollback keeps pack commits.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { commitDesignPack, isPackCommitSubject } = require('../src/lunasworkPackCommit');
const { createCheckpoints } = require('../src/lunasworkCheckpoint');

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const write = (repo, rel, text) => {
  fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
  fs.writeFileSync(path.join(repo, rel), text);
};

function makeRepo(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lw-pc-'));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true, maxRetries: 5 }).catch(() => {}));
  const origin = path.join(root, 'origin.git');
  const repo = path.join(root, 'repo');
  git(root, 'init', '--bare', origin);
  git(root, 'clone', origin, repo);
  git(repo, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  git(repo, 'config', 'user.name', 'Luna Test');
  git(repo, 'config', 'user.email', 'luna@example.test');
  git(repo, 'config', 'commit.gpgsign', 'false');
  write(repo, 'app.txt', 'v1\n');
  write(repo, 'design/PLAYTEST_LOG.md', '# Log\n');
  write(repo, 'design/ARCHITECTURE.md', '# Arch v0\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-m', 'initial');
  git(repo, 'push', 'origin', 'HEAD:refs/heads/main');
  return { root, origin, repo };
}

const originFile = (origin, rel) => git(origin, 'show', `main:${rel}`);

test('commits and pushes the design files the Critic wrote', async (t) => {
  const { origin, repo } = makeRepo(t);
  write(repo, 'design/PLAYTEST_LOG.md', '# Log\n## Iteration 1\nall good\n');
  write(repo, 'design/ARCHITECTURE.md', '# Arch v1\n');
  const res = await commitDesignPack({ repoPath: repo, label: 'iteration 1 design pack' });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.committed, true);
  assert.equal(res.pushed, true);
  assert.equal(git(repo, 'status', '--porcelain', '--', 'design'), '');
  assert.match(originFile(origin, 'design/PLAYTEST_LOG.md'), /Iteration 1/);
  assert.match(originFile(origin, 'design/ARCHITECTURE.md'), /Arch v1/);
  const subject = git(origin, 'log', '-1', '--format=%s', 'main');
  assert.equal(subject, 'docs(luna-work): iteration 1 design pack');
  assert.ok(isPackCommitSubject(subject));
});

test('stages only design pack files, even with other dirty, staged and untracked files', async (t) => {
  const { origin, repo } = makeRepo(t);
  write(repo, 'design/DECISIONS.md', '# Decisions\n- x\n');
  write(repo, 'app.txt', 'v2 dirty\n');
  write(repo, 'notes.txt', 'untracked\n');
  write(repo, 'staged.txt', 'staged by someone\n');
  git(repo, 'add', 'staged.txt');
  const res = await commitDesignPack({ repoPath: repo, label: 'iteration 2 design pack' });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.deepEqual(res.files, ['design/DECISIONS.md']);
  assert.deepEqual(git(repo, 'show', '--name-only', '--format=', 'HEAD').split('\n'), ['design/DECISIONS.md']);
  const status = git(repo, 'status', '--porcelain').split('\n').map((l) => l.trim()).sort();
  assert.deepEqual(status, ['?? notes.txt', 'A  staged.txt', 'M app.txt'].sort());
  assert.equal(git(origin, 'show', 'main:app.txt'), 'v1');
});

test('no commit when design/ is unchanged', async (t) => {
  const { repo } = makeRepo(t);
  write(repo, 'app.txt', 'dirty but not design\n');
  const before = git(repo, 'rev-parse', 'HEAD');
  const res = await commitDesignPack({ repoPath: repo, label: 'x' });
  assert.equal(res.ok, true);
  assert.equal(res.committed, false);
  assert.equal(git(repo, 'rev-parse', 'HEAD'), before);
});

test('a failed push is reported, not thrown, and retried on the next call', async (t) => {
  const { origin, repo } = makeRepo(t);
  git(repo, 'remote', 'set-url', 'origin', path.join(path.dirname(origin), 'missing.git'));
  write(repo, 'design/PLAYTEST_LOG.md', '# Log\nentry\n');
  const res = await commitDesignPack({ repoPath: repo, label: 'iteration 3 design pack' });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'pushFailed');
  assert.equal(res.committed, true);
  git(repo, 'remote', 'set-url', 'origin', origin);
  const retry = await commitDesignPack({ repoPath: repo, label: 'iteration 3 design pack' });
  assert.equal(retry.ok, true);
  assert.equal(retry.pushed, true);
  assert.match(originFile(origin, 'design/PLAYTEST_LOG.md'), /entry/);
});

test('a failed commit comes back as an error, never a throw', async () => {
  const fake = async (cwd, args) => {
    if (args[0] === 'rev-parse') return { ok: true, out: 'main', err: '' };
    if (args[0] === 'status') return { ok: true, out: '?? design/DECISIONS.md', err: '' };
    if (args[0] === 'commit') return { ok: false, out: '', err: 'hook said no' };
    return { ok: true, out: '', err: '' };
  };
  const res = await commitDesignPack({ repoPath: 'x', git: fake });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'commitFailed');
});

test('the checkpoint tag holds the pack commit and a rollback keeps pack commits', async (t) => {
  const { root, origin, repo } = makeRepo(t);
  const cp = createCheckpoints({ tmpDir: () => root });
  // Iteration 1: code + design pack, then the tag.
  write(repo, 'app.txt', 'v2\n');
  git(repo, 'commit', '-am', 'feat: one');
  write(repo, 'design/PLAYTEST_LOG.md', '# Log\niteration 1\n');
  await commitDesignPack({ repoPath: repo, label: 'iteration 1 design pack' });
  const tagged = await cp.tagIteration({ repoPath: repo, runId: 'lwrun1', iteration: 1 });
  assert.equal(tagged.ok, true, JSON.stringify(tagged));
  assert.equal(git(origin, 'rev-parse', 'refs/tags/luna-work/lwrun1/iter-1^{commit}'), git(origin, 'rev-parse', 'main'));
  assert.match(git(origin, 'show', 'luna-work/lwrun1/iter-1:design/PLAYTEST_LOG.md'), /iteration 1/);
  // Iteration 2: broken code, then the Critic's pack commit, then the rollback.
  write(repo, 'app.txt', 'broken\n');
  git(repo, 'commit', '-am', 'feat: broken');
  write(repo, 'design/PLAYTEST_LOG.md', '# Log\niteration 1\niteration 2 found the break\n');
  await commitDesignPack({ repoPath: repo, label: 'iteration 2 design pack' });
  const res = await cp.rollback({ repoPath: repo, runId: 'lwrun1', iteration: 2, toIteration: 1, reason: 'coreJourneyBroken' });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.reverted.length, 1, 'only the code commit is reverted');
  assert.equal(git(origin, 'show', 'main:app.txt'), 'v2');
  assert.match(git(origin, 'show', 'main:design/PLAYTEST_LOG.md'), /iteration 2 found the break/);
});

test('a commit only named like a pack commit, but touching code, is still reverted', async (t) => {
  const { root, origin, repo } = makeRepo(t);
  const cp = createCheckpoints({ tmpDir: () => root });
  write(repo, 'app.txt', 'v2\n');
  git(repo, 'commit', '-am', 'feat: one');
  git(repo, 'push', 'origin', 'HEAD:refs/heads/main');
  const tagged = await cp.tagIteration({ repoPath: repo, runId: 'lwrun2', iteration: 1 });
  assert.equal(tagged.ok, true, JSON.stringify(tagged));
  // The subject claims "design pack", the diff says code.
  write(repo, 'app.txt', 'broken\n');
  write(repo, 'design/PLAYTEST_LOG.md', '# Log\nforged\n');
  git(repo, 'commit', '-am', 'docs(luna-work): iteration 2 design pack');
  git(repo, 'push', 'origin', 'HEAD:refs/heads/main');
  const res = await cp.rollback({ repoPath: repo, runId: 'lwrun2', iteration: 2, toIteration: 1, reason: 'coreJourneyBroken' });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.reverted.length, 1);
  assert.equal(git(origin, 'show', 'main:app.txt'), 'v2');
});
