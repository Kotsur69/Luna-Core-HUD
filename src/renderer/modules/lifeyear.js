// ============================================================================
// LunaCore - Life dashboard: Year tab (renderer)
// ----------------------------------------------------------------------------
// The whole year at once (src/lifebudgetyear.js does the math): its own
// ◀ year ▶ switch, KPI cards (income, spent, saved + savings rate, left
// over, monthly average), the twelve periods as stacked bars under the
// income line (with a table), spend per category with its monthly average
// and the same months last year beside it, quick insights (best and worst
// period, busiest weekday, how bills were paid), spend per weekday and the
// biggest single expenses. Periods before the app was used and future ones
// show as empty and never count. Every number is printed as text.
// ============================================================================

'use strict';

import { t } from './util.js';
import {
  el, bucket, bar, iconButton, money, money0, pct, trend, shortDate, monthLabel, lang, catName, catById, catColor, setMonth,
} from './lifeui.js';
import { stackedBars } from './lifecharts.js';

const SERIES = ['fixed', 'savings', 'planned', 'free'];

// --- year switch ----------------------------------------------------------------

function yearSwitch(s) {
  const y = s.year.year;
  const mm = s.month.slice(5);
  const go = (n) => () => setMonth(`${y + n}-${mm}`);
  const box = el('div', 'life-month life-year__switch');
  const label = el('span', 'life-month__label');
  label.append(el('span', 'life-month__name', String(y)), el('span', 'life-month__range', t('life.yr.counted', { n: s.year.totals.months })));
  box.append(iconButton('◀', 'life.yr.prev', go(-1)), label, iconButton('▶', 'life.yr.next', go(1)));
  if (!s.year.isCurrent) {
    const back = el('button', 'life-btn', t('life.yr.thisYear'));
    back.type = 'button';
    back.addEventListener('click', () => setMonth(null));
    box.append(back);
  }
  return box;
}

// --- KPI cards ------------------------------------------------------------------

function kpi(labelKey, value, sub, cls = '') {
  const card = el('div', 'life-kpi');
  card.append(el('span', 'life-kpi__label', t(labelKey)), el('span', `life-kpi__value life-num ${cls}`.trim(), value));
  if (sub) card.append(sub instanceof Node ? sub : el('span', 'life-kpi__sub', sub));
  return card;
}

function vsLastYear(now, before) {
  const sub = el('span', 'life-kpi__sub');
  const change = trend(now, before);
  sub.append(el('span', change.cls, change.text), document.createTextNode(` ${t('life.yr.vsLast', { amount: money0(before) })}`));
  return sub;
}

function kpis(y) {
  const tt = y.totals;
  const row = el('div', 'life-kpis');
  row.append(
    kpi('life.bucket.income', money0(tt.income), t('life.yr.monthsN', { n: tt.months })),
    kpi('life.yr.spent', money0(tt.spent), y.prev ? vsLastYear(tt.spent, y.prev.spent) : t('life.yr.perMonth', { amount: money0(tt.avgSpent) })),
    kpi('life.yr.saved', money0(tt.savings), tt.savingsRate === null ? '' : t('life.yr.rate', { pct: pct(tt.savingsRate) }), 'is-good'),
    kpi('life.yr.net', money0(tt.net), t('life.yr.netHint'), tt.net < 0 ? 'is-bad' : ''),
    kpi('life.yr.avg', money0(tt.avgSpent), t('life.yr.avgFree', { amount: money0(tt.avgFree) }))
  );
  return row;
}

// --- months chart -----------------------------------------------------------------

