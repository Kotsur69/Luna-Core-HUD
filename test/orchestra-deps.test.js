// ============================================================================
// God Mode package worktree dependencies (src/orchestraDeps.js + its wiring
// in src/orchestra.js): LunaCore installs each worktree's own node_modules
// before the worker starts, one install at a time; an empty / broken
// node_modules holds the whole run ('noNodeModules') until Resume, with no
// package stalled for it.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const {
  createInstallQueue,
  installWorktreeDeps,
  checkNodeModules,
  noNodeModulesText,
  WORKER_NPM_COMMAND,
} = require('../src/orchestraDeps.js');
const { createOrchestra, briefText } = require('../src/orchestra.js');
const { ensureInstall } = require('../src/orchestraIntegrate.js');

const REPO_ROOT = path.join(__dirname, '..');

const turn = (text) =>
  JSON.stringify({ type: 'assistant', message: { stop_reason: 'end_turn', content: [{ type: 'text', text }] } });

const pkg = (id, todoAts, extra = {}) => ({
  id,
  title: `T ${id}`,
  todoAts,
  prompt: `do ${id}`,
  files: [],
  dependsOn: [],
  verify: 'npm test',
  model: 'sonnet',
  ...extra,
});

const flush = async (n = 6) => {
  for (let i = 0; i < n; i += 1) await new Promise((r) => setImmediate(r));
};

/** A fake fs over a {path: content | 'DIR' | string[] (dir listing)} map. */
function fakeFs(entries) {
  const norm = (p) => path.resolve(p);
  const map = new Map(Object.entries(entries).map(([k, v]) => [norm(k), v]));
  return {
    existsSync: (p) => map.has(norm(p)),
    statSync: (p) => {
      if (!map.has(norm(p))) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      const v = map.get(norm(p));
      return { isDirectory: () => Array.isArray(v) };
    },
    readdirSync: (p) => {
      const v = map.get(norm(p));
      if (!Array.isArray(v)) throw new Error('ENOTDIR');
      return v;
    },
    readFileSync: (p) => {
      const v = map.get(norm(p));
      if (typeof v !== 'string') throw new Error('ENOENT');
      return v;
    },
  };
}

const PKG_JSON = JSON.stringify({ dependencies: { pngjs: '^7.0.0' }, devDependencies: { '@scope/tool': '1.0.0' } });
const project = (extra) => ({
  '/w/package.json': PKG_JSON,
  '/w/package-lock.json': '{}',
  ...extra,
});

// ---- the check -----------------------------------------------------------------

test('checkNodeModules passes a folder that needs no node_modules', () => {
  assert.deepEqual(checkNodeModules('/w', fakeFs({})), { ok: true, needed: false }, 'no lockfile');
  assert.deepEqual(
    checkNodeModules('/w', fakeFs({ '/w/package.json': '{}', '/w/package-lock.json': '{}' })),
    { ok: true, needed: false },
    'no declared dependency',
  );
  assert.deepEqual(checkNodeModules(null), { ok: true, needed: false });
});

test('checkNodeModules fails a missing, empty or incomplete node_modules', () => {
  const missing = checkNodeModules('/w', fakeFs(project({})));
  assert.deepEqual([missing.ok, missing.reason, missing.dir], [false, 'missing', '/w']);

  // An emptied junction target: only npm's own bookkeeping left.
  const empty = checkNodeModules('/w', fakeFs(project({ '/w/node_modules': ['.package-lock.json', '.bin'] })));
  assert.deepEqual([empty.ok, empty.reason], [false, 'empty']);

  const partial = checkNodeModules(
    '/w',
    fakeFs(project({ '/w/node_modules': ['pngjs'], '/w/node_modules/pngjs/package.json': '{}' })),
  );
  assert.deepEqual([partial.ok, partial.reason], [false, 'unresolved']);
  assert.match(partial.detail, /@scope\/tool/);

  const good = checkNodeModules(
    '/w',
    fakeFs(
      project({
        '/w/node_modules': ['pngjs', '@scope'],
        '/w/node_modules/pngjs/package.json': '{}',
        '/w/node_modules/@scope/tool/package.json': '{}',
      }),
    ),
  );
  assert.deepEqual(good, { ok: true, needed: true });
});

