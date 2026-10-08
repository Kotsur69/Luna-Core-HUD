// ============================================================================
// LunaCore - Mission Control: calendar month grid
// ----------------------------------------------------------------------------
// Pure DOM building for the calendar widget's Month view: no state, no IPC.
// missioncalendar.js owns the loaded months and the selected day and calls
// buildMonthGrid() whenever either changes.
//
// Weeks start on Monday. Days outside the month are shown (dimmed) so every
// row is a full week, but they carry no events: only the month itself was
// fetched, and an empty-looking neighbour day would be a lie.
// ============================================================================

'use strict';

import { t } from './util.js';

const MAX_PER_CELL = 3;
// Any Monday; only its weekday names are used.
const A_MONDAY = new Date(2024, 0, 1);

const pad = (n) => String(n).padStart(2, '0');

/** 'YYYY-MM-DD' of a Date in local time. */
export const dateKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** 'YYYY-MM' of a Date in local time. */
export const monthKeyOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;

/** First day of a 'YYYY-MM' month, local midnight. */
const firstDay = (monthKey) => new Date(Number(monthKey.slice(0, 4)), Number(monthKey.slice(5, 7)) - 1, 1);

/** 'YYYY-MM' moved by whole months. */
export function shiftMonth(monthKey, delta) {
  const d = firstDay(monthKey);
  d.setMonth(d.getMonth() + delta);
  return monthKeyOf(d);
}

/** 'YYYY-MM-DD' moved by whole days (calendar arithmetic, no time zone). */
export function shiftDate(value, days) {
  const d = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return value;
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Local day key of an event's start. */
export const startDay = (ev) => (ev.allDay ? ev.start.slice(0, 10) : dateKey(new Date(ev.start)));

/**
 * Day key -> events on that day. An all-day event covers every day from its
 * start up to its (exclusive) end, so a trackday weekend shows on both days;
 * a timed event sits on the day it starts.
 */
export function eventsByDay(events) {
  const days = new Map();
  const put = (key, ev) => days.set(key, [...(days.get(key) || []), ev]);
  for (const ev of events) {
    if (!ev.allDay) {
      put(startDay(ev), ev);
      continue;
    }
    const last = ev.end > ev.start ? shiftDate(ev.end, -1) : ev.start;
    // Bounded: a malformed year-long range must not lock the renderer.
    for (let key = ev.start, n = 0; key <= last && n < 62; key = shiftDate(key, 1), n++) put(key, ev);
  }
  return days;
}

/** "HH:mm" of a timed event, '' for all-day. */
const timeOf = (ev) => (ev.allDay ? '' : new Date(ev.start).toTimeString().slice(0, 5));

function weekdayHeader(lang) {
  const row = document.createElement('div');
  row.className = 'mc-month__weekdays';
  row.setAttribute('aria-hidden', 'true');
  for (let i = 0; i < 7; i++) {
    const d = new Date(A_MONDAY);
    d.setDate(d.getDate() + i);
    const span = document.createElement('span');
    span.textContent = d.toLocaleDateString(lang, { weekday: 'short' });
    row.append(span);
  }
  return row;
}

function cellEvent(ev, colorOf) {
  const span = document.createElement('span');
  span.className = 'mc-month__ev';
  const color = colorOf(ev);
  if (color) span.style.setProperty('--mc-cat', color);
  const time = timeOf(ev);
  span.textContent = time ? `${time} ${ev.title}` : ev.title;
  return span;
}

function dayCell(day, { inMonth, events, isToday, isSelected, lang, colorOf, onSelect }) {
  const key = dateKey(day);
  const cell = document.createElement('button');
  cell.type = 'button';
  cell.className = 'mc-month__day';
  cell.classList.toggle('is-out', !inMonth);
  cell.classList.toggle('is-today', isToday);
  cell.setAttribute('aria-pressed', String(isSelected));
  const label = day.toLocaleDateString(lang, { weekday: 'long', day: 'numeric', month: 'long' });
  cell.setAttribute('aria-label', t('mc.cal.dayAria', { day: label, n: events.length }));
  const num = document.createElement('span');
  num.className = 'mc-month__num';
  num.textContent = String(day.getDate());
  cell.append(num);
  for (const ev of events.slice(0, MAX_PER_CELL)) cell.append(cellEvent(ev, colorOf));
  if (events.length > MAX_PER_CELL) {
    const more = document.createElement('span');
    more.className = 'mc-month__more';
    more.textContent = t('mc.cal.more', { n: events.length - MAX_PER_CELL });
    cell.append(more);
  }
  cell.addEventListener('click', () => onSelect(key));
  return cell;
}

/**
 * @param {{monthKey:string, events:object[]|null, selectedKey:string, lang:string,
 *   colorOf:(event:object)=>string|null, onSelect:(dayKey:string)=>void}} opts
 *   `events` null = month not loaded yet: the grid still renders, empty.
 * @returns {HTMLElement}
 */
export function buildMonthGrid({ monthKey, events, selectedKey, lang, colorOf, onSelect }) {
  const byDay = eventsByDay(events || []);
  const todayKey = dateKey(new Date());
  const first = firstDay(monthKey);
  const cursor = new Date(first);
  cursor.setDate(cursor.getDate() - ((first.getDay() + 6) % 7));

  const grid = document.createElement('div');
  grid.className = 'mc-month__grid';
  do {
    for (let i = 0; i < 7; i++) {
      const key = dateKey(cursor);
      const inMonth = cursor.getMonth() === first.getMonth();
      grid.append(
        dayCell(new Date(cursor), {
          inMonth,
          events: inMonth ? byDay.get(key) || [] : [],
          isToday: key === todayKey,
          isSelected: key === selectedKey,
          lang,
          colorOf,
          onSelect,
        })
      );
      cursor.setDate(cursor.getDate() + 1);
    }
  } while (cursor.getMonth() === first.getMonth());

  const wrap = document.createElement('div');
  wrap.className = 'mc-month';
  wrap.append(weekdayHeader(lang), grid);
  return wrap;
}
