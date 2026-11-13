// ============================================================================
// LunaCore - the memory window's scores, conflicts and list of all memories (renderer)
// ----------------------------------------------------------------------------
// Parts of the memory window (memoryinbox.js) for the usefulness scan,
// conflicts and the archive (src/memorybrainipc.js):
//
//   usefulnessLine   "Usefulness: 72/100 - <why>" under every memory, or "?"
//                    for one the scan has not rated yet.
//   conflictEntry    two memories that contradict each other: keep A, keep B
//                    or keep both. The loser is superseded, never deleted.
//   memoriesPanel    the "All memories" list of one project, its Scan button
//                    and the scan's progress, archived memories with Restore.
//
// Memory text is free text from a model: textContent only, never markup.
// ============================================================================

'use strict';

import { t } from './util.js';

/** Characters of a body shown in a list. */
const PREVIEW_CHARS = 280;

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

const cut = (text, max = PREVIEW_CHARS) => {
  const s = String(text || '');
  return s.length > max ? `${s.slice(0, max).trimEnd()} ...` : s;
};

/** The usefulness line of a memory: its score and why, or "?" when it was never scanned. */
export function usefulnessLine(item) {
  if (!item || !Number.isInteger(item.usefulness)) return t('mem.brain.usefulnessNone');
  return item.usefulness_note ? t('mem.brain.usefulnessWhy', { score: item.usefulness, note: item.usefulness_note }) : t('mem.brain.usefulness', { score: item.usefulness });
}

/** The i18n key of a scan failure reason (src/memoryscan.js). */
export function scanErrorKey(reason) {
  if (reason === 'model-no-claude') return 'mem.brain.err.noClaude';
  if (reason === 'model-timeout') return 'mem.brain.err.timeout';
  if (reason === 'bad-answer' || reason === 'no-scores' || reason === 'model-bad-json' || reason === 'model-cli-error') return 'mem.brain.err.reply';
  return 'mem.brain.err.failed';
}

/** What the scan is doing or last did, in words; '' when there is nothing to say. */
export function scanLine(status) {
  if (!status || !status.project) return '';
  if (status.running) return t('mem.brain.scanning', { done: status.done, total: status.total });
  const skipped = status.skipped ? ` ${t('mem.brain.scanSkipped', { skipped: status.skipped })}` : '';
  if (status.failed) return t('mem.brain.scanFailed', { failed: status.failed, total: status.total, reason: t(scanErrorKey(status.error)) }) + skipped;
  return t('mem.brain.scanDone', { scored: status.scored, conflicts: status.conflicts }) + skipped;
}

/** The i18n key of a refused scan start. */
export function scanStartKey(reason) {
  if (reason === 'busy') return 'mem.brain.scanBusy';
  if (reason === 'empty') return 'mem.brain.scanEmpty';
  return 'mem.inbox.err.failed';
}

function conflictSide(label, item) {
  const box = el('div', 'mem-brain__side');
  const head = el('div', 'mem-inbox__head');
  head.append(el('span', 'mem-inbox__type', `${label} - ${item.type}`), el('span', 'mem-inbox__date', item.created));
  box.append(head, el('h3', 'mem-inbox__title', item.title), el('p', 'mem-inbox__body', cut(item.body)), el('p', 'mem-inbox__note', usefulnessLine(item)));
  return box;
}

/**
 * Two memories that contradict each other.
 * @param {object} item a conflict of memory:inbox ({id, source, note, a, b})
 * @param {{off: boolean, error: string|null, onKeep: (keep: 'a'|'b'|'both') => void}} ctx
 *   error = an i18n key of the last failed action, or null
 */
export function conflictEntry(item, { off, error, onKeep }) {
  const card = el('li', 'mem-inbox__item mem-brain__conflict');
  card.dataset.key = item.id;
  card.append(el('h3', 'mem-inbox__title', t('mem.brain.conflict.title')));
  const why = item.source === 'scan' ? (item.note ? t('mem.brain.conflict.scanWhy', { note: item.note }) : t('mem.brain.conflict.scan')) : t('mem.brain.conflict.check');
  card.append(el('p', 'mem-inbox__note mem-inbox__note--warn', why), conflictSide('A', item.a), conflictSide('B', item.b), el('p', 'hint', t('mem.brain.conflict.hint')));
  const actions = el('div', 'mem-inbox__actions');
  const keepA = button('port-btn mem-inbox__btn', t('mem.brain.conflict.keepA'), () => onKeep('a'));
  const keepB = button('port-btn mem-inbox__btn', t('mem.brain.conflict.keepB'), () => onKeep('b'));
  const keepBoth = button('port-btn mem-inbox__btn', t('mem.brain.conflict.keepBoth'), () => onKeep('both'));
  for (const b of [keepA, keepB, keepBoth]) b.disabled = off;
  actions.append(keepA, keepB, keepBoth);
  card.append(actions);
  if (error) {
    const err = el('p', 'hint is-fail', t(error));
    err.setAttribute('role', 'alert');
    card.append(err);
  }
  return card;
}

