// ============================================================================
// LunaCore - Life dashboard: productivity score + Now strip (renderer)
// ----------------------------------------------------------------------------
// The live 0-100 score (src/lifescore.js, computed in main - no model call)
// with its four parts, arrows today vs yesterday and this week vs last week,
// and a tooltip naming the parts left out for lack of data. The Now strip
// says what project is live (a Claude reply in the last 10 minutes), for how
// long, and nudges after 3+ context switches today. Settings: the four
// weights (normalised to 100 in main) and the daily focus target.
// ============================================================================

'use strict';

import { t } from './util.js';
import { el, bucket, bar, field, input } from './lifeui.js';
import { getDaily, setScorePrefs } from './lifedaily.js';
import { scoreBand, arrow, hoursMinutes, shouldNudge, weightsOf } from './lifedailyview.js';

const PARTS = ['focus', 'shipping', 'goals', 'health'];

const duration = (ms) => {
  const { h, m } = hoursMinutes(ms);
  return h ? t('life.score.hm', { h, m }) : t('life.score.m', { m });
};

function trendChip(labelKey, trend) {
  const a = arrow(trend);
  const chip = el('span', `life-score__trend ${a ? a.cls : ''}`.trim());
  chip.append(el('span', 'life-score__trendlabel', t(labelKey)), el('span', 'life-num', a ? `${a.glyph} ${a.text}` : '–'));
  return chip;
}

function partRow(p) {
  const li = el('li', 'life-score__part');
  const head = el('div', 'life-cat__head');
  head.append(el('span', 'life-cat__name', t(`life.score.${p.key}`)));
  if (p.value === null) head.append(el('span', 'life-cat__note', t(p.weight > 0 ? 'life.score.noData' : 'life.score.off')));
  else head.append(el('span', 'life-num', t('life.score.partValue', { value: Math.round(p.value * 100), share: p.share })));
  li.append(head, bar(p.value || 0, p.value === null ? 'is-off' : ''));
  return li;
}

/** Overview card: the score, its arrows and its parts. id'd so a refresh can swap it in place. */
export function scoreCard() {
  const card = bucket('life.score.title', 'life-score');
  card.sec.id = 'life-score-card';
  const s = getDaily().score;
  if (!s) {
    card.body.append(el('p', 'hint', t('life.loading')));
    return card.sec;
  }
  const today = s.score.today;
  const top = el('div', 'life-score__top');
  const big = el('p', `life-score__big life-num ${scoreBand(today.score)}`.trim(), today.score === null ? '–' : String(today.score));
  big.setAttribute('aria-label', today.score === null ? t('life.score.none') : t('life.score.aria', { n: today.score }));
  const missing = today.missing.map((k) => t(`life.score.${k}`)).join(', ');
  // The tooltip says what the number is built from - a part with no data is left out, not counted as 0.
  big.title = missing ? t('life.score.reweighted', { parts: missing }) : t('life.score.allParts');
  const trends = el('div', 'life-score__trends');
  trends.append(
    trendChip('life.score.vsYesterday', s.score.dayTrend),
    trendChip('life.score.vsLastWeek', s.score.weekTrend),
    el('span', 'life-score__week life-num', t('life.score.weekAvg', { n: s.score.week.score === null ? '–' : s.score.week.score }))
  );
  top.append(big, trends);
  const list = el('ul', 'life-list');
  for (const p of today.parts) list.append(partRow(p));
  card.body.append(top, list);
  if (missing) card.body.append(el('p', 'hint', t('life.score.reweighted', { parts: missing })));
  return card.sec;
}

/** The Now strip above the Overview. id'd so a refresh can swap it in place. */
export function nowStrip() {
  const strip = el('section', 'life-now');
  strip.id = 'life-now-strip';
  strip.setAttribute('aria-label', t('life.now.title'));
  const s = getDaily().score;
  const now = s && s.now;
  strip.append(el('span', 'life-now__label', t('life.now.title')));
  if (now && now.project) {
    strip.append(el('span', 'life-now__project', now.project.name), el('span', 'life-num life-now__time', duration(now.inMs)));
  } else {
    strip.append(el('span', 'life-now__idle', t('life.now.idle')));
  }
  if (now && typeof now.switches === 'number') strip.append(el('span', 'life-num life-now__switches', t('life.now.switches', { n: now.switches })));
  if (shouldNudge(now)) strip.append(el('span', 'life-now__nudge is-warn', t('life.now.nudge')));
  return strip;
}

/** Settings card: the four weights and the daily focus target. */
export function scoreSettingsCard() {
  const card = bucket('life.score.settings');
  const s = getDaily().score;
  const prefs = (s && s.prefs) || { weights: { focus: 25, shipping: 25, goals: 25, health: 25 }, focusTargetH: 6 };
  const form = el('form', 'life-form');
  const sliders = {};
  const shares = {};
  const paint = () => {
    const w = weightsOf(Object.fromEntries(PARTS.map((k) => [k, sliders[k].value])));
    const total = PARTS.reduce((sum, k) => sum + w[k], 0);
    for (const k of PARTS) shares[k].textContent = total > 0 ? `${Math.round((w[k] / total) * 100)}%` : '–';
  };
  for (const k of PARTS) {
    const range = input({ type: 'range', min: '0', max: '100', step: '5' });
    range.value = String(prefs.weights[k]);
    range.addEventListener('input', paint);
    sliders[k] = range;
    shares[k] = el('span', 'life-num life-score__share');
    const row = el('div', 'life-score__slider');
    row.append(field(`life.score.${k}`, range, 'life-field--grow'), shares[k]);
    form.append(row);
  }
  const target = input({ type: 'number', min: '0.5', max: '16', step: '0.5' });
  target.value = String(prefs.focusTargetH);
  const go = el('button', 'pad-send life-btn', t('life.save'));
  go.type = 'submit';
  const row = el('div', 'life-form__row');
  row.append(field('life.score.target', target), go);
  form.append(row);
  paint();
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    go.disabled = true;
    await setScorePrefs(weightsOf(Object.fromEntries(PARTS.map((k) => [k, sliders[k].value]))), Number(target.value));
    go.disabled = false;
  });
  card.body.append(el('p', 'hint', t('life.score.settingsHint')), form);
  return card.sec;
}
