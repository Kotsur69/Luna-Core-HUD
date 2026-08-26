// ============================================================================
// LunaCore - Settings overlay (Ctrl+L)
// ----------------------------------------------------------------------------
// TERMINAL_CUSTOMIZER_PLAN.md. Mirrors palette.js's shape exactly - the only
// other standalone (non-widget-registry) overlay in this codebase: markup is
// static in index.html (not a <template>), so elements are queried once at
// module load time, and Escape/backdrop-click/global-keybind all follow the
// same pattern palette.js already established for Ctrl+K.
//
// 2026-08-13 (Mati): expanded from terminal-appearance-only into a general
// Settings overlay - sound (toggle/volume/keystroke variant/"all done"
// minutes/read-output) and the boot-sequence toggle moved here from
// appearance.js's left panel, which was getting crowded. File/module/element
// ids kept the historical "termcustom" name; only the user-visible title text
// changed (see i18n.js's `termcustom.title`).
// ============================================================================

'use strict';

import { term, applyTerminalAppearance } from './terminals.js';
import { mountBoot, startBoot } from './boot.js';
import { mountNotify } from './notify.js';
import { applyLang } from './appearance.js';
import { sfx } from './sound.js';
import {
  setEnabled as setSynthEnabled,
  setVolume as setSynthVolume,
  setVariant as setSynthVariant,
  userKeystroke,
  preloadCurrentVariant,
} from './keysynth.js';
import { t } from './util.js';

const termcustomEl = document.getElementById('termcustom');
const els = {
  // Moved from appearance.js's w-appearance template (2026-08-19).
  langSwitcher: document.getElementById('termcustom-lang-switcher'),
  fontFamily: document.getElementById('termcustom-font-family'),
  fontFamilyCustomField: document.getElementById('termcustom-font-family-custom-field'),
  fontFamilyCustom: document.getElementById('termcustom-font-family-custom'),
  fontSize: document.getElementById('termcustom-font-size'),
  lineHeight: document.getElementById('termcustom-line-height'),
  letterSpacing: document.getElementById('termcustom-letter-spacing'),
  cursorStyle: document.getElementById('termcustom-cursor-style'),
  cursorBlink: document.getElementById('termcustom-cursor-blink'),
  scrollback: document.getElementById('termcustom-scrollback'),
  bgOpacity: document.getElementById('termcustom-bg-opacity'),
  bgBlur: document.getElementById('termcustom-bg-blur'),
  bgImagePick: document.getElementById('termcustom-bg-image-pick'),
  bgImageClear: document.getElementById('termcustom-bg-image-clear'),
  bgImageStatus: document.getElementById('termcustom-bg-image-status'),
  reset: document.getElementById('termcustom-reset'),
  // Moved from appearance.js's w-appearance template (2026-08-13).
  soundToggle: document.getElementById('sound-toggle'),
  voiceToggle: document.getElementById('voice-toggle'),
  soundVolume: document.getElementById('sound-volume'),
  soundKeystrokeVariant: document.getElementById('sound-keystroke-variant'),
  soundLongTaskMinutes: document.getElementById('sound-long-task-minutes'),
  soundReadOutputToggle: document.getElementById('sound-read-output-toggle'),
};

// The curated <option> values in index.html - anything else means "Custom…".
const CURATED_FONTS = new Set(
  Array.from(els.fontFamily.options)
    .map((o) => o.value)
    .filter((v) => v !== '__custom__')
);

// Mirrors uiprefs.js's DEFAULTS for the term* fields (§5) - same duplication
// appearance.js already accepts for theme/lang/sound (renderer has no access
// to the main-process module, only to what getUiPrefs() returns over IPC).
const TERM_DEFAULTS = {
  termFontFamily: 'Cascadia Code, Consolas, "Courier New", monospace',
  termFontSize: 14,
  termLineHeight: 1.0,
  termLetterSpacing: 0,
  termCursorStyle: 'block',
  termCursorBlink: true,
  termScrollback: 5000,
  termBgOpacity: 100,
  termBgBlur: 0,
  termBgImage: null,
};

let termcustomOpen = false;

