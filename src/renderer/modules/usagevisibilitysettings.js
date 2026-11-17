// ============================================================================
// LunaCore - Settings (Ctrl+L) -> Usage limits shown (renderer)
// ----------------------------------------------------------------------------
// Two selects in the static #usage-visibility-section markup (index.html,
// next to Claude accounts): what the usage tile lists on a Claude tab and on
// an Antigravity (agy) tab - Claude accounts only / the Google account only /
// all of them. Stored as uiprefs usageVisibility through the existing
// setUiPrefs IPC and validated again in main (src/usagevisibility.js). Every
// change is put on the bus (emitUsageVisibility), so the tile repaints live.
// ============================================================================

'use strict';

import { t } from './util.js';
import { onLangChange, emitUsageVisibility } from './bus.js';
import { sfx } from './sound.js';
import { USAGE_PRESETS, normalizeUsageVisibility, presetOfRule, ruleOfPreset } from './usagevisibility.js';

/** Settings select id -> the tab kind it sets. */
const SELECTS = Object.freeze({ 'usage-vis-claude': 'claudeTab', 'usage-vis-agy': 'agyTab' });

let els = null;
let state = normalizeUsageVisibility(null);

/** Writes the whole value; main answers with what it stored (null = write failed). */
function save(value) {
  return Promise.resolve()
    .then(() => window.lunacore.setUiPrefs({ usageVisibility: value }))
    .then((next) => {
      if (!next) console.warn('[usage-visibility] the setting could not be saved');
    })
    .catch((err) => console.warn('[usage-visibility] save failed:', (err && err.message) || err));
}

function paint() {
  if (!els) return;
  for (const [id, kind] of Object.entries(SELECTS)) {
    const select = els[id];
    select.replaceChildren(...Object.keys(USAGE_PRESETS).map((preset) => {
      const opt = document.createElement('option');
      opt.value = preset;
      opt.textContent = t(`usage.visibility.preset.${preset}`);
      return opt;
    }));
    select.value = presetOfRule(state[kind]);
  }
}

/**
 * Called once from termcustom.js initTermcustomSettings() with #termcustom as
 * root and the prefs it already read. Puts the stored choice on the bus at
 * once, so the usage tile follows it from its first paint.
 */
export function mountUsageVisibilitySettings(root, prefs) {
  state = normalizeUsageVisibility(prefs && prefs.usageVisibility);
  emitUsageVisibility(state);
  const found = Object.fromEntries(Object.keys(SELECTS).map((id) => [id, root.querySelector(`#${id}`)]));
  if (Object.values(found).some((el) => !el)) return () => {};
  els = found;
  paint();
  for (const [id, kind] of Object.entries(SELECTS)) {
    els[id].addEventListener('change', (ev) => {
      const rule = ruleOfPreset(ev.target.value);
      if (!rule) return;
      sfx.modeToggle();
      state = { ...state, [kind]: rule };
      emitUsageVisibility(state);
      save(state);
    });
  }
  // Static overlay, never unmounted (same as hubsettings.js).
  const offLang = onLangChange(paint);
  return () => {
    offLang();
    els = null;
  };
}