function monthsTable(rows) {
  const box = el('details', 'life-details');
  box.append(el('summary', '', t('life.sp.table')));
  const table = el('table', 'life-table');
  const head = el('tr');
  for (const key of ['life.sp.month', ...SERIES.map((k) => `life.bucket.${k}`), 'life.yr.net']) head.append(el('th', '', t(key)));
  table.append(head);
  for (const r of rows.filter((x) => x.active)) {
    const tr = el('tr');
    tr.append(el('td', '', monthLabel(r.month, 'long')));
    for (const k of SERIES) tr.append(el('td', 'life-num', money0(r[k])));
    tr.append(el('td', `life-num${r.net < 0 ? ' is-bad' : ''}`, money0(r.net)));
    table.append(tr);
  }
  box.append(table);
  return box;
}

function legendFor(series, income) {
  const legend = el('ul', 'life-legend life-legend--inline');
  for (const x of series) {
    const li = el('li', 'life-legend__row');
    const dot = el('span', 'life-dot');
    dot.style.background = x.color;
    li.append(dot, el('span', '', x.label));
    legend.append(li);
  }
  if (income) {
    const li = el('li', 'life-legend__row');
    li.append(el('span', 'life-legend__line'), el('span', '', t('life.sp.incomeLine', { amount: money0(income) })));
    legend.append(li);
  }
  return legend;
}

function monthsCard(s) {
  const y = s.year;
  const card = bucket('life.yr.monthsTitle');
  if (!y.totals.months) {
    card.body.append(el('p', 'hint', t('life.yr.empty')));
    return card.sec;
  }
  const series = SERIES.map((key) => ({ key, color: `var(--life-${key})`, label: t(`life.bucket.${key}`) }));
  const fmtMonth = new Intl.DateTimeFormat(lang(), { month: 'short' });
  const rows = y.rows.map((r) => {
    const [yy, mm] = r.month.split('-').map(Number);
    return { label: fmtMonth.format(new Date(yy, mm - 1, 1)), values: r };
  });
  const chart = stackedBars(rows, series, {
    line: s.income.amount,
    fmt: money0,
    highlight: y.rows.findIndex((r) => r.state === 'current'),
    label: t('life.yr.chartLabel', { year: y.year }),
  });
  card.body.append(chart, legendFor(series, s.income.amount), monthsTable(y.rows));
  return card.sec;
}

// --- categories -------------------------------------------------------------------

function categoryLine(r, hasPrev) {
  const li = el('li', 'life-share');
  const head = el('div', 'life-cat__head');
  const name = el('span', 'life-cat__name');
  const dot = el('span', 'life-dot');
  dot.style.background = catColor(r.id);
  name.append(dot, document.createTextNode(catName(catById(r.id))));
  const nums = el('span', 'life-share__nums');
  nums.append(el('span', 'life-num life-share__pct', pct(r.pct)), el('span', 'life-num', money0(r.amount)));
  head.append(name, nums);
  const meta = el('span', 'life-cat__note');
  meta.append(document.createTextNode(t('life.yr.perMonth', { amount: money0(r.perMonth) })));
  if (hasPrev) {
    const change = trend(r.amount, r.prev);
    meta.append(document.createTextNode(` · ${t('life.yr.lastYear', { amount: money0(r.prev) })} `), el('span', change.cls, change.text));
  }
  li.append(head, bar(r.pct / 100, '', catColor(r.id)), meta);
  return li;
}

function categoriesCard(y) {
  const card = bucket('life.yr.cats');
  const rows = y.categories.filter((r) => r.amount > 0);
  if (!rows.length) {
    card.body.append(el('p', 'hint', t('life.sp.none')));
    return card.sec;
  }
  const list = el('ul', 'life-list');
  for (const r of rows) list.append(categoryLine(r, Boolean(y.prev)));
  card.body.append(list);
  return card.sec;
}

// --- insights -----------------------------------------------------------------------

function weekdayName(i) {
  // 2026-10-12 is a Monday.
  return new Intl.DateTimeFormat(lang(), { weekday: 'long' }).format(new Date(2026, 9, 12 + i));
}

