// ============================================================================
// LunaCore - Mission Control: "Focus this week" block (renderer)
// ----------------------------------------------------------------------------
// Lives inside the Telemetry widget, under "Where Claude went", and renders
// report.focus from the same mission:ledger call (no extra IPC, no model
// call). A real <table>: rows = top projects, columns = Mon-Sun, a cell's
// heat level comes from missionfocusview.js. Exact time is in each cell's
// title and in hidden text, so the heat colour is never the only signal.
// ============================================================================

'use strict';

import { t } from './util.js';
import { focusView } from './missionfocusview.js';

const lang = () => (window.i18n && window.i18n.lang) || 'pl';

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** 95 min -> "1:35 h"; under an hour -> "35 min". */
export function hm(ms) {
  const mins = Math.round(ms / 60000);
  if (mins < 60) return t('mc.focus.min', { n: mins });
  return t('mc.focus.h', { h: Math.floor(mins / 60), m: String(mins % 60).padStart(2, '0') });
}

/** 330 min -> "5:30" for the narrow day columns. */
const clock = (ms) => {
  const mins = Math.round(ms / 60000);
  return `${Math.floor(mins / 60)}:${String(mins % 60).padStart(2, '0')}`;
};

const weekday = (ms) => new Intl.DateTimeFormat(lang(), { weekday: 'short' }).format(new Date(ms));
const longDay = (ms) => new Intl.DateTimeFormat(lang(), { weekday: 'long', day: 'numeric', month: 'short' }).format(new Date(ms));

function headRow(view) {
  const tr = el('tr');
  const corner = el('th', 'mc-focus__corner');
  corner.scope = 'col';
  corner.append(el('span', 'mc-sr', t('mc.focus.project')));
  tr.append(corner);
  for (const d of view.days) {
    const th = el('th', d.isToday ? 'mc-focus__day is-today' : 'mc-focus__day', weekday(d.start));
    th.scope = 'col';
    th.title = longDay(d.start);
    tr.append(th);
  }
  const sum = el('th', 'mc-focus__sum', t('mc.focus.sum'));
  sum.scope = 'col';
  tr.append(sum);
  return tr;
}

function projectRow(r) {
  const tr = el('tr');
  const th = el('th', 'mc-focus__name');
  th.scope = 'row';
  th.title = `${r.name} · ${t(`mc.ledger.cls.${r.cls}`)}`;
  th.append(el('span', `mc-ledger__swatch mc-ledger__seg--${r.cls}`), el('span', 'mc-focus__label', r.name));
  tr.append(th);
  for (const c of r.cells) {
    const td = el('td', 'mc-focus__cellwrap');
    const sq = el('span', c.isFuture ? 'mc-tele__cell mc-focus__cell is-future' : 'mc-tele__cell mc-focus__cell');
    if (!c.isFuture) {
      sq.dataset.level = String(c.level);
      td.title = `${longDay(c.start)}: ${c.ms ? hm(c.ms) : '-'}`;
      td.append(sq, el('span', 'mc-sr', c.ms ? hm(c.ms) : '-'));
    } else {
      td.append(sq);
    }
    tr.append(td);
  }
  tr.append(el('td', 'mc-focus__sum', hm(r.totalMs)));
  return tr;
}

/** Bottom rows: wall-clock hours per day, then context switches per day. */
function footRows(view) {
  const hours = el('tr', 'mc-focus__foot');
  const switches = el('tr', 'mc-focus__foot');
  const hTh = el('th', 'mc-focus__name', t('mc.focus.perDay'));
  hTh.scope = 'row';
  const sTh = el('th', 'mc-focus__name', t('mc.focus.switches'));
  sTh.scope = 'row';
  sTh.title = t('mc.focus.switchesHint');
  hours.append(hTh);
  switches.append(sTh);
  for (const d of view.days) {
    hours.append(el('td', 'mc-focus__num', d.isFuture || !d.totalMs ? '' : clock(d.totalMs)));
    switches.append(el('td', 'mc-focus__num', d.isFuture || !d.totalMs ? '' : String(d.switches)));
  }
  hours.append(el('td', 'mc-focus__sum', hm(view.totalMs)));
  switches.append(el('td', 'mc-focus__sum', ''));
  return [hours, switches];
}

/**
 * The Focus block's nodes for `focus` (report.focus), or [] before the first report.
 * @param {object|null|undefined} focus
 * @returns {Node[]}
 */
export function renderFocus(focus) {
  const view = focusView(focus, Date.now());
  if (!view) return [];
  if (!view.rows.length) return [el('p', 'hint', t('mc.focus.empty'))];

  const summary = el('p', 'mc-tele__stat');
  const today = view.today ? t('mc.focus.today', { time: hm(view.today.totalMs), n: view.today.switches }) : '';
  summary.textContent = [t('mc.focus.week', { time: hm(view.totalMs) }), today].filter(Boolean).join(' · ');

  const table = el('table', 'mc-focus__grid');
  table.append(el('caption', 'mc-sr', t('mc.focus.caption')));
  const thead = el('thead');
  thead.append(headRow(view));
  const tbody = el('tbody');
  for (const r of view.rows) tbody.append(projectRow(r));
  const tfoot = el('tfoot');
  tfoot.append(...footRows(view));
  table.append(thead, tbody, tfoot);

  const wrap = el('div', 'mc-focus__scroll');
  wrap.append(table);
  const out = [summary, wrap];
  if (view.restCount) out.push(el('p', 'mc-tele__stat', t('mc.focus.rest', { n: view.restCount, time: hm(view.restMs) })));
  out.push(el('p', 'hint', t('mc.focus.note')));
  return out;
}
