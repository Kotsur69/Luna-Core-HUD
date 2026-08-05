// ============================================================================
// LunaCore - widget host (A2)
// ----------------------------------------------------------------------------
// The DOM half of the widget contract: takes a registered widget and puts it in
// a slot, or takes it back out.
//
// Two decisions worth knowing about.
//
// 1. MARKUP STAYS IN index.html, inside <template>. It would have been possible
//    to build every block with createElement, but that throws away the
//    data-i18n attributes, the CSS class names and the ability to read the HUD's
//    structure as HTML. A template is cloned on mount, so the live DOM is
//    identical to what the static markup produced - which is why this refactor
//    needs no CSS changes at all.
//
// 2. THE WIDGET ROOT IS THE TEMPLATE'S OWN ELEMENT, not a wrapper this file
//    adds. An extra <div> around a .panel__section would be one more level for
//    the panel's flex layout to trip over. Hence the "exactly one root element"
//    rule below.
//
// The contract for widget authors:
//   * mount(root) may return a cleanup function; everything it subscribed to,
//     timers included, must be undone there. Listeners bound to elements INSIDE
//     root need no cleanup - the subtree goes with them.
//   * mount(root) must scope every lookup to root (root.querySelector), never
//     document.getElementById. Ids only exist once mounted.
// ============================================================================

'use strict';

import { getWidget } from './registry.js';

/** id -> { root, cleanup } for everything currently on screen. */
const mounted = new Map();

/**
 * Widgets whose placeholder is nested INSIDE another widget's template, keyed by
 * the widget that owns it.
 *
 * `autocompact` lives in [data-slot="autocompact"] inside w-actions, so it has
 * no place of its own: it cannot be positioned by a layout, and - the reason
 * this map is here rather than in layout.js - it cannot survive its host being
 * rebuilt. Anything that takes `actions` down has to take autocompact with it
 * and put it back afterwards; see remountWidget().
 */
export const NESTED = Object.freeze({ autocompact: 'actions' });

/** Mounted widgets nested inside `id`'s subtree. */
function nestedIn(id) {
  return Object.keys(NESTED).filter((n) => NESTED[n] === id && mounted.has(n));
}

/**
 * Builds a widget's root element from its <template>, or an empty section when
 * the widget has none and builds its own DOM.
 */
function buildRoot(widget) {
  if (!widget.template) {
    const root = document.createElement('div');
    root.className = 'panel__section';
    return root;
  }
  const tpl = document.getElementById(widget.template);
  if (!tpl || !tpl.content) {
    throw new Error(`widget "${widget.id}": no <template id="${widget.template}">`);
  }
  const frag = tpl.content.cloneNode(true);
  const root = frag.firstElementChild;
  if (!root || frag.children.length !== 1) {
    throw new Error(`widget "${widget.id}": template must hold exactly one root element`);
  }
  return root;
}

/**
 * Mounts a widget into a slot.
 * @param {string} id registered widget id
 * @param {Element} slot container to mount into
 * @param {{before?: Element|null}} [opts] insert before this sibling (append if null)
 * @returns {Element} the widget's root element
 */
export function mountWidget(id, slot, { before = null } = {}) {
  const widget = getWidget(id);
  if (!widget) throw new Error(`unknown widget "${id}"`);
  if (mounted.has(id)) throw new Error(`widget "${id}" is already mounted`);
  if (!slot) throw new Error(`widget "${id}": no slot to mount into`);

  const root = buildRoot(widget);
  root.dataset.widget = widget.id;
  slot.insertBefore(root, before);

  // Translate the fresh subtree. applyStatic() runs over the whole document on
  // a language switch, but this markup did not exist at that point - and on a
  // remount it comes back out of the template in its authored language.
  window.i18n.applyStatic(root);

  let cleanup = null;
  try {
    const result = widget.mount(root);
    if (typeof result === 'function') cleanup = result;
  } catch (err) {
    // A widget that failed to mount must not leave half of itself on screen.
    root.remove();
    throw err;
  }

  mounted.set(id, { root, cleanup });
  return root;
}

/**
 * Unmounts a widget. Safe to call on something that is not mounted.
 * @returns {boolean} whether anything was taken down
 */
export function unmountWidget(id) {
  const rec = mounted.get(id);
  if (!rec) return false;

  // Drop the record FIRST: a cleanup that (directly or not) remounts this
  // widget would otherwise see it as still mounted and throw.
  mounted.delete(id);
  try {
    if (rec.cleanup) rec.cleanup();
  } finally {
    rec.root.remove();
  }
  return true;
}

/**
 * Takes a widget down and puts it back in the SAME place.
 *
 * This is the only routine that actually exercises unmount(), and it is why it
 * exists: nothing in the HUD is ever torn down during normal use, so a leaked
 * subscription would stay invisible until Phase C moved a panel - and would then
 * look like a layout bug. Remounting a few times and checking that renders and
 * clicks still happen ONCE is the real test of this contract.
 */
export function remountWidget(id) {
  const rec = mounted.get(id);
  if (!rec) return false;
  const widget = getWidget(id);
  if (widget && widget.remountable === false) {
    // `terminal` (A2f): a remount would clone a fresh, empty host and orphan
    // every running session's live xterm buffer from the DOM. Refuse instead
    // of doing that - see FUTURE_PLAN.md §A2f.
    console.warn(`widget "${id}": remount is unsupported for this widget - ignored`);
    return false;
  }
  const slot = rec.root.parentNode;
  const before = rec.root.nextElementSibling;

  // A nested widget's DOM lives inside this one's subtree, and mountWidget()
  // below clones a FRESH template whose nested placeholder is empty. Without
  // this, remounting `actions` would leave `autocompact` registered as mounted
  // while its root sits in a detached subtree nothing can reach - the toggle
  // just disappears, and the widget goes on subscribing from off-screen.
  const nested = nestedIn(id);
  for (const n of nested) unmountWidget(n);

  unmountWidget(id);
  mountWidget(id, slot, { before });
  for (const n of nested) mountIntoSlot(n);
  return true;
}

/** Is this widget on screen right now? */
export function isMounted(id) {
  return mounted.has(id);
}

/**
 * The live root element of a mounted widget, or null.
 *
 * C1 needs this because switching layouts MOVES roots between regions instead
 * of remounting them: a DOM move keeps the subtree - and therefore `terminal`'s
 * running xterm instances (A2f) - intact, so one code path is safe for every
 * widget. Nothing else should reach for a widget's DOM from outside.
 */
export function widgetRoot(id) {
  const rec = mounted.get(id);
  return rec ? rec.root : null;
}

/** Ids of everything currently mounted, in mount order. */
export function mountedWidgets() {
  return [...mounted.keys()];
}

/**
 * Mounts a widget into the placeholder that marks its spot in index.html.
 *
 * Transitional: while most blocks are still static markup, a converted widget
 * has to land in exactly the right position among its unconverted neighbours.
 * `.widget-slot` is `display: contents`, so the placeholder itself contributes
 * nothing to layout and the widget behaves as a direct child of the panel.
 * Phase C replaces this with real, named layout slots.
 */
export function mountIntoSlot(id) {
  const slot = document.querySelector(`[data-slot="${id}"]`);
  if (!slot) throw new Error(`widget "${id}": no [data-slot="${id}"] in the page`);
  return mountWidget(id, slot);
}