// Moved from appearance.js's module state (2026-08-13) - mirrors its role:
// module scope so a re-render (langChange, reopen) repaints from truth
// instead of the template's authored defaults.
let soundPrefs = {
  enabled: true,
  voiceEnabled: true,
  volume: 70,
  keystrokeVariant: 'mechanical',
  longTaskMinutes: 10,
  readOutputEnabled: false,
};

/** Repaints the sound controls (toggle, volume, keystroke variant, ...). */
function renderSoundSwitcher() {
  els.soundToggle.checked = soundPrefs.enabled;
  els.voiceToggle.checked = soundPrefs.voiceEnabled;
  els.soundVolume.value = soundPrefs.volume;
  els.soundKeystrokeVariant.value = soundPrefs.keystrokeVariant;
  els.soundLongTaskMinutes.value = soundPrefs.longTaskMinutes;
  els.soundReadOutputToggle.checked = soundPrefs.readOutputEnabled;
}

/** Persists a partial prefs change AND repaints the live terminal (§4/§5). */
function persistAndApply(partial) {
  window.lunacore.setUiPrefs(partial);
  applyTerminalAppearance(partial);
}

/** Paints every control from a prefs object (§5 shape). */
function renderFromPrefs(prefs) {
  const isCurated = CURATED_FONTS.has(prefs.termFontFamily);
  els.fontFamily.value = isCurated ? prefs.termFontFamily : '__custom__';
  els.fontFamilyCustomField.hidden = isCurated;
  els.fontFamilyCustom.value = isCurated ? '' : prefs.termFontFamily;

  els.fontSize.value = prefs.termFontSize;
  els.lineHeight.value = prefs.termLineHeight;
  els.letterSpacing.value = prefs.termLetterSpacing;
  els.cursorStyle.value = prefs.termCursorStyle;
  els.cursorBlink.checked = prefs.termCursorBlink;
  els.scrollback.value = prefs.termScrollback;
  els.bgOpacity.value = prefs.termBgOpacity;
  els.bgBlur.value = prefs.termBgBlur;
  renderBgImageStatus(prefs.termBgImage);
}

/** Text-only feedback since a data: URI is meaningless to show as-is. */
function renderBgImageStatus(termBgImage) {
  els.bgImageStatus.textContent = termBgImage ? t('termcustom.bgImage.set') : t('termcustom.bgImage.none');
}

/** Repaints the language select from the live i18n state (appearance.js owns applying it). */
function renderLangSwitcher() {
  els.langSwitcher.value = window.i18n.lang;
}

async function openTermcustom() {
  if (termcustomOpen) return;
  termcustomOpen = true;
  termcustomEl.hidden = false;
  renderLangSwitcher();

  let prefs = TERM_DEFAULTS;
  try {
    prefs = (await window.lunacore.getUiPrefs()) || TERM_DEFAULTS;
  } catch {
    /* IPC failed - fall back to defaults, still lets the modal open */
  }
  renderFromPrefs(prefs);
  // Same reason as gitquick.js's openGitQuick(): the overlay is a plain <div>,
  // so until it holds focus its own keydown (Escape, :265) never fires and the
  // keys keep going into the terminal. Needs the tabindex="-1" in index.html.
  termcustomEl.focus();
}

function closeTermcustom() {
  if (!termcustomOpen) return;
  termcustomOpen = false;
  termcustomEl.hidden = true;
}

// -- Language (moved from appearance.js, 2026-08-19) -------------------------

els.langSwitcher.addEventListener('change', () => {
  sfx.modeToggle();
  applyLang(els.langSwitcher.value);
  window.lunacore.setUiPrefs({ lang: els.langSwitcher.value });
});

// -- Persistence: each control writes its own term* key on change -----------

els.fontFamily.addEventListener('change', () => {
  const custom = els.fontFamily.value === '__custom__';
  els.fontFamilyCustomField.hidden = !custom;
  if (custom) {
    els.fontFamilyCustom.focus();
    return; // wait for the free-text field itself before persisting
  }
  persistAndApply({ termFontFamily: els.fontFamily.value });
});

els.fontFamilyCustom.addEventListener('change', () => {
  persistAndApply({ termFontFamily: els.fontFamilyCustom.value });
});

