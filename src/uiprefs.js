// ============================================================================
// LunaCore - UI preferences (theme + language + boot sequence + last profile)
// ----------------------------------------------------------------------------
// Small persistent slice of interface state in config/ui.local.json (gitignored)
// - like the scratchpad, a plain file rather than localStorage. Holds
// { theme, lang, boot, profile, layout, hideSystemPorts, soundEnabled,
// voiceEnabled, voiceDuckingEnabled,
// soundVolume, soundKeystrokeVariant, soundLongTaskMinutes, notificationsEnabled,
// termFontFamily, termFontSize, termLineHeight, termLetterSpacing, termCursorStyle,
// termCursorBlink, termScrollback, termBgOpacity, termBgBlur, termBgImage,
// collapsed, layoutSizes, widgetSlots.
// The renderer
// reads it at startup (ui:get) and writes on change (ui:set).
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
const TERM_CURSOR_STYLES = ['block', 'underline', 'bar'];

function clampVolume(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : 70;
}
// 0 is a valid, deliberate value (announce on every turn end); only reject
// non-numbers and negatives.
function clampLongTaskMinutes(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : 10;
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
  // Separate from soundEnabled: mutes only "Luna talking" (voice.* canned
  // clips - welcome/needYou/done/usage50/usage80 - plus live read-aloud
  // narration) while sfx.* (keystrokes, nav clicks, tab open/close) keeps
  // playing. Mati asked for this specifically - the two were previously one
  // shared on/off switch. Default true so existing installs stay unchanged.
  voiceEnabled: true,
  // Auto-pause the now-playing media (Spotify, a browser tab, a podcast app -
  // anything GSMTC controls) for the duration of the SAPI read-aloud
  // narration, then resume it. Narration only. Default OFF: it reaches
  // outside the HUD and moves another app's playback, so - like
  // soundReadOutputEnabled and notificationsEnabled - it must be opted into,
  // never a surprise. See src/voiceduck.js.
  voiceDuckingEnabled: false,
  soundVolume: 70,
  soundKeystrokeVariant: 'mechanical',
  // §11.1: minimum turn duration (minutes) before the "All done" voice line
  // fires on turn-end. 10 matches Mati's own example ("like 10 mins Claude
  // cogitated") - a quick back-and-forth should stay silent.
  soundLongTaskMinutes: 10,
  // §11.2: read Claude's actual output aloud via Windows SAPI on turn-end.
  // Default OFF - unlike the other sound prefs this narrates arbitrary,
  // potentially long/sensitive text, so it must never surprise-narrate a
  // room; Mati opts in explicitly from the Appearance panel.
  soundReadOutputEnabled: false,
  // Terminal Appearance Customizer (TERMINAL_CUSTOMIZER_PLAN.md). Global, not
  // per-tab/per-profile - confirmed 2026-08-13, matches how theme/sound prefs
  // already behave app-wide.
  termFontFamily: 'Cascadia Code, Consolas, "Courier New", monospace',
  termFontSize: 14,
  termLineHeight: 1.0,
  termLetterSpacing: 0,
  termCursorStyle: 'block',
  termCursorBlink: true,
  termScrollback: 5000,
  termBgOpacity: 100, // percent, 0-100
  termBgBlur: 0, // px, 0-20
  // data: URI (renderer's CSP only allows 'self'/data: for img-src, so a raw
  // file path could never be used as a CSS background-image). null = none.
  termBgImage: null,
  // Clipboard history widget. Default OFF, and for a stronger reason than
  // soundReadOutputEnabled's: enabling it makes LunaCore read every text clip
  // copied anywhere on the machine and persist it to disk. See src/clipboard.js's
  // header - an app whose promise is "I only read what the README lists" has no
  // business watching the clipboard until asked.
  clipboardEnabled: false,
  // OS toast when a session goes busy->idle or crosses 85% context. Off by
  // default, same reasoning as soundReadOutputEnabled above: an unexpected
  // desktop popup is a worse surprise than a quiet HUD, so this is opt-in.
  notificationsEnabled: false,
  // C2 collapsible panels: ids of the widgets whose section is folded shut.
  // A list rather than a map of booleans so an id that no longer exists simply
  // stops matching anything instead of accumulating dead `false` entries.
  //
  // The first-run value is the whole LEFT rail of the `classic` layout. That
  // rail is a drawer of things you open deliberately - actions, the appearance
  // and project and profile switchers, the cheatsheets, the prompt library,
  // three hundred-odd skills. Unfolded all at once it is a wall of headings,
  // and folding six of them away by hand is the first thing anyone does. So the
  // HUD ships tidy and each person opens the two or three they actually use.
  //
  // The RIGHT rail is deliberately absent: it is the live readout (context
  // window, usage, telemetry), and shipping that folded would gut the point of
  // a HUD. Like `lang` above, this is only the FIRST-RUN value - cleanCollapsed
  // returns a stored list untouched, including an empty one, so nobody who has
  // arranged their own panels ever gets re-folded.
  collapsed: ['actions', 'appearance', 'project', 'profile', 'cheatsheets', 'prompts', 'skills'],
  // C2 resizable panels: layoutId -> the `grid-template-columns` the user
  // dragged that preset to. Per layout because the presets have different
  // column counts, and a width dragged in `classic` means nothing in `focus`.
  layoutSizes: {},
  // C4 drag-a-widget-between-regions: layoutId -> { region -> [widgetId] }, the
  // arrangement the user dragged that preset into. Per layout for the same
  // reason as layoutSizes - a preset's regions are its own. Merged back over
  // the preset (and healed) by renderer/modules/widgetarrange.js; `terminal` is
  // never stored here. Empty = every preset in its authored arrangement.
  widgetSlots: {},
};

