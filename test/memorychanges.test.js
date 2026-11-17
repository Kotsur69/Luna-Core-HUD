// ============================================================================
// LunaCore - files named by memories that changed since they were checked
// (src/memorychanges.js, the 'changed' flag of src/memoryreview.js)
// ----------------------------------------------------------------------------
// The git side: the parser, the arguments, one call in flight per project,
// the cache, a failing git, and one real git log in a temporary repository.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { createChangeTracker, changeQueries, gitArgs, parseChanges, readChanges, headSignature, cachedChanges, CHANGES_TTL_MS, MAX_PATHSPEC_CHARS } = require('../src/memorychanges.js');
const { reviewList } = require('../src/memoryreview.js');
const { registerMemoryIpc } = require('../src/memoryipc.js');
const { checkAllTargets } = require('../src/memorycheck.js');
const { writeRecord, scan } = require('../src/memorystore.js');
const { createLog, logPath, DAY_MS } = require('../src/memorylog.js');

const PROJECT = 'github.com/acme/hud';
const TODAY = '2026-11-16';
const NOW = Date.parse(`${TODAY}T12:00:00Z`);
const ROOT = path.resolve('/repos/hud');
const MARK = '\u0001';

const rec = (id, over = {}) => ({
  id,
  type: 'gotcha',
  project: PROJECT,
  title: `Title of ${id}`,
  created: '2026-11-01',
  confidence: 'confirmed',
  supersedes: [],
  links: [],
  body: `Body of ${id}.`,
  ...over,
});
const entries = (...records) => records.map((r) => [`${r.project}/${r.id}`, r]);

/** A stub execFile: records every call, answers when told to. */
function stubGit(answer = () => ({ stdout: '' })) {
  const calls = [];
  const pending = [];
  const exec = (cmd, args, opts, cb) => {
    calls.push({ cmd, args, opts });
    pending.push(() => {
      const res = answer(args);
      cb(res.error || null, res.stdout || '', res.stderr || '');
    });
  };
  const flush = () => {
    while (pending.length) pending.shift()();
  };
  return { exec, calls, flush };
}

/** Collects console.error lines while fn runs. */
async function capturedErrors(fn) {
  const lines = [];
  const original = console.error;
  console.error = (...args) => lines.push(args.join(' '));
  try {
    await fn();
  } finally {
    console.error = original;
  }
  return lines;
}

// ---- the parser and the arguments --------------------------------------------------

test('git log output becomes the newest commit time per wanted path', () => {
  const stdout = [
    `${MARK}2026-11-14T10:00:00+01:00`,
    '',
    'src/a.js',
    'src/other.js',
    `${MARK}2026-11-12T09:00:00Z`,
    '',
    'src/a.js',
    'src/b.js\r',
    `${MARK}not a date`,
    'src/b.js',
  ].join('\n');

  const changes = parseChanges(stdout, ['src/a.js', 'src/b.js', 'src/never.js']);

  assert.deepEqual([...changes], [
    ['src/a.js', '2026-11-14T09:00:00.000Z'],
    ['src/b.js', '2026-11-12T09:00:00.000Z'],
  ]);
  assert.equal(parseChanges('', ['src/a.js']).size, 0);
});

test('git runs without a shell: literal paths after --, since the day before the oldest check', () => {
  const args = gitArgs({ root: ROOT, since: '2026-11-01', paths: ['src/[x].js', 'src/a.js'] });

  assert.deepEqual(args.slice(0, 2), ['-C', ROOT]);
  assert.ok(args.includes('--literal-pathspecs'));
  assert.ok(args.indexOf('--literal-pathspecs') < args.indexOf('log'));
  assert.ok(args.includes('--since=2026-10-31'));
  assert.deepEqual(args.slice(args.indexOf('--')), ['--', 'src/[x].js', 'src/a.js']);
});

test('a path list too long for a command line asks for every file and filters here', () => {
  const paths = Array.from({ length: Math.ceil(MAX_PATHSPEC_CHARS / 20) + 1 }, (_, i) => `src/long/file-${String(i).padStart(6, '0')}.js`);
  const args = gitArgs({ root: ROOT, since: '2026-11-01', paths });

  assert.equal(args.includes('--'), false);
  assert.equal(args.some((a) => a.startsWith('src/long/')), false);
});

