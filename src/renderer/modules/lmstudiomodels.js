// ============================================================================
// LunaCore - LM Studio model picker (Settings overlay)
// ----------------------------------------------------------------------------
// The in-app replacement for the external "go local claude" desktop script:
// lists every model DOWNLOADED to disk (via the `lms` CLI, src/lmstudiocli.js
// on the main side - NOT src/lmstudio.js's passive HTTP watcher, which only
// ever sees a currently-running server's loaded model) and force-loads one on
// click. Static markup in the Settings overlay (#termcustom), mounted once
// from termcustom.js's init - same shape as autocompact.js's
// mountAutoCompactSettings(), and rows/action-button wiring mirrors
// diagnostics.js's buildRow()/event-delegation pattern closely.
// ============================================================================

'use strict';

import { t } from './util.js';
import { onLangChange } from './bus.js';
import { formatBytes } from './telemetry.js';

// Module state survives a remount (the overlay is static markup, so this
// mostly matters for a language switch's repaint, same reasoning as
// diagnostics.js's `report`).
let status = null; // last getLmsCliStatus() result, or null before the first check
let models = []; // last listDownloadedLmStudioModels() result
let loadingList = false;
let loadingModelKey = null; // the one row currently mid-load, or null
let lastLoadResult = null; // { modelKey, ok, reason } for the most recent load, or null

let els = null;

/** "32B · Q4_K_M · 6.7 GB · ctx 32768" - technical facts, not localized text. */
function describeModel(model) {
  const parts = [];
  if (model.paramsString) parts.push(model.paramsString);
  if (model.quantization) parts.push(model.quantization);
  const size = formatBytes(model.sizeBytes);
  if (size) parts.push(size);
  if (model.maxContextLength) parts.push(`ctx ${model.maxContextLength}`);
  return parts.join(' · ');
}

/** The label for a load-failure reason returned by loadLmStudioModel(). */
function loadFailedLabel(reason) {
  if (reason === 'timeout') return t('lmstudio.load.timeout');
  if (reason === 'busy') return t('lmstudio.load.busy');
  if (reason === 'not-found') return t('lmstudio.status.notFound');
  return t('lmstudio.load.failed');
}

function buildModelRow(model) {
  const li = document.createElement('li');
  li.className = 'diag-item';

  const head = document.createElement('span');
  head.className = 'diag-item__head';

  // No live "currently loaded" signal in this version (that would need
  // `lms ps --json` wired up too) - the dot stays a neutral placeholder so
  // the row still matches diagnostics.js's visual language.
  const dot = document.createElement('span');
  dot.className = 'diag-item__dot diag-item__dot--unknown';

  const label = document.createElement('span');
  label.className = 'diag-item__label';
  label.textContent = model.displayName;

  head.append(dot, label);

  const isThisLoading = loadingModelKey === model.key;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'diag-item__action';
  btn.dataset.modelKey = model.key;
  btn.disabled = loadingModelKey !== null;
  btn.textContent = isThisLoading ? t('lmstudio.load.loading') : t('lmstudio.load.action');
  head.appendChild(btn);

  const detail = document.createElement('span');
  detail.className = 'diag-item__detail';
  let detailText = describeModel(model);
  if (!isThisLoading && lastLoadResult && lastLoadResult.modelKey === model.key) {
    const suffix = lastLoadResult.ok ? t('lmstudio.load.done') : loadFailedLabel(lastLoadResult.reason);
    detailText = detailText ? `${detailText} — ${suffix}` : suffix;
  }
  detail.textContent = detailText;

  li.append(head, detail);
  return li;
}

/** Repaints the CLI-detection status line. */
function renderStatus() {
  if (!els) return;
  if (!status) {
    els.status.textContent = t('lmstudio.status.checking');
    return;
  }
  if (status.ok) {
    els.status.textContent = t('lmstudio.status.ready', { version: status.version || '' });
    return;
  }
  els.status.textContent = status.reason === 'not-found' ? t('lmstudio.status.notFound') : t('lmstudio.status.error');
}

/** Repaints the model list (or the matching empty/loading/error state). */
function renderModels() {
  if (!els) return;
  els.list.innerHTML = '';

  if (!status || !status.ok) {
    els.empty.style.display = '';
    els.empty.textContent = t('lmstudio.status.checking');
    return;
  }
  if (loadingList) {
    els.empty.style.display = '';
    els.empty.textContent = t('lmstudio.list.loading');
    return;
  }
  if (models.length === 0) {
    els.empty.style.display = '';
    els.empty.textContent = t('lmstudio.empty');
    return;
  }

  els.empty.style.display = 'none';
  for (const model of models) {
    els.list.appendChild(buildModelRow(model));
  }
}

function render() {
  renderStatus();
  renderModels();
}

/** First load and the refresh button's action: re-checks `lms` and re-lists. */
async function refreshStatusAndList() {
  loadingList = true;
  render();

  try {
    status = await window.lunacore.getLmsCliStatus();
  } catch {
    status = { ok: false, reason: 'error' };
  }

  if (status && status.ok) {
    try {
      const result = await window.lunacore.listDownloadedLmStudioModels();
      models = result && result.ok && Array.isArray(result.models) ? result.models : [];
    } catch {
      models = [];
    }
  } else {
    models = [];
  }

  loadingList = false;
  render();
}

/** The actual "change settings from here" action this panel exists for. */
async function loadSelectedModel(modelKey) {
  if (!modelKey || loadingModelKey) return;
  loadingModelKey = modelKey;
  lastLoadResult = null;
  renderModels();

  let result;
  try {
    result = await window.lunacore.loadLmStudioModel({ modelKey });
  } catch {
    result = { ok: false, reason: 'error' };
  }

  loadingModelKey = null;
  lastLoadResult = { modelKey, ok: !!(result && result.ok), reason: result && result.reason };
  renderModels();
}

/**
 * Called once from termcustom.js's Settings-overlay init, same pattern as
 * autocompact.js's mountAutoCompactSettings(root).
 * @param {ParentNode} root
 * @returns {() => void} disposer
 */
export function mountLmStudioSettings(root) {
  els = {
    status: root.querySelector('#lmstudio-status'),
    refresh: root.querySelector('#lmstudio-refresh-btn'),
    list: root.querySelector('#lmstudio-models-list'),
    empty: root.querySelector('#lmstudio-models-empty'),
  };
  if (!els.status) {
    els = null;
    return () => {};
  }

  render();

  els.refresh.addEventListener('click', () => {
    refreshStatusAndList();
  });

  // Delegated, same as diagnostics.js's #diag-list: one listener survives
  // every row repaint instead of rebinding per-button.
  els.list.addEventListener('click', (e) => {
    const btn = e.target.closest('.diag-item__action');
    if (!btn || btn.disabled) return;
    loadSelectedModel(btn.dataset.modelKey);
  });

  const offLang = onLangChange(render);

  refreshStatusAndList();

  return () => {
    offLang();
    els = null;
  };
}