test('checkNodeModules on real folders: an empty node_modules fails, a dangling link fails', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-deps-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));
  fs.writeFileSync(path.join(dir, 'package.json'), PKG_JSON);
  fs.writeFileSync(path.join(dir, 'package-lock.json'), '{}');
  fs.mkdirSync(path.join(dir, 'node_modules'));
  assert.equal(checkNodeModules(dir).reason, 'empty');
  fs.rmdirSync(path.join(dir, 'node_modules'));
  // A junction to a folder that was removed (the old hand-made link).
  const gone = path.join(dir, 'gone');
  fs.mkdirSync(gone);
  try {
    fs.symlinkSync(gone, path.join(dir, 'node_modules'), 'junction');
  } catch {
    t.skip('cannot create a junction here');
    return;
  }
  fs.rmdirSync(gone);
  assert.equal(checkNodeModules(dir).ok, false);
});

test('the board / notification text names the folder', () => {
  assert.equal(noNodeModulesText('C:/repo'), 'node_modules in C:/repo is empty - run npm install, then Resume');
  const i18n = fs.readFileSync(path.join(REPO_ROOT, 'src', 'renderer', 'i18n.js'), 'utf8');
  const lines = i18n.split(/\r?\n/).filter((l) => l.includes("'orch.noNodeModules'"));
  assert.equal(lines.length, 2, 'pl + en');
  assert.ok(lines.some((l) => l.includes('node_modules in {repo} is empty - run npm install, then Resume')));
  for (const l of lines) assert.doesNotMatch(l, /[ąćęłńóśźżĄĆĘŁŃÓŚŹŻ]/, 'Polish without diacritics');
});

// ---- the install -----------------------------------------------------------------

test('installWorktreeDeps runs npm ci --ignore-scripts in the worktree', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-deps-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));
  fs.writeFileSync(path.join(dir, 'package-lock.json'), '{}');
  const calls = [];
  const res = await installWorktreeDeps(dir, {
    queue: createInstallQueue(),
    verifyImpl: async (cmd, cwd) => {
      calls.push([cmd, cwd]);
      return { ok: true, output: '' };
    },
  });
  assert.equal(res.ok, true);
  assert.equal(WORKER_NPM_COMMAND, 'npm ci --ignore-scripts');
  assert.deepEqual(calls, [['npm ci --ignore-scripts', dir]]);
  // The integration worktree keeps its plain npm ci.
  calls.length = 0;
  await ensureInstall(dir, async (cmd, cwd) => {
    calls.push([cmd, cwd]);
    return { ok: true, output: '' };
  });
  assert.deepEqual(calls, [['npm ci', dir]]);
});

test('installs run one at a time; a throwing install does not block the next', async () => {
  const queue = createInstallQueue();
  let running = 0;
  let maxRunning = 0;
  const order = [];
  const job = (name, fail) => async () => {
    running += 1;
    maxRunning = Math.max(maxRunning, running);
    order.push(`start ${name}`);
    await flush(2);
    order.push(`end ${name}`);
    running -= 1;
    if (fail) throw new Error(`${name} broke`);
    return { ok: true, output: '' };
  };
  const results = await Promise.all([queue.run(job('a')), queue.run(job('b', true)), queue.run(job('c'))]);
  assert.equal(maxRunning, 1);
  assert.deepEqual(order, ['start a', 'end a', 'start b', 'end b', 'start c', 'end c']);
  assert.deepEqual(results.map((r) => r.ok), [true, false, true]);
  assert.match(results[1].output, /b broke/);
  assert.equal(queue.pending(), 0);
});

test('plain npm test can load pngjs: node_modules is the checkout own folder, no NODE_PATH, no junction', () => {
  const nm = path.join(REPO_ROOT, 'node_modules');
  assert.equal(fs.lstatSync(nm).isSymbolicLink(), false, 'node_modules is not a link to another checkout');
  const env = { ...process.env };
  delete env.NODE_PATH;
  const res = spawnSync(process.execPath, ['-e', "require('pngjs'); require('./src/lunasworkPlaytest.js')"], {
    cwd: REPO_ROOT,
    env,
    encoding: 'utf8',
  });
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(checkNodeModules(REPO_ROOT), { ok: true, needed: true });
});

test('the worker brief says dependencies are installed and forbids linking or reinstalling them', () => {
  const text = briefText(pkg('a', [1]), 'luna/a-1');
  assert.match(text, /Dependencies are already installed in this worktree/);
  assert.match(text, /Do not link node_modules to another checkout/);
  assert.match(text, /do not reinstall/);
});

// ---- the controller -----------------------------------------------------------------

