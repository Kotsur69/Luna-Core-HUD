// ============================================================================
// LunaCore - the physical COMPACT CONTEXT button (Action Injector)
// ----------------------------------------------------------------------------
// Sends exactly "/compact" + Enter to the active session - zero extra tokens
// beyond what the command itself costs.
//
// A2: this widget's template also holds the `autocompact` widget's
// `[data-slot]` (they share the "Akcje" section - see index.html). That makes
// `actions` a mounting DEPENDENCY: renderer.js's WIDGETS list must mount it
// BEFORE `autocompact`, or that nested slot will not exist yet.
// ============================================================================

'use strict';

import { pulse } from './util.js';
import { term } from './terminals.js';
import { defineWidget } from './registry.js';

// Elements of the current mount, or null when this widget is not on screen.
let els = null;

/** Armed auto-compact fires the same injector, and flashes the same button. */
export function pulseCompact() {
  if (!els) return;
  pulse(els.btn);
}

defineWidget({
  id: 'actions',
  titleKey: 'actions.title',
  template: 'w-actions',
  mount(root) {
    els = { btn: root.querySelector('#btn-compact') };

    // Bound inside root, so the host removes it with the subtree - no
    // disposer needed.
    els.btn.addEventListener('click', () => {
      window.lunacore.runCommand('/compact');
      pulse(els.btn);
      term.focus();
    });

    return () => {
      els = null;
    };
  },
});
