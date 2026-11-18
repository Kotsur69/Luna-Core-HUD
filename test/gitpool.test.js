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
