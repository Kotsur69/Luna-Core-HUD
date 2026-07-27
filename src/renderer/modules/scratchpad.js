// ============================================================================
// LunaCore - scratchpad (local notepad)
// ----------------------------------------------------------------------------
// Autosaves to config/scratchpad.local.md (gitignored) after a pause in typing,
// not on every keystroke. "Paste into session" deliberately does NOT send, so
// you can still add to it.
//
// A2: second block converted to the widget contract. Unlike `ports`, this
// widget holds no state outside the DOM itself - the text lives in the
// textarea, not a module variable - so a remount just re-fetches it from disk.
// The one thing worth getting right on unmount is the pending debounce: if a
// widget were torn down mid-pause, clearing the timer without saving would
// silently drop the last edit. cleanup() flushes it instead.
// ============================================================================

'use strict';

import { t, pulse } from './util.js';
import { term } from './terminals.js';
import { defineWidget } from './registry.js';

const PAD_SAVE_MS = 500;

// Elements of the current mount, or null when this widget is not on screen.
let els = null;
let padTimer = null;

defineWidget({
  id: 'scratchpad',
  titleKey: 'pad.title',
  template: 'w-scratchpad',
  mount(root) {
    els = {
      text: root.querySelector('#pad-text'),
      status: root.querySelector('#pad-status'),
      send: root.querySelector('#pad-send'),
    };

    window.lunacore
      .getScratchpad()
      .then((text) => {
        if (els) els.text.value = typeof text === 'string' ? text : '';
      })
      .catch(() => {
        // missing file / read error - leave the notepad empty (non-blocking)
      });

    els.text.addEventListener('input', () => {
      els.status.textContent = '·';
      clearTimeout(padTimer);
      padTimer = setTimeout(async () => {
        const ok = await window.lunacore.saveScratchpad(els.text.value);
        if (els) els.status.textContent = ok ? t('pad.saved') : t('pad.saveError');
      }, PAD_SAVE_MS);
    });

    els.send.addEventListener('click', () => {
      const text = els.text.value.trim();
      if (!text) return;
      window.lunacore.pastePrompt(text, false);
      pulse(els.send);
      term.focus();
    });

    return () => {
      // Flush a pending debounce rather than dropping the last edit on unmount.
      if (padTimer) {
        clearTimeout(padTimer);
        window.lunacore.saveScratchpad(els.text.value).catch(() => {});
        padTimer = null;
      }
      els = null;
    };
  },
});
