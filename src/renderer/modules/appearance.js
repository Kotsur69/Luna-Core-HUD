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

let themesById = new Map();
let activeThemeId = null;

// Elements of the current mount, or null when this widget is not on screen.
let els = null;

/** Puts a theme's tokens on :root and its palette on the terminals. */
function applyThemeVars(theme) {
  if (!theme) return;
  const root = document.documentElement;
  for (const [k, v] of Object.entries(theme.vars || {})) root.style.setProperty(k, v);
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

export async function initAppearance() {
  let prefs = { theme: 'cyberpunk', lang: 'pl', boot: true };
  try {
    prefs = (await window.lunacore.getUiPrefs()) || prefs;
  } catch {
    /* no preferences - stay on the defaults */
  }

  // Language first, so applyStatic catches the whole DOM on startup.
  applyLang(prefs.lang);
  renderLangSwitcher();

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
      langSwitcher: root.querySelector('#lang-switcher'),
    };

    // Repaint from module state - initAppearance() only runs once at launch,
    // a remount must not fall back to the template's authored defaults.
    renderLangSwitcher();
    renderThemeSwitcher();

    els.themeSwitcher.addEventListener('change', () => {
      activeThemeId = els.themeSwitcher.value;
      applyThemeVars(themesById.get(activeThemeId));
      window.lunacore.setUiPrefs({ theme: activeThemeId });
    });

    els.langSwitcher.addEventListener('change', () => {
      applyLang(els.langSwitcher.value);
      window.lunacore.setUiPrefs({ lang: els.langSwitcher.value });
    });

    const offBoot = mountBoot(root);

    return () => {
      offBoot();
      els = null;
    };
  },
});
