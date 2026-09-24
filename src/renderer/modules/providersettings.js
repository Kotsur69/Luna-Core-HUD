// ============================================================================
// LunaCore - AI provider profiles (Settings overlay)
// ----------------------------------------------------------------------------
// Phase 3 of the AI-providers feature: lets Mati add/edit/remove a profile
// built FROM a config/providers.json template (GLM, Kimi, Ollama via CCR, ...)
// entirely from inside LunaCore - no hand-editing config/profiles.local.json.
// Phases 1-2 already built the backend (src/providers.js, src/profiles.js)
// and IPC (profiles:add/update-from-template, profiles:remove, providers:list,
// providers:open-docs) - this module is the UI on top of it. Pure form logic
// (which fields a template needs, building an add/edit payload, mapping a
// failure reason to an i18n key) lives in providerform.js and is unit-tested
// there; everything here is DOM/IPC and is manual-checklist-only, same
// convention as lmstudiomodels.js.
//
// UX: one add/edit form per action, inline INSIDE the list as its own row -
// clicking "Edit" on a profile row replaces it with its edit form; clicking
// the top "Add profile" button inserts a new form row at the top. Only one
// row is ever in form mode at a time (opening one closes the other).
//
// A CCR-routed row also gets "Test connection" (ccr:test-key): main checks
// the profile's stored client key against its own gateway - only the profile
// id crosses IPC - and the row shows what the outcome means.
// ============================================================================

'use strict';

import { t, loc } from './util.js';
import { onLangChange } from './bus.js';
import {
  generatedProfiles,
  templateFields,
  localLaunchState,
  buildAddPayload,
  buildEditPayload,
  failureKey,
  canTestConnection,
  portFromBaseUrl,
  testResultMessage,
} from './providerform.js';
import { refreshProfileList } from './switchers.js';

let templates = []; // getProviders() catalog
let profiles = []; // redacted profiles from getProfiles()
let editingId = null; // profile id whose row is showing the edit form, or null
let adding = false; // whether the top "add new" form row is open
let addTemplateId = ''; // template picked in the add form, kept across re-renders
let saving = false; // guards double-submit while an IPC call is in flight
// Profile id -> {running:true} while ccr:test-key is in flight, then the
// testResultMessage() outcome. Kept across re-renders; dropped on edit/remove
// and whenever the gateway's state changes (ccr:state).
const testResults = new Map();
let els = null;

/** Placeholder only - src/providers.js owns the real default port. */
const DEFAULT_CCR_PORT = 3456;

function findTemplate(id) {
  return templates.find((tpl) => tpl.id === id) || null;
}

/** Shows a transient success message under the add button (providers.saved.add/edit). */
function showStatus(text) {
  if (!els || !els.status) return;
  els.status.hidden = false;
  els.status.classList.remove('is-fail');
  els.status.textContent = text;
}

/** Same spot, styled as a failure - used by removeRow(), which has no per-row form status line of its own. */
function showFailStatus(text) {
  if (!els || !els.status) return;
  els.status.hidden = false;
  els.status.classList.add('is-fail');
  els.status.textContent = text;
}

/** "GLM (Z.ai) - key stored - model glm-5.3" - the row's non-secret detail line. */
function describeProfile(profile) {
  const template = findTemplate(profile.templateId);
  const parts = [template ? loc(template.label) : profile.templateId];
  const fields = templateFields(template);
  if (fields.needsApiKey) parts.push(profile.hasApiKey ? t('providers.item.keySet') : t('providers.item.noKey'));
  if (fields.needsBaseUrl) {
    parts.push(profile.hasBaseUrl ? t('providers.item.baseUrlSet') : t('providers.item.baseUrlMissing'));
  }
  if (fields.showModel && profile.model) parts.push(t('providers.item.model', { model: profile.model }));
  if (profile.isLegacyCcr) parts.push(t('providers.item.legacyCcr'));
  return parts.join(' · ');
}

/** One <label class="ui-field"> wrapping a text/password input. Hidden when `show` is false. */
function buildFieldRow({ show, labelKey, inputType, value, placeholder }) {
  const label = document.createElement('label');
  label.className = 'ui-field';
  if (!show) label.hidden = true;

  const span = document.createElement('span');
  span.className = 'ui-field__label';
  span.textContent = t(labelKey);
  label.appendChild(span);

  const input = document.createElement('input');
  input.type = inputType;
  input.className = 'profile-select';
  input.autocomplete = 'off';
  input.spellcheck = false;
  if (value) input.value = value;
  if (placeholder) input.placeholder = placeholder;
  label.appendChild(input);

  return { wrapper: label, input };
}

