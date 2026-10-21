// ============================================================================
// God Mode never blocks 4/5: end-of-run self-check (tests, syntax, smoke,
// manual actions) + one fix-up worker. The check itself runs against real
// temp git repos (git + node --check); the smoke, the fix-up worker and the
// finalizer wiring are faked.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const sc = require('../src/orchestraSelfCheck.js');
const integ = require('../src/orchestraIntegrate.js');
const sup = require('../src/orchestraSupervisor.js');
const { createFinalizer } = require('../src/orchestraFinalize.js');
const { createOrchestra } = require('../src/orchestra.js');

const greenVerify = async () => ({ ok: true, output: '' });

// ---- temp repos -----------------------------------------------------------------

function git(dir, ...args) {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', windowsHide: true }).trim();
}

/** A repo with one base commit; returns {dir, baseSha}. */
function tempRepo(files = { 'README.md': 'base\n' }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-selfcheck-'));
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 't@example.com');
  git(dir, 'config', 'user.name', 'T');
  git(dir, 'config', 'commit.gpgsign', 'false');
  write(dir, files);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'base');
  return { dir, baseSha: git(dir, 'rev-parse', 'HEAD') };
}

function write(dir, files) {
  for (const [rel, text] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, text);
  }
}

function commit(dir, files, message) {
  write(dir, files);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', message);
  return git(dir, 'rev-parse', '--short=7', 'HEAD');
}

const rm = (dir) => fs.rmSync(dir, { recursive: true, force: true });

// ---- runSelfCheck ---------------------------------------------------------------

test('runSelfCheck: a red check command fails tests and keeps the last 40 output lines', async () => {
  const { dir, baseSha } = tempRepo();
  try {
    const ran = [];
    const lines = Array.from({ length: 60 }, (_, i) => `line ${i}`).join('\n');
    const res = await sc.runSelfCheck(
      { root: dir, baseSha, checkCommand: 'npm test' },
      { verifyImpl: async (cmd, cwd) => (ran.push([cmd, cwd]), { ok: false, output: lines }) },
    );
    assert.deepEqual(ran, [['npm test', dir]]);
    assert.equal(res.tests, 'failed');
    assert.equal(res.syntax, 'skipped', 'nothing changed since the base');
    assert.equal(res.smoke, 'skipped');
    const tail = res.tail.split('\n');
    assert.equal(tail.length, 40);
    assert.equal(tail[0], 'line 20');
    assert.equal(tail[39], 'line 59');
  } finally {
    rm(dir);
  }
});

test('runSelfCheck: node --check catches a syntax error in a changed file, skips node_modules', async () => {
  const { dir, baseSha } = tempRepo({ 'src/ok.js': 'module.exports = 1;\n' });
  try {
    commit(
      dir,
      {
        'src/ok.js': 'module.exports = 2;\n',
        'src/broken.js': 'function (\n',
        'src/fine.mjs': 'export const a = 1;\n',
        'node_modules/dep/index.js': 'this is not js (\n',
        'docs/readme.md': 'not code (\n',
      },
      'work',
    );
    // node_modules is normally ignored; force it in to prove the filter.
    const res = await sc.runSelfCheck({ root: dir, baseSha, checkCommand: 'npm test' }, { verifyImpl: greenVerify });
    assert.equal(res.tests, 'ok');
    assert.equal(res.syntax, 'failed');
    assert.match(res.tail, /broken\.js/);
    assert.doesNotMatch(res.tail, /node_modules/);

    git(dir, 'rm', '-q', 'src/broken.js');
    git(dir, 'commit', '-q', '-m', 'fix');
    const fixed = await sc.runSelfCheck({ root: dir, baseSha, checkCommand: 'npm test' }, { verifyImpl: greenVerify });
    assert.equal(fixed.syntax, 'ok');
    assert.equal(fixed.tail, '');
  } finally {
    rm(dir);
  }
});

