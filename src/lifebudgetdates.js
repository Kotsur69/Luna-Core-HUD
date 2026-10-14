// ============================================================================
// LunaCore - Life dashboard: period + date helpers for the budget math
// ----------------------------------------------------------------------------
// Pure, no I/O. Shared by lifebudgetcalc.js (one period) and
// lifebudgettrend.js (history). Dates are local 'YYYY-MM-DD' strings and
// months 'YYYY-MM'; day arithmetic goes through local noon, so DST never
// shifts a day.
// ============================================================================

'use strict';

const DAY_MS = 24 * 60 * 60 * 1000;

// `|| 0` turns -0 into 0 (Intl would print "-0.00"); the epsilon keeps
// 0.29 * 100 = 28.999... from flooring a grosz away.
const round2 = (n) => Math.round(n * 100) / 100 || 0;
const floor2 = (n) => Math.floor(n * 100 + 1e-9) / 100 || 0;
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const daysInMonth = (y, m0) => new Date(y, m0 + 1, 0).getDate();
const sumBy = (list, pick) => round2(list.reduce((s, x) => s + pick(x), 0));

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

function noonOf(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d, 12);
}

/** Whole days from 'YYYY-MM-DD' a to b (b - a). */
function dayDiff(a, b) {
  return Math.round((noonOf(b).getTime() - noonOf(a).getTime()) / DAY_MS);
}

function addDays(s, n) {
  const d = noonOf(s);
  d.setDate(d.getDate() + n);
  return ymd(d);
}

/**
 * The payday-to-payday period starting in `startMonth`, or the one around
 * `nowMs` when startMonth is null. daysElapsed/daysLeft count today in.
 */
function periodFor(payday, startMonth, nowMs) {
  const today = ymd(new Date(nowMs));
  const thisMonth = monthKey(nowMs);
  const sm = startMonth || (today >= dueDateIn(thisMonth, payday) ? thisMonth : prevMonth(thisMonth));
  const endMonth = nextMonth(sm);
  const start = dueDateIn(sm, payday);
  const end = addDays(dueDateIn(endMonth, payday), -1);
  const daysTotal = dayDiff(start, end) + 1;
  const isCurrent = today >= start && today <= end;
  const isPast = today > end;
  let daysElapsed = 0;
  let daysLeft = daysTotal;
  if (isCurrent) {
    daysElapsed = dayDiff(start, today) + 1;
    daysLeft = dayDiff(today, end) + 1;
  } else if (isPast) {
    daysElapsed = daysTotal;
    daysLeft = 0;
  }
  return { start, end, today, startMonth: sm, endMonth, daysTotal, daysElapsed, daysLeft, isCurrent, isPast };
}

/** The calendar month in which a bill falls due inside the period, or null. */
function billMonth(bill, _payday, period) {
  // Judge by the real (clamped) due date, not the raw day numbers: with payday
  // 31 a due day 30 still falls inside a period that starts Apr 30.
  const first = dueDateIn(period.startMonth, bill.dueDay);
  const month = first >= period.start && first <= period.end ? period.startMonth : period.endMonth;
  if (bill.every === 'year' && Number(month.split('-')[1]) !== bill.month) return null;
  return month;
}

/** Category id an expense counts under; unknown ids land in 'other'. */
function categoryOf(budget) {
  const known = new Set(budget.categories.map((c) => c.id));
  return (e) => (known.has(e.category) ? e.category : 'other');
}

module.exports = {
  DAY_MS,
  round2,
  floor2,
  ymd,
  monthKey,
  dueDateIn,
  nextMonth,
  prevMonth,
  dayDiff,
  addDays,
  periodFor,
  billMonth,
  sumBy,
  categoryOf,
};