const MAX_COLLAPSED = 64;
const MAX_LAYOUT_SIZES = 32;
// A layout has a handful of regions and a few dozen widgets; these caps only
// exist so a hand-edited or corrupt file cannot make the renderer chew on a
// pathological structure.
const MAX_ARRANGED_LAYOUTS = 32;
const MAX_ARRANGE_REGIONS = 16;
const MAX_ARRANGE_IDS = 64;

/**
 * Shape check for a stored columns string. Deliberately coarse: this is the
 * "don't persist a novel" gate, while the strict track grammar that decides
 * what may actually be written into an inline style lives in
 * renderer/modules/panels.js (isSafeColumns) - the place that does the writing.
 */
function isColumnsish(v) {
  return typeof v === 'string' && v.length > 0 && v.length <= 120 && /^[\d a-z.%]+$/i.test(v);
}

function cleanCollapsed(raw) {
  if (!Array.isArray(raw)) return [...DEFAULTS.collapsed];
  const out = [];
  for (const id of raw) {
    if (typeof id !== 'string' || !id || id.length > 64) continue;
    if (!out.includes(id)) out.push(id);
    if (out.length >= MAX_COLLAPSED) break;
  }
  return out;
}

function cleanLayoutSizes(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ...DEFAULTS.layoutSizes };
  const out = {};
  for (const [id, cols] of Object.entries(raw)) {
    if (!id || id.length > 64 || !isColumnsish(cols)) continue;
    out[id] = cols;
    if (Object.keys(out).length >= MAX_LAYOUT_SIZES) break;
  }
  return out;
}

function isIdish(v) {
  return typeof v === 'string' && v.length > 0 && v.length <= 64;
}

/**
 * Sanitizes a stored C4 arrangement: { layoutId -> { region -> [widgetId] } }.
 * Same reject-don't-repair boundary as the rest of this file - a garbage entry
 * is dropped, not patched. widgetarrange.js re-validates against the live
 * preset on top of this (an id the preset no longer places is filtered there),
 * so this pass only has to guarantee shape and bound size.
 */
function cleanWidgetSlots(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ...DEFAULTS.widgetSlots };
  const out = {};
  for (const [layoutId, regions] of Object.entries(raw)) {
    if (!isIdish(layoutId) || !regions || typeof regions !== 'object' || Array.isArray(regions)) {
      continue;
    }
    const cleanRegions = {};
    const seen = new Set();
    for (const [region, ids] of Object.entries(regions)) {
      if (!isIdish(region) || !Array.isArray(ids)) continue;
      const list = [];
      for (const id of ids) {
        if (!isIdish(id) || seen.has(id)) continue;
        seen.add(id);
        list.push(id);
        if (list.length >= MAX_ARRANGE_IDS) break;
      }
      if (list.length) cleanRegions[region] = list;
      if (Object.keys(cleanRegions).length >= MAX_ARRANGE_REGIONS) break;
    }
    if (Object.keys(cleanRegions).length) out[layoutId] = cleanRegions;
    if (Object.keys(out).length >= MAX_ARRANGED_LAYOUTS) break;
  }
  return out;
}

