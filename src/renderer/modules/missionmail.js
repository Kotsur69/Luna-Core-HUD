// ============================================================================
// LunaCore - Mission Control: Gmail cleanup widget
// ----------------------------------------------------------------------------
// Scan (dry run, read-only) -> review three buckets -> tick -> Apply (two
// clicks) -> report. The preview survives a remount in module state, so
// moving the widget between regions does not throw away a scan that cost a
// model call.
//
// Defaults follow the safety order of src/missionmail.js: "to trash" rows
// start ticked, "needs your call" rows start unticked, flagged rows have no
// checkbox at all (main would refuse them anyway).
// ============================================================================

'use strict';

import { t } from './util.js';
import { defineWidget } from './registry.js';
import { errorText, costSuffix, bindModelSelect, setStatus, ipcFailed } from './missionshared.js';

const CONFIRM_WINDOW_MS = 4000;

// Survives remounts: the last validated preview and the user's ticks.
let preview = null;
let selected = new Set();
let els = null;
let confirmTimer = null;

function rowText(row) {
  const wrap = document.createElement('span');
  wrap.className = 'mc-row__text';
  const from = document.createElement('span');
  from.className = 'mc-row__from';
  from.textContent = row.from || '?';
  const subject = document.createElement('span');
  subject.className = 'mc-row__subject';
  subject.textContent = row.subject || '';
  subject.title = row.subject || '';
  wrap.append(from, subject);
  const note = row.rule || row.reason;
  if (note) {
    const n = document.createElement('span');
    n.className = 'mc-row__note';
    n.textContent = note;
    wrap.append(n);
  }
  return wrap;
}

function checkRow(row) {
  const li = document.createElement('li');
  const label = document.createElement('label');
  label.className = 'todo-item mc-row';
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.checked = selected.has(row.threadId);
  box.addEventListener('change', () => {
    const next = new Set(selected);
    if (box.checked) next.add(row.threadId);
    else next.delete(row.threadId);
    selected = next;
    renderApply();
  });
  label.append(box, rowText(row));
  li.append(label);
  return li;
}

function flagRow(row) {
  const li = document.createElement('li');
  li.className = 'todo-item mc-row mc-row--flag';
  const mark = document.createElement('span');
  mark.className = 'mc-flag';
  mark.textContent = '!';
  mark.setAttribute('aria-hidden', 'true');
  li.append(mark, rowText(row));
  return li;
}

function bucket(titleKey, rows, makeRow) {
  if (!rows.length) return null;
  const section = document.createElement('section');
  section.className = 'mc-bucket';
  const h = document.createElement('h3');
  h.className = 'mc-bucket__title';
  h.textContent = `${t(titleKey)} (${rows.length})`;
  const ul = document.createElement('ul');
  ul.className = 'todo-list';
  ul.append(...rows.map(makeRow));
  section.append(h, ul);
  return section;
}

function disarmConfirm() {
  clearTimeout(confirmTimer);
  confirmTimer = null;
  if (els) els.apply.classList.remove('is-armed');
}

function renderApply() {
  if (!els) return;
  disarmConfirm();
  els.apply.hidden = !preview || selected.size === 0;
  els.apply.textContent = t('mc.mail.apply', { n: selected.size });
}

function render() {
  if (!els) return;
  els.results.replaceChildren();
  if (!preview) {
    els.count.textContent = '';
    renderApply();
    return;
  }
  const total = preview.trash.length + preview.flag.length + preview.needsCall.length;
  els.count.textContent = total ? String(total) : '';
  const parts = [
    bucket('mc.mail.flag', preview.flag, flagRow),
    bucket('mc.mail.trash', preview.trash, checkRow),
    bucket('mc.mail.needsCall', preview.needsCall, checkRow),
  ].filter(Boolean);
  // Sender and subject come from the model, not from Gmail headers: say so,
  // so a mislabelled row is checked in Gmail rather than trusted.
  const note = document.createElement('p');
  note.className = 'hint';
  note.textContent = t('mc.mail.modelNote');
  els.results.append(note);
  if (preview.summary) {
    const p = document.createElement('p');
    p.className = 'mc-summary';
    p.textContent = preview.summary;
    els.results.append(p);
  }
  if (!parts.length) {
    const p = document.createElement('p');
    p.className = 'hint';
    p.textContent = t('mc.mail.clean');
    els.results.append(p);
  }
  els.results.append(...parts);
  renderApply();
}

