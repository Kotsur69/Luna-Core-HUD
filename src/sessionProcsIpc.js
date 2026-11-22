// ============================================================================
// LunaCore - session process snapshots over IPC, polled only while watched
// ----------------------------------------------------------------------------
// The renderer's views of the processes and ports under each tab (#agymap
// slices 2 and 3) subscribe when they are shown and unsubscribe when they
// are hidden. src/sessionProcs.js runs ONLY while at least one subscription
// is open - with none there is no timer and no process is spawned - and each
// snapshot waits for the one before to end, plus a pause that grows with how
// long it took (scheduleNext).
//
// Channels (all read-only; none takes an argument, so there is nothing from
// the renderer to validate but who is asking):
//   sessionprocs:subscribe    -> {ok, snapshot}  starts polling if first
//   sessionprocs:unsubscribe  -> {ok}            stops polling if last
//   sessionprocs:get          -> {ok, snapshot}  the latest snapshot, no poll
//   sessionprocs:update       main -> renderer {at, sessions}, on change only
// Only the main window's own webContents may subscribe (isTrustedSender); a
// window that goes away loses its subscriptions. Subscriptions are counted
// per window, so two views in one window keep polling until both leave, and
// a runaway caller cannot hold more than MAX_SUBSCRIPTIONS_PER_SENDER.
// ============================================================================

'use strict';

/** Least time between the end of one snapshot and the start of the next. */
const DEFAULT_INTERVAL_MS = 5000;
/**
 * The next snapshot waits at least this many times as long as the last one
 * took. On Windows one takes 5-12 s (starting powershell.exe dominates;
 * measured 2026-11-22), so the helper process runs at most a third of the
 * time a view is open, never back to back.
 */
const PACING_FACTOR = 2;
/** Longest wait between snapshots, however slow the last one was. */
const MAX_INTERVAL_MS = 30000;
const MAX_SUBSCRIPTIONS_PER_SENDER = 16;
/** Failure reasons logged once each, so a broken scan does not flood the log. */
const MAX_LOGGED_REASONS = 32;

const errText = (err) => (err && (err.code || err.message)) || String(err);

class SessionProcsHub {
  /**
   * @param {{snapshot: (roots: object[]) => Promise<object>, listRoots: () => object[],
   *   intervalMs?: number, now?: () => number, log?: (msg: string) => void,
   *   setTimeout?: Function, clearTimeout?: Function}} deps
   */
  constructor({ snapshot, listRoots, intervalMs = DEFAULT_INTERVAL_MS, now = Date.now, log, setTimeout: setTimer = setTimeout, clearTimeout: clearTimer = clearTimeout }) {
    if (typeof snapshot !== 'function' || typeof listRoots !== 'function') {
      throw new TypeError('SessionProcsHub needs snapshot() and listRoots()');
    }
    this.snapshot = snapshot;
    this.listRoots = listRoots;
    this.intervalMs = intervalMs;
    this.now = now;
    this.log = typeof log === 'function' ? log : (msg) => console.warn(`[sessionprocs] ${msg}`);
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    /** subscriber id -> {count, deliver} */
    this.subscribers = new Map();
    /** Whether snapshots are being taken (someone subscribed). */
    this.running = false;
    /** The pending wait before the next snapshot, or null. */
    this.timer = null;
    this.busy = false;
    /** {at, sessions} of the last snapshot, or null before the first. */
    this.latest = null;
    this.lastJson = '';
    /** Snapshots taken: the "0 polls while nobody watches" guarantee is tested on it. */
    this.polls = 0;
    this.loggedReasons = new Set();
  }

  /**
   * Opens one subscription for a subscriber; the first one anywhere starts polling.
   * @param {number|string} id the subscriber (a webContents id)
   * @param {(payload: object) => void} deliver sends an update to it
   * @returns {{ok: boolean, isNew: boolean}} isNew: this subscriber had none open
   */
  subscribe(id, deliver) {
    const entry = this.subscribers.get(id);
    if (entry && entry.count >= MAX_SUBSCRIPTIONS_PER_SENDER) return { ok: false, isNew: false };
    if (entry) entry.count++;
    else this.subscribers.set(id, { count: 1, deliver });
    if (!this.running) {
      this.running = true;
      this.poll();
    }
    return { ok: true, isNew: !entry };
  }

