// ============================================================================
// LunaCore - Life dashboard: Money column (renderer)
// ----------------------------------------------------------------------------
// "Left until payday" headline, quick expense entry (the amount takes
// arithmetic - lifecalc.js), category limit bars and the recent expenses with
// edit / delete. Renders from the shared budget state in lifeui.js; every
// change goes through act() -> life:budget-do, main validates it.
// ============================================================================

'use strict';

import { t } from './util.js';
import {
  el, bucket, relabel, button, armedButton, field, input, select, amountField, bar,
  money, shortDate, today, catName, catById, getState, onState, act, setStatus,
} from './lifeui.js';

let els = null;
let editingId = null;

function categoryOptions(budget) {
  const opts = budget.categories.map((c) => [c.id, catName(c)]);
  if (!budget.categories.some((c) => c.id === 'other')) opts.push(['other', t('life.cat.other')]);
  return opts;
}

// --- headline -----------------------------------------------------------------

function renderHero(s) {
  const node = els.hero;
  node.replaceChildren();
  node.append(el('p', 'life-hero__label', t('life.money.left')));
  node.append(el('p', `life-hero__big${s.left < 0 ? ' is-bad' : ''}`, money(s.left, s.currency)));
  node.append(
    el('p', 'life-hero__sub', t('life.money.perDay', { perDay: money(Math.max(0, s.perDay), s.currency), days: s.period.daysLeft, end: shortDate(s.period.end) }))
  );
  node.append(
    el('p', 'life-hero__math', t('life.money.math', { income: money(s.income.amount, s.currency), bills: money(s.billsTotal, s.currency), spent: money(s.spent, s.currency) }))
  );
  if (s.left < 0) node.append(el('p', 'life-hero__warn', t('life.money.overBudget')));
  if (!s.income.amount) node.append(el('p', 'hint', t('life.money.noIncome')));
}

// --- expense form ---------------------------------------------------------------

function buildForm() {
  const form = el('form', 'life-form');
  const amount = amountField('life.f.amount');
  const category = select([]);
  const note = input({ maxlength: '200' });
  const date = input({ type: 'date' });
  date.value = today();
  const submit = el('button', 'pad-send life-form__go', t('life.money.add'));
  submit.type = 'submit';
  const cancel = button('life.cancel', () => resetForm());
  cancel.hidden = true;
  const row = el('div', 'life-form__row');
  row.append(amount.wrap, field('life.f.category', category));
  const row2 = el('div', 'life-form__row');
  row2.append(field('life.f.note', note, 'life-field--grow'), field('life.f.date', date));
  const actions = el('div', 'life-form__actions');
  actions.append(submit, cancel);
  form.append(row, row2, actions);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    save();
  });
  return { form, amount, category, note, date, submit, cancel };
}

function resetForm() {
  const f = els.form;
  editingId = null;
  f.amount.set('');
  f.note.value = '';
  f.date.value = today();
  f.submit.textContent = t('life.money.add');
  f.cancel.hidden = true;
  f.amount.input.focus();
}

async function save() {
  const f = els.form;
  const value = f.amount.value();
  if (value === null || value <= 0) {
    setStatus(t('life.err.bad-amount'), true);
    f.amount.input.focus();
    return;
  }
  const data = { date: f.date.value, amount: value, category: f.category.value, note: f.note.value };
  const wasEdit = Boolean(editingId);
  f.submit.disabled = true;
  const res = await act(wasEdit ? 'updateExpense' : 'addExpense', wasEdit ? { ...data, id: editingId } : data);
  f.submit.disabled = false;
  if (!res.ok) return;
  setStatus(t(wasEdit ? 'life.money.saved' : 'life.money.added', { amount: money(value) }));
  resetForm();
}

function startEdit(e) {
  const f = els.form;
  editingId = e.id;
  f.amount.set(e.amount);
  f.category.value = e.category;
  f.note.value = e.note;
  f.date.value = e.date;
  f.submit.textContent = t('life.save');
  f.cancel.hidden = false;
  f.amount.input.focus();
}

