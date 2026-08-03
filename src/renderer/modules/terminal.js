// ============================================================================
// LunaCore - the `terminal` widget (A2f): the center panel
// ----------------------------------------------------------------------------
// One root, FOUR owning modules - terminals.js (the xterm host), led.js (the
// working/waiting indicator), sessions.js (the tab bar) and palette.js (the
// Ctrl+K chip). None of the four may import each other in a way that would
// cycle back here, which is exactly why this composition lives in its own
// file instead of inside terminals.js: sessions.js and palette.js already
// import FROM terminals.js.
//
// UNLIKE every other widget, this one's mount() must only ever run ONCE. Its
// children are live xterm.Terminal instances wired to real PTY child
// processes (terminals.js's ensureTerm/termsBySession) - a remount would clone
// a brand-new EMPTY host from the template and orphan every running session's
// DOM from its buffer, which would look like every tab silently vanished while
// its process kept running headless. `remountable: false` tells host.js to
// refuse a remount instead of doing that; see FUTURE_PLAN.md §A2f.
// ============================================================================

'use strict';

import { defineWidget } from './registry.js';
import { mountTerminalHost } from './terminals.js';
import { mountLed } from './led.js';
import { mountTabs } from './sessions.js';
import { mountPaletteChip } from './palette.js';

defineWidget({
  id: 'terminal',
  titleKey: '',
  template: 'w-terminal',
  remountable: false,
  mount(root) {
    mountTerminalHost(root);
    mountLed(root);
    mountTabs(root);
    mountPaletteChip(root);
    // No cleanup: this widget is never meant to unmount (see header).
  },
});
