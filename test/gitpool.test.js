// Tests for src/gitpool.js (the one door the HUD's git pollers go through)
// and the single-flight guards built on it in gitfiles.js / gitstation.js.
// Under load ~300 `git status` processes piled up because each poller started
// a new call before its last one ended; these pin the cap and the sharing.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createGitPool, isShareable, MAX_CONCURRENT_GIT } = require('../src/gitpool.js');
const { GitFileWatcher } = require('../src/gitfiles.js');
const gitstation = require('../src/gitstation.js');

/** A fake execFile that never answers until the test says so. */
function fakeSpawner() {
  const calls = [];
  let live = 0;
  let peak = 0;
  const execFileImpl = (file, args, opts, cb) => {
    live += 1;
    peak = Math.max(peak, live);
    calls.push({
      file,
      args,
      opts,
      answer: (err, stdout = '', stderr = '') => {
        live -= 1;
        cb(err, stdout, stderr);
      },
    });
  };
  return { execFileImpl, calls, peak: () => peak, live: () => live };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test('concurrent identical status calls for one dir share a single git process', async () => {
  const sp = fakeSpawner();
  const pool = createGitPool({ execFileImpl: sp.execFileImpl });
  const a = pool.run('/repo', ['status', '--porcelain=v2', '-z']);
  const b = pool.run('/repo', ['status', '--porcelain=v2', '-z']);
  const c = pool.run('/repo', ['status', '--porcelain=v2', '-z']);
  assert.equal(sp.calls.length, 1, 'one spawn for three callers');
  assert.deepEqual(sp.calls[0].args, ['-C', '/repo', 'status', '--porcelain=v2', '-z']);
  assert.equal(sp.calls[0].opts.windowsHide, true);
  sp.calls[0].answer(null, 'out');
  const results = await Promise.all([a, b, c]);
  for (const r of results) assert.deepEqual(r, { ok: true, stdout: 'out', stderr: '' });
  assert.notEqual(results[0], results[1], 'every caller gets its own copy');
  // Once answered, the next poll is a fresh process again.
  const d = pool.run('/repo', ['status', '--porcelain=v2', '-z']);
  assert.equal(sp.calls.length, 2);
  sp.calls[1].answer(null, 'again');
  assert.equal((await d).stdout, 'again');
});

test('a write is never shared, and different dirs or args are separate calls', async () => {
  const sp = fakeSpawner();
  const pool = createGitPool({ execFileImpl: sp.execFileImpl });
  const runs = [
    pool.run('/repo', ['commit', '-m', 'x']),
    pool.run('/repo', ['commit', '-m', 'x']),
    pool.run('/repo', ['status', '--porcelain']),
    pool.run('/other', ['status', '--porcelain']),
  ];
  assert.equal(sp.calls.length, 4);
  for (const c of sp.calls) c.answer(null, '');
  await Promise.all(runs);
  assert.equal(isShareable(['push']), false);
  assert.equal(isShareable(['fetch', '--all']), false);
  assert.equal(isShareable(['rev-parse', '--show-toplevel']), true);
});

test('a read asked for after a write to the same dir never gets the pre-write answer', async () => {
  const sp = fakeSpawner();
  const pool = createGitPool({ execFileImpl: sp.execFileImpl });
  const before = pool.run('/repo', ['status', '--porcelain']);
  const add = pool.run('/repo', ['add', '-A']);
  const after = pool.run('/repo', ['status', '--porcelain']);
  const other = pool.run('/other', ['status', '--porcelain']);
  const otherDup = pool.run('/other', ['status', '--porcelain']);
  assert.equal(sp.calls.length, 4, 'the post-write read is its own process; /other still shares');
  sp.calls[0].answer(null, 'before add');
  sp.calls[1].answer(null, '');
  sp.calls[2].answer(null, 'after add');
  sp.calls[3].answer(null, 'other');
  assert.equal((await before).stdout, 'before add');
  assert.equal((await add).ok, true);
  assert.equal((await after).stdout, 'after add');
  assert.equal((await otherDup).stdout, (await other).stdout);
});

test('a read started while a write runs is not shared once the write is done', async () => {
  const sp = fakeSpawner();
  const pool = createGitPool({ execFileImpl: sp.execFileImpl });
  const commit = pool.run('/repo', ['commit', '-m', 'x']);
  const during = pool.run('/repo', ['log', '-1']);
  sp.calls[0].answer(null, '');
  await commit;
  const later = pool.run('/repo', ['log', '-1']);
  assert.equal(sp.calls.length, 3, 'the read after the commit spawned afresh');
  sp.calls[1].answer(null, 'old');
  sp.calls[2].answer(null, 'new');
  assert.equal((await during).stdout, 'old');
  assert.equal((await later).stdout, 'new');
});

test('isShareable finds the subcommand past leading global options', () => {
  assert.equal(isShareable(['-c', 'core.quotepath=false', 'log', '-1']), true);
  assert.equal(isShareable(['--no-optional-locks', 'status']), true);
  assert.equal(isShareable(['-c', 'status=1', 'push']), false);
  assert.equal(isShareable([]), false);
});

test('the global cap holds under N parallel dirs; the queue drains as calls end', async () => {
  const sp = fakeSpawner();
  const pool = createGitPool({ execFileImpl: sp.execFileImpl });
  const N = 20;
  const runs = Array.from({ length: N }, (_, i) => pool.run(`/wt/${i}`, ['status', '--porcelain=v2', '-z']));
  assert.equal(sp.calls.length, MAX_CONCURRENT_GIT, 'only the cap starts');
  assert.deepEqual(pool.stats(), { active: MAX_CONCURRENT_GIT, queued: N - MAX_CONCURRENT_GIT });
  // A duplicate of a QUEUED request adds nothing to the queue.
  const dup = pool.run('/wt/19', ['status', '--porcelain=v2', '-z']);
  assert.equal(pool.stats().queued, N - MAX_CONCURRENT_GIT);
  let answered = 0;
  while (answered < sp.calls.length) {
    sp.calls[answered].answer(null, `out ${answered}`);
    answered += 1;
    await tick();
    assert.ok(sp.live() <= MAX_CONCURRENT_GIT, `never more than ${MAX_CONCURRENT_GIT} running`);
  }
  const results = await Promise.all(runs);
  assert.equal(sp.calls.length, N, 'every dir ran exactly once');
  assert.equal(sp.peak(), MAX_CONCURRENT_GIT);
  assert.ok(results.every((r) => r.ok));
  assert.deepEqual(await dup, results[N - 1]);
  assert.deepEqual(pool.stats(), { active: 0, queued: 0 });
});

test('never rejects: a failure, a timeout and a throwing spawner all resolve ok:false and free the slot', async () => {
  const sp = fakeSpawner();
  const pool = createGitPool({ execFileImpl: sp.execFileImpl, maxConcurrent: 1 });
  const failed = pool.run('/a', ['status']);
  const queued = pool.run('/b', ['status'], { timeout: 1234 });
  sp.calls[0].answer(Object.assign(new Error('killed'), { killed: true }), '', 'fatal: x');
  assert.deepEqual(await failed, { ok: false, stdout: '', stderr: 'fatal: x' });
  await tick();
  assert.equal(sp.calls[1].opts.timeout, 1234, 'the caller timeout reaches execFile');
  sp.calls[1].answer(null, 'ok');
  assert.equal((await queued).ok, true);

  const throwing = createGitPool({
    maxConcurrent: 1,
    execFileImpl: () => {
      throw new Error('spawn EINVAL');
    },
  });
  const r1 = await throwing.run('/a', ['status']);
  const r2 = await throwing.run('/b', ['status']);
  assert.equal(r1.ok, false);
  assert.match(r1.stderr, /EINVAL/);
  assert.equal(r2.ok, false, 'the slot was freed for the next call');
  assert.deepEqual(throwing.stats(), { active: 0, queued: 0 });
});

test('GitFileWatcher: a tick while the previous read is in flight is skipped (one read per dir)', async () => {
  let reads = 0;
  let release;
  const seen = [];
  const watcher = new GitFileWatcher('/repo', (files) => seen.push(files), {
    intervalMs: 60 * 60 * 1000,
    snapshot: async () => new Set(),
    read: () => {
      reads += 1;
      return new Promise((resolve) => {
        release = resolve;
      });
    },
  });
  await watcher.start();
  assert.equal(reads, 1, 'start runs the first tick');
  await watcher.tick();
  await watcher.tick();
  assert.equal(reads, 1, 'later ticks skip while git is still busy');
  release([{ file: '/repo/a.js', added: 1, removed: 0 }]);
  await tick();
  assert.equal(seen.length, 1);
  const next = watcher.tick();
  assert.equal(reads, 2, 'the next tick after the answer reads again');
  release([{ file: '/repo/a.js', added: 1, removed: 0 }]);
  await next;
  assert.equal(seen.length, 1, 'an unchanged answer is not re-emitted');
  watcher.stop();
});

test('GitFileWatcher: stop() during the first snapshot leaves no timer behind', async () => {
  let release;
  let reads = 0;
  const watcher = new GitFileWatcher('/repo', () => {}, {
    snapshot: () =>
      new Promise((resolve) => {
        release = resolve;
      }),
    read: async () => {
      reads += 1;
      return [];
    },
  });
  const started = watcher.start();
  await watcher.start();
  watcher.stop();
  release(new Set());
  await started;
  assert.equal(watcher.timer, null, 'no interval after a stop');
  assert.equal(reads, 0);
});

test('GitFileWatcher: stop(); start() while the first snapshot is pending ends with one live timer', async () => {
  const releases = [];
  const seen = [];
  const watcher = new GitFileWatcher('/repo', (files) => seen.push(files), {
    intervalMs: 60 * 60 * 1000,
    snapshot: () => new Promise((resolve) => releases.push(resolve)),
    read: async () => [{ file: '/repo/x.js', added: 2, removed: 0 }],
  });
  const first = watcher.start();
  watcher.stop();
  const second = watcher.start();
  assert.equal(releases.length, 2, 'the restart took its own snapshot');
  releases[0](new Set());
  await first;
  assert.equal(watcher.timer, null, 'the stopped start made no timer');
  releases[1](new Set());
  await second;
  assert.notEqual(watcher.timer, null, 'the restart is live');
  await tick();
  assert.equal(seen.length, 1);
  watcher.stop();
});

test('readAllRepos: concurrent callers share one pass', async () => {
  // An injected reader: no real git runs on whatever repos this PC lists.
  const readOne = async (dir) => ({ path: dir, name: String(dir), state: 'clean' });
  const first = gitstation.readAllRepos(readOne);
  const second = gitstation.readAllRepos(readOne);
  assert.equal(first, second, 'the second caller gets the pass in flight');
  await first;
  const third = gitstation.readAllRepos(readOne);
  assert.notEqual(third, first, 'a finished pass is not reused');
  await third;
});

// ---------------------------------------------------------------------------
// Lanes: slow calls (network, worktree add/remove, log --all, long timeouts)
// have their own slots, so they can never starve the fast status polls.
// ---------------------------------------------------------------------------

const { laneOf, MAX_SLOW_GIT, gitPoolLaneStats } = require('../src/gitpool.js');
const worktrees = require('../src/worktrees.js');

const killed = () => Object.assign(new Error('killed'), { killed: true });

test('laneOf: network, whole-checkout, whole-history and long-timeout calls are slow', () => {
  assert.equal(laneOf(['status', '--porcelain=v2', '-z'], 8000), 'fast');
  assert.equal(laneOf(['log', '-1', '--format=%h'], 10000), 'fast');
  assert.equal(laneOf(['rev-parse', '--show-toplevel'], 30000), 'fast', 'worktrees probes at 30s stay fast');
  assert.equal(laneOf(['worktree', 'list', '--porcelain'], 30000), 'fast');
  assert.equal(laneOf(['fetch', '--all', '--prune'], 30000), 'slow');
  assert.equal(laneOf(['push'], 30000), 'slow');
  assert.equal(laneOf(['-c', 'core.quotepath=false', 'log', '--all', '--no-merges'], 30000), 'slow');
  assert.equal(laneOf(['worktree', 'add', '-b', 'luna/x', '/wt', 'main'], 300000), 'slow');
  assert.equal(laneOf(['worktree', 'remove', '--', '/wt'], 600000), 'slow');
  assert.equal(laneOf(['merge', '--ff-only', 'origin/main'], 60000), 'slow', 'a timeout over 30s is slow');
  assert.equal(laneOf([], undefined), 'fast');
});

test('four hung slow calls fill the slow lane only: status polls still run and answer', async () => {
  const sp = fakeSpawner();
  const pool = createGitPool({ execFileImpl: sp.execFileImpl });
  const hung = [
    pool.run('/a', ['fetch', '--all', '--prune'], { timeout: 30000 }),
    pool.run('/b', ['fetch', '--all', '--prune'], { timeout: 30000 }),
    pool.run('/c', ['log', '--all', '--no-merges'], { timeout: 30000 }),
    pool.run('/d', ['push'], { timeout: 30000 }),
  ];
  const fifthSlow = pool.run('/e', ['fetch', '--all', '--prune'], { timeout: 30000 });
  assert.equal(sp.calls.length, MAX_SLOW_GIT, 'the slow lane is full');
  assert.deepEqual(pool.laneStats().slow, { active: MAX_SLOW_GIT, queued: 1 });

  const polls = Array.from({ length: MAX_CONCURRENT_GIT }, (_, i) => pool.run(`/wt/${i}`, ['status', '--porcelain=v2', '-z']));
  assert.equal(sp.calls.length, MAX_SLOW_GIT + MAX_CONCURRENT_GIT, 'every status poll started at once');
  assert.deepEqual(pool.laneStats().fast, { active: MAX_CONCURRENT_GIT, queued: 0 });
  for (const c of sp.calls.slice(MAX_SLOW_GIT)) c.answer(null, 'clean');
  const answered = await Promise.all(polls);
  assert.ok(answered.every((r) => r.ok && r.stdout === 'clean'), 'polls answered while the slow calls hang');

  // The queued slow call takes the first slow slot that frees up.
  sp.calls[0].answer(killed());
  assert.equal((await hung[0]).ok, false);
  await tick();
  assert.deepEqual(sp.calls.at(-1).args, ['-C', '/e', 'fetch', '--all', '--prune']);
  for (const c of sp.calls.slice(1, MAX_SLOW_GIT)) c.answer(null, '');
  sp.calls.at(-1).answer(null, '');
  await Promise.all([...hung, fifthSlow]);
  assert.ok(sp.peak() <= MAX_CONCURRENT_GIT + MAX_SLOW_GIT);
  assert.deepEqual(pool.stats(), { active: 0, queued: 0 });
});

test('an explicit lane overrides the classifier, and withSlot frees its slot on a failed task', async () => {
  const sp = fakeSpawner();
  const pool = createGitPool({ execFileImpl: sp.execFileImpl, maxConcurrent: 1, maxSlow: 1 });
  const slowStatus = pool.run('/a', ['status'], { lane: 'slow' });
  assert.equal(pool.laneStats().slow.active, 1);
  sp.calls[0].answer(null, 'x');
  await slowStatus;
  await assert.rejects(pool.withSlot('fast', () => Promise.reject(new Error('boom'))), /boom/);
  await assert.rejects(
    pool.withSlot('fast', () => {
      throw new Error('sync boom');
    }),
    /sync boom/,
  );
  assert.equal(await pool.withSlot('fast', () => 'next'), 'next', 'the slot was freed');
  assert.deepEqual(pool.stats(), { active: 0, queued: 0 });
});

test('worktrees.runGit: N parallel rev-parse probes are capped at the fast lane', async () => {
  const sp = fakeSpawner();
  const pool = createGitPool();
  const N = 25;
  const probes = Array.from({ length: N }, (_, i) =>
    worktrees.runGit(`/repo/${i}`, ['rev-parse', '--show-toplevel'], sp.execFileImpl, { withSlot: pool.withSlot }),
  );
  assert.equal(sp.calls.length, MAX_CONCURRENT_GIT, 'only the cap starts');
  assert.deepEqual(pool.laneStats().fast, { active: MAX_CONCURRENT_GIT, queued: N - MAX_CONCURRENT_GIT });
  let answered = 0;
  while (answered < N) {
    sp.calls[answered].answer(null, `/repo/${answered}\n`);
    answered += 1;
    await tick();
    assert.ok(sp.live() <= MAX_CONCURRENT_GIT);
  }
  const results = await Promise.all(probes);
  assert.equal(sp.peak(), MAX_CONCURRENT_GIT);
  assert.equal(results[7].stdout, '/repo/7\n');
  assert.equal(results[7].timeoutMs, worktrees.GIT_TIMEOUT_MS, 'the diagnostic fields survive the pool');
  assert.equal(results[7].code, 0);
});

test('worktrees.runGit: hung worktree add/remove use the slow lane and never block probes or status polls', async () => {
  const sp = fakeSpawner();
  const pool = createGitPool({ execFileImpl: sp.execFileImpl });
  const via = { withSlot: pool.withSlot };
  const add = (b) =>
    worktrees.runGit('/repo', ['worktree', 'add', '-b', `luna/${b}`, `/wt/${b}`, 'main'], sp.execFileImpl, {
      ...via,
      timeoutMs: worktrees.ADD_TIMEOUT_MS,
    });
  const remove = (b) =>
    worktrees.runGit('/repo', ['worktree', 'remove', '--', `/wt/${b}`], sp.execFileImpl, {
      ...via,
      timeoutMs: worktrees.REMOVE_TIMEOUT_MS,
    });
  const long = [add('a'), add('b'), remove('c'), remove('d')];
  assert.equal(pool.laneStats().slow.active, MAX_SLOW_GIT);
  const probe = worktrees.runGit('/repo', ['rev-parse', '--show-toplevel'], sp.execFileImpl, via);
  const poll = pool.run('/wt/x', ['status', '--porcelain=v2', '-z']);
  assert.equal(sp.calls.length, MAX_SLOW_GIT + 2, 'probe and poll started despite four hung slow calls');
  assert.equal(sp.calls[MAX_SLOW_GIT].opts.timeout, worktrees.GIT_TIMEOUT_MS);
  sp.calls[MAX_SLOW_GIT].answer(null, '/repo\n');
  sp.calls[MAX_SLOW_GIT + 1].answer(null, 'clean');
  assert.equal((await probe).stdout, '/repo\n');
  assert.equal((await poll).stdout, 'clean');
  for (const c of sp.calls.slice(0, MAX_SLOW_GIT)) c.answer(killed());
  const ended = await Promise.all(long);
  assert.ok(ended.every((r) => r.timedOut), 'timeouts are still reported');
  assert.deepEqual(pool.stats(), { active: 0, queued: 0 });
});

test('worktrees.runGit uses the shared HUD pool by default', async () => {
  const sp = fakeSpawner();
  const probe = worktrees.runGit('/repo', ['rev-parse', '--show-toplevel'], sp.execFileImpl);
  const remove = worktrees.runGit('/repo', ['worktree', 'remove', '--', '/wt'], sp.execFileImpl, {
    timeoutMs: worktrees.REMOVE_TIMEOUT_MS,
  });
  assert.deepEqual(gitPoolLaneStats(), { fast: { active: 1, queued: 0 }, slow: { active: 1, queued: 0 } });
  for (const c of sp.calls) c.answer(null, '');
  await Promise.all([probe, remove]);
  assert.deepEqual(gitPoolLaneStats(), { fast: { active: 0, queued: 0 }, slow: { active: 0, queued: 0 } });
});