/**
 * Sanitizes a raw terminal-appearance prefs object (e.g. parsed from JSON, or
 * a partial write payload). Every field is validated independently and falls
 * back to DEFAULTS on a missing/wrong-typed/out-of-range value, so a garbage
 * or partial input always yields a fully-populated, safe-to-apply result.
 */
function clampTermPrefs(raw) {
  const obj = raw && typeof raw === 'object' ? raw : {};
  const num = (v, min, max, fallback) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
  };
  return {
    termFontFamily:
      typeof obj.termFontFamily === 'string' && obj.termFontFamily.trim()
        ? obj.termFontFamily
        : DEFAULTS.termFontFamily,
    termFontSize: Math.round(num(obj.termFontSize, 8, 32, DEFAULTS.termFontSize)),
    termLineHeight: num(obj.termLineHeight, 0.8, 3, DEFAULTS.termLineHeight),
    termLetterSpacing: num(obj.termLetterSpacing, -5, 20, DEFAULTS.termLetterSpacing),
    termCursorStyle: TERM_CURSOR_STYLES.includes(obj.termCursorStyle)
      ? obj.termCursorStyle
      : DEFAULTS.termCursorStyle,
    termCursorBlink:
      typeof obj.termCursorBlink === 'boolean' ? obj.termCursorBlink : DEFAULTS.termCursorBlink,
    termScrollback: Math.round(num(obj.termScrollback, 0, 1000000, DEFAULTS.termScrollback)),
    termBgOpacity: Math.round(num(obj.termBgOpacity, 0, 100, DEFAULTS.termBgOpacity)),
    termBgBlur: Math.round(num(obj.termBgBlur, 0, 20, DEFAULTS.termBgBlur)),
    termBgImage:
      typeof obj.termBgImage === 'string' && obj.termBgImage.startsWith('data:image/')
        ? obj.termBgImage
        : null,
  };
}

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
      voiceEnabled: typeof obj.voiceEnabled === 'boolean' ? obj.voiceEnabled : DEFAULTS.voiceEnabled,
      // Missing key => disabled (prefs file written before this option existed).
      voiceDuckingEnabled:
        typeof obj.voiceDuckingEnabled === 'boolean'
          ? obj.voiceDuckingEnabled
          : DEFAULTS.voiceDuckingEnabled,
      soundVolume: typeof obj.soundVolume === 'number' ? clampVolume(obj.soundVolume) : DEFAULTS.soundVolume,
      soundKeystrokeVariant:
        typeof obj.soundKeystrokeVariant === 'string' &&
        KEYSTROKE_VARIANT_IDS.includes(obj.soundKeystrokeVariant)
          ? obj.soundKeystrokeVariant
          : DEFAULTS.soundKeystrokeVariant,
      soundLongTaskMinutes:
        typeof obj.soundLongTaskMinutes === 'number'
          ? clampLongTaskMinutes(obj.soundLongTaskMinutes)
          : DEFAULTS.soundLongTaskMinutes,
      soundReadOutputEnabled:
        typeof obj.soundReadOutputEnabled === 'boolean'
          ? obj.soundReadOutputEnabled
          : DEFAULTS.soundReadOutputEnabled,
      // Missing key => disabled (prefs file written before this option existed).
      clipboardEnabled:
        typeof obj.clipboardEnabled === 'boolean' ? obj.clipboardEnabled : DEFAULTS.clipboardEnabled,
      // Missing key => disabled (prefs file written before this option existed).
      notificationsEnabled:
        typeof obj.notificationsEnabled === 'boolean'
          ? obj.notificationsEnabled
          : DEFAULTS.notificationsEnabled,
      // Missing keys => nothing folded, every preset at its authored widths and
      // authored arrangement.
      collapsed: cleanCollapsed(obj.collapsed),
      layoutSizes: cleanLayoutSizes(obj.layoutSizes),
      widgetSlots: cleanWidgetSlots(obj.widgetSlots),
      ...clampTermPrefs(obj),
    };
  } catch {
    return { ...DEFAULTS };
  }
}

