// ============================================================================
// God Mode "never blocks": self-healing dependency merge at launch (card 1)
// and an integration that skips bad packages instead of stopping (card 2).
// Git, the resolver and verify are faked; nothing touches a real repo.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const integ = require('../src/orchestraIntegrate.js');
const sup = require('../src/orchestraSupervisor.js');
const { briefText } = require('../src/orchestra.js');

/**
 * Fake execFile: `git -C <dir> <sub> ...` answered by subcommand (a list is
 * consumed in order, the last entry repeats), anything else by bin.
 */
function fakeExec(answers) {
  const calls = [];
  const execImpl = (bin, args, _opts, cb) => {
    const sub = bin === 'git' ? args.slice(2) : args;
    const key = bin === 'git' ? sub[0] : bin;
    calls.push(`${bin} ${sub.join(' ')}`);
    const list = answers[key];
    const a = (Array.isArray(list) ? (list.length > 1 ? list.shift() : list[0]) : list) || { ok: true, stdout: '' };
    setImmediate(() => {
      const err = a.ok ? null : Object.assign(new Error('x'), { code: a.code || 1 });
      cb(err, a.stdout || '', a.stderr || '');
    });
    return { stdin: { on() {}, end() {} } };
  };
  return { execImpl, calls };
}

// ---- card 1: mergeDeps -------------------------------------------------------

test('mergeDeps: clean merges need no resolver and report nothing resolved', async () => {
  const git = fakeExec({});
  let asked = 0;
  const res = await integ.mergeDeps('/wt/c', ['luna/a-1', 'luna/b-1'], {
    execImpl: git.execImpl,
    resolve: async () => ((asked += 1), { ok: true }),
  });
  assert.deepEqual(res, { ok: true, resolved: 0 });
  assert.equal(asked, 0);
  const merges = git.calls.filter((c) => c.startsWith('git merge'));
  assert.deepEqual(merges.map((c) => c.split(' ').pop()), ['refs/heads/luna/a-1', 'refs/heads/luna/b-1']);
});

test('mergeDeps: a conflict goes to the resolver and is committed in the worktree only', async () => {
  const git = fakeExec({
    merge: [{ ok: false, stderr: 'Auto-merging src/x.js' }, { ok: true }],
    diff: [{ ok: true, stdout: 'src/x.js\nsrc/y.js\n' }, { ok: true, stdout: '' }],
    grep: { ok: false },
  });
  const asked = [];
  const res = await integ.mergeDeps('/wt/c', ['luna/b-1'], {
    execImpl: git.execImpl,
    resolve: async (r) => (asked.push(r), { ok: true }),
  });
  assert.deepEqual(res, { ok: true, resolved: 2 });
  assert.deepEqual(asked, [{ cwd: '/wt/c', branch: 'luna/b-1', files: ['src/x.js', 'src/y.js'] }]);
  assert.ok(git.calls.includes('git add -- src/x.js src/y.js'));
  assert.ok(git.calls.includes('git commit --no-edit'));
  // The dependency branch is never checked out, reset, pushed or committed to.
  assert.ok(!git.calls.some((c) => /git (checkout|switch|reset|push|branch|update-ref)/.test(c)));
});

test('mergeDeps: a failed resolver aborts that merge, keeps going, lists branch + repo-relative files', async () => {
  const git = fakeExec({
    // b conflicts, c merges cleanly
    merge: [{ ok: false }, { ok: true }, { ok: true }],
    diff: [{ ok: true, stdout: 'src/lifeipc.js\nsrc/main.js\n' }],
  });
  const res = await integ.mergeDeps('/wt/d', ['luna/b-1', 'luna/c-1'], {
    execImpl: git.execImpl,
    resolve: async () => ({ ok: false, detail: 'budget' }),
  });
  assert.equal(res.ok, false);
  assert.equal(res.stage, 'conflict');
  assert.equal(res.branch, 'luna/b-1');
  assert.deepEqual(res.files, ['src/lifeipc.js', 'src/main.js']);
  assert.deepEqual(res.failed, [{ branch: 'luna/b-1', stage: 'conflict', detail: res.detail, files: res.files }]);
  assert.ok(git.calls.includes('git merge --abort'));
  assert.ok(git.calls.some((c) => c.endsWith('refs/heads/luna/c-1')), 'the next branch is still merged');
  assert.ok(!git.calls.includes('git commit --no-edit'));
});

