// ============================================================================
// LunaCore - Mission Control: calendar quick add (parse -> draft -> Add)
// ----------------------------------------------------------------------------
// The one part of the calendar widget that still runs a model: free text is
// parsed into an editable draft, and nothing is created until the user
// presses Add. The draft card is the "modal": inline, because the HUD has no
// free floating space, but with the same contract - Escape cancels.
//
// Split out of missioncalendar.js. The widget hands over its DOM refs and a
// small context on mount (config, splice + re-render hooks); the draft itself
// survives remounts, the calendar list is re-read on every mount.
// ============================================================================

'use strict';

import { t, loc } from './util.js';
import { errorText, costSuffix, setStatus, ipcFailed } from './missionshared.js';
import { shiftDate } from './missioncalmonth.js';
import { toInputValue, fromInputValue, field, input } from './missioncaledit.js';

const LAST_CAL_KEY = 'lc.mc.lastCalendar';
const TRACKDAY_RE = /\btrack ?days?\b/i;

let draft = null;
// Calendars a new event can go to ({key, name, color, primary}); null until loaded.
let calendars = null;
let calSelect = null;
let els = null;
/** @type {{config: () => object, onCreated: (ev: object) => void, loadWeather: () => void, renderViews: () => void} | null} */
let ctx = null;

/** Last calendar used for a new event, if this browser profile remembers one. */
function lastCalendar() {
  try {
    return localStorage.getItem(LAST_CAL_KEY);
  } catch {
    return null;
  }
}

/**
 * The calendar a draft should default to: a trackday goes to the calendar
 * named like "Trackdays"; otherwise the last one used, else the primary one.
 */
function pickCalendar(d) {
  if (!calendars || !calendars.length) return '';
  const { weatherCategory } = ctx.config();
  const trackday = (weatherCategory && d.category === weatherCategory) || TRACKDAY_RE.test(d.title || '');
  const trackCal = trackday ? calendars.find((c) => /track/i.test(c.name)) : null;
  if (trackCal) return trackCal.key;
  const last = lastCalendar();
  if (last && calendars.some((c) => c.key === last)) return last;
  return (calendars.find((c) => c.primary) || calendars[0]).key;
}

/** Options for the calendar select; a placeholder while the list loads. */
function fillCalendars(select, selected) {
  if (!calendars) {
    select.replaceChildren(new Option(t('mc.cal.calLoading'), ''));
    select.disabled = true;
    return;
  }
  select.disabled = false;
  select.replaceChildren(...calendars.map((c) => new Option(c.name || t('mc.cal.mainCalendar'), c.key)));
  if (selected) select.value = selected;
}

function draftActions() {
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
  return { actions, add };
}

function renderDraft() {
  if (!els) return;
  els.draft.replaceChildren();
  els.draft.hidden = !draft;
  if (!draft) return;
  const { categories } = ctx.config();
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
  cat.append(new Option(t('mc.cal.uncategorized'), ''), ...categories.map((c) => new Option(loc(c.label), c.id)));
  cat.value = draft.category || '';
  const select = document.createElement('select');
  select.className = 'profile-select';
  fillCalendars(select, pickCalendar(draft));
  // A trackday category moves the event to the trackday calendar - until the
  // user picks a calendar by hand, which then stays.
  let calTouched = false;
  select.addEventListener('change', () => (calTouched = true));
  cat.addEventListener('change', () => {
    if (!calTouched) select.value = pickCalendar({ ...draft, title: title.value, category: cat.value || null }) || select.value;
  });
  calSelect = select;

  const { actions, add } = draftActions();
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
      select.value,
      add
    )
  );

  els.draft.append(
    field('mc.cal.f.title', title),
    field('mc.cal.f.start', start),
    field('mc.cal.f.end', end),
    field('mc.cal.f.category', cat),
    field('mc.cal.f.calendar', select),
    field('mc.cal.f.location', where),
    actions
  );
  title.focus();
}

/** Fetches the calendar list once per mount; fills an open draft's select in place. */
export async function loadCalendars() {
  const res = await window.lunacore.missionCalCalendars().catch(ipcFailed);
  if (!res.ok) return;
  calendars = res.calendars;
  // Filled in place: re-rendering the draft would drop the user's edits.
  if (els && calSelect && draft) fillCalendars(calSelect, pickCalendar(draft));
}

export function closeDraft() {
  draft = null;
  calSelect = null;
  renderDraft();
  if (els) els.input.focus();
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

async function create(edited, calendarKey, button) {
  if (!calendarKey) {
    setStatus(els.status, t('mc.cal.calLoading'), true);
    return;
  }
  button.disabled = true;
  setStatus(els.status, t('mc.cal.creating'));
  const res = await window.lunacore.missionCalCreate(edited, calendarKey).catch(ipcFailed);
  if (res.ok) {
    // The event as Google stored it, spliced into whatever is loaded rather
    // than paying for a reload.
    ctx.onCreated(res.event);
    try {
      localStorage.setItem(LAST_CAL_KEY, calendarKey);
    } catch {
      // A convenience only: without storage the primary calendar stays the default.
    }
  }
  if (!els) return;
  button.disabled = false;
  if (!res.ok) {
    setStatus(els.status, errorText(res.reason), true);
    // A token from before editing existed: one reconnect grants the write scope.
    if (res.reason === 'gcal-scope') els.connect.hidden = false;
    return;
  }
  const cal = (calendars || []).find((c) => c.key === calendarKey);
  setStatus(els.status, t('mc.cal.createdIn', { title: res.event.title, calendar: cal ? cal.name : '' }));
  ctx.loadWeather();
  els.input.value = '';
  closeDraft();
  ctx.renderViews();
}

/**
 * Wires the quick-add form and draft card of a freshly mounted widget.
 * @param {{form: HTMLFormElement, input: HTMLInputElement, draft: HTMLElement, status: HTMLElement, connect: HTMLButtonElement}} widgetEls
 * @param {{config: () => object, onCreated: (ev: object) => void, loadWeather: () => void, renderViews: () => void}} context
 * @returns {() => void} unmount
 */
export function mountQuickAdd(widgetEls, context) {
  els = widgetEls;
  ctx = context;
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
  renderDraft();
  return () => {
    els = null;
    calSelect = null;
    calendars = null;
  };
}