test('one query per project: confirmed, active, anchored memories with a folder here', () => {
  const records = entries(
    rec('a', { body: 'See `src/a.js` and `src/b.js`.', last_verified: '2026-11-10' }),
    rec('b', { body: 'See `src/b.js`.', created: '2026-10-20' }),
    rec('observed', { confidence: 'observed', body: '`src/obs.js`', created: '2026-01-01' }),
    rec('archived', { archived: '2026-11-02', body: '`src/arch.js`', created: '2026-01-01' }),
    rec('no-anchor', { created: '2026-01-01' }),
    rec('elsewhere', { project: 'github.com/acme/other', body: '`src/x.js`' }),
  );

  assert.deepEqual(changeQueries(records, { [PROJECT]: ROOT }), {
    [PROJECT]: { root: ROOT, since: '2026-10-20', paths: ['src/a.js', 'src/b.js'] },
  });
  assert.deepEqual(changeQueries(records, { [PROJECT]: 'relative/path' }), {});
});

// ---- the tracker ------------------------------------------------------------------

const anchored = () => entries(rec('a', { body: 'See `src/a.js`.' }));
const answerA = () => ({ stdout: `${MARK}2026-11-14T10:00:00Z\n\nsrc/a.js\n` });

test('two refresh requests for one project make one git call', async () => {
  const git = stubGit(answerA);
  const tracker = createChangeTracker({ exec: git.exec, now: () => NOW, headOf: () => 'h1' });

  const first = tracker.refresh(anchored(), { [PROJECT]: ROOT });
  const second = tracker.refresh(anchored(), { [PROJECT]: ROOT });
  assert.equal(git.calls.length, 1);
  assert.equal(git.calls[0].cmd, 'git');
  assert.ok(git.calls[0].opts.timeout > 0);
  git.flush();

  assert.deepEqual(await Promise.all([first, second]), [true, true]);
  assert.deepEqual([...tracker.current()[PROJECT]], [['src/a.js', '2026-11-14T10:00:00.000Z']]);
});

test('the answer is cached until HEAD moves or the TTL passes', async () => {
  const git = stubGit(answerA);
  let now = NOW;
  let head = 'h1';
  const tracker = createChangeTracker({ exec: git.exec, now: () => now, headOf: () => head });
  const refresh = async () => {
    const p = tracker.refresh(anchored(), { [PROJECT]: ROOT });
    git.flush();
    return p;
  };

  assert.equal(await refresh(), true);
  assert.equal(await refresh(), false);
  assert.equal(git.calls.length, 1, 'same HEAD, inside the TTL: no call');

  head = 'h2';
  assert.equal(await refresh(), false, 'same answer: nothing to repaint');
  assert.equal(git.calls.length, 2, 'HEAD moved: asked again');

  now += CHANGES_TTL_MS + 1;
  await refresh();
  assert.equal(git.calls.length, 3, 'TTL passed: asked again');
});

test('a verified memory needs no new call; a newly named file does', async () => {
  const git = stubGit(answerA);
  const tracker = createChangeTracker({ exec: git.exec, now: () => NOW, headOf: () => 'h1' });
  const run = async (records) => {
    const p = tracker.refresh(records, { [PROJECT]: ROOT });
    git.flush();
    return p;
  };

  await run(anchored());
  await run(entries(rec('a', { body: 'See `src/a.js`.', last_verified: TODAY })));
  assert.equal(git.calls.length, 1);
  await run(entries(rec('a', { body: 'See `src/a.js`.' }), rec('b', { body: '`src/new.js`' })));
  assert.equal(git.calls.length, 2);
});

test('a failing git logs once with its reason and yields no changed flags', async () => {
  const failure = Object.assign(new Error('fatal: not a git repository'), { code: 128 });
  const git = stubGit(() => ({ error: failure }));
  const tracker = createChangeTracker({ exec: git.exec, now: () => NOW, headOf: () => 'h1' });

  const errors = await capturedErrors(async () => {
    const p = tracker.refresh(anchored(), { [PROJECT]: ROOT });
    git.flush();
    assert.equal(await p, false);
  });

  assert.equal(errors.length, 1);
  assert.match(errors[0], /git log failed/);
  assert.match(errors[0], /128/);
  assert.equal(Object.hasOwn(tracker.current(), PROJECT), false);
  const { items } = reviewList({ records: anchored(), today: TODAY, changes: tracker.current() });
  assert.deepEqual(items, []);
});

test('an answer that turns into a failure repaints, so its flags go away', async () => {
  let fail = false;
  const git = stubGit(() => (fail ? { error: Object.assign(new Error('x'), { killed: true }) } : answerA()));
  let now = NOW;
  const tracker = createChangeTracker({ exec: git.exec, now: () => now, headOf: () => null });
  const refresh = async () => {
    const p = tracker.refresh(anchored(), { [PROJECT]: ROOT });
    git.flush();
    return p;
  };

  assert.equal(await refresh(), true);
  fail = true;
  now += CHANGES_TTL_MS + 1;
  const errors = await capturedErrors(async () => assert.equal(await refresh(), true));
  assert.match(errors[0], /timeout/);
  assert.deepEqual(tracker.current(), {});
});

