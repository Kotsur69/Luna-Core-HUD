// ============================================================================
// LunaCore - Mission Control: "Focus this week" block (renderer)
// ----------------------------------------------------------------------------
// Lives inside the Telemetry widget, under "Where Claude went", and renders
// report.focus from the same mission:ledger call (no extra IPC, no model
// call). Three headline tiles (week, today, switches today), then a real
// <table>: rows = top projects with a share bar, columns = Mon-Sun. Each
// cell prints its time on a heat tile (level from missionfocusview.js), so
// the colour is never the only signal; screen readers get the spelled-out time.
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
    const th = el('th', d.isToday ? 'mc-focus__day is-today' : 'mc-focus__day', weekday(d.start).replace('.', ''));
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
  const label = el('span', 'mc-focus__labelline');
  label.append(el('span', `mc-ledger__swatch mc-ledger__seg--${r.cls}`), el('span', 'mc-focus__label', r.name));
  // Share of the busiest project; decorative (the Total column has the number).
  const bar = el('span', 'mc-focus__bar');
  bar.setAttribute('aria-hidden', 'true');
  const fill = el('span', `mc-focus__barfill mc-ledger__seg--${r.cls}`);
  fill.style.width = `${Math.round(r.share * 100)}%`;
  bar.append(fill);
  th.append(label, bar);
  tr.append(th);
  for (const c of r.cells) tr.append(dayCell(c));
  tr.append(el('td', 'mc-focus__sum mc-focus__total', hm(r.totalMs)));
  return tr;
}

/** One project-day: the time itself on a heat tile ("4:12"), blank for the future. */
function dayCell(c) {
  const td = el('td', c.isToday ? 'mc-focus__cellwrap is-today' : 'mc-focus__cellwrap');
  if (c.isFuture) {
    td.append(el('span', 'mc-focus__cell is-future'));
    return td;
  }
  const tile = el('span', 'mc-focus__cell', c.ms ? clock(c.ms) : '·');
  tile.dataset.level = String(c.level);
  // The tile text is visual shorthand; screen readers get the spelled-out time.
  tile.setAttribute('aria-hidden', 'true');
  td.title = `${longDay(c.start)}: ${c.ms ? hm(c.ms) : '-'}`;
  td.append(tile, el('span', 'mc-sr', c.ms ? hm(c.ms) : '-'));
  return td;
}

/** The three headline numbers above the grid. */
function statTiles(view) {
  const box = el('div', 'mc-focus__stats');
  const tile = (labelKey, value, extra = '') => {
    const d = el('div', `mc-focus__stat${extra}`);
    d.append(el('span', 'mc-focus__statvalue', value), el('span', 'mc-focus__statlabel', t(labelKey)));
    return d;
  };
  box.append(
    tile('mc.focus.statWeek', hm(view.totalMs)),
    tile('mc.focus.statToday', view.today ? hm(view.today.totalMs) : '-', ' is-today'),
    tile('mc.focus.statSwitches', view.today ? String(view.today.switches) : '-')
  );
  return box;
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
    const cls = d.isToday ? 'mc-focus__num is-today' : 'mc-focus__num';
    hours.append(el('td', cls, d.isFuture || !d.totalMs ? '' : clock(d.totalMs)));
    switches.append(el('td', cls, d.isFuture || !d.totalMs ? '' : String(d.switches)));
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
  const out = [statTiles(view), wrap];
  if (view.restCount) out.push(el('p', 'mc-focus__rest', t('mc.focus.rest', { n: view.restCount, time: hm(view.restMs) })));
  // The method note is for the curious: folded, so it does not compete with the numbers.
  const how = el('details', 'mc-focus__how');
  how.append(el('summary', '', t('mc.focus.how')), el('p', 'hint', t('mc.focus.note')));
  out.push(how);
  return out;
}
