// ============================================================================
// God Mode "never blocks": self-healing dependency merge at launch (card 1)
// and an integration that skips bad packages instead of stopping (card 2).
// Git, the resolver and verify are faked; nothing touches a real repo.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

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

// ---- card 2: ensureInstall -----------------------------------------------------

function tempRepo(layout) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-integ-'));
  for (const rel of layout) {
    const full = path.join(root, rel);
    if (rel.endsWith('/')) fs.mkdirSync(full, { recursive: true });
    else {
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, '{}');
    }
  }
  return root;
}

test('ensureInstall: npm ci at the root and in direct subfolders with a lockfile and no node_modules', async () => {
  const root = tempRepo([
    'package-lock.json',
    'mobile/package-lock.json',
    'done/package-lock.json',
    'done/node_modules/',
    '.hidden/package-lock.json',
    'docs/readme.md',
    'deep/inner/package-lock.json',
  ]);
  try {
    const ran = [];
    const res = await integ.ensureInstall(root, async (cmd, cwd) => (ran.push([cmd, path.relative(root, cwd)]), { ok: true, output: '' }));
    assert.equal(res.ok, true);
    assert.deepEqual(ran, [
      ['npm ci', ''],
      ['npm ci', 'mobile'],
    ]);

    const failing = await integ.ensureInstall(root, async (_cmd, cwd) =>
      cwd === root ? { ok: true, output: '' } : { ok: false, output: 'ERR! lock mismatch' },
    );
    assert.equal(failing.ok, false);
    assert.match(failing.output.split('\n').pop(), /mobile/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  // node_modules itself is never treated as a subproject.
  const installed = tempRepo(['package-lock.json', 'node_modules/package-lock.json']);
  try {
    const ran = [];
    await integ.ensureInstall(installed, async (cmd, cwd) => (ran.push(cwd), { ok: true, output: '' }));
    assert.deepEqual(ran, []);
  } finally {
    fs.rmSync(installed, { recursive: true, force: true });
  }
});

test('ensureInstall: a missing root folder never throws', async () => {
  const res = await integ.ensureInstall(path.join(os.tmpdir(), 'luna-integ-missing-xyz'), async () => ({ ok: true, output: '' }));
  assert.equal(res.ok, true);
});

// ---- card 2: integrateMerge never stops at the first failure ---------------------

const WT = { ok: true, root: '/wt/int', cwd: '/wt/int', branch: 'luna/p-integration' };

function integDeps(git, { verify, resolve, beforePush } = {}) {
  const removed = [];
  const resolves = [];
  return {
    removed,
    resolves,
    deps: {
      execImpl: git.execImpl,
      addWorktree: async (_r, _n, opts) => ({ ...WT, base: opts.base }),
      removeWorktree: async (_r, root) => removed.push(root),
      resolve: async (r) => (resolves.push(r), resolve ? resolve(r) : { ok: true }),
      verifyImpl: verify || (async () => ({ ok: true, output: '' })),
      installImpl: async () => ({ ok: true }),
      ...(beforePush ? { beforePush } : {}),
    },
  };
}

const args = (packages) => ({ repoPath: '/r', base: 'main', slug: 'p', packages });

test('integrateMerge: a red package is reset away and skipped, its dependents too, the rest is pushed', async () => {
  const git = fakeExec({ 'rev-parse': { ok: true, stdout: 'sha1\n' } });
  const verify = async (cmd) => (cmd === 'red' ? { ok: false, output: 'FAIL x' } : { ok: true, output: '' });
  const { deps, removed } = integDeps(git, { verify });
  const res = await integ.integrateMerge(
    args([
      { id: 'a', branch: 'luna/a', verify: 'red', dependsOn: [] },
      { id: 'b', branch: 'luna/b', verify: 'green', dependsOn: [] },
      { id: 'c', branch: 'luna/c', verify: 'green', dependsOn: ['a'] },
      { id: 'd', branch: 'luna/d', verify: '', dependsOn: ['c'] },
    ]),
    deps,
  );
  assert.equal(res.ok, true);
  assert.deepEqual(res.merged, ['b']);
  assert.deepEqual(res.skipped, [
    { id: 'a', stage: 'verify', detail: 'FAIL x', files: [] },
    { id: 'c', stage: 'depSkipped', detail: 'a', files: [] },
    { id: 'd', stage: 'depSkipped', detail: 'c', files: [] },
  ]);
  assert.ok(git.calls.includes('git reset --hard sha1'));
  assert.ok(!git.calls.some((c) => c.endsWith('refs/heads/luna/c')), 'a dependent of a skipped package is never merged');
  assert.ok(git.calls.includes('git push origin HEAD:refs/heads/main'));
  assert.deepEqual(removed, ['/wt/int']);
});

test('integrateMerge: a verify that passes on the re-run counts as green', async () => {
  const git = fakeExec({ 'rev-parse': { ok: true, stdout: 'sha1\n' } });
  let runs = 0;
  const { deps } = integDeps(git, {
    verify: async () => ((runs += 1), runs === 1 ? { ok: false, output: 'flaky' } : { ok: true, output: '' }),
  });
  const res = await integ.integrateMerge(args([{ id: 'a', branch: 'luna/a', verify: 'npm test' }]), deps);
  assert.equal(res.ok, true);
  assert.deepEqual(res.merged, ['a']);
  assert.deepEqual(res.skipped, []);
  assert.equal(runs, 2);
  assert.ok(!git.calls.some((c) => c.startsWith('git reset')));
});

test('integrateMerge: an unresolved conflict gets one stronger resolver attempt, then is skipped with its files', async () => {
  const git = fakeExec({
    'rev-parse': { ok: true, stdout: 'sha1\n' },
    // a: conflict + abort, retry conflict + abort; b: clean
    merge: [{ ok: false }, { ok: true }, { ok: false }, { ok: true }, { ok: true }],
    diff: [{ ok: true, stdout: 'src/x.js\n' }, { ok: true, stdout: 'src/x.js\n' }, { ok: true, stdout: '' }],
  });
  const { deps, resolves } = integDeps(git, { resolve: async () => ({ ok: false }) });
  const res = await integ.integrateMerge(
    args([
      { id: 'a', branch: 'luna/a', verify: '' },
      { id: 'b', branch: 'luna/b', verify: '' },
    ]),
    deps,
  );
  assert.equal(res.ok, true);
  assert.deepEqual(res.merged, ['b']);
  assert.deepEqual(res.skipped, [{ id: 'a', stage: 'conflict', detail: 'src/x.js', files: ['src/x.js'] }]);
  assert.deepEqual(
    resolves.map((r) => r.attempt),
    [undefined, 2],
  );
});

test('integrateMerge: nothing merged fails with nothingMerged and pushes nothing', async () => {
  const git = fakeExec({ 'rev-parse': { ok: true, stdout: 'sha1\n' } });
  const { deps, removed } = integDeps(git, { verify: async () => ({ ok: false, output: 'red' }) });
  const res = await integ.integrateMerge(args([{ id: 'a', branch: 'luna/a', verify: 'npm test' }]), deps);
  assert.equal(res.ok, false);
  assert.equal(res.stage, 'nothingMerged');
  assert.equal(res.skipped.length, 1);
  assert.ok(!git.calls.some((c) => c.startsWith('git push')));
  assert.deepEqual(removed, [], 'failed integration worktree kept');
});

test('integrateMerge: beforePush sees merged + skipped and can stop the push', async () => {
  const git = fakeExec({ 'rev-parse': { ok: true, stdout: 'sha1\n' } });
  const seen = [];
  const { deps, removed } = integDeps(git, {
    beforePush: async (root, info) => (seen.push([root, info]), { ok: false, reason: 'self-check red' }),
  });
  const res = await integ.integrateMerge(args([{ id: 'a', branch: 'luna/a', verify: '' }]), deps);
  assert.deepEqual(seen, [['/wt/int', { merged: ['a'], skipped: [] }]]);
  assert.equal(res.ok, false);
  assert.equal(res.stage, 'beforePush');
  assert.equal(res.detail, 'self-check red');
  assert.ok(!git.calls.some((c) => c.startsWith('git push')));
  assert.deepEqual(removed, []);

  const git2 = fakeExec({ 'rev-parse': { ok: true, stdout: 'sha1\n' } });
  const thrower = integDeps(git2, {
    beforePush: async () => {
      throw new Error('x');
    },
  });
  const res2 = await integ.integrateMerge(args([{ id: 'a', branch: 'luna/a', verify: '' }]), thrower.deps);
  assert.equal(res2.ok, false, 'a throwing gate never pushes');
  assert.ok(!git2.calls.some((c) => c.startsWith('git push')));

  const git3 = fakeExec({ 'rev-parse': { ok: true, stdout: 'sha1\n' } });
  const okGate = integDeps(git3, { beforePush: async () => ({ ok: true }) });
  assert.equal((await integ.integrateMerge(args([{ id: 'a', branch: 'luna/a', verify: '' }]), okGate.deps)).ok, true);
  assert.ok(git3.calls.includes('git push origin HEAD:refs/heads/main'));
});

test('runResolver: attempt 2 triples the budget and doubles the timeout', async () => {
  const seen = [];
  const execImpl = (bin, argv, opts, cb) => {
    seen.push({ argv, timeout: opts.timeout });
    setImmediate(() => cb(null, '', ''));
    return { stdin: { on() {}, end() {} } };
  };
  await integ.runResolver({ cwd: '/wt', branch: 'luna/a', files: ['a.js'], isDirImpl: () => true }, execImpl);
  await integ.runResolver({ cwd: '/wt', branch: 'luna/a', files: ['a.js'], isDirImpl: () => true, attempt: 2 }, execImpl);
  const budget = (a) => Number(a[a.indexOf('--max-budget-usd') + 1]);
  assert.equal(budget(seen[1].argv), budget(seen[0].argv) * 3);
  assert.equal(seen[1].timeout, seen[0].timeout * 2);
});

// ---- card 2: stored integration ------------------------------------------------

test('normalizeStoredPlan: integration.skipped capped and validated, partial is a boolean', () => {
  const base = { id: 'p1', repoPath: '/r', packages: [{ id: 'a' }] };
  const many = Array.from({ length: 60 }, (_, i) => ({
    id: `p${i}`,
    stage: 'verify',
    detail: 'x'.repeat(1000),
    files: Array.from({ length: 15 }, (_, j) => `src/f${j}.js`),
  }));
  const stored = sup.normalizeStoredPlan({
    ...base,
    integration: { state: 'done', partial: true, skipped: [null, { id: 'BAD ID' }, 'x', ...many] },
  }).integration;
  assert.equal(stored.partial, true);
  assert.equal(stored.skipped.length, 50);
  assert.equal(stored.skipped[0].id, 'p0');
  assert.equal(stored.skipped[0].files.length, 10);
  assert.ok(stored.skipped[0].detail.length <= 300);
  const legacy = sup.normalizeStoredPlan(base).integration;
  assert.deepEqual([legacy.skipped, legacy.partial], [[], false]);
  const junk = sup.normalizeStoredPlan({ ...base, integration: { skipped: 'nope', partial: 'yes' } }).integration;
  assert.deepEqual([junk.skipped, junk.partial], [[], false]);
});
