// ============================================================================
// LunaCore - "Check if still true" in the memory window (renderer)
// ----------------------------------------------------------------------------
// Sonnet reads the project's code and git history and says whether a
// confirmed memory still holds (src/memorycheck.js through
// src/memorybrainipc.js). This draws, per confirmed memory on the Review and
// All memories tabs:
//
//   the button   "Check if still true"; disabled with the reason as its
//                tooltip when this PC has no folder of the project, and while
//                any check runs (one model job at a time)
//   the badge    the last answer (holds / fixed / partly / fixable / unknown),
//                its date, the note and the evidence
//   the actions  partly -> Edit, prefilled with the suggested text;
//                fixed -> Retire, asked twice (All memories; the Review tab
//                has its own); fixable -> the entry's "Make a to-do"
//
// and, on the All memories tab, the progress line of "Check all".
// Nothing here deletes or edits by itself. Model text: textContent and form
// values only, never markup.
// ============================================================================

'use strict';

import { t } from './util.js';

const VERDICTS = ['holds', 'fixed', 'partly', 'fixable', 'unknown'];
/** Mirrors src/memoryrecord.js MAX_TITLE / MAX_BODY (main checks both again). */
const MAX_TITLE_CHARS = 200;
const MAX_BODY_CHARS = 5000;

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

const isVerdict = (v) => VERDICTS.includes(v);
/** The project of an entry: its own field (review list), or its key's part before the id (All memories). */
const projectOf = (item) => (typeof item.project === 'string' ? item.project : String(item.key || '').slice(0, Math.max(0, String(item.key || '').lastIndexOf('/'))));

/** The i18n key of a refused check start. */
export function checkStartKey(reason) {
  if (reason === 'busy') return 'mem.check.err.busy';
  if (reason === 'no-folder') return 'mem.check.err.noFolder';
  if (reason === 'empty') return 'mem.check.err.empty';
  return 'mem.inbox.err.failed';
}

/** The i18n key of a refused check call on an entry, or null when the reason is not one of its own. */
export function checkReasonKey(reason) {
  if (reason === 'busy' || reason === 'no-folder') return checkStartKey(reason);
  if (reason === 'not-partly') return 'mem.inbox.err.gone';
  return null;
}

/** The i18n key of why the last check failed (the checker's status.error). */
export function checkErrorKey(reason) {
  if (reason === 'model-no-claude') return 'mem.brain.err.noClaude';
  if (reason === 'model-timeout') return 'mem.brain.err.timeout';
  if (reason === 'changed') return 'mem.check.err.changed';
  if (['bad-answer', 'bad-verdict', 'model-bad-json', 'model-cli-error'].includes(reason)) return 'mem.brain.err.reply';
  return 'mem.brain.err.failed';
}

/** What a check run is doing or last did, in words; '' when there is nothing to say (for this project). */
export function checkStatusLine(status, project) {
  if (!status || !status.project || (project && status.project !== project)) return '';
  if (status.running) return t('mem.check.running', { done: status.done, total: status.total });
  const v = status.verdicts || {};
  const n = (k) => (Number.isInteger(v[k]) ? v[k] : 0);
  const done = t('mem.check.done', { holds: n('holds'), fixed: n('fixed'), partly: n('partly'), fixable: n('fixable'), unknown: n('unknown') });
  return status.failed ? `${done} ${t('mem.check.failed', { failed: status.failed, reason: t(checkErrorKey(status.error)) })}` : done;
}

