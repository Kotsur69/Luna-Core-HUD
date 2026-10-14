// ============================================================================
// LunaCore - Life dashboard: Spending tab (renderer)
// ----------------------------------------------------------------------------
// "What goes where": this week or this budget period split by category, each
// as a % bar with the previous week / period beside it (arrow + %, never
// colour alone), then the trend - up to 12 periods as stacked bars (fixed,
// savings, planned, free) under a dashed income line, with the same numbers
// in a table for anyone who wants them exact.
// ============================================================================

'use strict';

import { t } from './util.js';
import { el, bucket, bar, money, money0, pct, trend, shortDate, monthLabel, catName, catById, catColor } from './lifeui.js';
import { stackedBars } from './lifecharts.js';

const SERIES = ['fixed', 'savings', 'planned', 'free'];
let range = 'month'; // 'week' | 'month', kept across re-renders

function rangeToggle(onChange) {
  const box = el('div', 'life-seg');
  box.setAttribute('role', 'radiogroup');
  box.setAttribute('aria-label', t('life.sp.range'));
  for (const key of ['week', 'month']) {
    const b = el('button', `life-seg__btn${range === key ? ' is-on' : ''}`, t(`life.sp.${key}`));
    b.type = 'button';
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(range === key));
    b.addEventListener('click', () => {
      range = key;
      onChange();
    });
    box.append(b);
  }
  return box;
}

function shareRow(r) {
  const li = el('li', 'life-share');
  const head = el('div', 'life-cat__head');
  const name = el('span', 'life-cat__name');
  const dot = el('span', 'life-dot');
  dot.style.background = catColor(r.id);
  name.append(dot, document.createTextNode(catName(r.id.startsWith('_') ? { id: r.id } : catById(r.id))));
  const nums = el('span', 'life-share__nums');
  nums.append(el('span', 'life-num life-share__pct', pct(r.pct)), el('span', 'life-num', money(r.amount)));
  head.append(name, nums);
  const change = trend(r.amount, r.prev || 0);
  const meta = el('span', 'life-cat__note');
  meta.append(
    document.createTextNode(t(range === 'week' ? 'life.sp.prevWeek' : 'life.sp.prevMonth', { amount: money(r.prev || 0) })),
    document.createTextNode(' · '),
    el('span', change.cls, change.text)
  );
  li.append(head, bar(r.pct / 100, '', catColor(r.id)), meta);
  return li;
}

function shares(s, rerender) {
  const card = bucket('life.sp.where');
  const data = s.breakdown[range];
  const head = el('div', 'life-sp__head');
  const when =
    range === 'week' ? t('life.sp.weekOf', { date: shortDate(data.start) }) : t('life.sp.periodOf', { start: shortDate(s.period.start), end: shortDate(s.period.end) });
  const total = el('div', 'life-sp__total');
  const change = trend(data.total, data.prevTotal);
  total.append(el('span', 'life-sp__big life-num', money(data.total)), el('span', `life-cat__note ${change.cls}`.trim(), `${change.text} · ${when}`));
  head.append(total, rangeToggle(rerender));
  card.body.append(head);
  if (!data.rows.length) {
    card.body.append(el('p', 'hint', t('life.sp.none')));
    return card.sec;
  }
  const list = el('ul', 'life-list');
  for (const r of data.rows) list.append(shareRow(r));
  card.body.append(list);
  if (range === 'week') card.body.append(el('p', 'hint', t('life.sp.weekHint')));
  return card.sec;
}

function trendTable(rows) {
  const box = el('details', 'life-details');
  box.append(el('summary', '', t('life.sp.table')));
  const table = el('table', 'life-table');
  const head = el('tr');
  for (const key of ['life.sp.month', ...SERIES.map((k) => `life.bucket.${k}`), 'life.sp.total']) head.append(el('th', '', t(key)));
  table.append(head);
  for (const r of rows) {
    const tr = el('tr');
    tr.append(el('td', '', monthLabel(r.month, 'long')));
    for (const k of SERIES) tr.append(el('td', 'life-num', money0(r[k])));
    tr.append(el('td', 'life-num', money0(SERIES.reduce((sum, k) => sum + r[k], 0))));
    table.append(tr);
  }
  box.append(table);
  return box;
}

function trendCard(s) {
  const card = bucket('life.sp.trend');
  if (!s.trend.length) {
    card.body.append(el('p', 'hint', t('life.sp.noTrend')));
    return card.sec;
  }
  const series = SERIES.map((key) => ({ key, color: `var(--life-${key})`, label: t(`life.bucket.${key}`) }));
  const rows = s.trend.map((r) => ({ label: monthLabel(r.month), values: r }));
  const chart = stackedBars(rows, series, {
    line: s.income.amount,
    fmt: money0,
    highlight: s.trend.findIndex((r) => r.month === s.month),
    label: t('life.sp.trendLabel', { n: rows.length }),
  });
  const legend = el('ul', 'life-legend life-legend--inline');
  for (const x of series) {
    const li = el('li', 'life-legend__row');
    const dot = el('span', 'life-dot');
    dot.style.background = x.color;
    li.append(dot, el('span', '', x.label));
    legend.append(li);
  }
  if (s.income.amount) {
    const li = el('li', 'life-legend__row');
    li.append(el('span', 'life-legend__line'), el('span', '', t('life.sp.incomeLine', { amount: money0(s.income.amount) })));
    legend.append(li);
  }
  card.body.append(chart, legend, trendTable(s.trend));
  return card.sec;
}

/** Rebuilds the Spending tab into `root`. */
export function renderSpending(root, state) {
  const draw = () => {
    const grid = el('div', 'life-grid life-grid--2');
    grid.append(shares(state.summary, draw), trendCard(state.summary));
    root.replaceChildren(grid);
  };
  draw();
}
