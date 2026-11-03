// ============================================================================
// LunaCore - Mission Control calendar IPC (main process)
// ----------------------------------------------------------------------------
// The mission:cal-* and mission:gcal-* channels, split out of
// missioncontrolipc.js: the agenda and month grid read through the Google
// Calendar API client (src/gcal.js - no model call), quick add parses with one
// lean model job, and edits / creates go back through gcal.js.
//
// State held here, and why:
//   - seenEvents: the calendar events main itself read from Google. Event
//     weather is worked out from these, never from events the renderer sends.
//   - lastUpdateAt / lastCreateAt / createTimes: a renderer looping over
//     saves or creates is throttled to a crawl.
// ============================================================================

'use strict';

const { loadMissionConfig } = require('./missionconfig');
const cal = require('./missioncal');
const { localIsoNow } = require('./missionipcshared');

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_SEEN_EVENTS = 1000;
/** Min gap between two event edits or creates (a person saves one card at a time). */
const UPDATE_GAP_MS = 1000;
/** At most this many new events per window (a person adds a few at a time). */
const MAX_CREATES_PER_WINDOW = 30;
const CREATE_WINDOW_MS = 10 * 60 * 1000;
const EVENT_ID_RE = /^[A-Za-z0-9_@.-]{1,256}$/;

const timeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

/** The opaque calendar keys gcal.listCalendars() hands out. */
const CAL_KEY_RE = /^[0-9a-f]{16}$/;

/** A GcalError keeps its reason; anything else is logged and made generic. */
function gcalFailure(err) {
  if (err && typeof err.reason === 'string') {
    console.error('[mission] google calendar:', err.reason, err.message);
    return { ok: false, reason: err.reason };
  }
  console.error('[mission] google calendar failed:', err && err.message);
  return { ok: false, reason: 'gcal-failed' };
}

/** Native file dialog for the Google Desktop-app client JSON. */
async function defaultPickClientFile() {
  const { dialog, BrowserWindow } = require('electron');
  const win = BrowserWindow.getFocusedWindow();
  const opts = {
    title: 'Google OAuth client (Desktop app) JSON',
    properties: ['openFile'],
    filters: [{ name: 'JSON', extensions: ['json'] }],
  };
  const result = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
  return result.canceled || !result.filePaths[0] ? null : result.filePaths[0];
}

/**
 * Registers the calendar channels.
 * @param {{ipcMain:object, guarded:Function, job:Function, gcal:object,
 *          weather:object, pickClientFile:Function}} ctx  shared helpers and
 *   services from registerMissionIpc().
 */
