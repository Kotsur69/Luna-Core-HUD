// ============================================================================
// LunaCore - Mission Control: Google Calendar agenda + natural-language add
// ----------------------------------------------------------------------------
// Reading, creating and editing go straight to the Calendar API (src/gcal.js:
// free, every visible calendar). One model job remains:
//
//   PARSE   lean, no tools at all            "Trackday Tor Poznan Sat 9-16"
//                                            -> a structured event DRAFT
//
// The draft travels renderer -> main between PARSE and create (and back for
// an edit), so normalizeDraft() runs on both sides of that trip: the renderer
// is never trusted to hand back something shaped like what we sent it.
// ============================================================================

'use strict';

const { clampString } = require('./missionrunner');

const MONTH_RE = /^(\d{4})-(\d{2})$/;
const MAX_TITLE_CHARS = 200;
const MAX_TEXT_CHARS = 500;
const MAX_INPUT_CHARS = 300;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?$/;

const categoryLines = (categories) =>
  categories.length
    ? categories.map((c) => `- "${c.id}": ${typeof c.label === 'string' ? c.label : c.label.en || c.id}`).join('\n')
    : '- (no categories configured - use null)';

/** A time string valid for its kind (date for all-day, date-time otherwise). */
function validTime(value, allDay) {
  if (typeof value !== 'string') return null;
  const re = allDay ? DATE_RE : DATETIME_RE;
  return re.test(value) && !Number.isNaN(Date.parse(value)) ? value : null;
}

/**
 * Local-midnight bounds of a 'YYYY-MM' month: [start, end) with end the first
 * day of the next month. Null for anything else - the value comes from the
 * renderer and ends up in a prompt, so only this exact shape gets through.
 * @returns {{start:Date, end:Date}|null}
 */
function monthBounds(month) {
  const m = typeof month === 'string' ? MONTH_RE.exec(month) : null;
  if (!m) return null;
  const year = Number(m[1]);
  const index = Number(m[2]) - 1;
  if (year < 2000 || year > 2100 || index < 0 || index > 11) return null;
  return { start: new Date(year, index, 1), end: new Date(year, index + 1, 1) };
}

/**
 * Sort key: all-day dates are read as LOCAL midnight (a bare date would parse
 * as UTC midnight and land among early-morning events), and an all-day event
 * goes before the timed events of its day.
 */
function compareEvents(a, b) {
  const at = (ev) => Date.parse(ev.allDay ? `${ev.start}T00:00:00` : ev.start);
  return at(a) - at(b) || (b.allDay === true) - (a.allDay === true);
}

function buildParsePrompt({ text, nowIso, timeZone, categories }) {
  return [
    "Turn the user's calendar request into ONE event. Do not ask questions; pick sensible",
    'defaults (1 hour long when no end is given; all-day when no time is given).',
    `Current time: ${nowIso}. Time zone: ${timeZone}. Resolve relative dates ("Saturday",`,
    '"tomorrow") against the current time, always into the future.',
    '',
    'Category ids:',
    categoryLines(categories),
    '',
    'Reply with ONLY one JSON object, no prose, no code fence:',
    '{ "title": string, "start": string, "end": string, "allDay": boolean,',
    '  "location": string, "description": string, "category": string|null }',
    'For all-day events start/end are YYYY-MM-DD (end exclusive); otherwise',
    'ISO 8601 local date-time with the zone offset, e.g. 2026-10-10T09:00:00+02:00.',
    '',
    `REQUEST: ${clampString(text, MAX_INPUT_CHARS)}`,
  ].join('\n');
}

/**
 * Validates an event draft (from the model, or back from the renderer).
 * @returns {{ok:true, draft:object}|{ok:false, reason:'bad-draft'}}
 */
function normalizeDraft(raw, categories) {
  if (!raw || typeof raw !== 'object') return { ok: false, reason: 'bad-draft' };
  const allDay = raw.allDay === true;
  const title = clampString(raw.title, MAX_TITLE_CHARS);
  const start = validTime(raw.start, allDay);
  const end = validTime(raw.end, allDay);
  if (!title || !start || !end || Date.parse(end) <= Date.parse(start)) {
    return { ok: false, reason: 'bad-draft' };
  }
  const ids = new Set(categories.map((c) => c.id));
  return {
    ok: true,
    draft: {
      title,
      start,
      end,
      allDay,
      location: clampString(raw.location, MAX_TEXT_CHARS),
      description: clampString(raw.description, MAX_TEXT_CHARS),
      category: ids.has(raw.category) ? raw.category : null,
    },
  };
}

module.exports = {
  compareEvents,
  monthBounds,
  MAX_INPUT_CHARS,
  validTime,
  buildParsePrompt,
  normalizeDraft,
};
