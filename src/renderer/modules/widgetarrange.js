// ============================================================================
// LunaCore - drag a widget between regions (C4 / E4)
// ----------------------------------------------------------------------------
// The last panel-engine piece. C1 made "which widget lives in which region"
// data; C2 let you fold a widget away and drag the region borders. This lets
// you pick a widget up by its title and carry it to a different column, or to
// a new spot in the same one.
//
// It edits the same shell C1 builds, so it follows C1's one rule exactly:
//
//   MOVING A WIDGET MOVES ITS ROOT, IT NEVER REMOUNTS IT.
//
// A drop is `scroll.insertBefore(existingRoot, ...)` - the whole subtree, live
// xterm buffers and all, rides along. Nothing is torn down, so none of host.js's
// "repaint from module state" concerns apply here any more than they do to a
// layout switch.
//
// WHAT PERSISTS. Per layout id (like C2's column widths - a position in
// `classic` means nothing in `focus`), a `{ region: [widgetId] }` map in
// ui.local.json under `widgetSlots`. On the next build it is merged back over
// the preset by effectiveSlots() below, which also HEALS it: a widget the
// preset dropped falls out, a widget a newer build added is appended to its
// authored region, and `terminal` is pinned no matter what the stored map says.
//
// TWO NON-DEPENDENCIES, same as panels.js and for the same reason (keep the
// pure half require()-able from a plain CJS test):
//   * nothing touches `document` at module scope - `.app` is resolved lazily;
//   * after a drop we dispatch a window `resize` rather than importing
//     terminals.js, because renderer.js has already wired that to fitAndResize().
// ============================================================================

'use strict';

import { onLangChange } from './bus.js';
import { getWidget, listWidgets } from './registry.js';

/**
 * Widgets a layout may place but this feature must never move. `terminal` is
 * `remountable: false` and its region is rendered bare (no scroller) - it is
 * neither a draggable tile nor a valid drop target.
 */
export const PINNED = Object.freeze(['terminal']);

// ---- Pure merge core ------------------------------------------------------

/**
 * Every widget id the preset places, anywhere - the whitelist a stored
 * arrangement is validated against.
 * @param {Record<string, string[]>} presetSlots
 * @returns {Set<string>}
 */
function placedByPreset(presetSlots) {
  const all = new Set();
  for (const ids of Object.values(presetSlots || {})) {
    if (Array.isArray(ids)) for (const id of ids) all.add(id);
  }
  return all;
}

/**
 * The region the preset authored a widget into, or null.
 * @param {Record<string, string[]>} presetSlots
 * @param {string} id
 */
function presetRegionOf(presetSlots, id) {
  for (const [region, ids] of Object.entries(presetSlots || {})) {
    if (Array.isArray(ids) && ids.includes(id)) return region;
  }
  return null;
}

/**
 * Merges a stored arrangement over a layout's authored slots.
 *
 * Rules, in order:
 *   1. Only regions the preset defines get a list; `regionOrder` still drives
 *      iteration in layout.js, this just supplies the ids per region.
 *   2. A stored id is kept only if the preset still places it somewhere and it
 *      has not already been taken by an earlier region (first mention wins).
 *   3. `terminal` (PINNED) is stripped from the stored map and re-added to its
 *      authored region - it can never be dragged, so it can never move.
 *   4. Any preset widget the stored map never mentions is appended to its
 *      authored region. This is the heal path for a widget a newer build adds.
 *
 * @param {{ id: string, regionOrder: string[], slots: Record<string,string[]> }} layout
 * @param {Record<string, string[]>|null|undefined} override
 * @returns {Record<string, string[]>} region -> ordered widget ids
 */
export function effectiveSlots(layout, override) {
  const presetSlots = (layout && layout.slots) || {};
  const regions =
    (layout && Array.isArray(layout.regionOrder) && layout.regionOrder) ||
    Object.keys(presetSlots);
  const pinned = new Set(PINNED);
  const valid = placedByPreset(presetSlots);

  const out = {};
  for (const region of regions) out[region] = [];

  const taken = new Set();
  const hasOverride = override && typeof override === 'object' && !Array.isArray(override);

  if (hasOverride) {
    for (const region of regions) {
      const stored = Array.isArray(override[region]) ? override[region] : [];
      for (const id of stored) {
        if (typeof id !== 'string' || !id) continue;
        if (pinned.has(id)) continue; // rule 3
        if (!valid.has(id) || taken.has(id)) continue; // rule 2
        out[region].push(id);
        taken.add(id);
      }
    }
  }

  // Rule 3: pinned widgets, always in their authored region.
  for (const id of valid) {
    if (!pinned.has(id)) continue;
    const region = presetRegionOf(presetSlots, id);
    if (region && out[region] && !taken.has(id)) {
      out[region].push(id);
      taken.add(id);
    }
  }

  // Rule 4: heal - anything the preset places that nothing above claimed.
  for (const region of regions) {
    for (const id of presetSlots[region] || []) {
      if (taken.has(id)) continue;
      out[region].push(id);
      taken.add(id);
    }
  }

  return out;
}

