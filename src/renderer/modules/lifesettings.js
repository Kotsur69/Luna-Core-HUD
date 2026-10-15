// ============================================================================
// LunaCore - Life dashboard: Settings tab (renderer)
// ----------------------------------------------------------------------------
// Everything the budget math is built from: income + payday, the categories
// (a "planned" envelope with a monthly plan such as food or fuel, or "free"
// spending such as snacks or the cinema), the recurring bills - a bill, a
// subscription, or a saving that feeds a pot (a monthly investment) - and
// the savings pots themselves. Deleting a category, bill or pot takes two
// clicks: those carry history an Undo toast cannot bring back.
// ============================================================================

'use strict';

import { t } from './util.js';
import {
  el, bucket, button, armedButton, field, input, select, amountField, money, monthLabel, lang, catName,
  getState, act as uiAct, setStatus,
} from './lifeui.js';
import { cloudCard } from './lifecloud.js';

let editingBillId = null;
let editingGoalId = null;
let isSaving = false;

/**
 * One save at a time: a fast double Enter would otherwise send the op twice
 * and the second, refused by the write rate limit, would show an error over
 * a save that worked. The extra press is simply ignored.
 */
async function act(op, data) {
  if (isSaving) return { ok: false, reason: 'busy' };
  isSaving = true;
  try {
    return await uiAct(op, data);
  } finally {
    isSaving = false;
  }
}

const monthNames = () =>
  Array.from({ length: 12 }, (_, i) => [String(i + 1), new Intl.DateTimeFormat(lang(), { month: 'long' }).format(new Date(2026, i, 1))]);

/** Empty text = 0; else the parsed amount, or null when it is not a number. */
const optionalAmount = (f) => (f.input.value.trim() === '' ? 0 : f.value());

function submitButton(labelKey) {
  const b = el('button', 'pad-send life-form__go', t(labelKey));
  b.type = 'submit';
  return b;
}

// --- income -------------------------------------------------------------------

function incomeCard(budget) {
  const card = bucket('life.set.income');
  const form = el('form', 'life-form__row');
  const amount = amountField('life.settings.income', budget.income.amount || '');
  const payday = input({ type: 'number', min: '1', max: '31' });
  payday.value = String(budget.income.payday);
  const go = el('button', 'pad-send life-btn', t('life.save'));
  go.type = 'submit';
  form.append(amount.wrap, field('life.settings.payday', payday), go);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = amount.value();
    if (v === null || v < 0) {
      setStatus(t('life.err.bad-amount'), true);
      return;
    }
    const res = await act('setIncome', { amount: v, payday: Number(payday.value) });
    if (res.ok) setStatus(t('life.settings.saved'));
  });
  card.body.append(form, el('p', 'hint', t('life.set.paydayHint')));
  return card.sec;
}

// --- categories -----------------------------------------------------------------

function kindSelect(value) {
  return select([['planned', t('life.set.kindPlanned')], ['free', t('life.set.kindFree')]], value);
}

function categoryLine(c) {
  const li = el('li', 'life-row life-row--cat');
  const name = input({ maxlength: '60', placeholder: catName({ id: c.id, name: '' }) });
  name.value = c.name;
  const kind = kindSelect(c.kind);
  const plan = amountField('life.set.plan', c.plan || '');
  const syncPlan = () => {
    plan.wrap.hidden = kind.value !== 'planned';
  };
  kind.addEventListener('change', syncPlan);
  syncPlan();
  const save = button('life.save', async () => {
    const pv = kind.value === 'planned' ? optionalAmount(plan) : 0;
    if (pv === null || pv < 0) {
      setStatus(t('life.err.bad-amount'), true);
      return;
    }
    const res = await act('saveCategory', { id: c.id, name: name.value, kind: kind.value, plan: pv });
    if (res.ok) setStatus(t('life.settings.saved'));
  });
  const acts = el('div', 'life-row__acts');
  acts.append(save);
  if (c.id !== 'other') acts.append(armedButton('life.delete', () => act('deleteCategory', { id: c.id })));
  li.append(field('life.f.name', name, 'life-field--grow'), field('life.set.kind', kind), plan.wrap, acts);
  return li;
}