test('runSelfCheck: manual actions - migrations, edge functions, env vars, commit notes; deduplicated', async () => {
  const { dir, baseSha } = tempRepo({
    'supabase/migrations/001_old.sql': 'select 1;\n',
    'src/old.js': 'const a = process.env.OLD_KEY;\n',
  });
  try {
    const sha = commit(
      dir,
      {
        'supabase/migrations/002_new.sql': 'create table x();\n',
        'supabase/migrations/003_more.sql': 'create table y();\n',
        'supabase/functions/send-mail/index.ts': "const k = Deno.env.get('MAIL_KEY');\n",
        'src/new.js': 'const a = process.env.NEW_KEY; const b = process.env.OLD_KEY; const c = process.env.NEW_KEY;\n',
        'web/app.js': 'const u = import.meta.env.VITE_URL;\n',
        'test/x.test.js': 'process.env.TEST_ONLY_KEY = "1";\n',
      },
      'feat: cloud tables\n\nThe migrations are not applied yet - apply them live.\nNothing else here.',
    );
    const res = await sc.runSelfCheck({ root: dir, baseSha, checkCommand: 'npm test' }, { verifyImpl: greenVerify });
    const by = (kind) => res.manualActions.filter((a) => a.kind === kind);
    assert.deepEqual(
      by('migration').map((a) => a.what),
      ['002_new.sql', '003_more.sql'],
    );
    assert.equal(by('migration')[0].from, sha);
    assert.deepEqual(
      by('edgeFunction').map((a) => a.what),
      ['send-mail'],
    );
    assert.deepEqual(by('env').map((a) => a.what).sort(), ['MAIL_KEY', 'NEW_KEY', 'VITE_URL']);
    const notes = by('note');
    assert.equal(notes.length, 1);
    assert.equal(notes[0].what, 'The migrations are not applied yet - apply them live.');
    assert.equal(notes[0].from, sha);
  } finally {
    rm(dir);
  }
});

test('runSelfCheck: smoke is skipped (not failed) in a repo without electron / luna-probe', async () => {
  const { dir, baseSha } = tempRepo({
    'package.json': JSON.stringify({ name: 'x', main: 'index.js', devDependencies: { mocha: '1' } }),
    'index.js': '// luna-probe\n',
  });
  try {
    const calls = [];
    const execImpl = (bin, args, opts, cb) => (calls.push(bin), cb(null, '', ''));
    const res = await sc.runSmoke(dir, { execImpl });
    assert.equal(res.state, 'skipped');
    assert.deepEqual(calls, []);
    // electron without the probe flag in the main file: still skipped.
    write(dir, { 'package.json': JSON.stringify({ main: 'index.js', devDependencies: { electron: '1' } }), 'index.js': '// app\n' });
    assert.equal((await sc.runSmoke(dir, { execImpl })).state, 'skipped');
    assert.deepEqual(calls, []);
  } finally {
    rm(dir);
  }
});

test('runSmoke: launches the app with --luna-probe, time-boxed; error lines or a bad exit fail it', async () => {
  const { dir } = tempRepo({
    'package.json': JSON.stringify({ main: 'src/main.js', devDependencies: { electron: '^43' } }),
    'src/main.js': "if (process.argv.includes('--luna-probe')) {}\n",
  });
  try {
    const seen = [];
    const answer = (err, stdout) => (bin, args, opts, cb) => {
      seen.push({ bin, args, opts });
      cb(err, stdout, '');
    };
    const ok = await sc.runSmoke(dir, { execImpl: answer(null, '[luna-probe] {"rows":3}\n[luna-probe] wrote x') });
    assert.equal(ok.state, 'ok');
    assert.deepEqual(seen[0].args.slice(-2), ['.', '--luna-probe']);
    assert.equal(seen[0].opts.cwd, dir);
    assert.equal(seen[0].opts.windowsHide, true);
    assert.equal(seen[0].opts.timeout, sc.SMOKE_TIMEOUT_MS);
    assert.equal(sc.SMOKE_TIMEOUT_MS, 180 * 1000);

    const typeErr = await sc.runSmoke(dir, { execImpl: answer(null, 'boot\nUncaught TypeError: x is not a function') });
    assert.equal(typeErr.state, 'failed');
    assert.match(typeErr.output, /TypeError/);
    const failedProbe = await sc.runSmoke(dir, { execImpl: answer(null, '[luna-probe] FAILED Error: boom') });
    assert.equal(failedProbe.state, 'failed');
    const exit = await sc.runSmoke(dir, { execImpl: answer(Object.assign(new Error('x'), { code: 1 }), 'quiet') });
    assert.equal(exit.state, 'failed');
  } finally {
    rm(dir);
  }
});

