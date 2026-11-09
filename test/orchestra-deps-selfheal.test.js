// ============================================================================
// God Mode: a broken package node_modules heals itself
// (src/orchestraDeps.js, src/orchestraHoldWatch.js, src/plainFs.js, and the
// hold in src/orchestra.js):
//   - a fresh install removes nothing when node_modules already passes,
//   - never removes while another install for the same root is in flight,
//   - a remove that fails on a held file (EBUSY) installs in a sibling temp
//     folder and moves the entries in (electron's dist/ untouched),
//   - a 'noNodeModules' hold resumes on its own once the folders pass, and
//     its timer goes with kill / discard / resume,
//   - the hold names the real reason and the missing package.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  createInstallQueue,
  installWorktreeDeps,
  installInFlight,
  checkNodeModules,
  LOCKED_TEXT,
} = require('../src/orchestraDeps.js');
const { plainFs } = require('../src/plainFs.js');
const { createHoldWatch, HOLD_RECHECK_MS } = require('../src/orchestraHoldWatch.js');
const { createOrchestra } = require('../src/orchestra.js');

const flush = async (n = 8) => {
  for (let i = 0; i < n; i += 1) await new Promise((r) => setImmediate(r));
};

const DEPS = { pngjs: '^7.0.0', electron: '^30.0.0' };
const DEV_DEPS = { '@scope/tool': '1.0.0' };

/** A worktree folder under a fresh "worktrees dir": package.json + lockfile. */
function worktree(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-selfheal-'));
  t.after(() => fs.promises.rm(base, { recursive: true, force: true, maxRetries: 5 }));
  const root = path.join(base, 'wt-a');
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ dependencies: DEPS, devDependencies: DEV_DEPS }));
  fs.writeFileSync(path.join(root, 'package-lock.json'), '{}');
  return { base, root, nm: path.join(root, 'node_modules') };
}

