// ============================================================================
// LunaCore - armed auto-compact (§5.5, extended: Feature #4)
// ----------------------------------------------------------------------------
// A toggle in the Actions section. When ARMED, the renderer injects "/compact"
// itself through the EXISTING Action Injector (runCommand) - no new IPC
// channel. /compact does cost tokens, but it is an explicit cost the user armed
// on purpose (off by default).
//
// Feature #4 gave the armed toggle THREE exclusive trigger modes, chosen in the
// Settings overlay (Ctrl+L) and persisted in ui.local.json:
//
//   'context'  the original edge: fire once the ACTIVE tab's context crosses
//              AUTO_COMPACT_AT (85%), re-arm only below AUTO_COMPACT_REARM
//              (60%). Unchanged from the first version.
//   'turns'    fire every N completed turns on the ACTIVE tab (background tabs
//              never count - same safety model as 'context'). The counter
//              resets on a compact and on (dis)arming.
//   'time'     fire N minutes after the last compact (or after arming, until
//              the first compact), but ONLY while context is also past
//              AUTO_COMPACT_TIME_FLOOR (60%) - so M minutes on a near-empty
//              idle session compacts nothing.
//
// EVERY mode then passes the same gate: armed, the toggle is on screen, the
// session is alive (isLedDead), and 60 s have passed since the last shot. That
// gate is canAutoCompactFire() and it is pure so all four preconditions sit in
// one tested place.
//
// A2: first LEFT-panel conversion, and the first widget whose visible state does
// NOT live in its own DOM. Two consequences, both load-bearing:
//
//  1. `autoCompactArmed` is module state, so a fresh clone of the template comes
//     back UNCHECKED. mount() has to repaint the armed look from module state -
//     see the note there for why getting this wrong is worse than a cosmetic bug.
//  2. The subscription that can inject /compact lives in mount(), not at module
//     scope. Unmounted means no visible toggle, and an injector the user cannot
//     see or disarm is exactly what "zero surprise token spend" rules out - so
//     canAutoCompactFire() also checks `mounted()`, which covers the 'turns' and
//     'time' listeners that DO sit at module scope (onTurnEnd has no disposer,
//     same reason autoproceed.js / godmode.js register it once).
//
// The edge/cooldown/clock/counter state stays at module scope on purpose - a
// remount must not re-arm the edge or clear the cooldown and hand you a second
// /compact seconds after the first.
// ============================================================================

'use strict';

import { t } from './util.js';
import { onActiveContext, onLangChange } from './bus.js';
import { pulseCompact } from './actions.js';
import { isLedDead } from './led.js';
import { getActiveSessionId } from './terminals.js';
import { CTX_WARN_HIGH, CTX_WARN_MID } from './thresholds.js';
import { defineWidget } from './registry.js';
import { sfx } from './sound.js';

const AUTO_COMPACT_AT = CTX_WARN_HIGH;        // 'context' trigger threshold (0.85)
const AUTO_COMPACT_REARM = CTX_WARN_MID;      // 'context' re-arm floor (0.60)
const AUTO_COMPACT_TIME_FLOOR = CTX_WARN_MID; // 'time' minimum context to fire (0.60)
const AUTO_COMPACT_COOLDOWN_MS = 60000;       // never twice within 60 s, any mode
const MS_PER_MINUTE = 60000;                  // 'time' arithmetic
const TIME_TICK_MS = 15000;                   // how often 'time' re-checks the clock

const MODES = ['context', 'turns', 'time'];
const DEFAULT_EVERY_TURNS = 20;
const DEFAULT_AFTER_MINUTES = 30;

// ---- Pure trigger logic (unit-tested in test/autocompact.test.js) -----------

/**
 * 'context' mode: the edge with hysteresis. Fires ONCE crossing UP through
 * AUTO_COMPACT_AT and only re-arms after dropping below AUTO_COMPACT_REARM -
 * otherwise it oscillates around 85% after a compact and spams. Pure: caller's
 * flag in, next flag + verdict out (same shape as notify.js's
 * nextContextNotifyState).
 *
 * @param {boolean} fired already fired in this cycle
 * @param {number} pct 0..1
 * @returns {{fired: boolean, shouldFire: boolean}}
 */
export function nextThresholdState(fired, pct) {
  const held = pct < AUTO_COMPACT_REARM ? false : !!fired;
  if (pct < AUTO_COMPACT_AT || held) return { fired: held, shouldFire: false };
  return { fired: true, shouldFire: true };
}