els.fontSize.addEventListener('change', () => {
  persistAndApply({ termFontSize: Number(els.fontSize.value) });
});

els.lineHeight.addEventListener('change', () => {
  persistAndApply({ termLineHeight: Number(els.lineHeight.value) });
});

els.letterSpacing.addEventListener('change', () => {
  persistAndApply({ termLetterSpacing: Number(els.letterSpacing.value) });
});

els.cursorStyle.addEventListener('change', () => {
  persistAndApply({ termCursorStyle: els.cursorStyle.value });
});

els.cursorBlink.addEventListener('change', () => {
  persistAndApply({ termCursorBlink: els.cursorBlink.checked });
});

els.scrollback.addEventListener('change', () => {
  persistAndApply({ termScrollback: Number(els.scrollback.value) });
});

els.bgOpacity.addEventListener('change', () => {
  persistAndApply({ termBgOpacity: Number(els.bgOpacity.value) });
});

els.bgBlur.addEventListener('change', () => {
  persistAndApply({ termBgBlur: Number(els.bgBlur.value) });
});

els.bgImagePick.addEventListener('click', async () => {
  els.bgImagePick.disabled = true;
  try {
    const result = await window.lunacore.pickTermBgImage();
    if (!result) return; // user cancelled the dialog
    if (result.error) {
      // Only two error shapes come back from main.js - both simple enough
      // for a native alert, no need for a dedicated notice UI (§2/§4).
      window.alert(
        result.error === 'tooLarge' ? t('termcustom.bgImage.errTooLarge') : t('termcustom.bgImage.errUnsupported')
      );
      return;
    }
    renderBgImageStatus(result.dataUrl);
    persistAndApply({ termBgImage: result.dataUrl });
  } finally {
    els.bgImagePick.disabled = false;
  }
});

els.bgImageClear.addEventListener('click', () => {
  renderBgImageStatus(null);
  persistAndApply({ termBgImage: null });
});

els.reset.addEventListener('click', () => {
  renderFromPrefs(TERM_DEFAULTS);
  persistAndApply({ ...TERM_DEFAULTS });
});

// -- Sound & boot (moved from appearance.js, 2026-08-13) ---------------------
// Reset above is scoped to terminal-appearance fields only - it does not
// touch these, matching how Mati never asked for a sound/boot reset.

els.soundToggle.addEventListener('change', () => {
  soundPrefs.enabled = els.soundToggle.checked;
  setSynthEnabled(soundPrefs.enabled);
  window.lunacore.setUiPrefs({ soundEnabled: soundPrefs.enabled });
});

els.voiceToggle.addEventListener('change', () => {
  soundPrefs.voiceEnabled = els.voiceToggle.checked;
  window.lunacore.setUiPrefs({ voiceEnabled: soundPrefs.voiceEnabled });
});

els.soundVolume.addEventListener('change', () => {
  soundPrefs.volume = Number(els.soundVolume.value);
  setSynthVolume(soundPrefs.volume);
  window.lunacore.setUiPrefs({ soundVolume: soundPrefs.volume });
});

els.soundKeystrokeVariant.addEventListener('change', () => {
  soundPrefs.keystrokeVariant = els.soundKeystrokeVariant.value;
  setSynthVariant(soundPrefs.keystrokeVariant);
  window.lunacore.setUiPrefs({ soundKeystrokeVariant: soundPrefs.keystrokeVariant });
  // Audition-by-ear: hear the click you just picked, not just its label.
  userKeystroke();
});

els.soundLongTaskMinutes.addEventListener('change', () => {
  const n = Number(els.soundLongTaskMinutes.value);
  soundPrefs.longTaskMinutes = Number.isFinite(n) && n >= 0 ? Math.round(n) : 10;
  els.soundLongTaskMinutes.value = soundPrefs.longTaskMinutes;
  window.lunacore.setUiPrefs({ soundLongTaskMinutes: soundPrefs.longTaskMinutes });
});

els.soundReadOutputToggle.addEventListener('change', () => {
  soundPrefs.readOutputEnabled = els.soundReadOutputToggle.checked;
  window.lunacore.setUiPrefs({ soundReadOutputEnabled: soundPrefs.readOutputEnabled });
});

