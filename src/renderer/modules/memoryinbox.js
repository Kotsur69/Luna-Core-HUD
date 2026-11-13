// ============================================================================
// LunaCore - memory inbox window (renderer)
// ----------------------------------------------------------------------------
// docs/untouched_docs/rag-stylememory.md, phase 4. The memories capture
// proposed from finished sessions wait here (src/memoryinbox.js through
// src/memoryipc.js). Per entry: approve (it joins the project card), edit the
// title and text, make a project entry global, or reject (it is deleted on
// every PC). Capture never files a memory as global by itself: only the
// 'Make global' button here does (security review of 2026-11-11).
//
// Entries come most useful first (the extractor's usefulness score, unknown
// last; src/memoryinbox.js listInbox). The score is shown, never acted on.
//
// Opened from the notification hub item "N memories to review"
// (hubpanel.js openMemoryInbox). A memory is named to main only by its key.
// Memory text is free text from a model: textContent only, never markup.
// ============================================================================

'use strict';

import { t } from './util.js';
import { createTallOverlay } from './talloverlay.js';
import { COMMANDS, keyCommand, typingIn, moveSelection, keepSelection } from './memoryinboxkeys.js';
import { autoSection } from './memoryautopanel.js';

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
/** Which list shows: 'inbox' (to approve) or 'review' (to check). Null until the first paint picks one. */
let tab = null;
/** The key whose "Retire" waits for a second click, or null. */
let confirming = null;
/** The entry the keyboard acts on (memoryinboxkeys.js), or null; and where it was listed. */
let selected = null;
let selectedIndex = 0;
/** The entries of the list on screen, in order: what the keys move through and act on. */
let shownItems = [];
/** Auto-accept (memoryautopanel.js): a switch call in flight, and the last failure's i18n key. */
let switching = false;
let autoError = null;

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
  if (reason === 'not-found' || reason === 'not-pending' || reason === 'not-confirmed' || reason === 'not-flagged') return 'mem.inbox.err.gone';
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

/** Whether an entry is filed under `global` (it would reach every project's card). */
export const isGlobal = (item) => item.project === 'global';

/**
 * The notes under an entry, as [text, modifier]: modifier '' or a mem-inbox__note--* suffix.
 * @returns {[string, string][]}
 */
export function noteLines(item) {
  const lines = [];
  if (isGlobal(item)) lines.push([t('mem.inbox.globalNote'), 'global']);
  else if (item.suggestedGlobal) lines.push([t('mem.inbox.suggestedGlobal'), '']);
  if (item.outside > 0) lines.push([t('mem.inbox.outside', { count: item.outside }), 'warn']);
  for (const old of item.supersedes) lines.push([t('mem.inbox.replaces', { title: old.title }), '']);
  if (item.similar) lines.push([t('mem.inbox.similar', { title: item.similar.title }), '']);
  if (item.duplicates) lines.push([t('mem.inbox.duplicates', { count: item.duplicates }), '']);
  return lines;
}

/** The usefulness label of an entry: "Usefulness 72%", or the unknown form. */
export function scoreLabel(item) {
  const pct = item && Number.isInteger(item.usefulness) ? item.usefulness : null;
  return pct === null ? t('mem.inbox.usefulnessUnknown') : t('mem.inbox.usefulness', { pct });
}

function scoreChip(item) {
  const chip = el('span', 'mem-inbox__score', scoreLabel(item));
  chip.title = t('mem.inbox.usefulnessHint');
  return chip;
}

function notes(item) {
  return noteLines(item).map(([line, mod]) => el('p', mod ? `mem-inbox__note mem-inbox__note--${mod}` : 'mem-inbox__note', line));
}

/** A list entry: focusable by the keyboard selection, marked when selected. */
function cardFor(item) {
  const card = el('li', item.key === selected ? 'mem-inbox__item is-selected' : 'mem-inbox__item');
  card.dataset.key = item.key;
  card.tabIndex = -1;
  if (item.key === selected) card.setAttribute('aria-current', 'true');
  return card;
}

