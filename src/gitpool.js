// ============================================================================
// LunaCore - one shared limit on the git processes the HUD's pollers start
// ----------------------------------------------------------------------------
// With several God Mode packages open, every tab's GitFileWatcher (gitfiles.js)
// and the git station (gitstation.js) shelled out to git on their own timers.
// Under load (parallel `npm test` runs) a `git status` took longer than the
// poll interval, so new calls started before the old ones ended: about 300
// `git -C <worktree> status --porcelain=v2 -z` processes were seen at once,
// starving every shell on the machine.
//
// This module is the one door those calls go through:
//   - at most MAX_CONCURRENT_GIT git children run at a time, across all
//     folders; the rest wait in a FIFO queue
//   - a read-only call (SHAREABLE_COMMANDS) identical to one already queued or
//     running (same folder, args, timeout and buffer) does not start a second
//     process: both callers get the same answer
//   - a write (commit, push, add, fetch, ...) is never shared, only queued;
//     it also ends the sharing of reads of its folder, so a read asked for
//     after the write never gets an answer from before it
//
// Every call resolves { ok, stdout, stderr } and never rejects. The timeout is
// git's own (execFile's), counted from the moment the process starts.
// ============================================================================

'use strict';

const { execFile } = require('child_process');

// Enough for the station's status + log pair plus a tab poll and a diff.
const MAX_CONCURRENT_GIT = 4;
const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_MAX_BUFFER = 4 * 1024 * 1024;
// Subcommands that only read: two identical calls in flight give one answer.
const SHAREABLE_COMMANDS = new Set(['status', 'log', 'diff', 'rev-parse']);

const positive = (v, fallback) => (Number.isFinite(v) && v > 0 ? v : fallback);

// Global options that take the next arg as their value (`-c k=v`, `-C dir`).
const OPTIONS_WITH_VALUE = new Set(['-c', '-C']);

/** The git subcommand in an args list, past any leading global options. */
function subcommandOf(args) {
  for (let i = 0; i < args.length; i += 1) {
    const a = String(args[i]);
    if (OPTIONS_WITH_VALUE.has(a)) i += 1;
    else if (!a.startsWith('-')) return a;
  }
  return '';
}

/** True when this args list only reads and may share another caller's process. */
function isShareable(args) {
  return Array.isArray(args) && SHAREABLE_COMMANDS.has(subcommandOf(args));
}

/**
 * @param {{maxConcurrent?: number, execFileImpl?: Function}} [opts]
 * @returns {{run: (dir:string, args:string[], o?:{timeout?:number, maxBuffer?:number}) =>
 *   Promise<{ok:boolean, stdout:string, stderr:string}>, stats: () => {active:number, queued:number}}}
 */
function createGitPool(opts = {}) {
  const maxConcurrent = positive(opts.maxConcurrent, MAX_CONCURRENT_GIT);
  const execFileImpl = opts.execFileImpl || execFile;
  let active = 0;
  const queue = [];
  // Key -> {dir, promise}: the answer every caller of an identical read-only
  // call shares.
  const shared = new Map();

  /** A write to `dir` makes every shared read of it stale for later callers. */
  function forgetReadsOf(dir) {
    for (const [key, entry] of shared) if (entry.dir === dir) shared.delete(key);
  }

  function spawnGit(job) {
    active += 1;
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      active -= 1;
      job.resolve(result);
      drain();
    };
    try {
      execFileImpl(
        'git',
        ['-C', job.dir, ...job.args],
        { windowsHide: true, timeout: job.timeout, maxBuffer: job.maxBuffer },
        (err, stdout, stderr) => finish({ ok: !err, stdout: String(stdout || ''), stderr: String(stderr || '') }),
      );
    } catch (err) {
      // A synchronous spawn failure still frees the slot and answers the caller.
      finish({ ok: false, stdout: '', stderr: err instanceof Error ? err.message : String(err) });
    }
  }

  function drain() {
    while (active < maxConcurrent && queue.length) spawnGit(queue.shift());
  }

  function enqueue(dir, args, timeout, maxBuffer) {
    return new Promise((resolve) => {
      queue.push({ dir, args, timeout, maxBuffer, resolve });
      drain();
    });
  }

  function run(dir, args, o = {}) {
    const list = Array.isArray(args) ? args.map(String) : [];
    const timeout = positive(o.timeout, DEFAULT_TIMEOUT_MS);
    const maxBuffer = positive(o.maxBuffer, DEFAULT_MAX_BUFFER);
    const where = String(dir);
    if (!isShareable(list)) {
      // A read asked for after this write must not get an answer from before
      // it: drop the shared reads now and again once the write is done.
      forgetReadsOf(where);
      return enqueue(dir, list, timeout, maxBuffer).then((res) => {
        forgetReadsOf(where);
        return res;
      });
    }
    const key = JSON.stringify([where, list, timeout, maxBuffer]);
    let entry = shared.get(key);
    if (!entry) {
      const promise = enqueue(dir, list, timeout, maxBuffer).finally(() => {
        if (shared.get(key) === entry) shared.delete(key);
      });
      entry = { dir: where, promise };
      shared.set(key, entry);
    }
    // Each caller gets its own copy of the shared answer.
    return entry.promise.then((res) => ({ ...res }));
  }

  return { run, stats: () => ({ active, queued: queue.length }) };
}

// The pool every HUD git poller uses.
const sharedPool = createGitPool();

module.exports = {
  createGitPool,
  isShareable,
  runPooledGit: sharedPool.run,
  gitPoolStats: sharedPool.stats,
  MAX_CONCURRENT_GIT,
  SHAREABLE_COMMANDS,
};
