// ============================================================================
// LunaCore - the memory window's scores, conflicts and list of all memories (renderer)
// ----------------------------------------------------------------------------
// Parts of the memory window (memoryinbox.js) for the usefulness scan,
// conflicts and the archive (src/memorybrainipc.js):
//
//   usefulnessLine   "Score 74 (usefulness 80, confirmed, read 3x) - <why>" under
//                    every memory (the final score main computed), or "?" for
//                    one that has no usefulness score yet.
//   healthLine       "Memory health 78/100 - ..." on top of the list of all
//                    memories, every part in words.
//   conflictEntry    two memories that contradict each other, or two confirmed
//                    ones that say nearly the same: keep A, keep B, keep both
//                    or merge (the inbox edit form, prefilled). The loser, or
//                    both merged ones, are superseded, never deleted.
//   memoriesPanel    the "All memories" list of one project, its Scan button
//                    and the scan's progress, archived memories with Restore,
//                    and a History expander per memory (memoryhistory.js).
//
// Memory text is free text from a model: textContent only, never markup.
// ============================================================================

'use strict';

import { t } from './util.js';
import { historyBlock } from './memoryhistory.js';

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

/** How sure a memory is, in words, for its score line. */
const CONFIDENCE_KEYS = {
  confirmed: 'mem.brain.conf.confirmed',
  observed: 'mem.brain.conf.observed',
  inferred: 'mem.brain.conf.inferred',
};

/**
 * The final score main computed for an item (src/memoryrecord.js finalScore), or
 * null when there is none to show: not sent, or the memory has no usefulness yet.
 * @returns {{score: number, usefulness: number, confidence: string, reads: number}|null}
 */
export function finalOf(item) {
  const final = item && item.final;
  const parts = final && final.parts;
  if (!parts || !Number.isInteger(final.score) || !Number.isInteger(parts.usefulness)) return null;
  return {
    score: final.score,
    usefulness: parts.usefulness,
    confidence: Object.hasOwn(CONFIDENCE_KEYS, parts.confidence) ? parts.confidence : 'observed',
    reads: Number.isInteger(parts.usage) && parts.usage > 0 ? parts.usage : 0,
  };
}

/**
 * The score line of a memory: "Score 74 (usefulness 80, confirmed, read 3x) - <why>",
 * or "?" when it was never rated. Without a final score from main it says the usefulness alone.
 */
export function usefulnessLine(item) {
  const final = finalOf(item);
  const note = item && item.usefulness_note;
  if (final) {
    const params = { score: final.score, usefulness: final.usefulness, confidence: t(CONFIDENCE_KEYS[final.confidence]), reads: final.reads };
    return note ? t('mem.brain.scoreWhy', { ...params, note }) : t('mem.brain.score', params);
  }
  if (!item || !Number.isInteger(item.usefulness)) return t('mem.brain.usefulnessNone');
  return note ? t('mem.brain.usefulnessWhy', { score: item.usefulness, note }) : t('mem.brain.usefulness', { score: item.usefulness });
}

const count = (v) => (Number.isInteger(v) && v >= 0 ? v : 0);

/** The health line of a project's memories, every part in words (never colour alone); '' when main sent none. */
export function healthLine(health) {
  if (!health || !Number.isInteger(health.score) || !health.parts) return '';
  const p = health.parts;
  return t('mem.brain.health', {
    score: health.score,
    unscored: count(p.unscored),
    average: Number.isInteger(p.average) ? p.average : '?',
    conflicts: count(p.conflicts),
    review: count(p.review),
    backlog: count(p.backlog),
    days: count(p.backlogDays),
    archived: count(p.archived),
  });
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

/** Why a pair is listed, in words: the scan's reason, the cheap check, or near-duplicates. */
export function pairWhy(item) {
  if (item.source === 'duplicate') return t('mem.brain.dup.why');
  if (item.source === 'scan') return item.note ? t('mem.brain.conflict.scanWhy', { note: item.note }) : t('mem.brain.conflict.scan');
  return t('mem.brain.conflict.check');
}

/** The text a merge starts from: A's title, and both bodies joined. */
export function mergeDraft(item) {
  return { title: item.a.title, body: `${item.a.body}\n\n${item.b.body}` };
}

/**
 * Two memories that contradict each other, or say nearly the same (source 'duplicate').
 * @param {object} item a pair of memory:inbox's conflicts ({id, source, note, a, b})
 * @param {{off: boolean, error: string|null, onKeep: (keep: 'a'|'b'|'both') => void,
 *   onMerge?: () => void, form?: HTMLElement|null}} ctx
 *   error = an i18n key of the last failed action, or null; form = the open merge
 *   draft (the inbox edit form), shown instead of the buttons
 */
export function conflictEntry(item, { off, error, onKeep, onMerge = null, form = null }) {
  const duplicate = item.source === 'duplicate';
  const card = el('li', `mem-inbox__item ${duplicate ? 'mem-brain__duplicate' : 'mem-brain__conflict'}`);
  card.dataset.key = item.id;
  card.append(el('h3', 'mem-inbox__title', t(duplicate ? 'mem.brain.dup.title' : 'mem.brain.conflict.title')));
  card.append(el('p', duplicate ? 'mem-inbox__note' : 'mem-inbox__note mem-inbox__note--warn', pairWhy(item)), conflictSide('A', item.a), conflictSide('B', item.b));
  card.append(el('p', 'hint', t(duplicate ? 'mem.brain.dup.hint' : 'mem.brain.conflict.hint')));
  if (form) {
    card.append(el('p', 'hint', t('mem.brain.merge.formHint')), form);
  } else {
    const actions = el('div', 'mem-inbox__actions');
    const keepA = button('port-btn mem-inbox__btn', t('mem.brain.conflict.keepA'), () => onKeep('a'));
    const keepB = button('port-btn mem-inbox__btn', t('mem.brain.conflict.keepB'), () => onKeep('b'));
    const keepBoth = button('port-btn mem-inbox__btn', t('mem.brain.conflict.keepBoth'), () => onKeep('both'));
    const merge = onMerge ? button('port-btn mem-inbox__btn', t('mem.brain.merge'), onMerge) : null;
    const buttons = [keepA, keepB, keepBoth, ...(merge ? [merge] : [])];
    for (const b of buttons) b.disabled = off;
    actions.append(...buttons);
    card.append(actions);
  }
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
  // Where it came from and what happened to it, read only when opened.
  card.append(historyBlock(item.key));
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
  // The project's memory health on top, in words (src/memorybrainipc.js projectHealth).
  const health = healthLine(list.health);
  if (health) panel.append(el('p', 'hint mem-brain__health', health));
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
