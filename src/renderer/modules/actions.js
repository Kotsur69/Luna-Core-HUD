// ============================================================================
// LunaCore - the physical COMPACT CONTEXT button (Action Injector)
// ----------------------------------------------------------------------------
// Sends exactly "/compact" + Enter to the active session - zero extra tokens
// beyond what the command itself costs.
// ============================================================================

'use strict';

import { pulse } from './util.js';
import { term } from './terminals.js';

const compactBtn = document.getElementById('btn-compact');

compactBtn.addEventListener('click', () => {
  window.lunacore.runCommand('/compact');
  pulse(compactBtn);
  term.focus();
});

/** Armed auto-compact fires the same injector, and flashes the same button. */
export function pulseCompact() {
  pulse(compactBtn);
}
