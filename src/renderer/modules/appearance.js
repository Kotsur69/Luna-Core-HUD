// ============================================================================
// LunaCore - appearance: theme + language
// ----------------------------------------------------------------------------
// Themes come from config/themes.json (maps of CSS tokens + xterm colours), the
// language from the i18n.js dictionary. Both choices persist in
// config/ui.local.json. Switching works live: tokens go onto documentElement,
// xterm palettes through term.options, and the text through applyStatic() plus
// a language broadcast that has every module re-render its own dynamic strings.
//
// A2: this widget's root also hosts boot.js's toggle (mountBoot) - same
// one-root-two-owners shape as context.js + spark.js. `activeThemeId` is kept
// at module scope (mirroring autocompact's armed flag / switchers'
// currentProfileId) so a remount repaints the select from truth instead of
// its template's first authored <option>; the language equivalent is already
// available as window.i18n.lang, so no separate variable is needed for it.
// ============================================================================

'use strict';

import { emitLangChange } from './bus.js';
import { applyTerminalTheme } from './terminals.js';
import { defineWidget } from './registry.js';
import { mountBoot, startBoot } from './boot.js';
import { mountUpdate } from './update.js';
import { getLayouts, getActiveLayoutId, selectLayout } from './layout.js';
import { loc } from './util.js';
import { sfx, setKeystrokeVariant } from './sound.js';

let themesById = new Map();
let activeThemeId = null;

// Mirrors activeThemeId's role: module state so a remount repaints the
// controls from truth instead of the template's authored defaults.
let soundPrefs = {
  enabled: true,
  volume: 70,
  keystrokeVariant: 'mechanical',
  longTaskMinutes: 10,
  readOutputEnabled: false,
};

// Elements of the current mount, or null when this widget is not on screen.
let els = null;

// Tokens the previous theme wrote onto documentElement. See applyThemeVars().
let appliedTokens = [];

/**
 * Puts a theme's tokens on :root and its palette on the terminals.
 *
 * Tokens the OUTGOING theme set and the incoming one does not are removed, not
 * left in place. This matters much more since C3: when every theme carried the
 * same 17 colour tokens they all overwrote each other and nothing could go
 * stale, but the vocabulary is ~45 now and themes deliberately set only what
 * they care about. Without this, switching `matrix` (--radius: 0) -> `light`
 * (silent on radius) would leave every corner square, and the bug would look
 * like it belonged to `light`.
 *
 * Removing rather than resetting is the point: styles.css's :root block is the
 * one source of default values, so a cleared token falls back to it instead of
 * to a second copy of the defaults maintained over here.
 */
function applyThemeVars(theme) {
  if (!theme) return;
  const root = document.documentElement;
  const vars = theme.vars || {};

  for (const k of appliedTokens) {
    if (!(k in vars)) root.style.removeProperty(k);
  }
  for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);
  appliedTokens = Object.keys(vars);

  if (theme.terminal && typeof theme.terminal === 'object') {
    applyTerminalTheme(theme.terminal);
  }
}

/** Switches language: static labels, then everything held in module state. */
function applyLang(lang) {
  window.i18n.setLang(lang);
  window.i18n.applyStatic();
  emitLangChange();
}

/** Repaints the language select from the live i18n state. */
function renderLangSwitcher() {
  if (!els) return;
  els.langSwitcher.value = window.i18n.lang;
}

/** Rebuilds the theme select's options and repaints it from module state. */
function renderThemeSwitcher() {
  if (!els || !activeThemeId) return;
  els.themeSwitcher.innerHTML = '';
  for (const th of themesById.values()) {
    const opt = document.createElement('option');
    opt.value = th.id;
    opt.textContent = th.label;
    els.themeSwitcher.appendChild(opt);
  }
  els.themeSwitcher.value = activeThemeId;
}

/**
 * Rebuilds the layout select from layout.js's state (C1).
 *
 * No local mirror of the active id: unlike the theme, a layout can also change
 * from the console (__luna.layout) or be corrected at startup when the
 * remembered preset no longer exists, so the single source of truth is
 * getActiveLayoutId(). Labels are localized, hence the repaint on langChange.
 */
function renderLayoutSwitcher() {
  if (!els) return;
  const layouts = getLayouts();
  els.layoutSwitcher.innerHTML = '';
  for (const l of layouts) {
    const opt = document.createElement('option');
    opt.value = l.id;
    opt.textContent = loc(l.label);
    els.layoutSwitcher.appendChild(opt);
  }
  const active = getActiveLayoutId();
  if (active) els.layoutSwitcher.value = active;
}

/** Repaints the sound controls (toggle, volume, keystroke variant) from module state. */
function renderSoundSwitcher() {
  if (!els) return;
  els.soundToggle.checked = soundPrefs.enabled;
  els.soundVolume.value = soundPrefs.volume;
  els.soundKeystrokeVariant.value = soundPrefs.keystrokeVariant;
  els.soundLongTaskMinutes.value = soundPrefs.longTaskMinutes;
  els.soundReadOutputToggle.checked = soundPrefs.readOutputEnabled;
}

/** Ids of every loaded theme, for the console hook and the probe. */
export function getThemeIds() {
  return [...themesById.keys()];
}

