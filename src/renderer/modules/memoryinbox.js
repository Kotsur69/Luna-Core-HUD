// ============================================================================
// LunaCore - memory inbox window (renderer)
// ----------------------------------------------------------------------------
// docs/untouched_docs/rag-stylememory.md, phase 4. The memories capture
// proposed from finished sessions wait here (src/memoryinbox.js through
// src/memoryipc.js). Per entry: approve (it joins the project card), edit the
// title and text, or reject (it is deleted on every PC).
//
// Opened from the notification hub item "N memories to review"
// (hubpanel.js openMemoryInbox). A memory is named to main only by its key.
// Memory text is free text from a model: textContent only, never markup.
// ============================================================================

'use strict';

import { t } from './util.js';
import { createTallOverlay } from './talloverlay.js';

/** Characters of a body shown before "show all". */
export const PREVIEW_CHARS = 320;

let overlay = null;
let stopListening = null;
/** Keys with a call in flight: their buttons are disabled. */
const busy = new Set();
/** The key being edited, or null. One at a time, so a repaint cannot lose two drafts. */
let editing = null;
const expanded = new Set();
/** key -> reason of the last failed action, shown on that entry. */
const failed = new Map();

const call = (fn, ...args) => Promise.resolve().then(() => window.lunacore[fn](...args)).catch(() => ({ ok: false, reason: 'ipc' }));

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(cls, label, onClick) {
  const b = el('button', cls, label);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}

/** The short name of a project key: its last segment, or "global". */
export const projectLabel = (project) => String(project || '').split('/').pop() || '';

/** A body cut for the list. @returns {{text: string, cut: boolean}} */
export function preview(body, max = PREVIEW_CHARS) {
  const text = String(body || '');
  return text.length > max ? { text: `${text.slice(0, max).trimEnd()} ...`, cut: true } : { text, cut: false };
}

/** The i18n key of a failed action's reason. */
export function reasonKey(reason) {
  if (reason === 'not-found' || reason === 'not-pending') return 'mem.inbox.err.gone';
  if (reason === 'empty-body' || reason === 'bad-title' || reason === 'body-too-long' || reason === 'record-too-big') return 'mem.inbox.err.text';
  return 'mem.inbox.err.failed';
}

function field(labelKey, control) {
  const label = el('label', 'ui-field');
  label.append(el('span', 'ui-field__label', t(labelKey)), control);
  return label;
}

function editForm(item) {
  const form = el('form', 'mem-inbox__form');
  const title = el('input', 'mem-inbox__input');
  title.type = 'text';
  title.value = item.title;
  title.maxLength = 200;
  const body = el('textarea', 'mem-inbox__input mem-inbox__text');
  body.value = item.body;
  body.rows = 8;
  body.maxLength = 5000;
  const save = el('button', 'port-btn mem-inbox__btn', t('mem.inbox.save'));
  save.type = 'submit';
  const cancel = button('port-btn mem-inbox__btn', t('mem.inbox.cancel'), () => {
    editing = null;
    load(item.key);
  });
  const row = el('div', 'mem-inbox__actions');
  row.append(save, cancel);
  const problem = el('p', 'hint is-fail');
  problem.setAttribute('role', 'alert');
  problem.hidden = true;
  form.append(field('mem.inbox.field.title', title), field('mem.inbox.field.body', body), problem, row);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    save.disabled = true;
    act(item.key, 'memoryInboxUpdate', item.key, { title: title.value, body: body.value }).then((ok) => {
      if (ok) {
        editing = null;
        load(item.key);
        return;
      }
      // A refused save keeps the form: a repaint would throw the typed text away.
      problem.textContent = t(reasonKey(failed.get(item.key)));
      problem.hidden = false;
      failed.delete(item.key);
      save.disabled = false;
    });
  });
  // Focus lands in the form once it is in the document.
  queueMicrotask(() => title.focus());
  return form;
}

function notes(item) {
  const lines = [];
  for (const old of item.supersedes) lines.push(t('mem.inbox.replaces', { title: old.title }));
  if (item.similar) lines.push(t('mem.inbox.similar', { title: item.similar.title }));
  if (item.duplicates) lines.push(t('mem.inbox.duplicates', { count: item.duplicates }));
  return lines.map((line) => el('p', 'mem-inbox__note', line));
}