function writeFile(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

/** The incident: an aborted Electron postinstall left only a partial default_app.asar. */
function brokenInstall(nm) {
  writeFile(path.join(nm, 'electron', 'dist', 'resources', 'default_app.asar'), 'PARTIAL');
  writeFile(path.join(nm, 'pngjs', 'package.json'), '{"name":"pngjs","kept":true}');
}

/** A real fs whose recursive rm of `lockedDir` fails as if a file in it were held open. */
function lockingFs(lockedDir, rmCalls = []) {
  return {
    ...fs,
    promises: {
      ...fs.promises,
      rm: async (p, opts) => {
        rmCalls.push(path.resolve(p));
        if (path.resolve(p) === path.resolve(lockedDir)) {
          throw Object.assign(new Error(`EBUSY: resource busy or locked, rmdir '${lockedDir}'`), { code: 'EBUSY' });
        }
        return fs.promises.rm(p, opts);
      },
    },
  };
}

/** npm ci in the temp folder: writes a complete node_modules there. */
function tempNpm(calls) {
  return async (cmd, cwd) => {
    calls.push([cmd, cwd]);
    const nm = path.join(cwd, 'node_modules');
    writeFile(path.join(nm, 'pngjs', 'package.json'), '{"name":"pngjs","fromTemp":true}');
    writeFile(path.join(nm, 'electron', 'package.json'), '{"name":"electron"}');
    writeFile(path.join(nm, 'electron', 'index.js'), 'module.exports = "electron";');
    writeFile(path.join(nm, '@scope', 'tool', 'package.json'), '{"name":"@scope/tool"}');
    writeFile(path.join(nm, '.bin', 'tool'), '#!/bin/sh');
    writeFile(path.join(nm, '.package-lock.json'), '{}');
    return { ok: true, output: 'added 3 packages' };
  };
}

// ---- plainFs ------------------------------------------------------------------

test('plainFs: original-fs inside Electron, plain fs under node or when it cannot load', () => {
  assert.equal(plainFs(), fs, 'node: plain fs');
  assert.equal(plainFs({ node: '24' }), fs);
  const original = { tag: 'original-fs' };
  assert.equal(plainFs({ electron: '30.0.0' }, (id) => (id === 'original-fs' ? original : null)), original);
  assert.equal(
    plainFs({ electron: '30.0.0' }, () => {
      throw new Error('Cannot find module');
    }),
    fs,
  );
});

// ---- the fresh install ---------------------------------------------------------------

test('an rm that fails with EBUSY installs in a sibling temp folder; node_modules then passes', async (t) => {
  const { base, root, nm } = worktree(t);
  brokenInstall(nm);
  // The failed remove emptied @scope/tool part-way: a husk without package.json.
  writeFile(path.join(nm, '@scope', 'tool', 'lib', 'half.js'), 'half');
  // A crashed earlier temp-folder install of this package.
  writeFile(path.join(base, '_deps-wt-a-1', 'node_modules', 'junk', 'x.js'), 'x');
  assert.deepEqual([checkNodeModules(root).ok, checkNodeModules(root).reason], [false, 'unresolved']);
  const rmCalls = [];
  const npmCalls = [];
  const res = await installWorktreeDeps(root, {
    fresh: true,
    queue: createInstallQueue(),
    fsImpl: lockingFs(nm, rmCalls),
    verifyImpl: tempNpm(npmCalls),
    now: () => 4242,
  });
  assert.equal(res.ok, true, res.output);
  assert.deepEqual(checkNodeModules(root), { ok: true, needed: true });

  // npm ci --ignore-scripts ran once, in <worktrees dir>/_deps-<pkg>-<ts>.
  const temp = path.join(base, '_deps-wt-a-4242');
  assert.deepEqual(npmCalls, [['npm ci --ignore-scripts', temp]]);
  assert.equal(fs.existsSync(temp), false, 'the temp folder is removed afterwards');
  assert.ok(rmCalls.includes(path.resolve(temp)), 'removed with the injected (plain) fs');

  // Moved in: what was missing. Kept: what was there. electron's dist/ untouched.
  assert.ok(fs.existsSync(path.join(nm, '@scope', 'tool', 'package.json')));
  assert.equal(fs.existsSync(path.join(nm, '@scope', 'tool', 'lib', 'half.js')), false, 'the husk was replaced, not kept');
  assert.equal(fs.existsSync(path.join(base, '_deps-wt-a-1')), false, 'the leftover temp folder is gone');
  assert.ok(fs.existsSync(path.join(nm, 'electron', 'package.json')));
  assert.ok(fs.existsSync(path.join(nm, 'electron', 'index.js')));
  assert.ok(fs.existsSync(path.join(nm, '.bin', 'tool')));
  assert.equal(JSON.parse(fs.readFileSync(path.join(nm, 'pngjs', 'package.json'), 'utf8')).kept, true, 'existing entries are skipped');
  assert.equal(fs.readFileSync(path.join(nm, 'electron', 'dist', 'resources', 'default_app.asar'), 'utf8'), 'PARTIAL');
  assert.equal(installInFlight(root), false);
});

test('the temp-folder route that still cannot fix it reports a file locked by LunaCore', async (t) => {
  const { base, root, nm } = worktree(t);
  brokenInstall(nm);
  const res = await installWorktreeDeps(root, {
    fresh: true,
    queue: createInstallQueue(),
    fsImpl: lockingFs(nm),
    verifyImpl: async () => ({ ok: false, output: 'npm ERR! code ECONNRESET' }),
    now: () => 7,
  });
  assert.equal(res.ok, false);
  assert.equal(res.locked, true);
  assert.equal(res.output.trim().split('\n').pop(), LOCKED_TEXT);
  assert.match(LOCKED_TEXT, /locked by LunaCore - restart LunaCore/);
  assert.equal(fs.existsSync(path.join(base, '_deps-wt-a-7')), false, 'the temp folder is removed on failure too');
});

test('the fresh rm is skipped when node_modules already passes the check', async (t) => {
  const { root, nm } = worktree(t);
  writeFile(path.join(nm, 'pngjs', 'package.json'), '{}');
  writeFile(path.join(nm, 'electron', 'package.json'), '{}');
  writeFile(path.join(nm, '@scope', 'tool', 'package.json'), '{}');
  const rmCalls = [];
  const npmCalls = [];
  const res = await installWorktreeDeps(root, {
    fresh: true,
    queue: createInstallQueue(),
    fsImpl: lockingFs(path.join(root, 'nothing-is-locked'), rmCalls),
    verifyImpl: async (cmd, cwd) => {
      npmCalls.push([cmd, cwd]);
      return { ok: true, output: '' };
    },
  });
  assert.equal(res.ok, true);
  assert.deepEqual(rmCalls, [], 'nothing removed');
  assert.deepEqual(npmCalls, [], 'nothing reinstalled');
  assert.ok(fs.existsSync(path.join(nm, 'pngjs', 'package.json')));
});

test('never removes while another install for the same root is in flight', async () => {
  const root = path.join(os.tmpdir(), 'luna-selfheal-guard', 'wt-g');
  let release;
  const gate = new Promise((r) => {
    release = r;
  });
  const order = [];
  const fsImpl = {
    lstatSync: () => ({ isSymbolicLink: () => false, isDirectory: () => true }),
    promises: {
      rm: async () => {
        order.push('rm');
      },
    },
  };
  // Separate queues: the per-root guard, not the shared queue, keeps them apart.
  const plain = installWorktreeDeps(root, {
    queue: createInstallQueue(),
    installImpl: async () => {
      order.push('plain start');
      await gate;
      order.push('plain end');
      return { ok: true, output: '' };
    },
  });
  const fresh = installWorktreeDeps(root, {
    fresh: true,
    queue: createInstallQueue(),
    fsImpl,
    checkImpl: () => ({ ok: false, reason: 'empty', dir: root, detail: 'empty' }),
    installImpl: async () => {
      order.push('fresh install');
      return { ok: true, output: '' };
    },
  });
  // A second fresh request joins the one in flight instead of queueing a second rm.
  const again = installWorktreeDeps(root, { fresh: true, queue: createInstallQueue(), fsImpl });
  assert.equal(again, fresh);
  assert.equal(installInFlight(root), true);
  await flush();
  assert.deepEqual(order, ['plain start'], 'no rm while the plain install runs');
  release();
  await Promise.all([plain, fresh, again]);
  assert.deepEqual(order, ['plain start', 'plain end', 'rm', 'fresh install']);
  assert.equal(installInFlight(root), false);
});

test('a fresh install still runs when the install before it rejected', async () => {
  const root = path.join(os.tmpdir(), 'luna-selfheal-guard', 'wt-r');
  const broken = installWorktreeDeps(root, { queue: { run: () => Promise.reject(new Error('queue broke')) } });
  const ran = [];
  const fresh = installWorktreeDeps(root, {
    fresh: true,
    queue: createInstallQueue(),
    checkImpl: () => ({ ok: true, needed: true }),
    installImpl: async () => {
      ran.push('fresh');
      return { ok: true, output: '' };
    },
  });
  await assert.rejects(broken, /queue broke/);
  assert.deepEqual(await fresh, { ok: true, output: '' });
  assert.deepEqual(ran, ['fresh']);
});

// ---- the hold watch --------------------------------------------------------------------

function fakeTimers() {
  const timers = [];
  return {
    timers,
    setTimer: (fn, ms) => {
      const handle = { fn, ms, cleared: false, fired: false };
      timers.push(handle);
      return handle;
    },
    clearTimer: (handle) => {
      if (handle) handle.cleared = true;
    },
    live: (ms) => timers.filter((x) => !x.cleared && !x.fired && (ms === undefined || x.ms === ms)),
    /** Fires every live timer of this delay (one tick of fake time). */
    fire: (ms) => {
      for (const handle of timers.filter((x) => !x.cleared && !x.fired && x.ms === ms)) {
        handle.fired = true;
        handle.fn();
      }
    },
  };
}

test('createHoldWatch: one timer at most, re-armed while broken, resumes once fixed', async () => {
  const clock = fakeTimers();
  let held = true;
  let broken = true;
  const resumes = [];
  const still = [];
  const watch = createHoldWatch({
    isHeld: () => held,
    dirs: () => ['/wt/a'],
    check: () => (broken ? { ok: false, dir: '/wt/a', reason: 'empty' } : { ok: true }),
    resume: async () => {
      resumes.push(1);
      held = false;
      return { ok: true };
    },
    onStill: (res) => still.push(res.reason),
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  assert.equal(HOLD_RECHECK_MS, 60 * 1000);
  watch.arm();
  watch.arm();
  assert.equal(clock.live().length, 1, 'never two timers');
  clock.fire(HOLD_RECHECK_MS);
  assert.deepEqual(still, ['empty']);
  assert.equal(clock.live().length, 1, 're-armed while still broken');
  broken = false;
  clock.fire(HOLD_RECHECK_MS);
  await flush();
  assert.equal(resumes.length, 1);
  assert.equal(clock.live().length, 0, 'no timer left after the resume');
  watch.arm();
  watch.cancel();
  assert.equal(clock.live().length, 0);
});

test('createHoldWatch: no resume while an install for a held folder is in flight', async () => {
  const clock = fakeTimers();
  let busy = true;
  const resumes = [];
  const watch = createHoldWatch({
    isHeld: () => resumes.length === 0,
    dirs: () => ['/wt/a'],
    check: () => ({ ok: true }),
    busy: () => busy,
    resume: () => {
      resumes.push(1);
      return { ok: true };
    },
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  watch.arm();
  clock.fire(HOLD_RECHECK_MS);
  await flush();
  assert.equal(resumes.length, 0, 'a half-filled folder could pass the check');
  assert.equal(clock.live().length, 1, 'checked again next minute');
  busy = false;
  clock.fire(HOLD_RECHECK_MS);
  await flush();
  assert.equal(resumes.length, 1);
});

/** An orchestra whose package worktrees' node_modules are broken until `state.broken` turns false. */
function heldRun(state) {
  const clock = fakeTimers();
  let seq = 0;
  const alive = new Set();
  const events = [];
  const sessions = [];
  const orch = createOrchestra({
    now: () => 1_000_000,
    readTodos: () => [1, 2].map((at) => ({ at, text: `t${at}`, done: false })),
    dirtyCount: async () => 0,
    runPlanner: async () => ({
      ok: true,
      raw: {
        packages: ['a', 'b'].map((id, i) => ({
          id, title: `T ${id}`, todoAts: [i + 1], prompt: `do ${id}`, files: [], dependsOn: [], verify: 'npm test', model: 'sonnet',
        })),
        notes: '',
      },
      costUsd: 0,
    }),
    addWorktree: async (repo, name) => ({ ok: true, root: path.join('/wt', name), cwd: path.join('/wt', name), branch: `luna/${name}` }),
    headSha: async () => 'base',
    briefDir: () => '/cfg/tasks',
    writeBrief: () => true,
    createSession: (opts) => {
      seq += 1;
      sessions.push(opts);
      alive.add(`s${seq}`);
      return { id: `s${seq}` };
    },
    closeSession: (id) => alive.delete(id),
    sessionAlive: (id) => alive.has(id),
    writePty: (id) => alive.has(id),
    finishPackage: async (p) => ({ ok: true, headSha: `${p.id}aaaaaaa` }),
    installDeps: async () => ({ ok: true, output: '' }),
    checkDeps: (root) =>
      state.broken
        ? { ok: false, reason: 'unresolved', dir: root, detail: `electron is not in ${root}/node_modules`, missing: 'electron' }
        : { ok: true, needed: true },
    workerSettings: () => ({ model: 'opus', permissionMode: 'bypassPermissions' }),
    onRunEvent: (kind, data) => events.push([kind, data]),
    sleep: async () => {},
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  return { orch, clock, events, sessions };
}

async function startHeld(state) {
  const s = heldRun(state);
  const { plan } = await s.orch.makePlan({ projectId: 'p1', repoPath: '/repo', profileId: 'cloud', env: {} });
  await s.orch.launch({ planId: plan.id });
  // The recovery playbook's install runs (and does not help) first.
  await flush();
  return { ...s, planId: plan.id };
}

test('a held noNodeModules run resumes on its own within a minute of the fix - no Resume call', async () => {
  const state = { broken: true };
  const s = await startHeld(state);
  const hold = s.orch.view().hold;
  assert.equal(hold.reason, 'noNodeModules');
  assert.equal(s.sessions.length, 0);
  assert.equal(s.clock.live(HOLD_RECHECK_MS).length, 1, 'the watch is armed');

  // A tick while still broken: still held, checked again next minute.
  s.clock.fire(HOLD_RECHECK_MS);
  await flush();
  assert.ok(s.orch.view().hold);
  assert.equal(s.clock.live(HOLD_RECHECK_MS).length, 1);

  // Fixed by hand: the next tick resumes the run.
  state.broken = false;
  s.clock.fire(HOLD_RECHECK_MS);
  await flush();
  assert.equal(s.orch.view().hold, null);
  assert.deepEqual(s.orch.view().packages.map((p) => p.state), ['launched', 'launched']);
  assert.ok(s.events.some(([k, d]) => k === 'resumed' && d.reason === 'noNodeModules'));
  assert.equal(s.clock.live(HOLD_RECHECK_MS).length, 0, 'no timer left behind');
});

test('the hold watch timer is cleared on kill, on discard and on a manual resume', async () => {
  const killed = await startHeld({ broken: true });
  assert.equal(killed.clock.live(HOLD_RECHECK_MS).length, 1);
  killed.orch.kill();
  assert.equal(killed.clock.live(HOLD_RECHECK_MS).length, 0, 'kill drops it');

  const discarded = await startHeld({ broken: true });
  assert.equal(discarded.clock.live(HOLD_RECHECK_MS).length, 1);
  assert.equal(discarded.orch.discard().ok, true);
  assert.equal(discarded.clock.live(HOLD_RECHECK_MS).length, 0, 'discard drops it');

  const state = { broken: true };
  const resumed = await startHeld(state);
  state.broken = false;
  assert.equal((await resumed.orch.resumeRun({ planId: resumed.planId })).ok, true);
  assert.equal(resumed.clock.live(HOLD_RECHECK_MS).length, 0, 'resume drops it');
});

test('the hold names the real reason and the missing package (board and message)', async () => {
  const s = await startHeld({ broken: true });
  const hold = s.orch.view().hold;
  assert.deepEqual([hold.cause, hold.missing], ['unresolved', 'electron']);
  assert.match(hold.detail, /electron is not in/);
  const msg = s.events.find(([k]) => k === 'noNodeModules');
  assert.ok(msg, 'the hold message went out');
  assert.deepEqual([msg[1].cause, msg[1].missing], ['unresolved', 'electron']);
});
