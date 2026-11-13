// ============================================================================
// LunaCore - auto-accept section of the memory window (renderer)
// ----------------------------------------------------------------------------
// src/memoryautoaccept.js decides; this only shows it. Under the 'To approve'
// list: one switch per memory type that this PC's numbers offer (or that is
// already on), and the memories auto-accepted in the last days, each with an
// Undo (= reject, deleted on every PC). Main re-checks every switch and undo
// (src/memoryipc.js memory:auto-set / memory:auto-undo).
// Titles are model text: textContent only, never markup.
// ============================================================================

'use strict';

import { t } from './util.js';

const pct = (rate) => (typeof rate === 'number' ? Math.round(rate * 100) : 0);

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** One type's numbers in words: the rate, then hand, edit, auto and undo apart. */
export function autoRowLine(row) {
  return t('mem.auto.row', {
    type: row.type,
    rate: pct(row.rate),
    decisions: row.decisions,
    approved: row.approved,
    edited: row.edited,
    auto: row.auto,
    undone: row.undone,
  });
}

/** The rules of the switch, with the numbers main sent. */
export function autoIntro(bar) {
  return t('mem.auto.intro', { min: bar.min, days: bar.days, on: pct(bar.on), off: pct(bar.off) });
}

function switchRow(row, { onToggle, disabled }) {
  const label = el('label', 'mem-auto__row');
  const box = el('input', 'mem-auto__switch');
  box.type = 'checkbox';
  box.setAttribute('role', 'switch');
  box.checked = row.on;
  box.disabled = disabled;
  box.addEventListener('change', () => onToggle(row.type, box.checked));
  label.append(box, el('span', 'mem-auto__text', autoRowLine(row)));
  return label;
}

function recentRow(item, { onUndo, busy }) {
  const li = el('li', 'mem-auto__item');
  const undo = el('button', 'port-btn port-btn--kill mem-inbox__btn', t('mem.auto.undo'));
  undo.type = 'button';
  undo.disabled = busy.has(item.key);
  undo.addEventListener('click', () => onUndo(item.key));
  const project = String(item.project || '').split('/').pop() || '';
  li.append(el('span', 'mem-inbox__type', item.type), el('span', 'mem-inbox__project', project), el('span', 'mem-auto__title', item.title), el('span', 'mem-inbox__date', item.created), undo);
  return li;
}

/**
 * @param {{types: object[], recent: object[], bar: object}|null} auto memory:inbox `auto`
 * @param {{onToggle: (type: string, on: boolean) => void, onUndo: (key: string) => void,
 *   busy: Set<string>, switching: boolean, error: string|null}} opts
 *   switching = a switch call is in flight; error = an i18n key to show, or null
 * @returns {HTMLElement|null} null when main sent nothing (the section stays hidden)
 */
export function autoSection(auto, { onToggle, onUndo, busy, switching, error }) {
  if (!auto || !Array.isArray(auto.types) || !Array.isArray(auto.recent) || !auto.bar) return null;
  const section = el('section', 'mem-auto');
  section.setAttribute('aria-labelledby', 'mem-auto-title');
  const title = el('h3', 'mem-auto__heading', t('mem.auto.title'));
  title.id = 'mem-auto-title';
  section.append(title, el('p', 'hint', autoIntro(auto.bar)));
  if (auto.types.length) {
    const list = el('div', 'mem-auto__types');
    for (const row of auto.types) list.append(switchRow(row, { onToggle, disabled: switching }));
    section.append(list);
  } else {
    section.append(el('p', 'hint', t('mem.auto.none')));
  }
  section.append(el('h4', 'mem-auto__heading', t('mem.auto.recent', { days: auto.bar.undoDays })));
  if (auto.recent.length) {
    const list = el('ul', 'mem-auto__list');
    for (const item of auto.recent) list.append(recentRow(item, { onUndo, busy }));
    section.append(list);
  } else {
    section.append(el('p', 'hint', t('mem.auto.recentNone')));
  }
  if (error) {
    const err = el('p', 'hint is-fail', t(error));
    err.setAttribute('role', 'alert');
    section.append(err);
  }
  return section;
}
