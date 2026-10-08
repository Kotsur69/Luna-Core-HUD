// ============================================================================
// LunaCore - Mission Control panel (Ctrl+`)
// ----------------------------------------------------------------------------
// A full-screen overlay that hosts the Mission Control widgets side by side,
// instead of squeezing them into a layout region. The widgets themselves are
// unchanged: open() mounts them through host.js into the overlay's columns,
// close() unmounts them. Their module state (last scan, ticks, agenda, draft)
// survives that, so closing and reopening the panel never re-bills a model
// call.
//
// Ctrl+` is matched on e.code ('Backquote'), not e.key: the physical key is
// what the user learns, and e.key differs between keyboard layouts. Nothing
// else in the renderer or main.js's before-input-event handler claims it.
// ============================================================================

'use strict';

import { mountWidget, unmountWidget, isMounted } from './host.js';
import { closeWithExit, cancelExit } from './motion.js';

// Column id in index.html -> widget id. Order is visual order.
const COLUMNS = [
  ['mission-col-mail', 'mailcleanup'],
  ['mission-col-cal', 'calendar'],
];

const overlayEl = document.getElementById('mission');
let isOpen = false;
let returnFocus = null;

function open() {
  if (isOpen) return;
  cancelExit(overlayEl);
  isOpen = true;
  returnFocus = document.activeElement;
  for (const [colId, widgetId] of COLUMNS) {
    // A widget placed in a custom layout as well keeps its layout copy; the
    // ids inside its template are single-instance, so mounting it twice would
    // make both copies fight over the same elements.
    if (isMounted(widgetId)) continue;
    mountWidget(widgetId, document.getElementById(colId));
  }
  overlayEl.hidden = false;
  overlayEl.focus();
}

function close() {
  if (!isOpen) return;
  isOpen = false;
  closeWithExit(overlayEl);
  for (const [colId, widgetId] of COLUMNS) {
    const col = document.getElementById(colId);
    // Only take down what this panel mounted, never a layout copy.
    if (col.querySelector(`[data-widget="${widgetId}"]`)) unmountWidget(widgetId);
  }
  if (returnFocus && typeof returnFocus.focus === 'function') returnFocus.focus();
  returnFocus = null;
}

overlayEl.addEventListener('click', (e) => {
  if (e.target.hasAttribute('data-mission-close')) close();
});

// Capture phase, to get ahead of xterm.js - same as Ctrl+K / Ctrl+B. Escape is
// handled here too rather than on the overlay: focus is not guaranteed to be
// inside the panel (the terminal can take it back during startup), and an
// open panel must close on Escape regardless.
window.addEventListener(
  'keydown',
  (e) => {
    if (isOpen && e.key === 'Escape') {
      // The calendar draft owns Escape inside itself (cancel the draft).
      if (e.target instanceof Element && e.target.closest('#mc-cal-draft')) return;
      e.preventDefault();
      e.stopPropagation();
      close();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.code === 'Backquote') {
      e.preventDefault();
      e.stopPropagation();
      if (isOpen) close();
      else open();
    }
  },
  true
);
