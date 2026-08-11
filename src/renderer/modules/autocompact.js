// ============================================================================
// LunaCore - armed auto-compact (§5.5)
// ----------------------------------------------------------------------------
// A toggle in the Actions section. When ARMED and the context crosses the
// threshold, the renderer injects "/compact" itself through the EXISTING Action
// Injector (runCommand) - no new IPC channel. /compact does cost tokens, but it
// is an explicit cost the user armed on purpose (off by default).
//
// Edge trigger with hysteresis: fires ONCE when the context crosses AT (85%)
// and only re-arms after it drops below REARM (60%) - otherwise it would
// oscillate around the threshold after a compact and spam. The cooldown is an
// extra safety belt in case the metric is briefly noisy right after a compact.
//
// It listens to the ACTIVE context stream, which is exactly the "live metric"
// path - restoring a tab replays metrics through a different route and must
// never fire an injection.
//
// A2: first LEFT-panel conversion, and the first widget whose visible state does
// NOT live in its own DOM. Two consequences, both load-bearing:
//
//  1. `autoCompactArmed` is module state, so a fresh clone of the template comes
//     back UNCHECKED. mount() has to repaint the armed look from module state -
//     see the note there for why getting this wrong is worse than a cosmetic bug.
//  2. The subscription that can inject /compact lives in mount(), not at module
//     scope. Unmounted means no visible toggle, and an injector the user cannot
//     see or disarm is exactly what "zero surprise token spend" rules out.
//
// The edge/cooldown flags stay at module scope on purpose - see below.
// ============================================================================

'use strict';

import { t } from './util.js';
import { onActiveContext, onLangChange } from './bus.js';
import { pulseCompact } from './actions.js';
import { isLedDead } from './led.js';
import { CTX_WARN_HIGH, CTX_WARN_MID } from './thresholds.js';
import { defineWidget } from './registry.js';
import { sfx } from './sound.js';

const AUTO_COMPACT_AT = CTX_WARN_HIGH;      // trigger threshold (0.85)
const AUTO_COMPACT_REARM = CTX_WARN_MID;    // ready again below this (0.60)
const AUTO_COMPACT_COOLDOWN_MS = 60000;     // never twice within 60 s

// Elements of the current mount, or null when this widget is not on screen.
let els = null;

// ---- State that must OUTLIVE a remount --------------------------------------
//
// autoCompactFired / autoCompactFiredAt are the whole anti-spam mechanism. If a
// remount reset them, taking the block down and putting it back would re-arm the
// edge and clear the cooldown - i.e. hand you a second /compact seconds after
// the first. They are deliberately module-level, not per-mount.
let autoCompactArmed = false; // toggle state (off by default, not persisted - you arm it each session)
let autoCompactFired = false; // edge flag: already fired in this cycle
let autoCompactFiredAt = 0;   // timestamp of the last shot (cooldown)
let autoCompactFlashTimer = null;

function maybeAutoCompact(pct) {
  if (!autoCompactArmed) return;
  // Hysteresis: once we drop below the re-arm threshold, clear the edge.
  if (pct < AUTO_COMPACT_REARM) autoCompactFired = false;
  if (pct < AUTO_COMPACT_AT || autoCompactFired) return;
  if (isLedDead()) return; // dead session - nowhere to inject
  if (Date.now() - autoCompactFiredAt < AUTO_COMPACT_COOLDOWN_MS) return;

  autoCompactFired = true;
  autoCompactFiredAt = Date.now();
  window.lunacore.runCommand('/compact'); // the same injector as the physical button
  pulseCompact();
  flashAutoCompactFired();
}

/** Brief "/compact sent" flash, then back to "armed". */
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

/** Refreshes the status label (i18n-aware, also called on a language switch). */
function renderAutoCompact() {
  if (!els) return;
  if (els.field.classList.contains('is-fired')) return; // do not overwrite the flash
  els.status.textContent = autoCompactArmed ? t('autocompact.armed') : t('autocompact.off');
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
    // authored state - unchecked, no .is-armed, status reading "off" (applyStatic
    // ran just before us). Skipping this would leave the HUD saying auto-compact
    // is OFF while this module happily keeps firing /compact: a wrong label on a
    // control that spends tokens, which is worse than a control that just looks
    // stale. The probe cannot see it - it counts subscribers, not pixels.
    els.toggle.checked = autoCompactArmed;
    els.field.classList.toggle('is-armed', autoCompactArmed);
    renderAutoCompact();

    // Bound to an element INSIDE root, so it goes away with the subtree.
    els.toggle.addEventListener('change', () => {
      sfx.modeToggle();
      autoCompactArmed = els.toggle.checked;
      autoCompactFired = false; // (dis)arming starts the cycle over
      els.field.classList.toggle('is-armed', autoCompactArmed);
      renderAutoCompact();
    });

    const offContext = onActiveContext((metrics) => {
      if (!metrics || typeof metrics.percent !== 'number') return;
      maybeAutoCompact(Math.max(0, Math.min(1, metrics.percent)));
    });
    const offLang = onLangChange(renderAutoCompact);

    return () => {
      offContext();
      offLang();
      // A2b, the other half of the rule: this timer only repaints a label, it
      // carries no user intent, so it CANCELS - unlike the scratchpad's autosave,
      // which had to flush. Nothing is lost by dropping the flash.
      clearTimeout(autoCompactFlashTimer);
      autoCompactFlashTimer = null;
      els = null;
    };
  },
});
