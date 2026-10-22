// ============================================================================
// LunaCore - God Mode v2 power options (sleepOnLimit, shutdownWhenDone)
// ----------------------------------------------------------------------------
// Decides WHEN to sleep or shut the PC down; src/powerctl.js does the OS part.
//
// Sleep at the usage limit: the run is paused until the reset. With
// sleepOnLimit on, a wake task is scheduled for the reset (+ the resume
// grace) and ONLY when that worked is keep-awake released and a 60 s
// countdown started (cancelable on the board); then the PC is suspended.
// It never sleeps when the wake could not be scheduled, the run was killed
// or a worker sits on a permission prompt. On the system resume the wake
// task is deleted and keep-awake comes back (orchestra.js re-arms or resumes
// the run itself).
//
// Shutdown when done: after a settled run's finalize has fully completed,
// the option is read again at that moment; keep-awake released, pending
// writes flushed, `shutdown /s /t 120` scheduled and a 120 s countdown shown
// with "Cancel shutdown" (shutdown /a). The run report gets the time.
//
// State lives here only as long as a countdown does; nothing is persisted.
// ============================================================================

'use strict';

const SLEEP_COUNTDOWN_MS = 60 * 1000;
const SHUTDOWN_DELAY_S = 120;

const hhmm = (ms) => {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

/**
 * @param {{
 *   power: {scheduleWake:Function, cancelWake:Function, sleepNow:Function, canWake:Function, shutdownIn:Function, abortShutdown:Function},
 *   getRun: () => null|{planId:string, pausedUntil:number|null, killed:boolean, approvalsPending:boolean,
 *     options:{sleepOnLimit:boolean, shutdownWhenDone:boolean}},
 *   awake?: {release:Function, restore:Function},
 *   flush?: () => void|Promise<void>,
 *   notify?: (kind:string, info?:object) => void,
 *   appendReport?: (planId:string, line:string) => void,
 *   onChange?: () => void,
 *   graceMs?: number, now?: () => number,
 *   setTimer?: Function, clearTimer?: Function, log?: Function,
 * }} deps
 */
function createPowerFlow(deps) {
  const noop = () => {};
  const { power, getRun } = deps;
  const awake = deps.awake || { release: noop, restore: noop };
  const flush = deps.flush || noop;
  const notify = deps.notify || noop;
  const appendReport = deps.appendReport || noop;
  const onChange = deps.onChange || noop;
  const graceMs = deps.graceMs || 0;
  const now = deps.now || Date.now;
  const setTimer = deps.setTimer || setTimeout;
  const clearTimer = deps.clearTimer || clearTimeout;
  const log = deps.log || noop;

  /** @type {null|{phase:'scheduling'|'countdown'|'sleeping', at:number|null, wakeAt:number}} */
  let sleep = null;
  /** @type {null|{phase:'arming'|'countdown', at:number|null, planId:string}} */
  let shutdown = null;
  let sleepError = null;
  let shutdownError = null;
  let wake = null; // the last canWake() result
  let sleepTimer = null;
  let wakeScheduled = false;
  let awakeReleased = false;
  // Bumped on every cancel: an await that comes back to a newer token lost.
  let sleepToken = 0;
  let shutdownToken = 0;

  const safe = async (fn) => {
    try {
      return (await fn()) || { ok: false, reason: 'error' };
    } catch {
      return { ok: false, reason: 'error' };
    }
  };

  function releaseAwake() {
    if (awakeReleased) return;
    awakeReleased = true;
    awake.release();
  }

  function restoreAwake() {
    if (!awakeReleased || sleep || shutdown) return;
    awakeReleased = false;
    awake.restore();
  }

  function canSleep(run) {
    return !!run && !!run.pausedUntil && !run.killed && !run.approvalsPending && run.options.sleepOnLimit === true;
  }

  async function dropWake() {
    if (!wakeScheduled) return;
    wakeScheduled = false;
    const res = await safe(() => power.cancelWake());
    if (!res.ok) log(`cancelWake failed: ${res.reason}`);
  }

  /** Stops a sleep in any phase: countdown, wake task, keep-awake back. */
  async function cancelSleep() {
    sleepToken += 1;
    if (sleepTimer) clearTimer(sleepTimer);
    sleepTimer = null;
    const had = !!sleep || wakeScheduled;
    sleep = null;
    restoreAwake();
    await dropWake();
    if (had) onChange();
    return { ok: true };
  }

  async function fireSleep(token) {
    sleepTimer = null;
    if (token !== sleepToken) return;
    if (!canSleep(getRun())) {
      await cancelSleep();
      return;
    }
    sleep = { ...sleep, phase: 'sleeping' };
    onChange();
    log('suspending the PC until the usage limit resets');
    const res = await safe(() => power.sleepNow());
    if (res.ok || token !== sleepToken) return;
    sleepError = res.reason;
    notify('sleepFailed', { reason: res.reason });
    await cancelSleep();
  }

  /**
   * The run paused at the usage limit (or the pause got longer, or the
   * option was ticked while paused): schedule the wake, then count down.
   */
  async function onPaused() {
    const run = getRun();
    if (!canSleep(run)) return { ok: false, reason: 'notEligible' };
    // A longer pause re-schedules the wake for the new reset.
    if (sleep && sleep.wakeAt === run.pausedUntil + graceMs) return { ok: true };
    if (sleep) await cancelSleep();
    const token = ++sleepToken;
    const wakeAt = run.pausedUntil + graceMs;
    sleep = { phase: 'scheduling', at: null, wakeAt };
    sleepError = null;
    onChange();
    const res = await safe(() => power.scheduleWake(wakeAt));
    if (token !== sleepToken) {
      // Canceled meanwhile: a task that got created anyway goes too.
      if (res.ok) await safe(() => power.cancelWake());
      return { ok: false, reason: 'canceled' };
    }
    if (!res.ok) {
      sleep = null;
      sleepError = res.reason || 'error';
      notify('sleepFailed', { reason: sleepError });
      onChange();
      return { ok: false, reason: sleepError };
    }
    wakeScheduled = true;
    if (!canSleep(getRun())) {
      await cancelSleep();
      return { ok: false, reason: 'notEligible' };
    }
    releaseAwake();
    sleep = { phase: 'countdown', at: now() + SLEEP_COUNTDOWN_MS, wakeAt };
    notify('sleepSoon', { at: sleep.at, wakeAt });
    onChange();
    sleepTimer = setTimer(() => fireSleep(token), SLEEP_COUNTDOWN_MS);
    return { ok: true };
  }

  /** powerMonitor 'resume': the sleep is over (ours or not). */
  async function onSystemResume() {
    if (!sleep && !wakeScheduled && !awakeReleased) return;
    if (!shutdown) await cancelSleep();
  }

  async function cancelShutdown() {
    if (!shutdown) return { ok: false, reason: 'none' };
    shutdownToken += 1;
    const { phase, planId } = shutdown;
    shutdown = null;
    restoreAwake();
    if (phase === 'countdown') {
      const res = await safe(() => power.abortShutdown());
      if (!res.ok) log(`abortShutdown failed: ${res.reason}`);
      appendReport(planId, `- Shutdown canceled at ${hhmm(now())}`);
    }
    onChange();
    return { ok: true };
  }

  /**
   * A settled run's finalize is done. Shuts down only when the option is on
   * NOW, the run was not killed and nothing else runs (`busy`).
   * @param {{busy:boolean}} ctx
   */
  async function afterFinalize({ busy }) {
    const run = getRun();
    if (!run || run.killed || busy || shutdown || run.options.shutdownWhenDone !== true) return { ok: false, reason: 'notEligible' };
    const token = ++shutdownToken;
    shutdown = { phase: 'arming', at: null, planId: run.planId };
    shutdownError = null;
    if (sleep) await cancelSleep();
    releaseAwake();
    try {
      await flush();
    } catch (err) {
      log(`flush before shutdown failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    const again = getRun();
    if (token !== shutdownToken) return { ok: false, reason: 'canceled' };
    if (!again || again.killed || again.options.shutdownWhenDone !== true) {
      await cancelShutdown();
      return { ok: false, reason: 'notEligible' };
    }
    const res = await safe(() => power.shutdownIn(SHUTDOWN_DELAY_S));
    if (token !== shutdownToken) {
      if (res.ok) await safe(() => power.abortShutdown());
      return { ok: false, reason: 'canceled' };
    }
    if (!res.ok) {
      shutdownError = res.reason || 'error';
      shutdown = null;
      restoreAwake();
      notify('shutdownFailed', { reason: shutdownError });
      onChange();
      return { ok: false, reason: shutdownError };
    }
    const at = now() + SHUTDOWN_DELAY_S * 1000;
    shutdown = { phase: 'countdown', at, planId: run.planId };
    appendReport(run.planId, `- PC shut down at ${hhmm(at)}`);
    notify('shutdownSoon', { at });
    onChange();
    return { ok: true };
  }

  /** The options changed: unticking cancels whatever that option started. */
  async function onOptions(options) {
    if (!options) return;
    if (options.shutdownWhenDone !== true && shutdown) await cancelShutdown();
    if (options.sleepOnLimit !== true && (sleep || wakeScheduled)) await cancelSleep();
    else if (options.sleepOnLimit === true && !sleep) await onPaused();
  }

  /** Best-effort wake check for the note under the sleep option. Once per app run. */
  async function checkWake() {
    if (wake) return wake;
    const res = await safe(() => power.canWake());
    wake = { ok: res.ok === true, reason: res.reason || null };
    onChange();
    return wake;
  }

  function view() {
    return {
      sleep: sleep ? { phase: sleep.phase, at: sleep.at, wakeAt: sleep.wakeAt } : null,
      shutdown: shutdown ? { phase: shutdown.phase, at: shutdown.at } : null,
      sleepError,
      shutdownError,
      wake,
    };
  }

  return { onPaused, cancelSleep, onSystemResume, afterFinalize, cancelShutdown, onOptions, checkWake, view };
}

module.exports = { createPowerFlow, SLEEP_COUNTDOWN_MS, SHUTDOWN_DELAY_S };