function newCategoryForm() {
  const form = el('form', 'life-form__row');
  const name = input({ maxlength: '60' });
  const kind = kindSelect('free');
  const go = el('button', 'life-btn', t('life.settings.addCategory'));
  go.type = 'submit';
  form.append(field('life.settings.newCategory', name, 'life-field--grow'), field('life.set.kind', kind), go);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const res = await act('saveCategory', { name: name.value, kind: kind.value, plan: 0 });
    if (res.ok) setStatus(t('life.settings.saved'));
  });
  return form;
}

function categoriesCard(budget) {
  const card = bucket('life.set.categories');
  const plans = budget.categories.filter((c) => c.kind === 'planned').reduce((sum, c) => sum + c.plan, 0);
  card.body.append(el('p', 'hint', t('life.set.catHint')));
  const list = el('ul', 'life-list');
  for (const c of budget.categories) list.append(categoryLine(c));
  card.body.append(list, el('p', 'life-total', t('life.set.plansTotal', { amount: money(plans) })), newCategoryForm());
  return card.sec;
}

// --- bills ----------------------------------------------------------------------

function billForm(budget, rerender) {
  const b = budget.bills.find((x) => x.id === editingBillId) || null;
  const form = el('form', 'life-form');
  const name = input({ maxlength: '60' });
  name.value = b ? b.name : '';
  const expected = amountField('life.bills.expectedAmount', b ? b.expected : '');
  const dueDay = input({ type: 'number', min: '1', max: '31' });
  dueDay.value = String(b ? b.dueDay : 10);
  const kind = select(
    [['bill', t('life.bills.kindBill')], ['subscription', t('life.bills.kindSub')], ['saving', t('life.bills.kindSaving')]],
    b ? b.kind : 'bill'
  );
  const every = select([['month', t('life.bills.everyMonth')], ['year', t('life.bills.everyYear')]], b ? b.every : 'month');
  const month = select(monthNames(), String(b && b.month ? b.month : new Date().getMonth() + 1));
  const goal = select([['', t('life.set.noGoal')], ...budget.goals.map((g) => [g.id, g.name])], b ? b.goal : '');
  const monthField = field('life.bills.inMonth', month);
  const goalField = field('life.set.goal', goal);
  const sync = () => {
    monthField.hidden = every.value !== 'year';
    goalField.hidden = kind.value !== 'saving';
  };
  every.addEventListener('change', sync);
  kind.addEventListener('change', sync);
  sync();
  const r1 = el('div', 'life-form__row');
  r1.append(field('life.f.name', name, 'life-field--grow'), expected.wrap);
  const r2 = el('div', 'life-form__row');
  r2.append(field('life.bills.dueDay', dueDay), field('life.bills.kind', kind), goalField, field('life.bills.every', every), monthField);
  const actions = el('div', 'life-form__actions');
  actions.append(submitButton(b ? 'life.save' : 'life.bills.addBill'));
  if (b) {
    actions.append(
      button('life.cancel', () => {
        editingBillId = null;
        rerender();
      })
    );
  }
  form.append(r1, r2, actions);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = expected.value();
    if (v === null || v <= 0) {
      setStatus(t('life.err.bad-amount'), true);
      return;
    }
    const data = {
      name: name.value,
      expected: v,
      dueDay: Number(dueDay.value),
      kind: kind.value,
      every: every.value,
      month: every.value === 'year' ? Number(month.value) : 0,
      category: '',
      goal: kind.value === 'saving' ? goal.value : '',
    };
    if (b) data.id = b.id;
    const res = await act('saveBill', data);
    if (!res.ok) return;
    setStatus(t('life.bills.savedMsg', { name: data.name.trim() }));
    editingBillId = null;
    rerender();
  });
  if (b) queueMicrotask(() => name.focus());
  return form;
}

