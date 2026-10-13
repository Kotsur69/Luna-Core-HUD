// ============================================================================
// LunaCore - Mission Control: calendar event editor + event weather row
// ----------------------------------------------------------------------------
// Click an event you own -> this card opens inside its row: title, start, end,
// location. Save goes to main (mission:cal-update), which re-validates and
// patches Google; nothing changes until Save. Escape or Cancel closes it.
// The all-day kind is not switchable here (Google treats it as another event).
//
// Also the form helpers shared with the quick-add draft (missioncalendar.js).
// ============================================================================

'use strict';

import { t } from './util.js';
import { shiftDate } from './missioncalmonth.js';
import { surfaceOf } from './missionweatherview.js';

const DAY_MS = 86400000;
const pad = (n) => String(Math.abs(n)).padStart(2, '0');

/** datetime-local value ('YYYY-MM-DDTHH:mm', local wall time) from an ISO string. */
export function toInputValue(iso, allDay) {
  if (allDay) return iso.slice(0, 10);
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** ISO 8601 with the local offset for that date, from a datetime-local value. */
export function fromInputValue(value, allDay) {
  if (allDay) return value;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  return `${value}:00${sign}${pad(Math.trunc(off / 60))}:${pad(off % 60)}`;
}

export function field(labelKey, control) {
  const label = document.createElement('label');
  label.className = 'mc-field';
  const span = document.createElement('span');
  span.textContent = t(labelKey);
  label.append(span, control);
  return label;
}

export function input(type, value) {
  const el = document.createElement('input');
  el.type = type;
  el.className = 'mc-input';
  el.value = value;
  return el;
}

/** Moving the start keeps the event's length, like Google Calendar does. */
function keepLength(start, end, allDay) {
  let lastStart = start.value;
  start.addEventListener('change', () => {
    const shift = Date.parse(start.value) - Date.parse(lastStart);
    if (Number.isFinite(shift) && end.value) {
      end.value = allDay
        ? shiftDate(end.value, Math.round(shift / DAY_MS))
        : toInputValue(new Date(Date.parse(end.value) + shift).toISOString(), false);
    }
    // A cleared field is no new anchor: the next real start still shifts the end.
    if (start.value) lastStart = start.value;
  });
}

function button(type, className, labelKey) {
  const el = document.createElement('button');
  el.type = type;
  el.className = className;
  el.textContent = t(labelKey);
  return el;
}

/**
 * The inline edit card for one event.
 * @param {object} ev  a listed event (editable)
 * @param {{onSave:(draft:object, button:HTMLButtonElement)=>void, onCancel:()=>void}} handlers
 * @returns {{el:HTMLElement, focus:()=>void}}
 */
export function buildEditor(ev, { onSave, onCancel }) {
  const type = ev.allDay ? 'date' : 'datetime-local';
  const title = input('text', ev.title);
  title.maxLength = 200;
  const start = input(type, toInputValue(ev.start, ev.allDay));
  // Google's all-day end is exclusive; the field shows the last day itself.
  const end = input(type, ev.allDay ? shiftDate(ev.end, -1) : toInputValue(ev.end, false));
  const where = input('text', ev.location || '');
  where.maxLength = 500;
  // The browser blocks Save on an empty one, with its own message by the field.
  for (const el of [title, start, end]) el.required = true;
  keepLength(start, end, ev.allDay);

  const save = button('submit', 'pad-send', 'mc.cal.save');
  const cancel = button('button', 'port-btn mc-draft__cancel', 'mc.cal.cancel');
  const actions = document.createElement('div');
  actions.className = 'mc-draft__actions';
  actions.append(save, cancel);

  const form = document.createElement('form');
  form.className = 'mc-draft mc-edit';
  form.setAttribute('aria-label', t('mc.cal.editLabel', { title: ev.title }));
  form.append(
    field('mc.cal.f.title', title),
    field('mc.cal.f.start', start),
    field('mc.cal.f.end', end),
    field('mc.cal.f.location', where),
    actions
  );
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    onSave(
      {
        title: title.value,
        start: fromInputValue(start.value, ev.allDay),
        end: ev.allDay ? shiftDate(end.value, 1) : fromInputValue(end.value, false),
        allDay: ev.allDay,
        location: where.value,
      },
      save
    );
  });
  cancel.addEventListener('click', onCancel);
  form.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    // The Mission Control panel lets Escape through inside .mc-edit (missionpanel.js).
    e.preventDefault();
    onCancel();
  });
  return { el: form, focus: () => start.focus() };
}

let wxSeq = 0;

