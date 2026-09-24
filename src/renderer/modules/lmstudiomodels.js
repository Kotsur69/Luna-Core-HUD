// ============================================================================
// LunaCore - LM Studio model picker (Settings overlay)
// ----------------------------------------------------------------------------
// The in-app replacement for the external "go local claude" desktop script:
// lists every model DOWNLOADED to disk and loads one on click. Main side is
// src/lmstudiosdk.js (the official LM Studio SDK; the `lms` CLI only wakes LM
// Studio when it is down) - NOT src/lmstudio.js's passive HTTP watcher, which
// only ever sees a running server's loaded model. Static markup in the
// Settings overlay (#termcustom), mounted once from termcustom.js's init -
// same shape as autocompact.js's mountAutoCompactSettings(), and the row /
// action-button wiring mirrors diagnostics.js's buildRow() closely.
//
// The pure half (a row's raw inputs -> the load payload) lives in
// lmstudioloadform.js and is unit-tested there.
// ============================================================================

'use strict';

import { t } from './util.js';
import { onLangChange } from './bus.js';
import { formatBytes } from './telemetry.js';
import { blankOptions, buildLoadPayload } from './lmstudioloadform.js';

// Module state survives a remount (the overlay is static markup, so this
// mostly matters for a language switch's repaint, same reasoning as
// diagnostics.js's `report`).
let status = null; // last getLmsCliStatus() result, or null before the first check
let models = []; // last listDownloadedLmStudioModels() result
let loadingList = false;
let loadingModelKey = null; // the one row currently mid-load, or null
let lastLoadResult = null; // { modelKey, ok, reason, field } for the most recent load, or null

// One row's fields, keyed by model key - kept here (not in `models`) so an
// in-progress edit survives the list re-rendering out from under it (every
// status change wipes and rebuilds #lmstudio-models-list, same as
// diagnostics.js's report repaint).
const modelOptions = new Map();
let optionsOpenKey = null; // the one row whose options panel is expanded, or null

function optionsFor(modelKey) {
  if (!modelOptions.has(modelKey)) modelOptions.set(modelKey, blankOptions());
  return modelOptions.get(modelKey);
}

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

/** The label for a load-failure result returned by loadLmStudioModel(). */
function loadFailedLabel(result) {
  const reason = result && result.reason;
  if (reason === 'timeout') return t('lmstudio.load.timeout');
  if (reason === 'busy') return t('lmstudio.load.busy');
  if (reason === 'not-running') return t('lmstudio.load.notRunning');
  if (reason === 'unknown-model') return t('lmstudio.load.unknownModel');
  if (reason === 'invalid-option') return t('lmstudio.load.invalid', { field: result.field || '' });
  return t('lmstudio.load.failed');
}

/** One labeled field for the options panel below. */
function optionField(labelKey, input) {
  const box = document.createElement('label');
  box.className = 'diag-item__opt';
  const span = document.createElement('span');
  span.textContent = t(labelKey);
  box.append(span, input);
  return box;
}

/** A number input bound to one option field of one row. */
function numberInput(model, field, { min, max, step, placeholderKey, placeholder }) {
  const input = document.createElement('input');
  input.type = 'number';
  if (min !== undefined) input.min = String(min);
  if (max !== undefined) input.max = String(max);
  input.step = String(step);
  input.placeholder = placeholder || t(placeholderKey || 'lmstudio.options.auto');
  input.value = optionsFor(model.key)[field];
  input.dataset.optField = field;
  input.dataset.modelKey = model.key;
  return input;
}

/** A <select> bound to one option field of one row. */
function selectInput(model, field, choices) {
  const select = document.createElement('select');
  select.dataset.optField = field;
  select.dataset.modelKey = model.key;
  const current = optionsFor(model.key)[field];
  for (const [value, label] of choices) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = label;
    if (value === current) opt.selected = true;
    select.appendChild(opt);
  }
  return select;
}

/**
 * The load-options panel for one row (collapsed by default - see
 * optionsOpenKey). Every field starts blank/'auto': "let LM Studio decide"
 * is expressed by omitting the option entirely (lmstudioloadform.js).
 */
