// ============================================================================
// LunaCore - Mission Control: focus view math (pure, renderer)
// ----------------------------------------------------------------------------
// report.focus from mission:ledger (src/missionfocus.js via the ledger
// service) in; rows, heat levels and today's numbers out. No DOM, so
// node --test pins it.
// ============================================================================

'use strict';

/** Projects that get a heatmap row; the rest are summed into one line. */
export const FOCUS_TOP = 6;

const MIN_MS = 60 * 1000;
/** Upper bounds of heat levels 1-3; anything longer is level 4. */
const LEVELS = [30 * MIN_MS, 60 * MIN_MS, 120 * MIN_MS];

/** 0 = nothing, 1 < 30 min, 2 < 1 h, 3 < 2 h, 4 = 2 h or more. */
export function focusLevel(ms) {
  if (!(ms > 0)) return 0;
  const i = LEVELS.findIndex((max) => ms < max);
  return i === -1 ? 4 : i + 1;
}

/** Same rule as the ledger: the non-repo bucket is "other", a repo without a class is "unassigned". */
const classOf = (p) => (p.key === 'other' ? 'other' : p.cls || 'unassigned');

/**
 * @param {{weekStart:number, totalMs:number, days:Array, projects:Array}|null|undefined} focus
 * @param {number} now epoch ms
 */
export function focusView(focus, now) {
  if (!focus || !Array.isArray(focus.days) || !Array.isArray(focus.projects)) return null;
  const days = focus.days.map((d, i) => {
    const next = focus.days[i + 1] ? focus.days[i + 1].start : Infinity;
    return { ...d, isFuture: d.start > now, isToday: d.start <= now && now < next };
  });
  const rows = focus.projects.slice(0, FOCUS_TOP).map((p) => ({
    key: p.key,
    name: p.name,
    cls: classOf(p),
    totalMs: p.totalMs,
    cells: days.map((d, i) => ({ start: d.start, ms: p.days[i] || 0, level: focusLevel(p.days[i]), isFuture: d.isFuture })),
  }));
  const rest = focus.projects.slice(FOCUS_TOP);
  const today = days.find((d) => d.isToday);
  return {
    totalMs: focus.totalMs,
    days,
    rows,
    restCount: rest.length + (focus.moreProjects || 0),
    restMs: rest.reduce((s, p) => s + p.totalMs, 0),
    today: today ? { totalMs: today.totalMs, switches: today.switches } : null,
  };
}
