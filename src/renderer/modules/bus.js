// ============================================================================
// LunaCore - renderer event bus
// ----------------------------------------------------------------------------
// The renderer used to be one file, so every section could simply call into
// every other one. Splitting it made two couplings visible, and this module is
// what replaces them - a handful of tiny subscriber lists, no dependencies.
//
//  * Context metrics. Only ONE IPC listener exists (in sessions.js); it fans the
//    ACTIVE session's metrics out to whoever wants them (the Context Window bar,
//    the sparkline) and stashes a BACKGROUND session's metrics into that tab's
//    own bucket. This is the pattern the single-file version already used.
//  * Language switch. applyLang() used to hard-call renderLed, renderPtyStatus,
//    renderCtxText, renderBurn, renderUsage, ... - a hub that had to know every
//    module. Now each module re-renders itself when the language changes.
//  * Per-tab view state. Switching tabs has to swap the LED, the context bar and
//    the sparkline over to the new session's numbers. Each module registers how
//    to save/load/clear ITS OWN keys on a session bucket, so no module writes
//    into another's state.
//
// A2 added two things on top:
//
//  * Every subscribe function returns a DISPOSER. Nothing was ever torn down
//    before widgets existed, so a subscriber list could only grow and losing the
//    ability to unsubscribe cost nothing. A widget that unmounts and mounts
//    again would otherwise subscribe twice and render twice - permanently.
//  * The process-wide feeds (ports, usage) are REPLAYING channels, so a widget
//    mounted after their data landed paints immediately instead of sitting empty
//    until the next poll. See feeds.js for who fills them.
// ============================================================================

'use strict';

/**
 * One subscriber list.
 * @param {{replay?: boolean}} [opts] replay: hand the last payload to a late
 *   subscriber straight away.
 */
function channel({ replay = false } = {}) {
  const subs = [];
  let last = null; // arguments of the most recent emit, once there was one

  return {
    on(cb) {
      subs.push(cb);
      if (replay && last) cb(...last);
      return () => {
        const i = subs.indexOf(cb);
        if (i >= 0) subs.splice(i, 1);
      };
    },
    emit(...args) {
      if (replay) last = args;
      // Iterate a COPY. A subscriber may unsubscribe - or mount/unmount a whole
      // widget - while we are notifying, and splicing the live array mid-loop
      // would silently skip its neighbour.
      for (const cb of subs.slice()) cb(...args);
    },
    get size() {
      return subs.length;
    },
  };
}

// ---- Context metrics --------------------------------------------------------

const activeContext = channel();
const backgroundContext = channel();

/** Metrics of the tab you are looking at. cb(metrics) -> disposer */
export function onActiveContext(cb) {
  return activeContext.on(cb);
}

export function emitActiveContext(metrics) {
  activeContext.emit(metrics);
}

/** Metrics of a tab running in the background. cb(bucket, metrics) -> disposer */
export function onBackgroundContext(cb) {
  return backgroundContext.on(cb);
}

export function emitBackgroundContext(bucket, metrics) {
  backgroundContext.emit(bucket, metrics);
}

// ---- Session restart (profile / project switch) -----------------------------

const sessionRestarted = channel();

export function onSessionRestarted(cb) {
  return sessionRestarted.on(cb);
}

export function emitSessionRestarted(profile) {
  sessionRestarted.emit(profile);
}

// ---- Language switch --------------------------------------------------------

const langChange = channel();

/** Re-render whatever text this module owns. Static labels are i18n's job. */
export function onLangChange(cb) {
  return langChange.on(cb);
}

export function emitLangChange() {
  langChange.emit();
}

// ---- Process-wide feeds (see feeds.js) --------------------------------------
//
// Replaying: both are polls with long gaps (ports ~5 s, usage ~90 s), so a
// widget mounted between two ticks must not sit empty waiting for the next one.

