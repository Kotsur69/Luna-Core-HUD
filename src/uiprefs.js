// ============================================================================
// LunaCore - UI preferences (theme + language + boot sequence + last profile)
// ----------------------------------------------------------------------------
// Small persistent slice of interface state in config/ui.local.json (gitignored)
// - like the scratchpad, a plain file rather than localStorage. Holds
// { theme, lang, boot, profile, layout, hideSystemPorts, soundEnabled,
// voiceEnabled, voiceDuckingEnabled,
// soundVolume, soundKeystrokeVariant, soundLongTaskMinutes, notificationsEnabled,
// autoCompactMode, autoCompactEveryTurns, autoCompactAfterMinutes,
// termFontFamily, termFontSize, termLineHeight, termLetterSpacing, termCursorStyle,
// termCursorBlink, termScrollback, termBgOpacity, termBgBlur, termBgImage,
// collapsed, layoutSizes, widgetSlots, railedRegions, density, fontPack, glow,
// motion.
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
// Feature #4: what an ARMED auto-compact watches. 'context' = the original 85%
// context-window threshold; 'turns' = every N completed turns on the active
// tab; 'time' = N minutes since the last compact, gated by context also being
// past 60%. The arm TOGGLE itself is per-session (autocompact.js module state),
// never persisted - only the mode + its N/M live here.
const AUTO_COMPACT_MODES = ['context', 'turns', 'time'];
// v0.10 modifiers: four axes that multiply across every theme rather than
// adding to them. Ids only - the VALUES they stand for (multipliers, font
// stacks, blur radii, durations) live in the [data-*] blocks in
// renderer/styles.css, which is the only place that should know them. Main has
// no business holding a second copy of a number it cannot apply.
const DENSITIES = ['comfortable', 'cozy', 'compact', 'dense'];
const FONT_PACKS = ['theme', 'mono', 'display', 'system'];
const GLOW_LEVELS = ['full', 'reduced', 'off'];
const MOTION_LEVELS = ['full', 'reduced', 'off'];

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
  // Feature #4: which signal an ARMED auto-compact fires on. 'context' = the
  // original 85% context-window threshold; 'turns' = every N completed turns on
  // the active tab; 'time' = N minutes since the last compact, but only once
  // context is also past 60% so a near-empty idle session is left alone. The
  // arm toggle itself stays per-session (autocompact.js), not stored here.
  autoCompactMode: 'context',
  autoCompactEveryTurns: 20,
  autoCompactAfterMinutes: 30,
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
  // v0.10 3.4 collapse-to-rail: layoutId -> [regionName], the regions the user
  // has folded down to a strip of glyphs in that preset. Per layout for the
  // same reason as layoutSizes and widgetSlots - a region name belongs to the
  // preset that defines it.
  //
  // Deliberately NOT stored as widths. layoutSizes always holds the UNRAILED
  // columns and panels.js derives the narrow track from this list at apply
  // time, so un-railing restores exactly the width the user had dragged to
  // rather than an approximation of it, and a rail can never be mistaken for a
  // deliberately narrow panel.
  railedRegions: {},
  // v0.10 4.2 layout builder: layoutId -> a full layout spec the user saved,
  // in exactly the shape config/layouts.json uses. Merged in by loadLayouts()
  // as a third source after base and layouts.local.json, so a custom layout is
  // validated by the same normalizeLayout() as a shipped preset and an id that
  // collides with one overrides it.
  //
  // Stored whole rather than as a diff against a preset. A diff would have to
  // be re-based every time the preset it derives from changes, and a saved
  // layout is the one thing in this file the user expects to stay exactly as
  // they left it.
  customLayouts: {},
  // v0.10 modifiers. Every default is the no-op value, i.e. exactly what the
  // HUD did before the axes existed: `cozy` IS the :root scale, `theme` means
  // the theme keeps choosing its own faces, and `full` glow/motion is the
  // unmodified look. An existing install therefore reads identically to how it
  // rendered yesterday, and modifiers.js writes no attribute at all for these.
  //
  // `motion` is NOT the OS prefers-reduced-motion setting and does not shadow
  // it: the OS switch is an accessibility declaration and still wins outright
  // (see the media block in styles.css). This one is a taste/perf preference.
  density: 'cozy',
  fontPack: 'theme',
  glow: 'full',
  motion: 'full',
};

const MAX_COLLAPSED = 64;
const MAX_LAYOUT_SIZES = 32;
// A layout has a handful of regions and a few dozen widgets; these caps only
// exist so a hand-edited or corrupt file cannot make the renderer chew on a
// pathological structure.
const MAX_ARRANGED_LAYOUTS = 32;
const MAX_ARRANGE_REGIONS = 16;
const MAX_ARRANGE_IDS = 64;
/** Regions one preset may have collapsed to a rail at once. A layout with more
 *  than a dozen regions is not a layout; this caps a hand-edited file. */
