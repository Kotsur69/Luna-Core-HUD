// ============================================================================
// LunaCore - Life dashboard: budget history math (pure, no I/O)
// ----------------------------------------------------------------------------
// The numbers that need more than one period:
//   usualByCategory - average spend per category over the last 3 periods
//                     that have any expense at all (months before the app
//                     was used do not drag the average to zero)
//   trendRows       - up to 12 periods ending at the viewed one, split into
//                     the four outgoing buckets; leading empty periods dropped
//   breakdown       - where the money went, as % per category, for the week
//                     and for the period, each against the one before
// Past periods count only what was actually paid; the current and future
// ones count a still-due bill at its expected amount.
// ============================================================================

'use strict';

const { round2, ymd, prevMonth, addDays, periodFor, billMonth, sumBy, categoryOf } = require('./lifebudgetdates');

const USUAL_PERIODS = 3;
const TREND_PERIODS = 12;

const expensesIn = (budget, p) => budget.expenses.filter((e) => e.date >= p.start && e.date <= p.end);

/** The period starting `back` months before `startMonth`. */
function periodBack(budget, startMonth, back, nowMs) {
  let m = startMonth;
  for (let i = 0; i < back; i += 1) m = prevMonth(m);
  return periodFor(budget.income.payday, m, nowMs);
}

function usualByCategory(budget, period) {
  const catOf = categoryOf(budget);
  const totals = {};
  let counted = 0;
  for (let back = 1; back <= USUAL_PERIODS; back += 1) {
    const list = expensesIn(budget, periodBack(budget, period.startMonth, back, 0));
    if (!list.length) continue;
    counted += 1;
    for (const e of list) totals[catOf(e)] = (totals[catOf(e)] || 0) + e.amount;
  }
  if (!counted) return {};
  const out = {};
  for (const c of budget.categories) out[c.id] = round2((totals[c.id] || 0) / counted);
  return out;
}

/** Fixed and savings bills of one period: paid amounts, plus expected ones unless the period is over. */
function billTotals(budget, p) {
  let fixed = 0;
  let savings = 0;
  for (const b of budget.bills) {
    const month = billMonth(b, budget.income.payday, p);
    if (!month) continue;
    const pay = (budget.payments[month] || {})[b.id];
    const amount = pay ? pay.amount : p.isPast ? 0 : b.expected;
    if (b.kind === 'saving') savings += amount;
    else fixed += amount;
  }
  const deposited = sumBy(budget.deposits.filter((d) => d.date >= p.start && d.date <= p.end), (d) => d.amount);
  return { fixed: round2(fixed), savings: round2(savings + deposited) };
}

function trendRows(budget, period, nowMs) {
  const plannedIds = new Set(budget.categories.filter((c) => c.kind === 'planned').map((c) => c.id));
  const catOf = categoryOf(budget);
  const rows = [];
  for (let back = TREND_PERIODS - 1; back >= 0; back -= 1) {
    const p = periodBack(budget, period.startMonth, back, nowMs);
    const list = expensesIn(budget, p);
    const { fixed, savings } = billTotals(budget, p);
    rows.push({
      month: p.startMonth,
      fixed,
      savings,
      planned: sumBy(list.filter((e) => plannedIds.has(catOf(e))), (e) => e.amount),
      free: sumBy(list.filter((e) => !plannedIds.has(catOf(e))), (e) => e.amount),
    });
  }
  const first = rows.findIndex((r) => r.fixed || r.savings || r.planned || r.free);
  return first === -1 ? rows.slice(-1) : rows.slice(first);
}

/** Per-category totals of `list` vs `prevList`, with % of this total. */
function shareRows(budget, list, prevList, extra = []) {
  const catOf = categoryOf(budget);
  const ids = [...new Set([...budget.categories.map((c) => c.id), 'other'])];
  const by = (xs, id) => sumBy(xs.filter((e) => catOf(e) === id), (e) => e.amount);
  const rows = [...extra, ...ids.map((id) => ({ id, amount: by(list, id), prev: by(prevList, id) }))].filter((r) => r.amount > 0 || r.prev > 0);
  const total = sumBy(rows, (r) => r.amount);
  const prevTotal = sumBy(rows, (r) => r.prev || 0);
  return {
    total,
    prevTotal,
    rows: rows.map((r) => ({ ...r, pct: total > 0 ? Math.round((r.amount / total) * 1000) / 10 : 0 })).sort((a, b) => b.amount - a.amount),
  };
}

/** Monday 'YYYY-MM-DD' of the week holding `day`. */
function mondayOf(day) {
  const [y, m, d] = day.split('-').map(Number);
  const dt = new Date(y, m - 1, d, 12);
  return ymd(new Date(y, m - 1, d - ((dt.getDay() + 6) % 7), 12));
}

function breakdown(budget, period, inPeriod, fixed, savings) {
  // The week shown: this week while the period runs, else its last week
  // (a future period shows its first).
  let anchor = period.start;
  if (period.isCurrent) anchor = period.today;
  else if (period.isPast) anchor = period.end;
  const monday = mondayOf(anchor);
  const inRange = (from, to) => budget.expenses.filter((e) => e.date >= from && e.date < to);
  const week = { ...shareRows(budget, inRange(monday, addDays(monday, 7)), inRange(addDays(monday, -7), monday)), start: monday };

  const prev = periodBack(budget, period.startMonth, 1, 0);
  const prevBills = billTotals(budget, { ...prev, isPast: true });
  const month = shareRows(budget, inPeriod, expensesIn(budget, prev), [
    { id: '_fixed', amount: fixed.committed, prev: prevBills.fixed },
    { id: '_savings', amount: savings.committed, prev: prevBills.savings },
  ]);
  return { week, month };
}

module.exports = { usualByCategory, trendRows, breakdown };