test('runSelfCheck never throws: a missing root and a throwing verify yield a result', async () => {
  const res = await sc.runSelfCheck(
    { root: path.join(os.tmpdir(), 'luna-selfcheck-missing-xyz'), baseSha: 'nope', checkCommand: 'npm test' },
    {
      verifyImpl: async () => {
        throw new Error('boom');
      },
    },
  );
  assert.equal(res.tests, 'failed');
  assert.equal(res.syntax, 'skipped');
  assert.equal(res.smoke, 'skipped');
  assert.deepEqual(res.manualActions, []);
});

test('isGreen / fixupBrief: the brief names the failed check, its tail, the command and the marker', () => {
  assert.equal(sc.isGreen({ tests: 'ok', syntax: 'skipped', smoke: 'skipped' }), true);
  assert.equal(sc.isGreen({ tests: 'ok', syntax: 'failed', smoke: 'skipped' }), false);
  const brief = sc.fixupBrief({ tests: 'failed', syntax: 'ok', smoke: 'skipped', tail: 'not ok 3 - math' }, 'npm test');
  assert.match(brief, /tests/);
  assert.match(brief, /not ok 3 - math/);
  assert.match(brief, /npm test/);
  assert.match(brief, /minimal fix/);
  assert.match(brief, /do not touch unrelated files/i);
  assert.match(brief, /LUNA_DONE selfcheck/);
});

// ---- gate: one fix-up worker ------------------------------------------------------

function gateDeps(results, { pushOk = true } = {}) {
  const log = { checks: 0, fixups: [], pushes: [] };
  return {
    log,
    deps: {
      runSelfCheck: async (args) => {
        log.checks += 1;
        return { manualActions: [], tail: '', ...results.shift(), args };
      },
      runFixup: async (args) => (log.fixups.push(args), { ok: true }),
      pushBranch: async (root, branch) => (log.pushes.push([root, branch]), { ok: pushOk }),
    },
  };
}

const RED = { tests: 'failed', syntax: 'ok', smoke: 'skipped', tail: 'FAIL' };
const GREEN = { tests: 'ok', syntax: 'ok', smoke: 'skipped', tail: '' };

test('selfCheckGate: green at once pushes without a fix-up', async () => {
  const { deps, log } = gateDeps([{ ...GREEN, manualActions: [{ kind: 'migration', what: '1.sql' }] }]);
  const res = await sc.selfCheckGate({ root: '/wt', baseSha: 'abc1234', checkCommand: 'npm test', slug: 'p1' }, deps);
  assert.equal(res.ok, true);
  assert.equal(log.fixups.length, 0);
  assert.deepEqual(res.selfCheck, { tests: 'ok', syntax: 'ok', smoke: 'skipped', fixups: 0, tail: '', pushedIntegrationBranch: null });
  assert.deepEqual(res.manualActions, [{ kind: 'migration', what: '1.sql' }]);
});

