// ============================================================================
// LunaCore - Life dashboard: Plan column (renderer)
// ----------------------------------------------------------------------------
// Savings goals (progress + how much to put aside per month, "+ add" a
// deposit), spending this week vs last week per category (arrow + text, never
// colour alone), and the settings the budget math needs: income + payday and
// the category list with monthly limits.
// ============================================================================

'use strict';

import { t } from './util.js';
import {
  el, bucket, relabel, button, armedButton, field, input, amountField, bar,
  money, monthLabel, catName, getState, onState, act, setStatus,
} from './lifeui.js';

let els = null;
let depositFor = null; // goal id with the open "+ add" editor
let editingGoalId = null;

// --- goals --------------------------------------------------------------------

function depositEditor(g) {
  const box = el('form', 'life-pay');
  const amount = amountField('life.goals.deposit');
  const save = el('button', 'pad-send life-btn', t('life.goals.addIt'));
  save.type = 'submit';
  const cancel = button('life.cancel', () => {
    depositFor = null;
    render(getState());
  });
  box.append(amount.wrap, save, cancel);
  box.addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = amount.value();
    if (v === null || v <= 0) {
      setStatus(t('life.err.bad-amount'), true);
      return;
    }
    const { id, name, target, saved, by } = g;
    const res = await act('saveGoal', { id, name, target, saved: Math.round((saved + v) * 100) / 100, by });
    if (!res.ok) return;
    setStatus(t('life.goals.deposited', { amount: money(v), name }));
    depositFor = null;
    render(getState());
  });
  queueMicrotask(() => amount.input.focus());
  return box;
}

function goalLine(g) {
  const li = el('li', 'life-goal');
  const head = el('div', 'life-cat__head');
  head.append(el('span', 'life-cat__name', g.name), el('span', 'life-num', `${money(g.saved)} / ${money(g.target)}`));
  li.append(head, bar(g.target ? g.saved / g.target : 0, g.pct >= 100 ? 'is-good' : ''));
  const note = g.pct >= 100 ? t('life.goals.done') : t('life.goals.perMonth', { amount: money(g.perMonth), by: monthLabel(g.by), months: g.monthsLeft });
  li.append(el('span', 'life-cat__note', `${g.pct}% · ${note}`));
  const acts = el('div', 'life-row__acts');
  const deposit = button(
    'life.goals.add',
    () => {
      depositFor = g.id;
      render(getState());
    },
    'life-btn pad-send'
  );
  acts.append(deposit, button('life.edit', () => editGoal(g)), armedButton('life.delete', () => act('deleteGoal', { id: g.id })));
  li.append(acts);
  if (depositFor === g.id) li.append(depositEditor(g));
  return li;
}

function buildGoalForm() {
  const form = el('form', 'life-form');
  const name = input({ maxlength: '60' });
  const target = amountField('life.goals.target');
  const saved = amountField('life.goals.saved');
  const by = input({ type: 'month' });
  const submit = el('button', 'pad-send life-form__go', t('life.goals.new'));
  submit.type = 'submit';
  const cancel = button('life.cancel', () => resetGoalForm());
  cancel.hidden = true;
  const r1 = el('div', 'life-form__row');
  r1.append(field('life.f.name', name, 'life-field--grow'), field('life.goals.by', by));
  const r2 = el('div', 'life-form__row');
  r2.append(target.wrap, saved.wrap);
  const actions = el('div', 'life-form__actions');
  actions.append(submit, cancel);
  form.append(r1, r2, actions);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const tv = target.value();
    const sv = saved.input.value.trim() === '' ? 0 : saved.value();
    if (tv === null || tv <= 0 || sv === null) {
      setStatus(t('life.err.bad-amount'), true);
      return;
    }
    const data = { name: name.value, target: tv, saved: sv, by: by.value };
    if (editingGoalId) data.id = editingGoalId;
    const res = await act('saveGoal', data);
    if (!res.ok) return;
    setStatus(t('life.goals.savedMsg', { name: data.name.trim() }));
    resetGoalForm();
  });
  return { form, name, target, saved, by, submit, cancel };
}

function resetGoalForm() {
  const f = els.goalForm;
  editingGoalId = null;
  f.name.value = '';
  f.target.set('');
  f.saved.set('');
  f.by.value = '';
  f.submit.textContent = t('life.goals.new');
  f.cancel.hidden = true;
}

function editGoal(g) {
  const f = els.goalForm;
  editingGoalId = g.id;
  f.name.value = g.name;
  f.target.set(g.target);
  f.saved.set(g.saved);
  f.by.value = g.by;
  f.submit.textContent = t('life.save');
  f.cancel.hidden = false;
  f.name.focus();
}

function renderGoals(s) {
  const body = els.goals;
  body.replaceChildren();
  if (!s.goals.length) {
    body.append(el('p', 'hint', t('life.goals.none')));
    return;
  }
  const list = el('ul', 'life-list');
  for (const g of s.goals) list.append(goalLine(g));
  body.append(list);
}

