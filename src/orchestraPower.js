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
//
// Battery (createBatteryGuard, one per process): the OS sleeps a laptop on
// its own battery policy and nothing here can block that. So on battery the
// board warns once per battery period (plus one notification), and where a
// percentage can be read, below LOW_BATTERY_PCT no new worker launches and
// no new verify starts until the PC is plugged in. A running worker is never
// stopped. Without a percentage it only warns. powerMonitor's 'on-battery' /
// 'on-ac' arrive through injected subscribe functions (main.js).
// ============================================================================

'use strict';

const SLEEP_COUNTDOWN_MS = 60 * 1000;
const SHUTDOWN_DELAY_S = 120;
// Below this battery percentage new workers and verifies wait for the charger.
const LOW_BATTERY_PCT = 20;
// How often the percentage is read while on battery.
const BATTERY_POLL_MS = 2 * 60 * 1000;

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

/** A battery percentage reading, or null when there is none. */
function percentOf(value) {
  const n = typeof value === 'number' ? value : value && typeof value === 'object' ? value.percent : NaN;
  return Number.isFinite(n) && n >= 0 && n <= 100 ? Math.round(n) : null;
}

/**
 * The process-wide battery guard every God Mode run shares.
 * @param {{
 *   isOnBattery?: () => boolean,
 *   onBatteryEvent?: (fn:Function) => void, onAcEvent?: (fn:Function) => void,
 *   readPercent?: () => Promise<number|{ok:boolean, percent?:number}|null>,
 *   anyRunActive?: () => boolean,
 *   notify?: (kind:'battery'|'batteryLow', info:{percent:number|null, thresholdPct:number}) => void,
 *   thresholdPct?: number, pollMs?: number,
 *   setTimer?: Function, clearTimer?: Function, log?: Function,
 * }} deps
 */
function createBatteryGuard(deps = {}) {
  const noop = () => {};
  const notify = deps.notify || noop;
  const anyRunActive = deps.anyRunActive || (() => false);
  const thresholdPct = Number.isFinite(deps.thresholdPct) ? deps.thresholdPct : LOW_BATTERY_PCT;
  const pollMs = Number.isFinite(deps.pollMs) && deps.pollMs > 0 ? deps.pollMs : BATTERY_POLL_MS;
  const setTimer = deps.setTimer || setTimeout;
  const clearTimer = deps.clearTimer || clearTimeout;
  const log = deps.log || noop;

  let onBattery = false;
  let percent = null;
  // Bumped on every switch to battery: warnings are once per period.
  let period = 0;
  let warnedPeriod = 0;
  let lowWarnedPeriod = 0;
  let pollTimer = null;
  let started = false;
  const listeners = new Set();
  /** @type {Array<() => void>} verifies waiting for power */
  let waiters = [];

  const isHeld = () => onBattery && percent !== null && percent < thresholdPct;

  function view() {
    return { onBattery, percent, held: isHeld(), thresholdPct };
  }

  function emit() {
    const v = view();
    for (const fn of listeners) {
      try {
        fn(v);
      } catch (err) {
        log(`battery listener failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  function releaseWaiters() {
    if (isHeld() || !waiters.length) return;
    const ready = waiters;
    waiters = [];
    for (const resolve of ready) resolve();
  }

  /** The board warning's notification, once per battery period. */
  function warn() {
    if (!onBattery) return;
    const info = { percent, thresholdPct };
    if (warnedPeriod !== period) {
      warnedPeriod = period;
      notify('battery', info);
    }
    if (isHeld() && lowWarnedPeriod !== period) {
      lowWarnedPeriod = period;
      notify('batteryLow', info);
    }
  }

  function stopPoll() {
    if (pollTimer) clearTimer(pollTimer);
    pollTimer = null;
  }

  function armPoll(token) {
    stopPoll();
    pollTimer = setTimer(() => {
      pollTimer = null;
      readNow(token);
    }, pollMs);
  }

  /** Reads the percentage once; ignored when the period moved on meanwhile. */
  async function readNow(token = period) {
    if (!deps.readPercent || !onBattery) return percent;
    let next = null;
    try {
      next = percentOf(await deps.readPercent());
    } catch (err) {
      log(`battery read failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!onBattery || token !== period) return percent;
    const wasHeld = isHeld();
    percent = next;
    if (isHeld() !== wasHeld) log(isHeld() ? `battery at ${percent}%: holding new workers and verifies` : 'battery hold lifted');
    if (anyRunActive()) warn();
    releaseWaiters();
    emit();
    armPoll(token);
    return percent;
  }

  /** powerMonitor 'on-battery' (or on battery at start). */
  function handleBattery() {
    if (onBattery) return;
    onBattery = true;
    percent = null;
    period += 1;
    if (anyRunActive()) warn();
    emit();
    readNow(period).catch(noop);
  }

  /** powerMonitor 'on-ac': plugged in - every hold lifts. */
  function handleAc() {
    if (!onBattery) return;
    onBattery = false;
    percent = null;
    stopPoll();
    releaseWaiters();
    emit();
  }

  /** Subscribes to powerMonitor and reads the current state. Once. */
  function start() {
    if (started) return;
    started = true;
    if (deps.onBatteryEvent) deps.onBatteryEvent(() => handleBattery());
    if (deps.onAcEvent) deps.onAcEvent(() => handleAc());
    let now = false;
    try {
      now = !!(deps.isOnBattery && deps.isOnBattery());
    } catch {
      now = false;
    }
    if (now) handleBattery();
  }

  /** A run started (or is running): warns when on battery, once per period. */
  function onRunStart() {
    warn();
  }

  /** Resolves when a new verify may start (at once unless held). */
  function whenAllowed() {
    if (!isHeld()) return Promise.resolve();
    return new Promise((resolve) => waiters.push(resolve));
  }

  /** @param {(view:object) => void} fn called on every change; returns an unsubscribe */
  function subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  return { start, onBattery: handleBattery, onAc: handleAc, readNow, onRunStart, isHeld, whenAllowed, subscribe, view };
}

module.exports = {
  createPowerFlow,
  createBatteryGuard,
  percentOf,
  SLEEP_COUNTDOWN_MS,
  SHUTDOWN_DELAY_S,
  LOW_BATTERY_PCT,
  BATTERY_POLL_MS,
};
