// ============================================================================
// LunaCore - scratchpad (local notepad)
// ----------------------------------------------------------------------------
// Autosaves to config/scratchpad.local.md (gitignored) after a pause in typing,
// not on every keystroke. "Paste into session" deliberately does NOT send, so
// you can still add to it.
// ============================================================================

'use strict';

import { t, pulse } from './util.js';
import { term } from './terminals.js';

const PAD_SAVE_MS = 500;

const padText = document.getElementById('pad-text');
const padStatus = document.getElementById('pad-status');
const padSend = document.getElementById('pad-send');

let padTimer = null;

export function initScratchpad() {
  window.lunacore
    .getScratchpad()
    .then((text) => {
      padText.value = typeof text === 'string' ? text : '';
    })
    .catch(() => {
      // missing file / read error - leave the notepad empty (non-blocking)
    });
}

padText.addEventListener('input', () => {
  padStatus.textContent = '·';
  clearTimeout(padTimer);
  padTimer = setTimeout(async () => {
    const ok = await window.lunacore.saveScratchpad(padText.value);
    padStatus.textContent = ok ? t('pad.saved') : t('pad.saveError');
  }, PAD_SAVE_MS);
});

padSend.addEventListener('click', () => {
  const text = padText.value.trim();
  if (!text) return;
  window.lunacore.pastePrompt(text, false);
  pulse(padSend);
  term.focus();
});