function entry(item) {
  const card = cardFor(item);
  const head = el('div', 'mem-inbox__head');
  head.append(el('span', 'mem-inbox__type', item.type), el('span', 'mem-inbox__project', projectLabel(item.project)), scoreChip(item), el('span', 'mem-inbox__date', item.created));
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
    // Only a project entry can be made global; a global one already is.
    const global = isGlobal(item) ? null : button('port-btn mem-inbox__btn', t('mem.inbox.makeGlobal'), () => promote(item.key));
    // The destructive action sits apart from the others.
    const reject = button('port-btn port-btn--kill mem-inbox__btn mem-inbox__btn--reject', t('mem.inbox.reject'), () => decide(item.key, 'memoryInboxReject'));
    const buttons = [approve, edit, ...(global ? [global] : []), reject];
    for (const b of buttons) b.disabled = off;
    const actions = el('div', 'mem-inbox__actions');
    actions.append(...buttons);
    card.append(actions);
  }
  if (failed.has(item.key)) {
    const err = el('p', 'hint is-fail', t(reasonKey(failed.get(item.key))));
    err.setAttribute('role', 'alert');
    card.append(err);
  }
  return card;
}

/** Why a confirmed memory is on the review list, in words (never by colour alone). */
export function flagLine(flag) {
  if (flag.kind === 'disputed') return t('mem.inbox.review.disputed', { note: flag.note || '-' });
  if (flag.kind === 'anchor') return t('mem.inbox.review.anchor', { files: (flag.missing || []).join(', ') });
  return t('mem.inbox.review.stale', { since: flag.since });
}

/** One confirmed memory that needs a look: still true, or retire (asked twice). */
function reviewEntry(item) {
  const card = cardFor(item);
  const head = el('div', 'mem-inbox__head');
  head.append(el('span', 'mem-inbox__type', item.type), el('span', 'mem-inbox__project', projectLabel(item.project)), el('span', 'mem-inbox__date', item.last_verified || item.created));
  const shown = expanded.has(item.key) ? { text: item.body, cut: false } : preview(item.body);
  card.append(head, el('h3', 'mem-inbox__title', item.title), el('p', 'mem-inbox__body', shown.text));
  if (shown.cut) {
    card.append(
      button('gm-sum__link mem-inbox__more', t('mem.inbox.showAll'), () => {
        expanded.add(item.key);
        load(item.key);
      }),
    );
  }
  card.append(...item.flags.map((flag) => el('p', 'mem-inbox__note', flagLine(flag))));
  const off = busy.has(item.key);
  const actions = el('div', 'mem-inbox__actions');
  if (confirming === item.key) {
    const ask = el('p', 'mem-inbox__ask', t('mem.inbox.review.retireAsk'));
    ask.setAttribute('role', 'alert');
    const yes = button('port-btn port-btn--kill mem-inbox__btn', t('mem.inbox.review.retireYes'), () => decide(item.key, 'memoryReviewRetire'));
    const no = button('port-btn mem-inbox__btn', t('mem.inbox.cancel'), () => {
      confirming = null;
      load(item.key);
    });
    for (const b of [yes, no]) b.disabled = off;
    card.append(ask);
    // Cancel comes first: it is where the keyboard focus lands after the repaint.
    actions.append(no, yes);
  } else {
    const keep = button('port-btn mem-inbox__btn mem-inbox__btn--approve', t('mem.inbox.review.keep'), () => decide(item.key, 'memoryReviewVerify'));
    const retire = button('port-btn port-btn--kill mem-inbox__btn mem-inbox__btn--reject', t('mem.inbox.review.retire'), () => {
      confirming = item.key;
      load(item.key);
    });
    for (const b of [keep, retire]) b.disabled = off;
    actions.append(keep, retire);
  }
  card.append(actions);
  if (failed.has(item.key)) {
    const err = el('p', 'hint is-fail', t(reasonKey(failed.get(item.key))));
    err.setAttribute('role', 'alert');
    card.append(err);
  }
  return card;
}

/** What capture proposed in the last week and what became of it, or '' when there is nothing to say. */
export function statsLine(stats) {
  if (!stats || !(stats.proposed || stats.approved || stats.rejected)) return '';
  if (typeof stats.rate !== 'number') return t('mem.inbox.statsNone', { days: stats.days, proposed: stats.proposed });
  return t('mem.inbox.stats', { days: stats.days, proposed: stats.proposed, approved: stats.approved, rejected: stats.rejected, rate: Math.round(stats.rate * 100) });
}

const TABS = [
  ['inbox', 'mem.inbox.tab.inbox'],
  ['review', 'mem.inbox.tab.review'],
];
const PANEL_ID = 'mem-inbox-panel';

function switchTab(name) {
  // Not while a draft is open: switching would throw the typed text away.
  if (name === tab || editing !== null) return;
  tab = name;
  confirming = null;
  selected = null;
  load(undefined, undefined, true);
}

