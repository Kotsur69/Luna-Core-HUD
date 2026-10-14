// ============================================================================
// LunaCore - Life dashboard: Bills column (renderer)
// ----------------------------------------------------------------------------
// Bills due this payday period with an expected amount; "Pay" opens an inline
// amount (prefilled with the expected one, takes arithmetic) because the real
// bill differs - gas expected 400, paid 200. A paid bill stays editable and
// can be un-paid. Below: the subscriptions (monthly + yearly cost) and the
// bill manager (add / edit / delete recurring bills).
// ============================================================================

'use strict';

import { t } from './util.js';
import {
  el, bucket, relabel, button, armedButton, field, input, select, amountField,
  money, signedMoney, shortDate, lang, getState, onState, act, setStatus,
} from './lifeui.js';

let els = null;
// The open pay editor: `${billId}:${month}` and the text typed so far, kept
// across re-renders (another column's change must not wipe it).
let paying = null;
let payDraft = '';
let editingBillId = null;

const round2 = (n) => Math.round(n * 100) / 100;
const monthNames = () =>
  Array.from({ length: 12 }, (_, i) => [String(i + 1), new Intl.DateTimeFormat(lang(), { month: 'long' }).format(new Date(2026, i, 1))]);

// --- bills this period --------------------------------------------------------

function payEditor(b) {
  const box = el('form', 'life-pay');
  const amount = amountField('life.bills.paidAmount');
  amount.set(payDraft);
  amount.input.addEventListener('input', () => {
    payDraft = amount.input.value;
  });
  const save = el('button', 'pad-send life-btn', t('life.save'));
  save.type = 'submit';
  box.append(amount.wrap, save, button('life.cancel', () => closePay()));
  box.addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = amount.value();
    if (v === null || v < 0) {
      setStatus(t('life.err.bad-amount'), true);
      return;
    }
    save.disabled = true;
    const res = await act('payBill', { id: b.id, month: b.month, amount: v });
    if (res.ok) {
      setStatus(t('life.bills.paidMsg', { name: b.name, amount: money(v) }));
      closePay();
    } else save.disabled = false;
  });
  queueMicrotask(() => amount.input.focus());
  return box;
}

function openPay(b) {
  paying = `${b.id}:${b.month}`;
  payDraft = String(b.status === 'paid' ? b.paid : b.expected);
  render(getState());
}

function closePay() {
  paying = null;
  payDraft = '';
  render(getState());
}

function billLine(b) {
  const li = el('li', `life-row life-bill is-${b.status}`);
  const text = el('div', 'life-row__text');
  text.append(el('span', 'life-row__title', b.name));
  const meta = el('span', 'life-row__meta');
  meta.append(el('span', `life-chip life-chip--${b.status}`, t(`life.bills.status.${b.status}`)), document.createTextNode(` ${shortDate(b.dueDate)}`));
  text.append(meta);
  const amt = el('div', 'life-bill__amt');
  if (b.status === 'paid') {
    amt.append(el('span', 'life-num', money(b.paid)));
    if (b.diff) amt.append(el('span', `life-bill__diff ${b.diff < 0 ? 'is-good' : 'is-warn'}`, t('life.bills.vsExpected', { diff: signedMoney(b.diff), expected: money(b.expected) })));
  } else {
    amt.append(el('span', 'life-num', money(b.expected)), el('span', 'life-bill__diff', t('life.bills.expected')));
  }
  const acts = el('div', 'life-row__acts');
  if (b.status === 'paid') {
    acts.append(button('life.edit', () => openPay(b)), button('life.bills.unpay', () => act('unpayBill', { id: b.id, month: b.month })));
  } else {
    acts.append(button('life.bills.pay', () => openPay(b), 'life-btn pad-send'));
  }
  li.append(text, amt, acts);
  if (paying === `${b.id}:${b.month}`) li.append(payEditor(b));
  return li;
}

function renderBills(s) {
  const body = els.bills;
  body.replaceChildren();
  if (!s.bills.length) {
    body.append(el('p', 'hint', t('life.bills.none')));
    return;
  }
  const list = el('ul', 'life-list');
  for (const b of s.bills) list.append(billLine(b));
  const due = round2(s.bills.filter((b) => b.status !== 'paid').reduce((sum, b) => sum + b.expected, 0));
  body.append(list, el('p', 'life-total', t('life.bills.total', { total: money(s.billsTotal), due: money(due) })));
}

function renderSubs(s) {
  const body = els.subs;
  body.replaceChildren();
  if (!s.subscriptions.length) {
    body.append(el('p', 'hint', t('life.subs.none')));
    return;
  }
  const list = el('ul', 'life-list');
  for (const x of s.subscriptions) {
    const li = el('li', 'life-row life-row--plain');
    const text = el('div', 'life-row__text');
    text.append(el('span', 'life-row__title', x.name), el('span', 'life-row__meta', t(x.every === 'year' ? 'life.subs.yearly' : 'life.subs.monthly')));
    const amt = el('div', 'life-bill__amt');
    amt.append(el('span', 'life-num', t('life.subs.perMonth', { amount: money(x.monthly) })), el('span', 'life-bill__diff', t('life.subs.perYear', { amount: money(x.yearly) })));
    li.append(text, amt);
    list.append(li);
  }
  const yearly = round2(s.subscriptions.reduce((sum, x) => sum + x.yearly, 0));
  body.append(list, el('p', 'life-total', t('life.subs.total', { month: money(s.subscriptionsMonthly), year: money(yearly) })));
}