function buildOptionsPanel(model) {
  const opts = optionsFor(model.key);
  const wrap = document.createElement('div');
  wrap.className = 'diag-item__options';

  const gpuSelect = selectInput(model, 'gpu', [
    ['auto', t('lmstudio.options.gpu.auto')],
    ['off', t('lmstudio.options.gpu.off')],
    ['max', t('lmstudio.options.gpu.max')],
    ['custom', t('lmstudio.options.gpu.custom')],
  ]);
  const gpuRatioInput = numberInput(model, 'gpuRatio', { min: 0, max: 1, step: 0.05, placeholder: '0.50' });
  gpuRatioInput.disabled = opts.gpu !== 'custom';

  const idInput = document.createElement('input');
  idInput.type = 'text';
  idInput.placeholder = model.key;
  idInput.value = opts.identifier;
  idInput.dataset.optField = 'identifier';
  idInput.dataset.modelKey = model.key;

  const onOff = [
    ['auto', t('lmstudio.options.auto')],
    ['on', t('lmstudio.options.on')],
    ['off', t('lmstudio.options.off')],
  ];
  const kvChoices = [['auto', t('lmstudio.options.auto')], ['f16', 'f16'], ['q8_0', 'q8_0'], ['q4_0', 'q4_0']];

  const threadsHint = document.createElement('p');
  threadsHint.className = 'hint';
  threadsHint.textContent = t('lmstudio.options.threadsHint');

  wrap.append(
    optionField('lmstudio.options.contextLength', numberInput(model, 'contextLength', { min: 256, step: 1 })),
    optionField('lmstudio.options.gpu', gpuSelect),
    optionField('lmstudio.options.gpuRatio', gpuRatioInput),
    optionField('lmstudio.options.expertOffload', numberInput(model, 'expertOffload', { min: 0, max: 1, step: 0.05 })),
    optionField('lmstudio.options.flashAttention', selectInput(model, 'flashAttention', onOff)),
    optionField('lmstudio.options.kvCache', selectInput(model, 'kvCacheType', kvChoices)),
    optionField('lmstudio.options.evalBatch', numberInput(model, 'evalBatchSize', { min: 32, step: 32 })),
    optionField('lmstudio.options.parallel', numberInput(model, 'parallel', { min: 1, step: 1 })),
    optionField('lmstudio.options.ttl', numberInput(model, 'ttlSeconds', { min: 1, step: 1, placeholderKey: 'lmstudio.options.never' })),
    optionField('lmstudio.options.identifier', idInput),
    threadsHint,
  );
  return wrap;
}

function buildModelRow(model) {
  const li = document.createElement('li');
  li.className = 'diag-item';

  const head = document.createElement('span');
  head.className = 'diag-item__head';

  const dot = document.createElement('span');
  dot.className = `diag-item__dot ${model.loaded ? 'diag-item__dot--ok' : 'diag-item__dot--unknown'}`;
  if (model.loaded) dot.title = t('lmstudio.loaded');

  const label = document.createElement('span');
  label.className = 'diag-item__label';
  label.textContent = model.displayName;

  head.append(dot, label);

  const isOpen = optionsOpenKey === model.key;
  const toggleBtn = document.createElement('button');
  toggleBtn.type = 'button';
  toggleBtn.className = 'diag-item__action diag-item__action--ghost';
  toggleBtn.dataset.optionsToggle = model.key;
  toggleBtn.setAttribute('aria-expanded', String(isOpen));
  toggleBtn.textContent = isOpen ? t('lmstudio.options.hide') : t('lmstudio.options.show');
  head.appendChild(toggleBtn);

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
  const parts = [describeModel(model)];
  if (model.loaded) parts.push(t('lmstudio.loaded'));
  if (!isThisLoading && lastLoadResult && lastLoadResult.modelKey === model.key) {
    parts.push(lastLoadResult.ok ? t('lmstudio.load.done') : loadFailedLabel(lastLoadResult));
  }
  detail.textContent = parts.filter(Boolean).join(' — ');

  li.append(head, detail);
  if (isOpen) li.appendChild(buildOptionsPanel(model));
  return li;
}