/**
 * 'turns' mode: one completed active-tab turn folds in here. The counter is NOT
 * reset on a blocked fire (cooldown / dead LED) - it stays >= everyTurns so the
 * next turn asks again; fireCompact() is the only thing that zeroes it. An
 * everyTurns below 1 is inert (guards a hand-edited pref).
 *
 * @param {number} turnCount turns since the last fire / (dis)arm
 * @param {number} everyTurns target
 * @returns {{turnCount: number, shouldFire: boolean}}
 */
export function nextTurnState(turnCount, everyTurns) {
  const n = (Number.isFinite(turnCount) ? turnCount : 0) + 1;
  return { turnCount: n, shouldFire: everyTurns >= 1 && n >= everyTurns };
}

/**
 * 'time' mode: fire when at least afterMinutes have passed since the clock
 * origin (last compact, or arm time until the first compact) AND context is
 * past AUTO_COMPACT_TIME_FLOOR, so M minutes on a near-empty session compacts
 * nothing. afterMinutes below 1 is inert. Pure - no timer, no Date.now here.
 *
 * @param {number} elapsedMs since the clock origin
 * @param {number} pct 0..1 current context
 * @param {number} afterMinutes target
 * @returns {{shouldFire: boolean}}
 */
export function nextTimeState(elapsedMs, pct, afterMinutes) {
  const due = afterMinutes >= 1 && elapsedMs >= afterMinutes * MS_PER_MINUTE;
  return { shouldFire: due && pct >= AUTO_COMPACT_TIME_FLOOR };
}

/**
 * The gate EVERY mode passes before an injection: armed, the toggle is on
 * screen (an injector the user cannot see or disarm is exactly what the "zero
 * surprise token spend" rule forbids - §A2), the session is alive, and the
 * 60 s cooldown has elapsed. Pure so the four preconditions are pinned in one
 * place - a regression in any of them silently spams /compact or never sends it.
 *
 * @param {{armed: boolean, mounted: boolean, ledDead: boolean, sinceLastFireMs: number}} g
 * @returns {boolean}
 */
export function canAutoCompactFire({ armed, mounted, ledDead, sinceLastFireMs }) {
  if (!armed || !mounted || ledDead) return false;
  return sinceLastFireMs >= AUTO_COMPACT_COOLDOWN_MS;
}

/** Clamp a stored or typed mode to one of the three known values. */
export function normalizeMode(mode) {
  return MODES.includes(mode) ? mode : 'context';
}

// ---- Module state (must OUTLIVE a remount - see header) ---------------------

let els = null;    // left-panel widget mount (the arm toggle), or null off screen
let setEls = null; // Settings-overlay mount (the mode picker), or null

let autoCompactArmed = false; // per-session, never persisted - armed deliberately each run
let autoCompactFired = false; // 'context' edge flag
let autoCompactFiredAt = 0;   // last shot - the shared cooldown
let armedAt = 0;              // 'time' clock origin until the first compact
let lastCompactAt = 0;        // 'time' clock origin after the first compact
let turnCount = 0;            // 'turns': active-tab turns since last fire / (dis)arm
let lastPct = 0;              // most recent live context reading ('time' floor input)

// Persisted config (uiprefs.js). Defaults until getUiPrefs() lands on a mount.
let mode = 'context';
let everyTurns = DEFAULT_EVERY_TURNS;
let afterMinutes = DEFAULT_AFTER_MINUTES;

let autoCompactFlashTimer = null;

// ---- The trigger core ------------------------------------------------------

/** True while the arm toggle is on screen. */
function isMounted() {
  return els !== null;
}

/** Shared injection path for all three modes. */
function fireCompact() {
  const now = Date.now();
  autoCompactFired = true;
  autoCompactFiredAt = now;
  lastCompactAt = now; // restart the 'time' clock
  turnCount = 0;        // restart the 'turns' counter
  window.lunacore.runCommand('/compact'); // the same injector as the physical button
  pulseCompact();
  flashAutoCompactFired();
}

/** The shared gate, resolved against live module state. */
function gate() {
  return canAutoCompactFire({
    armed: autoCompactArmed,
    mounted: isMounted(),
    ledDead: isLedDead(),
    sinceLastFireMs: Date.now() - autoCompactFiredAt,
  });
}