test("a failure's reason says what git said, never the whole command line", async () => {
  const query = { root: ROOT, since: '2026-11-01', paths: ['src/a.js'] };
  const failing = (fields) => Object.assign(new Error(`Command failed: git -C ${ROOT} log -- src/a.js`), fields);
  const flushed = async (res) => {
    const git = stubGit(() => res);
    const p = readChanges(query, { exec: git.exec });
    git.flush();
    return (await p).reason;
  };

  const ownership = "fatal: detected dubious ownership in repository at 'C:/repo'\nTo add an exception for this directory, call:";
  assert.equal(await flushed({ error: failing({ code: 128 }), stderr: ownership }), "exit 128: fatal: detected dubious ownership in repository at 'C:/repo'");
  assert.equal(await flushed({ error: failing({ code: 128 }) }), 'exit 128');
  assert.equal(await flushed({ error: failing({ code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', killed: true }) }), 'output too large');
  assert.equal(await flushed({ error: failing({ killed: true, signal: 'SIGTERM' }) }), 'timeout');
  assert.equal(await flushed({ error: failing({ code: null, signal: 'SIGKILL' }) }), 'SIGKILL');
  assert.equal(await flushed({ error: failing({ code: 'ENOENT' }) }), 'ENOENT');
  const noisy = await flushed({ error: failing({ code: 1 }), stderr: `error: \u001b[31mred\u001b[0m ${'y'.repeat(500)}` });
  assert.equal(noisy.includes('\u001b'), false);
  assert.ok(noisy.length <= 'exit 1: '.length + 200);
});

test('readChanges refuses a bad query without running git', async () => {
  const git = stubGit();
  assert.deepEqual(await readChanges({ root: 'relative', since: '2026-11-01', paths: ['src/a.js'] }, { exec: git.exec }), { ok: false, reason: 'bad-query' });
  assert.deepEqual(await readChanges({ root: ROOT, since: 'yesterday', paths: ['src/a.js'] }, { exec: git.exec }), { ok: false, reason: 'bad-query' });
  assert.deepEqual(await readChanges({ root: ROOT, since: '2026-11-01', paths: [] }, { exec: git.exec }), { ok: false, reason: 'bad-query' });
  assert.equal(git.calls.length, 0);
});

test('cachedChanges hands back the cache at once and repaints when the refresh differs', async () => {
  const git = stubGit(answerA);
  const tracker = createChangeTracker({ exec: git.exec, now: () => NOW, headOf: () => 'h1' });
  let repaints = 0;

  assert.deepEqual(cachedChanges(tracker, anchored(), { [PROJECT]: ROOT }, () => repaints++), {});
  git.flush();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(repaints, 1);
  assert.equal(cachedChanges(tracker, anchored(), { [PROJECT]: ROOT }, () => repaints++)[PROJECT].size, 1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(repaints, 1);
  assert.equal(git.calls.length, 1);
  assert.deepEqual(cachedChanges(null, anchored(), {}, () => repaints++), {});
});

// ---- the IPC: the list uses the cache, "still true" works on a 'changed' memory --------

test('memory:review shows a changed flag after the refresh lands, and "still true" clears it', async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-memchanges-'));
  t.after(() => fs.promises.rm(base, { recursive: true, force: true, maxRetries: 5 }));
  const dir = path.join(base, 'memory');
  const repo = path.join(base, 'repo');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'src', 'a.js'), '');
  writeRecord(dir, rec('a', { body: 'See `src/a.js`.' }));
  const git = stubGit(answerA);
  const tracker = createChangeTracker({ exec: git.exec, now: () => NOW, headOf: () => 'h1' });
  const handlers = {};
  let repaints = 0;
  registerMemoryIpc({
    ipcMain: { handle: (channel, fn) => (handlers[channel] = fn) },
    dir: () => dir,
    onChanged: () => repaints++,
    now: () => NOW,
    log: createLog(logPath(base), { now: () => NOW }),
    roots: () => ({ [PROJECT]: repo }),
    changes: tracker,
  });

  assert.deepEqual(handlers['memory:review']().items, [], 'the first paint has no answer yet');
  git.flush();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(repaints, 1);
  const [item] = handlers['memory:review']().items;
  assert.deepEqual(item.flags, [{ kind: 'changed', files: ['src/a.js'], last: '2026-11-14' }]);

  assert.equal(handlers['memory:verify']({}, `${PROJECT}/a`).ok, true);
  assert.equal(Object.fromEntries(scan(dir).records)[`${PROJECT}/a`].last_verified, TODAY);
  assert.deepEqual(handlers['memory:review']().items, []);
  assert.equal(git.calls.length, 1, 'verifying moved the date, not the paths: no new call');
});

// ---- "Check all" order ---------------------------------------------------------------

test('"Check all" checks memories whose files changed first, even one checked lately', () => {
  const records = entries(
    rec('old', { created: '2026-01-01' }),
    rec('disputed', { created: '2026-10-01' }),
    rec('changed', { created: '2026-11-01', body: '`src/a.js`' }),
    rec('recent', { created: '2026-02-01', body: '`src/b.js`' }),
  );
  const events = [
    { at: NOW - DAY_MS, ev: 'disputed', key: `${PROJECT}/disputed`, by: 'tool', note: 'wrong' },
    // Checked three days ago, answer "unknown": its file changed two days ago.
    { at: NOW - 3 * DAY_MS, ev: 'checked', key: `${PROJECT}/recent`, verdict: 'unknown' },
  ];
  const changes = new Map([
    ['src/a.js', '2026-11-14T10:00:00.000Z'],
    ['src/b.js', '2026-11-14T10:00:00.000Z'],
  ]);

  assert.deepEqual(checkAllTargets({ records, events, project: PROJECT, now: NOW, changes }), [
    `${PROJECT}/recent`,
    `${PROJECT}/changed`,
    `${PROJECT}/disputed`,
    `${PROJECT}/old`,
  ]);
  const before = new Map([['src/b.js', '2026-11-12T10:00:00.000Z']]);
  assert.deepEqual(checkAllTargets({ records, events, project: PROJECT, now: NOW, changes: before }), [`${PROJECT}/disputed`, `${PROJECT}/old`, `${PROJECT}/changed`], 'a change older than the check: still skipped');
});

// ---- one real git log ------------------------------------------------------------------

/** git's kill timer in the real-repository test: generous, the suite may run under heavy load. */
const REAL_GIT_TIMEOUT_MS = 5 * 60 * 1000;

test('createChangeTracker: gitTimeoutMs is the kill timer of git log; 15 s by default', async () => {
  const timeouts = [];
  const exec = (bin, args, opts, cb) => {
    timeouts.push(opts.timeout);
    setImmediate(() => cb(null, '', ''));
  };
  const records = entries(rec('a', { body: 'Names `src/a.js`.', created: '2026-11-05' }));
  const root = path.resolve('repo-root');
  await createChangeTracker({ exec, now: () => NOW, headOf: () => null }).refresh(records, { [PROJECT]: root });
  await createChangeTracker({ exec, now: () => NOW, headOf: () => null, gitTimeoutMs: 1234 }).refresh(records, { [PROJECT]: root });
  assert.deepEqual(timeouts, [15000, 1234]);
});

/** git with no user config, hooks or signing in the way. */
function git(cwd, args, date) {
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date };
  const config = ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', '-c', `core.hooksPath=${path.join(cwd, '.no-hooks')}`];
  return execFileSync('git', [...config, ...args], { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
}

test('a real repository: a commit after the check flags the memory, one before does not', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-memchanges-git-'));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true, maxRetries: 5 }));
  fs.mkdirSync(path.join(root, 'src'));
  git(root, ['init', '-q'], '2026-11-01T10:00:00Z');
  fs.writeFileSync(path.join(root, 'src', 'old.js'), 'one');
  fs.writeFileSync(path.join(root, 'src', 'new.js'), 'one');
  git(root, ['add', '.'], '2026-11-01T10:00:00Z');
  git(root, ['commit', '-q', '--no-verify', '-m', 'first'], '2026-11-01T10:00:00Z');
  fs.writeFileSync(path.join(root, 'src', 'new.js'), 'two');
  git(root, ['commit', '-q', '--no-verify', '-am', 'second'], '2026-11-14T10:00:00Z');

  const records = entries(rec('a', { body: 'Names `src/old.js` and `src/new.js`.', created: '2026-11-05' }));
  // A loaded machine (parallel suites) can take longer than the HUD's 15 s for one git call.
  const tracker = createChangeTracker({ now: () => NOW, gitTimeoutMs: REAL_GIT_TIMEOUT_MS });
  assert.ok(headSignature(root), 'HEAD is read without running git');
  assert.equal(await tracker.refresh(records, { [PROJECT]: root }), true);

  assert.deepEqual([...tracker.current()[PROJECT]], [['src/new.js', '2026-11-14T10:00:00.000Z']]);
  const [item] = reviewList({ records, today: TODAY, changes: tracker.current() }).items;
  assert.deepEqual(item.flags, [{ kind: 'changed', files: ['src/new.js'], last: '2026-11-14' }]);
});