test('selfCheckGate: red -> one fix-up worker -> green pushes the base', async () => {
  const { deps, log } = gateDeps([RED, GREEN]);
  const res = await sc.selfCheckGate({ root: '/wt', baseSha: 'abc1234', checkCommand: 'npm test', slug: 'p1' }, deps);
  assert.equal(res.ok, true);
  assert.equal(log.fixups.length, 1);
  assert.equal(log.fixups[0].root, '/wt');
  assert.match(log.fixups[0].brief, /FAIL/);
  assert.equal(log.checks, 2);
  assert.equal(res.selfCheck.fixups, 1);
  assert.equal(res.selfCheck.tests, 'ok');
  assert.deepEqual(log.pushes, []);
});

test('selfCheckGate: still red after the fix-up -> base not pushed, luna/<slug>-integration pushed instead', async () => {
  const { deps, log } = gateDeps([RED, { ...RED, tail: 'STILL' }]);
  const res = await sc.selfCheckGate({ root: '/wt', baseSha: 'abc1234', checkCommand: 'npm test', slug: 'p1' }, deps);
  assert.equal(res.ok, false);
  assert.match(res.reason, /tests/);
  assert.equal(log.fixups.length, 1, 'exactly one fix-up worker');
  assert.deepEqual(log.pushes, [['/wt', 'luna/p1-integration']]);
  assert.deepEqual(res.selfCheck, {
    tests: 'failed',
    syntax: 'ok',
    smoke: 'skipped',
    fixups: 1,
    tail: 'STILL',
    pushedIntegrationBranch: 'luna/p1-integration',
  });

  const failedPush = gateDeps([RED, RED], { pushOk: false });
  const res2 = await sc.selfCheckGate({ root: '/wt', baseSha: 'abc1234', checkCommand: 'npm test', slug: 'p1' }, failedPush.deps);
  assert.equal(res2.selfCheck.pushedIntegrationBranch, null);
});

test('selfCheckGate never throws: a throwing fix-up / check counts as red', async () => {
  const res = await sc.selfCheckGate(
    { root: '/wt', baseSha: 'abc1234', checkCommand: 'npm test', slug: 'p1' },
    {
      runSelfCheck: async () => {
        throw new Error('x');
      },
      runFixup: async () => {
        throw new Error('y');
      },
      pushBranch: async () => ({ ok: true }),
    },
  );
  assert.equal(res.ok, false);
  assert.equal(res.selfCheck.tests, 'failed');
});

test('pushBranch: only a luna/ branch, argv push origin HEAD:refs/heads/<branch>', async () => {
  const calls = [];
  const execImpl = (bin, args, _o, cb) => (calls.push([bin, ...args].join(' ')), cb(null, '', ''));
  assert.equal((await sc.pushBranch('/wt', 'luna/p1-integration', execImpl)).ok, true);
  assert.deepEqual(calls, ['git -C /wt push origin HEAD:refs/heads/luna/p1-integration']);
  assert.equal((await sc.pushBranch('/wt', 'main', execImpl)).ok, false);
  assert.equal((await sc.pushBranch('/wt', 'luna/--force', execImpl)).ok, false);
  assert.equal(calls.length, 1);
});

// ---- integrateMerge checkOnly ---------------------------------------------------------

function fakeExec(answers) {
  const calls = [];
  const execImpl = (bin, args, _opts, cb) => {
    const sub = bin === 'git' ? args.slice(2) : args;
    calls.push(`${bin} ${sub.join(' ')}`);
    const a = answers[sub[0]] || { ok: true, stdout: '' };
    setImmediate(() => cb(a.ok ? null : Object.assign(new Error('x'), { code: 1 }), a.stdout || '', a.stderr || ''));
    return { stdin: { on() {}, end() {} } };
  };
  return { execImpl, calls };
}

