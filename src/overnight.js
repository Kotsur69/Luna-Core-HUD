// ============================================================================
// LunaCore - overnight guard (main-process half of a God Mode run)
// ----------------------------------------------------------------------------
// God Mode (src/renderer/modules/godmode.js) is the unattended runner; this is
// what keeps a long run alive when nobody is at the desk:
//
//   - powerSaveBlocker 'prevent-app-suspension' so Windows does not sleep
//     mid-run (the screen may still turn off);
//   - background throttling OFF for the window, so a minimized LunaCore keeps
//     its timers (God Mode's limit poll, auto-proceed) on schedule;
//   - for a LOCAL tab (LM Studio), a watchdog: when the server stops answering
//     or no model is loaded any more, it wakes LM Studio and reloads the last
//     model, telling God Mode through godmode:signal so the run waits for the
//     backend instead of burning its connection retries.
//
// Both halves are scoped to the runs (God Mode v2: one per tab, several at
// once): keep-awake is held while ANY run is live and released when the last
// one ends, stalls or its tab closes; the watchdog is one per local upstream,
// shared by every run on it, and stops when its last run does.
//
// A single bad probe is never acted on - it is confirmed a few seconds later
// first, since a busy server can miss one probe while it generates. The
// recovery itself is safe on a false alarm too: it only reloads when the SDK
// confirms nothing is loaded.
// ============================================================================

'use strict';

const { pickLoadedModel } = require('./lmstudio');

const WATCH_INTERVAL_MS = 30 * 1000;
const CONFIRM_DELAY_MS = 3000;
const MAX_RECOVERY_ATTEMPTS = 3;

/**
 * Whether a probe shows a backend a session can talk to.
 * @param {{up:boolean, models:Array}|null} probe
 */
function isBackendHealthy(probe) {
  if (!probe || !probe.up) return false;
  const models = Array.isArray(probe.models) ? probe.models : [];
  if (pickLoadedModel(models)) return true;
  // /v1/models reports no load state at all: an answering server is all we know.
  return models.every((m) => m && m.loaded === null);
}

/**
 * Brings a local LM Studio backend back: wakes the app and its server, then
 * reloads a model only when none is loaded. Never rejects.
 * @param {{modelKey:string|null, lastLoad:Object|null, wake:Function, listModels:Function, load:Function}} input
 * @returns {Promise<{ok:true, action:'server'|'reload'}|{ok:false, reason:string}>}
 */
async function recoverLocalBackend({ modelKey, lastLoad, wake, listModels, load }) {
  try {
    const woke = await wake();
    if (!woke || !woke.ok) return { ok: false, reason: (woke && woke.reason) || 'error' };
    const listed = await listModels();
    if (!listed || !listed.ok) return { ok: false, reason: (listed && listed.reason) || 'error' };
    const hasModel = (listed.models || []).some((m) => m && m.loaded === true && m.type !== 'embedding');
    if (hasModel) return { ok: true, action: 'server' };
    // The model this run last saw loaded wins: lastLoad is app-wide (any
    // Settings load), so its options are reused only when it is for that
    // same model - never to swap a different model in mid-run.
    const lastMatches = lastLoad && (!modelKey || lastLoad.modelKey === modelKey);
    const request = lastMatches ? lastLoad : modelKey ? { modelKey } : null;
    if (!request) return { ok: false, reason: 'no-model' };
    const loaded = await load(request);
    if (!loaded || !loaded.ok) return { ok: false, reason: (loaded && loaded.reason) || 'error' };
    return { ok: true, action: 'reload' };
  } catch {
    return { ok: false, reason: 'error' };
  }
}

/**
 * @param {{
 *   blocker: {start:Function, stop:Function, isStarted:Function},
 *   getWebContents: () => ({setBackgroundThrottling:Function, isDestroyed:Function}|null),
 *   resolveLocal: (sessionId:string) => string|null,
 *   probe: (upstream:string) => Promise<{up:boolean, models:Array}>,
 *   recover: (ctx:{modelKey:string|null}) => Promise<{ok:boolean}>,
 *   signal: (sessionId:string, type:string) => void,
 *   intervalMs?: number,
 *   confirmDelayMs?: number,
 *   timers?: {setInterval:Function, clearInterval:Function, setTimeout:Function, clearTimeout:Function},
 * }} deps
 */
