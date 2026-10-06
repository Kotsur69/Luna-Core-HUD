// ============================================================================
// God Mode v2 per-worker finish (orchestraFinish.js): commit leftovers, refuse
// an empty branch, verify, push - with git and the verify command faked.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { finishPackage } = require('../src/orchestraFinish.js');

/** Fake execFile for `git -C <root> ...`: answers by subcommand. */
function fakeGit(answers) {
  const calls = [];
  const execImpl = (_bin, args, _opts, cb) => {
    const sub = args.slice(2);
    calls.push(sub.join(' '));
    const a = answers[sub[0]] || { ok: true, stdout: '' };
    setImmediate(() => cb(a.ok ? null : new Error('x'), a.stdout || '', a.stderr || ''));
  };
  return { execImpl, calls };
}

const pkg = { id: 'a', root: '/wt/a', cwd: '/wt/a', branch: 'luna/a-1', baseSha: 'base', verify: 'npm test' };
const passVerify = async () => ({ ok: true, output: '' });

test('clean worktree with commits: verify, push, report HEAD', async () => {
  const git = fakeGit({
    'rev-list': { ok: true, stdout: '2\n' },
    'rev-parse': { ok: true, stdout: 'abc\n' },
    diff: { ok: true, stdout: 'src/x.js\n' },
  });
  const res = await finishPackage(pkg, { execImpl: git.execImpl, verifyImpl: passVerify });
  assert.deepEqual(res, { ok: true, headSha: 'abc', files: ['src/x.js'] });
  assert.ok(git.calls.includes('push -u origin refs/heads/luna/a-1'));
  assert.ok(!git.calls.some((c) => c.startsWith('commit')), 'nothing to commit');
});

test('leftovers are committed as a wip commit before verifying', async () => {
  const git = fakeGit({ status: { ok: true, stdout: ' M src/x.js\n' }, 'rev-list': { ok: true, stdout: '1' } });
  await finishPackage(pkg, { execImpl: git.execImpl, verifyImpl: passVerify });
  assert.ok(git.calls.includes('add -A'));
  assert.ok(git.calls.includes('commit -m chore: luna wip a'));
});

test('no commit past the base is refused before verify or push', async () => {
  let verified = false;
  const git = fakeGit({ 'rev-list': { ok: true, stdout: '0' } });
  const res = await finishPackage(pkg, {
    execImpl: git.execImpl,
    verifyImpl: async () => {
      verified = true;
      return { ok: true, output: '' };
    },
  });
  assert.equal(res.stage, 'noCommits');
  assert.equal(verified, false);
  assert.ok(!git.calls.some((c) => c.startsWith('push')));
});

test('a red verify returns its output and does not push', async () => {
  const git = fakeGit({ 'rev-list': { ok: true, stdout: '1' } });
  const res = await finishPackage(pkg, { execImpl: git.execImpl, verifyImpl: async () => ({ ok: false, output: 'FAIL' }) });
  assert.deepEqual(res, { ok: false, stage: 'verify', output: 'FAIL' });
  assert.ok(!git.calls.some((c) => c.startsWith('push')));
});

test('push failure reports git\'s first stderr line', async () => {
  const git = fakeGit({ 'rev-list': { ok: true, stdout: '1' }, push: { ok: false, stderr: 'fatal: no remote\nmore' } });
  const res = await finishPackage(pkg, { execImpl: git.execImpl, verifyImpl: passVerify });
  assert.deepEqual(res, { ok: false, stage: 'push', detail: 'fatal: no remote' });
});
