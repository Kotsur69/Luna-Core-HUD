// ============================================================================
// LunaCore - Life dashboard: budget math (pure, no I/O)
// ----------------------------------------------------------------------------
// Turns the stored budget (src/lifebudget.js) into what the Life panel shows,
// for one budget period. A period runs payday to payday, not calendar month
// to calendar month, and is named by the month it starts in ('2026-10').
//
// Five buckets, every zloty in exactly one:
//   income   - the monthly salary
//   fixed    - bills + subscriptions: the actual amount once paid (gas
//              expected 400, paid 200 -> 200), the expected one while due
//   savings  - 'saving' bills (Revolut Investing) the same way, plus one-off
//              deposits into a pot. Leaves free money, but counts as saved
//   planned  - envelopes (food, fuel): max(plan, spent) is set aside, so a
//              plan not yet spent is already gone from free money
//   free     - everything else (snacks, cinema, Temu)
//
//   free left = income - fixed - savings - planned reserved - free spent
//
// All money is rounded to grosze (2 decimals) at every sum. Dates are local
// 'YYYY-MM-DD' strings, compared as strings. History-based numbers (usual
// spend, trend, week/month breakdown) live in lifebudgettrend.js; period and
// date helpers in lifebudgetdates.js.
// ============================================================================

'use strict';

const { usualByCategory, trendRows, breakdown } = require('./lifebudgettrend');
const { round2, floor2, ymd, monthKey, dueDateIn, nextMonth, dayDiff, periodFor, billMonth, sumBy, categoryOf } = require('./lifebudgetdates');

const SOON_DAYS = 3;
// A projection from the first few days is noise (one full tank = "3000 a month").
const PACE_MIN_DAYS = 7;
const PACE_SLACK = 1.05;
const FIXED_KINDS = new Set(['bill', 'subscription']);

function billStatus(payment, dueDate, today) {
  if (payment) return 'paid';
  if (dueDate < today) return 'overdue';
  return dayDiff(today, dueDate) <= SOON_DAYS ? 'soon' : 'due';
}

function billRows(budget, period) {
  const rows = [];
  for (const b of budget.bills) {
    const month = billMonth(b, budget.income.payday, period);
    if (!month) continue;
    const dueDate = dueDateIn(month, b.dueDay);
    const payment = (budget.payments[month] || {})[b.id] || null;
    rows.push({
      id: b.id,
      name: b.name,
      kind: b.kind,
      goal: b.goal || '',
      expected: b.expected,
      month,
      dueDate,
      status: billStatus(payment, dueDate, period.today),
      paid: payment ? payment.amount : null,
      paidOn: payment ? payment.paidOn : null,
      diff: payment ? round2(payment.amount - b.expected) : null,
    });
  }
  return rows.sort((a, b) => a.dueDate.localeCompare(b.dueDate));
}

/** {plan, actual, committed} of a set of bill rows. */
function billBucket(rows) {
  return {
    plan: sumBy(rows, (b) => b.expected),
    actual: sumBy(rows, (b) => b.paid || 0),
    committed: sumBy(rows, (b) => (b.status === 'paid' ? b.paid : b.expected)),
  };
}

function envelopeRows(budget, inPeriod, period, usual) {
  const catOf = categoryOf(budget);
  return budget.categories
    .filter((c) => c.kind === 'planned')
    .map((c) => {
      const spent = sumBy(inPeriod.filter((e) => catOf(e) === c.id), (e) => e.amount);
      const projected = period.isCurrent && period.daysElapsed >= PACE_MIN_DAYS ? round2((spent / period.daysElapsed) * period.daysTotal) : null;
      let status = 'ok';
      if (c.plan > 0 && spent > c.plan) status = 'over';
      else if (c.plan > 0 && projected !== null && projected > c.plan * PACE_SLACK) status = 'pace';
      const u = usual[c.id] ?? null;
      return {
        id: c.id,
        name: c.name,
        plan: c.plan,
        spent,
        reserved: Math.max(c.plan, spent),
        left: round2(c.plan - spent),
        usual: u,
        vsUsual: u ? Math.round(((spent - u) / u) * 100) : null,
        projected,
        status,
      };
    });
}

function freeRows(budget, inPeriod) {
  const catOf = categoryOf(budget);
  // A planned category's spending is its envelope's - never counted here too,
  // even 'other' (which also catches deleted categories) when it is planned.
  const planned = new Set(budget.categories.filter((c) => c.kind === 'planned').map((c) => c.id));
  const ids = [...new Set([...budget.categories.map((c) => c.id), 'other'])].filter((id) => !planned.has(id));
  return ids
    .map((id) => {
      const c = budget.categories.find((x) => x.id === id);
      return { id, name: c ? c.name : '', spent: sumBy(inPeriod.filter((e) => catOf(e) === id), (e) => e.amount) };
    })
    .filter((r) => r.id !== 'other' || r.spent > 0 || budget.categories.some((c) => c.id === 'other'));
}

