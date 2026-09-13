// ============================================================================
// LunaCore - Surface transparency (Settings overlay, Ctrl+L)
// ----------------------------------------------------------------------------
// reference/TRANSPARENCY_PLAN.md. Four sliders over the per-layer alpha tokens
// that styles.css derives every surface colour from.
//
// FOUR sliders and not one, because the layers NEST: html/body -> .app ->
// .panel are stacked, so a single shared alpha composites to 1-(1-a)^n. That is
// the whole 2026-09-13 "glass renders opaque" bug - 62% on three layers is
// 94.5% on screen - and one knob per layer is the only honest control for it.
//
// null means FOLLOW THE THEME and is the default on every axis, so until a
// slider is actually moved this module writes nothing and the 28 opaque themes
// stay pixel-identical. "Follow theme" puts all four back to null.
//
// Mounted by termcustom.js; applySurfaceAlpha() is called by appearance.js
// immediately after it writes a theme's vars - the same compose-don't-race
// shape terminals.js already uses for the background-opacity slider, and for
// the same reason: a theme switch would otherwise silently drop the override.
// ============================================================================

'use strict';

import { refreshTerminalGround } from './terminals.js';
import { sfx } from './sound.js';
import { t } from './util.js';
import { onLangChange } from './bus.js';

// key: our own axis name | token: what styles.css reads | pref: uiprefs field.
const AXES = [
  { key: 'ground', token: '--alpha-ground', pref: 'surfaceAlphaGround', id: 'surfacealpha-ground' },
  { key: 'edge', token: '--alpha-edge', pref: 'surfaceAlphaEdge', id: 'surfacealpha-edge' },
  { key: 'panel', token: '--alpha-panel', pref: 'surfaceAlphaPanel', id: 'surfacealpha-panel' },
  { key: 'term', token: '--alpha-term', pref: 'surfaceAlphaTerm', id: 'surfacealpha-term' },
  { key: 'chrome', token: '--alpha-chrome', pref: 'surfaceAlphaChrome', id: 'surfacealpha-chrome' },
];

/** Per-axis override, percent 0-100, or null for "follow the theme". */
const overrides = { ground: null, edge: null, panel: null, term: null, chrome: null };

/**
 * What the ACTIVE THEME published for each token, captured on every theme
 * apply.
 *
 * Needed because appearance.js writes theme vars to documentElement.style - the
 * same inline block this module writes to - so "stop overriding this axis"
 * cannot be a removeProperty(): that would delete the theme's own value too.
 * Snapshotting it the moment the theme lands is what makes the reset restore
 * the theme rather than fall through to styles.css's 100% default.
 */
const themeBaseline = { ground: '', edge: '', panel: '', term: '', chrome: '' };

let els = null;

/**
 * Windows backdrop material. Global rather than a theme token: it is the one
 * part of the stack Windows owns instead of the stylesheet, it paints the
 * non-client area too, and it is the ONLY control over how smeared the
 * backdrop is - DWM's acrylic blur radius is not adjustable. Applied in main.js
 * off the same 'ui:set' write, live, with no window recreation.
 */
let material = 'acrylic';

/** Writes the live tokens: an override where set, the theme's value where not. */
function paint() {
  const root = document.documentElement;
  for (const axis of AXES) {
    const pct = overrides[axis.key];
    if (pct === null) {
      const base = themeBaseline[axis.key];
      if (base) root.style.setProperty(axis.token, base);
      else root.style.removeProperty(axis.token);
    } else {
      root.style.setProperty(axis.token, `${pct}%`);
    }
  }
  // --alpha-term decides whether xterm paints a ground of its own at all, and
  // that is a canvas option rather than a CSS token, so it needs telling.
  refreshTerminalGround();
}

/**
 * Re-snapshots the theme's own alphas, then re-applies the overrides on top.
 *
 * Called by appearance.js AFTER applyThemeVars() has written the incoming
 * theme, which is the one moment documentElement.style holds the theme's values
 * and nothing else.
 */
export function applySurfaceAlpha() {
  const root = document.documentElement;
  for (const axis of AXES) {
    themeBaseline[axis.key] = root.style.getPropertyValue(axis.token) || '';
  }
  paint();
  render();
}

/** Repaints the sliders and their readouts from module state. */
function render() {
  if (!els) return;
  for (const axis of AXES) {
    const pct = overrides[axis.key];
    // A slider has no "unset" position, so an axis following the theme shows
    // the theme's number and says so in the readout instead of pretending the
    // value is the user's.
    const shown = pct === null ? themePct(axis.key) : pct;
    els[axis.key].value = shown;
    els[`${axis.key}Out`].textContent =
      pct === null ? `${shown}% ${t('surfacealpha.fromTheme')}` : `${pct}%`;
  }
  els.follow.disabled = AXES.every((a) => overrides[a.key] === null);
  if (els.material) els.material.value = material;
}

/** The theme's own percentage for an axis, as a number; 100 when it sets none. */
function themePct(key) {
  const n = parseFloat(themeBaseline[key]);
  return Number.isFinite(n) ? Math.round(n) : 100;
}

/**
 * Wires the four sliders. Returns a no-op teardown when the markup is absent,
 * matching autocompact.js's mount contract.
 */
export function mountSurfaceAlpha(root) {
  els = {
    follow: root.querySelector('#surfacealpha-follow'),
    material: root.querySelector('#surfacealpha-material'),
  };
  for (const axis of AXES) {
    els[axis.key] = root.querySelector(`#${axis.id}`);
    els[`${axis.key}Out`] = root.querySelector(`#${axis.id}-out`);
  }
  if (!els.follow || AXES.some((a) => !els[a.key])) {
    els = null;
    return () => {};
  }

  for (const axis of AXES) {
    // 'input' and not 'change': the whole point is watching the HUD dissolve
    // while the handle moves. Painting is a few setProperty calls on one
    // element, so there is nothing here worth debouncing.
    els[axis.key].addEventListener('input', () => {
      overrides[axis.key] = Number(els[axis.key].value);
      paint();
      render();
    });
    // Persist on release, not per frame - a drag across the track would
    // otherwise be a hundred writes to disk.
    els[axis.key].addEventListener('change', () => {
      sfx.modeToggle();
      window.lunacore.setUiPrefs({ [axis.pref]: overrides[axis.key] });
    });
  }

  if (els.material) {
    els.material.value = material;
    els.material.addEventListener('change', () => {
      sfx.modeToggle();
      material = els.material.value;
      window.lunacore.setUiPrefs({ windowMaterial: material });
    });
  }

  els.follow.addEventListener('click', () => {
    sfx.modeToggle();
    const partial = {};
    for (const axis of AXES) {
      overrides[axis.key] = null;
      partial[axis.pref] = null;
    }
    paint();
    render();
    window.lunacore.setUiPrefs(partial);
  });

  // The readouts carry a translated "(theme)" suffix, so a language switch has
  // to repaint them - same reason notify.js and the screenshot switch do.
  onLangChange(render);
  render();
  return () => {};
}

/** Seeds the overrides from stored prefs at boot, before the first paint. */
export function initSurfaceAlpha(prefs) {
  if (prefs && typeof prefs.windowMaterial === 'string') material = prefs.windowMaterial;
  for (const axis of AXES) {
    const v = prefs ? prefs[axis.pref] : null;
    overrides[axis.key] = Number.isFinite(v) ? Math.max(0, Math.min(100, Math.round(v))) : null;
  }
  paint();
  render();
}