/** Repaints the status line: running / can be woken / unavailable. */
function renderStatus() {
  if (!els) return;
  if (!status) {
    els.status.textContent = t('lmstudio.status.checking');
    return;
  }
  if (status.ok) {
    els.status.textContent = status.running ? t('lmstudio.status.running') : t('lmstudio.status.canWake');
    return;
  }
  els.status.textContent = t('lmstudio.status.notRunning');
}

/** Repaints the model list (or the matching empty/loading/error state). */
function renderModels() {
  if (!els) return;
  els.list.innerHTML = '';

  if (!status || !status.ok) {
    els.empty.style.display = '';
    els.empty.textContent = status ? t('lmstudio.status.notRunning') : t('lmstudio.status.checking');
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

let fetchSeq = 0; // only the newest list request may write `models`

/** Re-fetches the model list (with loaded marks) and the running flag. */
async function fetchModels() {
  const seq = ++fetchSeq;
  let result;
  try {
    result = await window.lunacore.listDownloadedLmStudioModels();
  } catch {
    result = null;
  }
  if (seq !== fetchSeq) return;
  const ok = Boolean(result && result.ok);
  models = ok && Array.isArray(result.models) ? result.models : [];
  // Listing wakes LM Studio when needed, so the list outcome is the freshest
  // answer to "is it running" - in both directions.
  if (status && status.ok) status = { ...status, running: ok };
}

/** First load and the refresh button's action: re-checks LM Studio and re-lists. */
async function refreshStatusAndList() {
  loadingList = true;
  render();

  try {
    status = await window.lunacore.getLmsCliStatus();
  } catch {
    status = { ok: false, reason: 'error' };
  }

  if (status && status.ok) await fetchModels();
  else models = [];

  loadingList = false;
  render();
}

/** The actual "change settings from here" action this panel exists for. */
async function loadSelectedModel(modelKey) {
  if (!modelKey || loadingModelKey) return;
  loadingModelKey = modelKey;
  lastLoadResult = null;
  renderModels();

  const replaceLoaded = !els || !els.replaceLoaded || els.replaceLoaded.checked;
  const payload = buildLoadPayload(modelKey, optionsFor(modelKey), { replaceLoaded });
  let result;
  try {
    result = await window.lunacore.loadLmStudioModel(payload);
  } catch {
    result = { ok: false, reason: 'error' };
  }

  loadingModelKey = null;
  lastLoadResult = { modelKey, ok: !!(result && result.ok), reason: result && result.reason, field: result && result.field };
  // Refresh the loaded marks: a load may also have unloaded other models.
  await fetchModels();
  render();
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
    replaceLoaded: root.querySelector('#lmstudio-replace-loaded'),
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
  // every row repaint instead of rebinding per-button. The options toggle
  // is checked FIRST - it also matches `.diag-item__action` (same visual
  // family) but must never trigger a load.
  els.list.addEventListener('click', (e) => {
    const toggle = e.target.closest('[data-options-toggle]');
    if (toggle) {
      const key = toggle.dataset.optionsToggle;
      optionsOpenKey = optionsOpenKey === key ? null : key;
      renderModels();
      return;
    }
    const btn = e.target.closest('.diag-item__action');
    if (!btn || btn.disabled || !btn.dataset.modelKey) return;
    loadSelectedModel(btn.dataset.modelKey);
  });

  // Options-panel fields write straight into the modelOptions map, keyed by
  // model - no re-render on every keystroke (that would rebuild the row out
  // from under the input the user is still typing in and drop focus). The
  // gpu <select> is the one exception: it must re-enable/disable the ratio
  // field next to it, which is done directly rather than via a full repaint.
  const handleOptionEdit = (e) => {
    const field = e.target.dataset && e.target.dataset.optField;
    if (!field) return;
    const opts = optionsFor(e.target.dataset.modelKey);
    opts[field] = e.target.value;
    if (field === 'gpu') {
      const panel = e.target.closest('.diag-item__options');
      const ratioInput = panel && panel.querySelector('[data-opt-field="gpuRatio"]');
      if (ratioInput) ratioInput.disabled = opts.gpu !== 'custom';
    }
  };
  els.list.addEventListener('input', handleOptionEdit);
  els.list.addEventListener('change', handleOptionEdit);

  const offLang = onLangChange(render);

  refreshStatusAndList();

  return () => {
    offLang();
    els = null;
  };
}
