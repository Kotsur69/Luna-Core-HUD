// ============================================================================
// LunaCore - bounded concurrency semaphore for heavy verification suites
// ----------------------------------------------------------------------------
// Multiple God Mode / Luna's Work worktrees can finish at the same time. Each
// post-DONE verify or end-of-run self-check runs a heavy test suite (`npm test`,
// Unity test runner, etc.). Running several concurrently saturates CPU/disk and
// causes false `[LunaCore: verify timed out]` failures even when every test is
// healthy.
//
// This semaphore bounds how many heavy verifications execute at once (default 1)
// in strict FIFO order, supports cancellation before or while queued, and
// always releases its slot when a task resolves, rejects, or throws.
// ============================================================================

'use strict';

const DEFAULT_VERIFY_CONCURRENCY = 1;

/**
 * Normalizes a concurrency limit from either a number or `{ maxConcurrency }`.
 * Anything other than a positive integer falls back to DEFAULT_VERIFY_CONCURRENCY.
 * @param {number|{maxConcurrency?: number}|undefined} opts
 * @returns {number}
 */
function normalizeConcurrency(opts) {
  const raw = typeof opts === 'number' ? opts : opts && typeof opts === 'object' ? opts.maxConcurrency : undefined;
  return Number.isInteger(raw) && raw >= 1 ? raw : DEFAULT_VERIFY_CONCURRENCY;
}

/** Calls an observer hook; a throwing hook never breaks the semaphore. */
function safeHook(fn, arg) {
  if (typeof fn !== 'function') return;
  try {
    fn(arg);
  } catch {
    /* observer failure must not leak or stall a slot */
  }
}

/**
 * Creates a bounded concurrency FIFO semaphore.
 * @param {number|{maxConcurrency?: number, now?: () => number}} [opts]
 * @returns {{
 *   acquire: (hooks?: {onQueued?: Function, onStart?: Function, isCancelled?: () => boolean}) =>
 *     Promise<{acquired: boolean, cancelled: boolean, waited: boolean, waitedMs: number, release: () => void}>,
 *   run: <T>(task: (info: {waited: boolean, waitedMs: number}) => Promise<T>|T,
 *     hooks?: {onQueued?: Function, onStart?: Function, isCancelled?: () => boolean, cancelledValue?: any}) => Promise<T>,
 *   stats: () => {active: number, queued: number, maxConcurrency: number},
 *   maxConcurrency: number,
 * }}
 */
function createVerifySemaphore(opts = {}) {
  const maxConcurrency = normalizeConcurrency(opts);
  const rawNow = opts && typeof opts === 'object' && typeof opts.now === 'function' ? opts.now : Date.now;
  const safeNow = () => {
    try {
      const t = rawNow();
      return Number.isFinite(t) ? t : 0;
    } catch {
      return 0;
    }
  };

  let active = 0;
  /** @type {Array<{queuedAt: number, hooks: object, grant: Function, cancel: Function}>} */
  const queue = [];

  function isCancelled(hooks) {
    if (!hooks || typeof hooks.isCancelled !== 'function') return false;
    try {
      return hooks.isCancelled() === true;
    } catch {
      return false;
    }
  }

  function makeRelease() {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      active = Math.max(0, active - 1);
      drain();
    };
  }

  function drain() {
    while (active < maxConcurrency && queue.length > 0) {
      const next = queue.shift();
      const waitedMs = Math.max(0, safeNow() - next.queuedAt);
      if (isCancelled(next.hooks)) {
        next.cancel(waitedMs);
        continue;
      }
      active += 1;
      safeHook(next.hooks.onStart, { waited: true, waitedMs });
      next.grant(makeRelease(), { waited: true, waitedMs });
    }
  }

  function acquire(hooks = {}) {
    const h = hooks && typeof hooks === 'object' ? hooks : {};
    if (isCancelled(h)) {
      return Promise.resolve({ acquired: false, cancelled: true, waited: false, waitedMs: 0, release: () => {} });
    }
    const queuedAt = safeNow();
    if (active < maxConcurrency && queue.length === 0) {
      active += 1;
      safeHook(h.onStart, { waited: false, waitedMs: 0 });
      return Promise.resolve({ acquired: true, cancelled: false, waited: false, waitedMs: 0, release: makeRelease() });
    }
    const ahead = active + queue.length;
    safeHook(h.onQueued, { ahead });
    return new Promise((resolve) => {
      queue.push({
        queuedAt,
        hooks: h,
        grant: (release, info) => resolve({ acquired: true, cancelled: false, ...info, release }),
        cancel: (waitedMs) => resolve({ acquired: false, cancelled: true, waited: true, waitedMs, release: () => {} }),
      });
    });
  }

  const cancelledResult = (h, waitedMs) =>
    Object.prototype.hasOwnProperty.call(h, 'cancelledValue')
      ? h.cancelledValue
      : { ok: false, output: '', timedOut: false, cancelled: true, waitedMs };

  async function run(task, hooks = {}) {
    if (typeof task !== 'function') throw new TypeError('task must be a function');
    const h = hooks && typeof hooks === 'object' ? hooks : {};
    const slot = await acquire(h);
    if (!slot.acquired) return cancelledResult(h, slot.waitedMs);
    try {
      if (isCancelled(h)) return cancelledResult(h, slot.waitedMs);
      return await task({ waited: slot.waited, waitedMs: slot.waitedMs });
    } finally {
      slot.release();
    }
  }

  const stats = () => ({ active, queued: queue.length, maxConcurrency });

  return { acquire, run, stats, maxConcurrency };
}

let shared = null;

/** The process-wide verification semaphore shared across God Mode runs and self-checks. */
function sharedVerifySemaphore() {
  if (!shared) shared = createVerifySemaphore({ maxConcurrency: DEFAULT_VERIFY_CONCURRENCY });
  return shared;
}

module.exports = {
  createVerifySemaphore,
  sharedVerifySemaphore,
  DEFAULT_VERIFY_CONCURRENCY,
};
