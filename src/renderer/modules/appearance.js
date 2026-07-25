// ============================================================================
// LunaCore - appearance: theme + language
// ----------------------------------------------------------------------------
// Themes come from config/themes.json (maps of CSS tokens + xterm colours), the
// language from the i18n.js dictionary. Both choices persist in
// config/ui.local.json. Switching works live: tokens go onto documentElement,
// xterm palettes through term.options, and the text through applyStatic() plus
// a language broadcast that has every module re-render its own dynamic strings.
// ============================================================================

'use strict';

import { emitLangChange } from './bus.js';
import { applyTerminalTheme } from './terminals.js';
import { startBoot } from './boot.js';

const themeSwitcher = document.getElementById('theme-switcher');
const langSwitcher = document.getElementById('lang-switcher');

let themesById = new Map();

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

export async function initAppearance() {
  let prefs = { theme: 'cyberpunk', lang: 'pl', boot: true };
  try {
    prefs = (await window.lunacore.getUiPrefs()) || prefs;
  } catch {
    /* no preferences - stay on the defaults */
  }

  // Language first, so applyStatic catches the whole DOM on startup.
  applyLang(prefs.lang);
  langSwitcher.value = prefs.lang;

  // Themes: fill the list and apply the active one (or the first available).
  try {
    const { themes } = await window.lunacore.getThemes();
    themesById = new Map((themes || []).map((th) => [th.id, th]));
    themeSwitcher.innerHTML = '';
    for (const th of themes || []) {
      const opt = document.createElement('option');
      opt.value = th.id;
      opt.textContent = th.label;
      themeSwitcher.appendChild(opt);
    }
    const active = themesById.has(prefs.theme)
      ? prefs.theme
      : themes && themes[0] && themes[0].id;
    if (active) {
      themeSwitcher.value = active;
      applyThemeVars(themesById.get(active));
    }
  } catch {
    /* no themes - the built-in styles.css look stays */
  }

  // Last, because the sequence should already know the language and the colours
  // of the chosen theme - nothing should jump mid-animation.
  startBoot(prefs.boot !== false);
}

themeSwitcher.addEventListener('change', () => {
  applyThemeVars(themesById.get(themeSwitcher.value));
  window.lunacore.setUiPrefs({ theme: themeSwitcher.value });
});

langSwitcher.addEventListener('change', () => {
  applyLang(langSwitcher.value);
  window.lunacore.setUiPrefs({ lang: langSwitcher.value });
});