/** The two lists as tabs: arrow keys move between them, Tab goes on into the list. */
function tabBar(counts) {
  const bar = el('div', 'mem-inbox__tabs');
  bar.setAttribute('role', 'tablist');
  bar.setAttribute('aria-label', t('mem.inbox.tabs'));
  for (const [name, key] of TABS) {
    const b = button('mem-inbox__tab', t(key, { count: counts[name] }), () => switchTab(name));
    b.id = `mem-inbox-tab-${name}`;
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-selected', String(name === tab));
    b.setAttribute('aria-controls', PANEL_ID);
    b.tabIndex = name === tab ? 0 : -1;
    bar.append(b);
  }
  bar.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    switchTab(tab === 'inbox' ? 'review' : 'inbox');
  });
  return bar;
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
  // The entry's own actions (or its edit form), not the "show all" link above them.
  const control = target && target.querySelector('.mem-inbox__actions button:not(:disabled), input');
  if (control) control.focus();
}

/**
 * @param {object} res the inbox (memory:inbox)
 * @param {{items: object[], total: number}} review the review list (memory:review)
 * @param {boolean} [focusTab] put the keyboard focus on the selected tab
 */
function render(res, review, focusKey, focusIndex, focusTab) {
  // First paint: an empty inbox with something to check opens on the review list.
  if (tab === null) tab = !res.total && review.total ? 'review' : 'inbox';
  overlay.setTitle(res.total ? t('mem.inbox.titleCount', { count: res.total }) : '');
  const reviewing = tab === 'review';
  const shown = reviewing ? review : res;
  // An entry that left the list (decided on another PC) takes its open draft or question with it:
  // a key that is still set would block every later repaint.
  const listed = new Set(shown.items.map((item) => item.key));
  if (editing !== null && !listed.has(editing)) editing = null;
  if (confirming !== null && !listed.has(confirming)) confirming = null;
  // A decided entry hands the keyboard selection to the one that took its place.
  shownItems = shown.items;
  selected = keepSelection(shown.items.map((item) => item.key), selected, selectedIndex);
  selectedIndex = Math.max(0, shown.items.findIndex((item) => item.key === selected));
  const panel = el('div');
  panel.id = PANEL_ID;
  panel.setAttribute('role', 'tabpanel');
  panel.setAttribute('aria-labelledby', `mem-inbox-tab-${tab}`);
  panel.append(el('p', 'hint mem-inbox__intro', t(reviewing ? 'mem.inbox.review.intro' : 'mem.inbox.intro')));
  let list = null;
  if (shown.items.length) {
    list = el('ul', 'mem-inbox__list');
    for (const item of shown.items) list.append(reviewing ? reviewEntry(item) : entry(item));
    // Keyboard focus moving into an entry (Tab, or the refocus after a keyboard decision)
    // selects it. Mouse focus does not: a selection the user never made would take the
    // first Esc, and Esc must still close the window for a mouse user.
    list.addEventListener('focusin', (event) => {
      const card = event.target.closest('.mem-inbox__item');
      if (card && event.target.matches(':focus-visible')) markSelected(card.dataset.key);
    });
    panel.append(list);
    if (shown.total > shown.items.length) panel.append(el('p', 'hint', t('mem.inbox.more', { count: shown.total - shown.items.length })));
  } else {
    panel.append(el('p', 'mem-inbox__empty', t(reviewing ? 'mem.inbox.review.empty' : 'mem.inbox.empty')));
  }
  const bar = tabBar({ inbox: res.total, review: review.total });
  const foot = el('p', 'hint mem-inbox__foot', captureLine(res.capture));
  const stats = statsLine(res.stats);
  const keys = el('p', 'hint mem-inbox__keys', t(reviewing ? 'mem.inbox.keys.review' : 'mem.inbox.keys.inbox'));
  // An open draft locks the section: its repaint would throw the typed text away.
  const autoPart = reviewing ? null : autoSection(res.auto, { onToggle: toggleAuto, onUndo: undoAuto, busy, switching: switching || editing !== null, error: autoError });
  overlay.body.replaceChildren(bar, panel, ...(autoPart ? [autoPart] : []), foot, ...(stats ? [el('p', 'hint', stats)] : []), keys);
  if (focusTab) bar.querySelector('[aria-selected="true"]').focus();
  else if (list && (focusKey !== undefined || focusIndex !== undefined)) refocus(list, focusKey, focusIndex || 0);
}

const NO_REVIEW = { items: [], total: 0 };
/** Counts load() calls, so a slow answer can tell that a newer one was asked for. */
let loadSeq = 0;

