// ============================================================================
// LunaCore - Memory panel widget (opens Inbox / Review / All / Graveyard)
// ----------------------------------------------------------------------------
// Gives direct one-click access to the Memory window (modules/memoryinbox.js)
// from the HUD sidebar, even when the notification Hub has no pending items.
// ============================================================================

'use strict';

import { defineWidget } from './registry.js';
import { openMemoryInbox } from './memoryinbox.js';

defineWidget({
  id: 'memory',
  titleKey: 'mem.panel.title',
  template: 'w-memory',
  mount(root) {
    const btn = root.querySelector('#memory-open-btn');
    if (btn) {
      btn.addEventListener('click', () => {
        openMemoryInbox();
      });
    }
    return () => {};
  },
});
