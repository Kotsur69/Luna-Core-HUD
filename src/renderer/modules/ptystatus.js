// ============================================================================
// LunaCore - pty status line (left panel footer)
// ----------------------------------------------------------------------------
// State is kept semantically (an i18n key plus params) rather than as finished
// text, so switching the language re-renders it correctly.
// ============================================================================

'use strict';

import { t } from './util.js';
import { onLangChange } from './bus.js';

const dot = document.getElementById('pty-status-dot');
const label = document.getElementById('pty-status-text');

let ptyStatusState = { live: true, key: 'ptystatus.connecting', params: {} };

export function setPtyStatus(isLive, key, params = {}) {
  ptyStatusState = { live: isLive, key, params };
  renderPtyStatus();
}

export function renderPtyStatus() {
  dot.classList.toggle('dot--live', ptyStatusState.live);
  dot.classList.toggle('dot--dead', !ptyStatusState.live);
  label.textContent = t(ptyStatusState.key, ptyStatusState.params);
}

onLangChange(renderPtyStatus);
