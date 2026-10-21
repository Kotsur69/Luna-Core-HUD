// ============================================================================
// LunaCore - Life dashboard: live productivity score 0-100 (pure, no model)
// ----------------------------------------------------------------------------
// Four parts, each 0..1, weighted by the Settings sliders (25 each by default):
//   focus    focus hours vs the daily target (W2 blocks, missionfocus.js)
//   shipping own commits (+1 more per feat:, +0.5 per fix:) and PRs (+2) as
//            points vs SHIP_POINTS_PER_DAY
//   goals    the ISO week's goals (done 1 / partly 0.5) and to-dos closed
//            (vs TODOS_PER_DAY), averaged over what exists
//   health   YAZIO kcal within 15% of the goal, protein >= 90% of the goal,
//            sleep vs SLEEP_TARGET_H, daily habits ticked - averaged over
//            what exists
// A part with no data at all is left out and the others are re-weighted, so
// a day without YAZIO is not a bad day - the UI says which parts are out.
// Ranges (a week so far, last week) sum the days and scale the targets by
// the number of days.
// ============================================================================

'use strict';

const { addDays, dayDiff, mondayOf, isoWeek } = require('./lifedays');

const PARTS = ['focus', 'shipping', 'goals', 'health'];
const HOUR_MS = 60 * 60 * 1000;
const SHIP_POINTS_PER_DAY = 4;
const TODOS_PER_DAY = 3;
const SLEEP_TARGET_H = 7.5;
const KCAL_TOLERANCE = 0.15;
const PROTEIN_SHARE = 0.9;

const cap = (v) => Math.max(0, Math.min(1, v));
const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);

/** true/false, or null when there is nothing to judge (no goal or nothing logged). */
function kcalHit(kcal, goal) {
  if (!(goal > 0) || !(kcal > 0)) return null;
  return Math.abs(kcal - goal) <= goal * KCAL_TOLERANCE;
}

function proteinHit(protein, goal) {
  if (!(goal > 0) || typeof protein !== 'number') return null;
  return protein >= goal * PROTEIN_SHARE;
}

/**
 * One day's (or a summed range's) inputs -> part values 0..1 or null.
 * @param {{focusMs:number|null, commits:number|null, feat:number, fix:number, prs:number|null,
 *   todos:number|null, kcalHit:boolean|number|null, proteinHit:boolean|number|null,
 *   sleep:number|null, habits:{done:number,due:number}|null}} input
 *   kcalHit / proteinHit may be a 0..1 share when days are summed.
 * @param {{focusTargetH:number, days?:number, goals?:number|null}} opts
 */
function partValues(input, { focusTargetH, days = 1, goals = null }) {
  const focus = input.focusMs === null ? null : cap(input.focusMs / (focusTargetH * HOUR_MS * days));

  let shipping = null;
  if (input.commits !== null || input.prs !== null) {
    const points = (input.commits || 0) + (input.feat || 0) + 0.5 * (input.fix || 0) + 2 * (input.prs || 0);
    shipping = cap(points / (SHIP_POINTS_PER_DAY * days));
  }

  const goalParts = [];
  if (typeof goals === 'number') goalParts.push(cap(goals));
  if (input.todos !== null && input.todos !== undefined) goalParts.push(cap(input.todos / (TODOS_PER_DAY * days)));

  const healthParts = [];
  for (const hit of [input.kcalHit, input.proteinHit]) if (hit !== null && hit !== undefined) healthParts.push(Number(hit));
  if (typeof input.sleep === 'number') healthParts.push(cap(input.sleep / SLEEP_TARGET_H));
  if (input.habits && input.habits.due > 0) healthParts.push(cap(input.habits.done / input.habits.due));

  return { focus, shipping, goals: mean(goalParts), health: mean(healthParts) };
}