test('integrateMerge checkOnly: merges with the skip rules, runs the gate, never pushes, removes the throwaway worktree + branch', async () => {
  const git = fakeExec({ 'rev-parse': { ok: true, stdout: 'sha1\n' } });
  const removed = [];
  const seen = [];
  const res = await integ.integrateMerge(
    {
      repoPath: '/r',
      base: 'main',
      slug: 'p-check',
      checkOnly: true,
      packages: [
        { id: 'a', branch: 'luna/a', verify: 'red', dependsOn: [] },
        { id: 'b', branch: 'luna/b', verify: '', dependsOn: [] },
      ],
    },
    {
      execImpl: git.execImpl,
      addWorktree: async () => ({ ok: true, root: '/wt/chk', cwd: '/wt/chk', branch: 'luna/p-check-integration' }),
      removeWorktree: async (_r, root) => (removed.push(root), { ok: true }),
      resolve: async () => ({ ok: true }),
      verifyImpl: async (cmd) => ({ ok: cmd !== 'red', output: 'x' }),
      installImpl: async () => ({ ok: true }),
      beforePush: async (root, info) => (seen.push([root, info]), { ok: true }),
    },
  );
  assert.equal(res.ok, true);
  assert.equal(res.checkOnly, true);
  assert.deepEqual(res.merged, ['b']);
  assert.equal(res.skipped[0].id, 'a');
  assert.deepEqual(seen, [['/wt/chk', { merged: ['b'], skipped: res.skipped, baseSha: 'sha1' }]]);
  assert.ok(!git.calls.some((c) => c.startsWith('git push')), 'check-only never pushes');
  assert.deepEqual(removed, ['/wt/chk']);
  assert.ok(git.calls.includes('git branch -D luna/p-check-integration'));
});

// ---- normalizeIntegration ----------------------------------------------------------

test('normalizeStoredPlan: selfCheck and manualActions validated and capped; legacy plans load', () => {
  const base = { id: 'p', repoPath: path.resolve('/r'), packages: [{ id: 'a', state: 'pushed' }] };
  const legacy = sup.normalizeStoredPlan(base);
  assert.equal(legacy.integration.selfCheck, null);
  assert.deepEqual(legacy.integration.manualActions, []);

  const stored = sup.normalizeStoredPlan({
    ...base,
    integration: {
      state: 'failed',
      selfCheck: {
        tests: 'failed',
        syntax: 'bogus',
        smoke: 'ok',
        fixups: 99,
        tail: 'x'.repeat(20000),
        pushedIntegrationBranch: 'luna/p1-integration',
      },
      manualActions: [
        { kind: 'migration', what: '002.sql', from: 'abc1234' },
        { kind: 'env', what: 'KEY', from: 'not a sha' },
        { kind: 'rm -rf', what: 'x' },
        { kind: 'note', what: 'y'.repeat(500) },
        ...Array.from({ length: 60 }, (_, i) => ({ kind: 'env', what: `K${i}` })),
      ],
    },
  });
  const s = stored.integration.selfCheck;
  assert.deepEqual([s.tests, s.syntax, s.smoke, s.fixups], ['failed', 'skipped', 'ok', 1]);
  assert.ok(s.tail.length <= 4000);
  assert.equal(s.pushedIntegrationBranch, 'luna/p1-integration');
  const m = stored.integration.manualActions;
  assert.equal(m.length, 40);
  assert.deepEqual(m[0], { kind: 'migration', what: '002.sql', from: 'abc1234' });
  assert.deepEqual(m[1], { kind: 'env', what: 'KEY' });
  assert.equal(m[2].kind, 'note');
  assert.equal(m[2].what.length, 160);

  const evil = sup.normalizeStoredPlan({
    ...base,
    integration: { selfCheck: { tests: 'ok', pushedIntegrationBranch: 'main --force' } },
  });
  assert.equal(evil.integration.selfCheck.pushedIntegrationBranch, null);
});

// ---- finalizer wiring ------------------------------------------------------------

