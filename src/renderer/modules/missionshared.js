// ============================================================================
// LunaCore - Mission Control: helpers shared by the mail and calendar widgets
// ----------------------------------------------------------------------------
// The model picker (one pref, missionModel, read by both widgets), the error
// reason -> i18n key table, and the "$0.04" cost suffix. Every job result from
// main carries `costUsd`, and showing it is the point: these are real model
// calls, and the user should see what a scan costs before making it a habit.
// ============================================================================

'use strict';

import { t } from './util.js';

const ERROR_KEYS = {
  'no-claude': 'mc.err.noClaude',
  timeout: 'mc.err.timeout',
  'bad-json': 'mc.err.badJson',
  'cli-error': 'mc.err.cli',
  busy: 'mc.err.busy',
  'nothing-approved': 'mc.err.nothingApproved',
  'bad-draft': 'mc.err.badDraft',
  'not-created': 'mc.err.notCreated',
  'maybe-created': 'mc.err.maybeCreated',
  empty: 'mc.err.empty',
  'bad-range': 'mc.err.badRange',
  'gcal-no-client': 'mc.err.gcalNoClient',
  'gcal-not-connected': 'mc.err.gcalNotConnected',
  'gcal-auth': 'mc.err.gcalAuth',
  'gcal-denied': 'mc.err.gcalDenied',
  'gcal-timeout': 'mc.err.gcalTimeout',
  'gcal-network': 'mc.err.gcalNetwork',
  'gcal-failed': 'mc.err.gcalFailed',
  generic: 'mc.err.generic',
};

/** Human message for a failed job's `reason`; unknown reasons -> generic. */
export function errorText(reason) {
  return t(ERROR_KEYS[reason] || ERROR_KEYS.generic);
}

/** " · $0.04" when a cost is known, '' otherwise. */
export function costSuffix(costUsd) {
  return typeof costUsd === 'number' ? ` · $${costUsd.toFixed(costUsd < 0.01 ? 4 : 2)}` : '';
}

/**
 * Fills a <select> with the allowed models and persists a change to the
 * missionModel pref. Main re-checks the value, so this is convenience only.
 * @param {HTMLSelectElement} select
 * @param {{model:string, models:string[]}} config
 */
export function bindModelSelect(select, config) {
  select.replaceChildren(
    ...config.models.map((m) => {
      const opt = document.createElement('option');
      opt.value = m;
      opt.textContent = m.charAt(0).toUpperCase() + m.slice(1);
      return opt;
    })
  );
  select.value = config.model;
  select.addEventListener('change', () => {
    window.lunacore.setUiPrefs({ missionModel: select.value }).catch(() => {
      // Pref write failed - the select still shows the choice for this mount,
      // and main keeps using the last persisted model; nothing to undo.
    });
  });
}

/**
 * .catch() handler for a mission IPC call: logs the real error for debugging
 * and hands the widget the same typed failure main would have sent.
 */
export function ipcFailed(err) {
  console.error('[mission] ipc failed:', err && err.message);
  return { ok: false, reason: 'generic' };
}

/** Status line helper: text + an error modifier the CSS colours. */
export function setStatus(el, text, isError = false) {
  el.textContent = text;
  el.classList.toggle('is-fail', isError);
}