function billsCard(budget, rerender) {
  const card = bucket('life.bills.manage');
  card.body.append(el('p', 'hint', t('life.set.billHint')), billForm(budget, rerender));
  if (!budget.bills.length) return card.sec;
  const names = monthNames();
  const goalName = (id) => (budget.goals.find((g) => g.id === id) || {}).name;
  const list = el('ul', 'life-list');
  for (const b of budget.bills) {
    const li = el('li', `life-row${b.id === editingBillId ? ' is-editing' : ''}`);
    const text = el('div', 'life-row__text');
    const when = b.every === 'year' ? t('life.bills.whenYear', { day: b.dueDay, month: names[b.month - 1][1] }) : t('life.bills.whenMonth', { day: b.dueDay });
    const kindText = t(`life.tx.kind.${b.kind}`) + (b.kind === 'saving' && goalName(b.goal) ? ` → ${goalName(b.goal)}` : '');
    text.append(el('span', 'life-row__title', b.name), el('span', 'life-row__meta', `${kindText} · ${when}`));
    const acts = el('div', 'life-row__acts');
    acts.append(
      button('life.edit', () => {
        editingBillId = b.id;
        rerender();
      }),
      armedButton('life.delete', () => act('deleteBill', { id: b.id }))
    );
    li.append(text, el('span', 'life-num life-row__amount', money(b.expected)), acts);
    list.append(li);
  }
  card.body.append(list);
  return card.sec;
}

// --- savings pots -----------------------------------------------------------------

function goalForm(budget, rerender) {
  const g = budget.goals.find((x) => x.id === editingGoalId) || null;
  const form = el('form', 'life-form');
  const name = input({ maxlength: '60' });
  name.value = g ? g.name : '';
  const target = amountField('life.goals.target', g && g.target ? g.target : '');
  const saved = amountField('life.goals.saved', g && g.saved ? g.saved : '');
  const by = input({ type: 'month' });
  by.value = g ? g.by : '';
  const r1 = el('div', 'life-form__row');
  r1.append(field('life.f.name', name, 'life-field--grow'), field('life.goals.by', by));
  const r2 = el('div', 'life-form__row');
  r2.append(target.wrap, saved.wrap);
  const actions = el('div', 'life-form__actions');
  actions.append(submitButton(g ? 'life.save' : 'life.goals.new'));
  if (g) {
    actions.append(
      button('life.cancel', () => {
        editingGoalId = null;
        rerender();
      })
    );
  }
  form.append(r1, r2, el('p', 'hint', t('life.set.goalHint')), actions);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const tv = optionalAmount(target);
    const sv = optionalAmount(saved);
    if (tv === null || tv < 0 || sv === null || sv < 0) {
      setStatus(t('life.err.bad-amount'), true);
      return;
    }
    const data = { name: name.value, target: tv, saved: sv, by: by.value };
    if (g) data.id = g.id;
    const res = await act('saveGoal', data);
    if (!res.ok) return;
    setStatus(t('life.goals.savedMsg', { name: data.name.trim() }));
    editingGoalId = null;
    rerender();
  });
  if (g) queueMicrotask(() => name.focus());
  return form;
}

function goalsCard(budget, rerender) {
  const card = bucket('life.set.goals');
  card.body.append(goalForm(budget, rerender));
  if (!budget.goals.length) return card.sec;
  const list = el('ul', 'life-list');
  for (const g of budget.goals) {
    const li = el('li', `life-row${g.id === editingGoalId ? ' is-editing' : ''}`);
    const text = el('div', 'life-row__text');
    const target = g.target > 0 ? money(g.target) : t('life.goals.open');
    text.append(el('span', 'life-row__title', g.name), el('span', 'life-row__meta', g.by ? `${target} · ${monthLabel(g.by)}` : target));
    const acts = el('div', 'life-row__acts');
    acts.append(
      button('life.edit', () => {
        editingGoalId = g.id;
        rerender();
      }),
      armedButton('life.delete', () => act('deleteGoal', { id: g.id }))
    );
    li.append(text, el('span', 'life-num life-row__amount', money(g.saved)), acts);
    list.append(li);
  }
  card.body.append(list);
  return card.sec;
}

/** Rebuilds the Settings tab into `root`. */
export function renderSettings(root, state) {
  const rerender = () => renderSettings(root, getState());
  const { budget } = state;
  if (editingBillId && !budget.bills.some((b) => b.id === editingBillId)) editingBillId = null;
  if (editingGoalId && !budget.goals.some((g) => g.id === editingGoalId)) editingGoalId = null;
  const grid = el('div', 'life-grid life-grid--2');
  const left = el('div', 'life-stack');
  left.append(incomeCard(budget), categoriesCard(budget));
  const right = el('div', 'life-stack');
  right.append(billsCard(budget, rerender), goalsCard(budget, rerender), cloudCard());
  grid.append(left, right);
  root.replaceChildren(grid);
}