function setup({ packages, install, check, queue } = {}) {
  let seq = 0;
  const log = { order: [], sessions: [], events: [], worktrees: [], finishes: [], installs: [], installOpts: [], checks: [] };
  const alive = new Set();
  const orch = createOrchestra({
    now: () => 1_000_000,
    readTodos: () => [1, 2, 3, 4].map((at) => ({ at, text: `t${at}`, done: false })),
    dirtyCount: async () => 0,
    runPlanner: async () => ({ ok: true, raw: { packages, notes: '' }, costUsd: 0 }),
    addWorktree: async (repo, name) => {
      log.worktrees.push(name);
      log.order.push(`worktree ${name.split('-')[0]}`);
      return { ok: true, root: path.join('/wt', name), cwd: path.join('/wt', name), branch: `luna/${name}` };
    },
    headSha: async () => 'base',
    briefDir: () => '/cfg/tasks',
    writeBrief: () => true,
    createSession: (opts) => {
      seq += 1;
      log.sessions.push(opts);
      log.order.push(`tab ${path.basename(opts.cwd).split('-')[0]}`);
      alive.add(`s${seq}`);
      return { id: `s${seq}` };
    },
    closeSession: (id) => alive.delete(id),
    sessionAlive: (id) => alive.has(id),
    writePty: (id) => alive.has(id),
    finishPackage: async (p) => {
      log.finishes.push(p.id);
      return { ok: true, headSha: `${p.id}aaaaaaa` };
    },
    installDeps: (root, opts) => {
      const run = async () => {
        log.installs.push(root);
        log.installOpts.push(opts || {});
        log.order.push(`install ${path.basename(root).split('-')[0]}`);
        return install ? install(root) : { ok: true, output: '' };
      };
      return queue ? queue.run(run) : run();
    },
    checkDeps: (root) => {
      log.checks.push(root);
      return check ? check(root) : { ok: true, needed: true };
    },
    workerSettings: () => ({ model: 'opus', permissionMode: 'bypassPermissions' }),
    onRunEvent: (kind, data) => log.events.push([kind, data]),
    sleep: async () => {},
    setTimer: () => ({}),
    clearTimer: () => {},
  });
  const ctx = { projectId: 'p1', repoPath: '/repo', profileId: 'cloud', env: {} };
  const view = (id) => orch.view().packages.find((p) => p.id === id);
  return { orch, log, ctx, view, alive };
}

async function started(opts) {
  const s = setup(opts);
  const { plan } = await s.orch.makePlan(s.ctx);
  const res = await s.orch.launch({ planId: plan.id });
  return { ...s, planId: plan.id, launchRes: res };
}

test('a newly launched package worktree gets its install before the worker starts', async () => {
  const s = await started({ packages: [pkg('a', [1]), pkg('b', [2])] });
  assert.deepEqual(s.log.order, ['worktree a', 'install a', 'tab a', 'worktree b', 'install b', 'tab b']);
  assert.equal(s.log.installs[0], path.join('/wt', s.log.worktrees[0]));
  assert.deepEqual([s.view('a').state, s.view('b').state], ['launched', 'launched']);
});

test('an install failure stalls the package with its own error and the output tail', async () => {
  const output = Array.from({ length: 40 }, (_, i) => `npm line ${i}`).join('\n') + '\nnpm ERR! code ECONNRESET';
  const s = await started({
    packages: [pkg('a', [1]), pkg('b', [2])],
    install: (root) => (root.includes(`${path.sep}a-`) ? { ok: false, output } : { ok: true, output: '' }),
  });
  const a = s.view('a');
  assert.deepEqual([a.state, a.error, a.detail, a.terminal], ['stalled', 'installFailed', 'npm ERR! code ECONNRESET', true]);
  assert.match(a.verifyTail, /npm line 39\nnpm ERR! code ECONNRESET$/);
  assert.doesNotMatch(a.verifyTail, /npm line 0\n/, 'only the tail');
  assert.ok(a.branch, 'the worktree is kept for Retry');
  assert.equal(s.log.sessions.length, 1, 'no worker tab for a');
  assert.equal(s.view('b').state, 'launched', 'the other package goes on');
  assert.equal(s.orch.view().hold, null, 'an install failure is the package, not a run hold');
  assert.ok(s.log.events.some(([k, d]) => k === 'stalled' && d.reason === 'installFailed'));

  // Retry installs again in the same worktree and then opens the worker.
  const before = s.log.worktrees.length;

  const res = await s.orch.retry({ planId: s.planId, id: 'a' });
  assert.equal(res.ok, false, 'still failing');
  assert.equal(res.error, 'installFailed');
  assert.equal(s.log.worktrees.length, before, 'no new worktree');
});

