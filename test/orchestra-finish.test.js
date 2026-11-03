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
  const res = await finishPackage(pkg, { isDirImpl: () => true, execImpl: git.execImpl, verifyImpl: passVerify });
  assert.deepEqual(res, { ok: true, headSha: 'abc', files: ['src/x.js'] });
  assert.ok(git.calls.includes('push -u origin refs/heads/luna/a-1'));
  assert.ok(!git.calls.some((c) => c.startsWith('commit')), 'nothing to commit');
});

test('leftovers are committed as a wip commit before verifying', async () => {
  const git = fakeGit({ status: { ok: true, stdout: ' M src/x.js\n' }, 'rev-list': { ok: true, stdout: '1' } });
  await finishPackage(pkg, { isDirImpl: () => true, execImpl: git.execImpl, verifyImpl: passVerify });
  assert.ok(git.calls.includes('add -A'));
  assert.ok(git.calls.includes('commit -m chore: luna wip a'));
});

test('no commit past the base is refused before verify or push', async () => {
  let verified = false;
  const git = fakeGit({ 'rev-list': { ok: true, stdout: '0' } });
  const res = await finishPackage(pkg, { isDirImpl: () => true,
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
  const res = await finishPackage(pkg, { isDirImpl: () => true, execImpl: git.execImpl, verifyImpl: async () => ({ ok: false, output: 'FAIL' }) });
  assert.deepEqual(res, { ok: false, stage: 'verify', output: 'FAIL' });
  assert.ok(!git.calls.some((c) => c.startsWith('push')));
});

test('push failure reports git\'s first stderr line', async () => {
  const git = fakeGit({ 'rev-list': { ok: true, stdout: '1' }, push: { ok: false, stderr: 'fatal: no remote\nmore' } });
  const res = await finishPackage(pkg, { isDirImpl: () => true, execImpl: git.execImpl, verifyImpl: passVerify });
  assert.deepEqual(res, { ok: false, stage: 'push', detail: 'fatal: no remote' });
});

// ---- runVerify: a verify past its cap is stopped with everything under it ----------

const fs = require('fs');
const os = require('os');
const path = require('path');
const { runVerify, killTree, VERIFY_TIMEOUT_MS } = require('../src/orchestraFinish.js');

/** Fake exec: hands out a child, answers only when `finish` is called (or at once with `now`). */
function fakeVerifyExec(now) {
  const state = { opts: null, finish: null, child: { pid: 4242, kill: () => (state.killed = true) }, killed: false };
  const execImpl = (_cmd, opts, cb) => {
    state.opts = opts;
    state.finish = (err, stdout) => cb(err, stdout, '');
    if (now) cb(now.err, now.stdout, '');
    return state.child;
  };
  return { execImpl, state };
}

/** Fake timers: nothing fires by itself. */
function fakeTimers() {
  const t = { armed: [], cleared: [] };
  t.setTimer = (fn, ms) => {
    const h = { fn, ms };
    t.armed.push(h);
    return h;
  };
  t.clearTimer = (h) => t.cleared.push(h);
  return t;
}

test('runVerify: past the cap the whole tree is stopped and the output says it timed out', async () => {
  const { execImpl, state } = fakeVerifyExec();
  const timers = fakeTimers();
  const stopped = [];
  const done = runVerify('npm test', '/wt', execImpl, { ...timers, killTree: (c) => stopped.push(c) });

  assert.equal(state.opts.timeout, undefined, "no exec timeout: it would kill only the shell, before the tree is found");
  assert.equal(timers.armed.length, 1);
  assert.equal(timers.armed[0].ms, VERIFY_TIMEOUT_MS);
  timers.armed[0].fn();
  assert.deepEqual(stopped, [state.child], 'the cap stops the child and its tree');
  // A killed tree exits non-zero; what it printed so far is kept.
  state.finish(Object.assign(new Error('x'), { code: 1 }), 'ok 1 - passes\n');
  const res = await done;
  assert.equal(res.ok, false);
  assert.match(res.output, /ok 1 - passes\n\[LunaCore: verify timed out\]$/);
});

test('runVerify: a verify that ends in time clears its timer; a capped one counts red even if it exited 0', async () => {
  const green = fakeVerifyExec();
  const timers = fakeTimers();
  const p = runVerify('npm test', '/wt', green.execImpl, { ...timers, killTree: () => assert.fail('not capped') });
  green.state.finish(null, 'all good');
  assert.deepEqual(await p, { ok: true, output: 'all good' });
  assert.deepEqual(timers.cleared, timers.armed);

  const late = fakeVerifyExec();
  const t2 = fakeTimers();
  const q = runVerify('npm test', '/wt', late.execImpl, { ...t2, killTree: () => {} });
  t2.armed[0].fn();
  late.state.finish(null, 'finished anyway');
  const res = await q;
  assert.equal(res.ok, false);
  assert.match(res.output, /verify timed out/);
});

test('runVerify: an exec that answers at once arms no timer; over maxBuffer still reads as timed out', async () => {
  const sync = fakeVerifyExec({ err: Object.assign(new Error('maxBuffer'), { killed: true }), stdout: 'lots' });
  const timers = fakeTimers();
  const res = await runVerify('npm test', '/wt', sync.execImpl, timers);
  assert.equal(timers.armed.length, 0, 'nothing left to keep the process alive');
  assert.equal(res.ok, false);
  assert.match(res.output, /^lots\n\[LunaCore: verify timed out\]$/);
});

test('killTree: taskkill /T /F on the pid on Windows, then child.kill(); only child.kill() elsewhere', () => {
  const calls = [];
  const child = { pid: 4242, kill: () => calls.push('kill') };
  const execFileImpl = (bin, argv, opts, cb) => {
    calls.push(`${bin} ${argv.join(' ')} hide=${opts.windowsHide}`);
    cb(null);
  };
  killTree(child, { platform: 'win32', execFileImpl });
  assert.deepEqual(calls, ['taskkill /pid 4242 /T /F hide=true', 'kill']);

  calls.length = 0;
  killTree(child, { platform: 'linux', execFileImpl });
  assert.deepEqual(calls, ['kill']);

  calls.length = 0;
  killTree({ pid: undefined, kill: () => calls.push('kill') }, { platform: 'win32', execFileImpl });
  assert.deepEqual(calls, ['kill'], 'no pid: no taskkill');

  killTree({ pid: 1, kill: () => { throw new Error('gone'); } }, { platform: 'win32', execFileImpl: (_b, _a, _o, cb) => cb(new Error('ENOENT')) });
});

/** True while a process with this pid runs. */
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test(
  'runVerify for real: past the cap the shell, its child and its grandchild are all gone',
  { timeout: 60000, skip: process.platform !== 'win32' && 'the tree kill is Windows-only' },
  async () => {
    // shell -> node -> node, each writing its pid to a file: what `npm test` -> `node --test` is.
    // Before the fix, exec's timeout stopped only the shell and both node processes ran on.
    const pidFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'luna-verify-')), 'pids');
    process.env.LUNA_TREE_PIDS = pidFile;
    const grand = 'require(`fs`).appendFileSync(process.env.LUNA_TREE_PIDS,`grand:`+process.pid+`;`);setTimeout(()=>{},60000)';
    const script = `const c=require('child_process');require('fs').appendFileSync(process.env.LUNA_TREE_PIDS,'child:'+process.pid+';');c.spawn(process.execPath,['-e','${grand}'],{stdio:'inherit'});setTimeout(()=>{},60000)`;
    const readPids = () => {
      const written = fs.existsSync(pidFile) ? fs.readFileSync(pidFile, 'utf8') : '';
      return ['child', 'grand'].map((k) => Number((new RegExp(`${k}:(\\d+)`).exec(written) || [])[1]));
    };
    // The cap fires once both processes run - a fixed delay races node's
    // start-up on a busy machine.
    const capOnceRunning = {
      setTimer: (fn) => {
        const h = { iv: null };
        h.iv = setInterval(() => {
          if (readPids().every(Number.isInteger)) {
            clearInterval(h.iv);
            fn();
          }
        }, 50);
        return h;
      },
      clearTimer: (h) => clearInterval(h.iv),
    };
    try {
      const res = await runVerify(`node -e "${script}"`, process.cwd(), undefined, capOnceRunning);
      assert.equal(res.ok, false);
      assert.match(res.output, /verify timed out/);
      const pids = readPids();
      assert.ok(pids.every(Number.isInteger), 'both pids written');
      for (let i = 0; i < 50 && pids.some(alive); i++) await new Promise((r) => setTimeout(r, 100));
      assert.deepEqual(pids.filter(alive), [], 'nothing of the verify is left running');
    } finally {
      delete process.env.LUNA_TREE_PIDS;
      fs.rmSync(path.dirname(pidFile), { recursive: true, force: true });
    }
  },
);
