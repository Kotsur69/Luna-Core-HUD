// ============================================================================
// LunaCore - Life dashboard: budget math (pure, no I/O)
// ----------------------------------------------------------------------------
// Turns the stored budget (src/lifebudget.js) into what the Money panel shows.
// The budget "month" runs payday to payday, not calendar month to calendar
// month: "left" and "per day" only make sense until the next salary lands.
//
//   left = income - bills - spent
//     bills: the actual amount once a bill is marked paid (gas expected 400,
//            paid 200 -> 200), the expected amount while it is still due;
//     spent: manual expenses dated inside the period.
//
// All money is rounded to grosze (2 decimals) at every sum, so 0.1 + 0.2 is
// 0.3 on screen. Dates are local 'YYYY-MM-DD' strings, compared as strings.
// ============================================================================

'use strict';

const SOON_DAYS = 3;
const RECENT_MAX = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

const round2 = (n) => Math.round(n * 100) / 100;
const floor2 = (n) => Math.floor(n * 100) / 100;
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const daysInMonth = (y, m0) => new Date(y, m0 + 1, 0).getDate();

/** Local 'YYYY-MM' of a timestamp. */
function monthKey(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}

/** 'YYYY-MM' + day -> 'YYYY-MM-DD', the day clamped to the month length. */
function dueDateIn(month, day) {
  const [y, m] = month.split('-').map(Number);
  return `${month}-${pad(Math.min(day, daysInMonth(y, m - 1)))}`;
}

function nextMonth(month) {
  const [y, m] = month.split('-').map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${pad(m + 1)}`;
}

function prevMonth(month) {
  const [y, m] = month.split('-').map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${pad(m - 1)}`;
}

/** Whole days from 'YYYY-MM-DD' a to b (b - a), DST-safe via local noon. */
function dayDiff(a, b) {
  const at = (s) => {
    const [y, m, d] = s.split('-').map(Number);
    return new Date(y, m - 1, d, 12).getTime();
  };
  return Math.round((at(b) - at(a)) / DAY_MS);
}

/** Payday to the day before the next payday, around `nowMs`. */
function periodOf(payday, nowMs) {
  const today = ymd(new Date(nowMs));
  const thisMonth = monthKey(nowMs);
  const startMonth = today >= dueDateIn(thisMonth, payday) ? thisMonth : prevMonth(thisMonth);
  const endMonth = nextMonth(startMonth);
  const [ey, em] = endMonth.split('-').map(Number);
  const nextPay = new Date(ey, em - 1, Math.min(payday, daysInMonth(ey, em - 1)), 12);
  const end = ymd(new Date(nextPay.getTime() - DAY_MS));
  return { start: dueDateIn(startMonth, payday), end, startMonth, endMonth, today, daysLeft: dayDiff(today, end) + 1 };
}

/** The calendar month in which a bill falls due inside the period, or null. */
function billMonth(bill, payday, period) {
  const month = bill.dueDay >= payday ? period.startMonth : period.endMonth;
  if (bill.every === 'year' && Number(month.split('-')[1]) !== bill.month) return null;
  return month;
}

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
      category: b.category,
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

const sumBy = (list, pick) => round2(list.reduce((s, x) => s + pick(x), 0));

/** Category id an expense counts under; unknown ids land in 'other'. */
function categoryOf(budget) {
  const known = new Set(budget.categories.map((c) => c.id));
  return (e) => (known.has(e.category) ? e.category : 'other');
}

function categoryRows(budget, inPeriod) {
  const catOf = categoryOf(budget);
  const spentOf = (id) => sumBy(inPeriod.filter((e) => catOf(e) === id), (e) => e.amount);
  const rows = budget.categories.map((c) => {
    const spent = spentOf(c.id);
    const hasLimit = c.limit > 0;
    return { id: c.id, name: c.name, spent, limit: c.limit, remaining: hasLimit ? round2(c.limit - spent) : null, over: hasLimit && spent > c.limit };
  });
  const other = spentOf('other');
  if (other > 0 && !rows.some((r) => r.id === 'other')) {
    rows.push({ id: 'other', name: null, spent: other, limit: 0, remaining: null, over: false });
  }
  return rows;
}

function weekRows(budget, nowMs) {
  const d = new Date(nowMs);
  const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7), 12);
  const thisStart = ymd(monday);
  const lastStart = ymd(new Date(monday.getTime() - 7 * DAY_MS));
  const nextStart = ymd(new Date(monday.getTime() + 7 * DAY_MS));
  const catOf = categoryOf(budget);
  const inRange = (from, to) => budget.expenses.filter((e) => e.date >= from && e.date < to);
  const thisWeek = inRange(thisStart, nextStart);
  const lastWeek = inRange(lastStart, thisStart);
  const ids = [...new Set([...budget.categories.map((c) => c.id), 'other'])];
  const rows = ids
    .map((id) => ({
      id,
      thisWeek: sumBy(thisWeek.filter((e) => catOf(e) === id), (e) => e.amount),
      lastWeek: sumBy(lastWeek.filter((e) => catOf(e) === id), (e) => e.amount),
    }))
    .filter((r) => r.id !== 'other' || r.thisWeek > 0 || r.lastWeek > 0);
  return { rows, total: { thisWeek: sumBy(thisWeek, (e) => e.amount), lastWeek: sumBy(lastWeek, (e) => e.amount) } };
}

function goalRows(budget, nowMs) {
  const [ny, nm] = monthKey(nowMs).split('-').map(Number);
  return budget.goals.map((g) => {
    const [by, bm] = g.by.split('-').map(Number);
    const monthsLeft = Math.max(1, (by - ny) * 12 + (bm - nm) + 1);
    const rest = Math.max(0, g.target - g.saved);
    return {
      ...g,
      monthsLeft,
      perMonth: round2(rest / monthsLeft),
      pct: g.target > 0 ? Math.min(100, Math.round((g.saved / g.target) * 100)) : 0,
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

/** Newest first; same-day entries keep "added last = shown first". */
function recentRows(inPeriod) {
  return inPeriod
    .map((e, i) => ({ e, i }))
    .sort((a, b) => b.e.date.localeCompare(a.e.date) || b.i - a.i)
    .slice(0, RECENT_MAX)
    .map(({ e }) => e);
}

/**
 * Everything the Money panel shows, for the budget period around `nowMs`.
 * @param {object} budget a normalized store from lifebudget.js
 * @param {number} nowMs
 */
function budgetSummary(budget, nowMs) {
  const period = periodOf(budget.income.payday, nowMs);
  const bills = billRows(budget, period);
  const billsTotal = sumBy(bills, (b) => (b.status === 'paid' ? b.paid : b.expected));
  const inPeriod = budget.expenses.filter((e) => e.date >= period.start && e.date <= period.end);
  const spent = sumBy(inPeriod, (e) => e.amount);
  const left = round2(budget.income.amount - billsTotal - spent);
  const subscriptions = subscriptionRows(budget);
  const week = weekRows(budget, nowMs);
  return {
    currency: budget.currency,
    income: budget.income,
    period: { start: period.start, end: period.end, today: period.today, daysLeft: period.daysLeft },
    bills,
    billsTotal,
    spent,
    left,
    perDay: floor2(left / Math.max(1, period.daysLeft)),
    categories: categoryRows(budget, inPeriod),
    subscriptions,
    subscriptionsMonthly: sumBy(subscriptions, (s) => s.monthly),
    goals: goalRows(budget, nowMs),
    week: week.rows,
    weekTotal: week.total,
    recent: recentRows(inPeriod),
  };
}

module.exports = { budgetSummary, monthKey, dueDateIn, SOON_DAYS };