/** One switch toggle (same markup as the static Settings switches in index.html). */
function buildSwitchRow({ labelKey, hintKey, checked }) {
  const label = document.createElement('label');
  label.className = 'switch-field';
  label.title = t(hintKey);

  const text = document.createElement('span');
  text.className = 'switch-field__text';
  const name = document.createElement('span');
  name.className = 'switch-field__label';
  name.textContent = t(labelKey);
  const hint = document.createElement('span');
  hint.className = 'switch-field__status';
  hint.textContent = t(hintKey);
  text.append(name, hint);

  const sw = document.createElement('span');
  sw.className = 'switch';
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.className = 'switch__input';
  input.checked = checked;
  const track = document.createElement('span');
  track.className = 'switch__track';
  const thumb = document.createElement('span');
  thumb.className = 'switch__thumb';
  track.appendChild(thumb);
  sw.append(input, track);

  label.append(text, sw);
  return { wrapper: label, input };
}

/**
 * The lean-launch toggles for a local template (LM Studio), or null for any
 * other. `read()` returns the current {shim, leanMcp, leanTools} booleans.
 */
function buildLocalLaunchBlock(state) {
  if (!state) return null;
  const box = document.createElement('div');

  const heading = document.createElement('span');
  heading.className = 'ui-field__label';
  heading.textContent = t('providers.localLaunch.title');
  box.appendChild(heading);

  const rows = {
    shim: buildSwitchRow({ labelKey: 'providers.localLaunch.shim', hintKey: 'providers.localLaunch.shimHint', checked: state.shim }),
    leanMcp: buildSwitchRow({ labelKey: 'providers.localLaunch.leanMcp', hintKey: 'providers.localLaunch.leanMcpHint', checked: state.leanMcp }),
    leanTools: buildSwitchRow({ labelKey: 'providers.localLaunch.leanTools', hintKey: 'providers.localLaunch.leanToolsHint', checked: state.leanTools }),
  };
  for (const row of Object.values(rows)) box.appendChild(row.wrapper);

  const note = document.createElement('p');
  note.className = 'hint';
  note.textContent = t('providers.localLaunch.harnessNote');
  box.appendChild(note);

  const read = () => Object.fromEntries(Object.entries(rows).map(([k, row]) => [k, row.input.checked]));
  return { wrapper: box, read };
}

/** The docs button for one template - hidden whenever it ships no docsUrl. */
function buildDocsButton(template) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'usage-refresh';
  btn.title = t('providers.action.docs');
  btn.textContent = '?';
  btn.hidden = !template || !template.docsUrl;
  btn.addEventListener('click', () => {
    if (template) window.lunacore.openProviderDocs(template.id);
  });
  return btn;
}

/**
 * Builds one inline form row (shared shape for both "add" and "edit"):
 * template note, label/apiKey/baseUrl/model/fastModel fields (only the ones
 * `templateFields(template)` says this template uses), a status line, and
 * Save/Cancel/Docs buttons. The caller supplies `template`, `prefill` values,
 * and what Save should do with the collected field values.
 */