test('Retry after a fixed install opens the worker in the same worktree', async () => {
  let fail = true;
  const s = await started({
    packages: [pkg('a', [1])],
    install: () => (fail ? { ok: false, output: 'boom' } : { ok: true, output: '' }),
  });
  assert.equal(s.view('a').error, 'installFailed');
  fail = false;
  const res = await s.orch.retry({ planId: s.planId, id: 'a' });
  assert.equal(res.ok, true);
  assert.equal(s.view('a').state, 'launched');
  assert.equal(s.log.worktrees.length, 1);
  assert.equal(s.log.installs.length, 2);
});

test('installs of parallel launches run serially through one queue', async () => {
  const queue = createInstallQueue();
  let running = 0;
  let maxRunning = 0;
  const install = async () => {
    running += 1;
    maxRunning = Math.max(maxRunning, running);
    await flush(3);
    running -= 1;
    return { ok: true, output: '' };
  };
  // Two projects' runs launching at the same time share the process queue.
  const one = setup({ packages: [pkg('a', [1]), pkg('b', [2])], install, queue });
  const two = setup({ packages: [pkg('c', [1])], install, queue });
  const [p1, p2] = await Promise.all([one.orch.makePlan(one.ctx), two.orch.makePlan(two.ctx)]);
  await Promise.all([one.orch.launch({ planId: p1.plan.id }), two.orch.launch({ planId: p2.plan.id })]);
  assert.equal(maxRunning, 1);
  assert.equal(one.log.installs.length + two.log.installs.length, 3);
  assert.equal(one.view('b').state, 'launched');
  assert.equal(two.view('c').state, 'launched');
});

test('an empty node_modules refuses the launch and holds the run; Resume after the fix continues', async () => {
  let broken = true;
  const check = (root) =>
    broken ? { ok: false, reason: 'empty', dir: root, detail: `${root}/node_modules is empty` } : { ok: true, needed: true };
  const s = await started({ packages: [pkg('a', [1]), pkg('b', [2])], check });

  // No worker started, the whole run held, no package stalled for it.
  assert.equal(s.log.sessions.length, 0);
  const hold = s.orch.view().hold;
  assert.equal(hold.reason, 'noNodeModules');
  assert.equal(hold.dir, path.join('/wt', s.log.worktrees[0]));
  assert.equal(s.log.worktrees.length, 1, 'b is not launched while the run is held');
  assert.deepEqual(s.orch.view().packages.map((p) => p.state), ['pending', 'pending']);
  assert.ok(s.orch.view().packages.every((p) => p.state !== 'stalled' && !p.terminal));
  assert.equal(s.log.events.filter(([k]) => k === 'noNodeModules').length, 1, 'one message');
  assert.equal((await s.orch.retry({ planId: s.planId, id: 'b' })).error, 'notRetryable');
  assert.equal((await s.orch.launch({ planId: s.planId, ids: ['b'] })).error, 'noNodeModules');

  // Resume while still broken: stays held.
  const still = await s.orch.resumeRun({ planId: s.planId });
  assert.deepEqual([still.ok, still.error], [false, 'noNodeModules']);
  assert.ok(s.orch.view().hold);

  // Mati runs npm install, then Resume: a starts in the SAME worktree, b launches.
  broken = false;
  const res = await s.orch.resumeRun({ planId: s.planId });
  assert.equal(res.ok, true);
  assert.equal(s.orch.view().hold, null);
  assert.deepEqual(s.orch.view().packages.map((p) => p.state), ['launched', 'launched']);
  assert.equal(s.log.worktrees.length, 2, 'a kept its worktree');
  assert.equal(s.log.sessions[0].cwd, path.join('/wt', s.log.worktrees[0]));
  assert.equal((await s.orch.resumeRun({ planId: s.planId })).error, 'notHeld');
});

test('LUNA_DONE with a broken node_modules waits for Resume instead of verifying or stalling', async () => {
  let broken = false;
  const check = (root) => (broken ? { ok: false, reason: 'missing', dir: root, detail: 'gone' } : { ok: true, needed: true });
  const s = await started({ packages: [pkg('a', [1]), pkg('b', [2], { dependsOn: ['a'] })], check });
  assert.equal(s.view('a').state, 'launched');

  broken = true;
  s.orch.onTurnEnd('s1', turn('LUNA_DONE a'));
  await flush();
  assert.deepEqual(s.log.finishes, [], 'no verify without dependencies');
  const a = s.view('a');
  assert.deepEqual([a.state, a.awaitingDeps, a.error], ['launched', true, null]);
  assert.equal(s.orch.view().hold.reason, 'noNodeModules');
  assert.equal(s.orch.view().settled, false);

  broken = false;
  assert.equal((await s.orch.resumeRun({ planId: s.planId })).ok, true);
  await flush();
  assert.deepEqual(s.log.finishes, ['a']);
  assert.equal(s.view('a').state, 'pushed');
  assert.equal(s.view('a').awaitingDeps, false);
  assert.equal(s.view('b').state, 'launched', 'the dependent starts after the push');
});