/** Reads both lists and repaints. `focusKey` / `focusIndex` / `focusTab` say where the keyboard focus goes. */
async function load(focusKey, focusIndex, focusTab) {
  const seq = ++loadSeq;
  const [res, review] = await Promise.all([call('memoryInbox'), call('memoryReview')]);
  // Only the newest read paints: an older answer arriving late must not undo its focus.
  if (seq !== loadSeq || !overlay || !overlay.isOpen()) return;
  if (!res || !res.ok || !Array.isArray(res.items)) {
    overlay.body.replaceChildren(el('p', 'hint is-fail', t('mem.inbox.err.load')));
    return;
  }
  // The review list failing must not take the inbox down with it.
  render(res, review && review.ok && Array.isArray(review.items) ? review : NO_REVIEW, focusKey, focusIndex, focusTab);
}

/** One call for one entry. @returns {Promise<object|null>} main's answer, null when it failed */
async function actResult(key, fn, ...args) {
  if (busy.has(key)) return null;
  busy.add(key);
  failed.delete(key);
  const res = await call(fn, ...args);
  busy.delete(key);
  // A window closed meanwhile has cleared its errors: do not leave one for the next opening.
  if ((!res || !res.ok) && overlay && overlay.isOpen()) failed.set(key, (res && res.reason) || 'failed');
  return res && res.ok ? res : null;
}

/** One call for one entry. @returns {Promise<boolean>} whether it worked */
async function act(key, fn, ...args) {
  return Boolean(await actResult(key, fn, ...args));
}

/** Decisions whose list has not been repainted yet: the keys wait for the new list. */
let settling = 0;

/** Approve or reject: the entry leaves the list and focus moves to its neighbour. */
async function decide(key, fn) {
  const cards = overlay ? [...overlay.body.querySelectorAll('.mem-inbox__item')] : [];
  const index = Math.max(0, cards.findIndex((c) => c.dataset.key === key));
  for (const b of cards[index] ? cards[index].querySelectorAll('button') : []) b.disabled = true;
  settling++;
  try {
    await act(key, fn, key);
    confirming = null;
    await load(key, index);
  } finally {
    settling--;
  }
}

/** Make global: the entry gets a new key, and focus follows it to that key. */
async function promote(key) {
  const cards = overlay ? [...overlay.body.querySelectorAll('.mem-inbox__item')] : [];
  const index = Math.max(0, cards.findIndex((c) => c.dataset.key === key));
  for (const b of cards[index] ? cards[index].querySelectorAll('button') : []) b.disabled = true;
  settling++;
  try {
    const res = await actResult(key, 'memoryInboxMakeGlobal', key);
    const next = res && typeof res.key === 'string' ? res.key : key;
    // The selection follows the entry to its new key; a refused move keeps the old one and shows its error there.
    if (selected === key) selected = next;
    await load(next, index);
  } finally {
    settling--;
  }
}

/** The i18n key of a failed auto-accept call. */
export function autoReasonKey(reason) {
  if (reason === 'not-offered') return 'mem.auto.err.notOffered';
  if (reason === 'not-found' || reason === 'not-auto') return 'mem.inbox.err.gone';
  return 'mem.inbox.err.failed';
}

/** Switches auto-accept for one type; main re-checks that the numbers allow it. */
async function toggleAuto(type, on) {
  // Like switchTab: never while a draft is open, a repaint would throw it away.
  if (switching || editing !== null) return;
  switching = true;
  const res = await call('memoryAutoSet', type, on);
  switching = false;
  autoError = res && res.ok ? null : autoReasonKey(res && res.reason);
  load();
}

/** Undoes one auto-accept: the memory is rejected (deleted on every PC). */
async function undoAuto(key) {
  if (busy.has(key) || editing !== null) return;
  busy.add(key);
  const res = await call('memoryAutoUndo', key);
  busy.delete(key);
  autoError = res && res.ok ? null : autoReasonKey(res && res.reason);
  load();
}

/** Selects an entry without a repaint (null clears the selection). */
function markSelected(key) {
  selected = key;
  const at = shownItems.findIndex((item) => item.key === key);
  if (at >= 0) selectedIndex = at;
  if (!overlay) return;
  for (const card of overlay.body.querySelectorAll('.mem-inbox__item')) {
    const on = key !== null && card.dataset.key === key;
    card.classList.toggle('is-selected', on);
    if (on) card.setAttribute('aria-current', 'true');
    else card.removeAttribute('aria-current');
  }
}

