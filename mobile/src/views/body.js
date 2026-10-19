// ============================================================================
// LunaCore phone - Body: the newest YAZIO numbers a PC uploaded (phase 4c)
// ----------------------------------------------------------------------------
// Read-only. The phone never logs in to YAZIO: a PC that is logged in puts
// its Body tab numbers as the `yazio` snapshot (src/lifeyaziopeers.js), and
// snapmodel.bodyFrom() keeps only known, range-checked fields.
// ============================================================================

import { h } from '../dom.js';
import { t, tf, locale } from '../i18n.js';
import { bodyFrom } from '../snapmodel.js';
import { mountSnapshots, when } from './snapshotview.js';

const n0 = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 });
const n1 = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 });
const HISTORY_DAYS = 7;
const shortDate = (ymd) => new Date(`${ymd}T12:00:00`).toLocaleDateString(locale, { day: 'numeric', month: 'short' });

// The CSP (style-src 'self') blocks style attributes, so sizes go through the CSSOM.
function meter(value, goal, over = false) {
  const bar = h('span');
  bar.style.transform = `scaleX(${goal > 0 ? Math.min(1, value / goal) : 0})`;
  return h('div', { class: `meter${over ? ' is-bad' : ''}`, 'aria-hidden': 'true' }, bar);
}

/** One "value of goal" line with its meter; the text carries the numbers. */
function goalRow(label, value, goal, unit) {
  return h(
    'li',
    { class: 'row-col' },
    h('div', { class: 'row' }, h('span', { class: 'grow' }, label), h('span', { class: 'num' }, `${n0.format(value)} / ${n0.format(goal)} ${unit}`.trim())),
    meter(value, goal),
  );
}

function weightCard(today, lastWeighIn) {
  if (!today.weight) return null;
  const sub = [lastWeighIn ? tf('weighIn', { date: shortDate(lastWeighIn.date) }) : '', today.weightGoal ? tf('weightGoal', { kg: `${n1.format(today.weightGoal)} kg` }) : ''].filter(Boolean).join(' · ');
  return h(
    'section',
    { class: 'card', 'aria-labelledby': 'body-weight' },
    h('h2', { class: 'section-title', id: 'body-weight' }, t('weight')),
    h('div', { class: 'big-sm num' }, `${n1.format(today.weight)} kg`),
    sub ? h('div', { class: 'hint' }, sub) : null,
  );
}

function historyCard(history) {
  const days = history.slice(-HISTORY_DAYS).reverse();
  if (!days.length) return null;
  return h(
    'section',
    { class: 'card', 'aria-labelledby': 'body-hist' },
    h('h2', { class: 'section-title', id: 'body-hist' }, t('last7')),
    h(
      'ul',
      { class: 'rows' },
      days.map((d) =>
        h(
          'li',
          { class: 'row-col' },
          h('div', { class: 'row' }, h('span', { class: 'grow' }, shortDate(d.date)), h('span', { class: `num${d.kcalGoal > 0 && d.kcal > d.kcalGoal ? ' is-bad' : ''}` }, `${n0.format(d.kcal)} / ${n0.format(d.kcalGoal)}`)),
          meter(d.kcal, d.kcalGoal, d.kcalGoal > 0 && d.kcal > d.kcalGoal),
        ),
      ),
    ),
  );
}

function render(rows, now) {
  const found = bodyFrom(rows, now);
  if (!found) return h('p', { class: 'empty' }, t('bodyEmpty'));
  const { machine, body } = found;
  const d = body.today;
  const budget = d.kcalGoal + d.activityKcal;
  return h(
    'div',
    { class: 'stack' },
    h('p', { class: 'hint' }, tf('bodyFrom', { date: shortDate(body.date), time: when(body.fetchedAt, now), machine })),
    h(
      'section',
      { class: 'card hero', 'aria-labelledby': 'body-kcal' },
      h('h2', { class: 'label', id: 'body-kcal' }, t('kcal')),
      h('div', { class: `big num${d.kcal > budget ? ' is-bad' : ''}` }, `${n0.format(d.kcal)} kcal`),
      h('div', { class: 'sub' }, `/ ${n0.format(d.kcalGoal)} + ${n0.format(d.activityKcal)} kcal`),
      meter(d.kcal, budget, d.kcal > budget),
    ),
    h(
      'section',
      { class: 'card' },
      h(
        'ul',
        { class: 'rows' },
        goalRow(t('protein'), d.protein, d.proteinGoal, 'g'),
        goalRow(t('fat'), d.fat, d.fatGoal, 'g'),
        goalRow(t('carb'), d.carb, d.carbGoal, 'g'),
        goalRow(t('steps'), d.steps, d.stepsGoal, ''),
        goalRow(t('water'), d.water, d.waterGoal, 'ml'),
      ),
    ),
    weightCard(d, body.lastWeighIn),
    historyCard(body.history),
  );
}

/**
 * @param {HTMLElement} main
 * @param {{cloud: object, toast: (m: string, bad?: boolean) => void}} deps
 * @returns {{refresh: () => Promise<void>}}
 */
export function mountBody(main, deps) {
  return mountSnapshots(main, deps, ['yazio'], (byKind, now) => render(byKind.yazio, now));
}