/**
 * @param {Record<string, number|null>} values part -> 0..1 or null
 * @param {Record<string, number>} weights part -> weight (any scale)
 * @returns {{score:number|null, parts:Array<{key, value, weight, share}>, missing:string[]}}
 *   share = the part's effective % of the score after re-weighting.
 */
function scoreOf(values, weights) {
  const used = PARTS.filter((k) => values[k] !== null && weights[k] > 0);
  const total = used.reduce((s, k) => s + weights[k], 0);
  const score = total > 0 ? Math.round((100 * used.reduce((s, k) => s + weights[k] * values[k], 0)) / total) : null;
  return {
    score,
    parts: PARTS.map((k) => ({ key: k, value: values[k], weight: weights[k], share: used.includes(k) ? Math.round((100 * weights[k]) / total) : 0 })),
    missing: PARTS.filter((k) => values[k] === null && weights[k] > 0),
  };
}

/** Sums day inputs; a field stays null only when every day lacks it. */
function sumDays(list) {
  const sum = (k) => (list.some((d) => d[k] !== null && d[k] !== undefined) ? list.reduce((s, d) => s + (d[k] || 0), 0) : null);
  const share = (k) => mean(list.filter((d) => d[k] !== null && d[k] !== undefined).map((d) => Number(d[k])));
  const sleeps = list.filter((d) => typeof d.sleep === 'number').map((d) => d.sleep);
  const habitDays = list.filter((d) => d.habits && d.habits.due > 0);
  return {
    focusMs: sum('focusMs'),
    commits: sum('commits'),
    feat: sum('feat') || 0,
    fix: sum('fix') || 0,
    prs: sum('prs'),
    todos: sum('todos'),
    kcalHit: share('kcalHit'),
    proteinHit: share('proteinHit'),
    sleep: mean(sleeps),
    habits: habitDays.length ? { done: habitDays.reduce((s, d) => s + d.habits.done, 0), due: habitDays.reduce((s, d) => s + d.habits.due, 0) } : null,
  };
}

const NO_DATA = { focusMs: null, commits: null, feat: 0, fix: 0, prs: null, todos: null, kcalHit: null, proteinHit: null, sleep: null, habits: null };

function rangeScore(days, list, opts) {
  const inputs = list.map((d) => days[d] || NO_DATA);
  const goals = opts.goalsByWeek[isoWeek(list[0])];
  const values = partValues(sumDays(inputs), { focusTargetH: opts.focusTargetH, days: list.length, goals: typeof goals === 'number' ? goals : null });
  return { ...scoreOf(values, opts.weights), days: list.length };
}

function trend(now, before) {
  if (now.score === null || before.score === null) return null;
  const delta = now.score - before.score;
  return { dir: delta > 0 ? 'up' : delta < 0 ? 'down' : 'same', delta };
}

/**
 * @param {{days: Record<string, object>, today: string, goalsByWeek: Record<string, number|null>,
 *   weights: Record<string, number>, focusTargetH: number}} opts
 *   days = per local day inputs (see partValues); goalsByWeek = ISO week -> goals fraction
 */
function scoreReport(opts) {
  const { days, today } = opts;
  const yesterday = addDays(today, -1);
  const monday = mondayOf(today);
  const span = (from, n) => Array.from({ length: n }, (_, i) => addDays(from, i));
  const thisWeek = span(monday, dayDiff(monday, today) + 1);
  const r = {
    today: rangeScore(days, [today], opts),
    yesterday: rangeScore(days, [yesterday], opts),
    week: rangeScore(days, thisWeek, opts),
    lastWeek: rangeScore(days, span(addDays(monday, -7), 7), opts),
  };
  return { ...r, dayTrend: trend(r.today, r.yesterday), weekTrend: trend(r.week, r.lastWeek) };
}

module.exports = { partValues, scoreOf, scoreReport, sumDays, kcalHit, proteinHit, PARTS, SHIP_POINTS_PER_DAY, TODOS_PER_DAY, SLEEP_TARGET_H };