/** The last answer of one memory: verdict badge, date, note, evidence. Null when it was never checked on this PC. */
export function checkBadge(check) {
  if (!check || !isVerdict(check.verdict)) return null;
  const box = el('div', `mem-check mem-check--${check.verdict}`);
  const head = el('p', 'mem-inbox__note');
  // The verdict in words, never by colour alone.
  head.append(
    el('span', `mem-check__badge mem-check__badge--${check.verdict}`, t(`mem.check.verdict.${check.verdict}`)),
    ' ',
    el('span', 'mem-inbox__date', t('mem.check.on', { date: String(check.date || '') })),
  );
  box.append(head);
  if (check.note) box.append(el('p', 'mem-inbox__note', check.note));
  const evidence = Array.isArray(check.evidence) ? check.evidence.filter((e) => typeof e === 'string' && e) : [];
  if (evidence.length) {
    const list = el('ul', 'mem-check__evidence');
    list.setAttribute('aria-label', t('mem.check.evidence'));
    for (const e of evidence) list.append(el('li', 'hint', e));
    box.append(list);
  }
  if (check.verdict === 'fixable') box.append(el('p', 'hint', t('mem.check.fixableHint')));
  return box;
}

/**
 * The "Check if still true" button of one entry.
 * @param {{checkable: boolean, running: boolean, checking: boolean, off: boolean, onClick: () => void}} ctx
 *   checkable = this PC has the project's folder; running = a check holds the model;
 *   checking = this entry is the one being checked
 */
export function checkButton({ checkable, running, checking, off, onClick }) {
  const b = button('port-btn mem-inbox__btn', t(checking ? 'mem.check.checking' : 'mem.check.button'), onClick);
  b.disabled = off || running || !checkable;
  if (!checkable) b.title = t('mem.check.noFolderHint');
  else if (running && !checking) b.title = t('mem.check.busyHint');
  return b;
}

/** The corrected-text form after a `partly` answer. Same class as the inbox edit form: Enter / Esc work on it. */
function editForm(draft, { onSave, onCancel }) {
  const form = el('form', 'mem-inbox__form');
  const title = el('input', 'mem-inbox__input');
  title.type = 'text';
  title.value = draft.title;
  title.maxLength = MAX_TITLE_CHARS;
  const body = el('textarea', 'mem-inbox__input mem-inbox__text');
  body.value = draft.body;
  body.rows = 8;
  body.maxLength = MAX_BODY_CHARS;
  const save = el('button', 'port-btn mem-inbox__btn mem-inbox__btn--approve', t('mem.inbox.save'));
  save.type = 'submit';
  const cancel = button('port-btn mem-inbox__btn', t('mem.inbox.cancel'), onCancel);
  const problem = el('p', 'hint is-fail');
  problem.setAttribute('role', 'alert');
  problem.hidden = true;
  const field = (labelKey, control) => {
    const label = el('label', 'ui-field');
    label.append(el('span', 'ui-field__label', t(labelKey)), control);
    return label;
  };
  const row = el('div', 'mem-inbox__actions');
  row.append(save, cancel);
  form.append(el('p', 'hint', t('mem.check.editHint')), field('mem.inbox.field.title', title), field('mem.inbox.field.body', body), problem, row);
  const refused = (key) => {
    // A refused save keeps the form and what was typed in it.
    problem.textContent = t(key);
    problem.hidden = false;
    save.disabled = false;
  };
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (save.disabled) return;
    save.disabled = true;
    onSave(title.value, body.value).then(
      (refusal) => {
        if (refusal) refused(refusal);
      },
      (err) => {
        console.error('[memory] check edit failed:', err);
        refused('mem.inbox.err.failed');
      },
    );
  });
  queueMicrotask(() => title.focus());
  return form;
}

/**
 * The check flow of the memory window. Like the to-do flow, an open edit form
 * holds the window's `editing`, so every draft lock applies to it.
 * @param {{actResult: (key: string, fn: string, ...args: unknown[]) => Promise<object|null>,
 *   call: (fn: string, ...args: unknown[]) => Promise<object>, failureOf: (key: string) => string|undefined,
 *   clearFailure: (key: string) => void, reasonKey: (reason: string) => string, load: (key?: string) => unknown,
 *   getEditing: () => string|null, setEditing: (key: string|null) => void}} w
 */