function createOvernightGuard(deps) {
  const {
    blocker,
    getWebContents,
    resolveLocal,
    probe,
    recover,
    signal,
    intervalMs = WATCH_INTERVAL_MS,
    confirmDelayMs = CONFIRM_DELAY_MS,
    timers = { setInterval, clearInterval, setTimeout, clearTimeout },
  } = deps;

  // Every live run: tab id -> its local upstream (null for a cloud tab).
  const runs = new Map();
  // One watchdog per local upstream, shared by every run that talks to it, so
  // two tabs on the same LM Studio never both try to bring it back.
  const watchers = new Map();
  // Keep-awake and throttling are app-wide: held while ANY run is live.
  let blockerId = null;

  function setThrottling(enabled) {
    const wc = getWebContents();
    if (wc && !wc.isDestroyed()) wc.setBackgroundThrottling(enabled);
  }

  function holdAwake() {
    if (blockerId !== null) return;
    blockerId = blocker.start('prevent-app-suspension');
    setThrottling(false);
  }

  function releaseAwake() {
    if (blockerId === null) return;
    if (blocker.isStarted(blockerId)) blocker.stop(blockerId);
    blockerId = null;
    setThrottling(true);
  }

  /** Sends a backend signal to every run on this watcher's upstream. */
  function broadcast(w, type) {
    for (const [sessionId, upstream] of runs) {
      if (upstream === w.upstream) signal(sessionId, type);
    }
  }

  function stopWatch(w) {
    if (w.interval !== null) timers.clearInterval(w.interval);
    if (w.confirm !== null) timers.clearTimeout(w.confirm);
    w.interval = null;
    w.confirm = null;
  }

  function isLive(w) {
    return watchers.get(w.upstream) === w;
  }

  function startWatch(upstream) {
    const existing = watchers.get(upstream);
    // A watcher that already gave up is replaced: a new run is a fresh start.
    if (existing && !existing.lost) return;
    if (existing) stopWatch(existing);
    const w = {
      upstream,
      interval: null,
      confirm: null,
      busy: false,
      suspect: false,
      recovering: false,
      attempts: 0,
      lost: false,
      lastModelKey: null,
    };
    watchers.set(upstream, w);
    w.interval = timers.setInterval(() => { checkWatcher(w); }, intervalMs);
    checkWatcher(w);
  }

  /** Starts a run on a tab. Idempotent per tab; other tabs' runs are untouched. */
  function startRun(sessionId) {
    const id = typeof sessionId === 'string' && sessionId ? sessionId : null;
    if (!id || runs.has(id)) return;
    const upstream = resolveLocal(id) || null;
    runs.set(id, upstream);
    holdAwake();
    if (upstream) startWatch(upstream);
  }

  /** Ends a tab's run. The last run out releases keep-awake. */
  function endRun(sessionId) {
    if (!runs.has(sessionId)) return;
    const upstream = runs.get(sessionId);
    runs.delete(sessionId);
    if (upstream && ![...runs.values()].includes(upstream)) {
      const w = watchers.get(upstream);
      if (w) stopWatch(w);
      watchers.delete(upstream);
    }
    if (runs.size === 0) releaseAwake();
  }

  function stopAll() {
    for (const w of watchers.values()) stopWatch(w);
    watchers.clear();
    runs.clear();
    releaseAwake();
  }

  async function attemptRecovery(w) {
    if (!w.recovering) {
      w.recovering = true;
      broadcast(w, 'backendRecovering');
    }
    w.attempts += 1;
    const result = await recover({ modelKey: w.lastModelKey });
    if (!isLive(w)) return; // every run on it ended while recovery ran
    if (result && result.ok) {
      w.recovering = false;
      w.attempts = 0;
      broadcast(w, 'backendRecovered');
      return;
    }
    if (w.attempts >= MAX_RECOVERY_ATTEMPTS) {
      w.lost = true;
      stopWatch(w);
      broadcast(w, 'backendLost');
    }
  }

  /** One watchdog pass for one upstream. Overlapping calls are dropped. */
  async function checkWatcher(w) {
    if (!isLive(w) || w.busy || w.lost) return;
    w.busy = true;
    try {
      let reading = null;
      try {
        reading = await probe(w.upstream);
      } catch {
        reading = null;
      }
      if (!isLive(w)) return;
      if (isBackendHealthy(reading)) {
        const loaded = pickLoadedModel(reading.models);
        if (loaded) w.lastModelKey = loaded.id;
        w.suspect = false;
        return;
      }
      if (w.recovering || w.suspect) {
        w.suspect = false;
        await attemptRecovery(w);
        return;
      }
      // First bad reading: confirm shortly instead of acting on it.
      w.suspect = true;
      if (w.confirm === null) {
        w.confirm = timers.setTimeout(() => {
          w.confirm = null;
          return checkWatcher(w);
        }, confirmDelayMs);
      }
    } finally {
      w.busy = false;
    }
  }

  /** A watchdog pass over every watched upstream. Safe to call at any time. */
  function check() {
    return Promise.all([...watchers.values()].map(checkWatcher));
  }

  /** A dropped request on a run's tab: look at its backend now, not at the next tick. */
  function onConnectionError(sessionId) {
    const w = watchers.get(runs.get(sessionId));
    return w ? checkWatcher(w) : Promise.resolve();
  }

  return {
    startRun,
    endRun,
    check,
    onConnectionError,
    forgetSession: endRun, // a tab closed: a run bound to it is over
    stop: stopAll,
    current: () => [...runs.keys()],
  };
}

module.exports = {
  createOvernightGuard,
  recoverLocalBackend,
  isBackendHealthy,
  MAX_RECOVERY_ATTEMPTS,
  WATCH_INTERVAL_MS,
};
