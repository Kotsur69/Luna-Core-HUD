// ============================================================================
// LunaCore phone - calendar and mail from the `google` server function (phase 5)
// ----------------------------------------------------------------------------
// Pure: the request window, the replies re-checked before rendering (the
// function is ours, but every string in it came from Google), day grouping
// and the add-event draft. Validators are the server's own (core.mjs), so the
// phone never builds a draft the function would refuse.
// ============================================================================

import { clamp, validTime, normalizeDraft, compareEvents } from '../../supabase/functions/google/core.mjs';

export const WINDOW_DAYS = 7;
const MAX_EVENTS = 500;
const MAX_MAIL = 5;
const HOUR_MS = 3600000;
const HEX_RE = /^#[0-9a-f]{6}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

const pad = (n) => String(n).padStart(2, '0');

/** A local date as YYYY-MM-DD. */
export const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** A Date as local ISO 8601 with its zone offset: 2026-10-19T09:00:00+02:00. */
export function localIso(d) {
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const abs = Math.abs(off);
  return `${dayKey(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/** Today's local midnight up to the same midnight WINDOW_DAYS later. */
export function weekWindow(now = new Date()) {
  const from = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const to = new Date(now.getFullYear(), now.getMonth(), now.getDate() + WINDOW_DAYS);
  return { from: localIso(from), to: localIso(to) };
}

/** An events reply -> events safe to render; junk entries are dropped. */
export function readEvents(data) {
  const list = data && Array.isArray(data.events) ? data.events : [];
  const out = [];
  for (const e of list.slice(0, MAX_EVENTS)) {
    if (!e || typeof e !== 'object') continue;
    const allDay = e.allDay === true;
    const start = validTime(e.start, allDay);
    if (!start) continue;
    out.push({
      title: clamp(e.title, 200) || '(no title)',
      start,
      end: validTime(e.end, allDay) || start,
      allDay,
      location: clamp(e.location, 500),
      calendar: clamp(e.calendar, 80),
      color: typeof e.color === 'string' && HEX_RE.test(e.color) ? e.color : null,
    });
  }
  return out.sort(compareEvents);
}

/** A mail reply -> {unread, latest} safe to render. */
export function readMail(data) {
  const unread = data ? Number(data.unread) : NaN;
  const latest = (data && Array.isArray(data.latest) ? data.latest : [])
    .slice(0, MAX_MAIL)
    .filter((m) => m && typeof m === 'object')
    .map((m) => ({
      from: clamp(m.from, 80),
      subject: clamp(m.subject, 200) || '(no subject)',
      at: Number.isFinite(m.at) && m.at > 0 ? m.at : null,
    }));
  return { unread: Number.isInteger(unread) && unread >= 0 ? unread : 0, latest };
}

/** True when `ev` is over before today's local midnight (all-day ends are exclusive). */
function endedBefore(ev, today, midnight) {
  if (ev.allDay) return ev.end <= today && ev.start < today;
  return Date.parse(ev.end) <= midnight && Date.parse(ev.start) < midnight;
}

/**
 * Events per local day from today on, empty days left out. An event that
 * began before today but is still running sits under today; one already
 * over (a week cached days ago, shown offline) is left out.
 * @returns {Array<{day: string, events: object[]}>}
 */
export function groupByDay(events, now = new Date()) {
  const today = dayKey(now);
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const groups = new Map();
  for (const ev of events) {
    if (endedBefore(ev, today, midnight)) continue;
    const startDay = ev.allDay ? ev.start : dayKey(new Date(ev.start));
    const day = startDay < today ? today : startDay;
    if (!groups.has(day)) groups.set(day, []);
    groups.get(day).push(ev);
  }
  return [...groups.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([day, list]) => ({ day, events: list }));
}

/** The day after a YYYY-MM-DD (all-day ends are exclusive). */
function nextDay(date) {
  const [y, m, d] = date.split('-').map(Number);
  return dayKey(new Date(y, m - 1, d + 1));
}

/**
 * The add-event form -> a draft the server accepts, or null. No end time
 * means one hour; times are this phone's local zone.
 * @param {{title:string, date:string, allDay:boolean, start?:string, end?:string, location?:string}} form
 */
export function draftFrom(form) {
  if (!form || typeof form.date !== 'string' || !DATE_RE.test(form.date)) return null;
  if (form.allDay) return normalizeDraft({ title: form.title, allDay: true, start: form.date, end: nextDay(form.date), location: form.location });
  if (typeof form.start !== 'string' || !TIME_RE.test(form.start)) return null;
  const [y, m, d] = form.date.split('-').map(Number);
  const at = (hhmm) => new Date(y, m - 1, d, Number(hhmm.slice(0, 2)), Number(hhmm.slice(3, 5)));
  const start = at(form.start);
  const end = form.end && TIME_RE.test(form.end) ? at(form.end) : new Date(start.getTime() + HOUR_MS);
  return normalizeDraft({ title: form.title, allDay: false, start: localIso(start), end: localIso(end), location: form.location });
}