export function createCheckFlow(w) {
  /** {key, title, body} of the open edit form, or null. */
  let draft = null;
  /** The key whose Retire (All memories tab) waits for a second click, or null. */
  let confirming = null;
  let status = null;
  /** A check or the usefulness scan holds the model (main's shared lock). */
  let busy = false;
  let checkable = new Set();
  /** An i18n key when main refused "Check all", or null. */
  let startError = null;

  const close = (key) => {
    draft = null;
    w.setEditing(null);
    w.load(key);
  };
  const running = () => busy || Boolean(status && status.running);

  async function check(key) {
    await w.actResult(key, 'memoryCheck', key);
    w.load(key);
  }

  /** Opens Edit with the suggested text of a `partly` answer (the memory's own text when there is none). */
  function openEdit(item) {
    if (w.getEditing() !== null) return;
    const suggested = item.check && typeof item.check.suggested === 'string' && item.check.suggested ? item.check.suggested : item.body;
    draft = { key: item.key, title: item.title, body: suggested };
    w.setEditing(item.key);
    w.load(item.key);
  }

  return {
    /** memory:check-status's answer, read on every repaint. */
    setStatus(res) {
      status = res && res.ok && res.status ? res.status : null;
      busy = Boolean(res && res.ok && res.busy === true);
      checkable = new Set(res && res.ok && Array.isArray(res.checkable) ? res.checkable : []);
    },
    status: () => status,
    running,
    canCheck: (project) => checkable.has(project),
    startError: () => startError,
    async checkAll(project) {
      startError = null;
      const res = await w.call('memoryCheckAll', project);
      if (!res || !res.ok) startError = checkStartKey(res && res.reason);
      w.load();
    },
    /** The check button of an entry. */
    button(item, off) {
      return checkButton({
        checkable: checkable.has(projectOf(item)),
        running: running(),
        checking: Boolean(status && status.running && status.key === item.key),
        off,
        onClick: () => check(item.key),
      });
    },
    /** The verdict's own actions: Edit after partly; Retire after fixed when `retire` (the entry has none of its own). */
    actions(item, { off, retire = false }) {
      const verdict = item.check && item.check.verdict;
      const out = [];
      if (verdict === 'partly') {
        const edit = button('port-btn mem-inbox__btn', t('mem.check.edit'), () => openEdit(item));
        edit.disabled = off;
        out.push(edit);
      }
      if (verdict === 'fixed' && retire) {
        const ask = button('port-btn port-btn--kill mem-inbox__btn mem-inbox__btn--reject', t('mem.inbox.review.retire'), () => {
          confirming = item.key;
          w.load(item.key);
        });
        ask.disabled = off;
        out.push(ask);
      }
      return out;
    },
    /** The two-step Retire question of an entry (All memories), or null when it is not asked. */
    retireAsk(item, off) {
      if (confirming !== item.key) return null;
      const box = el('div');
      const ask = el('p', 'mem-inbox__ask', t('mem.inbox.review.retireAsk'));
      ask.setAttribute('role', 'alert');
      const no = button('port-btn mem-inbox__btn', t('mem.inbox.cancel'), () => {
        confirming = null;
        w.load(item.key);
      });
      const yes = button('port-btn port-btn--kill mem-inbox__btn', t('mem.inbox.review.retireYes'), async () => {
        await w.actResult(item.key, 'memoryReviewRetire', item.key);
        confirming = null;
        w.load();
      });
      for (const b of [no, yes]) b.disabled = off;
      const row = el('div', 'mem-inbox__actions');
      // Cancel first: it is where the keyboard focus lands after the repaint.
      row.append(no, yes);
      box.append(ask, row);
      return box;
    },
    /** The open edit form of this entry, or null. */
    formOf(key) {
      if (w.getEditing() !== key || !draft || draft.key !== key) return null;
      return editForm(draft, {
        onCancel: () => close(key),
        onSave: async (title, body) => {
          if (await w.actResult(key, 'memoryCheckEdit', key, { title, body })) {
            close(key);
            return null;
          }
          const reason = w.failureOf(key) || 'failed';
          w.clearFailure(key);
          return w.reasonKey(reason);
        },
      });
    },
    /** Forgets the draft and the question (the window closed, or the entry left the list). */
    reset() {
      draft = null;
      confirming = null;
      startError = null;
    },
  };
}