// --- week vs last week --------------------------------------------------------

function trend(now, before) {
  if (now === before) return { cls: '', text: t('life.week.same') };
  if (before === 0) return { cls: 'is-warn', text: t('life.week.new') };
  const pct = Math.round(((now - before) / before) * 100);
  return now > before ? { cls: 'is-warn', text: `▲ ${pct}%` } : { cls: 'is-good', text: `▼ ${-pct}%` };
}

function renderWeek(s, budget) {
  const body = els.week;
  body.replaceChildren();
  const rows = s.week.filter((w) => w.thisWeek > 0 || w.lastWeek > 0);
  if (!rows.length) {
    body.append(el('p', 'hint', t('life.week.none')));
    return;
  }
  const table = el('table', 'life-week');
  const head = el('tr');
  for (const key of ['life.week.category', 'life.week.this', 'life.week.last', 'life.week.change']) head.append(el('th', '', t(key)));
  table.append(head);
  const nameOf = (id) => catName(budget.categories.find((c) => c.id === id) || { id, name: '' });
  for (const w of [...rows, { id: null, ...s.weekTotal }]) {
    const tr = el('tr', w.id === null ? 'life-week__total' : '');
    const change = trend(w.thisWeek, w.lastWeek);
    tr.append(
      el('td', '', w.id === null ? t('life.week.total') : nameOf(w.id)),
      el('td', 'life-num', money(w.thisWeek)),
      el('td', 'life-num', money(w.lastWeek)),
      el('td', `life-num ${change.cls}`.trim(), change.text)
    );
    table.append(tr);
  }
  body.append(table);
}

// --- settings -------------------------------------------------------------------

function buildIncomeForm() {
  const form = el('form', 'life-form');
  const amount = amountField('life.settings.income');
  const payday = input({ type: 'number', min: '1', max: '31' });
  const submit = el('button', 'pad-send life-form__go', t('life.save'));
  submit.type = 'submit';
  const row = el('div', 'life-form__row');
  row.append(amount.wrap, field('life.settings.payday', payday), submit);
  form.append(row);
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
  return { form, amount, payday };
}

function categoryLine(c) {
  const li = el('li', 'life-row life-row--cat');
  const name = input({ maxlength: '60' });
  name.value = c.name;
  name.placeholder = catName({ id: c.id, name: '' });
  const limit = amountField('life.settings.limit', c.limit || '');
  const save = button('life.save', async () => {
    const lv = limit.input.value.trim() === '' ? 0 : limit.value();
    if (lv === null || lv < 0) {
      setStatus(t('life.err.bad-amount'), true);
      return;
    }
    const res = await act('saveCategory', { id: c.id, name: name.value, limit: lv });
    if (res.ok) setStatus(t('life.settings.saved'));
  });
  const acts = el('div', 'life-row__acts');
  acts.append(save);
  if (c.id !== 'other') acts.append(armedButton('life.delete', () => act('deleteCategory', { id: c.id })));
  li.append(field('life.f.name', name, 'life-field--grow'), limit.wrap, acts);
  return li;
}

function renderSettings(budget) {
  const f = els.incomeForm;
  // Never overwrite what is being typed.
  if (!f.form.contains(document.activeElement)) {
    f.amount.set(budget.income.amount || '');
    f.payday.value = String(budget.income.payday);
  }
  if (els.catList.contains(document.activeElement)) return;
  const list = el('ul', 'life-list');
  for (const c of budget.categories) list.append(categoryLine(c));
  els.catList.replaceChildren(list);
}

function buildNewCategory() {
  const form = el('form', 'life-form__row');
  const name = input({ maxlength: '60' });
  const submit = el('button', 'life-btn', t('life.settings.addCategory'));
  submit.type = 'submit';
  form.append(field('life.settings.newCategory', name, 'life-field--grow'), submit);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const res = await act('saveCategory', { name: name.value, limit: 0 });
    if (res.ok) name.value = '';
  });
  return form;
}

function render(state) {
  if (!els || !state) return;
  renderGoals(state.summary);
  renderWeek(state.summary, state.budget);
  renderSettings(state.budget);
}

function build(root) {
  const goals = bucket('life.goals.title');
  const goalForm = buildGoalForm();
  const goalList = el('div');
  goals.body.append(goalList, goalForm.form);
  const week = bucket('life.week.title');
  const settings = bucket('life.settings.title');
  const incomeForm = buildIncomeForm();
  const catList = el('div');
  settings.body.append(incomeForm.form, el('p', 'hint', t('life.settings.limitHint')), catList, buildNewCategory());
  root.replaceChildren(goals.sec, week.sec, settings.sec);
  els = { root, goals: goalList, goalForm, week: week.body, incomeForm, catList };
}

export function mountPlan(root) {
  build(root);
  onState(render);
  render(getState());
}

/** Language switch: everything here is cheap to rebuild. */
export function relabelPlan() {
  if (!els) return;
  editingGoalId = null;
  build(els.root);
  render(getState());
}
