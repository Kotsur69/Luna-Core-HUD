// ============================================================================
// LunaCore - layout presets (Phase C1)
// ----------------------------------------------------------------------------
// Turns "where do the panels go" from hardcoded CSS into data. A layout says
// how to shape the top-level grid and which widgets live in which region:
//
//   { id, label, grid: { columns, rows, areas }, slots: { <region>: [widgetId] } }
//
// `areas` is grid-template-areas as an array of rows ("left main right"), so a
// preset can be three columns, two columns, or a terminal over a dock without
// this file knowing anything about those shapes. Region names come out of the
// areas themselves - there is no fixed left/center/right vocabulary.
//
// Same base+local merge as themes/profiles/projects: config/layouts.json plus a
// gitignored config/layouts.local.json that overrides by id.
//
// DOM-free on purpose. Mounting and moving widget roots is the renderer's job
// (src/renderer/modules/layout.js); everything here is pure and unit-tested,
// the same split that makes normalizeProfile / normalizeWidget testable.
// ============================================================================

'use strict';

const fs = require('fs');
const path = require('path');
const { hasText, normalizeText } = require('./localized');

const CONFIG_DIR = path.join(__dirname, '..', 'config');
const BASE_FILE = path.join(CONFIG_DIR, 'layouts.json');
const LOCAL_FILE = path.join(CONFIG_DIR, 'layouts.local.json');

/**
 * Widgets every layout MUST place somewhere, or it is rejected.
 *
 * `terminal` because a HUD without one is not the app. `appearance` because it
 * holds the layout <select>: a preset that omits it would hide the only control
 * that can switch away from it, locking the user in until they hand-edit JSON.
 * Both failures are silent and total, which is exactly what boundary validation
 * is for.
 */
const REQUIRED_WIDGETS = Object.freeze(['terminal', 'appearance']);

/** Safe read + JSON parse. Returns null when the file is missing or invalid. */
function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function isPlainObject(o) {
  return o && typeof o === 'object' && !Array.isArray(o);
}

/** Renders an areas array as a CSS grid-template-areas value. */
function gridAreas(areas) {
  return areas.map((row) => `"${row}"`).join(' ');
}

/**
 * Validates and normalizes one layout. Returns an object or null.
 *
 * Rejects rather than repairs, because every failure here has a safe fallback
 * and a silently "fixed" layout would be harder to debug than a missing one.
 */
