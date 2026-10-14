// ============================================================================
// LunaCore - Life dashboard: Overview tab (renderer)
// ----------------------------------------------------------------------------
// Answers "can I go to the cinema this month?": free money left (+ per day)
// up top, then where the income went - five KPI cards (income, fixed bills,
// savings, planned envelopes, free spending), a donut of the same split, the
// envelopes against their plan and usual spend, free spending by category and
// the bills still to pay. Every number is printed as text; colour only
// repeats it.
// ============================================================================

'use strict';

import { t } from './util.js';
import { el, bucket, button, bar, money, money0, pct, shortDate, catName, catColor } from './lifeui.js';
import { donut } from './lifecharts.js';

const BUCKET_COLOR = {
  fixed: 'var(--life-fixed)',
  savings: 'var(--life-savings)',
  planned: 'var(--life-planned)',
  free: 'var(--life-free)',
  left: 'var(--life-left)',
};
const UPCOMING_MAX = 5;

function hero(s) {
  const box = el('section', 'life-hero');
  box.setAttribute('aria-label', t('life.ov.left'));
  box.append(el('p', 'life-hero__label', t(s.period.isPast ? 'life.ov.leftPast' : 'life.ov.left')));
  box.append(el('p', `life-hero__big${s.left < 0 ? ' is-bad' : ''}`, money(s.left)));
  if (s.left < 0) box.append(el('p', 'life-hero__warn', t('life.ov.over')));
  else if (s.period.isCurrent) {
    box.append(el('p', 'life-hero__sub', t('life.ov.perDay', { perDay: money(s.free.perDay), days: s.period.daysLeft, end: shortDate(s.period.end) })));
  }
  box.append(
    el(
      'p',
      'life-hero__math',
      t('life.ov.math', {
        income: money0(s.income.amount),
        fixed: money0(s.fixed.committed),
        savings: money0(s.savings.committed),
        planned: money0(s.planned.reserved),
        free: money0(s.free.spent),
      })
    )
  );
  if (!s.income.amount) box.append(el('p', 'hint', t('life.ov.noIncome')));
  return box;
}

function kpi(key, value, sub, color) {
  const card = el('div', 'life-kpi');
  const head = el('span', 'life-kpi__label');
  if (color) {
    const dot = el('span', 'life-dot');
    dot.style.background = color;
    head.append(dot);
  }
  head.append(document.createTextNode(t(`life.bucket.${key}`)));
  card.append(head, el('span', 'life-kpi__value life-num', money0(value)));
  if (sub) card.append(el('span', 'life-kpi__sub', sub));
  return card;
}

function kpis(s) {
  const row = el('div', 'life-kpis');
  row.append(
    kpi('income', s.income.amount, t('life.ov.payday', { day: s.income.payday })),
    kpi('fixed', s.fixed.committed, t('life.ov.paidOf', { paid: money0(s.fixed.actual), plan: money0(s.fixed.plan) }), BUCKET_COLOR.fixed),
    kpi('savings', s.savings.committed, t('life.ov.totalSaved', { amount: money0(s.totalSaved) }), BUCKET_COLOR.savings),
    kpi('planned', s.planned.reserved, t('life.ov.spentOf', { spent: money0(s.planned.spent), plan: money0(s.planned.plan) }), BUCKET_COLOR.planned),
    kpi('free', s.free.spent, t('life.ov.freePlan', { amount: money0(Math.max(0, s.free.plan)) }), BUCKET_COLOR.free)
  );
  return row;
}

function split(s) {
  const card = bucket('life.ov.split', 'life-bucket--split');
  const slices = s.donut.map((d) => ({ ...d, label: `${t(`life.bucket.${d.key}`)}: ${money(d.amount)}`, color: BUCKET_COLOR[d.key] }));
  const base = s.income.amount || slices.reduce((sum, x) => sum + x.amount, 0);
  const chart = donut(slices, {
    center: money0(s.left),
    sub: t('life.ov.leftShort'),
    label: slices.map((x) => x.label).join(', '),
  });
  const legend = el('ul', 'life-legend');
  for (const x of slices) {
    const li = el('li', 'life-legend__row');
    const dot = el('span', 'life-dot');
    dot.style.background = x.color;
    li.append(
      dot,
      el('span', 'life-legend__name', t(`life.bucket.${x.key}`)),
      el('span', 'life-num', money0(x.amount)),
      el('span', 'life-num life-legend__pct', base > 0 ? pct((x.amount / base) * 100) : '–')
    );
    legend.append(li);
  }
  const wrap = el('div', 'life-split');
  wrap.append(chart, legend);
  card.body.append(wrap);
  return card.sec;
}