const portsUpdate = channel({ replay: true });
const usageUpdate = channel({ replay: true });

/** Listening localhost ports: cb(ports[]) -> disposer */
export function onPortsUpdate(cb) {
  return portsUpdate.on(cb);
}

export function emitPortsUpdate(ports) {
  portsUpdate.emit(ports);
}

/** Usage-limit state (5h + weekly): cb(usage) -> disposer */
export function onUsageUpdate(cb) {
  return usageUpdate.on(cb);
}

export function emitUsageUpdate(usage) {
  usageUpdate.emit(usage);
}

// D5. Replayed for a stronger reason than the two above: the update check runs
// ONCE, at launch, so its answer usually lands before the widget exists. Without
// replay the notice would stay blank until the user pressed the manual check -
// i.e. exactly never, since nobody presses a button they have no reason to.
const updateState = channel({ replay: true });

/** Update availability: cb({state, info, percent, error, reason}) -> disposer */
export function onUpdateState(cb) {
  return updateState.on(cb);
}

export function emitUpdateState(state) {
  updateState.emit(state);
}

// E1. Replayed for the ordinary reason: samples land every 2 s and a widget
// mounted between two ticks must not open on an empty chart. Note this channel
// carries ONE sample, not the history - the series is kept in telemetry.js at
// module scope, so it survives an unmount (the ports.js rule: state that is not
// the DOM stays at module scope).
const telemetryUpdate = channel({ replay: true });

/** One machine sample: cb({at, mem, cpu, uptime, load}) -> disposer */
export function onTelemetryUpdate(cb) {
  return telemetryUpdate.on(cb);
}

export function emitTelemetryUpdate(sample) {
  telemetryUpdate.emit(sample);
}

// Media Deck. Replayed for the same reason as ports/usage above - polled
// every 2 s, a widget mounted between two ticks must not sit blank.
const mediaUpdate = channel({ replay: true });

/** Now-playing sample: cb({title, artist, appId, isPlaying}|null) -> disposer */
export function onMediaUpdate(cb) {
  return mediaUpdate.on(cb);
}

export function emitMediaUpdate(state) {
  mediaUpdate.emit(state);
}

// ---- Per-tab view state -----------------------------------------------------

const sessionViews = [];

/**
 * Register how a module moves its own state on/off a session bucket.
 * @param {{ save(bucket): void, load(bucket): void, clear(bucket): void }} view
 * @returns {() => void} disposer
 */
export function registerSessionView(view) {
  sessionViews.push(view);
  return () => {
    const i = sessionViews.indexOf(view);
    if (i >= 0) sessionViews.splice(i, 1);
  };
}

/** Leaving a tab: park the live state on its bucket. */
export function saveSessionView(bucket) {
  for (const v of sessionViews.slice()) v.save(bucket);
}

/** Entering a tab: adopt its state and repaint. */
export function loadSessionView(bucket) {
  for (const v of sessionViews.slice()) v.load(bucket);
}

/** Session restarted: its history is gone, drop what we kept for it. */
export function clearSessionView(bucket) {
  for (const v of sessionViews.slice()) v.clear(bucket);
}

// ---- Diagnostics ------------------------------------------------------------

/**
 * How many subscribers each channel currently has.
 *
 * This is the measurement that makes the widget contract checkable. A widget
 * whose cleanup forgets a disposer looks completely normal - it just renders
 * twice per event, forever, and nothing on screen says so. Remount a few times
 * and compare these numbers: stable means unmount really undid the mount.
 */
export function busStats() {
  return {
    activeContext: activeContext.size,
    backgroundContext: backgroundContext.size,
    sessionRestarted: sessionRestarted.size,
    langChange: langChange.size,
    portsUpdate: portsUpdate.size,
    usageUpdate: usageUpdate.size,
    updateState: updateState.size,
    telemetryUpdate: telemetryUpdate.size,
    sessionViews: sessionViews.length,
  };
}
