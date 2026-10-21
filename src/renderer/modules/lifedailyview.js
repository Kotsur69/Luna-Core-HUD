// ============================================================================
// LunaCore - Life dashboard: daily view math (pure, renderer)
// ----------------------------------------------------------------------------
// The decisions behind the check-in / goals prompts, the score card and the
// Now strip, with no DOM, so node --test pins them.
// ============================================================================

'use strict';

export const SLEEP_MAX = 16;
export const ENERGY_LEVELS = [1, 2, 3, 4, 5];
/** Context switches today from which the Now strip suggests staying on one thing. */
export const SWITCH_NUDGE = 3;

/** 0, 0.5, ... 16 - the sleep choices. */
export function sleepOptions() {
  return Array.from({ length: SLEEP_MAX * 2 + 1 }, (_, i) => i / 2);
}

/** Ask for today's check-in: loaded and today not answered yet (a skip counts as answered). */
export const needsCheckin = (checkin) => Boolean(checkin && checkin.ok && checkin.entry === null);

/** Ask for this ISO week's goals: loaded and the week not answered yet (a skip is []). */
export const needsGoals = (goals) => Boolean(goals && goals.ok && goals.goals === null);

/** Score colour band; the number is always printed too. */
export function scoreBand(score) {
  if (typeof score !== 'number') return '';
  if (score >= 70) return 'is-good';
  return score >= 40 ? 'is-warn' : 'is-bad';
}

/** {dir, delta} from lifescore -> glyph + signed text + class; null stays null. */
export function arrow(trend) {
  if (!trend) return null;
  if (trend.dir === 'up') return { glyph: '▲', text: `+${trend.delta}`, cls: 'is-good' };
  if (trend.dir === 'down') return { glyph: '▼', text: String(trend.delta), cls: 'is-bad' };
  return { glyph: '=', text: '0', cls: '' };
}

/** 65 min -> {h: 1, m: 5}. */
export function hoursMinutes(ms) {
  const total = Math.max(0, Math.round((ms || 0) / 60000));
  return { h: Math.floor(total / 60), m: total % 60 };
}

export const shouldNudge = (now) => Boolean(now && typeof now.switches === 'number' && now.switches >= SWITCH_NUDGE);

/** Display name of a habit: its own, or the built-in suggestion's by id. */
export const habitLabelKey = (habit) => (habit && habit.name ? null : `life.habit.${habit ? habit.id : ''}`);

/** The slider values as weights; the main process normalises them to 100. */
export function weightsOf(values) {
  const out = {};
  for (const k of ['focus', 'shipping', 'goals', 'health']) {
    const v = Number(values[k]);
    out[k] = Number.isFinite(v) && v >= 0 ? v : 0;
  }
  return out;
}
