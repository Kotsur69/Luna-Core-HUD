// ============================================================================
// LunaCore - appearance modifiers (v0.10): density, font pack, glow, motion
// ----------------------------------------------------------------------------
// Four axes that MULTIPLY across every theme instead of adding to them. A theme
// is a look; a modifier is how you want that look served. Eighteen themes times
// four densities is not seventy-two presets to maintain - it is eighteen presets
// and four small token blocks in styles.css, and every future theme inherits all
// four for free. This is FUTURE_PLAN.md §2.3, finally buildable now that the
// space and type scales exist for density to multiply (v0.10 phase 1).
//
// This module owns exactly one thing: which id each axis is on. It deliberately
// does NOT know what the ids mean - no multipliers, no font stacks, no blur
// radii, no durations. Those live in the [data-*] blocks in styles.css, which is
// the only place that can apply them, and a second copy over here would be a
// second copy to keep in step. See test/modifiers.test.js: it reads both this
// table and that stylesheet and fails if an id has no block to match.
//
// Applied as data-* attributes on <html> rather than inline styles, and that is
// load-bearing: appearance.js's applyThemeVars() writes theme tokens inline and
// tracks which ones it wrote so it can remove them on the next switch. A
// modifier writing inline tokens would be invisible to that bookkeeping and get
// swept away by the next theme change. An attribute cannot collide with it.
//
// The DEFAULT value of an axis REMOVES its attribute instead of writing it, so a
// stock install carries no attributes at all and :root in styles.css is, by
// itself, the default of all four. Nothing to strip out later, and the DOM shows
// only what someone actually changed.
// ============================================================================

'use strict';

import { crossfade } from './motion.js';

/**
 * The axis table. `key` is the ui.local.json field (and the setModifier()
 * argument), `attr` the attribute on <html>, `values` the whitelist in the order
 * the Settings select lists them, `fallback` the value that means "unmodified".
 *
 * MUST stay in sync with src/uiprefs.js's DENSITIES/FONT_PACKS/GLOW_LEVELS/
 * MOTION_LEVELS and with the [data-*] blocks in styles.css - test/modifiers.test.js
 * checks this table against both, so neither copy can rot in silence.
 */
export const MODIFIER_AXES = [
  { key: 'density', attr: 'data-density', values: ['comfortable', 'cozy', 'compact', 'dense'], fallback: 'cozy' },
  { key: 'fontPack', attr: 'data-font-pack', values: ['theme', 'mono', 'display', 'system'], fallback: 'theme' },
  { key: 'glow', attr: 'data-glow', values: ['full', 'reduced', 'off'], fallback: 'full' },
  { key: 'motion', attr: 'data-motion', values: ['full', 'reduced', 'off'], fallback: 'full' },
];

/** The all-unmodified state - what the HUD looked like before v0.10. */
function defaults() {
  const out = {};
  for (const axis of MODIFIER_AXES) out[axis.key] = axis.fallback;
  return out;
}

// The live state, at module scope for the same reason appearance.js keeps
// activeThemeId there: the Settings overlay is repainted every time it opens,
// and it must repaint from truth rather than from the markup's first <option>.
let current = defaults();

/**
 * Picks the four modifier ids out of an arbitrary prefs object.
 *
 * Renderer-side mirror of uiprefs.js's clampModifierPrefs(): main validates what
 * it writes to disk, this validates what the renderer is handed over IPC. The
 * duplication is the same one termcustom.js already accepts for TERM_DEFAULTS -
 * the renderer has no access to a main-process module, only to what getUiPrefs()
 * returns - and here it is four whitelists rather than a set of numbers.
 *
 * Each axis falls back independently, so one unknown id costs that axis alone.
 * @param {object} prefs
 * @returns {{density: string, fontPack: string, glow: string, motion: string}}
 */
export function normalizeModifiers(prefs) {
  const obj = prefs && typeof prefs === 'object' ? prefs : {};
  const out = {};
  for (const axis of MODIFIER_AXES) {
    out[axis.key] = axis.values.includes(obj[axis.key]) ? obj[axis.key] : axis.fallback;
  }
  return out;
}

/**
 * Writes the axes onto an element as data-* attributes.
 *
 * Takes the element rather than reaching for document.documentElement so this
 * file holds no DOM reference at module scope and node --test can require() it
 * and hand it a stub - the same shape panels.js's pure half already has.
 *
 * @param {object} mods normalized axis ids (see normalizeModifiers)
 * @param {Element} [root] defaults to <html>, evaluated at call time
 */
export function applyModifiers(mods, root = document.documentElement) {
  if (!root) return;
  const next = normalizeModifiers(mods);
  for (const axis of MODIFIER_AXES) {
    // Default => remove. See the header: no attribute is the honest way to say
    // "unmodified", and it keeps the stock DOM clean.
    if (next[axis.key] === axis.fallback) root.removeAttribute(axis.attr);
    else root.setAttribute(axis.attr, next[axis.key]);
  }
  current = next;
}

/** The live axis ids, for repainting the Settings selects. */
export function getModifiers() {
  return { ...current };
}

/**
 * Changes one axis: apply, then persist. Returns false for an unknown axis or
 * value rather than writing a preference nothing can render.
 * @param {string} key one of MODIFIER_AXES' keys
 * @param {string} value one of that axis's values
 */
export function setModifier(key, value) {
  const axis = MODIFIER_AXES.find((a) => a.key === key);
  if (!axis || !axis.values.includes(value)) return false;
  const next = { ...current, [key]: value };
  // v0.10 3.1. Density is the axis that earns this: it moves every gap and type
  // size in the HUD at once, and applied in a single frame it reads as the
  // window having been resized rather than as a setting having been changed.
  //
  // `current` is advanced HERE rather than being left to applyModifiers(),
  // because crossfade()'s callback does not run until the browser has taken its
  // snapshot - and a second axis changed in the meantime has to spread the
  // state that is on its way in, not the one still on screen.
  current = normalizeModifiers(next);
  crossfade(() => applyModifiers(next));
  window.lunacore.setUiPrefs({ [key]: value });
  return true;
}

/**
 * Startup: read the stored axes and put them on <html>.
 *
 * Called from renderer.js BEFORE initAppearance(). Order matters in one
 * direction only - modifiers are attributes and themes are inline styles, so
 * they cannot overwrite each other - but density changes every gap and font size
 * in the HUD, and applying it after the first paint would show a visible
 * re-layout on every launch. First, then, and nothing reflows twice.
 */
export async function initModifiers() {
  let prefs = null;
  try {
    prefs = await window.lunacore.getUiPrefs();
  } catch {
    /* no preferences - stay unmodified, which is the pre-v0.10 look */
  }
  applyModifiers(normalizeModifiers(prefs));
}
