// ============================================================================
// LunaCore - Life dashboard: Bills & Savings tab (renderer)
// ----------------------------------------------------------------------------
// Bills due this payday period (fixed bills, subscriptions and 'saving' bills
// such as a monthly investment) with an inline "Pay" - the real amount often
// differs from the expected one - and a calendar of the period's due dates.
// Then the subscriptions (monthly + yearly cost) and the savings pots: how
// much is in each, how much a month it needs, and "+ Save" for a one-off
// deposit (answered with an Undo toast). Bills themselves are set up in the
// Settings tab.
// ============================================================================

'use strict';

import { t } from './util.js';
import {
  el, bucket, button, amountField, bar, money, money0, signedMoney, shortDate, monthLabel, lang, today,
  getState, act, setStatus, toast,
} from './lifeui.js';
import { billCalendarControl } from './lifebillcal.js';

// Kept across re-renders: the open pay editor ('billId:month') or deposit
// editor (goal id), with what was typed so far.
let paying = null;
let depositFor = null;
let draft = '';
let shownMonth = null; // an editor never follows you into another period
let rerender = () => {};

const round2 = (n) => Math.round(n * 100) / 100;

// --- bills this period --------------------------------------------------------

function inlineAmount({ labelKey, goKey, initial, min, onSave, onCancel }) {
  const box = el('form', 'life-pay');
  const amount = amountField(labelKey);
  amount.set(initial);
  amount.input.addEventListener('input', () => {
    draft = amount.input.value;
  });
  const save = el('button', 'pad-send life-btn', t(goKey));
  save.type = 'submit';
  box.append(amount.wrap, save, button('life.cancel', onCancel));
  box.addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = amount.value();
    if (v === null || v < min) {
      setStatus(t('life.err.bad-amount'), true);
      amount.input.focus();
      return;
    }
    save.disabled = true;
    if (!(await onSave(v))) save.disabled = false;
  });
  queueMicrotask(() => amount.input.focus());
  return box;
}

function closeEditors() {
  paying = null;
  depositFor = null;
  draft = '';
  rerender();
}

function payEditor(b) {
  return inlineAmount({
    labelKey: 'life.bills.paidAmount',
    goKey: 'life.save',
    initial: draft,
    min: 0,
    onCancel: closeEditors,
    onSave: async (v) => {
      // Fixing the amount of a paid bill keeps the day it was paid.
      const res = await act('payBill', { id: b.id, month: b.month, amount: v, paidOn: b.status === 'paid' ? b.paidOn : undefined });
      if (!res.ok) return false;
      setStatus(t('life.bills.paidMsg', { name: b.name, amount: money(v) }));
      closeEditors();
      return true;
    },
  });
}

function openPay(b) {
  paying = `${b.id}:${b.month}`;
  depositFor = null;
  draft = String(b.status === 'paid' ? b.paid : b.expected);
  rerender();
}

async function unpay(b) {
  const res = await act('unpayBill', { id: b.id, month: b.month });
  if (!res.ok) return;
  toast(t('life.bills.unpaidMsg', { name: b.name }), () => act('payBill', { id: b.id, month: b.month, amount: b.paid, paidOn: b.paidOn }));
}

function billLine(b) {
  const li = el('li', `life-row life-bill is-${b.status}`);
  const text = el('div', 'life-row__text');
  const meta = el('span', 'life-row__meta');
  meta.append(el('span', `life-chip life-chip--${b.status}`, t(`life.bills.status.${b.status}`)), document.createTextNode(` ${shortDate(b.dueDate)}`));
  if (b.kind !== 'bill') meta.append(document.createTextNode(` · ${t(`life.tx.kind.${b.kind}`)}`));
  text.append(el('span', 'life-row__title', b.name), meta);
  const amt = el('div', 'life-bill__amt');
  if (b.status === 'paid') {
    amt.append(el('span', 'life-num', money(b.paid)));
    if (b.diff) amt.append(el('span', `life-bill__diff ${b.diff < 0 ? 'is-good' : 'is-warn'}`, t('life.bills.vsExpected', { diff: signedMoney(b.diff), expected: money(b.expected) })));
  } else {
    amt.append(el('span', 'life-num', money(b.expected)), el('span', 'life-bill__diff', t('life.bills.expected')));
  }
  const acts = el('div', 'life-row__acts');
  if (b.status === 'paid') acts.append(button('life.edit', () => openPay(b)), button('life.bills.unpay', () => unpay(b)));
  else acts.append(button('life.bills.pay', () => openPay(b), 'life-btn pad-send'));
  const cal = billCalendarControl(b.id, () => rerender());
  if (cal.action) acts.append(cal.action);
  li.append(text, amt, acts);
  if (paying === `${b.id}:${b.month}`) li.append(payEditor(b));
  if (cal.editor) li.append(cal.editor);
  return li;
}

