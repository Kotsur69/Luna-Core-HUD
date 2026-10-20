// ============================================================================
// LunaCore - Life dashboard: habit streaks (pure)
// ----------------------------------------------------------------------------
// A habit is done on a day when it was ticked, or - for the steps habit -
// when YAZIO says the steps goal was reached that day (`auto` days, never
// written to the file). Streaks:
//   - daily habit: consecutive days ending today; while today is still open
//     the streak runs up to yesterday, so it does not read 0 every morning;
//   - N-per-week habit: consecutive local Mon-Sun weeks with >= N ticks; the
//     current week counts once it reaches N and never breaks the streak
//     before it is over.
// Every step back in time is a calendar day (lifedays.addDays), never 24 h.
// ============================================================================

'use strict';

const { addDays, mondayOf } = require('./lifedays');

/** Longest look back: a streak beyond this is shown as this. */
const MAX_STREAK_DAYS = 400;
const MAX_STREAK_WEEKS = 60;

function dailyStreak(done, today) {
  let day = done.has(today) ? today : addDays(today, -1);
  let n = 0;
  while (n < MAX_STREAK_DAYS && done.has(day)) {
    n += 1;
    day = addDays(day, -1);
  }
  return n;
}

/** Ticks inside the Mon-Sun week starting `monday`. */
function weekCount(done, monday) {
  let n = 0;
  for (let i = 0; i < 7; i++) if (done.has(addDays(monday, i))) n += 1;
  return n;
}

function weeklyStreak(done, perWeek, today) {
  const thisMonday = mondayOf(today);
  let n = weekCount(done, thisMonday) >= perWeek ? 1 : 0;
  let monday = addDays(thisMonday, -7);
  while (n < MAX_STREAK_WEEKS && weekCount(done, monday) >= perWeek) {
    n += 1;
    monday = addDays(monday, -7);
  }
  return n;
}

/** Ticked days plus the auto days that apply to this habit. */
function doneSet(habit, auto) {
  const set = new Set(Array.isArray(habit.done) ? habit.done : []);
  const extra = habit.auto && auto && auto[habit.auto];
  if (extra) for (const d of extra) set.add(d);
  return set;
}

/**
 * @param {{every:'day'|'week', perWeek:number, auto:string, done:string[]}} habit
 * @param {string} today 'YYYY-MM-DD'
 * @param {{steps?: Set<string>}} auto days a goal was met by an outside source
 */
function habitStatus(habit, today, auto) {
  const done = doneSet(habit, auto);
  const autoSet = (habit.auto && auto && auto[habit.auto]) || new Set();
  const yesterday = addDays(today, -1);
  return {
    doneToday: done.has(today),
    doneYesterday: done.has(yesterday),
    autoToday: autoSet.has(today) && !habit.done.includes(today),
    autoYesterday: autoSet.has(yesterday) && !habit.done.includes(yesterday),
    weekCount: weekCount(done, mondayOf(today)),
    streak: habit.every === 'week' ? weeklyStreak(done, habit.perWeek, today) : dailyStreak(done, today),
  };
}

/** Daily habits done / due on `day`; null when there are no daily habits to judge. */
function dayHabits(habits, day, auto) {
  const daily = habits.filter((h) => h.every === 'day');
  if (!daily.length) return null;
  return { done: daily.filter((h) => doneSet(h, auto).has(day)).length, due: daily.length };
}

module.exports = { dailyStreak, weeklyStreak, habitStatus, dayHabits, weekCount };