function finalizerFor(plan, deps = {}) {
  const patches = [];
  const fin = createFinalizer({
    getPlan: () => plan,
    patch: (id, fields) => patches.push([id, fields]),
    commit: () => {},
    view: () => ({ id: plan.id, packages: plan.packages.map((p) => ({ ...p, todos: [], dependsOn: [] })), integration: plan.integration }),
    onRunEvent: () => {},
    now: () => 5,
    sleep: async () => {},
    ...deps,
  });
  return { fin, patches };
}

const runPlan = (mode) => ({
  id: 'pabc',
  repoPath: '/r',
  baseBranch: 'main',
  integrationMode: mode,
  integration: { state: 'idle' },
  approvalLog: [],
  notes: '',
  packages: [
    { id: 'a', title: 'A', state: 'pushed', branch: 'luna/a', verify: '', dependsOn: [], todoAts: [] },
    { id: 'b', title: 'B', state: 'stalled', branch: 'luna/b', verify: '', dependsOn: [], todoAts: [] },
  ],
});

test('finalize merge mode: beforePush runs the self-check gate, results land in plan.integration', async () => {
  const plan = runPlan('merge');
  const calls = [];
  const { fin, patches } = finalizerFor(plan, {
    checkCommand: () => 'npm run check',
    runSelfCheck: async (args) => (calls.push(['check', args]), { ...GREEN, manualActions: [{ kind: 'env', what: 'K' }] }),
    runFixup: async () => (calls.push(['fixup']), { ok: true }),
    pushBranch: async () => (calls.push(['push']), { ok: true }),
    integrateMerge: async (args, extra) => {
      calls.push(['merge', args.checkOnly === true]);
      const gate = await extra.beforePush('/wt/int', { merged: ['a'], skipped: [], baseSha: 'abc1234' });
      return gate.ok ? { ok: true, merged: ['a'], skipped: [], headSha: 'h' } : { ok: false, merged: ['a'], skipped: [], stage: 'beforePush', detail: gate.reason };
    },
  });
  await fin.finalize();
  assert.deepEqual(calls[0], ['merge', false]);
  assert.deepEqual(calls[1], ['check', { root: '/wt/int', baseSha: 'abc1234', checkCommand: 'npm run check' }]);
  assert.equal(calls.length, 2);
  assert.equal(plan.integration.state, 'done');
  assert.deepEqual(plan.integration.selfCheck, { tests: 'ok', syntax: 'ok', smoke: 'skipped', fixups: 0, tail: '', pushedIntegrationBranch: null });
  assert.deepEqual(plan.integration.manualActions, [{ kind: 'env', what: 'K' }]);
  assert.deepEqual(patches, [['a', { merged: true }]]);
});

test('finalize merge mode: red twice -> one fix-up, base not pushed, integration branch recorded', async () => {
  const plan = runPlan('merge');
  const fixups = [];
  const pushes = [];
  const { fin, patches } = finalizerFor(plan, {
    runSelfCheck: async () => ({ ...RED, manualActions: [] }),
    runFixup: async (args) => (fixups.push(args), { ok: true }),
    pushBranch: async (root, branch) => (pushes.push(branch), { ok: true }),
    integrateMerge: async (args, extra) => {
      const gate = await extra.beforePush('/wt/int', { merged: ['a'], skipped: [], baseSha: 'abc1234' });
      return gate.ok ? { ok: true, merged: ['a'], skipped: [] } : { ok: false, merged: ['a'], skipped: [], stage: 'beforePush', detail: gate.reason };
    },
  });
  await fin.finalize();
  assert.equal(fixups.length, 1);
  assert.equal(fixups[0].root, '/wt/int');
  assert.match(fixups[0].brief, /npm test/, 'default check command');
  assert.deepEqual(pushes, ['luna/pabc-integration']);
  assert.equal(plan.integration.state, 'failed');
  assert.equal(plan.integration.error, 'selfCheckFailed');
  assert.equal(plan.integration.selfCheck.pushedIntegrationBranch, 'luna/pabc-integration');
  assert.equal(plan.integration.selfCheck.fixups, 1);
  assert.deepEqual(patches, [], 'nothing counts as merged');
});

