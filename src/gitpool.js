// ============================================================================
// LunaCore - one shared limit on the git processes the HUD starts
// ----------------------------------------------------------------------------
// With several God Mode packages open, every tab's GitFileWatcher (gitfiles.js)
// and the git station (gitstation.js) shelled out to git on their own timers.
// Under load (parallel `npm test` runs) a `git status` took longer than the
// poll interval, so new calls started before the old ones ended: about 300
// `git -C <worktree> status --porcelain=v2 -z` processes were seen at once,
// starving every shell on the machine.
//
// This module is the one door those calls go through:
//   - calls run in one of two lanes, each with its own slots and FIFO queue:
//     `fast` (status, log -1, rev-parse, short local work; MAX_CONCURRENT_GIT
//     slots) and `slow` (network calls, worktree add/remove, log --all, any
//     call allowed more than FAST_LANE_MAX_TIMEOUT_MS; MAX_SLOW_GIT slots).
//     Four hung fetches fill the slow lane only: status polls keep running.
//     At most MAX_CONCURRENT_GIT + MAX_SLOW_GIT git children exist at once.
//   - a read-only call (SHAREABLE_COMMANDS) identical to one already queued or
//     running (same folder, args, timeout and buffer) does not start a second
//     process: both callers get the same answer
//   - a write (commit, push, add, fetch, ...) is never shared, only queued;
//     it also ends the sharing of reads of its folder, so a read asked for
//     after the write never gets an answer from before it
//   - withGitSlot() lets a caller that spawns git itself (worktrees.runGit,
//     which needs the raw error for its diagnostics) hold a lane slot too
//
// Every run() call resolves { ok, stdout, stderr } and never rejects. The
// timeout is git's own (execFile's), counted from the moment the process starts.
// ============================================================================

'use strict';

const { execFile } = require('child_process');

// Fast lane: enough for the station's status + log pair plus a tab poll and a diff.
const MAX_CONCURRENT_GIT = 4;
// Slow lane: fetch/push, worktree add/remove, log --all. Separate slots, so
// these can never take one a status poll needs.
const MAX_SLOW_GIT = 4;
// A call allowed to run longer than this is slow, whatever its subcommand.
const FAST_LANE_MAX_TIMEOUT_MS = 30000;
const LANES = ['fast', 'slow'];
const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_MAX_BUFFER = 4 * 1024 * 1024;
// Subcommands that only read: two identical calls in flight give one answer.
const SHAREABLE_COMMANDS = new Set(['status', 'log', 'diff', 'rev-parse']);
// Subcommands that talk to a remote or do heavy repository-wide work.
const SLOW_COMMANDS = new Set(['fetch', 'push', 'pull', 'clone', 'ls-remote', 'gc', 'repack', 'submodule']);
// `git worktree <action>` actions that write or delete a whole checkout.
const SLOW_WORKTREE_ACTIONS = new Set(['add', 'remove', 'move']);

const positive = (v, fallback) => (Number.isFinite(v) && v > 0 ? v : fallback);

// Global options that take the next arg as their value (`-c k=v`, `-C dir`).
const OPTIONS_WITH_VALUE = new Set(['-c', '-C']);

/** Index of the git subcommand in an args list, past leading global options; -1 if none. */
function subcommandIndex(args) {
  for (let i = 0; i < args.length; i += 1) {
    const a = String(args[i]);
    if (OPTIONS_WITH_VALUE.has(a)) i += 1;
    else if (!a.startsWith('-')) return i;
  }
  return -1;
}

/** The git subcommand in an args list, past any leading global options. */
function subcommandOf(args) {
  const i = subcommandIndex(args);
  return i < 0 ? '' : String(args[i]);
}

/** True when this args list only reads and may share another caller's process. */
function isShareable(args) {
  return Array.isArray(args) && SHAREABLE_COMMANDS.has(subcommandOf(args));
}

/**
 * Which lane a call runs in: 'slow' for network, whole-checkout or
 * whole-history work or a long timeout; 'fast' for everything else.
 * @param {string[]} args
 * @param {number} [timeoutMs]
 * @returns {'fast'|'slow'}
 */
function laneOf(args, timeoutMs) {
  if (Number.isFinite(timeoutMs) && timeoutMs > FAST_LANE_MAX_TIMEOUT_MS) return 'slow';
  const list = Array.isArray(args) ? args.map(String) : [];
  const at = subcommandIndex(list);
  if (at < 0) return 'fast';
  const cmd = list[at];
  const rest = list.slice(at + 1);
  if (SLOW_COMMANDS.has(cmd)) return 'slow';
  if (cmd === 'worktree' && SLOW_WORKTREE_ACTIONS.has(rest[0])) return 'slow';
  if (cmd === 'log' && rest.includes('--all')) return 'slow';
  return 'fast';
}