/**
 * Switches theme from outside the widget (console hook, --luna-probe).
 *
 * Goes through the same path the select does, including the repaint, so a theme
 * chosen this way cannot leave the switcher showing the previous one. Does NOT
 * persist: this is a look-at-it tool, and the probe cycling all nine themes
 * should not end up rewriting Mati's saved choice.
 */
export function selectTheme(id) {
  if (!themesById.has(id)) return false;
  activeThemeId = id;
  applyThemeVars(themesById.get(id));
  renderThemeSwitcher();
  return true;
}

export async function initAppearance() {
  let prefs = {
    theme: 'cyberpunk',
    lang: 'pl',
    boot: true,
    soundEnabled: true,
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

  // Language first, so applyStatic catches the whole DOM on startup.
  applyLang(prefs.lang);
  renderLangSwitcher();
  // The widget already mounted (initLayout runs first), so its layout options
  // were built in the authored language - relabel them now that we know better.
  renderLayoutSwitcher();

  soundPrefs = {
    enabled: prefs.soundEnabled !== false,
    volume: typeof prefs.soundVolume === 'number' ? prefs.soundVolume : 70,
    keystrokeVariant: prefs.soundKeystrokeVariant || 'mechanical',
    longTaskMinutes:
      typeof prefs.soundLongTaskMinutes === 'number' ? prefs.soundLongTaskMinutes : 10,
    readOutputEnabled: prefs.soundReadOutputEnabled === true,
  };
  setKeystrokeVariant(soundPrefs.keystrokeVariant);
  renderSoundSwitcher();

  // Themes: fill the list and apply the active one (or the first available).
  try {
    const { themes } = await window.lunacore.getThemes();
    themesById = new Map((themes || []).map((th) => [th.id, th]));
    const active = themesById.has(prefs.theme)
      ? prefs.theme
      : themes && themes[0] && themes[0].id;
    if (active) {
      activeThemeId = active;
      renderThemeSwitcher();
      applyThemeVars(themesById.get(active));
    }
  } catch {
    /* no themes - the built-in styles.css look stays */
  }

  // Last, because the sequence should already know the language and the colours
  // of the chosen theme - nothing should jump mid-animation.
  startBoot(prefs.boot !== false);
}

defineWidget({
  id: 'appearance',
  titleKey: 'appearance.title',
  template: 'w-appearance',
  mount(root) {
    els = {
      themeSwitcher: root.querySelector('#theme-switcher'),
      layoutSwitcher: root.querySelector('#layout-switcher'),
      langSwitcher: root.querySelector('#lang-switcher'),
      soundToggle: root.querySelector('#sound-toggle'),
      soundVolume: root.querySelector('#sound-volume'),
      soundKeystrokeVariant: root.querySelector('#sound-keystroke-variant'),
      soundLongTaskMinutes: root.querySelector('#sound-long-task-minutes'),
      soundReadOutputToggle: root.querySelector('#sound-read-output-toggle'),
    };

    // Repaint from module state - initAppearance() only runs once at launch,
    // a remount must not fall back to the template's authored defaults.
    renderLangSwitcher();
    renderThemeSwitcher();
    renderLayoutSwitcher();
    renderSoundSwitcher();

    els.themeSwitcher.addEventListener('change', () => {
      sfx.modeToggle();
      activeThemeId = els.themeSwitcher.value;
      applyThemeVars(themesById.get(activeThemeId));
      window.lunacore.setUiPrefs({ theme: activeThemeId });
    });

    // C1. Two things to know about this one handler:
    //   * selectLayout() MOVES this very widget's root into the new region while
    //     this listener is on the stack. That is safe precisely because it is a
    //     DOM move, not a remount - the element, its listeners and `els` all
    //     survive (see modules/layout.js).
    //   * on a preset this widget is not part of we could never come back, which
    //     is why src/layouts.js rejects any layout that fails to place it.
    els.layoutSwitcher.addEventListener('change', () => {
      if (!selectLayout(els.layoutSwitcher.value)) renderLayoutSwitcher();
    });

    els.langSwitcher.addEventListener('change', () => {
      sfx.modeToggle();
      applyLang(els.langSwitcher.value);
      window.lunacore.setUiPrefs({ lang: els.langSwitcher.value });
      // Layout labels are localized, unlike the theme labels above.
      renderLayoutSwitcher();
    });

    els.soundToggle.addEventListener('change', () => {
      soundPrefs.enabled = els.soundToggle.checked;
      window.lunacore.setUiPrefs({ soundEnabled: soundPrefs.enabled });
    });

    els.soundVolume.addEventListener('change', () => {
      soundPrefs.volume = Number(els.soundVolume.value);
      window.lunacore.setUiPrefs({ soundVolume: soundPrefs.volume });
    });

    els.soundKeystrokeVariant.addEventListener('change', () => {
      soundPrefs.keystrokeVariant = els.soundKeystrokeVariant.value;
      setKeystrokeVariant(soundPrefs.keystrokeVariant);
      window.lunacore.setUiPrefs({ soundKeystrokeVariant: soundPrefs.keystrokeVariant });
      // Audition-by-ear: hear the clip you just picked, not just its label.
      sfx.keystroke();
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

    const offBoot = mountBoot(root);
    // D5. Same one-root-two-owners shape as boot above; see modules/update.js
    // for why the update notice lives in THIS widget and not one of its own.
    const offUpdate = mountUpdate(root);

    return () => {
      offBoot();
      offUpdate();
      els = null;
    };
  },
});
