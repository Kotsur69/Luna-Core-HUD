// ============================================================================
// LunaCore - layout host (C1)
// ----------------------------------------------------------------------------
// The DOM half of layout presets. src/layouts.js validates the data; this file
// turns one preset into an actual HUD: it writes the grid template onto `.app`,
// builds a region element per name in `grid-template-areas`, and puts every
// widget where its slot says.
//
// THE ONE RULE THAT SHAPES THIS FILE: switching layouts MOVES widget roots, it
// never remounts them.
//
//   host.appendChild(existingRoot)   // not unmountWidget() + mountWidget()
//
// `terminal` is `remountable: false` (A2f) because its children are live xterm
// instances wired to real PTY processes; a template re-clone would orphan every
// running session. A DOM move preserves the whole subtree, so the same code path
// is safe for every widget - and none of the A2c/A2d "repaint from module state"
// concerns even come up, because nothing was torn down. Only widgets the new
// layout has NO region for are really unmounted, and that is safe precisely
// because the A2 conversion made every mount() restore itself from module state.
//
// Chrome (brand mark, PTY status line) is static markup living in #app-chrome,
// not a widget: ptystatus.js captures #pty-status-dot at import time, so it can
// never come out of a <template>. This file moves those two nodes into whichever
// region the layout names, and parks them back in #app-chrome while rebuilding.
// ============================================================================

'use strict';

import { getWidget } from './registry.js';
import {
  mountWidget,
  unmountWidget,
  mountIntoSlot,
  isMounted,
  mountedWidgets,
  widgetRoot,
  NESTED,
} from './host.js';
import { fitAndResize } from './terminals.js';

const appEl = document.querySelector('.app');
const chromeEl = document.getElementById('app-chrome');
const brandEl = chromeEl && chromeEl.querySelector('.brand');
const statusEl = chromeEl && chromeEl.querySelector('.status-line');

let layouts = [];
let activeLayoutId = null;
// False until the HUD has been drawn once; gates the switch animation (C3.7).
let firstPaintDone = false;

/** All available presets (for the switcher in Appearance). */
export function getLayouts() {
  return layouts;
}

/** Id of the preset on screen, or null before the first applyLayout(). */
export function getActiveLayoutId() {
  return activeLayoutId;
}

/**
 * Resolves a preset's slots into { region -> [widgetId] }, dropping entries the
 * renderer cannot honour. Both drops are warnings, not failures: a layout that
 * names a widget this build does not ship should lose that one block, not the
 * whole HUD.
 */
function planRegions(layout) {
  const plan = new Map();
  for (const region of layout.regionOrder) {
    const ids = [];
    for (const id of layout.slots[region] || []) {
      if (NESTED[id]) {
        console.warn(`layout "${layout.id}": "${id}" is nested in "${NESTED[id]}" - not placeable`);
        continue;
      }
      if (!getWidget(id)) {
        console.warn(`layout "${layout.id}": unknown widget "${id}" - skipped`);
        continue;
      }
      ids.push(id);
    }
    plan.set(region, ids);
  }
  return plan;
}

/**
 * Creates one region element inside `.app` and returns the node widgets go into.
 *
 * A region that holds the terminal is rendered BARE - no panel padding, no
 * scroller. The terminal widget's root is itself a full `.panel--center`, and
 * xterm measures against a fixed box: put it in an overflow-y container and it
 * would grow instead of fitting.
 */
function buildRegion(name, ids, layout, { index = 0, animate = false } = {}) {
  const holdsTerminal = ids.includes('terminal');
  const el = document.createElement(holdsTerminal ? 'div' : 'aside');
  el.dataset.region = name;
  el.style.gridArea = name;
  // C3.7: position in the reassembly stagger. Regions come out of regionOrder,
  // so the HUD rebuilds itself left to right, top to bottom.
  if (animate) {
    el.style.setProperty('--region-i', String(index));
    el.classList.add('region--enter');
  }
  appEl.appendChild(el);

  if (holdsTerminal) {
    el.classList.add('region', 'region--bare');
    return el;
  }

  el.classList.add('region', 'panel', 'panel--region');
  // Brand above the scroller and the status line below it, both pinned - the
  // same chrome the hardcoded left panel had.
  if (layout.chrome.brand === name && brandEl) el.appendChild(brandEl);
  const scroll = document.createElement('div');
  scroll.className = 'panel__scroll';
  el.appendChild(scroll);
  if (layout.chrome.status === name && statusEl) el.appendChild(statusEl);
  return scroll;
}

