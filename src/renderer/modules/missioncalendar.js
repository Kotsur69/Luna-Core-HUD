// ============================================================================
// LunaCore - Mission Control: calendar widget (agenda + quick add)
// ----------------------------------------------------------------------------
// The agenda is loaded on demand (refresh button), not on mount: each load is
// a real model call, and a widget that re-bills itself every time the layout
// changes would be a surprise. The last agenda survives remounts.
//
// Quick add is parse -> editable draft -> Add. The draft card is the "modal":
// inline, because the HUD has no free floating space, but it has the same
// contract - nothing is created until the user presses Add, Escape cancels.
// ============================================================================

'use strict';

import { t, loc } from './util.js';
import { defineWidget } from './registry.js';
import { errorText, costSuffix, setStatus, ipcFailed } from './missionshared.js';

let config = { categories: [], days: 7 };
let agenda = null;
let draft = null;
let els = null;

const pad = (n) => String(Math.abs(n)).padStart(2, '0');

/** datetime-local value ('YYYY-MM-DDTHH:mm', local wall time) from an ISO string. */
function toInputValue(iso, allDay) {
  if (allDay) return iso.slice(0, 10);
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** ISO 8601 with the local offset for that date, from a datetime-local value. */
function fromInputValue(value, allDay) {
  if (allDay) return value;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  return `${value}:00${sign}${pad(Math.trunc(off / 60))}:${pad(off % 60)}`;
}

/** 'YYYY-MM-DD' moved by whole days (calendar arithmetic, no time zone). */
function shiftDate(value, days) {
  const d = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return value;
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Same order as main's compareEvents (src/missioncal.js). */
function compareEvents(a, b) {
  const at = (ev) => Date.parse(ev.allDay ? `${ev.start}T00:00:00` : ev.start);
  return at(a) - at(b) || (b.allDay === true) - (a.allDay === true);
}

const category = (id) => config.categories.find((c) => c.id === id) || null;

function chip(catId) {
  const cat = category(catId);
  const span = document.createElement('span');
  span.className = 'mc-chip';
  if (!cat) {
    span.textContent = t('mc.cal.uncategorized');
    return span;
  }
  span.style.setProperty('--mc-cat', cat.color);
  span.textContent = loc(cat.label);
  return span;
}

/** Local calendar day key for grouping; all-day events already carry one. */
const dayKey = (ev) => (ev.allDay ? ev.start.slice(0, 10) : toInputValue(ev.start, false).slice(0, 10));

function timeLabel(ev) {
  if (ev.allDay) return t('mc.cal.allDay');
  const hm = (iso) => toInputValue(iso, false).slice(11, 16);
  return ev.end && ev.end !== ev.start ? `${hm(ev.start)}–${hm(ev.end)}` : hm(ev.start);
}

function eventRow(ev) {
  const li = document.createElement('li');
  li.className = 'todo-item mc-event';
  const time = document.createElement('span');
  time.className = 'mc-event__time';
  time.textContent = timeLabel(ev);
  const body = document.createElement('span');
  body.className = 'mc-row__text';
  const title = document.createElement('span');
  title.className = 'mc-row__from';
  title.textContent = ev.title;
  body.append(title);
  if (ev.location) {
    const where = document.createElement('span');
    where.className = 'mc-row__note';
    where.textContent = ev.location;
    body.append(where);
  }
  li.append(time, body, chip(ev.category));
  return li;
}

function renderAgenda() {
  if (!els) return;
  els.agenda.replaceChildren();
  if (!agenda) return;
  if (!agenda.length) {
    const p = document.createElement('p');
    p.className = 'hint';
    p.textContent = t('mc.cal.empty', { n: config.days });
    els.agenda.append(p);
    return;
  }
  const groups = new Map();
  for (const ev of agenda) {
    const key = dayKey(ev);
    groups.set(key, [...(groups.get(key) || []), ev]);
  }
  for (const [key, events] of groups) {
    const section = document.createElement('section');
    section.className = 'mc-bucket';
    const h = document.createElement('h3');
    h.className = 'mc-bucket__title';
    h.textContent = new Date(`${key}T12:00:00`).toLocaleDateString(window.i18n.lang, {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
    });
    const ul = document.createElement('ul');
    ul.className = 'todo-list';
    ul.append(...events.map(eventRow));
    section.append(h, ul);
    els.agenda.append(section);
  }
}

function field(labelKey, control) {
  const label = document.createElement('label');
  label.className = 'mc-field';
  const span = document.createElement('span');
  span.textContent = t(labelKey);
  label.append(span, control);
  return label;
}

function input(type, value) {
  const el = document.createElement('input');
  el.type = type;
  el.className = 'mc-input';
  el.value = value;
  return el;
}

function renderDraft() {
  if (!els) return;
  els.draft.replaceChildren();
  els.draft.hidden = !draft;
  if (!draft) return;
  const type = draft.allDay ? 'date' : 'datetime-local';
  const title = input('text', draft.title);
  title.maxLength = 200;
  const start = input(type, toInputValue(draft.start, draft.allDay));
  // Google's all-day end date is exclusive; the field shows the inclusive
  // last day (what a person means) and the +1 goes back on submit.
  const end = input(type, draft.allDay ? shiftDate(draft.end, -1) : toInputValue(draft.end, false));
  const where = input('text', draft.location);
  where.maxLength = 500;
  const cat = document.createElement('select');
  cat.className = 'profile-select';
  cat.append(
    new Option(t('mc.cal.uncategorized'), ''),
    ...config.categories.map((c) => new Option(loc(c.label), c.id))
  );
  cat.value = draft.category || '';

  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'pad-send';
  add.textContent = t('mc.cal.add');
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'port-btn mc-draft__cancel';
  cancel.textContent = t('mc.cal.cancel');
  const actions = document.createElement('div');
  actions.className = 'mc-draft__actions';
  actions.append(add, cancel);

  cancel.addEventListener('click', closeDraft);
  add.addEventListener('click', () =>
    create(
      {
        ...draft,
        title: title.value,
        start: fromInputValue(start.value, draft.allDay),
        end: draft.allDay ? shiftDate(end.value, 1) : fromInputValue(end.value, false),
        location: where.value,
        category: cat.value || null,
      },
      add
    )
  );

  els.draft.append(
    field('mc.cal.f.title', title),
    field('mc.cal.f.start', start),
    field('mc.cal.f.end', end),
    field('mc.cal.f.category', cat),
    field('mc.cal.f.location', where),
    actions
  );
  title.focus();
}

function closeDraft() {
  draft = null;
  renderDraft();
  if (els) els.input.focus();
}

async function loadAgenda() {
  els.refresh.disabled = true;
  els.refresh.classList.add('is-spinning');
  setStatus(els.status, t('mc.cal.loading'));
  const res = await window.lunacore.missionCalAgenda().catch(ipcFailed);
  if (res.ok) agenda = res.events;
  if (!els) return;
  els.refresh.disabled = false;
  els.refresh.classList.remove('is-spinning');
  if (!res.ok) {
    setStatus(els.status, errorText(res.reason) + costSuffix(res.costUsd), true);
    return;
  }
  setStatus(els.status, t('mc.cal.loaded', { n: agenda.length }) + costSuffix(res.costUsd));
  renderAgenda();
}

async function parse(text) {
  els.input.disabled = true;
  setStatus(els.status, t('mc.cal.parsing'));
  const res = await window.lunacore.missionCalParse(text).catch(ipcFailed);
  if (res.ok) draft = res.draft;
  if (!els) return;
  els.input.disabled = false;
  if (!res.ok) {
    setStatus(els.status, errorText(res.reason) + costSuffix(res.costUsd), true);
    els.input.focus();
    return;
  }
  setStatus(els.status, t('mc.cal.review') + costSuffix(res.costUsd));
  renderDraft();
}

async function create(edited, button) {
  button.disabled = true;
  setStatus(els.status, t('mc.cal.creating'));
  const res = await window.lunacore.missionCalCreate(edited).catch(ipcFailed);
  if (res.ok && agenda) {
    // Main's normalised draft, not the raw form values; spliced in rather
    // than paying for a reload.
    agenda = [...agenda, { ...res.draft, id: res.eventId }].sort(compareEvents);
  }
  if (!els) return;
  button.disabled = false;
  if (!res.ok) {
    setStatus(els.status, errorText(res.reason) + costSuffix(res.costUsd), true);
    return;
  }
  setStatus(els.status, t('mc.cal.created', { title: edited.title }) + costSuffix(res.costUsd));
  els.input.value = '';
  closeDraft();
  renderAgenda();
}

defineWidget({
  id: 'calendar',
  titleKey: 'mc.cal.title',
  template: 'w-calendar',
  mount(root) {
    els = {
      refresh: root.querySelector('#mc-cal-refresh'),
      form: root.querySelector('#mc-cal-form'),
      input: root.querySelector('#mc-cal-input'),
      draft: root.querySelector('#mc-cal-draft'),
      status: root.querySelector('#mc-cal-status'),
      agenda: root.querySelector('#mc-cal-agenda'),
    };
    window.lunacore
      .getMissionConfig()
      .then((c) => {
        config = c;
        renderAgenda();
      })
      .catch(() => {
        // No config -> no categories; events still render, uncategorized.
      });
    els.refresh.addEventListener('click', loadAgenda);
    els.form.addEventListener('submit', (e) => {
      e.preventDefault();
      // An open draft holds the user's edits; a new parse would replace it
      // silently. Finish or cancel that one first.
      if (draft) {
        setStatus(els.status, t('mc.cal.draftOpen'), true);
        return;
      }
      const text = els.input.value.trim();
      if (text) parse(text);
    });
    els.draft.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      // Handled here: the Mission Control panel closes on an unhandled Escape.
      e.preventDefault();
      closeDraft();
    });
    if (!agenda) setStatus(els.status, t('mc.cal.idle'));
    renderAgenda();
    renderDraft();
    return () => {
      els = null;
    };
  },
});
