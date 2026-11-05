// ============================================================================
// LunaCore - Google Calendar event mapping (pure; split out of gcal.js)
// ----------------------------------------------------------------------------
// Every value from Google is untrusted: events and calendars are rebuilt field
// by field, capped, and validated with the same rules as missioncal.js. Also
// the readers of Google's error bodies. No network, no state.
// ============================================================================

'use strict';

const { clampString } = require('./missionrunner');
const { validTime, compareEvents } = require('./missioncal');

const MAX_CALENDARS = 25;
const MAX_EVENTS = 500;
const MAX_TITLE_CHARS = 200;
const MAX_TEXT_CHARS = 500;
const MAX_NAME_CHARS = 80;
const WRITE_ROLES = new Set(['owner', 'writer']);

const EVENT_ID_RE = /^[A-Za-z0-9_@.-]{1,256}$/;
const HEX_RE = /^#[0-9a-f]{6}$/i;

/**
 * Google API errors are {error:{code, message, status, errors:[{reason}]}}, not
 * a string. Returns ": <status/reason> - <message>" for the log, or "" when the
 * body carries nothing usable. Never includes tokens - Google does not echo them.
 */
function googleErrorDetail(body) {
  const err = body && body.error;
  if (!err) return '';
  if (typeof err === 'string') return `: ${err}`;
  const reason = (Array.isArray(err.errors) && err.errors[0] && err.errors[0].reason) || err.status || '';
  const message = typeof err.message === 'string' ? err.message.slice(0, 300) : '';
  const parts = [reason, message].filter(Boolean).join(' - ');
  return parts ? `: ${parts}` : '';
}

/**
 * A 403 on a write: the token predates the calendar.events scope (reconnect
 * fixes it), or Google refuses this event (a read-only calendar, a guest).
 */
function writeDenial(body) {
  const err = (body && body.error) || {};
  const reason = Array.isArray(err.errors) && err.errors[0] ? err.errors[0].reason : '';
  const scoped = reason === 'insufficientPermissions' || /scope/i.test(String(err.message || ''));
  return scoped ? 'gcal-scope' : 'gcal-not-editable';
}

/**
 * Rebuilds one API event into the widget's shape. Null for cancelled events,
 * events the user declined, and anything with unusable times.
 * @param {object} raw  an events#resource from the API
 * @param {{name:string, color:string|null}} calendar
 * @param {Array<{id:string, colorId:string|null}>} categories
 */
function normalizeEvent(raw, calendar, categories) {
  if (!raw || typeof raw !== 'object' || raw.status === 'cancelled') return null;
  const self = Array.isArray(raw.attendees) ? raw.attendees.find((a) => a && a.self) : null;
  if (self && self.responseStatus === 'declined') return null;
  const s = raw.start || {};
  const e = raw.end || {};
  const allDay = typeof s.date === 'string';
  const start = validTime(allDay ? s.date : s.dateTime, allDay);
  if (!start) return null;
  const category = categories.find((c) => c.colorId && c.colorId === raw.colorId);
  const id = typeof raw.id === 'string' && EVENT_ID_RE.test(raw.id) ? raw.id : '';
  // Someone else's invite: Google refuses a time change from a guest.
  const ownsIt = !raw.organizer || raw.organizer.self === true || raw.guestsCanModify === true;
  return {
    id,
    uid: typeof raw.iCalUID === 'string' ? raw.iCalUID.slice(0, 300) : '',
    title: clampString(raw.summary, MAX_TITLE_CHARS) || '(no title)',
    start,
    end: validTime(allDay ? e.date : e.dateTime, allDay) || start,
    allDay,
    location: clampString(raw.location, MAX_TEXT_CHARS),
    category: category ? category.id : null,
    calendar: calendar.name,
    color: calendar.color,
    editable: !!(id && calendar.writable && ownsIt),
  };
}

/**
 * Merges per-calendar event lists: one copy of an event that sits in two
 * calendars (an invite on both Praca and primary), sorted, capped.
 */
function mergeEvents(lists) {
  const seen = new Set();
  const out = [];
  for (const { uid, ...ev } of lists.flat()) {
    const key = uid ? `${uid}|${ev.start}` : null;
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    out.push(ev);
  }
  return out.sort(compareEvents).slice(0, MAX_EVENTS);
}

/** A calendar's display name; '' when the only name there is an email address. */
function calendarName(c) {
  const name = clampString(c.summaryOverride || c.summary, MAX_NAME_CHARS);
  return name && !name.includes('@') ? name : '';
}

/** The calendars shown in Google Calendar (ticked in its sidebar). */
function visibleCalendars(items) {
  return (Array.isArray(items) ? items : [])
    .filter((c) => c && typeof c.id === 'string' && c.id && (c.selected === true || c.primary === true))
    .slice(0, MAX_CALENDARS)
    .map((c) => ({
      id: c.id,
      // The primary calendar is named after the account's email address: never
      // shown. '' -> the renderer says "Main calendar" (or "no category" on a chip).
      name: calendarName(c),
      color: typeof c.backgroundColor === 'string' && HEX_RE.test(c.backgroundColor) ? c.backgroundColor : null,
      writable: WRITE_ROLES.has(c.accessRole),
      primary: c.primary === true,
    }));
}

module.exports = {
  normalizeEvent,
  mergeEvents,
  visibleCalendars,
  googleErrorDetail,
  writeDenial,
  EVENT_ID_RE,
};