// --- categories + recent --------------------------------------------------------

function renderCategories(s) {
  const body = els.cats;
  body.replaceChildren();
  const rows = s.categories.filter((c) => c.spent > 0 || c.limit > 0);
  if (!rows.length) {
    body.append(el('p', 'hint', t('life.money.noSpend')));
    return;
  }
  for (const c of rows) {
    const row = el('div', 'life-cat');
    const head = el('div', 'life-cat__head');
    head.append(el('span', 'life-cat__name', catName(c)));
    head.append(el('span', 'life-num', c.limit > 0 ? `${money(c.spent)} / ${money(c.limit)}` : money(c.spent)));
    row.append(head);
    if (c.limit > 0) {
      const used = c.spent / c.limit;
      row.append(bar(used, c.over ? 'is-bad' : used >= 0.8 ? 'is-warn' : ''));
      const note = c.over ? t('life.cat.over', { amount: money(-c.remaining) }) : t('life.cat.remaining', { amount: money(c.remaining) });
      row.append(el('span', `life-cat__note${c.over ? ' is-bad' : ''}`, note));
    }
    body.append(row);
  }
}

function renderRecent(s) {
  const body = els.recent;
  body.replaceChildren();
  if (!s.recent.length) {
    body.append(el('p', 'hint', t('life.money.noRecent')));
    return;
  }
  const list = el('ul', 'life-list');
  for (const e of s.recent) {
    const li = el('li', 'life-row');
    const text = el('div', 'life-row__text');
    const cat = catName(catById(e.category));
    text.append(el('span', 'life-row__title', e.note || cat));
    text.append(el('span', 'life-row__meta', `${shortDate(e.date)} · ${cat}`));
    const acts = el('div', 'life-row__acts');
    acts.append(button('life.edit', () => startEdit(e)), armedButton('life.delete', () => act('deleteExpense', { id: e.id })));
    li.append(text, el('span', 'life-num life-row__amount', money(e.amount)), acts);
    list.append(li);
  }
  body.append(list);
}

function render(state) {
  if (!els || !state) return;
  const { summary, budget } = state;
  renderHero(summary);
  const cat = els.form.category;
  const keep = cat.value;
  cat.replaceChildren(...select(categoryOptions(budget)).children);
  const ids = categoryOptions(budget).map(([id]) => id);
  cat.value = ids.includes(keep) ? keep : ids[0];
  renderCategories(summary);
  renderRecent(summary);
}

/** Builds the column once into `root`; it re-renders on every budget answer. */
export function mountMoney(root) {
  const hero = el('section', 'life-hero');
  hero.setAttribute('aria-live', 'polite');
  const add = bucket('life.money.addTitle');
  const form = buildForm();
  add.body.append(form.form);
  const cats = bucket('life.money.categories');
  const recent = bucket('life.money.recent');
  root.replaceChildren(hero, add.sec, cats.sec, recent.sec);
  els = { root, hero, form, cats: cats.body, recent: recent.body };
  onState(render);
  render(getState());
}

/** Language switch: titles relabelled, the form rebuilt keeping typed input. */
export function relabelMoney() {
  if (!els) return;
  relabel(els.root);
  const old = els.form;
  const kept = { amount: old.amount.input.value, note: old.note.value, date: old.date.value, cat: old.category.value };
  const form = buildForm();
  old.form.replaceWith(form.form);
  els.form = form;
  form.amount.set(kept.amount);
  form.note.value = kept.note;
  form.date.value = kept.date;
  if (editingId) {
    form.submit.textContent = t('life.save');
    form.cancel.hidden = false;
  }
  render(getState());
  form.category.value = kept.cat;
}

/** Focus the amount field (the panel opens straight into quick entry). */
export function focusMoney() {
  if (els) els.form.amount.input.focus();
}
