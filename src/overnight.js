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
// Both halves are scoped to the runs: armed when the renderer reports one,
// released the moment the last one ends, stalls or its tab closes. Several
// tabs can run at once (orchestrator slice 2): keep-awake is shared, the
// watchdog is per tab, and tabs on the SAME local server share one recovery
// so two runs never wake/load in parallel.
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

  /** @type {Map<string, Object>} sessionId -> run record */
  const runs = new Map();
  let blockerId = null;
  /** upstream -> in-flight recovery promise, shared by runs on one server */
  const recoveries = new Map();

  function setThrottling(enabled) {
    const wc = getWebContents();
    if (wc && !wc.isDestroyed()) wc.setBackgroundThrottling(enabled);
  }

  function stopWatch(r) {
    if (r.interval !== null) timers.clearInterval(r.interval);
    if (r.confirm !== null) timers.clearTimeout(r.confirm);
    r.interval = null;
    r.confirm = null;
  }

  function isLive(r) {
    return runs.get(r.sessionId) === r;
  }

  /** Keep-awake + throttling follow "is ANY run live". */
  function syncPower() {
    if (runs.size > 0 && blockerId === null) {
      blockerId = blocker.start('prevent-app-suspension');
      setThrottling(false);
    } else if (runs.size === 0 && blockerId !== null) {
      if (blocker.isStarted(blockerId)) blocker.stop(blockerId);
      blockerId = null;
      setThrottling(true);
    }
  }

  function dropRun(sessionId) {
    const r = runs.get(sessionId);
    if (!r) return;
    stopWatch(r);
    runs.delete(sessionId);
  }

  function addRun(sessionId) {
    const r = {
      sessionId,
      upstream: resolveLocal(sessionId) || null,
      interval: null,
      confirm: null,
      busy: false,
      suspect: false,
      recovering: false,
      attempts: 0,
      lost: false,
      lastModelKey: null,
    };
    runs.set(sessionId, r);
    if (r.upstream) {
      r.interval = timers.setInterval(() => { checkRun(r); }, intervalMs);
      checkRun(r);
    }
  }

  /** Reports the full set of tabs with a live run. Idempotent per tab. */
  function setRuns(sessionIds) {
    const wanted = new Set(
      (Array.isArray(sessionIds) ? sessionIds : []).filter((id) => typeof id === 'string' && id),
    );
    for (const id of [...runs.keys()]) if (!wanted.has(id)) dropRun(id);
    for (const id of wanted) if (!runs.has(id)) addRun(id);
    syncPower();
  }

  /** Single-run form (v1): a tab id replaces every run, null ends them all. */
  function setRun(sessionId) {
    setRuns(typeof sessionId === 'string' && sessionId ? [sessionId] : []);
  }

  function release() {
    setRuns([]);
  }

  /** One recovery per upstream at a time; every run on it awaits the same one. */
  function sharedRecover(r) {
    const key = r.upstream;
    if (!recoveries.has(key)) {
      const p = Promise.resolve()
        .then(() => recover({ modelKey: r.lastModelKey }))
        .finally(() => recoveries.delete(key));
      recoveries.set(key, p);
    }
    return recoveries.get(key);
  }

  async function attemptRecovery(r) {
    if (!r.recovering) {
      r.recovering = true;
      signal(r.sessionId, 'backendRecovering');
    }
    r.attempts += 1;
    const result = await sharedRecover(r);
    if (!isLive(r)) return; // the run ended or moved on while recovery ran
    if (result && result.ok) {
      r.recovering = false;
      r.attempts = 0;
      signal(r.sessionId, 'backendRecovered');
      return;
    }
    if (r.attempts >= MAX_RECOVERY_ATTEMPTS) {
      r.lost = true;
      stopWatch(r);
      signal(r.sessionId, 'backendLost');
    }
  }

  /** One watchdog pass for one run; overlapping calls are dropped. */
  async function checkRun(r) {
    if (!isLive(r) || !r.upstream || r.busy || r.lost) return;
    r.busy = true;
    try {
      let reading = null;
      try {
        reading = await probe(r.upstream);
      } catch {
        reading = null;
      }
      if (!isLive(r)) return;
      if (isBackendHealthy(reading)) {
        const loaded = pickLoadedModel(reading.models);
        if (loaded) r.lastModelKey = loaded.id;
        r.suspect = false;
        return;
      }
      if (r.recovering || r.suspect) {
        r.suspect = false;
        await attemptRecovery(r);
        return;
      }
      // First bad reading: confirm shortly instead of acting on it.
      r.suspect = true;
      if (r.confirm === null) {
        r.confirm = timers.setTimeout(() => {
          r.confirm = null;
          return checkRun(r);
        }, confirmDelayMs);
      }
    } finally {
      r.busy = false;
    }
  }

  /** A watchdog pass for one tab's run, or for every run when no id is given. */
  function check(sessionId) {
    if (typeof sessionId === 'string') {
      const r = runs.get(sessionId);
      return r ? checkRun(r) : Promise.resolve();
    }
    return Promise.all([...runs.values()].map(checkRun)).then(() => undefined);
  }

  /** A dropped request on a run's tab: look now instead of at the next tick. */
  function onConnectionError(sessionId) {
    return runs.has(sessionId) ? check(sessionId) : Promise.resolve();
  }

  /** A tab closed: a run bound to it is over. */
  function forgetSession(sessionId) {
    if (!runs.has(sessionId)) return;
    dropRun(sessionId);
    syncPower();
  }

  return {
    setRun,
    setRuns,
    check,
    onConnectionError,
    forgetSession,
    stop: release,
    current: () => (runs.size > 0 ? [...runs.keys()][0] : null),
    currentAll: () => [...runs.keys()],
  };
}

module.exports = {
  createOvernightGuard,
  recoverLocalBackend,
  isBackendHealthy,
  MAX_RECOVERY_ATTEMPTS,
  WATCH_INTERVAL_MS,
};