function fact(labelKey, value, note = '', cls = '') {
  const li = el('li', 'life-fact');
  li.append(el('span', 'life-fact__label', t(labelKey)), el('span', `life-fact__value life-num ${cls}`.trim(), value));
  if (note) li.append(el('span', 'life-fact__note', note));
  return li;
}

function insightsCard(y) {
  const card = bucket('life.yr.insights');
  const list = el('ul', 'life-facts');
  const rowOf = (m) => y.rows.find((r) => r.month === m);
  if (y.bestMonth) list.append(fact('life.yr.best', monthLabel(y.bestMonth, 'long'), t('life.yr.leftOver', { amount: money0(rowOf(y.bestMonth).net) }), 'is-good'));
  if (y.worstMonth) list.append(fact('life.yr.worst', monthLabel(y.worstMonth, 'long'), t('life.yr.spentIn', { amount: money0(rowOf(y.worstMonth).spent) }), 'is-warn'));
  const maxDay = Math.max(...y.weekdays);
  if (maxDay > 0) list.append(fact('life.yr.busiestDay', weekdayName(y.weekdays.indexOf(maxDay)), t('life.yr.dayTotal', { amount: money0(maxDay) })));
  const b = y.bills;
  if (b.paid) {
    list.append(fact('life.yr.billsPaid', `${b.onTime} / ${b.paid}`, t('life.yr.onTime', { pct: pct(Math.round((b.onTime / b.paid) * 100)) })));
    if (b.diff) list.append(fact('life.yr.billsDiff', money(b.diff), t(b.diff < 0 ? 'life.yr.billsCheaper' : 'life.yr.billsDearer'), b.diff < 0 ? 'is-good' : 'is-warn'));
  }
  if (b.unpaidPastDue) list.append(fact('life.yr.unpaid', String(b.unpaidPastDue), t('life.yr.unpaidHint'), 'is-bad'));
  card.body.append(list.children.length ? list : el('p', 'hint', t('life.yr.notEnough')));
  return card.sec;
}

function weekdaysCard(y) {
  const card = bucket('life.yr.weekdays');
  const max = Math.max(...y.weekdays);
  if (!(max > 0)) {
    card.body.append(el('p', 'hint', t('life.sp.none')));
    return card.sec;
  }
  const list = el('ul', 'life-list');
  y.weekdays.forEach((amount, i) => {
    const li = el('li', 'life-cat');
    const head = el('div', 'life-cat__head');
    head.append(el('span', 'life-cat__name', weekdayName(i)), el('span', 'life-num', money0(amount)));
    li.append(head, bar(amount / max, '', amount === max ? 'var(--life-free)' : 'var(--life-planned)'));
    list.append(li);
  });
  card.body.append(list, el('p', 'hint', t('life.sp.weekHint')));
  return card.sec;
}

function topCard(y) {
  const card = bucket('life.yr.top');
  if (!y.top.length) {
    card.body.append(el('p', 'hint', t('life.sp.none')));
    return card.sec;
  }
  const list = el('ul', 'life-list');
  for (const e of y.top) {
    const li = el('li', 'life-row life-row--plain');
    const text = el('div', 'life-row__text');
    const cat = catName(catById(e.category));
    text.append(el('span', 'life-row__title', e.note || cat), el('span', 'life-row__meta', `${cat} · ${shortDate(e.date)}`));
    li.append(text, el('span', 'life-num', money(e.amount)));
    list.append(li);
  }
  card.body.append(list);
  return card.sec;
}

/** Rebuilds the Year tab into `root`. */
export function renderYear(root, state) {
  const s = state.summary;
  const y = s.year;
  const left = el('div', 'life-stack');
  left.append(monthsCard(s), categoriesCard(y));
  const right = el('div', 'life-stack');
  right.append(insightsCard(y), weekdaysCard(y), topCard(y));
  const grid = el('div', 'life-grid life-grid--2');
  grid.append(left, right);
  root.replaceChildren(yearSwitch(s), kpis(y), grid);
}
