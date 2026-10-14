// ============================================================================
// LunaCore - Life dashboard: Transactions tab (renderer)
// ----------------------------------------------------------------------------
// Every money movement of the viewed period in one table - expenses, paid
// bills and savings deposits - filterable by type and category. Any row can
// be fixed in place (an expense: date, amount, category, note; a paid bill:
// amount and date) or removed with one click; removal answers with an Undo
// toast that puts the row back, so a mistake is never more than a click from
// gone and a wrong delete never more than a click from back.
// ============================================================================

'use strict';

import { t } from './util.js';
import {
  el, button, iconButton, field, input, select, amountField, money, shortDate, catName, catById, catColor,
  categoryOptions, getState, act, setStatus, toast,
} from './lifeui.js';

const TYPES = ['all', 'expense', 'bill', 'deposit'];
// Kept across re-renders: the filter and the row being edited ('type:id').
let typeFilter = 'all';
let catFilter = '';
let editing = null;
let shownMonth = null; // an open editor never follows you into another period
let rerender = () => {};

const keyOf = (r) => `${r.type}:${r.id}`;

// --- undoable removal -----------------------------------------------------------

/** The op that removes a row and the one that would put it back. */
function removal(r) {
  if (r.type === 'expense') {
    const known = r.category === 'other' || getState().budget.categories.some((c) => c.id === r.category);
    return {
      remove: ['deleteExpense', { id: r.id }],
      restore: ['addExpense', { date: r.date, amount: r.amount, category: known ? r.category : 'other', note: r.note }],
    };
  }
  if (r.type === 'bill') {
    return {
      remove: ['unpayBill', { id: r.id, month: r.month }],
      restore: ['payBill', { id: r.id, month: r.month, amount: r.amount, paidOn: r.date }],
    };
  }
  const goal = getState().budget.goals.find((g) => g.id === r.goal);
  // A deposit without its own note is shown under the pot's name: keep it empty.
  const note = goal && r.note === goal.name ? '' : r.note;
  return {
    remove: ['deleteDeposit', { id: r.id }],
    restore: ['addDeposit', { date: r.date, goal: r.goal, amount: r.amount, note }],
  };
}

async function remove(r) {
  const { remove: [op, data], restore } = removal(r);
  const res = await act(op, data);
  if (!res.ok) return;
  setStatus('');
  toast(t(`life.tx.removed.${r.type}`, { what: label(r), amount: money(r.amount) }), () => act(...restore));
}

// --- inline editors -----------------------------------------------------------

function expenseEditor(r) {
  const form = el('form', 'life-tx__edit');
  const date = input({ type: 'date' });
  date.value = r.date;
  const amount = amountField('life.f.amount', r.amount);
  const cat = select(categoryOptions(getState().budget), r.category);
  const note = input({ maxlength: '200' });
  note.value = r.note;
  const save = el('button', 'pad-send life-btn', t('life.save'));
  save.type = 'submit';
  form.append(field('life.f.date', date), amount.wrap, field('life.f.category', cat), field('life.f.note', note, 'life-field--grow'), save, button('life.cancel', stopEdit));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = amount.value();
    if (v === null || v <= 0) {
      setStatus(t('life.err.bad-amount'), true);
      amount.input.focus();
      return;
    }
    save.disabled = true;
    const res = await act('updateExpense', { id: r.id, date: date.value, amount: v, category: cat.value, note: note.value });
    if (res.ok) {
      setStatus(t('life.tx.saved'));
      stopEdit();
    } else save.disabled = false;
  });
  return { form, focus: amount.input };
}

function billEditor(r) {
  const form = el('form', 'life-tx__edit');
  const amount = amountField('life.bills.paidAmount', r.amount);
  const date = input({ type: 'date' });
  date.value = r.date;
  const save = el('button', 'pad-send life-btn', t('life.save'));
  save.type = 'submit';
  form.append(amount.wrap, field('life.tx.paidOn', date), save, button('life.cancel', stopEdit));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = amount.value();
    if (v === null || v < 0) {
      setStatus(t('life.err.bad-amount'), true);
      amount.input.focus();
      return;
    }
    save.disabled = true;
    const res = await act('payBill', { id: r.id, month: r.month, amount: v, paidOn: date.value });
    if (res.ok) {
      setStatus(t('life.tx.saved'));
      stopEdit();
    } else save.disabled = false;
  });
  return { form, focus: amount.input };
}

function stopEdit() {
  editing = null;
  rerender();
}

