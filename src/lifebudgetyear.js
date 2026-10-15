// ============================================================================
// LunaCore - Life dashboard: whole-year math (pure, no I/O)
// ----------------------------------------------------------------------------
// The Year tab's numbers: the twelve payday periods that start in one
// calendar year, each split into the outgoing buckets (fixed, savings,
// planned, free) against the income, then the year's totals, monthly
// averages, savings rate, best and worst period, spend per category and per
// weekday, the biggest single expenses, how bills were paid and the same
// months of the year before for comparison.
//
// A period counts once it has any money movement or is the current one -
// months before the app was used do not drag averages down, and future
// periods are listed but never counted. Like the trend, past periods count
// only what was paid; the current one counts a still-due bill as expected.
// ============================================================================

'use strict';

const { round2, sumBy, periodFor, billMonth, dueDateIn, categoryOf } = require('./lifebudgetdates');
const { billTotals, expensesIn } = require('./lifebudgettrend');

const TOP_EXPENSES = 5;
const pad = (n) => String(n).padStart(2, '0');
const round1 = (n) => Math.round(n * 10) / 10;

function periodRow(budget, month, nowMs) {
  const p = periodFor(budget.income.payday, month, nowMs);
  const state = p.isCurrent ? 'current' : p.isPast ? 'past' : 'future';
  if (state === 'future') return { month, state, active: false, period: p, list: [], income: 0, fixed: 0, savings: 0, planned: 0, free: 0, spent: 0, net: 0 };
  const plannedIds = new Set(budget.categories.filter((c) => c.kind === 'planned').map((c) => c.id));
  const catOf = categoryOf(budget);
  const list = expensesIn(budget, p);
  const { fixed, savings } = billTotals(budget, p);
  const planned = sumBy(list.filter((e) => plannedIds.has(catOf(e))), (e) => e.amount);
  const free = sumBy(list.filter((e) => !plannedIds.has(catOf(e))), (e) => e.amount);
  const spent = round2(fixed + planned + free);
  const active = p.isCurrent || spent > 0 || savings > 0;
  const income = active ? budget.income.amount : 0;
  return { month, state, active, period: p, list, income, fixed, savings, planned, free, spent, net: round2(income - spent - savings) };
}

function yearRows(budget, year, nowMs) {
  return Array.from({ length: 12 }, (_, i) => periodRow(budget, `${year}-${pad(i + 1)}`, nowMs));
}

function totalsOf(rows) {
  const active = rows.filter((r) => r.active);
  const sum = (k) => sumBy(active, (r) => r[k]);
  const n = active.length;
  const income = sum('income');
  const savings = sum('savings');
  return {
    months: n,
    income,
    fixed: sum('fixed'),
    savings,
    planned: sum('planned'),
    free: sum('free'),
    spent: sum('spent'),
    net: sum('net'),
    avgSpent: n ? round2(sum('spent') / n) : 0,
    avgFree: n ? round2(sum('free') / n) : 0,
    savingsRate: income > 0 ? round1((savings / income) * 100) : null,
  };
}

/** Per category: the year's total, % of all expenses, monthly average and the year before. */
function categoryRows(budget, list, prevList, months) {
  const catOf = categoryOf(budget);
  const ids = [...new Set([...budget.categories.map((c) => c.id), 'other'])];
  const by = (xs, id) => sumBy(xs.filter((e) => catOf(e) === id), (e) => e.amount);
  const rows = ids.map((id) => ({ id, amount: by(list, id), prev: by(prevList, id) })).filter((r) => r.amount > 0 || r.prev > 0);
  const total = sumBy(rows, (r) => r.amount);
  return rows
    .map((r) => ({ ...r, pct: total > 0 ? round1((r.amount / total) * 100) : 0, perMonth: months ? round2(r.amount / months) : 0 }))
    .sort((a, b) => b.amount - a.amount);
}

/** Expense total per weekday, Monday first. */
function weekdayTotals(list) {
  const out = [0, 0, 0, 0, 0, 0, 0];
  for (const e of list) {
    const [y, m, d] = e.date.split('-').map(Number);
    out[(new Date(y, m - 1, d, 12).getDay() + 6) % 7] += e.amount;
  }
  return out.map(round2);
}

/** How the year's bills were paid: count, on time, paid vs expected, still unpaid past due. */
function billStats(budget, rows) {
  const today = rows[0].period.today;
  let paid = 0;
  let onTime = 0;
  let unpaidPastDue = 0;
  let paidSum = 0;
  let expectedSum = 0;
  for (const r of rows) {
    if (!r.active) continue; // future, or before the app was used
    for (const b of budget.bills) {
      const month = billMonth(b, budget.income.payday, r.period);
      if (!month) continue;
      const dueDate = dueDateIn(month, b.dueDay);
      const pay = (budget.payments[month] || {})[b.id];
      if (pay) {
        paid += 1;
        if (pay.paidOn <= dueDate) onTime += 1;
        paidSum += pay.amount;
        expectedSum += b.expected;
      } else if (dueDate < today) unpaidPastDue += 1;
    }
  }
  return { paid, onTime, unpaidPastDue, paidSum: round2(paidSum), diff: round2(paidSum - expectedSum) };
}

function topExpenses(budget, list) {
  const catOf = categoryOf(budget);
  return [...list]
    .sort((a, b) => b.amount - a.amount || b.date.localeCompare(a.date))
    .slice(0, TOP_EXPENSES)
    .map((e) => ({ id: e.id, date: e.date, amount: e.amount, category: catOf(e), note: e.note || '' }));
}

const plainRow = ({ period, list, ...r }) => r;

/**
 * Everything the Year tab shows for the periods starting in `year`.
 * @param {object} budget a normalized store from lifebudget.js
 * @param {number} year e.g. 2026
 * @param {number} nowMs
 */
function yearSummary(budget, year, nowMs) {
  const rows = yearRows(budget, year, nowMs);
  const prevRows = yearRows(budget, year - 1, nowMs);
  // The year before over the same months only, so a half-done year is
  // never compared with a whole one.
  const counted = new Set(rows.filter((r) => r.active).map((r) => r.month.slice(5)));
  const prevSame = prevRows.filter((r) => counted.has(r.month.slice(5)));
  const prevTotals = totalsOf(prevSame);
  const totals = totalsOf(rows);
  const list = rows.flatMap((r) => r.list);
  // Best / worst only among finished periods: a half-spent current one
  // would always look like the best.
  const done = rows.filter((r) => r.active && r.state === 'past');
  const pick = (better) => (done.length > 1 ? done.reduce((a, b) => (better(b, a) ? b : a)).month : null);

  return {
    year,
    isCurrent: rows.some((r) => r.state === 'current'),
    rows: rows.map(plainRow),
    totals,
    prev: prevTotals.months ? prevTotals : null,
    bestMonth: pick((b, a) => b.net > a.net),
    worstMonth: pick((b, a) => b.spent > a.spent),
    categories: categoryRows(budget, list, prevSame.flatMap((r) => r.list), totals.months),
    weekdays: weekdayTotals(list),
    top: topExpenses(budget, list),
    bills: billStats(budget, rows),
  };
}

module.exports = { yearSummary };
