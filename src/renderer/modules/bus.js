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
// ============================================================================

'use strict';

// ---- Context metrics --------------------------------------------------------

const activeContextSubscribers = [];
const backgroundContextSubscribers = [];

/** Metrics of the tab you are looking at. cb(metrics) */
export function onActiveContext(cb) {
  activeContextSubscribers.push(cb);
}

export function emitActiveContext(metrics) {
  for (const cb of activeContextSubscribers) cb(metrics);
}

/** Metrics of a tab running in the background. cb(bucket, metrics) */
export function onBackgroundContext(cb) {
  backgroundContextSubscribers.push(cb);
}

export function emitBackgroundContext(bucket, metrics) {
  for (const cb of backgroundContextSubscribers) cb(bucket, metrics);
}

// ---- Session restart (profile / project switch) -----------------------------

const restartSubscribers = [];

export function onSessionRestarted(cb) {
  restartSubscribers.push(cb);
}

export function emitSessionRestarted(profile) {
  for (const cb of restartSubscribers) cb(profile);
}

// ---- Language switch --------------------------------------------------------

const langSubscribers = [];

/** Re-render whatever text this module owns. Static labels are i18n's job. */
export function onLangChange(cb) {
  langSubscribers.push(cb);
}

export function emitLangChange() {
  for (const cb of langSubscribers) cb();
}

// ---- Per-tab view state -----------------------------------------------------

const sessionViews = [];

/**
 * Register how a module moves its own state on/off a session bucket.
 * @param {{ save(bucket): void, load(bucket): void, clear(bucket): void }} view
 */
export function registerSessionView(view) {
  sessionViews.push(view);
}

/** Leaving a tab: park the live state on its bucket. */
export function saveSessionView(bucket) {
  for (const v of sessionViews) v.save(bucket);
}

/** Entering a tab: adopt its state and repaint. */
export function loadSessionView(bucket) {
  for (const v of sessionViews) v.load(bucket);
}

/** Session restarted: its history is gone, drop what we kept for it. */
export function clearSessionView(bucket) {
  for (const v of sessionViews) v.clear(bucket);
}
