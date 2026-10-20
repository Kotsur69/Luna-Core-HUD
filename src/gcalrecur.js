// ============================================================================
// LunaCore - RRULE builder for recurring Google Calendar events (bills)
// ----------------------------------------------------------------------------
// The only place a recurrence string is made. It is built from validated
// integers alone - never from text - so nothing a bill name or a synced row
// carries can end up inside an RRULE.
//
// A due day past the 28th is clamped to the month's end the way the budget
// does it: BYMONTHDAY lists 28..day and BYSETPOS=-1 picks the last one that
// exists, so day 31 lands on Feb 28/29, Apr 30 and Jan 31.
// ============================================================================

'use strict';

const isInt = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;

function monthDays(day) {
  if (!isInt(day, 1, 31)) throw new Error('bad day');
  if (day <= 28) return `BYMONTHDAY=${day}`;
  const days = [];
  for (let d = 28; d <= day; d++) days.push(d);
  return `BYMONTHDAY=${days.join(',')};BYSETPOS=-1`;
}

/** "RRULE:FREQ=MONTHLY;BYMONTHDAY=15". Throws on anything but 1-31. */
function monthlyRule(day) {
  return `RRULE:FREQ=MONTHLY;${monthDays(day)}`;
}

/** "RRULE:FREQ=YEARLY;BYMONTH=3;BYMONTHDAY=15". Throws on a bad month or day. */
function yearlyRule(month, day) {
  if (!isInt(month, 1, 12)) throw new Error('bad month');
  return `RRULE:FREQ=YEARLY;BYMONTH=${month};${monthDays(day)}`;
}

/** The day `day` clamped to the length of month `m` (0-11) of `year`. */
const clampDay = (year, m, day) => Math.min(day, new Date(year, m + 1, 0).getDate());

const ymd = (y, m, d) => `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

/**
 * The first all-day occurrence on or after `today` ('YYYY-MM-DD'), for a bill
 * {dueDay, every 'month'|'year', month}. Returns {start, end} (end exclusive).
 */
function firstOccurrence({ dueDay, every, month }, today) {
  const [y, mo, d] = today.split('-').map(Number);
  let year = y;
  let m = every === 'year' ? month - 1 : mo - 1;
  const before = (yy, mm) => yy < y || (yy === y && (mm < mo - 1 || (mm === mo - 1 && clampDay(yy, mm, dueDay) < d)));
  while (before(year, m)) {
    if (every === 'year') year += 1;
    else if (++m > 11) {
      m = 0;
      year += 1;
    }
  }
  const day = clampDay(year, m, dueDay);
  const next = new Date(year, m, day + 1);
  return { start: ymd(year, m, day), end: ymd(next.getFullYear(), next.getMonth(), next.getDate()) };
}

/** The RRULE for a validated bill row. Throws on a bad row. */
function billRule(bill) {
  return bill.every === 'year' ? yearlyRule(bill.month, bill.dueDay) : monthlyRule(bill.dueDay);
}

module.exports = { monthlyRule, yearlyRule, billRule, firstOccurrence };