function buildFormRow({ template, prefill, titleKey, titleParams, submitKey, onSave, onCancel }) {
  const li = document.createElement('li');
  li.className = 'diag-item';

  const title = document.createElement('span');
  title.className = 'diag-item__label';
  title.textContent = t(titleKey, titleParams);
  li.appendChild(title);

  const fields = templateFields(template);

  const note = document.createElement('p');
  note.className = 'hint';
  if (template && template.wireVia === 'ccr') note.textContent = t('providers.note.ccr');
  else if (template && template.autoModel) note.textContent = t('providers.note.autoModel');
  else note.hidden = true;
  li.appendChild(note);

  const labelRow = buildFieldRow({
    show: true,
    labelKey: 'providers.form.label',
    inputType: 'text',
    value: prefill.label,
    placeholder: t('providers.form.label.ph'),
  });
  li.appendChild(labelRow.wrapper);

  const apiKeyRow = buildFieldRow({
    show: fields.needsApiKey,
    labelKey: 'providers.form.apiKey',
    inputType: 'password',
    placeholder: prefill.hasApiKey ? t('providers.form.apiKey.keepPh') : t('providers.form.apiKey.ph'),
  });
  li.appendChild(apiKeyRow.wrapper);

  const baseUrlRow = buildFieldRow({
    show: fields.needsBaseUrl,
    labelKey: 'providers.form.baseUrl',
    inputType: 'text',
    placeholder: t('providers.form.baseUrl.ph'),
  });
  li.appendChild(baseUrlRow.wrapper);

  const modelRow = buildFieldRow({
    show: fields.showModel,
    labelKey: 'providers.form.model',
    inputType: 'text',
    value: prefill.model,
    placeholder: t('providers.form.model.ph', { model: (template && template.defaultModel) || '' }),
  });
  li.appendChild(modelRow.wrapper);

  const fastModelRow = buildFieldRow({
    show: fields.showFastModel,
    labelKey: 'providers.form.fastModel',
    inputType: 'text',
    value: prefill.fastModel,
  });
  li.appendChild(fastModelRow.wrapper);

  // Only for CCR templates ({{ccrPort}}): when CCR's own "port taken" fallback
  // picked another port. Text, not number, so junk reaches the invalid-port
  // check instead of silently reading as blank.
  const ccrPortRow = buildFieldRow({
    show: fields.showCcrPort,
    labelKey: 'providers.form.ccrPort',
    inputType: 'text',
    value: prefill.ccrPort,
    // Blank on edit keeps the stored port (main's keep-current rule), so the
    // hint must not promise the default there.
    placeholder: prefill.editing
      ? t('providers.form.ccrPort.keepPh')
      : t('providers.form.ccrPort.ph', { port: DEFAULT_CCR_PORT }),
  });
  ccrPortRow.input.inputMode = 'numeric';
  li.appendChild(ccrPortRow.wrapper);

  const localLaunch = buildLocalLaunchBlock(localLaunchState(template, prefill));
  if (localLaunch) li.appendChild(localLaunch.wrapper);

  const status = document.createElement('p');
  status.className = 'hint';
  status.setAttribute('role', 'status');
  status.hidden = true;
  li.appendChild(status);

  const actions = document.createElement('div');
  actions.className = 'project-row';

  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.className = 'termcustom__reset';
  saveBtn.textContent = t(submitKey);

  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'termcustom__reset';
  cancelBtn.textContent = t('providers.action.cancel');
  cancelBtn.addEventListener('click', onCancel);

  actions.append(saveBtn, cancelBtn, buildDocsButton(template));
  li.appendChild(actions);

  saveBtn.addEventListener('click', async () => {
    if (saving) return;
    saving = true;
    saveBtn.disabled = true;
    status.hidden = true;
    try {
      await onSave({
        label: labelRow.input.value,
        apiKey: apiKeyRow.input.value,
        baseUrl: baseUrlRow.input.value,
        model: modelRow.input.value,
        fastModel: fastModelRow.input.value,
        ccrPort: ccrPortRow.input.value,
        localLaunch: localLaunch ? localLaunch.read() : undefined,
        showFail: (key) => {
          status.hidden = false;
          status.classList.add('is-fail');
          status.textContent = t(key);
        },
      });
    } finally {
      saving = false;
      saveBtn.disabled = false;
    }
  });

  return li;
}

function startEdit(profileId) {
  editingId = profileId;
  adding = false;
  if (els.status) els.status.hidden = true;
  render();
}

function cancelEdit() {
  editingId = null;
  render();
}

function startAdd() {
  adding = true;
  editingId = null;
  if (!addTemplateId && templates.length > 0) addTemplateId = templates[0].id;
  if (els.status) els.status.hidden = true;
  render();
}

function cancelAdd() {
  adding = false;
  render();
}

async function submitAdd(fields) {
  const template = findTemplate(addTemplateId);
  const result = buildAddPayload({ template, ...fields });
  if (!result.ok) {
    fields.showFail(failureKey(result.reason));
    return;
  }
  let response;
  try {
    response = await window.lunacore.addProviderProfile(result.payload);
  } catch {
    response = { ok: false, reason: 'generic' };
  }
  if (!response || !response.ok) {
    fields.showFail(failureKey(response && response.reason));
    return;
  }
  profiles = response.profiles;
  adding = false;
  render();
  showStatus(t('providers.saved.add'));
  refreshProfileList();
}

async function submitEdit(profile, fields) {
  const template = findTemplate(profile.templateId);
  const result = buildEditPayload({
    id: profile.id,
    template,
    hasApiKey: profile.hasApiKey,
    hasBaseUrl: profile.hasBaseUrl,
    ...fields,
  });
  if (!result.ok) {
    fields.showFail(failureKey(result.reason));
    return;
  }
  let response;
  try {
    response = await window.lunacore.updateProviderProfile(profile.id, result.payload);
  } catch {
    response = { ok: false, reason: 'generic' };
  }
  if (!response || !response.ok) {
    fields.showFail(failureKey(response && response.reason));
    return;
  }
  profiles = response.profiles;
  editingId = null;
  // The key or port may have changed - an old test result no longer applies.
  testResults.delete(profile.id);
  render();
  showStatus(t('providers.saved.edit'));
  refreshProfileList();
}