const MAX_RAILED_REGIONS = 16;
// A saved layout is a handful of rows over a handful of columns. These bound a
// hand-edited or corrupt file, nothing more - the semantic rules (rows of equal
// width, `terminal` and `appearance` placed, no widget in two slots) belong to
// normalizeLayout() and are applied when the layout is loaded, not stored.
const MAX_CUSTOM_LAYOUTS = 16;
const MAX_AREA_ROWS = 12;

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
 * Sanitizes the v0.10 rail state: { layoutId -> [regionName] }.
 *
 * A region name this preset does not actually define is deliberately NOT
 * filtered here. panels.js resolves every name against the live layout's
 * `areas` and simply finds no column for a stale one, which is the safer place
 * for that check: this module has no idea which regions exist, and guessing
 * would silently drop a rail the moment layouts.json was read a beat later
 * than the prefs file.
 */
function cleanRailedRegions(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ...DEFAULTS.railedRegions };
  const out = {};
  for (const [layoutId, names] of Object.entries(raw)) {
    if (!isIdish(layoutId) || !Array.isArray(names)) continue;
    const list = [];
    for (const name of names) {
      if (!isIdish(name) || list.includes(name)) continue;
      list.push(name);
      if (list.length >= MAX_RAILED_REGIONS) break;
    }
    // An empty list means the same thing as no entry at all - do not persist
    // noise that would grow one key per preset the user has ever opened.
    if (list.length) out[layoutId] = list;
    if (Object.keys(out).length >= MAX_ARRANGED_LAYOUTS) break;
  }
  return out;
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

/** One row of grid-template-areas: region names, plus CSS's "." null cell. */
function isAreaRow(v) {
  return typeof v === 'string' && v.trim().length > 0 && v.length <= 240 && /^[\w.\- ]+$/.test(v);
}

/** A layout label is a plain string or a { pl, en } pair - see src/localized.js. */
function cleanLayoutLabel(raw) {
  if (typeof raw === 'string') return raw.trim().slice(0, 64) || null;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = {};
  for (const lang of LANGS) {
    const v = raw[lang];
    if (typeof v === 'string' && v.trim()) out[lang] = v.trim().slice(0, 64);
  }
  return Object.keys(out).length ? out : null;
}

/**
 * Sanitizes saved layouts: { layoutId -> { label, grid, chrome, slots } }.
 *
 * Shape and size only. Whether a layout MEANS anything - every row of `areas`
 * naming the same number of columns, `terminal` and `appearance` actually
 * placed, no widget claimed by two slots - is normalizeLayout()'s call, made
 * when the layout is loaded rather than when it is written.
 *
 * Two reasons for that split. It is the single definition of a valid layout,
 * and half of it restated here would be half that drifts. And a spec it rejects
 * is simply absent from the list, which is the same outcome a bad entry gets
 * here - so the strict pass buys nothing by running earlier, while running it
 * at write time would let a layout saved against one version of the rules
 * become unloadable under the next.
 */
function cleanCustomLayouts(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ...DEFAULTS.customLayouts };
  const out = {};
  for (const [layoutId, spec] of Object.entries(raw)) {
    if (!isIdish(layoutId) || !spec || typeof spec !== 'object' || Array.isArray(spec)) continue;

    const grid = spec.grid;
    if (!grid || typeof grid !== 'object' || Array.isArray(grid)) continue;
    if (!isColumnsish(grid.columns) || !isColumnsish(grid.rows)) continue;
    if (!Array.isArray(grid.areas)) continue;

    const areas = [];
    for (const row of grid.areas) {
      if (!isAreaRow(row)) continue;
      areas.push(row.trim());
      if (areas.length >= MAX_AREA_ROWS) break;
    }
    if (!areas.length) continue;

    // Slots are the same structure cleanWidgetSlots already bounds, one layout
    // deep - reused rather than restated so both paths share one set of caps.
    const slots = cleanWidgetSlots({ [layoutId]: spec.slots })[layoutId];
    if (!slots) continue;

    const entry = {
      label: cleanLayoutLabel(spec.label) || layoutId,
      grid: { columns: grid.columns, rows: grid.rows, areas },
      slots,
    };

    // chrome is optional here exactly as it is in layouts.json: normalizeLayout()
    // defaults it to the first region that does not hold the terminal.
    const chrome = spec.chrome;
    if (chrome && typeof chrome === 'object' && !Array.isArray(chrome)) {
      const picked = {};
      if (isIdish(chrome.brand)) picked.brand = chrome.brand;
      if (isIdish(chrome.status)) picked.status = chrome.status;
      if (Object.keys(picked).length) entry.chrome = picked;
    }

    out[layoutId] = entry;
    if (Object.keys(out).length >= MAX_CUSTOM_LAYOUTS) break;
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

/**
 * Sanitizes the Feature #4 auto-compact trigger trio from a raw object (parsed
 * JSON, or a partial write payload). Every field is validated independently and
 * an out-of-range number clamps into range while a non-number falls back to its
 * default - same reject-and-repair boundary as clampTermPrefs above.
 * @returns {{autoCompactMode: string, autoCompactEveryTurns: number, autoCompactAfterMinutes: number}}
 */
function clampAutoCompactPrefs(raw) {
  const obj = raw && typeof raw === 'object' ? raw : {};
  const intIn = (v, min, max, fallback) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.round(n))) : fallback;
  };
  return {
    autoCompactMode: AUTO_COMPACT_MODES.includes(obj.autoCompactMode)
      ? obj.autoCompactMode
      : DEFAULTS.autoCompactMode,
    // 1..999 turns and 1..1440 minutes (a day): below 1 is meaningless (fire
    // every turn / every tick), above the cap is a hand-edit or a fat-finger.
    autoCompactEveryTurns: intIn(obj.autoCompactEveryTurns, 1, 999, DEFAULTS.autoCompactEveryTurns),
    autoCompactAfterMinutes: intIn(
      obj.autoCompactAfterMinutes,
      1,
      1440,
      DEFAULTS.autoCompactAfterMinutes
    ),
  };
}