function entry(item) {
  const card = el('li', 'mem-inbox__item');
  card.dataset.key = item.key;
  const head = el('div', 'mem-inbox__head');
  head.append(el('span', 'mem-inbox__type', item.type), el('span', 'mem-inbox__project', projectLabel(item.project)), el('span', 'mem-inbox__date', item.created));
  card.append(head);

  if (editing === item.key) {
    card.append(editForm(item));
  } else {
    const shown = expanded.has(item.key) ? { text: item.body, cut: false } : preview(item.body);
    card.append(el('h3', 'mem-inbox__title', item.title), el('p', 'mem-inbox__body', shown.text));
    if (shown.cut) {
      card.append(
        button('gm-sum__link mem-inbox__more', t('mem.inbox.showAll'), () => {
          expanded.add(item.key);
          load(item.key);
        }),
      );
    }
    card.append(...notes(item));
    if (item.source) card.append(el('p', 'hint', item.source));
    const off = busy.has(item.key);
    const approve = button('port-btn mem-inbox__btn mem-inbox__btn--approve', t('mem.inbox.approve'), () => decide(item.key, 'memoryInboxApprove'));
    const edit = button('port-btn mem-inbox__btn', t('mem.inbox.edit'), () => {
      editing = item.key;
      load();
    });
    // The destructive action sits apart from the other two.
    const reject = button('port-btn port-btn--kill mem-inbox__btn mem-inbox__btn--reject', t('mem.inbox.reject'), () => decide(item.key, 'memoryInboxReject'));
    for (const b of [approve, edit, reject]) b.disabled = off;
    const actions = el('div', 'mem-inbox__actions');
    actions.append(approve, edit, reject);
    card.append(actions);
  }
  if (failed.has(item.key)) {
    const err = el('p', 'hint is-fail', t(reasonKey(failed.get(item.key))));
    err.setAttribute('role', 'alert');
    card.append(err);
  }
  return card;
}

function captureLine(capture) {
  if (!capture || !capture.last) return t('mem.inbox.captureNever');
  const when = new Date(capture.last.at).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  return t('mem.inbox.captureLast', { when, saved: capture.last.saved });
}

/** Puts focus back on the list after a repaint: the wanted entry, or the one that took its place. */
function refocus(list, key, index) {
  const cards = [...list.children];
  const target = cards.find((c) => c.dataset.key === key) || cards[Math.min(index, cards.length - 1)];
  const control = target && target.querySelector('button:not(:disabled), input');
  if (control) control.focus();
}

function render(res, focusKey, focusIndex) {
  overlay.setTitle(res.total ? t('mem.inbox.titleCount', { count: res.total }) : '');
  const intro = el('p', 'hint mem-inbox__intro', t('mem.inbox.intro'));
  const foot = el('p', 'hint mem-inbox__foot', captureLine(res.capture));
  if (!res.items.length) {
    overlay.body.replaceChildren(intro, el('p', 'mem-inbox__empty', t('mem.inbox.empty')), foot);
    return;
  }
  const list = el('ul', 'mem-inbox__list');
  for (const item of res.items) list.append(entry(item));
  const more = res.total > res.items.length ? [el('p', 'hint', t('mem.inbox.more', { count: res.total - res.items.length }))] : [];
  overlay.body.replaceChildren(intro, list, ...more, foot);
  if (focusKey !== undefined || focusIndex !== undefined) refocus(list, focusKey, focusIndex || 0);
}

/** Reads the inbox and repaints. `focusKey` / `focusIndex` say where the keyboard focus goes. */
async function load(focusKey, focusIndex) {
  const res = await call('memoryInbox');
  if (!overlay || !overlay.isOpen()) return;
  if (res && res.ok && Array.isArray(res.items)) render(res, focusKey, focusIndex);
  else overlay.body.replaceChildren(el('p', 'hint is-fail', t('mem.inbox.err.load')));
}

/** One call for one entry. @returns {Promise<boolean>} whether it worked */
async function act(key, fn, ...args) {
  if (busy.has(key)) return false;
  busy.add(key);
  failed.delete(key);
  const res = await call(fn, ...args);
  busy.delete(key);
  if (!res || !res.ok) failed.set(key, (res && res.reason) || 'failed');
  return Boolean(res && res.ok);
}

/** Approve or reject: the entry leaves the list and focus moves to its neighbour. */
async function decide(key, fn) {
  const cards = overlay ? [...overlay.body.querySelectorAll('.mem-inbox__item')] : [];
  const index = Math.max(0, cards.findIndex((c) => c.dataset.key === key));
  for (const b of cards[index] ? cards[index].querySelectorAll('button') : []) b.disabled = true;
  await act(key, fn, key);
  load(key, index);
}

/** Opens the inbox. */
export async function openMemoryInbox() {
  if (!overlay) {
    overlay = createTallOverlay({
      id: 'memory-inbox',
      glyph: '◈',
      titleKey: 'mem.inbox.title',
      onClose: () => {
        if (stopListening) stopListening();
        stopListening = null;
        editing = null;
        failed.clear();
      },
    });
  }
  overlay.setTitle('');
  overlay.body.replaceChildren(el('p', 'hint', t('mem.inbox.loading')));
  overlay.open();
  // Another PC's sync or a finished capture changes the list while it is open.
  // Not while a draft is open: a repaint would throw the typed text away.
  if (!stopListening && typeof window.lunacore.onMemoryChanged === 'function') {
    stopListening = window.lunacore.onMemoryChanged(() => {
      if (editing === null && busy.size === 0) load();
    });
  }
  await load();
}