async function removeRow(profile) {
  const label = loc(profile.label);
  if (!confirm(t('providers.remove.confirm', { label }))) return;
  let response;
  try {
    response = await window.lunacore.removeProfile(profile.id);
  } catch {
    response = null;
  }
  if (!response) {
    // removeProfile() returns null for a bad id, and a thrown/rejected IPC
    // call is caught above into the same null - either way the row must not
    // just silently stay put with no indication anything went wrong.
    showFailStatus(t('providers.error.generic'));
    return;
  }
  profiles = response.profiles;
  testResults.delete(profile.id);
  render();
  refreshProfileList();
}

/** Shows one view row's Test state: the button while running, and the status line. */
function paintTestState(li, result) {
  const btn = li.querySelector('[data-role="test"]');
  if (btn) btn.disabled = Boolean(result && result.running);
  let line = li.querySelector('[data-role="test-status"]');
  if (!result) {
    if (line) line.remove();
    return;
  }
  if (!line) {
    line = document.createElement('p');
    line.className = 'hint';
    line.dataset.role = 'test-status';
    line.setAttribute('role', 'status');
    li.appendChild(line);
  }
  line.classList.toggle('is-fail', !result.running && !result.ok);
  line.textContent = result.running ? t('providers.test.running') : t(result.key, result.params);
}

/**
 * Repaints ONE row's Test state in place. Never a full render(): that
 * rebuilds every row, and would wipe an add/edit form the user is typing in.
 * A row that is currently an edit form has no data-profile-id, so it is left
 * alone; its result shows once it is a view row again.
 */
function paintTestRow(profileId) {
  if (!els) return;
  const li = [...els.list.children].find((el) => el.dataset.profileId === profileId);
  if (li) paintTestState(li, testResults.get(profileId));
}

/**
 * Runs ccr:test-key for one CCR profile row. Only the id crosses IPC; main
 * resolves the key and port itself. A result that lands after the row was
 * edited or removed is dropped.
 */
async function runConnectionTest(profileId) {
  const current = testResults.get(profileId);
  if (current && current.running) return;
  const pending = { running: true };
  testResults.set(profileId, pending);
  paintTestRow(profileId);
  let response;
  try {
    response = await window.lunacore.testCcrKey(profileId);
  } catch {
    response = null;
  }
  if (testResults.get(profileId) !== pending) return;
  testResults.set(profileId, testResultMessage(response));
  paintTestRow(profileId);
}

/** The gateway started/stopped (or a CCR tab spawned): finished results are stale. */
function clearFinishedTests() {
  for (const [id, result] of testResults) {
    if (result.running) continue;
    testResults.delete(id);
    paintTestRow(id);
  }
}

/** The template <select> for the add form - a fixed dropdown, not editable once a row is in edit mode. */
function buildTemplateSelect() {
  const label = document.createElement('label');
  label.className = 'ui-field';
  const span = document.createElement('span');
  span.className = 'ui-field__label';
  span.textContent = t('providers.form.template');
  label.appendChild(span);

  const select = document.createElement('select');
  select.className = 'profile-select';
  for (const template of templates) {
    const opt = document.createElement('option');
    opt.value = template.id;
    opt.textContent = loc(template.label);
    if (template.id === addTemplateId) opt.selected = true;
    select.appendChild(opt);
  }
  select.addEventListener('change', () => {
    addTemplateId = select.value;
    render();
  });
  label.appendChild(select);
  return label;
}

function buildAddRow() {
  const template = findTemplate(addTemplateId);
  const li = buildFormRow({
    template,
    prefill: { label: template ? loc(template.label) : '' },
    titleKey: 'providers.form.add.title',
    submitKey: 'providers.action.save',
    onSave: submitAdd,
    onCancel: cancelAdd,
  });
  li.insertBefore(buildTemplateSelect(), li.firstChild.nextSibling);
  return li;
}