/** Active-tab live context reading. Drives 'context' mode; feeds 'time' floor. */
function onContext(pct) {
  lastPct = pct;
  // The edge flag only means something in 'context' mode. Leave it untouched in
  // the other modes so switching back to 'context' never inherits a stale
  // "already fired".
  if (mode !== 'context') return;
  const next = nextThresholdState(autoCompactFired, pct);
  autoCompactFired = next.fired;
  if (next.shouldFire && gate()) fireCompact();
}

/** One completed turn on the ACTIVE tab (background turns are filtered out). */
function onActiveTurnEnd() {
  if (mode !== 'turns') return;
  const next = nextTurnState(turnCount, everyTurns);
  turnCount = next.turnCount;
  if (next.shouldFire && gate()) fireCompact();
}

/** 'time' mode clock check, run on the TIME_TICK_MS interval. */
function onTimeTick() {
  if (mode !== 'time' || !autoCompactArmed) return;
  const origin = lastCompactAt || armedAt;
  if (!origin) return;
  const { shouldFire } = nextTimeState(Date.now() - origin, lastPct, afterMinutes);
  if (shouldFire && gate()) fireCompact();
}

// onTurnEnd has no disposer (preload just adds the ipcRenderer listener), so it
// is registered ONCE here, not per-mount - the same module-scope pattern
// autoproceed.js and godmode.js use. Both handlers self-gate on mode + arm +
// gate(), and gate() checks isMounted(), so nothing fires while the toggle is
// off screen. Guarded so a plain-Node test require of this module (for the pure
// exports above) doesn't touch a missing `window`.
if (typeof window !== 'undefined' && window.lunacore) {
  window.lunacore.onTurnEnd(({ sessionId } = {}) => {
    if (sessionId && sessionId === getActiveSessionId()) onActiveTurnEnd();
  });
  setInterval(onTimeTick, TIME_TICK_MS);
}

// ---- Left-panel widget: the arm toggle ------------------------------------

/** Brief "/compact sent" flash, then back to the armed label. */
function flashAutoCompactFired() {
  if (!els) return;
  clearTimeout(autoCompactFlashTimer);
  els.field.classList.add('is-fired');
  els.status.textContent = t('autocompact.fired');
  autoCompactFlashTimer = setTimeout(() => {
    autoCompactFlashTimer = null;
    if (!els) return;
    els.field.classList.remove('is-fired');
    renderAutoCompact();
  }, 2500);
}

/** The armed-state status label, worded per mode. */
function armedLabel() {
  if (mode === 'turns') return t('autocompact.armed.turns', { n: everyTurns });
  if (mode === 'time') return t('autocompact.armed.time', { n: afterMinutes });
  return t('autocompact.armed.context');
}

/** Refreshes the status label (i18n-aware, also called on a language switch). */
function renderAutoCompact() {
  if (!els) return;
  if (els.field.classList.contains('is-fired')) return; // do not overwrite the flash
  els.status.textContent = autoCompactArmed ? armedLabel() : t('autocompact.off');
}

/** Loads the persisted mode + N/M into module state; repaints both mounts. */
function adoptPrefs(prefs) {
  if (!prefs) return;
  mode = normalizeMode(prefs.autoCompactMode);
  if (Number.isFinite(prefs.autoCompactEveryTurns)) everyTurns = prefs.autoCompactEveryTurns;
  if (Number.isFinite(prefs.autoCompactAfterMinutes)) afterMinutes = prefs.autoCompactAfterMinutes;
  renderAutoCompact();
  renderSettings();
}

