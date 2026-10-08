// ============================================================================
// LunaCore - Mission Control: pace math for the telemetry widget (pure)
// ----------------------------------------------------------------------------
// No DOM, no IPC: GitHub daily counts and a usage limit in, numbers and flags
// out, so node --test can pin every threshold with a fixed clock.
//
// "Pace" is always actual / expected-by-now, never actual / full target: on a
// Tuesday, 30% of a normal week is on track, not behind. Two clocks:
//   - GitHub velocity runs on the calendar week, Monday 00:00 local, compared
//     with the average of the previous AVG_WEEKS full weeks.
//   - The Claude budget runs on the provider's own 7-day window (its resetsAt),
//     which rarely starts on a Monday.
// A low-pace flag only fires late in its week (LATE_WEEK): early on, a low
// ratio is mostly noise from a small denominator.
// ============================================================================

'use strict';

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

export const AVG_WEEKS = 4;
/** Weekday 5 of 7 done (Saturday 00:00) before a low pace is called out. */
export const LATE_WEEK = 5 / 7;
/** Below half the expected pace is "low". */
export const LOW_PACE = 0.5;
/** Days in a row with zero contributions (today excluded) before flagging. */
export const QUIET_DAYS = 3;
/** Below this much of the window gone, ratios are too noisy to show. */
const MIN_ELAPSED = 0.02;
const BAR_WEEKS = 8;

const pad = (n) => String(n).padStart(2, '0');

/** 'YYYY-MM-DD' of a local date. */
export function dayKey(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 'YYYY-MM-DD' -> local midnight Date. */
function parseDay(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
}

/** Monday 00:00 local of the week holding `d`. */
export function weekStart(d) {
  const day = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  day.setDate(day.getDate() - ((day.getDay() + 6) % 7));
  return day;
}

/** Fraction (0..1) of the current Monday-Sunday week already gone. */
export function weekElapsed(now) {
  return Math.min(1, Math.max(0, (now - weekStart(now)) / WEEK_MS));
}

/** Zero-contribution days in a row, counted back from yesterday. */
function quietDays(days, now) {
  const counts = new Map(days.map((d) => [d.date, d.count]));
  const cursor = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  let n = 0;
  while (counts.get(dayKey(cursor)) === 0) {
    n++;
    cursor.setDate(cursor.getDate() - 1);
  }
  return n;
}

/**
 * Daily contribution counts -> this week vs the AVG_WEEKS-week average.
 * @param {{date:string,count:number}[]} days  oldest first
 * @param {Date} now
 */
export function githubVelocity(days, now) {
  const totals = new Map();
  for (const { date, count } of days) {
    const key = dayKey(weekStart(parseDay(date)));
    totals.set(key, (totals.get(key) || 0) + count);
  }
  const thisStart = weekStart(now);
  const weekKey = (back) => {
    const d = new Date(thisStart);
    d.setDate(d.getDate() - back * 7);
    return dayKey(d);
  };
  const firstDay = days.length ? days[0].date : null;
  // Only weeks the data fully covers count towards the average.
  const prior = [];
  for (let back = 1; back <= AVG_WEEKS; back++) {
    const key = weekKey(back);
    if (firstDay && key >= firstDay) prior.push(totals.get(key) || 0);
  }
  const avgWeek = prior.length ? prior.reduce((a, b) => a + b, 0) / prior.length : null;
  const thisWeek = totals.get(weekKey(0)) || 0;
  const elapsed = weekElapsed(now);
  const expected = avgWeek === null ? null : avgWeek * elapsed;
  const pace = expected && elapsed >= MIN_ELAPSED ? thisWeek / expected : null;
  const weeks = [];
  for (let back = BAR_WEEKS - 1; back >= 0; back--) {
    const key = weekKey(back);
    weeks.push({ start: key, count: totals.get(key) || 0 });
  }
  return { thisWeek, avgWeek, expected, pace, elapsed, weeks, quietDays: quietDays(days, now) };
}

/**
 * Days -> heatmap columns (one per week, Monday first), each cell
 * {date, count, level 0..4}, or null for days not reached yet.
 */
export function heatmap(days, now) {
  if (!days.length) return [];
  const counts = new Map(days.map((d) => [d.date, d.count]));
  const max = Math.max(1, ...days.map((d) => d.count));
  const today = dayKey(now);
  const cols = [];
  const cursor = weekStart(parseDay(days[0].date));
  const end = weekStart(now);
  while (cursor <= end) {
    const col = [];
    for (let i = 0; i < 7; i++) {
      const key = dayKey(cursor);
      const count = counts.get(key) || 0;
      const level = count === 0 ? 0 : Math.min(4, Math.ceil((count / max) * 4));
      col.push(key > today ? null : { date: key, count, level });
      cursor.setDate(cursor.getDate() + 1);
    }
    cols.push(col);
  }
  return cols;
}

/**
 * A weekly usage limit ({percentUsed, resetsAt}) -> burn rate against the
 * window's elapsed share. Null when the provider gave no reset time.
 */
export function budgetPace(limit, now) {
  const resetsAt = limit ? Date.parse(limit.resetsAt) : NaN;
  if (!limit || typeof limit.percentUsed !== 'number' || !Number.isFinite(resetsAt)) return null;
  const used = Math.max(0, limit.percentUsed);
  const elapsed = Math.min(1, Math.max(0, 1 - (resetsAt - now.getTime()) / WEEK_MS));
  const expected = elapsed * 100;
  const noisy = elapsed < MIN_ELAPSED;
  const pace = noisy ? null : used / expected;
  const projected = noisy ? null : used / elapsed;
  let hitsAt = null;
  if (projected !== null && projected > 100 && used < 100) {
    const perMs = used / (elapsed * WEEK_MS);
    hitsAt = now.getTime() + (100 - used) / perMs;
  }
  return { used, elapsed, expected, pace, projected, hitsAt, resetsAt };
}

/**
 * The anomalies worth a line, most urgent first. Keys map to i18n
 * `mc.tele.flag.<key>`; vars fill the message.
 * @returns {{key:string, level:'bad'|'warn'|'info', vars:object}[]}
 */
export function paceFlags({ velocity, budget }) {
  const flags = [];
  if (budget && budget.hitsAt !== null && budget.hitsAt < budget.resetsAt) {
    flags.push({ key: 'overBurn', level: 'bad', vars: { at: budget.hitsAt } });
  }
  if (velocity && velocity.pace !== null && velocity.elapsed >= LATE_WEEK && velocity.pace < LOW_PACE) {
    flags.push({ key: 'lowOutput', level: 'warn', vars: { pct: Math.round(velocity.pace * 100) } });
  }
  if (budget && budget.pace !== null && budget.elapsed >= LATE_WEEK && budget.pace < LOW_PACE) {
    flags.push({
      key: 'lowBudget',
      level: 'warn',
      vars: { used: Math.round(budget.used), expected: Math.round(budget.expected) },
    });
  }
  if (velocity && velocity.quietDays >= QUIET_DAYS) {
    flags.push({ key: 'quiet', level: 'info', vars: { days: velocity.quietDays } });
  }
  return flags;
}
