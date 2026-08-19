// ============================================================================
// LunaCore - OS notifications (busy -> idle, context >= 85%)
// ----------------------------------------------------------------------------
// PASSIVE OBSERVER: reacts to signals two other modules already produce
// (led.js's busy/idle edge, context.js's threshold reading) and surfaces them
// as a native Windows toast. No new IPC listener on the PTY, no model call -
// this only decides whether to pop a `Notification`, same "zero extra tokens"
// rule as autocompact.js, applied to noticing instead of acting.
//
// Two triggers, one purpose: tell you something changed on a tab you are NOT
// currently looking at. A tab you have on screen with the window focused
// already has the LED and the context bar right there - a toast on top of
// that would just be noise, so both handlers below suppress that case.
//
// Off by default (uiprefs.js's notificationsEnabled) - like
// soundReadOutputEnabled, an unannounced desktop popup is a worse surprise
// than a quiet HUD, so this is opt-in.
//
// 2026-08-19 (Mati): moved out of the widget registry into the Settings
// overlay (Ctrl+L) - same "static overlay, never unmounted" shape boot.js's
// mountBoot() already established, and for the same reason (decluttering the
// left panel). mountNotify(root) is called once from termcustom.js's
// initTermcustomSettings() with #termcustom as root; the bus subscriptions
// below are permanent for the rest of the app's life, same as boot's.
// ============================================================================

'use strict';

import { t } from './util.js';
import { onActiveContext, onBackgroundContext, onBusyIdle, onLangChange } from './bus.js';
import { getActiveBucket, getActiveSessionId } from './terminals.js';
import { CTX_WARN_HIGH, CTX_WARN_MID } from './thresholds.js';
import { sfx } from './sound.js';

// Elements of the current mount, or null before mountNotify() has run.
let els = null;

// Loaded from ui.local.json on mount, written back on every toggle - see
// uiprefs.js's notificationsEnabled (same shape as ports.js's hideSystemPorts).
let notifyEnabled = false;

/**
 * Edge/rearm decision for ONE session's context reading - the same hysteresis
 * shape as autocompact.js's maybeAutoCompact(): fires once crossing UP through
 * CTX_WARN_HIGH, and only re-arms after dropping below CTX_WARN_MID, so a
 * reading that hovers around 85% cannot spam a toast per tick.
 *
 * Pure - the caller's flag in, the next flag + verdict out - so it is
 * unit-testable without a bucket, a session or a DOM. Each session keeps its
 * OWN `fired` flag (stored on its bucket, see maybeNotifyContext below);
 * unlike autocompact there is only one of those per app, this one is
 * necessarily per-tab.
 *
 * @param {boolean} fired whether this session already notified in this cycle
 * @param {number} pct 0..1
 * @returns {{fired: boolean, shouldFire: boolean}}
 */
export function nextContextNotifyState(fired, pct) {
  if (pct < CTX_WARN_MID) return { fired: false, shouldFire: false };
  if (pct < CTX_WARN_HIGH) return { fired: !!fired, shouldFire: false };
  if (fired) return { fired: true, shouldFire: false };
  return { fired: true, shouldFire: true };
}

/** Silent OS toast; clicking it brings the HUD forward and jumps to the tab. */
function fireToast(title, body, sessionId) {
  if (typeof Notification === 'undefined') return;
  const toast = new Notification(title, { body, silent: true });
  toast.onclick = () => {
    window.lunacore.focusWindow();
    window.lunacore.activateSession(sessionId);
  };
}

/** A session just went from working to waiting - active tab or background. */
function handleBusyIdle(sessionId) {
  if (!notifyEnabled) return;
  // Already looking at it: the LED just told you the same thing on screen.
  if (sessionId === getActiveSessionId() && document.hasFocus()) return;
  fireToast(t('notify.busyIdle.title'), t('notify.busyIdle.body'), sessionId);
}

/**
 * Checked BEFORE updating the hysteresis flag, on purpose - the same order
 * autocompact.js's `if (!autoCompactArmed) return;` uses. Arming this while a
 * session already sits at 92% should notify on the very next reading, not
 * silently skip it because the flag would have already flipped true while the
 * toggle was off.
 */
function maybeNotifyContext(bucket, sessionId, pct) {
  if (!notifyEnabled) return;
  const clamped = Math.max(0, Math.min(1, pct));
  const { fired, shouldFire } = nextContextNotifyState(bucket.notifyCtxFired, clamped);
  bucket.notifyCtxFired = fired;
  if (shouldFire) fireToast(t('notify.context.title'), t('notify.context.body'), sessionId);
}

function handleActiveContext(metrics) {
  if (!metrics || typeof metrics.percent !== 'number') return;
  const sessionId = getActiveSessionId();
  const bucket = getActiveBucket();
  if (!sessionId || !bucket) return;
  maybeNotifyContext(bucket, sessionId, metrics.percent);
}

function handleBackgroundContext(bucket, metrics) {
  if (!bucket || !bucket.id || !metrics || typeof metrics.percent !== 'number') return;
  maybeNotifyContext(bucket, bucket.id, metrics.percent);
}

function renderStatus() {
  if (!els) return;
  els.status.textContent = t(notifyEnabled ? 'notify.armed' : 'notify.off');
}

/**
 * Wires the notification toggle inside whatever root it's given - called once
 * from termcustom.js with the #termcustom overlay as root (static markup, not
 * a widget, so there's no remount to guard against - see boot.js's mountBoot
 * for the identical shape this mirrors).
 */
export function mountNotify(root) {
  els = {
    field: root.querySelector('#notify-field'),
    status: root.querySelector('#notify-status'),
    toggle: root.querySelector('#notify-toggle'),
  };

  // Repaint from module state - notifyEnabled only changes via a toggle or the
  // async prefs load below, never from the (now nonexistent) template clone.
  els.toggle.checked = notifyEnabled;
  els.field.classList.toggle('is-armed', notifyEnabled);
  renderStatus();

  els.toggle.addEventListener('change', () => {
    sfx.modeToggle();
    notifyEnabled = els.toggle.checked;
    els.field.classList.toggle('is-armed', notifyEnabled);
    renderStatus();
    window.lunacore.setUiPrefs({ notificationsEnabled: notifyEnabled });
  });

  // The real, persisted value arrives async - a mount before it lands shows
  // the (safe) off default rather than blocking on it.
  window.lunacore
    .getUiPrefs()
    .then((prefs) => {
      if (!els || !prefs) return;
      notifyEnabled = prefs.notificationsEnabled === true;
      els.toggle.checked = notifyEnabled;
      els.field.classList.toggle('is-armed', notifyEnabled);
      renderStatus();
    })
    .catch(() => {});

  const offLang = onLangChange(renderStatus);
  // The overlay being closed does not mean the user cannot see a toast - a
  // notification is exactly for a tab they are NOT currently looking at - so
  // unlike the old widget's mount()/unmount(), these subscriptions are
  // permanent for the app's lifetime, same as boot.js's mountBoot().
  const offBusyIdle = onBusyIdle(handleBusyIdle);
  const offActiveCtx = onActiveContext(handleActiveContext);
  const offBackgroundCtx = onBackgroundContext(handleBackgroundContext);

  return () => {
    offLang();
    offBusyIdle();
    offActiveCtx();
    offBackgroundCtx();
    els = null;
  };
}