// --- bill manager -------------------------------------------------------------

function buildBillForm() {
  const form = el('form', 'life-form');
  const name = input({ maxlength: '60' });
  const expected = amountField('life.bills.expectedAmount');
  const dueDay = input({ type: 'number', min: '1', max: '31', value: '10' });
  const kind = select([['bill', t('life.bills.kindBill')], ['subscription', t('life.bills.kindSub')]]);
  const every = select([['month', t('life.bills.everyMonth')], ['year', t('life.bills.everyYear')]]);
  const month = select(monthNames(), String(new Date().getMonth() + 1));
  const monthField = field('life.bills.inMonth', month);
  monthField.hidden = true;
  every.addEventListener('change', () => {
    monthField.hidden = every.value !== 'year';
  });
  const submit = el('button', 'pad-send life-form__go', t('life.bills.addBill'));
  submit.type = 'submit';
  const cancel = button('life.cancel', () => resetBillForm());
  cancel.hidden = true;
  const r1 = el('div', 'life-form__row');
  r1.append(field('life.f.name', name, 'life-field--grow'), expected.wrap);
  const r2 = el('div', 'life-form__row');
  r2.append(field('life.bills.dueDay', dueDay), field('life.bills.kind', kind), field('life.bills.every', every), monthField);
  const actions = el('div', 'life-form__actions');
  actions.append(submit, cancel);
  form.append(r1, r2, actions);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    saveBill();
  });
  return { form, name, expected, dueDay, kind, every, month, monthField, submit, cancel };
}

function resetBillForm() {
  const f = els.billForm;
  editingBillId = null;
  f.name.value = '';
  f.expected.set('');
  f.submit.textContent = t('life.bills.addBill');
  f.cancel.hidden = true;
}

async function saveBill() {
  const f = els.billForm;
  const expected = f.expected.value();
  if (expected === null || expected <= 0) {
    setStatus(t('life.err.bad-amount'), true);
    return;
  }
  const data = {
    name: f.name.value,
    expected,
    dueDay: Number(f.dueDay.value),
    kind: f.kind.value,
    every: f.every.value,
    month: f.every.value === 'year' ? Number(f.month.value) : 0,
    category: '',
  };
  if (editingBillId) data.id = editingBillId;
  const res = await act('saveBill', data);
  if (!res.ok) return;
  setStatus(t('life.bills.savedMsg', { name: data.name.trim() }));
  resetBillForm();
}

function editBill(b) {
  const f = els.billForm;
  editingBillId = b.id;
  f.name.value = b.name;
  f.expected.set(b.expected);
  f.dueDay.value = String(b.dueDay);
  f.kind.value = b.kind;
  f.every.value = b.every;
  f.month.value = String(b.month || new Date().getMonth() + 1);
  f.monthField.hidden = b.every !== 'year';
  f.submit.textContent = t('life.save');
  f.cancel.hidden = false;
  f.name.focus();
}

function renderManager(budget) {
  const body = els.managerList;
  body.replaceChildren();
  if (!budget.bills.length) return;
  const list = el('ul', 'life-list');
  const names = monthNames();
  for (const b of budget.bills) {
    const li = el('li', 'life-row');
    const text = el('div', 'life-row__text');
    const when = b.every === 'year' ? t('life.bills.whenYear', { day: b.dueDay, month: names[b.month - 1][1] }) : t('life.bills.whenMonth', { day: b.dueDay });
    text.append(el('span', 'life-row__title', b.name), el('span', 'life-row__meta', `${t(b.kind === 'bill' ? 'life.bills.kindBill' : 'life.bills.kindSub')} · ${when}`));
    const acts = el('div', 'life-row__acts');
    acts.append(button('life.edit', () => editBill(b)), armedButton('life.delete', () => act('deleteBill', { id: b.id })));
    li.append(text, el('span', 'life-num life-row__amount', money(b.expected)), acts);
    list.append(li);
  }
  body.append(list);
}

function render(state) {
  if (!els || !state) return;
  renderBills(state.summary);
  renderSubs(state.summary);
  renderManager(state.budget);
}

export function mountBills(root) {
  const bills = bucket('life.bills.title');
  const subs = bucket('life.subs.title');
  const manager = bucket('life.bills.manage');
  const billForm = buildBillForm();
  const managerList = el('div');
  manager.body.append(billForm.form, managerList);
  root.replaceChildren(bills.sec, subs.sec, manager.sec);
  els = { root, bills: bills.body, subs: subs.body, managerList, billForm };
  onState(render);
  render(getState());
}

export function relabelBills() {
  if (!els) return;
  relabel(els.root);
  const fresh = buildBillForm();
  els.billForm.form.replaceWith(fresh.form);
  els.billForm = fresh;
  editingBillId = null;
  render(getState());
}

/** Unpaid bills due within the "soon" window or already overdue. */
export function billsNeedingAttention(summary) {
  return summary.bills.filter((b) => b.status === 'soon' || b.status === 'overdue');
}
