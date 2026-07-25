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
// ============================================================================

'use strict';

import { t } from './util.js';
import { onActiveContext, onLangChange } from './bus.js';
import { pulseCompact } from './actions.js';
import { isLedDead } from './led.js';
import { CTX_WARN_HIGH, CTX_WARN_MID } from './context.js';

const AUTO_COMPACT_AT = CTX_WARN_HIGH;      // trigger threshold (0.85)
const AUTO_COMPACT_REARM = CTX_WARN_MID;    // ready again below this (0.60)
const AUTO_COMPACT_COOLDOWN_MS = 60000;     // never twice within 60 s

const autoCompactToggle = document.getElementById('autocompact-toggle');
const autoCompactStatus = document.getElementById('autocompact-status');
const autoCompactField = document.getElementById('autocompact-field');

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
  clearTimeout(autoCompactFlashTimer);
  autoCompactField.classList.add('is-fired');
  autoCompactStatus.textContent = t('autocompact.fired');
  autoCompactFlashTimer = setTimeout(() => {
    autoCompactField.classList.remove('is-fired');
    renderAutoCompact();
  }, 2500);
}

/** Refreshes the status label (i18n-aware, also called on a language switch). */
function renderAutoCompact() {
  if (autoCompactField.classList.contains('is-fired')) return; // do not overwrite the flash
  autoCompactStatus.textContent = autoCompactArmed ? t('autocompact.armed') : t('autocompact.off');
}

autoCompactToggle.addEventListener('change', () => {
  autoCompactArmed = autoCompactToggle.checked;
  autoCompactFired = false; // (dis)arming starts the cycle over
  autoCompactField.classList.toggle('is-armed', autoCompactArmed);
  renderAutoCompact();
});

onActiveContext((metrics) => {
  if (!metrics || typeof metrics.percent !== 'number') return;
  maybeAutoCompact(Math.max(0, Math.min(1, metrics.percent)));
});

onLangChange(renderAutoCompact);