function memoryItem(item, { off, error, onRestore }) {
  const card = el('li', item.archived ? 'mem-inbox__item mem-brain__item--archived' : 'mem-inbox__item');
  card.dataset.key = item.key;
  const head = el('div', 'mem-inbox__head');
  head.append(el('span', 'mem-inbox__type', item.type));
  if (item.confidence !== 'confirmed') head.append(el('span', 'mem-inbox__project', t('mem.brain.waiting')));
  head.append(el('span', 'mem-inbox__date', item.created));
  card.append(head, el('h3', 'mem-inbox__title', item.title), el('p', 'mem-inbox__body', cut(item.body)), el('p', 'mem-inbox__note', usefulnessLine(item)));
  if (item.archived) {
    card.append(el('p', 'mem-inbox__note mem-inbox__note--warn', t('mem.brain.archived', { date: item.archived })));
    const restore = button('port-btn mem-inbox__btn', t('mem.brain.restore'), () => onRestore(item.key));
    restore.disabled = off(item.key);
    const actions = el('div', 'mem-inbox__actions');
    actions.append(restore);
    card.append(actions);
  }
  const problem = error(item.key);
  if (problem) {
    const err = el('p', 'hint is-fail', t(problem));
    err.setAttribute('role', 'alert');
    card.append(err);
  }
  return card;
}

/** A project key as the picker shows it: its last segment, the count, and whether memory is on. */
export function projectOption(p) {
  const name = String(p.project || '').split('/').pop() || p.project;
  return t(p.enabled || p.project === 'global' ? 'mem.brain.projectOption' : 'mem.brain.projectOff', { name, count: p.count });
}

/**
 * The "All memories" list of one project.
 * @param {object} list memory:list's answer
 * @param {{scanError: string|null, off: (key: string) => boolean, error: (key: string) => string|null,
 *   onProject: (project: string) => void, onScan: (project: string) => void, onRestore: (key: string) => void}} ctx
 *   scanError = an i18n key of a refused scan start, or null
 * @returns {{node: HTMLElement, list: HTMLElement|null}}
 */
export function memoriesPanel(list, ctx) {
  const panel = el('div', 'mem-brain');
  panel.append(el('p', 'hint mem-inbox__intro', t('mem.brain.intro')));
  if (!list || !list.ok) {
    panel.append(el('p', 'hint is-fail', t('mem.inbox.err.load')));
    return { node: panel, list: null };
  }
  if (!list.project) {
    panel.append(el('p', 'mem-inbox__empty', t('mem.brain.empty')));
    return { node: panel, list: null };
  }
  const bar = el('div', 'mem-brain__bar');
  const label = el('label', 'ui-field');
  const select = el('select', 'mem-brain__select');
  for (const p of list.projects) {
    const option = el('option', '', projectOption(p));
    option.value = p.project;
    option.selected = p.project === list.project;
    select.append(option);
  }
  select.addEventListener('change', () => ctx.onProject(select.value));
  label.append(el('span', 'ui-field__label', t('mem.brain.project')), select);
  const running = Boolean(list.scan && list.scan.running);
  const scanBtn = button('port-btn mem-inbox__btn mem-brain__scan', t(running ? 'mem.brain.scanRunning' : 'mem.brain.scan'), () => ctx.onScan(list.project));
  // One scan at a time: main refuses a second one too.
  scanBtn.disabled = running;
  bar.append(label, scanBtn);
  const status = el('p', 'hint mem-brain__status', scanLine(list.scan));
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  panel.append(bar, status);
  if (ctx.scanError) {
    const err = el('p', 'hint is-fail', t(ctx.scanError));
    err.setAttribute('role', 'alert');
    panel.append(err);
  }
  if (!list.items.length) {
    panel.append(el('p', 'mem-inbox__empty', t('mem.brain.empty')));
    return { node: panel, list: null };
  }
  const ul = el('ul', 'mem-inbox__list');
  for (const item of list.items) ul.append(memoryItem(item, { off: ctx.off, error: ctx.error, onRestore: ctx.onRestore }));
  panel.append(ul);
  if (list.total > list.items.length) panel.append(el('p', 'hint', t('mem.brain.more', { count: list.total - list.items.length })));
  return { node: panel, list: ul };
}
