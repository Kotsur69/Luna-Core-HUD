// ============================================================================
// LunaCore - UI preferences (theme + language + boot sequence + last profile)
// ----------------------------------------------------------------------------
// Small persistent slice of interface state in config/ui.local.json (gitignored)
// - like the scratchpad, a plain file rather than localStorage. Holds
// { theme, lang, boot, profile, layout, hideSystemPorts, soundEnabled,
// soundVolume, soundKeystrokeVariant }. The renderer reads it at startup
// (ui:get) and writes on change (ui:set).
//
// Validate at the boundary: an unknown language falls back to 'pl'; a missing
// file falls back to DEFAULTS.
// ============================================================================

'use strict';

const fs = require('fs');
const paths = require('./paths');

// Per-machine state, so it lives in the WRITABLE root - which in a dev clone is
// still the repo's config/, and in a packaged build is %APPDATA%/LunaCore/config
// (or the portable folder next to the .exe). Resolved on each call rather than
// captured at import time: this module is required before app.whenReady(), and
// app.getPath('userData') is not dependable that early.
const file = () => paths.local('ui.local.json');

const LANGS = ['pl', 'en'];
const KEYSTROKE_VARIANT_IDS = ['mechanical', 'soft', 'scifi', 'typewriter'];

function clampVolume(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : 70;
}
// profile: id of the last used launch profile (B1). null = no choice recorded,
// in which case activeProfile from config/profiles.json decides, as before.
// hideSystemPorts: B5 view toggle. Defaults to ON because the unfiltered list is
// mostly svchost - and the panel always prints how many rows it folded, so the
// filter can never hide something without saying so.
// layout: id of the last chosen layout preset (C1). null = no choice recorded,
// in which case activeLayout from config/layouts.json decides - same shape as
// `profile` above.
// lang: English is the default because LunaCore ships publicly (D3). This is
// only the FIRST-RUN value - once anyone picks a language it is remembered in
// ui.local.json, so switching the default cannot change an existing setup. It
// was 'pl' until 2026-08-05, which was invisible on a developer machine whose
// prefs file already recorded a choice, and would have handed every stranger a
// UI they could not read.
const DEFAULTS = {
  theme: 'cyberpunk',
  lang: 'en',
  boot: true,
  profile: null,
  layout: null,
  hideSystemPorts: true,
  soundEnabled: true,
  soundVolume: 70,
  soundKeystrokeVariant: 'mechanical',
};

/** Reads UI preferences; a missing or corrupt file falls back to DEFAULTS. */
function readUiPrefs() {
  try {
    const obj = JSON.parse(fs.readFileSync(file(), 'utf8'));
    return {
      theme: typeof obj.theme === 'string' && obj.theme ? obj.theme : DEFAULTS.theme,
      lang: LANGS.includes(obj.lang) ? obj.lang : DEFAULTS.lang,
      // Missing key => enabled (prefs file written before this option existed).
      boot: typeof obj.boot === 'boolean' ? obj.boot : DEFAULTS.boot,
      // An unknown profile id is filtered out later by main.js (getProfile);
      // here we only check the type.
      profile: typeof obj.profile === 'string' && obj.profile ? obj.profile : DEFAULTS.profile,
      // An unknown layout id is filtered out in the renderer (getLayout returns
      // null -> fall back to activeLayout); here we only check the type.
      layout: typeof obj.layout === 'string' && obj.layout ? obj.layout : DEFAULTS.layout,
      // Missing key => filtered (prefs file written before this option existed).
      hideSystemPorts:
        typeof obj.hideSystemPorts === 'boolean' ? obj.hideSystemPorts : DEFAULTS.hideSystemPorts,
      // Missing key => enabled (prefs file written before this option existed).
      soundEnabled: typeof obj.soundEnabled === 'boolean' ? obj.soundEnabled : DEFAULTS.soundEnabled,
      soundVolume: typeof obj.soundVolume === 'number' ? clampVolume(obj.soundVolume) : DEFAULTS.soundVolume,
      soundKeystrokeVariant:
        typeof obj.soundKeystrokeVariant === 'string' &&
        KEYSTROKE_VARIANT_IDS.includes(obj.soundKeystrokeVariant)
          ? obj.soundKeystrokeVariant
          : DEFAULTS.soundKeystrokeVariant,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

/**
 * Merges and writes preferences. Accepts a partial
 * { theme?, lang?, boot?, profile?, layout?, hideSystemPorts?, soundEnabled?,
 *   soundVolume?, soundKeystrokeVariant? }.
 * @returns {{theme:string,lang:string,boot:boolean,profile:string|null,
 *   layout:string|null,hideSystemPorts:boolean,soundEnabled:boolean,
 *   soundVolume:number,soundKeystrokeVariant:string}|null} the new state, or
 *   null if the write failed
 */
function writeUiPrefs(partial) {
  try {
    const next = readUiPrefs();
    if (partial && typeof partial.theme === 'string' && partial.theme) next.theme = partial.theme;
    if (partial && LANGS.includes(partial.lang)) next.lang = partial.lang;
    if (partial && typeof partial.boot === 'boolean') next.boot = partial.boot;
    if (partial && typeof partial.profile === 'string' && partial.profile) {
      next.profile = partial.profile;
    }
    if (partial && typeof partial.layout === 'string' && partial.layout) {
      next.layout = partial.layout;
    }
    if (partial && typeof partial.hideSystemPorts === 'boolean') {
      next.hideSystemPorts = partial.hideSystemPorts;
    }
    if (partial && typeof partial.soundEnabled === 'boolean') next.soundEnabled = partial.soundEnabled;
    if (partial && typeof partial.soundVolume === 'number') next.soundVolume = clampVolume(partial.soundVolume);
    if (
      partial &&
      typeof partial.soundKeystrokeVariant === 'string' &&
      KEYSTROKE_VARIANT_IDS.includes(partial.soundKeystrokeVariant)
    ) {
      next.soundKeystrokeVariant = partial.soundKeystrokeVariant;
    }
    paths.ensureUserDir();
    fs.writeFileSync(file(), JSON.stringify(next, null, 2) + '\n', 'utf8');
    return next;
  } catch {
    return null;
  }
}

module.exports = { readUiPrefs, writeUiPrefs };