// Escape closes it, refocuses the terminal - same as palette's close path.
termcustomEl.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    e.preventDefault();
    closeTermcustom();
    term.focus();
  } else if (e.key === 'Enter' && e.target.tagName !== 'BUTTON') {
    // No <form> here, so Enter otherwise does nothing visible - re-focusing
    // commits a text/number field's pending value (fires its own 'change'
    // handler above) without losing keyboard focus inside the modal.
    e.preventDefault();
    e.target.blur();
    e.target.focus();
  }
});

// Flashes the changed field so a persisted value has a visible confirmation -
// one delegated listener rather than repeating this in every handler above.
termcustomEl.addEventListener('change', (e) => {
  const field = e.target.closest('.ui-field, .switch-field');
  if (!field) return;
  field.classList.remove('is-confirmed');
  void field.offsetWidth; // restart the animation on a repeated change
  field.classList.add('is-confirmed');
});

// Clicking the backdrop closes it.
termcustomEl.addEventListener('click', (e) => {
  if (e.target.hasAttribute('data-termcustom-close')) {
    closeTermcustom();
    term.focus();
  }
});

// The chip in the terminal bar opens the customizer.
/** Called once by the `terminal` widget's mount() - see modules/terminal.js. */
export function mountTermcustomChip(root) {
  const btn = root.querySelector('#termcustom-open');
  if (btn) btn.addEventListener('click', openTermcustom);
}

/**
 * One-time startup init for the sound + boot section, moved here from
 * appearance.js's initAppearance() (2026-08-13). Must be called from
 * renderer.js AFTER initAppearance() - startBoot() has always documented that
 * it needs language and theme already applied, so nothing jumps mid-animation.
 */
export async function initTermcustomSettings() {
  let prefs = {
    boot: true,
    soundEnabled: true,
    voiceEnabled: true,
    soundVolume: 70,
    soundKeystrokeVariant: 'mechanical',
    soundLongTaskMinutes: 10,
    soundReadOutputEnabled: false,
  };
  try {
    prefs = (await window.lunacore.getUiPrefs()) || prefs;
  } catch {
    /* no preferences - stay on the defaults */
  }

  soundPrefs = {
    enabled: prefs.soundEnabled !== false,
    voiceEnabled: prefs.voiceEnabled !== false,
    volume: typeof prefs.soundVolume === 'number' ? prefs.soundVolume : 70,
    keystrokeVariant: prefs.soundKeystrokeVariant || 'mechanical',
    longTaskMinutes:
      typeof prefs.soundLongTaskMinutes === 'number' ? prefs.soundLongTaskMinutes : 10,
    readOutputEnabled: prefs.soundReadOutputEnabled === true,
  };
  setSynthEnabled(soundPrefs.enabled);
  setSynthVolume(soundPrefs.volume);
  setSynthVariant(soundPrefs.keystrokeVariant);
  preloadCurrentVariant(); // decode+slice is real work - don't do it for the first time on a keypress
  renderSoundSwitcher();

  // mountBoot(root) is root-agnostic (see boot.js) - #termcustom is static,
  // non-remountable markup, so the returned disposer is never called, same
  // as terminal.js's "No cleanup: this widget is never meant to unmount".
  mountBoot(termcustomEl);
  startBoot(prefs.boot !== false);

  // Notifications: same "static overlay, never unmounted" shape as boot above
  // - moved out of the widget registry entirely (2026-08-19), see notify.js.
  mountNotify(termcustomEl);
}

// Global Ctrl/Cmd+L (capture, to get ahead of xterm.js) - same tradeoff and
// precedent as palette.js's Ctrl+K handler (§0: Ctrl+L no longer reaches the
// shell's readline "clear screen" binding while LunaCore has focus).
window.addEventListener(
  'keydown',
  (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === 'l' || e.key === 'L')) {
      e.preventDefault();
      e.stopPropagation();
      if (termcustomOpen) { closeTermcustom(); term.focus(); }
      else openTermcustom();
    }
  },
  true
);
