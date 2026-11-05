// ============================================================================
// LunaCore - Mission Control: calendar event list helpers
// ----------------------------------------------------------------------------
// Ordering, day grouping and month membership of the events the calendar
// widget (missioncalendar.js) keeps loaded. No state, no DOM, no IPC - split
// out of missioncalendar.js so the widget file holds rendering and flow only.
// ============================================================================

'use strict';

import { t } from './util.js';
import { shiftDate, startDay } from './missioncalmonth.js';
import { toInputValue } from './missioncaledit.js';

/** Same order as main's compareEvents (src/missioncal.js). */
export function compareEvents(a, b) {
  const at = (ev) => Date.parse(ev.allDay ? `${ev.start}T00:00:00` : ev.start);
  return at(a) - at(b) || (b.allDay === true) - (a.allDay === true);
}

/** Local calendar day key for grouping; all-day events already carry one. */
export const dayKey = (ev) => (ev.allDay ? ev.start.slice(0, 10) : toInputValue(ev.start, false).slice(0, 10));

/** Events grouped by dayKey, in list order: Map<'YYYY-MM-DD', event[]>. */
export function groupByDay(events) {
  const groups = new Map();
  for (const ev of events) {
    const key = dayKey(ev);
    groups.set(key, [...(groups.get(key) || []), ev]);
  }
  return groups;
}

/** 'HH:mm–HH:mm' (or one time, or "all day") for an event row. */
export function timeLabel(ev) {
  if (ev.allDay) return t('mc.cal.allDay');
  const hm = (iso) => toInputValue(iso, false).slice(11, 16);
  return ev.end && ev.end !== ev.start ? `${hm(ev.start)}–${hm(ev.end)}` : hm(ev.start);
}

/** Local 'YYYY-MM' keys an event touches, as a test (all-day end is exclusive). */
export function monthsOf(ev) {
  const first = startDay(ev);
  const lastDay = ev.allDay ? shiftDate(ev.end, -1) : toInputValue(ev.end, false).slice(0, 10);
  const from = first.slice(0, 7);
  const to = (lastDay > first ? lastDay : first).slice(0, 7);
  return (key) => key >= from && key <= to;
}

/** A new sorted list with `ev` added. */
export const withEvent = (list, ev) => [...list, ev].sort(compareEvents);
