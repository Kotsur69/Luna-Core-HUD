// ============================================================================
// LunaCore - pty status line (left panel footer)
// ----------------------------------------------------------------------------
// State is kept semantically (an i18n key plus params) rather than as finished
// text, so switching the language re-renders it correctly.
// ============================================================================

'use strict';

import { t } from './util.js';
import { onLangChange } from './bus.js';

const dot = typeof document !== 'undefined' ? document.getElementById('pty-status-dot') : null;
const label = typeof document !== 'undefined' ? document.getElementById('pty-status-text') : null;

let ptyStatusState = { live: true, key: 'ptystatus.connecting', params: {} };
let ptyVersion = '';

/**
 * Combines the localized PTY status string with the app version (e.g.
 * "PTY: active · v0.33.0"). Pure, exported for tests.
 */
export function formatPtyStatus(statusText, version) {
  const base = typeof statusText === 'string' ? statusText : '';
  const ver = typeof version === 'string' ? version.trim().replace(/^v/i, '') : '';
  if (!ver) return base;
  return base ? `${base} · v${ver}` : `v${ver}`;
}

export function setPtyVersion(version) {
  ptyVersion = typeof version === 'string' ? version.trim() : '';
  renderPtyStatus();
}

export function setPtyStatus(isLive, key, params = {}) {
  ptyStatusState = { live: isLive, key, params };
  renderPtyStatus();
}

export function renderPtyStatus() {
  if (dot) {
    dot.classList.toggle('dot--live', ptyStatusState.live);
    dot.classList.toggle('dot--dead', !ptyStatusState.live);
  }
  if (label && typeof window !== 'undefined' && window.i18n) {
    label.textContent = formatPtyStatus(t(ptyStatusState.key, ptyStatusState.params), ptyVersion);
  }
}

onLangChange(renderPtyStatus);

// Populate the app version once from main (update:status -> app.getVersion()).
if (typeof window !== 'undefined' && window.lunacore && typeof window.lunacore.getUpdateStatus === 'function') {
  Promise.resolve(window.lunacore.getUpdateStatus())
    .then((status) => {
      if (status && typeof status.version === 'string' && status.version) {
        setPtyVersion(status.version);
      }
    })
    .catch(() => {
      /* IPC unavailable - keep showing the status text without a version suffix */
    });
}