function envelopeNote(e) {
  if (e.status === 'over') return { cls: 'is-bad', text: t('life.env.over', { amount: money(-e.left) }) };
  if (e.status === 'pace') return { cls: 'is-warn', text: t('life.env.pace', { amount: money(e.projected) }) };
  return { cls: '', text: t('life.env.left', { amount: money(e.left) }) };
}

function envelope(e) {
  const li = el('li', 'life-env');
  const head = el('div', 'life-cat__head');
  const name = el('span', 'life-cat__name');
  const dot = el('span', 'life-dot');
  dot.style.background = catColor(e.id);
  name.append(dot, document.createTextNode(catName(e)));
  head.append(name, el('span', 'life-num', `${money0(e.spent)} / ${money0(e.plan)}`));
  const cls = { over: 'is-bad', pace: 'is-warn' }[e.status] || '';
  const track = bar(e.plan > 0 ? e.spent / e.plan : e.spent > 0 ? 1 : 0, cls, cls ? '' : catColor(e.id));
  // Where the usual spend sits on the plan: a thin marker, explained in text.
  if (e.usual && e.plan > 0) {
    const mark = el('span', 'life-bar__mark');
    mark.style.setProperty('--u', String(Math.min(1, e.usual / e.plan)));
    track.append(mark);
  }
  const note = envelopeNote(e);
  const meta = el('div', 'life-env__meta');
  meta.append(el('span', `life-cat__note ${note.cls}`.trim(), note.text));
  if (e.usual) {
    const vs = e.vsUsual === 0 ? t('life.trend.same') : `${e.vsUsual > 0 ? '▲' : '▼'} ${Math.abs(e.vsUsual)}%`;
    meta.append(el('span', 'life-cat__note', t('life.env.usual', { amount: money0(e.usual), vs })));
  }
  li.append(head, track, meta);
  return li;
}

function envelopes(s, goTab) {
  const card = bucket('life.ov.envelopes');
  if (!s.envelopes.length) {
    card.body.append(el('p', 'hint', t('life.ov.noEnvelopes')), button('life.tab.settings', () => goTab('settings')));
    return card.sec;
  }
  const list = el('ul', 'life-list');
  for (const e of s.envelopes) list.append(envelope(e));
  card.body.append(list);
  return card.sec;
}

function freeSpending(s) {
  const card = bucket('life.ov.freeTitle');
  const rows = s.free.rows.filter((r) => r.spent > 0).sort((a, b) => b.spent - a.spent);
  if (!rows.length) {
    card.body.append(el('p', 'hint', t('life.ov.noFree')));
    return card.sec;
  }
  const max = rows[0].spent;
  const list = el('ul', 'life-list');
  for (const r of rows) {
    const li = el('li', 'life-cat');
    const head = el('div', 'life-cat__head');
    const name = el('span', 'life-cat__name');
    const dot = el('span', 'life-dot');
    dot.style.background = catColor(r.id);
    name.append(dot, document.createTextNode(catName(r)));
    head.append(name, el('span', 'life-num', money(r.spent)));
    li.append(head, bar(r.spent / max, '', catColor(r.id)));
    list.append(li);
  }
  card.body.append(list, el('p', 'life-total', t('life.ov.freeTotal', { amount: money(s.free.spent) })));
  return card.sec;
}

function upcoming(s, goTab) {
  const card = bucket('life.ov.upcoming');
  const due = s.bills.filter((b) => b.status !== 'paid');
  if (!due.length) {
    card.body.append(el('p', 'hint', t(s.bills.length ? 'life.ov.allPaid' : 'life.bills.none')));
    return card.sec;
  }
  const list = el('ul', 'life-list');
  for (const b of due.slice(0, UPCOMING_MAX)) {
    const li = el('li', `life-row life-row--plain life-bill is-${b.status}`);
    const text = el('div', 'life-row__text');
    const meta = el('span', 'life-row__meta');
    meta.append(el('span', `life-chip life-chip--${b.status}`, t(`life.bills.status.${b.status}`)), document.createTextNode(` ${shortDate(b.dueDate)}`));
    text.append(el('span', 'life-row__title', b.name), meta);
    li.append(text, el('span', 'life-num', money(b.expected)));
    list.append(li);
  }
  const total = due.reduce((sum, b) => sum + b.expected, 0);
  card.body.append(list, el('p', 'life-total', t('life.ov.dueTotal', { n: due.length, amount: money(total) })), button('life.ov.toBills', () => goTab('bills')));
  return card.sec;
}

/** Rebuilds the Overview into `root`; `goTab(id)` switches tabs. */
export function renderOverview(root, state, goTab) {
  const s = state.summary;
  const top = el('div', 'life-ov__top');
  top.append(hero(s), split(s));
  const grid = el('div', 'life-grid');
  grid.append(envelopes(s, goTab), freeSpending(s), upcoming(s, goTab));
  root.replaceChildren(top, kpis(s), grid);
}