/**
 * @param {{maxConcurrent?: number, maxSlow?: number, execFileImpl?: Function}} [opts]
 *   maxConcurrent: fast-lane slots; maxSlow: slow-lane slots
 * @returns {{run: (dir:string, args:string[], o?:{timeout?:number, maxBuffer?:number, lane?:string}) =>
 *   Promise<{ok:boolean, stdout:string, stderr:string}>,
 *   withSlot: (lane:string, task:() => any) => Promise<any>,
 *   forgetReads: (dir:string) => void,
 *   stats: () => {active:number, queued:number},
 *   laneStats: () => {fast:{active:number, queued:number}, slow:{active:number, queued:number}}}}
 */
function createGitPool(opts = {}) {
  const execFileImpl = opts.execFileImpl || execFile;
  const lanes = {
    fast: { max: positive(opts.maxConcurrent, MAX_CONCURRENT_GIT), active: 0, queue: [] },
    slow: { max: positive(opts.maxSlow, MAX_SLOW_GIT), active: 0, queue: [] },
  };
  // Key -> {dir, promise}: the answer every caller of an identical read-only
  // call shares.
  const shared = new Map();

  /** A write to `dir` makes every shared read of it stale for later callers. */
  function forgetReadsOf(dir) {
    const where = String(dir);
    for (const [key, entry] of shared) if (entry.dir === where) shared.delete(key);
  }

  /** Starts one job in its lane; the slot is freed when its task settles. */
  function start(lane, job) {
    lane.active += 1;
    const finish = (settle) => {
      lane.active -= 1;
      settle();
      drain(lane);
    };
    let pending;
    try {
      pending = Promise.resolve(job.task());
    } catch (err) {
      // A task that throws synchronously still frees its slot.
      pending = Promise.reject(err);
    }
    pending.then(
      (value) => finish(() => job.resolve(value)),
      (err) => finish(() => job.reject(err)),
    );
  }

  function drain(lane) {
    while (lane.active < lane.max && lane.queue.length) start(lane, lane.queue.shift());
  }

  /**
   * Runs task() once a slot in `lane` is free and holds that slot until the
   * promise it returns settles. Resolves or rejects as the task does.
   */
  function withSlot(laneName, task) {
    const lane = lanes[laneName] || lanes.fast;
    return new Promise((resolve, reject) => {
      lane.queue.push({ task, resolve, reject });
      drain(lane);
    });
  }

  /** One git child; never rejects. */
  function spawnGit(dir, args, timeout, maxBuffer) {
    return new Promise((resolve) => {
      try {
        execFileImpl(
          'git',
          ['-C', dir, ...args],
          { windowsHide: true, timeout, maxBuffer },
          (err, stdout, stderr) => resolve({ ok: !err, stdout: String(stdout || ''), stderr: String(stderr || '') }),
        );
      } catch (err) {
        // A synchronous spawn failure still frees the slot and answers the caller.
        resolve({ ok: false, stdout: '', stderr: err instanceof Error ? err.message : String(err) });
      }
    });
  }

  function enqueue(lane, dir, args, timeout, maxBuffer) {
    return withSlot(lane, () => spawnGit(dir, args, timeout, maxBuffer));
  }

  function run(dir, args, o = {}) {
    const list = Array.isArray(args) ? args.map(String) : [];
    const timeout = positive(o.timeout, DEFAULT_TIMEOUT_MS);
    const maxBuffer = positive(o.maxBuffer, DEFAULT_MAX_BUFFER);
    const lane = LANES.includes(o.lane) ? o.lane : laneOf(list, timeout);
    const where = String(dir);
    if (!isShareable(list)) {
      // A read asked for after this write must not get an answer from before
      // it: drop the shared reads now and again once the write is done.
      forgetReadsOf(where);
      return enqueue(lane, dir, list, timeout, maxBuffer).then((res) => {
        forgetReadsOf(where);
        return res;
      });
    }
    const key = JSON.stringify([where, list, timeout, maxBuffer]);
    let entry = shared.get(key);
    if (!entry) {
      const promise = enqueue(lane, dir, list, timeout, maxBuffer).finally(() => {
        if (shared.get(key) === entry) shared.delete(key);
      });
      entry = { dir: where, promise };
      shared.set(key, entry);
    }
    // Each caller gets its own copy of the shared answer.
    return entry.promise.then((res) => ({ ...res }));
  }

  const laneStats = () => ({
    fast: { active: lanes.fast.active, queued: lanes.fast.queue.length },
    slow: { active: lanes.slow.active, queued: lanes.slow.queue.length },
  });
  const stats = () => ({
    active: lanes.fast.active + lanes.slow.active,
    queued: lanes.fast.queue.length + lanes.slow.queue.length,
  });

  return { run, withSlot, forgetReads: forgetReadsOf, stats, laneStats };
}

// The pool every HUD git caller uses (the pollers and worktrees.runGit).
const sharedPool = createGitPool();

module.exports = {
  createGitPool,
  isShareable,
  laneOf,
  runPooledGit: sharedPool.run,
  withGitSlot: sharedPool.withSlot,
  forgetPooledReads: sharedPool.forgetReads,
  gitPoolStats: sharedPool.stats,
  gitPoolLaneStats: sharedPool.laneStats,
  MAX_CONCURRENT_GIT,
  MAX_SLOW_GIT,
  FAST_LANE_MAX_TIMEOUT_MS,
  SHAREABLE_COMMANDS,
};