function normalizeLayout(raw) {
  if (!isPlainObject(raw)) return null;
  if (typeof raw.id !== 'string' || !raw.id) return null;

  const grid = isPlainObject(raw.grid) ? raw.grid : null;
  if (!grid) return null;

  // -- areas: the source of truth for which region names exist ---------------
  const areas = Array.isArray(grid.areas)
    ? grid.areas.filter((r) => typeof r === 'string' && r.trim()).map((r) => r.trim())
    : [];
  if (areas.length === 0) return null;

  // Every row of grid-template-areas must name the same number of columns.
  // A ragged value is invalid CSS, and the engine drops the WHOLE declaration -
  // the HUD would silently collapse into a single stacked column.
  const rowTokens = areas.map((r) => r.split(/\s+/));
  const width = rowTokens[0].length;
  if (rowTokens.some((tokens) => tokens.length !== width)) return null;

  // "." is CSS's null cell and never names a region.
  const regions = new Set(rowTokens.flat().filter((name) => name !== '.'));
  if (regions.size === 0) return null;

  // -- slots -----------------------------------------------------------------
  // Region order = first appearance in `areas`. Also the DOM order the renderer
  // builds regions in, so it decides mount order on first paint.
  const regionOrder = [...new Set(rowTokens.flat().filter((name) => name !== '.'))];

  const slots = {};
  const seen = new Set();
  if (isPlainObject(raw.slots)) {
    for (const [region, ids] of Object.entries(raw.slots)) {
      // A slot naming a region the grid does not define has nowhere to render;
      // drop it rather than failing the whole layout, so a preset stays usable
      // after someone trims a region out of its areas.
      if (!regions.has(region) || !Array.isArray(ids)) continue;
      const list = ids.filter((id) => typeof id === 'string' && id.trim()).map((id) => id.trim());
      for (const id of list) {
        // A widget has exactly one root element, so two slots would fight over
        // it and the second mount would throw. Reject: the config is genuinely
        // ambiguous and there is no non-arbitrary way to pick a winner.
        if (seen.has(id)) return null;
        seen.add(id);
      }
      slots[region] = list;
    }
  }

  for (const id of REQUIRED_WIDGETS) {
    if (!seen.has(id)) return null;
  }

  // -- chrome: where the brand mark and the PTY status line are pinned --------
  //
  // These two are not widgets - they are static markup the renderer MOVES into a
  // region (ptystatus.js captures #pty-status-dot at import time, so it cannot
  // live in a <template>). A layout says which region wears them.
  //
  // Default: the first region that does not hold the terminal. The terminal's
  // region is rendered bare - no padding, no scroller - so chrome placed there
  // would be dropped on the floor. Pointing chrome at it is therefore corrected
  // rather than honoured: unlike the rules above, this failure has an obviously
  // right answer, and losing the connection indicator is not worth a rejection.
  const defaultChrome =
    regionOrder.find((r) => !(slots[r] || []).includes('terminal')) || regionOrder[0];
  const chromeRaw = isPlainObject(raw.chrome) ? raw.chrome : {};
  const pickChrome = (v) =>
    typeof v === 'string' && regions.has(v) && !(slots[v] || []).includes('terminal')
      ? v
      : defaultChrome;

  return {
    id: raw.id,
    // Label may be a string or a { pl, en } object - see src/localized.js. It
    // stays unresolved so the renderer can pick a language at render time, the
    // same reason the widget contract takes `titleKey` and not `title`.
    label: hasText(raw.label) ? normalizeText(raw.label) : raw.id,
    columns: typeof grid.columns === 'string' && grid.columns.trim() ? grid.columns.trim() : '1fr',
    rows: typeof grid.rows === 'string' && grid.rows.trim() ? grid.rows.trim() : '1fr',
    areas,
    // Precomputed here rather than in the renderer: this is the one place that
    // knows `areas` is valid, and the renderer has no access to this module
    // (CommonJS, main process) to call gridAreas() itself.
    gridTemplateAreas: gridAreas(areas),
    regionOrder,
    chrome: { brand: pickChrome(chromeRaw.brand), status: pickChrome(chromeRaw.status) },
    slots,
  };
}

// Emergency preset for a missing or broken config - today's hardcoded layout,
// so a damaged file lands on exactly the HUD that shipped before C1.
const FALLBACK = {
  activeLayout: 'classic',
  layouts: [
    {
      id: 'classic',
      label: 'Classic',
      grid: { columns: '260px 1fr 280px', rows: '1fr', areas: ['left main right'] },
      slots: {
        left: ['actions', 'appearance', 'project', 'profile', 'cheatsheets', 'prompts', 'skills'],
        main: ['terminal'],
        right: ['context', 'usage', 'skilltracker', 'ports', 'scratchpad'],
      },
    },
  ],
};

/**
 * Loads layouts: base (layouts.json) merged with local (layouts.local.json).
 * Local overrides or adds presets by id.
 * @returns {{layouts: Array<object>, activeLayout: string}}
 */
function loadLayouts() {
  const base = readJson(BASE_FILE) || FALLBACK;
  const local = readJson(LOCAL_FILE);

  const byId = new Map();
  const collect = (src) => {
    if (!src || !Array.isArray(src.layouts)) return;
    for (const raw of src.layouts) {
      const l = normalizeLayout(raw);
      if (l) byId.set(l.id, l);
    }
  };
  collect(base);
  collect(local);

  let layouts = [...byId.values()];
  if (layouts.length === 0) {
    // Even the fallback goes through validation - if this ever returns null the
    // constant above is wrong, and an empty list is better than a broken grid.
    layouts = FALLBACK.layouts.map(normalizeLayout).filter(Boolean);
  }

  let activeLayout =
    (local && typeof local.activeLayout === 'string' && local.activeLayout) ||
    (typeof base.activeLayout === 'string' && base.activeLayout) ||
    layouts[0].id;
  if (!layouts.some((l) => l.id === activeLayout)) activeLayout = layouts[0].id;

  return { layouts, activeLayout };
}

/** Returns the layout with the given id, or null. */
function getLayout(layouts, id) {
  return layouts.find((l) => l.id === id) || null;
}

// normalizeLayout + gridAreas are pure (no I/O) - exported for the tests.
module.exports = { loadLayouts, getLayout, normalizeLayout, gridAreas, REQUIRED_WIDGETS };
