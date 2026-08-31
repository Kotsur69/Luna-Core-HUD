// ============================================================================
// LunaCore - the layout builder's pure half (v0.10 phase 4.2)
// ----------------------------------------------------------------------------
// Saving a layout is a data transform, not a DOM operation: take the shape the
// user has dragged the HUD into and write it down under a name. That transform
// lives here, DOM-free and require()-able from node --test, for the same reason
// panels.js keeps its track math separate from its splitters - the interesting
// failures are all in the data.
//
// What a saved layout IS:
//
//   the current preset's rows + areas + chrome   (the shape)
//   the live UNRAILED columns                    (what the splitters were dragged to)
//   the live healed slots                        (where the widgets actually are)
//
// Rows and areas come from the preset rather than from the screen because
// nothing in the HUD can change them - C2 drags columns, C4 moves widgets
// between regions, and neither invents a new grid. Columns come from
// currentBaseTracks (never the railed row) so a layout saved while a region
// happens to be collapsed records the width that region will have when it is
// opened, not 44px.
//
// Folds are deliberately NOT stored. `collapsed` in uiprefs is global rather
// than per-layout and already survives a layout switch, so recording it here
// would mean a saved layout silently re-folding panels the user had opened since.
// Rails ARE carried over, but by copying railedRegions to the new id rather than
// by putting them in the spec: they are per-layout state that layouts.json has
// no field for, and inventing one would put the same fact in two places.
// ============================================================================

'use strict';

/** Longest label we store. Matches cleanLayoutLabel()'s cap in src/uiprefs.js. */
export const MAX_LABEL_LEN = 64;

/** Longest generated id, before any uniqueness suffix. */
const MAX_ID_LEN = 48;

/**
 * Turns a human name into an id-shaped slug.
 *
 * Ids reach a prefs file key, a <select> value and grid-region lookups, so the
 * safe set is deliberately narrow: lowercase, digits, dashes. Returns '' when
 * nothing usable survives, which callers must treat as "ask again" rather than
 * substituting a name of their own - an id the user cannot predict is an id
 * they cannot find later.
 *
 * @param {string} name
 * @returns {string}
 */
export function slugify(name) {
  if (typeof name !== 'string') return '';
  return (
    name
      .toLowerCase()
      // U+0142 is a single codepoint with no combining mark, so NFKD leaves it
      // alone and the dash rule below would eat it. It is the ONLY one of the
      // nine Polish special letters that behaves this way - the other eight
      // decompose - which is why this is one replacement and not a table.
      .replace(/ł/g, 'l')
      // Decompose, then drop the combining marks, so Polish input slugs to its
      // bare latin form ("Moj Uklad" with diacritics -> "moj-uklad") instead of
      // losing those letters entirely.
      .normalize('NFKD')
      .replace(/\p{M}+/gu, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, MAX_ID_LEN)
      // Again after the slice: cutting at MAX_ID_LEN can land mid-dash.
      .replace(/-+$/g, '')
  );
}

/**
 * `base`, or the first `base-2`, `base-3`... that nothing has taken.
 *
 * `taken` must hold SHIPPED preset ids as well as saved ones. A custom layout is
 * allowed to override a preset by id - loadLayouts merges it last and the user's
 * wins - but doing that by accident because they typed "Classic" would make a
 * shipped preset vanish from the picker with no hint why.
 *
 * @param {string} base
 * @param {Iterable<string>} taken
 * @returns {string}
 */
export function uniqueLayoutId(base, taken) {
  if (!base) return '';
  const used = new Set(taken || []);
  if (!used.has(base)) return base;
  for (let n = 2; n < 1000; n += 1) {
    const next = `${base}-${n}`;
    if (!used.has(next)) return next;
  }
  return '';
}

/** Trims a label to what uiprefs will keep, or '' when there is nothing left. */
function cleanLabel(label) {
  return typeof label === 'string' ? label.trim().slice(0, MAX_LABEL_LEN) : '';
}

