// ============================================================================
// LunaCore - God Mode serial verify queue (one per process)
// ----------------------------------------------------------------------------
// A package's verify is usually the whole test suite (11-14 min). Run side by
// side they fight for CPU, miss the limit or fail on load, and every false
// failure sends a worker back for nothing. So every package verify - of every
// live God Mode run, every project (orchestraRegistry.js) - goes through ONE
// queue, one at a time:
//
//   - the limit (VERIFY_LIMIT_MS) counts from the moment a verify actually
//     starts, never from when it was queued
//   - a timed-out run has its whole process tree stopped (runVerify ->
//     procTree.killTree) and is run once more before it counts as a timeout;
//     the result says timedOut so the caller never hands it to a worker as
//     a test failure
//   - hooks.onQueued / onStart let the board show "waiting to verify"
//   - hooks.whenAllowed (the battery guard, src/orchestraPower.js) holds a
//     verify at the head of the queue until it may start: low on battery,
//     no new suite starts until the PC is plugged in
//
// Clock, timers, exec and the tree-kill are injected (tests); the process
// wide instance is sharedVerifyQueue(). Never rejects.
// ============================================================================

'use strict';

const { runVerify, VERIFY_TIMEOUT_MS } = require('./orchestraFinish');

const VERIFY_LIMIT_MS = VERIFY_TIMEOUT_MS;
// One automatic re-run of a timed-out verify.
const TIMEOUT_RERUNS = 1;

const noop = () => {};

/** Calls a hook; a throwing hook never breaks the queue. */
function safeCall(fn, arg) {
  if (typeof fn !== 'function') return;
  try {
    fn(arg);
  } catch {
    /* the board update failed; the verify itself goes on */
  }
}

/**
 * @param {{
 *   execImpl?: Function, killTree?: Function, setTimer?: Function, clearTimer?: Function,
 *   now?: () => number, limitMs?: number, runImpl?: Function, log?: (line:string) => void,
 * }} [deps] runImpl(command, cwd, {timeoutMs}) replaces runVerify entirely
 */
function createVerifyQueue(deps = {}) {
  const now = deps.now || Date.now;
  const limitMs = Number.isFinite(deps.limitMs) && deps.limitMs > 0 ? deps.limitMs : VERIFY_LIMIT_MS;
  const log = deps.log || noop;
  const runImpl =
    deps.runImpl ||
    ((command, cwd, opts) =>
      runVerify(command, cwd, deps.execImpl, {
        timeoutMs: opts.timeoutMs,
        killTree: deps.killTree,
        setTimer: deps.setTimer,
        clearTimer: deps.clearTimer,
      }));

  let tail = Promise.resolve();
  let waiting = 0;
  /** @type {null|{cwd:string, startedAt:number}} */
  let active = null;

  async function runOnce(command, cwd, timeoutMs) {
    try {
      const res = await runImpl(command, cwd, { timeoutMs });
      return res && typeof res === 'object' ? res : { ok: false, output: 'verify returned nothing', timedOut: false };
    } catch (err) {
      return { ok: false, output: err instanceof Error ? err.message : String(err), timedOut: false };
    }
  }

  /** Waits for hooks.whenAllowed(); a throwing hook never holds the queue. */
  async function holdIfNeeded(hooks) {
    if (typeof hooks.whenAllowed !== 'function') return;
    try {
      await hooks.whenAllowed();
    } catch {
      /* no hold: the verify goes on */
    }
  }

  async function runJob(command, cwd, hooks, queuedAt) {
    await holdIfNeeded(hooks);
    waiting -= 1;
    // A run killed while this verify waited: nothing to verify for any more,
    // and the next run's verify should not wait behind it.
    if (typeof hooks.isCancelled === 'function' && hooks.isCancelled()) {
      return { ok: false, output: '', timedOut: false, cancelled: true, reruns: 0, waitedMs: now() - queuedAt, ranMs: 0 };
    }
    const startedAt = now();
    active = { cwd, startedAt };
    safeCall(hooks.onStart, { waitedMs: startedAt - queuedAt });
    // The recovery playbook (orchestraRecover.js) re-runs a timed-out verify
    // alone with a longer limit and no further re-run.
    const limit = Number.isFinite(hooks.limitMs) && hooks.limitMs > 0 ? hooks.limitMs : limitMs;
    const maxReruns = Number.isInteger(hooks.timeoutReruns) && hooks.timeoutReruns >= 0 ? hooks.timeoutReruns : TIMEOUT_RERUNS;
    try {
      let res = await runOnce(command, cwd, limit);
      let reruns = 0;
      // No re-run when the timed-out tree could not be stopped: two suites
      // side by side is what this queue exists to prevent.
      while (res.timedOut && !res.killFailed && reruns < maxReruns) {
        reruns += 1;
        log(`[verify-queue] ${cwd}: timed out after ${Math.round(limit / 60000)} min, running it once more`);
        safeCall(hooks.onRerun, { attempt: reruns + 1 });
        res = await runOnce(command, cwd, limit);
      }
      return {
        ok: res.ok === true && !res.timedOut,
        output: String(res.output || ''),
        timedOut: res.timedOut === true,
        reruns,
        waitedMs: startedAt - queuedAt,
        ranMs: now() - startedAt,
      };
    } finally {
      active = null;
    }
  }

  /**
   * Queues one verify; resolves when it has run (after everything queued before it).
   * @param {string} command
   * @param {string} cwd
   * @param {{onQueued?:Function, onStart?:Function, onRerun?:Function, isCancelled?:() => boolean,
   *   whenAllowed?:() => Promise<void>, limitMs?:number, timeoutReruns?:number}} [hooks]
   *   limitMs / timeoutReruns: this run's own limit and re-run count
   * @returns {Promise<{ok:boolean, output:string, timedOut:boolean, reruns:number, waitedMs:number, ranMs:number}>}
   */
  function run(command, cwd, hooks = {}) {
    const queuedAt = now();
    const ahead = waiting + (active ? 1 : 0);
    waiting += 1;
    safeCall(hooks.onQueued, { ahead });
    const job = tail.then(() => runJob(command, cwd, hooks || {}, queuedAt));
    tail = job.catch(noop);
    return job;
  }

  return {
    run,
    limitMs,
    /** Verifies waiting for their turn (not counting the running one). */
    waiting: () => waiting,
    /** The running verify, or null. */
    active: () => (active ? { ...active } : null),
  };
}

let shared = null;

/** The one queue every God Mode run in this process shares. */
function sharedVerifyQueue() {
  if (!shared) shared = createVerifyQueue({ log: (line) => console.info(line) });
  return shared;
}

module.exports = { createVerifyQueue, sharedVerifyQueue, VERIFY_LIMIT_MS, TIMEOUT_RERUNS };