/** "12–17°C · rain 40% · wind 25 km/h", "≈ " in front when over a week out. */
function weatherSummary(wx) {
  const parts = [wx.tMin === wx.tMax ? `${wx.tMax}°C` : `${wx.tMin}–${wx.tMax}°C`];
  if (wx.rain !== null) parts.push(t('mc.cal.wx.rain', { n: wx.rain }));
  if (wx.wind !== null) parts.push(t('mc.cal.wx.wind', { n: wx.wind }));
  return (wx.longRange ? '≈ ' : '') + parts.join(' · ');
}

/** "sob 09:00" on the first hour of each day, "10:00" after it. */
function hourLabel(ms, prevMs) {
  const d = new Date(ms);
  const hh = `${pad(d.getHours())}:00`;
  const newDay = prevMs === null || new Date(prevMs).toDateString() !== d.toDateString();
  return newDay ? `${d.toLocaleDateString(window.i18n.lang, { weekday: 'short' })} ${hh}` : hh;
}

const num = (v, unit = '') => (v === null || v === undefined ? '–' : `${v}${unit}`);

/** The hour-by-hour table: time, temp, rain chance, rain mm, wind, surface guess. */
function hourTable(wx, id) {
  const table = document.createElement('table');
  table.className = 'mc-wxh';
  table.id = id;
  const cap = document.createElement('caption');
  cap.className = 'mc-sr';
  cap.textContent = t('mc.cal.wx.hourly', { place: wx.place || '' });
  const head = document.createElement('tr');
  for (const key of ['hour', 'temp', 'chance', 'mm', 'wind', 'surface']) {
    const th = document.createElement('th');
    th.scope = 'col';
    th.textContent = t(`mc.cal.wx.col.${key}`);
    if (key === 'surface') th.title = t('mc.cal.wx.surfaceHint');
    head.append(th);
  }
  const thead = document.createElement('thead');
  thead.append(head);
  const tbody = document.createElement('tbody');
  let prev = null;
  for (const h of wx.hours || []) {
    const surface = surfaceOf(h);
    const tr = document.createElement('tr');
    tr.className = `is-${surface}`;
    const th = document.createElement('th');
    th.scope = 'row';
    th.textContent = hourLabel(h.t, prev);
    prev = h.t;
    tr.append(th);
    for (const text of [num(h.temp, '°'), num(h.rain, '%'), num(h.mm), num(h.wind)]) {
      const td = document.createElement('td');
      td.textContent = text;
      tr.append(td);
    }
    // Text, not only colour: the guess is readable without the tint.
    const guess = document.createElement('td');
    guess.className = 'mc-wxh__surface';
    guess.textContent = t(`mc.cal.wx.surface.${surface}`);
    tr.append(guess);
    tbody.append(tr);
  }
  table.append(cap, thead, tbody);
  return table;
}

/**
 * The weather line under an event, as its own list item (a button must not
 * sit inside the row, which is itself a button). Clicking it unfolds the
 * hourly table - a trackday's tyre call can change from hour to hour.
 * @param {object|undefined} wx  main's forecast for the event
 * @param {{id:string, open:boolean, onToggle:()=>void}} opts
 * @returns {HTMLLIElement|null}
 */
export function weatherRow(wx, { id, open, onToggle }) {
  if (!wx) return null;
  const li = document.createElement('li');
  li.className = 'mc-wx-row';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'mc-wx';
  btn.dataset.wxFor = id;
  if (wx.longRange) btn.classList.add('is-far');
  if (wx.rain !== null && wx.rain >= 50) btn.classList.add('is-wet');
  const hasHours = Array.isArray(wx.hours) && wx.hours.length > 0;
  const text = document.createElement('span');
  text.textContent = weatherSummary(wx);
  btn.append(text);
  btn.title = t(wx.longRange ? 'mc.cal.wx.titleFar' : 'mc.cal.wx.title', { place: wx.place || '' });
  li.append(btn);
  if (!hasHours) {
    btn.disabled = true;
    return li;
  }
  const chevron = document.createElement('span');
  chevron.className = 'mc-wx__chevron';
  chevron.setAttribute('aria-hidden', 'true');
  chevron.textContent = open ? '▴' : '▾';
  btn.append(chevron);
  btn.setAttribute('aria-expanded', String(open));
  btn.addEventListener('click', onToggle);
  if (open) {
    const tableId = `mc-wxh-${++wxSeq}`;
    btn.setAttribute('aria-controls', tableId);
    li.append(hourTable(wx, tableId));
  }
  return li;
}