async function scan() {
  // Apply is locked for the whole scan: main replaces the preview it checks
  // Apply against, so an Apply racing a scan would act on a stale list.
  disarmConfirm();
  els.scan.disabled = true;
  els.apply.disabled = true;
  setStatus(els.status, t('mc.mail.scanning'));
  const res = await window.lunacore.missionMailPreview().catch(ipcFailed);
  // State first, DOM second: a scan that finishes after the widget unmounted
  // (panel closed) is still paid for and must survive to the next mount.
  if (res.ok) {
    preview = res.preview;
    selected = new Set(preview.trash.map((r) => r.threadId));
  }
  if (!els) return;
  els.scan.disabled = false;
  els.apply.disabled = false;
  if (!res.ok) {
    setStatus(els.status, errorText(res.reason) + costSuffix(res.costUsd), true);
    renderApply();
    return;
  }
  setStatus(els.status, t('mc.mail.scanned') + costSuffix(res.costUsd));
  render();
}

async function apply() {
  // First click arms, second click (within the window) trashes.
  if (!els.apply.classList.contains('is-armed')) {
    els.apply.classList.add('is-armed');
    els.apply.textContent = t('mc.mail.confirm', { n: selected.size });
    confirmTimer = setTimeout(renderApply, CONFIRM_WINDOW_MS);
    return;
  }
  disarmConfirm();
  els.apply.disabled = true;
  els.scan.disabled = true;
  setStatus(els.status, t('mc.mail.applying'));
  const res = await window.lunacore.missionMailApply([...selected]).catch(ipcFailed);
  // Trashed rows leave the module state even if the widget unmounted meanwhile.
  if (res.ok) {
    const gone = new Set(res.trashed);
    const keep = (r) => !gone.has(r.threadId);
    preview = { ...preview, trash: preview.trash.filter(keep), needsCall: preview.needsCall.filter(keep) };
    selected = new Set([...selected].filter((id) => !gone.has(id)));
  }
  if (!els) return;
  els.apply.disabled = false;
  els.scan.disabled = false;
  if (!res.ok) {
    setStatus(els.status, errorText(res.reason) + costSuffix(res.costUsd), true);
    renderApply();
    return;
  }
  const msg = t('mc.mail.applied', { n: res.trashed.length, failed: res.failed.length });
  setStatus(els.status, msg + costSuffix(res.costUsd), res.failed.length > 0);
  render();
}

defineWidget({
  id: 'mailcleanup',
  titleKey: 'mc.mail.title',
  template: 'w-mailcleanup',
  mount(root) {
    els = {
      count: root.querySelector('#mc-mail-count'),
      model: root.querySelector('#mc-mail-model'),
      scan: root.querySelector('#mc-mail-scan'),
      status: root.querySelector('#mc-mail-status'),
      results: root.querySelector('#mc-mail-results'),
      apply: root.querySelector('#mc-mail-apply'),
    };
    window.lunacore
      .getMissionConfig()
      .then((config) => {
        if (els) bindModelSelect(els.model, config);
      })
      .catch(() => {
        // No config -> leave the select empty; main falls back to haiku.
      });
    els.scan.addEventListener('click', scan);
    els.apply.addEventListener('click', apply);
    if (!preview) setStatus(els.status, t('mc.mail.idle'));
    render();
    return () => {
      disarmConfirm();
      els = null;
    };
  },
});