function buildEditRow(profile) {
  const template = findTemplate(profile.templateId);
  return buildFormRow({
    template,
    prefill: {
      label: loc(profile.label),
      model: profile.model,
      fastModel: profile.fastModel,
      hasApiKey: profile.hasApiKey,
      hasBaseUrl: profile.hasBaseUrl,
      ccrPort: portFromBaseUrl(profile.baseUrl),
      localLaunch: profile.localLaunch,
      editing: true,
    },
    titleKey: 'providers.form.edit.title',
    titleParams: { label: loc(profile.label) },
    submitKey: 'providers.action.save',
    onSave: (fields) => submitEdit(profile, fields),
    onCancel: cancelEdit,
  });
}

function buildViewRow(profile) {
  const li = document.createElement('li');
  li.className = 'diag-item';
  li.dataset.profileId = profile.id;

  const head = document.createElement('span');
  head.className = 'diag-item__head';

  const dot = document.createElement('span');
  const template = findTemplate(profile.templateId);
  const fields = templateFields(template);
  const configured =
    (!fields.needsApiKey || profile.hasApiKey) && (!fields.needsBaseUrl || profile.hasBaseUrl);
  dot.className = `diag-item__dot ${configured ? 'diag-item__dot--ok' : 'diag-item__dot--unknown'}`;
  head.appendChild(dot);

  const label = document.createElement('span');
  label.className = 'diag-item__label';
  label.textContent = loc(profile.label);
  head.appendChild(label);

  if (canTestConnection(template)) {
    const testBtn = document.createElement('button');
    testBtn.type = 'button';
    testBtn.className = 'diag-item__action';
    testBtn.dataset.role = 'test';
    testBtn.textContent = t('providers.action.test');
    testBtn.addEventListener('click', () => runConnectionTest(profile.id));
    head.appendChild(testBtn);
  }

  const editBtn = document.createElement('button');
  editBtn.type = 'button';
  editBtn.className = 'diag-item__action';
  editBtn.textContent = t('providers.action.edit');
  editBtn.addEventListener('click', () => startEdit(profile.id));
  head.appendChild(editBtn);

  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.className = 'diag-item__action';
  removeBtn.textContent = t('providers.action.remove');
  removeBtn.addEventListener('click', () => removeRow(profile));
  head.appendChild(removeBtn);

  li.appendChild(head);

  const detail = document.createElement('span');
  detail.className = 'diag-item__detail';
  detail.textContent = describeProfile(profile);
  li.appendChild(detail);

  paintTestState(li, testResults.get(profile.id));

  return li;
}

function render() {
  if (!els) return;

  const list = generatedProfiles(profiles);
  els.list.innerHTML = '';

  if (adding) els.list.appendChild(buildAddRow());
  for (const profile of list) {
    els.list.appendChild(editingId === profile.id ? buildEditRow(profile) : buildViewRow(profile));
  }

  const hasRows = adding || list.length > 0;
  els.empty.hidden = hasRows;
  if (!hasRows) els.empty.textContent = t('providers.empty');

  const otherCount = profiles.length - list.length;
  els.otherHint.hidden = otherCount <= 0;
  if (otherCount > 0) els.otherHint.textContent = t('providers.other', { n: otherCount });

  els.addBtn.disabled = adding;
}

async function refresh() {
  try {
    const result = await window.lunacore.getProviders();
    templates = (result && Array.isArray(result.providers) && result.providers) || [];
  } catch {
    templates = [];
  }
  try {
    const result = await window.lunacore.getProfiles();
    profiles = (result && Array.isArray(result.profiles) && result.profiles) || [];
  } catch {
    profiles = [];
  }
  render();
}

/**
 * Called once from termcustom.js's Settings-overlay init, same pattern as
 * lmstudiomodels.js's mountLmStudioSettings(root).
 * @param {ParentNode} root
 * @returns {() => void} disposer
 */
export function mountProviderSettings(root) {
  els = {
    list: root.querySelector('#providers-list'),
    empty: root.querySelector('#providers-empty'),
    otherHint: root.querySelector('#providers-other-hint'),
    addBtn: root.querySelector('#providers-add-btn'),
    status: root.querySelector('#providers-status'),
  };
  if (!els.list) {
    els = null;
    return () => {};
  }

  els.empty.textContent = t('providers.loading');
  els.addBtn.addEventListener('click', startAdd);

  const offLang = onLangChange(render);
  // Registered once, like ccrsettings.js (the preload API has no unsubscribe);
  // a no-op once disposed, since paintTestRow checks els.
  if (typeof window.lunacore.onCcrState === 'function') window.lunacore.onCcrState(clearFinishedTests);

  refresh();

  return () => {
    offLang();
    els = null;
  };
}
