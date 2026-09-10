// ============================================================================
// LunaCore - the keyboard-shortcut overlay (Ctrl+/)
// ----------------------------------------------------------------------------
// The fourth overlay in the Ctrl+K / Ctrl+L / Ctrl+G family, and the thinnest
// of them: it opens, prints the list modules/shortcuts.js owns, and closes.
// Nothing in here is editable or firable, so the only keys it claims are the
// toggle and Escape.
//
// WHY its own overlay. Ctrl+/ used to open Settings and scroll to a section at
// the bottom of it (2026-09-10, the first cut). Reaching a read-only reference
// by opening the panel full of live controls reads as "the wrong thing opened"
// - and the chord had no chip, so it was invisible unless you already knew it.
// Now it is a sibling of the other three: its own overlay, its own chip in the
// terminal bar, and Settings no longer carries the section at all.
//
// Mirrors gitquick.js's shape exactly (static markup in index.html, global
// keydown capture for the toggle, backdrop click + Escape to close, chip
// mounted from the terminal widget), and reuses .palette's CSS the same way.
//
// The LIST itself still lives in shortcuts.js - that module stays DOM-free at
// module scope so `node --test` can require() its table and drift guard
// without a document. This file is the DOM half; that one is the data half.
// ============================================================================

'use strict';

import { term } from './terminals.js';
import { mountShortcuts } from './shortcuts.js';
import { closeWithExit, cancelExit } from './motion.js';

const shortcutsEl = document.getElementById('shortcuts');

let shortcutsOpen = false;
/** The row list is built once, on first open - it is static data, and paying
 *  for it at boot would be work for an overlay most sessions never open.
 *  mountShortcuts() also subscribes to onLangChange, so once is enough. */
let mounted = false;

function openShortcutsPanel() {
  if (shortcutsOpen) return;
  shortcutsOpen = true;
  cancelExit(shortcutsEl);
  shortcutsEl.hidden = false;
  if (!mounted) {
    mountShortcuts(shortcutsEl);
    mounted = true;
  }
  // Same reason as openGitQuick(): the overlay is a plain <div>, so until it
  // holds focus its own keydown (Escape, below) never fires and the keys keep
  // going into the terminal. Needs the tabindex="-1" in index.html.
  shortcutsEl.focus();
  // The body scrolls, and a reopen should start at the top rather than
  // wherever the last visit left it.
  const body = shortcutsEl.querySelector('#shortcuts-list');
  if (body) body.scrollTop = 0;
}

function closeShortcutsPanel() {
  if (!shortcutsOpen) return;
  shortcutsOpen = false;
  closeWithExit(shortcutsEl);
}

shortcutsEl.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    e.preventDefault();
    closeShortcutsPanel();
    term.focus();
  }
});

shortcutsEl.addEventListener('click', (e) => {
  if (e.target.hasAttribute('data-shortcuts-close')) { closeShortcutsPanel(); term.focus(); }
});

// The chip in the terminal bar opens the list.
/** Called once by the `terminal` widget's mount() - see modules/terminal.js. */
export function mountShortcutsChip(root) {
  const btn = root.querySelector('#shortcuts-open');
  if (btn) btn.addEventListener('click', openShortcutsPanel);
}

// Global Ctrl/Cmd+/ (capture, to get ahead of xterm.js) - same tradeoff and
// precedent as palette.js's Ctrl+K, termcustom.js's Ctrl+L and gitquick.js's
// Ctrl+G (it shadows readline's Ctrl+_ undo while LunaCore has focus).
// `!e.shiftKey` keeps Ctrl+Shift+/ free; on the layouts where "/" is itself a
// shifted key the chord will not fire, which is what the chip is there for.
window.addEventListener(
  'keydown',
  (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key === '/') {
      e.preventDefault();
      e.stopPropagation();
      if (shortcutsOpen) { closeShortcutsPanel(); term.focus(); }
      else openShortcutsPanel();
    }
  },
  true
);