function goalRows(budget, nowMs) {
  const [ny, nm] = monthKey(nowMs).split('-').map(Number);
  const paidInto = (goalId) => {
    const billIds = new Set(budget.bills.filter((b) => b.goal === goalId).map((b) => b.id));
    let total = 0;
    for (const row of Object.values(budget.payments)) for (const [id, p] of Object.entries(row)) if (billIds.has(id)) total += p.amount;
    return total;
  };
  return budget.goals.map((g) => {
    const deposited = sumBy(budget.deposits.filter((d) => d.goal === g.id), (d) => d.amount);
    const total = round2(g.saved + deposited + paidInto(g.id));
    const monthly = sumBy(budget.bills.filter((b) => b.goal === g.id && b.every === 'month'), (b) => b.expected);
    let monthsLeft = null;
    let perMonth = null;
    if (g.target > 0 && g.by) {
      const [by, bm] = g.by.split('-').map(Number);
      monthsLeft = Math.max(1, (by - ny) * 12 + (bm - nm) + 1);
      perMonth = round2(Math.max(0, g.target - total) / monthsLeft);
    }
    return {
      ...g,
      total,
      monthly,
      monthsLeft,
      perMonth,
      pct: g.target > 0 ? Math.min(100, Math.round((total / g.target) * 100)) : null,
    };
  });
}

function subscriptionRows(budget) {
  return budget.bills
    .filter((b) => b.kind === 'subscription')
    .map((b) => ({
      id: b.id,
      name: b.name,
      every: b.every,
      monthly: b.every === 'year' ? round2(b.expected / 12) : b.expected,
      yearly: b.every === 'year' ? b.expected : round2(b.expected * 12),
    }));
}

/** Every money movement of the period, newest first: expenses, deposits, paid bills. */
function transactionRows(budget, inPeriod, bills, period) {
  const goalName = (id) => (budget.goals.find((g) => g.id === id) || {}).name || '';
  const rows = [
    ...inPeriod.map((e, i) => ({ type: 'expense', id: e.id, date: e.date, amount: e.amount, category: e.category, note: e.note, order: i })),
    ...budget.deposits
      .filter((d) => d.date >= period.start && d.date <= period.end)
      .map((d, i) => ({ type: 'deposit', id: d.id, date: d.date, amount: d.amount, goal: d.goal, note: d.note || goalName(d.goal), order: i })),
    ...bills
      .filter((b) => b.status === 'paid')
      .map((b, i) => ({ type: 'bill', id: b.id, month: b.month, date: b.paidOn, amount: b.paid, kind: b.kind, note: b.name, order: i })),
  ];
  return rows.sort((a, b) => b.date.localeCompare(a.date) || b.order - a.order).map(({ order, ...r }) => r);
}

/**
 * Everything the Life panel shows for one budget period.
 * @param {object} budget a normalized store from lifebudget.js
 * @param {number} nowMs
 * @param {string} [month] 'YYYY-MM' the period starts in; default = current
 */
function budgetSummary(budget, nowMs, month) {
  const payday = budget.income.payday;
  const current = periodFor(payday, null, nowMs);
  const period = periodFor(payday, month || current.startMonth, nowMs);
  const bills = billRows(budget, period);
  const inPeriod = budget.expenses.filter((e) => e.date >= period.start && e.date <= period.end);
  const deposits = budget.deposits.filter((d) => d.date >= period.start && d.date <= period.end);

  const fixed = billBucket(bills.filter((b) => FIXED_KINDS.has(b.kind)));
  const savingBills = billBucket(bills.filter((b) => b.kind === 'saving'));
  const deposited = sumBy(deposits, (d) => d.amount);
  const savings = {
    plan: savingBills.plan,
    actual: round2(savingBills.actual + deposited),
    committed: round2(savingBills.committed + deposited),
    deposited,
  };

  const usual = usualByCategory(budget, period);
  const envelopes = envelopeRows(budget, inPeriod, period, usual);
  const planned = {
    plan: sumBy(envelopes, (e) => e.plan),
    spent: sumBy(envelopes, (e) => e.spent),
    reserved: sumBy(envelopes, (e) => e.reserved),
  };
  const free = freeRows(budget, inPeriod);
  const freeSpent = sumBy(free, (r) => r.spent);
  const income = budget.income.amount;
  const freePlan = round2(income - fixed.plan - savings.plan - planned.plan);
  const left = round2(income - fixed.committed - savings.committed - planned.reserved - freeSpent);
  const days = period.isCurrent ? period.daysLeft : period.daysTotal;
  const subscriptions = subscriptionRows(budget);
  const goals = goalRows(budget, nowMs);

  return {
    currency: budget.currency,
    month: period.startMonth,
    currentMonth: current.startMonth,
    income: budget.income,
    period: {
      start: period.start,
      end: period.end,
      today: period.today,
      isCurrent: period.isCurrent,
      isPast: period.isPast,
      daysLeft: period.daysLeft,
      daysTotal: period.daysTotal,
      daysElapsed: period.daysElapsed,
    },
    fixed,
    savings,
    planned,
    envelopes,
    free: { plan: freePlan, spent: freeSpent, left, perDay: floor2(Math.max(0, left) / Math.max(1, days)), rows: free },
    left,
    // Where the income goes; 'left' is only a slice while it is positive.
    donut: [
      { key: 'fixed', amount: fixed.committed },
      { key: 'savings', amount: savings.committed },
      { key: 'planned', amount: planned.reserved },
      { key: 'free', amount: freeSpent },
      { key: 'left', amount: Math.max(0, left) },
    ],
    bills,
    subscriptions,
    subscriptionsMonthly: sumBy(subscriptions, (s) => s.monthly),
    goals,
    totalSaved: sumBy(goals, (g) => g.total),
    transactions: transactionRows(budget, inPeriod, bills, period),
    trend: trendRows(budget, period, nowMs),
    breakdown: breakdown(budget, period, inPeriod, fixed, savings),
  };
}

module.exports = { budgetSummary, monthKey, dueDateIn, nextMonth, ymd, SOON_DAYS };
