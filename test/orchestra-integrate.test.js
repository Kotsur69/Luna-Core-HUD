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
    // a: conflict + abort, retry conflict + abort; b: clean; a on the
    // second pass: conflict + abort again
    merge: [{ ok: false }, { ok: true }, { ok: false }, { ok: true }, { ok: true }, { ok: false }, { ok: true }],
    diff: { ok: true, stdout: 'src/x.js\n' },
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
  assert.deepEqual(res.secondPass, []);
  assert.deepEqual(
    resolves.map((r) => r.attempt),
    [undefined, 2, 2],
    'the second pass goes straight to the stronger resolver',
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
  assert.deepEqual(seen, [['/wt/int', { merged: ['a'], skipped: [], baseSha: 'sha1' }]]);
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

// ---- a red verify names what failed, never a lone `}` ------------------------------

const { verifyDetail } = require('../src/orchestraVerifyDetail.js');

// node --test (spec reporter, Node 24): two failures, the output ends with the
// `}` that closes the last error object - what run pmvqhos4s reported.
const SPEC_RED = [
  '\u2716 adds numbers (4.9ms)',
  '\u2714 passes (0.5ms)',
  '\u2716 loads the adapter (1.2ms)',
  '\u2139 tests 3',
  '\u2139 pass 1',
  '\u2139 fail 2',
  '',
  '\u2716 failing tests:',
  '',
  'test at test\\adapters.test.js:3:1',
  '\u2716 adds numbers (4.9ms)',
  '  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:',
  '',
  '  2 !== 3',
  '',
  '      at TestContext.<anonymous> (C:\\wt\\int\\test\\adapters.test.js:3:37) {',
  "    code: 'ERR_ASSERTION',",
  '    actual: 2,',
  '    expected: 3',
  '  }',
  '',
  'test at test\\adapters.test.js:9:1',
  '\u2716 loads the adapter (1.2ms)',
  "  Error: Cannot find module './tester'",
  '  Require stack:',
  '  - C:\\wt\\int\\src\\adapters.js {',
  "    code: 'MODULE_NOT_FOUND'",
  '  }',
].join('\n');

test('verifyDetail: names the failing tests with their file and the first error, not the trailing `}`', () => {
  const detail = verifyDetail(SPEC_RED, { root: 'C:\\wt\\int' });
  assert.equal(
    detail,
    'failing: adds numbers (test/adapters.test.js), loads the adapter (test/adapters.test.js); ' +
      'AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:',
  );
  assert.notEqual(detail, '}');
});

test("verifyDetail: TAP 'not ok' lines, a whole failing file, and an error with the worktree path cut out", () => {
  const tap = [
    'TAP version 13',
    'not ok 1 - adds numbers',
    '  ---',
    'ok 2 - later # SKIP',
    'not ok 3 - C:\\wt\\int\\test\\b.test.js',
    "Error: ENOENT: no such file or directory, open 'C:\\wt\\int\\data\\x.json'",
    '1..3',
  ].join('\n');
  assert.equal(
    verifyDetail(tap, { root: 'C:\\wt\\int' }),
    "failing: adds numbers, test/b.test.js; Error: ENOENT: no such file or directory, open 'data\\x.json'",
  );
});

test('verifyDetail: conflict markers left in the code are named first, with the file node pointed at', () => {
  const out = ['C:\\wt\\int\\src\\main.js:12', '<<<<<<< HEAD', '^^^^^^^', '', "SyntaxError: Unexpected token '<<'"].join('\n');
  assert.equal(verifyDetail(out, { root: 'C:\\wt\\int' }), "conflict markers left in: src/main.js; SyntaxError: Unexpected token '<<'");
  assert.match(verifyDetail('>>>>>>> luna/b\n}'), /^conflict markers left in: unknown files/);
});

test('verifyDetail: bounded to 5 names and 300 chars; no test lines falls back to the last line that says something', () => {
  const many = Array.from({ length: 9 }, (_, i) => `\u2716 a rather long failing test name number ${i} (1ms)`).join('\n');
  const detail = verifyDetail(`${many}\nTypeError: x is not a function`);
  assert.ok(detail.length <= 300, `${detail.length} chars`);
  assert.ok((detail.match(/number \d/g) || []).length <= 5);
  assert.match(detail, /\(\+\d+ more\)/);
  assert.match(detail, /TypeError: x is not a function$/);
  assert.equal(verifyDetail('FAIL x\n}\n'), 'FAIL x');
  assert.equal(verifyDetail('}'), 'tests failed with no output');
  assert.match(verifyDetail('ok\n[LunaCore: verify timed out]'), /^verify timed out/);
});

test('integrateMerge: a red verify is skipped with the failing tests as its detail', async () => {
  const git = fakeExec({ 'rev-parse': { ok: true, stdout: 'sha1\n' } });
  const { deps } = integDeps(git, { verify: async (cmd) => (cmd === 'red' ? { ok: false, output: SPEC_RED } : { ok: true, output: '' }) });
  const res = await integ.integrateMerge(
    args([
      { id: 'tester-adapters', branch: 'luna/tester-adapters', verify: 'red' },
      { id: 'core', branch: 'luna/core', verify: 'green' },
    ]),
    deps,
  );
  assert.equal(res.skipped[0].stage, 'verify');
  assert.match(res.skipped[0].detail, /^failing: adds numbers \(test\/adapters\.test\.js\)/);
  assert.match(res.skipped[0].detail, /AssertionError/);
});

// ---- a package red after its merge gets one fix-up before it is taken out ----------

const { buildReport } = require('../src/orchestraReport.js');
const { createFixupRunner, FIXUP_CAP_MS } = require('../src/orchestraFixup.js');
const { createMergeRunDeps } = require('../src/orchestraMergeRun.js');
const { selfCheckGate } = require('../src/orchestraSelfCheck.js');

/** Fake execFile answered per full command line by `route` (null -> ok, no output). */
function routedExec(route) {
  const calls = [];
  const execImpl = (bin, argv, _opts, cb) => {
    const cmd = `${bin} ${(bin === 'git' ? argv.slice(2) : argv).join(' ')}`;
    calls.push(cmd);
    const a = route(cmd) || { ok: true, stdout: '' };
    setImmediate(() => cb(a.ok ? null : Object.assign(new Error('x'), { code: 1 }), a.stdout || '', a.stderr || ''));
    return { stdin: { on() {}, end() {} } };
  };
  return { execImpl, calls };
}

// git for a merge fix-up: the package changed x + y, the merged ones x + z;
// `diff --cached --quiet` exits 1 = the fixer changed something.
const fixGit = (extra = () => null) =>
  routedExec((cmd) => {
    const hit = extra(cmd);
    if (hit) return hit;
    if (cmd.startsWith('git rev-parse')) return { ok: true, stdout: 'sha1\n' };
    if (cmd === 'git diff --name-only -z HEAD^1 HEAD') return { ok: true, stdout: 'src/x.js\0src/y.js\0' };
    if (cmd === 'git diff --name-only -z sha1 HEAD^1') return { ok: true, stdout: 'src/x.js\0src/z.js\0' };
    if (cmd === 'git diff --cached --quiet') return { ok: false };
    return null;
  });

const FIX_COMMIT = 'git commit -m fix: make a work with the merged packages';

test('integrateMerge: red after merge -> one fix-up -> green: stays merged, with a fix commit', async () => {
  const git = fixGit();
  let fixed = false;
  const fixups = [];
  const { deps } = integDeps(git, { verify: async () => (fixed ? { ok: true, output: '' } : { ok: false, output: SPEC_RED }) });
  deps.fixup = async (a) => (fixups.push(a), (fixed = true), { ok: true });
  const res = await integ.integrateMerge(args([{ id: 'a', branch: 'luna/a', verify: 'npm test', task: 'add the tester adapter' }]), deps);

  assert.equal(res.ok, true);
  assert.deepEqual(res.merged, ['a']);
  assert.deepEqual(res.skipped, []);
  assert.deepEqual(res.fixedUp, ['a']);
  assert.equal(fixups.length, 1);
  assert.equal(fixups[0].root, '/wt/int');
  assert.equal(fixups[0].capMs, 20 * 60 * 1000);
  const brief = fixups[0].brief;
  assert.match(brief, /package `a`/);
  assert.match(brief, /add the tester adapter/);
  assert.match(brief, /adds numbers \(test\/adapters\.test\.js\)/);
  assert.match(brief, /first error: AssertionError/);
  assert.match(brief, /- `src\/x\.js`/, 'the file both sides touched');
  assert.doesNotMatch(brief, /src\/y\.js|src\/z\.js/, 'only shared files are listed');
  assert.match(brief, /intent of BOTH sides/);
  assert.match(brief, /Do not delete or skip tests/);
  assert.match(brief, /Do not touch unrelated files/);
  assert.match(brief, /LUNA_DONE selfcheck/);
  assert.ok(git.calls.includes('git reset --soft sha1'), 'worker commits fold into the one fix commit');
  assert.ok(git.calls.includes(FIX_COMMIT));
  assert.ok(!git.calls.some((c) => c.startsWith('git reset --hard')), 'not reverted');
  assert.ok(!git.calls.some((c) => c.startsWith('git clean')), 'a green fix keeps its files');
  assert.ok(git.calls.includes('git push origin HEAD:refs/heads/main'));
});

test('integrateMerge: a fix-up that leaves the tests red -> reverted, skipped as verify, the report says a fix-up was tried', async () => {
  const git = fixGit();
  const fixups = [];
  const { deps } = integDeps(git, { verify: async (cmd) => (cmd === 'red' ? { ok: false, output: SPEC_RED } : { ok: true, output: '' }) });
  deps.fixup = async (a) => (fixups.push(a), { ok: false });
  const res = await integ.integrateMerge(
    args([
      { id: 'a', branch: 'luna/a', verify: 'red' },
      { id: 'core', branch: 'luna/core', verify: 'green' },
    ]),
    deps,
  );

  assert.deepEqual(res.merged, ['core']);
  assert.deepEqual(res.fixedUp, []);
  assert.equal(res.skipped[0].id, 'a');
  assert.equal(res.skipped[0].stage, 'verify');
  assert.equal(res.skipped[0].fixup, 'failed');
  assert.match(res.skipped[0].detail, /^failing: adds numbers/);
  assert.ok(fixups.length >= 1);
  assert.ok(git.calls.includes('git reset --hard sha1'));
  assert.ok(!git.calls.includes(FIX_COMMIT));

  const md = buildReport(
    {
      id: 'p1',
      repoPath: '/r',
      integrationMode: 'merge',
      integration: { state: 'done', partial: true, skipped: res.skipped, fixedUp: res.fixedUp },
      packages: [
        { id: 'a', title: 'A', state: 'pushed', branch: 'luna/a' },
        { id: 'core', title: 'Core', state: 'pushed', branch: 'luna/core', merged: true },
      ],
    },
    { now: 0, suggestions: [] },
  );
  assert.match(md, /- Fix-up: one fix-up worker tried after the merge and could not get it green \(the detail says why\)/);
  assert.match(md, /a fix-up worker tried and could not get it green/, 'the Needs-you line says so too');
});

test('integrateMerge: a failed fix-up leaves no new untracked files behind; files there before stay', async () => {
  let listed = 0;
  const git = fixGit((cmd) => {
    if (cmd !== 'git ls-files -z --others --exclude-standard') return null;
    listed += 1;
    return { ok: true, stdout: listed === 1 ? 'notes.txt\0' : 'notes.txt\0src/helper.js\0' };
  });
  const { deps } = integDeps(git, { verify: async () => ({ ok: false, output: SPEC_RED }) });
  deps.fixup = async () => ({ ok: false });
  const res = await integ.integrateMerge(args([{ id: 'a', branch: 'luna/a', verify: 'npm test' }]), deps);

  assert.equal(res.skipped[0].fixup, 'failed');
  assert.ok(git.calls.includes('git clean -f -q -- src/helper.js'), 'the worker leftover is removed');
  assert.ok(!git.calls.some((c) => c.startsWith('git clean') && c.includes('notes.txt')), 'a file there before stays');
  assert.ok(!git.calls.some((c) => c.startsWith('git clean') && / -[a-z]*[dx]/.test(c)), 'no directories, no ignored files');
});

test('integrateMerge: the report marks a package the fix-up kept in', () => {
  const md = buildReport(
    {
      id: 'p1',
      repoPath: '/r',
      integrationMode: 'merge',
      integration: { state: 'done', skipped: [], fixedUp: ['a'] },
      packages: [{ id: 'a', title: 'A', state: 'pushed', branch: 'luna/a', merged: true }],
    },
    { now: 0, suggestions: [] },
  );
  assert.match(md, /\| a - A \|.*fixed by fix-up after the merge/);
});

test('integrateMerge: no fix-up once the run is stopped, in a check-only build, or without a fixer', async () => {
  for (const [label, extra, checkOnly] of [
    ['stopped', { stopped: () => true }, false],
    ['throwing stop check', { stopped: () => assert.fail('boom') }, false],
    ['check only', {}, true],
  ]) {
    const git = fixGit();
    const fixups = [];
    const { deps } = integDeps(git, { verify: async () => ({ ok: false, output: SPEC_RED }) });
    Object.assign(deps, extra, { fixup: async (a) => (fixups.push(a), { ok: true }) });
    const res = await integ.integrateMerge({ ...args([{ id: 'a', branch: 'luna/a', verify: 'npm test' }]), checkOnly }, deps);
    assert.equal(fixups.length, 0, label);
    assert.equal(res.skipped[0].fixup, undefined, label);
  }
  const git = fixGit();
  const { deps } = integDeps(git, { verify: async () => ({ ok: false, output: SPEC_RED }) });
  const res = await integ.integrateMerge(args([{ id: 'a', branch: 'luna/a', verify: 'npm test' }]), deps);
  assert.deepEqual(Object.keys(res.skipped[0]), ['id', 'stage', 'detail', 'files'], 'no fixer: the entry looks as before');
});

// --no-renames: a test moved out of test/ is a deletion, not a rename.
const DELETED_CMD = 'git diff --cached --name-only -z --no-renames --diff-filter=D sha1';

test('integrateMerge: a green fix-up that deleted tests or moved HEAD off the merge is refused', async () => {
  const cases = [
    [(cmd) => (cmd === DELETED_CMD ? { ok: true, stdout: 'test/a.test.js\0' } : null), /deleted tests: test\/a\.test\.js/],
    // -z: a non-ASCII name arrives unquoted, so the test-file check still sees it.
    [(cmd) => (cmd === DELETED_CMD ? { ok: true, stdout: 'test/zażółć.test.js\0' } : null), /deleted tests: test\/zaż/],
    [(cmd) => (cmd === 'git merge-base --is-ancestor sha1 HEAD' ? { ok: false } : null), /moved HEAD off the merge/],
  ];
  for (const [route, why] of cases) {
    let fixed = false;
    // The revert takes the worker's change back out: the second pass is red again.
    const git = fixGit((cmd) => (cmd.startsWith('git reset --hard') ? ((fixed = false), null) : route(cmd)));
    const { deps } = integDeps(git, { verify: async () => (fixed ? { ok: true, output: '' } : { ok: false, output: SPEC_RED }) });
    deps.fixup = async () => ((fixed = true), { ok: true });
    const res = await integ.integrateMerge(args([{ id: 'a', branch: 'luna/a', verify: 'npm test' }]), deps);
    assert.equal(res.ok, false);
    assert.equal(res.skipped[0].fixup, 'failed');
    assert.match(res.skipped[0].detail, why);
    assert.ok(!git.calls.includes(FIX_COMMIT));
  }
});

test('createFixupRunner: capMs shortens the cap, never lengthens it', () => {
  const caps = [];
  const runner = createFixupRunner({
    getPlan: () => ({ id: 'p1', profileId: 'x', projectId: 'y' }),
    createSession: () => ({ id: 's1' }),
    writeBrief: () => true,
    briefDir: () => '/b',
    closeSession: () => {},
    sessionAlive: () => false,
    model: () => null,
    permissionMode: () => null,
    setTimer: (_fn, ms) => (caps.push(ms), {}),
    clearTimer: () => {},
  });
  for (const capMs of [20 * 60 * 1000, 10 * FIXUP_CAP_MS, undefined, -5]) {
    runner.run({ root: '/wt', brief: 'x', capMs });
    runner.abort();
  }
  assert.deepEqual(caps, [20 * 60 * 1000, FIXUP_CAP_MS, FIXUP_CAP_MS, FIXUP_CAP_MS]);
});

test('createMergeRunDeps: task text in, fix-ups counted on the self-check result, a kill during the merge stops new ones', async () => {
  const plan = { id: 'p1', repoPath: '/r', killed: false, pausedUntil: null, integration: { state: 'running' }, packages: [{ id: 'a', prompt: 'do a' }] };
  const seen = {};
  const mr = createMergeRunDeps({
    getPlan: () => plan,
    runFixup: async () => ({ ok: true }),
    runSelfCheck: async () => ({ tests: 'ok', syntax: 'ok', smoke: 'skipped' }),
    integrateMerge: async (a, extra) => {
      Object.assign(seen, { repoPath: a.repoPath, task: a.packages[0].task, gate: typeof extra.beforePush, before: extra.stopped() });
      await extra.fixup({ root: '/wt', brief: 'x' });
      seen.check = await mr.runSelfCheck({ root: '/wt' });
      plan.killed = true;
      seen.after = extra.stopped();
      return { ok: true, merged: ['a'], fixedUp: ['a', 'NOT AN ID'] };
    },
  });
  await mr.integrateMerge({ packages: [{ id: 'a', branch: 'luna/a' }] }, { beforePush: async () => ({ ok: true }) });
  assert.deepEqual(seen, { repoPath: '/r', task: 'do a', gate: 'function', before: false, check: { tests: 'ok', syntax: 'ok', smoke: 'skipped', mergeFixups: 1 }, after: true });
  assert.deepEqual(plan.integration, { state: 'running', fixedUp: ['a'], secondPass: [] });

  // A run killed earlier and finished by hand still gets its fix-ups.
  let stopped = null;
  const killed = { ...plan, killed: true, integration: {} };
  const again = createMergeRunDeps({ getPlan: () => killed, runFixup: async () => ({}), integrateMerge: async (_a, x) => ((stopped = x.stopped()), {}) });
  await again.integrateMerge({ packages: [] }, {});
  assert.equal(stopped, false);
  assert.equal(again.runSelfCheck, undefined, 'no self-check dep -> none handed on');
});

test('createMergeRunDeps: fix-ups count per run; lists only from an integration that went through, added up over passes', async () => {
  let plan = { id: 'p1', repoPath: '/r', integration: {}, packages: [] };
  let answer = { ok: true, fixedUp: ['a'], secondPass: ['b'] };
  const mr = createMergeRunDeps({
    getPlan: () => plan,
    runFixup: async () => ({ ok: true }),
    runSelfCheck: async () => ({ tests: 'ok' }),
    integrateMerge: async (_a, extra) => (await extra.fixup({ root: '/wt', brief: 'x' }), answer),
  });
  await mr.integrateMerge({ packages: [] }, {});
  answer = { ok: true, fixedUp: ['c'], secondPass: ['b'] };
  await mr.integrateMerge({ packages: [] }, {});
  assert.deepEqual(plan.integration, { fixedUp: ['a', 'c'], secondPass: ['b'] }, 'a Retry pass adds to the first');
  assert.equal((await mr.runSelfCheck({})).mergeFixups, 2, 'both passes of the same run count');

  answer = { ok: false, stage: 'push', fixedUp: ['d'], secondPass: ['e'] };
  await mr.integrateMerge({ packages: [] }, {});
  assert.deepEqual(plan.integration, { fixedUp: ['a', 'c'], secondPass: ['b'] }, 'a failed push merged nothing into the base');

  plan = { id: 'p2', repoPath: '/r', integration: {}, packages: [] };
  assert.equal((await mr.runSelfCheck({})).mergeFixups, 0, 'a new run inherits no fix-ups');
});

test("selfCheckGate: merge fix-ups count in selfCheck.fixups with the gate's own", async () => {
  const green = { tests: 'ok', syntax: 'ok', smoke: 'skipped', manualActions: [], tail: '', mergeFixups: 2 };
  const ok = await selfCheckGate({ root: '/wt', baseSha: null, checkCommand: 'npm test', slug: 'p' }, { runSelfCheck: async () => green });
  assert.equal(ok.selfCheck.fixups, 2);
  let n = 0;
  const red = await selfCheckGate(
    { root: '/wt', baseSha: null, checkCommand: 'npm test', slug: 'p' },
    { runSelfCheck: async () => ((n += 1), n === 1 ? { ...green, tests: 'failed' } : green), runFixup: async () => ({ ok: true }) },
  );
  assert.equal(red.selfCheck.fixups, 3);
});

test('normalizeStoredPlan keeps integration.fixedUp, a failed fix-up on a skip, and more than one fix-up', () => {
  const stored = sup.normalizeStoredPlan({
    id: 'p1',
    repoPath: '/r',
    packages: [{ id: 'a' }],
    integration: {
      state: 'done',
      fixedUp: ['a', 'BAD ID', 7],
      skipped: [
        { id: 'b', stage: 'verify', detail: 'x', files: [], fixup: 'failed' },
        { id: 'c', stage: 'verify', detail: 'x', files: [], fixup: '<b>' },
      ],
      selfCheck: { tests: 'ok', fixups: 3 },
    },
  }).integration;
  assert.deepEqual(stored.fixedUp, ['a']);
  assert.equal(stored.skipped[0].fixup, 'failed');
  assert.equal('fixup' in stored.skipped[1], false);
  assert.equal(stored.selfCheck.fixups, 3);
  assert.deepEqual(sup.normalizeStoredPlan({ id: 'p1', repoPath: '/r', packages: [{ id: 'a' }] }).integration.fixedUp, []);
});

// ---- the integration's second pass: what the order cost is tried again -----------

/**
 * Fake git for a plan where luna/b conflicts until luna/a is in: a merge of b
 * before that leaves src/shared.js unmerged (the resolver cannot fix it).
 */
function orderGit() {
  const inTree = new Set();
  return routedExec((cmd) => {
    if (cmd.startsWith('git rev-parse')) return { ok: true, stdout: 'sha1\n' };
    if (cmd === 'git diff --name-only --diff-filter=U') return { ok: true, stdout: 'src/shared.js\n' };
    const m = /^git merge --no-ff .* refs\/heads\/(luna\/[a-z]+)$/.exec(cmd);
    if (!m) return null;
    if (m[1] === 'luna/b' && !inTree.has('luna/a')) return { ok: false, stderr: 'CONFLICT (content): src/shared.js' };
    inTree.add(m[1]);
    return { ok: true };
  });
}

const ORDER_PLAN = [
  { id: 'b', branch: 'luna/b', verify: '' },
  { id: 'a', branch: 'luna/a', verify: '' },
  { id: 'c', branch: 'luna/c', verify: '', dependsOn: ['b'] },
];

test('integrateMerge second pass: B conflicts until A is in, C depends on B -> all three merged', async () => {
  const git = orderGit();
  const { deps, resolves } = integDeps(git, { resolve: async () => ({ ok: false }) });
  const res = await integ.integrateMerge(args(ORDER_PLAN), deps);

  assert.equal(res.ok, true);
  assert.deepEqual(res.merged, ['a', 'b', 'c'], 'A on the first pass, then B, then its dependent C');
  assert.deepEqual(res.skipped, []);
  assert.deepEqual(res.secondPass, ['b', 'c']);
  assert.deepEqual(resolves.map((r) => r.attempt), [undefined, 2], 'the first pass tried both resolvers; B then merged clean');
  const merges = git.calls.filter((c) => c.startsWith('git merge --no-ff')).map((c) => c.split('refs/heads/')[1]);
  assert.deepEqual(merges, ['luna/b', 'luna/b', 'luna/a', 'luna/b', 'luna/c']);
  assert.ok(git.calls.includes('git push origin HEAD:refs/heads/main'));
});

test('integrateMerge second pass: none once the run is stopped, none in a check-only build', async () => {
  for (const [label, extra, checkOnly] of [
    ['stopped', { stopped: () => true }, false],
    ['check only', {}, true],
  ]) {
    const git = orderGit();
    const { deps } = integDeps(git, { resolve: async () => ({ ok: false }) });
    Object.assign(deps, extra);
    const res = await integ.integrateMerge({ ...args(ORDER_PLAN), checkOnly }, deps);
    assert.deepEqual(res.merged, ['a'], label);
    assert.deepEqual(res.secondPass, [], label);
    assert.deepEqual(
      res.skipped.map((s) => [s.id, s.stage, s.detail]),
      [
        ['b', 'conflict', 'src/shared.js'],
        ['c', 'depSkipped', 'b'],
      ],
      label,
    );
  }
});

test('integrateMerge second pass: a package red again keeps its stage; a fix-up gets one more go', async () => {
  const git = fixGit();
  const fixups = [];
  const { deps } = integDeps(git, { verify: async (cmd) => (cmd === 'red' ? { ok: false, output: SPEC_RED } : { ok: true, output: '' }) });
  deps.fixup = async (a) => (fixups.push(a.id), { ok: false });
  const res = await integ.integrateMerge(
    args([
      { id: 'a', branch: 'luna/a', verify: 'red' },
      { id: 'core', branch: 'luna/core', verify: 'green' },
      { id: 'ui', branch: 'luna/ui', verify: 'green', dependsOn: ['a'] },
    ]),
    deps,
  );
  assert.deepEqual(res.merged, ['core']);
  assert.deepEqual(res.secondPass, []);
  assert.deepEqual(fixups, ['a', 'a'], 'one fix-up per pass');
  assert.deepEqual(
    res.skipped.map((s) => [s.id, s.stage, s.fixup]),
    [
      ['a', 'verify', 'failed'],
      ['ui', 'depSkipped', undefined],
    ],
  );
});

test('the report lists the packages merged on the second pass on their own', () => {
  const md = buildReport(
    {
      id: 'p1',
      repoPath: '/r',
      integrationMode: 'merge',
      integration: { state: 'done', skipped: [], fixedUp: [], secondPass: ['b', 'c'] },
      packages: [
        { id: 'a', title: 'Alpha', state: 'pushed', branch: 'luna/a', merged: true },
        { id: 'b', title: 'Beta', state: 'pushed', branch: 'luna/b', merged: true },
        { id: 'c', title: 'Gamma', state: 'pushed', branch: 'luna/c', merged: true },
      ],
    },
    { now: 0, suggestions: [] },
  );
  assert.match(md, /Merged on second pass \(after the rest was in\):\n\n- `b` Beta\n- `c` Gamma\n/);
  assert.match(md, /\| b - Beta \|.*merged on second pass/);
  assert.doesNotMatch(md, /\| a - Alpha \|.*second pass/);
  const none = buildReport({ id: 'p1', repoPath: '/r', integrationMode: 'merge', integration: { state: 'done' }, packages: [] }, { now: 0, suggestions: [] });
  assert.doesNotMatch(none, /second pass/);
});

test('normalizeStoredPlan keeps integration.secondPass (valid ids only)', () => {
  const stored = sup.normalizeStoredPlan({
    id: 'p1',
    repoPath: '/r',
    packages: [{ id: 'a' }],
    integration: { state: 'done', secondPass: ['b', 'NOT AN ID', null] },
  }).integration;
  assert.deepEqual(stored.secondPass, ['b']);
  assert.deepEqual(sup.normalizeStoredPlan({ id: 'p1', repoPath: '/r', packages: [{ id: 'a' }] }).integration.secondPass, []);
});

// ---- a second pass of the same run: leftovers never block it ---------------------

test('integrateMerge: a leftover branch from an earlier pass is deleted before the build', async () => {
  const git = fakeExec({ 'rev-parse': { ok: true, stdout: 'sha1\n' } });
  const { deps } = integDeps(git);
  const res = await integ.integrateMerge(args([{ id: 'a', branch: 'luna/a', verify: '' }]), deps);
  assert.equal(res.ok, true);
  const delAt = git.calls.indexOf('git branch -D luna/p-integration');
  assert.ok(delAt >= 0, 'leftover branch deleted');
  assert.ok(git.calls.indexOf('git worktree prune') < delAt, 'pruned first');
  assert.ok(delAt < git.calls.findIndex((c) => c.startsWith('git merge')), 'before any merge');
});

test('integrateMerge: no leftover branch, nothing deleted before the build', async () => {
  const git = fakeExec({
    'rev-parse': [{ ok: true, stdout: 'sha1\n' }, { ok: false }, { ok: true, stdout: 'sha1\n' }],
  });
  const { deps } = integDeps(git);
  const res = await integ.integrateMerge(args([{ id: 'a', branch: 'luna/a', verify: '' }]), deps);
  assert.equal(res.ok, true);
  const pushAt = git.calls.indexOf('git push origin HEAD:refs/heads/main');
  assert.ok(git.calls.indexOf('git branch -D luna/p-integration') > pushAt, 'the only delete is the one after the push');
});

test('integrateMerge: a leftover worktree is removed; one with local changes fails as worktree, not built over', async () => {
  const listing = 'worktree /r\nHEAD abc\nbranch refs/heads/main\n\nworktree /wt/old\nHEAD def\nbranch refs/heads/luna/p-integration\n';
  const git = fakeExec({ 'rev-parse': { ok: true, stdout: 'sha1\n' }, worktree: { ok: true, stdout: listing } });
  const { deps, removed } = integDeps(git);
  assert.equal((await integ.integrateMerge(args([{ id: 'a', branch: 'luna/a', verify: '' }]), deps)).ok, true);
  assert.equal(removed[0], '/wt/old');

  const git2 = fakeExec({ 'rev-parse': { ok: true, stdout: 'sha1\n' }, worktree: { ok: true, stdout: listing } });
  const dirty = integDeps(git2);
  let added = false;
  dirty.deps.removeWorktree = async () => ({ ok: false, error: 'dirty' });
  dirty.deps.addWorktree = async () => ((added = true), WT);
  const res = await integ.integrateMerge(args([{ id: 'a', branch: 'luna/a', verify: '' }]), dirty.deps);
  assert.equal(res.ok, false);
  assert.equal(res.stage, 'worktree');
  assert.match(res.detail, /leftover \/wt\/old: dirty/);
  assert.equal(added, false);
});

test('integrateMerge: after a successful push the local integration branch goes too', async () => {
  const git = fakeExec({ 'rev-parse': { ok: true, stdout: 'sha1\n' } });
  const { deps } = integDeps(git);
  await integ.integrateMerge(args([{ id: 'a', branch: 'luna/a', verify: '' }]), deps);
  const pushAt = git.calls.indexOf('git push origin HEAD:refs/heads/main');
  assert.ok(git.calls.lastIndexOf('git branch -D luna/p-integration') > pushAt);
});

test("integrateMerge: a failed fetch reports git's fatal line, not its progress line", async () => {
  const git = fakeExec({ fetch: { ok: false, stderr: 'remote: Counting objects\nfatal: unable to access origin\n' } });
  const { deps } = integDeps(git);
  const res = await integ.integrateMerge(args([{ id: 'a', branch: 'luna/a', verify: '' }]), deps);
  assert.equal(res.stage, 'fetch');
  assert.equal(res.detail, 'fatal: unable to access origin');
});

test('finalize: a worktree failure is retried once on its own; a conflict-type failure is not', async () => {
  const { createFinalizer } = require('../src/orchestraFinalize.js');
  const mk = (answers) => {
    const plan = {
      id: 'run1',
      repoPath: '/r',
      baseBranch: 'main',
      integrationMode: 'merge',
      integration: { state: 'idle' },
      approvalLog: [],
      packages: [{ id: 'a', title: 'A', state: 'pushed', branch: 'luna/a', dependsOn: [] }],
    };
    const calls = [];
    const events = [];
    const fin = createFinalizer({
      getPlan: () => plan,
      patch: () => {},
      commit: () => {},
      view: () => ({ id: plan.id, packages: plan.packages, integration: plan.integration, overlaps: [] }),
      onRunEvent: (kind) => events.push(kind),
      now: () => 1,
      sleep: async () => {},
      integrateMerge: async (a) => (calls.push(a), answers.shift()),
    });
    return { plan, calls, events, fin };
  };

  const retried = mk([
    { ok: false, merged: [], skipped: [], stage: 'worktree', detail: 'fatal: a branch named x already exists' },
    { ok: true, merged: ['a'], skipped: [] },
  ]);
  await retried.fin.finalize();
  assert.equal(retried.calls.length, 2);
  assert.ok(retried.events.includes('integrationRetry'));
  assert.equal(retried.plan.integration.state, 'done');

  const notRetried = mk([{ ok: false, merged: [], skipped: [], stage: 'nothingMerged', detail: 'a' }]);
  await notRetried.fin.finalize();
  assert.equal(notRetried.calls.length, 1);
  assert.equal(notRetried.plan.integration.state, 'failed');

  const dirtyLeftover = mk([{ ok: false, merged: [], skipped: [], stage: 'worktree', detail: 'leftover /wt/old: dirty' }]);
  await dirtyLeftover.fin.finalize();
  assert.equal(dirtyLeftover.calls.length, 1, 'a dirty leftover fails the same way every time');

  const twice = mk([
    { ok: false, merged: [], skipped: [], stage: 'push', detail: 'rejected' },
    { ok: false, merged: [], skipped: [], stage: 'push', detail: 'rejected' },
  ]);
  await twice.fin.finalize();
  assert.equal(twice.calls.length, 2, 'only one retry');
  assert.equal(twice.plan.integration.error, 'pushFailed');
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