for (const mode of ['pr', 'branches']) {
  test(`finalize ${mode} mode: a throwaway check-only integration, no fix-up, nothing pushed`, async () => {
    const plan = runPlan(mode);
    const merges = [];
    const pushes = [];
    const { fin } = finalizerFor(plan, {
      createPr: async () => ({ ok: true, url: 'https://github.com/o/r/pull/1' }),
      runSelfCheck: async () => ({ ...RED, manualActions: [{ kind: 'migration', what: '1.sql' }] }),
      runFixup: async () => assert.fail('no fix-up outside merge mode'),
      pushBranch: async (root, branch) => (pushes.push(branch), { ok: true }),
      integrateMerge: async (args, extra) => {
        merges.push(args);
        await extra.beforePush('/wt/chk', { merged: ['a'], skipped: [], baseSha: 'abc1234' });
        return { ok: true, merged: ['a'], skipped: [], checkOnly: true };
      },
    });
    await fin.finalize();
    assert.equal(merges.length, 1);
    assert.equal(merges[0].checkOnly, true);
    assert.deepEqual(merges[0].packages.map((p) => p.id), ['a'], 'only pushed packages');
    assert.notEqual(merges[0].slug, 'pabc', 'never the real integration worktree');
    assert.deepEqual(pushes, []);
    assert.equal(plan.integration.state, 'done');
    assert.equal(plan.integration.selfCheck.tests, 'failed');
    assert.equal(plan.integration.selfCheck.fixups, 0);
    assert.equal(plan.integration.selfCheck.pushedIntegrationBranch, null);
    assert.deepEqual(plan.integration.manualActions, [{ kind: 'migration', what: '1.sql' }]);
  });
}

test('finalize without self-check deps behaves as before (no selfCheck recorded)', async () => {
  const plan = runPlan('branches');
  const { fin } = finalizerFor(plan, {});
  await fin.finalize();
  assert.equal(plan.integration.state, 'done');
  assert.equal(plan.integration.selfCheck, undefined);
});

// ---- orchestra.runFixup ---------------------------------------------------------

const turn = (text) =>
  JSON.stringify({ type: 'assistant', message: { stop_reason: 'end_turn', content: [{ type: 'text', text }] } });

function orchSetup() {
  let seq = 0;
  const log = { sessions: [], closed: [], briefs: new Map(), writes: [] };
  const timers = [];
  const alive = new Set();
  const orch = createOrchestra({
    now: () => 1_000_000,
    readTodos: () => [{ at: 1, text: 't1', done: false }],
    dirtyCount: async () => 0,
    runPlanner: async () => ({
      ok: true,
      raw: { packages: [{ id: 'a', title: 'A', todoAts: [1], prompt: 'x', files: [], dependsOn: [], verify: '', model: 'sonnet' }], notes: '' },
      costUsd: 0,
    }),
    addWorktree: async (_r, name) => ({ ok: true, root: `/wt/${name}`, cwd: `/wt/${name}`, branch: `luna/${name}` }),
    headSha: async () => 'base',
    briefDir: () => '/cfg/tasks',
    writeBrief: (file, text) => (log.briefs.set(file, text), true),
    createSession: (opts) => {
      seq += 1;
      log.sessions.push(opts);
      alive.add(`s${seq}`);
      return { id: `s${seq}` };
    },
    closeSession: (id) => (log.closed.push(id), alive.delete(id)),
    writePty: (id, text) => (log.writes.push([id, text]), alive.has(id)),
    sessionAlive: (id) => alive.has(id),
    workerSettings: () => ({ model: 'opus', permissionMode: 'acceptEdits' }),
    setTimer: (fn, ms) => {
      const t = { fn, ms, done: false };
      timers.push(t);
      return t;
    },
    clearTimer: (t) => {
      if (t) t.done = true;
    },
  });
  return { orch, log, timers, alive };
}

