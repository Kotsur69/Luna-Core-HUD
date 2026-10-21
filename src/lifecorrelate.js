// ============================================================================
// LunaCore - Life dashboard: local correlations of daily series (pure)
// ----------------------------------------------------------------------------
// "On days when you hit your protein goal, on average you had 1.4 h more
// focus." Computed here, never by a model: for each outcome (focus hours,
// day score, own commits) and each condition (protein / kcal goal hit, slept
// >= 7 h, energy >= 4, every daily habit ticked) the outcome's mean on days
// with the condition is compared with the mean on days without it.
//
// A pair is only reported when it has enough data to mean something:
//   - at least MIN_DAYS days where both the outcome and the condition are known;
//   - at least MIN_GROUP days on each side;
//   - an effect above both the outcome's absolute floor and REL_THRESHOLD of
//     the overall mean (half an hour more focus on a 6 h average is noise).
// It is a mean difference, not causation; the wording says "on average".
//
// The series itself (one row per finished local day) is built by
// seriesFromInputs() from the score inputs (src/lifescoreinputs.js) plus the
// check-in, and kept by src/lifeseries.js so it outlives the 14-day input
// window.
// ============================================================================

'use strict';

const { partValues, scoreOf } = require('./lifescore');
const { isoWeek } = require('./lifedays');

const MIN_DAYS = 14;
const MIN_GROUP = 5;
const REL_THRESHOLD = 0.15;
const HOUR_MS = 60 * 60 * 1000;
const SLEEP_OK_H = 7;
const ENERGY_OK = 4;

const OUTCOMES = {
  focusH: { floor: 0.5, en: (v) => `${v.toFixed(1)} h of focus` },
  score: { floor: 5, en: (v) => `a day score of ${Math.round(v)}` },
  commits: { floor: 1, en: (v) => `${v.toFixed(1)} commits` },
};

const CONDITIONS = {
  proteinHit: { test: (d) => (typeof d.proteinHit === 'boolean' ? d.proteinHit : null), en: 'you hit your protein goal' },
  kcalHit: { test: (d) => (typeof d.kcalHit === 'boolean' ? d.kcalHit : null), en: 'your calories were on target' },
  sleep7: { test: (d) => (typeof d.sleep === 'number' ? d.sleep >= SLEEP_OK_H : null), en: `you slept ${SLEEP_OK_H} h or more` },
  energy4: { test: (d) => (Number.isInteger(d.energy) ? d.energy >= ENERGY_OK : null), en: `your energy was ${ENERGY_OK}/5 or higher` },
  habitsAll: { test: (d) => (typeof d.habits === 'number' ? d.habits >= 1 : null), en: 'you ticked every daily habit' },
};

const mean = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;
const round = (v, n = 2) => Math.round(v * 10 ** n) / 10 ** n;

/**
 * Every pair that passes the data and effect checks, strongest (relative
 * effect) first.
 * @param {Record<string, object>} series day -> {focusH, score, commits, proteinHit, kcalHit, sleep, energy, habits}
 * @returns {Array<{outcome:string, condition:string, withMean:number, withoutMean:number,
 *   nWith:number, nWithout:number, delta:number, rel:number}>}
 */
function correlate(series) {
  const days = Object.values(series && typeof series === 'object' ? series : {}).filter((d) => d && typeof d === 'object');
  const out = [];
  for (const [outcome, o] of Object.entries(OUTCOMES)) {
    for (const [condition, c] of Object.entries(CONDITIONS)) {
      const yes = [];
      const no = [];
      for (const d of days) {
        const v = d[outcome];
        const hit = c.test(d);
        if (typeof v !== 'number' || !Number.isFinite(v) || hit === null) continue;
        (hit ? yes : no).push(v);
      }
      if (yes.length + no.length < MIN_DAYS || yes.length < MIN_GROUP || no.length < MIN_GROUP) continue;
      const withMean = mean(yes);
      const withoutMean = mean(no);
      const delta = withMean - withoutMean;
      const overall = mean([...yes, ...no]);
      const rel = overall > 0 ? Math.abs(delta) / overall : 0;
      if (Math.abs(delta) < o.floor || rel < REL_THRESHOLD) continue;
      out.push({ outcome, condition, withMean: round(withMean), withoutMean: round(withoutMean), nWith: yes.length, nWithout: no.length, delta: round(delta), rel: round(rel, 3) });
    }
  }
  return out.sort((a, b) => b.rel - a.rel || Math.abs(b.delta) - Math.abs(a.delta));
}

/** The strongest `n` findings. */
const topCorrelations = (series, n = 3) => correlate(series).slice(0, n);

/** English sentence for the weekly review and its email. */
function phrase(c) {
  const o = OUTCOMES[c.outcome];
  const cond = CONDITIONS[c.condition];
  if (!o || !cond) return '';
  return `On days when ${cond.en}, on average you had ${o.en(c.withMean)} vs ${o.en(c.withoutMean)} on other days (${c.nWith} vs ${c.nWithout} days).`;
}

const bool = (v) => (typeof v === 'boolean' ? v : null);

/**
 * Finished days (before `today`) of the score inputs -> series rows.
 * @param {{days:Record<string,object>, today:string, checkin:{days:object}, goalsByWeek:Record<string,number|null>,
 *   weights:Record<string,number>, focusTargetH:number}} src days = lifescoreinputs.dayInputs()
 */
function seriesFromInputs({ days, today, checkin, goalsByWeek, weights, focusTargetH }) {
  const out = {};
  for (const [day, input] of Object.entries(days || {})) {
    if (day >= today || !input) continue;
    const goals = goalsByWeek ? goalsByWeek[isoWeek(day)] : null;
    const values = partValues(input, { focusTargetH, goals: typeof goals === 'number' ? goals : null });
    const entry = checkin && checkin.days ? checkin.days[day] : null;
    out[day] = {
      focusH: typeof input.focusMs === 'number' ? round(input.focusMs / HOUR_MS) : null,
      score: scoreOf(values, weights).score,
      commits: typeof input.commits === 'number' ? input.commits : null,
      proteinHit: bool(input.proteinHit),
      kcalHit: bool(input.kcalHit),
      sleep: entry && typeof entry.sleep === 'number' ? entry.sleep : null,
      energy: entry && Number.isInteger(entry.energy) ? entry.energy : null,
      habits: input.habits && input.habits.due > 0 ? round(input.habits.done / input.habits.due) : null,
    };
  }
  return out;
}

module.exports = { correlate, topCorrelations, phrase, seriesFromInputs, OUTCOMES, CONDITIONS, MIN_DAYS, MIN_GROUP, REL_THRESHOLD };