/**
 * Turns raw DOM-order entries into a storable arrangement, dropping pinned ids
 * and empty regions. Pure so the persistence shape is testable without a DOM.
 * @param {Array<{ region: string, ids: string[] }>} entries
 * @returns {Record<string, string[]>}
 */
export function arrangementFromEntries(entries) {
  const pinned = new Set(PINNED);
  const out = {};
  for (const entry of entries || []) {
    if (!entry || typeof entry !== 'object') continue;
    const { region, ids } = entry;
    if (typeof region !== 'string' || !region) continue;
    const clean = (Array.isArray(ids) ? ids : []).filter(
      (id) => typeof id === 'string' && id && !pinned.has(id),
    );
    if (clean.length) out[region] = clean;
  }
  return out;
}

// ---- DOM / interaction half --------------------------------------------------

/** layoutId -> stored { region: [id] }. Loaded once by initWidgetArrange(). */
const arrangements = new Map();
let currentLayout = null;
let appEl = null;

function app() {
  if (!appEl) appEl = document.querySelector('.app');
  return appEl;
}

/**
 * Appends any registered widget this layout places nowhere. CUSTOM layouts only.
 *
 * A shipped preset that omits a widget is making an authoring decision - `focus`
 * leaves most of them out on purpose - so healing there would quietly undo the
 * preset. A SAVED layout is a different thing: it froze the widget list as it
 * stood on the day it was saved, and a widget added by a later version would
 * otherwise be invisible in it forever, with no way to drag in something that is
 * not on screen to begin with.
 *
 * They land at the end of the last region that does not hold the terminal, which
 * is where the readouts already live. The next save writes them into the spec, so
 * this heals once rather than on every load.
 */
function withUnplacedWidgets(slots) {
  const placed = new Set();
  for (const ids of Object.values(slots)) for (const id of ids) placed.add(id);

  const missing = listWidgets()
    .map((w) => w && w.id)
    .filter((id) => id && !placed.has(id));
  if (missing.length === 0) return slots;

  const target = Object.keys(slots)
    .reverse()
    .find((r) => !(slots[r] || []).includes('terminal'));
  if (!target) return slots;

  return { ...slots, [target]: [...slots[target], ...missing] };
}

/** The effective slots for a layout, stored arrangement merged in. */
export function slotsFor(layout) {
  const slots = effectiveSlots(layout, arrangements.get(layout.id) || null);
  return layout && layout.custom ? withUnplacedWidgets(slots) : slots;
}

function persist() {
  try {
    window.lunacore.setUiPrefs({ widgetSlots: Object.fromEntries(arrangements) });
  } catch {
    /* a HUD that cannot remember a dragged panel still works as a HUD */
  }
}

/**
 * Loads the persisted arrangements. Must run before initLayout(), which is what
 * triggers the first slotsFor().
 */
export async function initWidgetArrange() {
  try {
    const prefs = (await window.lunacore.getUiPrefs()) || {};
    const raw = prefs.widgetSlots;
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      for (const [layoutId, map] of Object.entries(raw)) {
        if (typeof layoutId !== 'string' || !layoutId) continue;
        if (!map || typeof map !== 'object' || Array.isArray(map)) continue;
        arrangements.set(layoutId, map);
      }
    }
  } catch {
    /* no preferences - every preset in its authored arrangement */
  }
}

// ---- Grip decoration -------------------------------------------------------

function isDraggable(section) {
  const id = section.dataset.widget;
  if (!id || PINNED.includes(id)) return false;
  const w = getWidget(id);
  if (w && w.remountable === false) return false;
  return !!section.querySelector(':scope > .panel__title');
}

function gripLabel() {
  return window.i18n ? window.i18n.t('panel.arrange') : '';
}

/**
 * Adds the drag handle to one section's title, once. The grip sits just after
 * C2's fold chevron so both handles read as one cluster, and it stops its own
 * pointer/click events from reaching the title - otherwise a grab would also
 * toggle the fold that panels.js wired on the same element.
 */