test('runFixup: a normal tab in the integration worktree, resolves on LUNA_DONE selfcheck, closes the tab', async () => {
  const s = orchSetup();
  const { plan } = await s.orch.makePlan({ projectId: 'p1', repoPath: '/repo', profileId: 'cloud', env: {} });
  const before = JSON.stringify(s.orch.view());
  const pending = s.orch.runFixup({ root: '/wt/int', brief: 'fix it' });
  assert.equal(s.log.sessions.length, 1);
  const opened = s.log.sessions[0];
  assert.equal(opened.cwd, '/wt/int');
  assert.equal(opened.profileId, 'cloud');
  assert.equal(opened.task.permissionMode, 'acceptEdits');
  assert.equal(s.log.briefs.get(opened.task.briefPath), 'fix it');
  assert.ok(opened.task.briefPath.includes(plan.id));
  assert.equal(s.orch.ownsSession('s1'), false, 'not a package');

  s.orch.onTurnEnd('s1', turn('working on it'));
  s.orch.onTurnEnd('s1', turn('done\nLUNA_DONE selfcheck'));
  assert.deepEqual(await pending, { ok: true });
  assert.deepEqual(s.log.closed, ['s1']);
  assert.equal(JSON.stringify(s.orch.view()), before, 'the run itself is untouched');
});

test('runFixup: the 45 min cap resolves {ok:false} and closes the tab; a closed tab resolves too; one at a time', async () => {
  const s = orchSetup();
  await s.orch.makePlan({ projectId: 'p1', repoPath: '/repo', profileId: 'cloud', env: {} });
  const pending = s.orch.runFixup({ root: '/wt/int', brief: 'b' });
  const busy = await s.orch.runFixup({ root: '/wt/int', brief: 'b' });
  assert.deepEqual(busy, { ok: false });
  const cap = s.timers.find((t) => !t.done);
  assert.equal(cap.ms, 45 * 60 * 1000);
  cap.fn();
  assert.deepEqual(await pending, { ok: false });
  assert.deepEqual(s.log.closed, ['s1']);

  const second = s.orch.runFixup({ root: '/wt/int', brief: 'b' });
  s.orch.onSessionClosed('s2');
  assert.deepEqual(await second, { ok: false });

  const blocked = s.orch.runFixup({ root: '/wt/int', brief: 'b' });
  s.orch.onTurnEnd('s3', turn('LUNA_BLOCKED selfcheck: cannot'));
  assert.deepEqual(await blocked, { ok: false });
});

test('runFixup without a plan or a tab resolves {ok:false}', async () => {
  const s = orchSetup();
  assert.deepEqual(await s.orch.runFixup({ root: '/wt/int', brief: 'b' }), { ok: false });
});

// ---- Settings: Final check command ----------------------------------------------

test('uiprefs checkCommandOf: one trimmed line up to 200 chars, else rejected (default npm test kept)', () => {
  const { checkCommandOf } = require('../src/uiprefs.js');
  assert.equal(checkCommandOf('  npm run check '), 'npm run check');
  assert.equal(checkCommandOf(''), null);
  assert.equal(checkCommandOf('   '), null);
  assert.equal(checkCommandOf('npm test\nrm -rf /'), null);
  assert.equal(checkCommandOf('x'.repeat(201)), null);
  assert.equal(checkCommandOf(42), null);
});

test('Settings field: final check command has pl + en strings and an input in the God Mode v2 section', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'index.html'), 'utf8');
  assert.match(html, /id="orchestra-check-command"/);
  const i18n = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'i18n.js'), 'utf8');
  for (const key of ['orchset.check', 'orchset.check.hint']) {
    assert.equal(i18n.split(`'${key}':`).length - 1, 2, `${key} in pl and en`);
  }
});