/**
 * Puts a preset on screen. Safe to call with the id already active.
 * @returns {boolean} false when there is no such preset
 */
export function applyLayout(id) {
  const layout = layouts.find((l) => l.id === id);
  if (!layout) return false;

  const plan = planRegions(layout);
  const wanted = new Set([...plan.values()].flat());

  // Set BEFORE anything mounts: the appearance widget repaints its layout select
  // from getActiveLayoutId() inside its own mount(), which happens further down
  // this very function on first paint (A2c - render from state, not markup).
  activeLayoutId = layout.id;

  // 1. Nested widgets first. Dropping `actions` takes autocompact's root out of
  //    the document with it, and the host would go on believing it is mounted -
  //    pointing at a node nothing can reach.
  for (const [nested, host] of Object.entries(NESTED)) {
    if (isMounted(nested) && !wanted.has(host)) unmountWidget(nested);
  }

  // 2. Then anything the new layout has no region for. Real teardown, so their
  //    cleanup runs and their bus subscriptions go with them.
  for (const mountedId of mountedWidgets()) {
    if (!NESTED[mountedId] && !wanted.has(mountedId)) unmountWidget(mountedId);
  }

  // 3. Detach the survivors before the shell is torn down, so replaceChildren()
  //    below cannot destroy them. A nested widget rides along inside its host's
  //    subtree and must not be touched separately.
  for (const mountedId of mountedWidgets()) {
    if (NESTED[mountedId]) continue;
    const root = widgetRoot(mountedId);
    if (root) root.remove();
  }
  if (brandEl) chromeEl.appendChild(brandEl);
  if (statusEl) chromeEl.appendChild(statusEl);

  // 4. Rebuild the shell.
  appEl.replaceChildren();
  appEl.style.gridTemplateColumns = layout.columns;
  appEl.style.gridTemplateRows = layout.rows;
  appEl.style.gridTemplateAreas = layout.gridTemplateAreas;
  document.body.dataset.layout = layout.id;

  // Animate the reassembly on a real switch only. On first paint the boot
  // overlay covers the HUD, so the stagger would play where nobody can see it -
  // and would still cost its full delay before the terminal was interactive.
  const animate = firstPaintDone;
  let index = 0;
  for (const [region, ids] of plan) {
    const host = buildRegion(region, ids, layout, { index: index++, animate });
    for (const wid of ids) {
      const root = widgetRoot(wid);
      if (root) host.appendChild(root);
      else mountWidget(wid, host);
    }
  }

  // 5. Nested widgets last, which also settles the bus ordering constraint for
  //    free: `autocompact` subscribes to the context stream after `context` has,
  //    so the bar updates before auto-compact judges the reading.
  for (const [nested, host] of Object.entries(NESTED)) {
    if (wanted.has(host) && !isMounted(nested)) mountIntoSlot(nested);
  }

  // The terminal's box just changed size (or moved between grid areas); xterm
  // only re-measures when told to. Safe to do while the stagger is playing: the
  // animation is transform/opacity, which never changes a layout box.
  fitAndResize();
  firstPaintDone = true;
  return true;
}

/**
 * Loads the presets and mounts the HUD. Must finish before anything reaches for
 * widget DOM - it is what creates that DOM in the first place.
 */
export async function initLayout() {
  let chosen = null;
  try {
    const res = (await window.lunacore.getLayouts()) || {};
    layouts = res.layouts || [];
    chosen = res.activeLayout || null;
  } catch {
    layouts = [];
  }

  // A remembered choice beats config's activeLayout, but only if it still
  // exists - a preset can be renamed or removed out from under the prefs file.
  try {
    const prefs = await window.lunacore.getUiPrefs();
    if (prefs && prefs.layout && layouts.some((l) => l.id === prefs.layout)) {
      chosen = prefs.layout;
    }
  } catch {
    /* no preferences - stay on the config's choice */
  }

  if (layouts.length === 0) {
    // loadLayouts() always returns at least its FALLBACK, so an empty list means
    // the IPC call itself failed. Nothing can be drawn; say so loudly rather
    // than leaving a blank grid and no explanation.
    throw new Error('layout: no presets available (layouts:list failed)');
  }
  if (!applyLayout(chosen)) applyLayout(layouts[0].id);
}

/** Switches preset and remembers the choice. Used by the Appearance widget. */
export function selectLayout(id) {
  if (!applyLayout(id)) return false;
  window.lunacore.setUiPrefs({ layout: id });
  return true;
}