function decorate(section) {
  if (!isDraggable(section)) return;
  const title = section.querySelector(':scope > .panel__title');
  let grip = title.querySelector(':scope > .panel__grip');
  if (!grip) {
    grip = document.createElement('span');
    grip.className = 'panel__grip';
    grip.setAttribute('aria-hidden', 'true');
    grip.textContent = '⠿'; // braille pattern, the conventional drag-handle glyph
    const chevron = title.querySelector(':scope > .panel__fold');
    if (chevron && chevron.nextSibling) title.insertBefore(grip, chevron.nextSibling);
    else if (chevron) title.appendChild(grip);
    else title.prepend(grip);
  }
  grip.title = gripLabel();

  if (grip.dataset.wired) return;
  grip.dataset.wired = '1';
  grip.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    startDrag(e, section);
  });
  grip.addEventListener('click', (e) => e.stopPropagation());
  grip.addEventListener('dblclick', (e) => {
    e.stopPropagation();
    resetCurrentLayout();
  });
}

function decorateAll() {
  const el = app();
  if (!el) return;
  for (const section of el.querySelectorAll('.panel__section[data-widget]')) decorate(section);
}

// ---- Drop-target geometry -------------------------------------------------

/** Every non-terminal region's scroller on screen right now. */
function regionScrolls() {
  const out = [];
  for (const region of app().querySelectorAll('[data-region]')) {
    if (region.classList.contains('region--bare')) continue;
    const scroll = region.querySelector(':scope > .panel__scroll');
    if (scroll) out.push({ name: region.dataset.region, scroll });
  }
  return out;
}

/** The scroller under the pointer, or null when the pointer is off the grid. */
function scrollAt(x, y) {
  const node = document.elementFromPoint(x, y);
  if (!node) return null;
  const region = node.closest('[data-region]');
  if (!region || region.classList.contains('region--bare')) return null;
  return region.querySelector(':scope > .panel__scroll');
}

/**
 * Where the placeholder should sit inside `scroll` for a pointer at `y`: before
 * the first section whose vertical midpoint is below the pointer, or at the end.
 * The dragged section and the placeholder itself are skipped.
 */
function insertRefFor(scroll, y, dragged, placeholder) {
  for (const child of scroll.children) {
    if (child === dragged || child === placeholder) continue;
    const r = child.getBoundingClientRect();
    if (y < r.top + r.height / 2) return child;
  }
  return null;
}

// ---- FLIP for the rows that move out of the way -------------------------------

function snapshot(sections) {
  const m = new Map();
  for (const s of sections) m.set(s, s.getBoundingClientRect().top);
  return m;
}

/**
 * Plays every section from where it just was to where it now is. `.panel__section`
 * carries no transform transition of its own, so the "play" frame has to supply
 * one inline - and under prefers-reduced-motion the stylesheet's `!important`
 * zero-duration rule beats that inline value, so the rows just snap. No second
 * reduced-motion branch needed. endDrag() strips whatever is left behind.
 */
function flip(prev) {
  const movers = [];
  for (const [section, top0] of prev) {
    const dy = top0 - section.getBoundingClientRect().top;
    if (!dy) continue;
    section.style.transition = 'none';
    section.style.transform = `translateY(${dy}px)`;
    movers.push(section);
  }
  if (!movers.length) return;
  requestAnimationFrame(() => {
    for (const section of movers) {
      section.style.transition = 'transform var(--dur-fast, 140ms) var(--ease-sharp, ease)';
      section.style.transform = '';
    }
  });
}

/** Drops the inline transform/transition FLIP leaves on the rows it moved. */
function clearFlip() {
  for (const { scroll } of regionScrolls()) {
    for (const child of scroll.children) {
      child.style.transform = '';
      child.style.transition = '';
    }
  }
}

// ---- The drag ------------------------------------------------------------

/** The gesture in flight, or null. Module scope so a repaint cannot drop it. */
let drag = null;

function startDrag(event, section) {
  if (drag || event.button !== 0) return;

  const rect = section.getBoundingClientRect();
  const placeholder = document.createElement('div');
  placeholder.className = 'panel__drop-placeholder';
  placeholder.style.height = `${rect.height}px`;
  section.parentNode.insertBefore(placeholder, section);

  section.classList.add('is-arranging');
  section.style.width = `${rect.width}px`;
  section.style.left = `${rect.left}px`;
  section.style.top = `${rect.top}px`;
  document.body.classList.add('is-arranging');

  drag = {
    pointerId: event.pointerId,
    section,
    placeholder,
    grabDx: event.clientX - rect.left,
    grabDy: event.clientY - rect.top,
    lastX: event.clientX,
    lastY: event.clientY,
    frame: 0,
    // Grabbing the grip starts the gesture immediately (it is a dedicated
    // handle, not the whole title), but a plain click on it must not rewrite
    // prefs - this flips true only once the placeholder actually relocates.
    moved: false,
  };

  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onCancel);
}