  /** Closes one subscription; the last one anywhere stops polling. */
  unsubscribe(id) {
    const entry = this.subscribers.get(id);
    if (!entry) return;
    entry.count--;
    if (entry.count <= 0) this.drop(id);
  }

  /** Closes every subscription of one subscriber (its window went away). */
  drop(id) {
    this.subscribers.delete(id);
    if (this.subscribers.size === 0) this.stop();
  }

  stop() {
    this.running = false;
    if (this.timer) this.clearTimer(this.timer);
    this.timer = null;
    // The next subscriber gets a fresh snapshot, not one from minutes ago
    // (whose pids may since have been reused).
    this.lastJson = '';
    this.latest = null;
  }

  /** Takes one snapshot, sends it to every subscriber when it changed, and schedules the next. */
  async poll() {
    if (this.busy || this.subscribers.size === 0) return;
    this.busy = true;
    this.polls++;
    const started = this.now();
    try {
      const sessions = await this.snapshot(this.listRoots());
      const json = JSON.stringify(sessions);
      if (json === this.lastJson || this.subscribers.size === 0) return;
      this.lastJson = json;
      this.latest = { at: this.now(), sessions };
      for (const { deliver } of this.subscribers.values()) deliver(this.latest);
    } catch (err) {
      const reason = errText(err);
      if (!this.loggedReasons.has(reason) && this.loggedReasons.size < MAX_LOGGED_REASONS) {
        this.loggedReasons.add(reason);
        this.log(`process snapshot failed: ${reason}`);
      }
    } finally {
      this.busy = false;
      this.scheduleNext(this.now() - started);
    }
  }

  /** Waits before the next snapshot: at least intervalMs, and PACING_FACTOR times the last one. */
  scheduleNext(tookMs) {
    if (!this.running || this.subscribers.size === 0 || this.timer) return;
    const paced = PACING_FACTOR * Math.max(0, Number(tookMs) || 0);
    const delay = Math.min(MAX_INTERVAL_MS, Math.max(this.intervalMs, paced));
    this.timer = this.setTimer(() => {
      this.timer = null;
      this.poll();
    }, delay);
  }
}

/**
 * Registers the sessionprocs:* channels.
 * @param {{ipcMain: object, hub: SessionProcsHub, isTrustedSender: (event: object) => boolean}} deps
 */
function registerSessionProcsIpc({ ipcMain, hub, isTrustedSender }) {
  const trusted = (event) => typeof isTrustedSender === 'function' && isTrustedSender(event) === true;
  // One 'destroyed' listener per window for its whole life, however often
  // its views subscribe and leave.
  const watched = new Set();
  ipcMain.handle('sessionprocs:subscribe', (event) => {
    if (!trusted(event)) return { ok: false, reason: 'untrusted' };
    const sender = event.sender;
    const id = sender.id;
    const { ok } = hub.subscribe(id, (payload) => {
      if (!sender.isDestroyed()) sender.send('sessionprocs:update', payload);
    });
    if (!ok) return { ok: false, reason: 'tooMany' };
    if (!watched.has(id)) {
      watched.add(id);
      sender.once('destroyed', () => {
        watched.delete(id);
        hub.drop(id);
      });
    }
    return { ok: true, snapshot: hub.latest };
  });
  ipcMain.handle('sessionprocs:unsubscribe', (event) => {
    if (!trusted(event)) return { ok: false, reason: 'untrusted' };
    hub.unsubscribe(event.sender.id);
    return { ok: true };
  });
  ipcMain.handle('sessionprocs:get', (event) => {
    if (!trusted(event)) return { ok: false, reason: 'untrusted' };
    return { ok: true, snapshot: hub.latest };
  });
}

module.exports = { SessionProcsHub, registerSessionProcsIpc, MAX_SUBSCRIPTIONS_PER_SENDER };