test('mergeDeps: markers left behind count as a failure; a throwing or missing resolver never throws', async () => {
  const markers = fakeExec({
    merge: { ok: false },
    diff: { ok: true, stdout: 'a.js\n' },
    grep: { ok: true, stdout: 'a.js:3:<<<<<<< HEAD' },
  });
  const res = await integ.mergeDeps('/wt/c', ['luna/b-1'], { execImpl: markers.execImpl, resolve: async () => ({ ok: true }) });
  assert.equal(res.ok, false);
  assert.deepEqual(res.files, ['a.js']);
  assert.ok(markers.calls.includes('git merge --abort'));

  const throws = fakeExec({ merge: { ok: false }, diff: { ok: true, stdout: 'a.js\n' } });
  const res2 = await integ.mergeDeps('/wt/c', ['luna/b-1'], {
    execImpl: throws.execImpl,
    resolve: async () => {
      throw new Error('boom');
    },
  });
  assert.equal(res2.ok, false);
  const none = fakeExec({ merge: { ok: false }, diff: { ok: true, stdout: 'a.js\n' } });
  assert.equal((await integ.mergeDeps('/wt/c', ['luna/b-1'], { execImpl: none.execImpl })).ok, false);
});

// ---- card 1: brief + stored plan ---------------------------------------------

const pkgA = { id: 'c', title: 'C', prompt: 'do c', verify: 'npm test' };

test('briefText: depMerge instructions come first and list only the unmerged branches and files', () => {
  const text = briefText(pkgA, 'luna/c-1', { depMerge: { branches: ['luna/b-1'], files: ['src/x.js'] } });
  const merge = text.indexOf('git merge --no-edit luna/b-1');
  assert.ok(merge > 0);
  assert.ok(merge < text.indexOf('do c'), 'before the task');
  assert.ok(merge < text.indexOf('Package `c`'), 'at the top');
  assert.match(text, /src\/x\.js/);
  assert.match(text, /npm test/);
  assert.match(text, /LUNA_BLOCKED c: dependency merge/);
  assert.equal(briefText(pkgA, 'luna/c-1').includes('git merge'), false, 'no section without depMerge');
});

test('normalizeStoredPlan keeps a well-formed depMerge (capped) and drops a malformed one', () => {
  const base = { id: 'p1', repoPath: '/r' };
  const many = Array.from({ length: 15 }, (_, i) => `luna/b-${i}`);
  const files = Array.from({ length: 15 }, (_, i) => `src/f${i}.js`);
  const load = (depMerge) => sup.normalizeStoredPlan({ ...base, packages: [{ id: 'c', depMerge }] }).packages[0].depMerge;
  const ok = load({ strategy: 'worker', branches: many, files: [...files, '../x', 'C:/abs', 7] });
  assert.equal(ok.strategy, 'worker');
  assert.equal(ok.branches.length, 10);
  assert.equal(ok.files.length, 10);
  assert.ok(ok.files.every((f) => f.startsWith('src/')));
  assert.equal(load(undefined), null);
  assert.equal(load('worker'), null);
  assert.equal(load({ strategy: 'other', branches: ['luna/b-1'], files: [] }), null);
  assert.equal(load({ strategy: 'worker', branches: ['--evil', 'main'], files: [] }), null, 'no valid branch left');
  const legacy = sup.normalizeStoredPlan({ ...base, packages: [{ id: 'c' }] });
  assert.equal(legacy.packages[0].depMerge, null);
});