function moveTo(step) {
  const key = moveSelection(shownItems.map((item) => item.key), selected, step);
  if (key === null) return;
  markSelected(key);
  const card = [...overlay.body.querySelectorAll('.mem-inbox__item')].find((c) => c.dataset.key === key);
  if (!card) return;
  card.focus({ preventScroll: true });
  card.scrollIntoView({ block: 'nearest' });
}

function clearSelection() {
  markSelected(null);
  const active = document.activeElement;
  if (active && overlay.body.contains(active) && active.closest('.mem-inbox__item')) active.blur();
}

/** Commands that change an entry: one at a time, never on a list that is about to change. */
const ENTRY_ACTIONS = {
  [COMMANDS.APPROVE]: (key) => decide(key, 'memoryInboxApprove'),
  [COMMANDS.REJECT]: (key) => decide(key, 'memoryInboxReject'),
  [COMMANDS.GLOBAL]: (key) => promote(key),
  [COMMANDS.VERIFY]: (key) => decide(key, 'memoryReviewVerify'),
  [COMMANDS.RETIRE_CONFIRM]: (key) => decide(key, 'memoryReviewRetire'),
  [COMMANDS.EDIT]: (key) => {
    editing = key;
    load();
  },
  // The question must be on screen before a second R can answer it: a quick
  // double press would otherwise delete without ever asking.
  [COMMANDS.RETIRE_ASK]: async (key) => {
    settling++;
    try {
      confirming = key;
      await load(key);
    } finally {
      settling--;
    }
  },
};

/** Runs one keyboard command (memoryinboxkeys.js) on the selected entry. */
function runCommand(cmd, item) {
  if (cmd === COMMANDS.NEXT || cmd === COMMANDS.PREV) return moveTo(cmd === COMMANDS.NEXT ? 1 : -1);
  if (cmd === COMMANDS.CLEAR) return clearSelection();
  if (cmd === COMMANDS.SAVE) {
    const form = overlay.body.querySelector('.mem-inbox__form');
    if (form && !busy.has(editing)) form.requestSubmit();
    return undefined;
  }
  if (cmd === COMMANDS.CANCEL_EDIT) {
    const key = editing;
    editing = null;
    return load(key);
  }
  if (cmd === COMMANDS.CANCEL_CONFIRM) {
    confirming = null;
    return load(item.key);
  }
  const action = ENTRY_ACTIONS[cmd];
  if (!action || !item || settling > 0 || busy.has(item.key)) return undefined;
  return action(item.key);
}

/** The window's keys (talloverlay onKeydown). @returns {boolean} true = the key was ours */
function onKey(event) {
  if (!overlay || !overlay.isOpen()) return false;
  const item = shownItems.find((i) => i.key === selected) || null;
  const cmd = keyCommand(event, {
    tab,
    typing: typingIn(event.target),
    editing: editing !== null,
    confirming: item !== null && confirming === item.key,
    selected: item !== null,
    canGlobal: tab === 'inbox' && item !== null && !isGlobal(item),
  });
  if (!cmd) return false;
  // An empty list has nothing to move through: the arrows keep scrolling the window.
  if ((cmd === COMMANDS.NEXT || cmd === COMMANDS.PREV) && !shownItems.length) return false;
  runCommand(cmd, item);
  return true;
}

/** Opens the inbox. */
export async function openMemoryInbox() {
  if (!overlay) {
    overlay = createTallOverlay({
      id: 'memory-inbox',
      glyph: '◈',
      titleKey: 'mem.inbox.title',
      onKeydown: onKey,
      onClose: () => {
        if (stopListening) stopListening();
        stopListening = null;
        editing = null;
        confirming = null;
        selected = null;
        shownItems = [];
        autoError = null;
        failed.clear();
      },
    });
  }
  // Every opening picks its list anew: the inbox, or the review list when the inbox is empty.
  tab = null;
  overlay.setTitle('');
  overlay.body.replaceChildren(el('p', 'hint', t('mem.inbox.loading')));
  overlay.open();
  // Another PC's sync or a finished capture changes the list while it is open.
  // Not while a draft is open: a repaint would throw the typed text away.
  if (!stopListening && typeof window.lunacore.onMemoryChanged === 'function') {
    stopListening = window.lunacore.onMemoryChanged(() => {
      if (editing !== null || busy.size !== 0) return;
      // The repaint keeps the keyboard where it was: on the same entry, if it is still there.
      const focused = document.activeElement && document.activeElement.closest ? document.activeElement.closest('.mem-inbox__item') : null;
      if (focused) load(focused.dataset.key);
      else load();
    });
  }
  await load();
}