function billsCard(s, goTab) {
  const card = bucket('life.bills.title');
  if (!s.bills.length) {
    card.body.append(el('p', 'hint', t('life.bills.none')), button('life.bills.setUp', () => goTab('settings')));
    return card.sec;
  }
  const list = el('ul', 'life-list');
  for (const b of s.bills) list.append(billLine(b));
  const total = round2(s.bills.reduce((sum, b) => sum + (b.status === 'paid' ? b.paid : b.expected), 0));
  const due = round2(s.bills.filter((b) => b.status !== 'paid').reduce((sum, b) => sum + b.expected, 0));
  card.body.append(list, el('p', 'life-total', t('life.bills.total', { total: money(total), due: money(due) })));
  return card.sec;
}

// --- calendar of due dates ------------------------------------------------------

const parse = (ymd) => {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(y, m - 1, d);
};
const ymdOf = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

function weekdayHeads() {
  const fmt = new Intl.DateTimeFormat(lang(), { weekday: 'narrow' });
  // 2026-10-12 is a Monday: the week starts there.
  return Array.from({ length: 7 }, (_, i) => fmt.format(new Date(2026, 9, 12 + i)));
}

function calendarCard(s) {
  const card = bucket('life.bills.calendar');
  const grid = el('div', 'life-cal');
  for (const h of weekdayHeads()) grid.append(el('span', 'life-cal__head', h));
  const byDate = new Map();
  for (const b of s.bills) byDate.set(b.dueDate, [...(byDate.get(b.dueDate) || []), b]);
  const start = parse(s.period.start);
  const end = parse(s.period.end);
  const lead = (start.getDay() + 6) % 7;
  for (let i = 0; i < lead; i++) grid.append(el('span', 'life-cal__pad'));
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const key = ymdOf(d);
    const due = byDate.get(key) || [];
    const cell = el('span', `life-cal__day${key === s.period.today ? ' is-today' : ''}`);
    cell.append(el('span', 'life-cal__num', String(d.getDate())));
    if (due.length) {
      const worst = ['overdue', 'soon', 'due', 'paid'].find((st) => due.some((b) => b.status === st));
      cell.classList.add('has-due', `is-${worst}`);
      const names = due.map((b) => `${b.name} ${money0(b.status === 'paid' ? b.paid : b.expected)} (${t(`life.bills.status.${b.status}`)})`).join(', ');
      cell.title = `${shortDate(key)}: ${names}`;
      cell.append(el('span', 'life-cal__dot', String(due.length)));
    }
    grid.append(cell);
  }
  // The grid is a picture of the bill list above it; screen readers get the list.
  grid.setAttribute('aria-hidden', 'true');
  card.body.append(grid, el('p', 'hint', t('life.bills.calHint')));
  return card.sec;
}

// --- subscriptions --------------------------------------------------------------