/**
 * Merges and writes preferences. Accepts a partial
 * { theme?, lang?, boot?, profile?, layout?, hideSystemPorts?, soundEnabled?,
 *   voiceEnabled?, voiceDuckingEnabled?,
 *   soundVolume?, soundKeystrokeVariant?, soundLongTaskMinutes?,
 *   soundReadOutputEnabled?, termFontFamily?, termFontSize?, termLineHeight?,
 *   termLetterSpacing?, termCursorStyle?, termCursorBlink?, termScrollback?,
 *   termBgOpacity?, termBgBlur?, termBgImage?, collapsed?, layoutSizes?,
 *   widgetSlots? }.
 * @returns {object|null} the new state, or null if the write failed
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
    if (partial && typeof partial.voiceEnabled === 'boolean') next.voiceEnabled = partial.voiceEnabled;
    if (partial && typeof partial.voiceDuckingEnabled === 'boolean') {
      next.voiceDuckingEnabled = partial.voiceDuckingEnabled;
    }
    if (partial && typeof partial.soundVolume === 'number') next.soundVolume = clampVolume(partial.soundVolume);
    if (
      partial &&
      typeof partial.soundKeystrokeVariant === 'string' &&
      KEYSTROKE_VARIANT_IDS.includes(partial.soundKeystrokeVariant)
    ) {
      next.soundKeystrokeVariant = partial.soundKeystrokeVariant;
    }
    if (partial && typeof partial.soundLongTaskMinutes === 'number') {
      next.soundLongTaskMinutes = clampLongTaskMinutes(partial.soundLongTaskMinutes);
    }
    if (partial && typeof partial.soundReadOutputEnabled === 'boolean') {
      next.soundReadOutputEnabled = partial.soundReadOutputEnabled;
    }
    if (partial && typeof partial.clipboardEnabled === 'boolean') {
      next.clipboardEnabled = partial.clipboardEnabled;
    }
    if (partial && typeof partial.notificationsEnabled === 'boolean') {
      next.notificationsEnabled = partial.notificationsEnabled;
    }
    // Both are sent WHOLE, not merged per entry: the renderer holds the live
    // set/map and writes all of it. Merging here instead would make an unfolded
    // panel or a reset width impossible to express.
    if (partial && Array.isArray(partial.collapsed)) {
      next.collapsed = cleanCollapsed(partial.collapsed);
    }
    if (partial && partial.layoutSizes && typeof partial.layoutSizes === 'object') {
      next.layoutSizes = cleanLayoutSizes(partial.layoutSizes);
    }
    if (partial && partial.widgetSlots && typeof partial.widgetSlots === 'object') {
      next.widgetSlots = cleanWidgetSlots(partial.widgetSlots);
    }
    // Only the term* keys actually present in `partial` should move; anything
    // omitted keeps its current (already-validated) value from `next` rather
    // than reverting to DEFAULTS - clampTermPrefs still re-validates the
    // merged result, so a garbage value in `partial` can't corrupt the file.
    const TERM_KEYS = [
      'termFontFamily',
      'termFontSize',
      'termLineHeight',
      'termLetterSpacing',
      'termCursorStyle',
      'termCursorBlink',
      'termScrollback',
      'termBgOpacity',
      'termBgBlur',
      'termBgImage',
    ];
    const mergedTerm = { ...next };
    if (partial) {
      for (const key of TERM_KEYS) {
        if (key in partial) mergedTerm[key] = partial[key];
      }
    }
    Object.assign(next, clampTermPrefs(mergedTerm));
    paths.ensureUserDir();
    fs.writeFileSync(file(), JSON.stringify(next, null, 2) + '\n', 'utf8');
    return next;
  } catch {
    return null;
  }
}

module.exports = {
  readUiPrefs,
  writeUiPrefs,
  clampTermPrefs,
  cleanCollapsed,
  cleanLayoutSizes,
  cleanWidgetSlots,
};