function registerCalendarIpc({ ipcMain, guarded, job, gcal, weather, pickClientFile }) {
  const seenEvents = new Map();
  /** Keeps the newest copy of each listed event; the oldest fall out first. */
  const rememberEvents = (events) => {
    for (const ev of events) {
      if (!ev || !ev.id) continue;
      seenEvents.delete(ev.id);
      seenEvents.set(ev.id, ev);
    }
    while (seenEvents.size > MAX_SEEN_EVENTS) seenEvents.delete(seenEvents.keys().next().value);
  };
  let lastUpdateAt = 0;
  let lastCreateAt = 0;
  let createTimes = [];

  // No argument: the next `days` days from now (the week list). `{month}`:
  // that whole calendar month (the month grid). Read from the Calendar API.
  ipcMain.handle('mission:cal-agenda', (_event, req) =>
    guarded('agenda', async () => {
      const { calendar } = loadMissionConfig();
      let from;
      let to;
      if (req && req.month !== undefined) {
        const bounds = cal.monthBounds(req.month);
        if (!bounds) return { ok: false, reason: 'bad-range' };
        ({ start: from, end: to } = bounds);
      } else {
        from = new Date();
        to = new Date(from.getTime() + calendar.days * DAY_MS);
      }
      try {
        const { events } = await gcal.listEvents({
          fromIso: localIsoNow(from),
          toIso: localIsoNow(to),
          categories: calendar.categories,
        });
        rememberEvents(events);
        return { ok: true, events };
      } catch (err) {
        return gcalFailure(err);
      }
    })
  );

  // Click-to-edit: title, times and location of one event main listed earlier.
  // The draft is validated like a quick-add draft; gcal decides which calendar.
  ipcMain.handle('mission:cal-update', (_event, req) =>
    guarded('update', async () => {
      const id = req && typeof req.id === 'string' && EVENT_ID_RE.test(req.id) ? req.id : null;
      if (!id) return { ok: false, reason: 'bad-draft' };
      const { calendar } = loadMissionConfig();
      const checked = cal.normalizeDraft(req.draft, calendar.categories);
      if (!checked.ok) return checked;
      // A person saves one card at a time; a renderer looping over every
      // editable event is throttled to a crawl. Only well-formed saves count.
      const nowMs = Date.now();
      if (nowMs - lastUpdateAt < UPDATE_GAP_MS) return { ok: false, reason: 'rate-limited' };
      lastUpdateAt = nowMs;
      try {
        const { event } = await gcal.updateEvent(id, checked.draft, calendar.categories);
        rememberEvents([event]);
        return { ok: true, event };
      } catch (err) {
        return gcalFailure(err);
      }
    })
  );

  // Weather for the listed events that have a place (Open-Meteo, free).
  // Not under `busy`: an idempotent read, and a dropped second call would be
  // the one that already sees a just-saved event.
  ipcMain.handle('mission:cal-weather', async () => {
    try {
      const { calendar } = loadMissionConfig();
      return { ok: true, weather: await weather.forEvents([...seenEvents.values()], calendar.weather) };
    } catch (err) {
      console.error('[mission] weather failed:', err && err.message);
      return { ok: false, reason: 'generic' };
    }
  });

  // Opens the browser for Google consent and waits (up to 3 min) for the
  // loopback redirect. One at a time: a second click while waiting is `busy`.
  // The Google "Desktop app" client JSON: picked in a native dialog here, so
  // the renderer never names a path; gcal.importClient validates and copies it.
  ipcMain.handle('mission:gcal-import-client', () =>
    guarded('gcal-import', async () => {
      const file = await pickClientFile();
      if (!file) return { ok: false, reason: 'cancelled' };
      try {
        gcal.importClient(file);
        return { ok: true, gcal: gcal.status() };
      } catch (err) {
        return gcalFailure(err);
      }
    })
  );

  ipcMain.handle('mission:gcal-connect', () =>
    guarded('gcal-connect', async () => {
      try {
        await gcal.connect();
        return { ok: true, gcal: gcal.status() };
      } catch (err) {
        return gcalFailure(err);
      }
    })
  );

  ipcMain.handle('mission:cal-parse', (_event, text) =>
    guarded('parse', async () => {
      if (typeof text !== 'string' || !text.trim()) return { ok: false, reason: 'empty' };
      const { calendar } = loadMissionConfig();
      const prompt = cal.buildParsePrompt({
        text,
        nowIso: localIsoNow(),
        timeZone: timeZone(),
        categories: calendar.categories,
      });
      const res = await job('parse', prompt, { lean: true });
      if (!res.ok) return res;
      const parsed = cal.normalizeDraft(res.answer, calendar.categories);
      return parsed.ok ? { ...parsed, costUsd: res.costUsd } : parsed;
    })
  );

  // The calendars a new event can go to, as opaque keys (a calendar id is an
  // email address; the renderer never sees one).
  ipcMain.handle('mission:cal-calendars', () =>
    guarded('calendars', async () => {
      try {
        return { ok: true, calendars: await gcal.listCalendars() };
      } catch (err) {
        return gcalFailure(err);
      }
    })
  );

  // Creates the confirmed draft in the chosen calendar through the Calendar
  // API - no model. {draft, calendar}: the draft is re-validated (it has been
  // through the renderer since PARSE), the key must be one gcal handed out.
  ipcMain.handle('mission:cal-create', (_event, req) =>
    guarded('create', async () => {
      const key = req && typeof req.calendar === 'string' && CAL_KEY_RE.test(req.calendar) ? req.calendar : null;
      if (!key) return { ok: false, reason: 'bad-draft' };
      const { calendar } = loadMissionConfig();
      const checked = cal.normalizeDraft(req.draft, calendar.categories);
      if (!checked.ok) return checked;
      // Same throttle as edits: a renderer looping creates cannot flood the calendar.
      const nowMs = Date.now();
      if (nowMs - lastCreateAt < UPDATE_GAP_MS) return { ok: false, reason: 'rate-limited' };
      // And a ceiling per window: one a second would still be 3600 an hour.
      createTimes = createTimes.filter((at) => nowMs - at < CREATE_WINDOW_MS);
      if (createTimes.length >= MAX_CREATES_PER_WINDOW) return { ok: false, reason: 'rate-limited' };
      createTimes.push(nowMs);
      lastCreateAt = nowMs;
      try {
        const { event } = await gcal.createEvent(key, checked.draft, calendar.categories);
        rememberEvents([event]);
        return { ok: true, event };
      } catch (err) {
        // A network error can land after Google stored the event: say so
        // rather than invite a retry that duplicates it.
        if (err && err.reason === 'gcal-network') return { ok: false, reason: 'maybe-created' };
        return gcalFailure(err);
      }
    })
  );
}

module.exports = { registerCalendarIpc, defaultPickClientFile };