function subsCard(s) {
  const card = bucket('life.subs.title');
  if (!s.subscriptions.length) {
    card.body.append(el('p', 'hint', t('life.subs.none')));
    return card.sec;
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
  card.body.append(list, el('p', 'life-total', t('life.subs.total', { month: money(s.subscriptionsMonthly), year: money(yearly) })));
  return card.sec;
}

// --- savings pots ---------------------------------------------------------------

function depositEditor(g) {
  return inlineAmount({
    labelKey: 'life.goals.deposit',
    goKey: 'life.goals.addIt',
    initial: draft,
    min: 0.01,
    onCancel: closeEditors,
    onSave: async (v) => {
      const res = await act('addDeposit', { date: today(), goal: g.id, amount: v, note: '' });
      if (!res.ok) return false;
      setStatus('');
      closeEditors();
      toast(t('life.goals.deposited', { amount: money(v), name: g.name }), res.created ? () => act('deleteDeposit', { id: res.created }) : null);
      return true;
    },
  });
}

function goalNote(g) {
  const parts = [];
  if (g.monthly) parts.push(t('life.goals.monthly', { amount: money0(g.monthly) }));
  if (g.pct === null) parts.push(t('life.goals.open'));
  else if (g.pct >= 100) parts.push(t('life.goals.done'));
  else if (g.perMonth !== null) parts.push(t('life.goals.perMonth', { amount: money(g.perMonth), by: monthLabel(g.by), months: g.monthsLeft }));
  else parts.push(t('life.goals.toGo', { amount: money(Math.max(0, g.target - g.total)) }));
  return parts.join(' · ');
}

function goalLine(g) {
  const li = el('li', 'life-goal');
  const head = el('div', 'life-cat__head');
  head.append(el('span', 'life-cat__name', g.name), el('span', 'life-num', g.target > 0 ? `${money0(g.total)} / ${money0(g.target)}` : money0(g.total)));
  li.append(head);
  if (g.target > 0) li.append(bar(g.total / g.target, g.pct >= 100 ? 'is-good' : '', 'var(--life-savings)'));
  li.append(el('span', 'life-cat__note', `${g.pct === null ? '' : `${g.pct}% · `}${goalNote(g)}`));
  const acts = el('div', 'life-row__acts');
  acts.append(
    button(
      'life.goals.add',
      () => {
        depositFor = g.id;
        paying = null;
        draft = '';
        rerender();
      },
      'life-btn pad-send'
    )
  );
  li.append(acts);
  if (depositFor === g.id) li.append(depositEditor(g));
  return li;
}

function savingsCard(s, goTab) {
  const card = bucket('life.goals.title');
  card.body.append(el('p', 'life-total', t('life.goals.totalSaved', { amount: money(s.totalSaved), month: money(s.savings.committed) })));
  if (!s.goals.length) {
    card.body.append(el('p', 'hint', t('life.goals.none')), button('life.goals.setUp', () => goTab('settings')));
    return card.sec;
  }
  const list = el('ul', 'life-list');
  for (const g of s.goals) list.append(goalLine(g));
  card.body.append(list);
  return card.sec;
}

function forgetEditorsOnNewMonth(month) {
  if (month === shownMonth) return;
  shownMonth = month;
  paying = null;
  depositFor = null;
  draft = '';
}

/**
 * One bill row with its Pay button and inline pay editor, for another tab
 * (the Overview's upcoming bills). `redraw` rebuilds that tab.
 */
export function billRow(summary, b, redraw) {
  rerender = redraw;
  forgetEditorsOnNewMonth(summary.month);
  return billLine(b);
}

/** Rebuilds the Bills & Savings tab into `root`; `goTab(id)` switches tabs. */
export function renderBills(root, state, goTab) {
  rerender = () => renderBills(root, getState(), goTab);
  const s = state.summary;
  forgetEditorsOnNewMonth(s.month);
  const grid = el('div', 'life-grid life-grid--2');
  const left = el('div', 'life-stack');
  left.append(billsCard(s, goTab), subsCard(s));
  const right = el('div', 'life-stack');
  right.append(calendarCard(s), savingsCard(s, goTab));
  grid.append(left, right);
  root.replaceChildren(grid);
}

/** Unpaid bills due within the "soon" window or already overdue. */
export function billsNeedingAttention(summary) {
  return summary.bills.filter((b) => b.status === 'soon' || b.status === 'overdue');
}