// --- table --------------------------------------------------------------------

function label(r) {
  if (r.note) return r.note;
  return r.type === 'expense' ? catName(catById(r.category)) : '';
}

function kindCell(r) {
  const td = el('td', 'life-tx__kind');
  const dot = el('span', 'life-dot');
  if (r.type === 'expense') {
    dot.style.background = catColor(r.category);
    td.append(dot, document.createTextNode(catName(catById(r.category))));
  } else {
    const bucketKey = r.type === 'deposit' || r.kind === 'saving' ? 'savings' : 'fixed';
    dot.style.background = `var(--life-${bucketKey})`;
    td.append(dot, document.createTextNode(t(r.type === 'deposit' ? 'life.tx.deposit' : `life.tx.kind.${r.kind}`)));
  }
  return td;
}

function row(r) {
  const tr = el('tr', `life-tx__row is-${r.type}`);
  const acts = el('td', 'life-tx__acts');
  if (r.type !== 'deposit') {
    acts.append(
      iconButton('✎', 'life.edit', () => {
        editing = keyOf(r);
        rerender();
      })
    );
  }
  acts.append(iconButton('✕', r.type === 'bill' ? 'life.tx.unpay' : 'life.delete', () => remove(r), 'is-danger'));
  tr.append(el('td', 'life-num life-tx__date', shortDate(r.date)), el('td', 'life-tx__what', label(r) || '–'), kindCell(r), el('td', 'life-num life-tx__amt', money(r.amount)), acts);
  return tr;
}

function editRow(r) {
  const tr = el('tr', 'life-tx__row is-editing');
  const td = el('td');
  td.colSpan = 5;
  const ed = r.type === 'expense' ? expenseEditor(r) : billEditor(r);
  td.append(ed.form);
  tr.append(td);
  queueMicrotask(() => ed.focus.focus());
  return tr;
}

function filters(budget) {
  const bar = el('div', 'life-tx__filters');
  const type = select(TYPES.map((k) => [k, t(`life.tx.type.${k}`)]), typeFilter);
  type.addEventListener('change', () => {
    typeFilter = type.value;
    rerender();
  });
  const cat = select([['', t('life.tx.allCats')], ...categoryOptions(budget)], catFilter);
  cat.addEventListener('change', () => {
    catFilter = cat.value;
    // A category only narrows expenses: switch the type to match.
    if (catFilter && typeFilter !== 'expense') typeFilter = 'expense';
    rerender();
  });
  bar.append(field('life.tx.type', type), field('life.f.category', cat));
  return bar;
}

function visible(rows) {
  return rows.filter((r) => (typeFilter === 'all' || r.type === typeFilter) && (!catFilter || (r.type === 'expense' && r.category === catFilter)));
}

/** Rebuilds the Transactions tab into `root`. */
export function renderTx(root, state) {
  rerender = () => renderTx(root, getState());
  if (state.summary.month !== shownMonth) {
    shownMonth = state.summary.month;
    editing = null;
  }
  const rows = visible(state.summary.transactions);
  if (editing && !rows.some((r) => keyOf(r) === editing)) editing = null;
  const card = el('section', 'mc-bucket life-bucket');
  const head = el('div', 'life-tx__head');
  head.append(el('h3', 'mc-bucket__title', t('life.tx.title')), filters(state.budget));
  card.append(head);
  if (!rows.length) {
    card.append(el('p', 'hint', t(state.summary.transactions.length ? 'life.tx.noMatch' : 'life.tx.none')));
    root.replaceChildren(card);
    return;
  }
  const wrap = el('div', 'life-table-wrap');
  const table = el('table', 'life-table life-tx');
  const cap = el('caption', 'life-sr', t('life.tx.title'));
  const head2 = el('tr');
  for (const key of ['life.f.date', 'life.tx.what', 'life.tx.kindCol', 'life.f.amount', 'life.tx.actions']) head2.append(el('th', '', t(key)));
  const thead = el('thead');
  thead.append(head2);
  const tbody = el('tbody');
  for (const r of rows) tbody.append(editing === keyOf(r) ? editRow(r) : row(r));
  table.append(cap, thead, tbody);
  wrap.append(table);
  const total = Math.round(rows.reduce((sum, r) => sum + r.amount, 0) * 100) / 100;
  card.append(wrap, el('p', 'life-total', t('life.tx.total', { n: rows.length, amount: money(total) })));
  root.replaceChildren(card);
}