test('a Retry refused for node_modules is reopened by Resume', async () => {
  let broken = false;
  const check = (root) => (broken ? { ok: false, reason: 'empty', dir: root, detail: 'empty' } : { ok: true, needed: true });
  const s = await started({ packages: [pkg('a', [1])], check });
  s.alive.clear();
  s.orch.onSessionClosed('s1');
  assert.equal(s.view('a').state, 'closed');
  await flush(10);

  broken = true;
  const res = await s.orch.retry({ planId: s.planId, id: 'a' });
  assert.deepEqual([res.ok, res.error], [false, 'noNodeModules']);
  assert.equal(s.view('a').state, 'closed', 'not stalled for it');
  assert.equal(s.log.sessions.length, 1);

  broken = false;
  assert.equal((await s.orch.resumeRun({ planId: s.planId })).ok, true);
  assert.equal(s.view('a').state, 'launched');
  assert.equal(s.log.sessions.length, 2);
});

test('a kill ends the hold', async () => {
  const s = await started({
    packages: [pkg('a', [1])],
    check: (root) => ({ ok: false, reason: 'empty', dir: root, detail: 'empty' }),
  });
  assert.ok(s.orch.view().hold);
  s.orch.kill();
  assert.equal(s.orch.view().hold, null);
});

test('a fresh install after a failed one removes the partial node_modules first, never a link', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-deps-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));
  fs.writeFileSync(path.join(dir, 'package-lock.json'), '{}');
  fs.mkdirSync(path.join(dir, 'node_modules', 'half'), { recursive: true });
  const calls = [];
  const verifyImpl = async (cmd) => {
    calls.push(cmd);
    return { ok: true, output: '' };
  };
  // Not fresh: the partial folder makes the install a no-op.
  await installWorktreeDeps(dir, { queue: createInstallQueue(), verifyImpl });
  assert.deepEqual(calls, []);
  await installWorktreeDeps(dir, { queue: createInstallQueue(), verifyImpl, fresh: true });
  assert.deepEqual(calls, ['npm ci --ignore-scripts']);

  // A link is left alone (its target may be another checkout's node_modules).
  fs.rmSync(path.join(dir, 'node_modules'), { recursive: true, force: true });
  const target = path.join(dir, 'other-checkout-nm');
  fs.mkdirSync(path.join(target, 'precious'), { recursive: true });
  try {
    fs.symlinkSync(target, path.join(dir, 'node_modules'), 'junction');
  } catch {
    t.skip('cannot create a junction here');
    return;
  }
  const res = await installWorktreeDeps(dir, { queue: createInstallQueue(), verifyImpl, fresh: true });
  assert.equal(res.ok, false);
  assert.match(res.output, /is a link/);
  assert.ok(fs.existsSync(path.join(target, 'precious')), 'the link target is untouched');
});

test('Retry of an install-failed package asks for a fresh install', async () => {
  let fail = true;
  const s = await started({
    packages: [pkg('a', [1])],
    install: () => (fail ? { ok: false, output: 'boom' } : { ok: true, output: '' }),
  });
  await flush(10);
  assert.equal(s.view('a').error, 'installFailed');
  fail = false;
  assert.equal((await s.orch.retry({ planId: s.planId, id: 'a' })).ok, true);
  assert.deepEqual(
    s.log.installOpts.map((o) => o.fresh === true),
    [false, true],
    'the first install is plain, the retry starts from scratch',
  );
});

test('a kill during a launch install leaves no hold and no held launch; Resume refuses a killed or paused run', async () => {
  let release;
  const gate = new Promise((r) => {
    release = r;
  });
  const s = setup({
    packages: [pkg('a', [1])],
    install: async () => {
      await gate;
      return { ok: true, output: '' };
    },
    check: (root) => ({ ok: false, reason: 'empty', dir: root, detail: 'empty' }),
  });
  const { plan } = await s.orch.makePlan(s.ctx);
  const launching = s.orch.launch({ planId: plan.id });
  await flush();
  s.orch.kill();
  release();
  await launching;
  await flush();
  assert.equal(s.orch.view().hold, null);
  assert.equal(s.log.sessions.length, 0);
  assert.equal((await s.orch.resumeRun({ planId: plan.id })).error, 'notHeld');
});