/**
 * Sanitizes the v0.10 modifier axes: density, font pack, glow, motion.
 *
 * A pure whitelist per axis - the strictest of the three clamps in this file,
 * and deliberately so. The numbers these ids stand for live in styles.css; an
 * id that is not on the list has no block to match, so letting one through
 * would not produce a wrong look, it would produce the DEFAULT look while
 * ui.local.json and the Settings select both insist otherwise. Silent
 * disagreement between the file and the screen is the failure worth blocking.
 *
 * Every axis falls back independently: one bad id costs that axis, not all four.
 * @returns {{density: string, fontPack: string, glow: string, motion: string}}
 */
function clampModifierPrefs(raw) {
  const obj = raw && typeof raw === 'object' ? raw : {};
  const pick = (v, allowed, fallback) => (allowed.includes(v) ? v : fallback);
  return {
    density: pick(obj.density, DENSITIES, DEFAULTS.density),
    fontPack: pick(obj.fontPack, FONT_PACKS, DEFAULTS.fontPack),
    glow: pick(obj.glow, GLOW_LEVELS, DEFAULTS.glow),
    motion: pick(obj.motion, MOTION_LEVELS, DEFAULTS.motion),
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
      railedRegions: cleanRailedRegions(obj.railedRegions),
      customLayouts: cleanCustomLayouts(obj.customLayouts),
      ...clampAutoCompactPrefs(obj),
      ...clampTermPrefs(obj),
      ...clampModifierPrefs(obj),
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
 *   soundReadOutputEnabled?, autoCompactMode?, autoCompactEveryTurns?,
 *   autoCompactAfterMinutes?, termFontFamily?, termFontSize?, termLineHeight?,
 *   termLetterSpacing?, termCursorStyle?, termCursorBlink?, termScrollback?,
 *   termBgOpacity?, termBgBlur?, termBgImage?, collapsed?, layoutSizes?,
 *   widgetSlots?, density?, fontPack?, glow?, motion? }.
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
    // Feature #4: merge only the auto-compact keys actually present, then
    // re-validate the trio as a unit (same shape as the term* block below) -
    // `next` already holds validated values, so a garbage `partial` field can't
    // corrupt the file and an omitted one keeps its current value.
    const AC_KEYS = ['autoCompactMode', 'autoCompactEveryTurns', 'autoCompactAfterMinutes'];
    if (partial && AC_KEYS.some((k) => k in partial)) {
      const merged = {
        autoCompactMode: next.autoCompactMode,
        autoCompactEveryTurns: next.autoCompactEveryTurns,
        autoCompactAfterMinutes: next.autoCompactAfterMinutes,
      };
      for (const key of AC_KEYS) {
        if (key in partial) merged[key] = partial[key];
      }
      Object.assign(next, clampAutoCompactPrefs(merged));
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
    if (partial && partial.railedRegions && typeof partial.railedRegions === 'object') {
      next.railedRegions = cleanRailedRegions(partial.railedRegions);
    }
    // Whole map, same as the three above: the builder holds every saved layout
    // and writes all of them, which is what makes deleting one expressible.
    if (partial && partial.customLayouts && typeof partial.customLayouts === 'object') {
      next.customLayouts = cleanCustomLayouts(partial.customLayouts);
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
    // v0.10 modifiers: same merge-then-revalidate shape as the two blocks above.
    // Each axis is independent, so a partial write ({ glow: 'off' }) must not
    // reset the other three to their defaults.
    const MOD_KEYS = ['density', 'fontPack', 'glow', 'motion'];
    const mergedMods = {
      density: next.density,
      fontPack: next.fontPack,
      glow: next.glow,
      motion: next.motion,
    };
    if (partial) {
      for (const key of MOD_KEYS) {
        if (key in partial) mergedMods[key] = partial[key];
      }
    }
    Object.assign(next, clampModifierPrefs(mergedMods));
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
  clampAutoCompactPrefs,
  clampModifierPrefs,
  cleanCollapsed,
  cleanLayoutSizes,
  cleanWidgetSlots,
  cleanRailedRegions,
  cleanCustomLayouts,
};
