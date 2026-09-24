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
// Both halves are scoped to the run: armed when the renderer reports a run,
// released the moment it ends, stalls or its tab closes.
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
    const request = lastLoad || (modelKey ? { modelKey } : null);
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

  let run = null;

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

  function release() {
    if (!run) return;
    stopWatch(run);
    if (blocker.isStarted(run.blockerId)) blocker.stop(run.blockerId);
    setThrottling(true);
    run = null;
  }

  /** Reports a run (a tab id) or its end (null). Idempotent per tab. */
  function setRun(sessionId) {
    const id = typeof sessionId === 'string' && sessionId ? sessionId : null;
    if (run && run.sessionId === id) return;
    release();
    if (!id) return;
    run = {
      sessionId: id,
      upstream: resolveLocal(id) || null,
      blockerId: blocker.start('prevent-app-suspension'),
      interval: null,
      confirm: null,
      busy: false,
      suspect: false,
      recovering: false,
      attempts: 0,
      lost: false,
      lastModelKey: null,
    };
    setThrottling(false);
    if (run.upstream) {
      run.interval = timers.setInterval(() => { check(); }, intervalMs);
      check();
    }
  }

  async function attemptRecovery(r) {
    if (!r.recovering) {
      r.recovering = true;
      signal(r.sessionId, 'backendRecovering');
    }
    r.attempts += 1;
    const result = await recover({ modelKey: r.lastModelKey });
    if (run !== r) return; // the run ended or moved on while recovery ran
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

  /** One watchdog pass. Safe to call at any time; overlapping calls are dropped. */
  async function check() {
    const r = run;
    if (!r || !r.upstream || r.busy || r.lost) return;
    r.busy = true;
    try {
      let reading = null;
      try {
        reading = await probe(r.upstream);
      } catch {
        reading = null;
      }
      if (run !== r) return;
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
          return check();
        }, confirmDelayMs);
      }
    } finally {
      r.busy = false;
    }
  }

  /** A dropped request on the run's tab: look now instead of at the next tick. */
  function onConnectionError(sessionId) {
    if (!run || run.sessionId !== sessionId) return Promise.resolve();
    return check();
  }

  /** A tab closed: a run bound to it is over. */
  function forgetSession(sessionId) {
    if (run && run.sessionId === sessionId) release();
  }

  return {
    setRun,
    check,
    onConnectionError,
    forgetSession,
    stop: release,
    current: () => (run ? run.sessionId : null),
  };
}

module.exports = {
  createOvernightGuard,
  recoverLocalBackend,
  isBackendHealthy,
  MAX_RECOVERY_ATTEMPTS,
  WATCH_INTERVAL_MS,
};