function paint() {
  if (!drag) return;
  const { section, placeholder, lastX, lastY } = drag;

  // The tile tracks the pointer; the placeholder holds the slot it would drop
  // into. The section itself never leaves its original DOM position until the
  // drop - only the placeholder moves during the gesture.
  section.style.left = `${lastX - drag.grabDx}px`;
  section.style.top = `${lastY - drag.grabDy}px`;

  const scroll = scrollAt(lastX, lastY) || placeholder.parentNode;
  if (!scroll) return;

  const ref = insertRefFor(scroll, lastY, section, placeholder);
  if (placeholder.parentNode === scroll && placeholder.nextElementSibling === ref) return;

  // Snapshot every section that could move, do the placeholder move, then play
  // them all from where they were to where they now are.
  const moving = regionScrolls()
    .flatMap((r) => [...r.scroll.children])
    .filter((c) => c !== section && c !== placeholder);
  const before = snapshot(moving);
  scroll.insertBefore(placeholder, ref);
  drag.moved = true;
  flip(before);
}

function onMove(event) {
  if (!drag || event.pointerId !== drag.pointerId) return;
  drag.lastX = event.clientX;
  drag.lastY = event.clientY;
  if (drag.frame) return;
  drag.frame = requestAnimationFrame(() => {
    if (drag) drag.frame = 0;
    paint();
  });
}

function onUp(event) {
  if (drag && event.pointerId !== drag.pointerId) return;
  endDrag(true);
}

function onCancel(event) {
  if (drag && event.pointerId !== drag.pointerId) return;
  endDrag(false);
}

function endDrag(commit) {
  if (!drag) return;
  const g = drag;
  drag = null;
  if (g.frame) cancelAnimationFrame(g.frame);
  window.removeEventListener('pointermove', onMove);
  window.removeEventListener('pointerup', onUp);
  window.removeEventListener('pointercancel', onCancel);

  // On commit the section moves to wherever the placeholder ended up; on cancel
  // it stays where it started. Resolve the drop point BEFORE removing the
  // placeholder, and step past the section itself so insertBefore is never
  // asked to put a node in front of itself.
  const land = commit && g.moved && g.placeholder.parentNode;
  const target = land ? g.placeholder.parentNode : null;
  let ref = land ? g.placeholder.nextElementSibling : null;
  if (ref === g.section) ref = g.section.nextElementSibling;
  g.placeholder.remove();
  g.section.classList.remove('is-arranging');
  g.section.style.width = '';
  g.section.style.left = '';
  g.section.style.top = '';
  if (target) target.insertBefore(g.section, ref);
  clearFlip();
  document.body.classList.remove('is-arranging');

  if (commit && g.moved && currentLayout) {
    const entries = regionScrolls().map(({ name, scroll }) => ({
      region: name,
      ids: [...scroll.querySelectorAll(':scope > [data-widget]')].map((n) => n.dataset.widget),
    }));
    arrangements.set(currentLayout.id, arrangementFromEntries(entries));
    persist();
    // A widget region changed shape and xterm only re-measures on a resize
    // event - renderer.js has that wired to fitAndResize().
    window.dispatchEvent(new Event('resize'));
  }
}

/** Drops this layout's stored arrangement and rebuilds it from the preset. */
function resetCurrentLayout() {
  if (!currentLayout || !arrangements.has(currentLayout.id)) return;
  const id = currentLayout.id;
  arrangements.delete(id);
  persist();
  // Reuse the tested rebuild path rather than re-shuffling roots by hand. The
  // import is dynamic to keep a static cycle with layout.js from forming.
  import('./layout.js').then((m) => m.applyLayout(id)).catch(() => {});
}

// ---- Entry points ---------------------------------------------------------

/**
 * Re-decorates the grips for a freshly drawn layout. Called by layout.js right
 * after applyPanels(), which is the first moment every widget sits in its
 * region.
 */
export function applyWidgetArrange(layout) {
  currentLayout = layout;
  decorateAll();
}

/**
 * App-lifetime listener: put the grip tooltips back after a language switch.
 * i18n's applyStatic() reassigns `textContent` on the titles that carry
 * `data-i18n`, which drops the grip out of exactly those - so it has to be
 * re-added, the same repair panels.js does for its chevron.
 */
export function initWidgetArrangeTracking() {
  onLangChange(() => decorateAll());
}