defineWidget({
  id: 'autocompact',
  // No titleKey: this block has no header of its own - it sits under the
  // "Akcje" title next to the physical COMPACT button, which owns that heading.
  titleKey: '',
  template: 'w-autocompact',
  mount(root) {
    // NOTE: the root IS the control here, not a .panel__section wrapping one -
    // so `field` is root itself. root.querySelector() would not find it (it only
    // searches descendants), which is the one way this mount differs in shape
    // from the right-panel widgets.
    els = {
      field: root,
      status: root.querySelector('#autocompact-status'),
      toggle: root.querySelector('#autocompact-toggle'),
    };

    // Repaint the armed look from module state. The clone always arrives in its
    // authored state - unchecked, no .is-armed, status reading "off". Skipping
    // this would leave the HUD saying auto-compact is OFF while this module
    // happily keeps firing /compact: a wrong label on a control that spends
    // tokens, which is worse than a control that just looks stale.
    els.toggle.checked = autoCompactArmed;
    els.field.classList.toggle('is-armed', autoCompactArmed);
    renderAutoCompact();

    // Bound to an element INSIDE root, so it goes away with the subtree.
    els.toggle.addEventListener('change', () => {
      sfx.modeToggle();
      autoCompactArmed = els.toggle.checked;
      // (Dis)arming starts every mode's cycle over.
      autoCompactFired = false;
      turnCount = 0;
      armedAt = Date.now();
      lastCompactAt = 0;
      els.field.classList.toggle('is-armed', autoCompactArmed);
      renderAutoCompact();
    });

    const offContext = onActiveContext((metrics) => {
      if (!metrics || typeof metrics.percent !== 'number') return;
      onContext(Math.max(0, Math.min(1, metrics.percent)));
    });
    const offLang = onLangChange(renderAutoCompact);

    // The persisted mode + N/M arrive async (same as notify.js). A mount before
    // they land shows the safe 'context' default.
    window.lunacore.getUiPrefs().then(adoptPrefs).catch(() => {});

    return () => {
      offContext();
      offLang();
      // A2b: this timer only repaints a label, it carries no user intent, so it
      // CANCELS - nothing is lost by dropping the flash.
      clearTimeout(autoCompactFlashTimer);
      autoCompactFlashTimer = null;
      els = null;
    };
  },
});

// ---- Settings overlay: the trigger-mode picker --------------------------

/** Repaints the Settings controls: select value + which N/M row is visible. */
function renderSettings() {
  if (!setEls) return;
  setEls.mode.value = mode;
  setEls.turns.value = everyTurns;
  setEls.minutes.value = afterMinutes;
  setEls.turnsField.hidden = mode !== 'turns';
  setEls.minutesField.hidden = mode !== 'time';
}

/** Reads a number <input>, clamped to [min, max] and rounded, else `fallback`. */
function clampField(input, min, max, fallback) {
  const n = Number(input.value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

/**
 * Settings-overlay controls for the trigger MODE (context / turns / time) and
 * its N/M. Called once from termcustom.js's initTermcustomSettings() with
 * #termcustom as root - static, never-unmounted markup, same shape as
 * mountNotify(). The left-panel widget still owns the arm toggle itself; this
 * only decides WHAT an armed auto-compact watches.
 *
 * @param {ParentNode} root
 * @returns {() => void} disposer
 */
export function mountAutoCompactSettings(root) {
  setEls = {
    mode: root.querySelector('#autocompact-mode'),
    turnsField: root.querySelector('#autocompact-turns-field'),
    turns: root.querySelector('#autocompact-turns'),
    minutesField: root.querySelector('#autocompact-minutes-field'),
    minutes: root.querySelector('#autocompact-minutes'),
  };
  if (!setEls.mode) {
    setEls = null;
    return () => {};
  }

  renderSettings();

  setEls.mode.addEventListener('change', () => {
    sfx.modeToggle();
    mode = normalizeMode(setEls.mode.value);
    // Enter the new mode from a clean slate, never mid-count / mid-clock.
    turnCount = 0;
    armedAt = Date.now();
    lastCompactAt = 0;
    autoCompactFired = false;
    renderSettings();
    renderAutoCompact();
    window.lunacore.setUiPrefs({ autoCompactMode: mode });
  });

  setEls.turns.addEventListener('change', () => {
    everyTurns = clampField(setEls.turns, 1, 999, DEFAULT_EVERY_TURNS);
    setEls.turns.value = everyTurns;
    turnCount = 0;
    renderAutoCompact();
    window.lunacore.setUiPrefs({ autoCompactEveryTurns: everyTurns });
  });

  setEls.minutes.addEventListener('change', () => {
    afterMinutes = clampField(setEls.minutes, 1, 1440, DEFAULT_AFTER_MINUTES);
    setEls.minutes.value = afterMinutes;
    lastCompactAt = 0;
    armedAt = Date.now();
    renderAutoCompact();
    window.lunacore.setUiPrefs({ autoCompactAfterMinutes: afterMinutes });
  });

  const offLang = onLangChange(renderSettings);

  window.lunacore.getUiPrefs().then(adoptPrefs).catch(() => {});

  return () => {
    offLang();
    setEls = null;
  };
}
