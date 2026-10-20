// ============================================================================
// LunaCore - Life dashboard: productivity score inputs (pure, main process)
// ----------------------------------------------------------------------------
// Gathers what src/lifescore.js scores, per local day for the last
// INPUT_DAYS days (this week + last week):
//   focus    report.focus.days / prevDays (mission:ledger, missionfocus.js)
//   shipping report.commitDays (own commits + feat/fix, missioncommits.js) and
//            my open PRs updated that day (missiongithub.js)
//   goals    to-dos closed that day (doneAt, src/todo.js); the ISO week's
//            goals come from goalsByWeek() (src/lifegoals.js)
//   health   YAZIO kcal / protein (src/lifeyazio.js), check-in sleep
//            (src/lifecheckin.js), daily habits ticked (src/lifehabits.js)
// A missing source leaves its fields null - "no data", never "zero" - so
// the score leaves that part out instead of punishing the day. Today's
// YAZIO numbers are a running total, so today counts progress toward the
// goals rather than hit/miss.
// ============================================================================

'use strict';

const { ymd, addDays } = require('./lifedays');
const { kcalHit, proteinHit } = require('./lifescore');
const { dayHabits } = require('./lifehabitcalc');
const { goalsFraction } = require('./lifegoals');

const INPUT_DAYS = 14;
const KCAL_OVER = 1.15;
const PROTEIN_SHARE = 0.9;

const cap = (v) => Math.max(0, Math.min(1, v));

/** Today's kcal so far as 0..1 toward the goal; past 115% of the goal = 0. */
function kcalProgress(kcal, goal) {
  if (!(goal > 0) || !(kcal > 0)) return null;
  return kcal > goal * KCAL_OVER ? 0 : cap(kcal / goal);
}

function proteinProgress(protein, goal) {
  if (!(goal > 0) || typeof protein !== 'number') return null;
  return cap(protein / (goal * PROTEIN_SHARE));
}

/** {steps: Set<day>}: days YAZIO's steps reached today's steps goal. */
function autoDays(body) {
  const steps = new Set();
  const goal = body && body.today && body.today.stepsGoal;
  if (goal > 0 && Array.isArray(body.history)) {
    for (const h of body.history) if (h && typeof h.date === 'string' && h.steps >= goal) steps.add(h.date);
  }
  return { steps };
}

/** ISO week -> goals fraction (null for a skipped / empty week). */
function goalsByWeek(goalsStore) {
  const weeks = (goalsStore && goalsStore.weeks) || {};
  return Object.fromEntries(Object.keys(weeks).map((k) => [k, goalsFraction(weeks[k])]));
}

/** day -> count of things whose time falls on that local day. */
function countByDay(times) {
  const out = new Map();
  for (const ms of times) {
    if (!Number.isFinite(ms)) continue;
    const day = ymd(ms);
    out.set(day, (out.get(day) || 0) + 1);
  }
  return out;
}

function focusByDay(report) {
  const focus = report && report.focus;
  if (!focus) return null;
  const out = new Map();
  for (const d of [...(focus.prevDays || []), ...(focus.days || [])]) {
    if (d && Number.isFinite(d.start) && Number.isFinite(d.totalMs)) out.set(ymd(d.start), d.totalMs);
  }
  return out;
}

function todoTimes(todoStore) {
  const lists = todoStore && typeof todoStore === 'object' ? Object.values(todoStore) : [];
  const items = lists.flatMap((l) => (Array.isArray(l) ? l : []));
  return items.length ? items.filter((t) => t && t.done && Number.isFinite(t.doneAt)).map((t) => t.doneAt) : null;
}

function prTimes(github) {
  const items = github && github.lists && github.lists.prs && github.lists.prs.items;
  return Array.isArray(items) ? items.map((it) => Date.parse(it && it.updatedAt)) : null;
}

function yazioDay(body, day, today) {
  const none = { kcalHit: null, proteinHit: null };
  if (!body) return none;
  if (day === today && body.today && body.date === today) {
    return { kcalHit: kcalProgress(body.today.kcal, body.today.kcalGoal), proteinHit: proteinProgress(body.today.protein, body.today.proteinGoal) };
  }
  const h = Array.isArray(body.history) ? body.history.find((x) => x && x.date === day) : null;
  if (!h) return none;
  // History has no protein goal of its own: today's is the best guess.
  const proteinGoal = body.today ? body.today.proteinGoal : 0;
  return { kcalHit: kcalHit(h.kcal, h.kcalGoal), proteinHit: proteinHit(h.protein, proteinGoal) };
}

/**
 * @param {{today:string, report:object|null, github:object|null, todoStore:object,
 *   body:object|null, checkin:{days:object}, habits:Array}} src
 * @returns {Record<string, object>} day -> lifescore.partValues input
 */
function dayInputs({ today, report, github, todoStore, body, checkin, habits }) {
  const focus = focusByDay(report);
  const commits = report && Array.isArray(report.commitDays) ? new Map(report.commitDays.map((c) => [c.date, c])) : null;
  const prsTimes = prTimes(github);
  const prs = prsTimes ? countByDay(prsTimes) : null;
  const doneTimes = todoTimes(todoStore);
  const todos = doneTimes ? countByDay(doneTimes) : null;
  const auto = autoDays(body);
  const out = {};
  for (let i = INPUT_DAYS - 1; i >= 0; i--) {
    const day = addDays(today, -i);
    const c = commits ? commits.get(day) : null;
    const entry = checkin && checkin.days ? checkin.days[day] : null;
    out[day] = {
      focusMs: focus ? (focus.has(day) ? focus.get(day) : null) : null,
      commits: c ? c.commits : null,
      feat: c ? c.feat : 0,
      fix: c ? c.fix : 0,
      prs: prs ? prs.get(day) || 0 : null,
      todos: todos ? todos.get(day) || 0 : null,
      ...yazioDay(body, day, today),
      sleep: entry && typeof entry.sleep === 'number' ? entry.sleep : null,
      habits: dayHabits(Array.isArray(habits) ? habits : [], day, auto),
    };
  }
  return out;
}

/** The Now strip: live project (reply < 10 min old), time in it, today's context switches. */
function nowStrip(report, today, nowMs) {
  const project = (report && report.now) || null;
  const days = report && report.focus && Array.isArray(report.focus.days) ? report.focus.days : null;
  const day = days ? days.find((d) => d && Number.isFinite(d.start) && ymd(d.start) === today) : null;
  return { project, inMs: project ? Math.max(0, nowMs - project.sinceMs) : 0, switches: day ? day.switches : null };
}

module.exports = { dayInputs, autoDays, goalsByWeek, nowStrip, kcalProgress, proteinProgress, INPUT_DAYS };