/**
 * Builds the spec to store from the live HUD.
 *
 * @param {object} args
 * @param {object} args.layout the ACTIVE normalized layout (rows, areas, chrome)
 * @param {string} args.columns live unrailed grid-template-columns
 * @param {object} args.slots live healed { region: [widgetId] }
 * @param {string} args.label what the user typed
 * @returns {object|null} null when the inputs cannot make a layout
 */
export function specFromLive({ layout, columns, slots, label } = {}) {
  if (!layout || typeof layout !== 'object') return null;
  if (!Array.isArray(layout.areas) || layout.areas.length === 0) return null;
  if (!slots || typeof slots !== 'object' || Array.isArray(slots)) return null;

  const name = cleanLabel(label);
  if (!name) return null;

  // Empty regions are dropped rather than stored as []: uiprefs drops them
  // anyway, and a region with nothing in it is recreated from `areas` on load.
  const keptSlots = {};
  for (const [region, ids] of Object.entries(slots)) {
    if (!Array.isArray(ids) || ids.length === 0) continue;
    keptSlots[region] = [...ids];
  }
  if (Object.keys(keptSlots).length === 0) return null;

  const spec = {
    label: name,
    grid: {
      // Falls back to the preset's own widths when nothing has been dragged yet.
      columns: typeof columns === 'string' && columns.trim() ? columns.trim() : layout.columns,
      rows: typeof layout.rows === 'string' && layout.rows.trim() ? layout.rows : '1fr',
      areas: [...layout.areas],
    },
    slots: keptSlots,
  };

  // Carried over so a saved layout keeps the brand mark and PTY status line
  // where the preset had them. normalizeLayout re-validates on load and will
  // correct a region that no longer qualifies.
  if (layout.chrome && typeof layout.chrome === 'object') {
    const picked = {};
    if (typeof layout.chrome.brand === 'string') picked.brand = layout.chrome.brand;
    if (typeof layout.chrome.status === 'string') picked.status = layout.chrome.status;
    if (Object.keys(picked).length) spec.chrome = picked;
  }

  return spec;
}

/**
 * Adds a spec to the map under a fresh id. Returns the new map and that id.
 *
 * Every function below returns a NEW map rather than mutating. The caller hands
 * the result straight to setUiPrefs, and a write that had also mutated the live
 * object would leave the two disagreeing with no way to tell which is real.
 *
 * @returns {{map: object, id: string}|null}
 */
export function saveCustomLayout(map, spec, taken) {
  if (!spec || typeof spec !== 'object') return null;
  const base = slugify(typeof spec.label === 'string' ? spec.label : '');
  if (!base) return null;
  const id = uniqueLayoutId(base, taken);
  if (!id) return null;
  return { map: { ...(map || {}), [id]: spec }, id };
}

/**
 * Renames one saved layout.
 *
 * The id deliberately does NOT change with it. layoutSizes, widgetSlots and
 * railedRegions are all keyed by layout id, so re-slugging on rename would
 * orphan every one of them and the layout would snap back to its authored
 * widths for no reason the user can see.
 */
export function renameCustomLayout(map, id, label) {
  const current = map && map[id];
  if (!current) return null;
  const name = cleanLabel(label);
  if (!name) return null;
  return { ...map, [id]: { ...current, label: name } };
}

/** Copies one saved layout under a new name and id. */
export function duplicateCustomLayout(map, id, label, taken) {
  const current = map && map[id];
  if (!current) return null;
  const name = cleanLabel(label);
  if (!name) return null;
  // Deep enough for this shape: grid holds one array, slots holds arrays of
  // strings. A shallow copy would leave the duplicate sharing `areas` with its
  // original, so editing one would silently edit both.
  const copy = {
    ...current,
    label: name,
    grid: { ...current.grid, areas: [...(current.grid && current.grid.areas) || []] },
    slots: Object.fromEntries(
      Object.entries(current.slots || {}).map(([r, ids]) => [r, [...ids]])
    ),
  };
  return saveCustomLayout(map, copy, taken);
}

/** Removes one saved layout. Returns a new map, or null when there was nothing
 *  to remove - so a caller never persists a no-op write. */
export function deleteCustomLayout(map, id) {
  if (!map || !Object.prototype.hasOwnProperty.call(map, id)) return null;
  const next = { ...map };
  delete next[id];
  return next;
}
