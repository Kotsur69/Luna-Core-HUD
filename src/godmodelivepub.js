// ============================================================================
// LunaCore - when the live God Mode snapshot goes out (main, pure timers)
// ----------------------------------------------------------------------------
// orchestra.js commit() and the tab status board poke() this on every change;
// it decides whether the `godmode` snapshot's `live` / `lives` / `tabs` /
// `plans` go out now (`lives`: one per project's run, MULTI_GODMODE_PLAN.md
// A5; `plans`: plans not started yet, src/hostgodmode.js):
//
//   - at once when a package changes state, the run pauses / resumes,
//     settles or is killed, or a plan starts / finishes planning (the
//     "urgent" key moved);
//   - otherwise at most every MIN_MS (elapsed times, tab lights);
//   - while a run is running or paused, at least every HEARTBEAT_MS, so the
//     phone can tell a quiet run from a PC that went away (its 'stale' badge
//     shows after godmodesnapshot LIVE_STALE_MS);
//   - never when nothing but the clock moved and no heartbeat is due.
//
// `publish` is snapshotputs godmode.live(): it skips while logged out and
// only logs a failure. This module never throws into commit().
// ============================================================================

'use strict';

const MIN_MS = 15 * 1000;
const HEARTBEAT_MS = 60 * 1000;

/** Every live run in a section: `lives`, or the one `live` of an older build. */
const livesOf = (section) => {
  if (!section) return [];
  if (Array.isArray(section.lives)) return section.lives.filter(Boolean);
  return section.live ? [section.live] : [];
};
/** The section's plans not started yet (older callers send none). */
const plansOf = (section) => (section && Array.isArray(section.plans) ? section.plans.filter(Boolean) : []);
const isActive = (section) => livesOf(section).some((l) => l.state === 'running' || l.state === 'paused');
const errText = (err) => (err instanceof Error ? err.message : String(err));

/** What must go out at once: each run's identity / state, every package's state, each plan's state. */
function urgentKey(section) {
  const lives = livesOf(section);
  const plans = plansOf(section);
  if (!lives.length && !plans.length) return 'none';
  return JSON.stringify([
    lives.map((l) => [l.id, l.state, l.pausedUntil, l.packages.map((p) => [p.id, p.state])]),
    plans.map((p) => [p.projectId, p.planId, p.state]),
  ]);
}

/** Everything but the clock: elapsed times alone are not a change. */
function contentKey(section) {
  if (!section) return 'none';
  const lives = livesOf(section).map((l) => ({ ...l, packages: l.packages.map((p) => ({ ...p, elapsedMs: null })) }));
  return JSON.stringify({ lives, tabs: section.tabs || [], plans: plansOf(section) });
}

/**
 * @param {{
 *   build: () => ({live: object|null, lives?: object[], tabs: object[], plans?: object[]}|null),
 *   publish: (section: object) => unknown,
 *   now?: () => number, setTimer?: Function, clearTimer?: Function,
 *   minMs?: number, heartbeatMs?: number, log?: (msg: string) => void,
 * }} deps
 */
function createLivePublisher({
  build,
  publish,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  minMs = MIN_MS,
  heartbeatMs = HEARTBEAT_MS,
  log = (msg) => console.error(msg),
}) {
  let lastAt = -Infinity;
  let lastUrgent = 'none';
  let lastContent = null;
  let timer = null;

  function arm(ms) {
    if (timer) clearTimer(timer);
    timer = setTimer(check, Math.max(0, ms));
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  function send(section) {
    try {
      Promise.resolve(publish(section)).catch((err) => log(`[godmode-live] publish failed: ${errText(err)}`));
    } catch (err) {
      log(`[godmode-live] publish failed: ${errText(err)}`);
    }
  }

  function check() {
    if (timer) clearTimer(timer);
    timer = null;
    let section;
    try {
      section = build();
    } catch (err) {
      log(`[godmode-live] build failed: ${errText(err)}`);
      return;
    }
    const t = now();
    const urgent = urgentKey(section);
    const content = contentKey(section);
    const since = t - lastAt;
    const changed = content !== lastContent;
    if (urgent !== lastUrgent || (changed && since >= minMs) || (isActive(section) && since >= heartbeatMs)) {
      lastAt = t;
      lastUrgent = urgent;
      lastContent = content;
      send(section);
      if (isActive(section)) arm(heartbeatMs);
      return;
    }
    // A throttled change goes out when the window opens; a live run keeps its heartbeat.
    if (changed) arm(minMs - since);
    else if (isActive(section)) arm(heartbeatMs - since);
  }

  return {
    /** Something changed (a commit, a tab light): publish now, later or not at all. */
    poke: check,
    stop() {
      if (timer) clearTimer(timer);
      timer = null;
    },
  };
}

module.exports = { createLivePublisher, MIN_MS, HEARTBEAT_MS };
