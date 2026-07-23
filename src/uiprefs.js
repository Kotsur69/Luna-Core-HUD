// ============================================================================
// LunaCore - Preferencje UI (motyw + jezyk + sekwencja startowa)
// ----------------------------------------------------------------------------
// Trwaly, drobny stan interfejsu w config/ui.local.json (gitignore) - jak
// brudnopis, zwykly plik zamiast localStorage. Trzyma { theme, lang, boot }.
// Renderer czyta na starcie (ui:get) i zapisuje przy zmianie (ui:set).
//
// Walidacja na granicy: nieznany jezyk => domyslny 'pl'; brak pliku => DEFAULTS.
// ============================================================================

'use strict';

const fs = require('fs');
const path = require('path');

const CONFIG_DIR = path.join(__dirname, '..', 'config');
const FILE = path.join(CONFIG_DIR, 'ui.local.json');

const LANGS = ['pl', 'en'];
const DEFAULTS = { theme: 'cyberpunk', lang: 'pl', boot: true };

/** Czyta preferencje UI; brak/uszkodzony plik => DEFAULTS. */
function readUiPrefs() {
  try {
    const obj = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return {
      theme: typeof obj.theme === 'string' && obj.theme ? obj.theme : DEFAULTS.theme,
      lang: LANGS.includes(obj.lang) ? obj.lang : DEFAULTS.lang,
      // Brak klucza => wlaczona (plik prefs zapisany przed ta opcja).
      boot: typeof obj.boot === 'boolean' ? obj.boot : DEFAULTS.boot,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

/**
 * Scala i zapisuje preferencje. Przyjmuje czesciowy obiekt { theme?, lang?, boot? }.
 * @returns {{theme:string,lang:string,boot:boolean}|null} nowy stan lub null przy bledzie zapisu
 */
function writeUiPrefs(partial) {
  try {
    const next = readUiPrefs();
    if (partial && typeof partial.theme === 'string' && partial.theme) next.theme = partial.theme;
    if (partial && LANGS.includes(partial.lang)) next.lang = partial.lang;
    if (partial && typeof partial.boot === 'boolean') next.boot = partial.boot;
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(next, null, 2) + '\n', 'utf8');
    return next;
  } catch {
    return null;
  }
}

module.exports = { readUiPrefs, writeUiPrefs };
