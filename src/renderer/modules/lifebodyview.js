// ============================================================================
// LunaCore - Life dashboard: Body tab math (pure, no DOM)
// ----------------------------------------------------------------------------
// Turns the YAZIO numbers from life:body (src/lifeyazio.js) into what the
// Body tab draws: calories left and how close to the goal, a share of any
// goal, progress from the start weight to the goal weight (losing or
// gaining), and the week's averages. Kept apart from lifebody.js so it is
// testable under plain node.
// ============================================================================

'use strict';

// From 90 % of the calorie goal up to the goal itself counts as "on target".
const NEAR_SHARE = 0.9;

const round1 = (n) => Math.round(n * 10) / 10;
const round2 = (n) => Math.round(n * 100) / 100;

/** Calories against the goal: {left, share, status: none|under|near|over}. */
export function kcalState(kcal, goal) {
  if (!(goal > 0)) return { left: 0, share: 0, status: 'none' };
  const share = kcal / goal;
  let status = 'under';
  if (share > 1) status = 'over';
  else if (share >= NEAR_SHARE) status = 'near';
  return { left: goal - kcal, share, status };
}

/** Any "more is better" goal (protein, steps, water): {share, hit}. */
export function goalShare(value, goal) {
  if (!(goal > 0)) return { share: 0, hit: false };
  return { share: round2(value / goal), hit: value >= goal };
}

/**
 * Start -> current -> goal weight, either direction. null when a number is
 * missing or start equals goal (nothing to measure against).
 * @returns {{share:number, toGo:number, changed:number} | null}
 */
export function weightProgress(start, current, goal) {
  if (![start, current, goal].every((n) => typeof n === 'number' && Number.isFinite(n))) return null;
  if (start === goal) return null;
  const share = Math.max(0, Math.min(1, (start - current) / (start - goal)));
  const dir = Math.sign(start - goal);
  return {
    share: round2(share),
    toGo: Math.max(0, round1((current - goal) * dir)),
    changed: round1(current - start),
  };
}

/**
 * The last days at a glance. A day with 0 kcal was not logged and stays out
 * of the calorie numbers; steps count every day the phone saw any.
 */
export function weekStats(history, proteinGoal) {
  const logged = history.filter((d) => d.kcal > 0);
  const walked = history.filter((d) => d.steps > 0);
  const avg = (rows, key) => (rows.length ? Math.round(rows.reduce((s, d) => s + d[key], 0) / rows.length) : 0);
  return {
    logged: logged.length,
    avgKcal: avg(logged, 'kcal'),
    onTarget: logged.filter((d) => d.kcalGoal > 0 && d.kcal <= d.kcalGoal).length,
    proteinHit: proteinGoal > 0 ? history.filter((d) => d.protein >= proteinGoal).length : 0,
    avgSteps: avg(walked, 'steps'),
  };
}
