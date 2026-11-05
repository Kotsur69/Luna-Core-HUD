// ============================================================================
// LunaCore - Google Calendar API client (read + event edits, OAuth 2.0)
// ----------------------------------------------------------------------------
// Mission Control's agenda and month grid read the calendar through this
// module, straight from the Calendar API v3: no model call, no cost, and every
// calendar the user has ticked in Google Calendar (not only the primary one).
//
// Auth is the installed-app flow Google documents for desktop apps:
//   - the user's own OAuth client (a "Desktop app" client from their Google
//     Cloud project), dropped at <user config>/google-oauth.local.json;
//   - browser consent with PKCE (S256) and a random `state`, the redirect
//     caught by a one-shot loopback server on 127.0.0.1:<random port>;
//   - scopes calendar.readonly (the calendar list) + calendar.events (read
//     and edit events - never calendars, sharing or settings). A token from
//     before editing existed has only the first; an edit then fails with
//     gcal-scope and the UI asks for one reconnect;
//   - only events main itself listed from a writable calendar can be edited
//     (the `editable` map below): the renderer names an event id, never a calendar;
//   - the refresh token is stored encrypted with Electron safeStorage in
//     gcal-token.local.json. No safeStorage -> it lives in memory only and
//     the user reconnects after a restart; it is never written in clear.
//
// Every value from Google is untrusted: events are rebuilt field by field,
// capped, and validated with the same rules as the rest of missioncal.js.
//
// Split: gcalauth.js holds the OAuth flow and token storage, gcalevents.js
// the pure event/calendar mapping; this file is the API client itself.
// ============================================================================

'use strict';

const crypto = require('crypto');
const {
  createGcalCredentials,
  GcalError,
  parseClientFile,
  buildAuthUrl,
  startRedirectServer,
  base64url,
  readJson,
  CLIENT_FILE,
  SCOPE,
  FETCH_TIMEOUT_MS,
} = require('./gcalauth');
const {
  normalizeEvent,
  mergeEvents,
  visibleCalendars,
  googleErrorDetail,
  writeDenial,
  EVENT_ID_RE,
} = require('./gcalevents');

const API = 'https://www.googleapis.com/calendar/v3';
const MAX_PAGES = 5;
const PAGE_SIZE = 250;
/** Event ids remembered as editable; the oldest fall out first. */
const MAX_EDITABLE = 3000;

/**
 * @param {{fetchImpl?:Function, openExternal?:Function, safeStorage?:object,
 *   clientPath?:string, tokenPath?:string}} [deps]
 *   Injectable so tests never touch the network, a browser, the keychain or
 *   the real config folder.
 */
function createGcal(deps = {}) {
  const doFetch = deps.fetchImpl || ((...a) => fetch(...a));
  // Filled by listEvents (see remember()); cleared with the credentials.
  const editable = new Map();
  /** key -> calendar the user may add events to; the renderer only ever sees the key. */
  const targets = new Map();
  const creds = createGcalCredentials(deps, {
    onForget: () => {
      editable.clear();
      targets.clear();
    },
  });

  async function apiRequest(method, path, query, body) {
    const token = await creds.accessToken();
    let res;
    try {
      res = await doFetch(`${API}${path}?${new URLSearchParams(query)}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch (err) {
      throw new GcalError('gcal-network', err && err.message);
    }
    // 401 or 403 indicates authentication failure. Google's error response for
    // invalid_grant is {error: "invalid_grant", error_description: "..."}.
    if (res.status === 401 || res.status === 403) {
      const body = await res.json().catch(() => ({}));
      creds.dropAccess();
      // Only clear credentials when Google explicitly says the grant is invalid.
      // Other 403 errors might be transient - don't delete the token file.
      if (body && body.error === 'invalid_grant') {
        creds.forget();
        throw new GcalError('gcal-auth', body.error_description || 'refresh token invalid');
      }
      const detail = `HTTP ${res.status} on ${path}${googleErrorDetail(body)}`;
      if (method !== 'GET' && res.status === 403) throw new GcalError(writeDenial(body), detail);
      throw new GcalError('gcal-failed', detail);
    }
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new GcalError('gcal-failed', `HTTP ${res.status} on ${path}${googleErrorDetail(body)}`);
    }
    // A DELETE answers 204 with no body.
    if (res.status === 204) return {};
    try {
      return await res.json();
    } catch (err) {
      // A write that answered 2xx was stored even if its reply is unreadable:
      // gcal-network makes the caller say "may have been created", not "retry".
      throw new GcalError(method === 'GET' ? 'gcal-failed' : 'gcal-network', `unreadable reply on ${path}`);
    }
  }

  async function calendarEvents(cal, fromIso, toIso, categories) {
    const out = [];
    let pageToken = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const query = {
        timeMin: fromIso,
        timeMax: toIso,
        singleEvents: 'true',
        orderBy: 'startTime',
        maxResults: String(PAGE_SIZE),
        ...(pageToken ? { pageToken } : {}),
      };
      const body = await apiRequest('GET', `/calendars/${encodeURIComponent(cal.id)}/events`, query);
      for (const raw of Array.isArray(body.items) ? body.items : []) {
        const ev = normalizeEvent(raw, cal, categories);
        if (!ev) continue;
        if (ev.editable) remember(ev.id, { cal, allDay: ev.allDay });
        out.push(ev);
      }
      pageToken = typeof body.nextPageToken === 'string' ? body.nextPageToken : null;
      if (!pageToken) break;
    }
    return out;
  }

  /**
   * Every event overlapping [from, to) across the visible calendars. The API's
   * timeMin/timeMax overlap rule already includes events that started before
   * the window and are still running in it.
   */
  async function listEvents({ fromIso, toIso, categories }) {
    const cals = await loadCalendars();
    const lists = await Promise.all(cals.map((c) => calendarEvents(c, fromIso, toIso, categories)));
    return { events: mergeEvents(lists) };
  }

  const calendarKey = (id) => crypto.createHash('sha256').update(id).digest('hex').slice(0, 16);

  /** The visible calendars; refreshes the writable `targets` as a side effect. */
  async function loadCalendars() {
    const list = await apiRequest('GET', '/users/me/calendarList', { minAccessRole: 'reader', maxResults: '250' });
    const cals = visibleCalendars(list.items);
    targets.clear();
    for (const c of cals) if (c.writable) targets.set(calendarKey(c.id), c);
    return cals;
  }

  /**
   * Calendars a new event can go to, primary first, as {key, name, color, primary}.
   * Keys are hashes of the calendar ids: a calendar id is an email address.
   */
  async function listCalendars() {
    await loadCalendars();
    return [...targets.entries()]
      .map(([key, c]) => ({ key, name: c.name, color: c.color, primary: c.primary }))
      .sort((a, b) => b.primary - a.primary || a.name.localeCompare(b.name));
  }

  /**
   * Creates `draft` (validated: missioncal.normalizeDraft) in the calendar
   * behind `key`. The category becomes the event colour. `opts.recurrence`
   * (RRULE lines from gcalrecur.js only) and `opts.tag` (private
   * extendedProperties, so the event can later be told apart as ours) are
   * built by main, never taken from the renderer.
   * @returns {Promise<{event:object}>} the event as Google stored it
   */
  async function createEvent(key, draft, categories, opts = {}) {
    const cal = typeof key === 'string' ? targets.get(key) : null;
    if (!cal) throw new GcalError('gcal-not-editable', 'unknown calendar');
    const when = (v) => (draft.allDay ? { date: v } : { dateTime: v });
    const category = categories.find((c) => c.id === draft.category);
    const body = {
      summary: draft.title,
      start: when(draft.start),
      end: when(draft.end),
      ...(draft.location ? { location: draft.location } : {}),
      ...(draft.description ? { description: draft.description } : {}),
      ...(category && category.colorId ? { colorId: category.colorId } : {}),
      ...(opts.recurrence ? { recurrence: opts.recurrence } : {}),
      ...(opts.tag ? { extendedProperties: { private: opts.tag } } : {}),
    };
    const raw = await apiRequest('POST', `/calendars/${encodeURIComponent(cal.id)}/events`, {}, body);
    const ev = normalizeEvent(raw, cal, categories);
    if (!ev) throw new GcalError('gcal-failed', 'unreadable created event');
    if (ev.editable) remember(ev.id, { cal, allDay: ev.allDay });
    const { uid, ...event } = ev;
    return { event };
  }

  /**
   * id -> {cal, allDay} of events listed from a writable calendar. An id met
   * in two calendars maps to null: which copy the user meant is unknown, so
   * neither is edited.
   */
  function remember(id, info) {
    const prev = editable.get(id);
    const value = prev === null || (prev && prev.cal.id !== info.cal.id) ? null : info;
    editable.delete(id);
    editable.set(id, value);
    if (editable.size > MAX_EDITABLE) editable.delete(editable.keys().next().value);
  }

  /**
   * Changes title, times and location of an event listed earlier. `draft` is
   * already validated (missioncal.normalizeDraft); the all-day kind cannot
   * change here, and colour, guests and description are left as they are.
   * `opts.calendar` (a key from listCalendars) names the calendar of an event
   * not listed in this session - main checks ownership first (gcalbills.js);
   * `opts.recurrence` replaces the RRULE.
   * @returns {Promise<{event:object}>} the event as Google now has it
   */
  async function updateEvent(id, draft, categories, opts = {}) {
    const target = typeof opts.calendar === 'string' ? targets.get(opts.calendar) : null;
    const known = typeof id === 'string' ? editable.get(id) || (target ? { cal: target, allDay: draft.allDay } : null) : null;
    if (!known) throw new GcalError('gcal-not-editable');
    if (draft.allDay !== known.allDay) throw new GcalError('bad-draft', 'all-day kind changed');
    const when = (v) => (known.allDay ? { date: v } : { dateTime: v });
    const raw = await apiRequest(
      'PATCH',
      `/calendars/${encodeURIComponent(known.cal.id)}/events/${encodeURIComponent(id)}`,
      {},
      {
        summary: draft.title,
        location: draft.location,
        start: when(draft.start),
        end: when(draft.end),
        ...(opts.recurrence ? { recurrence: opts.recurrence } : {}),
      }
    );
    const ev = normalizeEvent(raw, known.cal, categories);
    if (!ev) throw new GcalError('gcal-failed', 'unreadable updated event');
    const { uid, ...event } = ev;
    return { event };
  }

  /**
   * GET / DELETE of one event in a writable calendar named by its key, for
   * gcalbills.js. Raw event (untrusted) or {} for a delete.
   */
  async function eventByKey(method, key, id) {
    if (method !== 'GET' && method !== 'DELETE') throw new GcalError('gcal-failed', 'bad method');
    const cal = typeof key === 'string' ? targets.get(key) : null;
    if (!cal || typeof id !== 'string' || !EVENT_ID_RE.test(id)) throw new GcalError('gcal-not-editable');
    return apiRequest(method, `/calendars/${encodeURIComponent(cal.id)}/events/${encodeURIComponent(id)}`, {});
  }

  return {
    status: creds.status,
    connect: creds.connect,
    listEvents,
    listCalendars,
    createEvent,
    updateEvent,
    eventByKey,
    importClient: creds.importClient,
  };
}

module.exports = {
  createGcal,
  GcalError,
  parseClientFile,
  buildAuthUrl,
  normalizeEvent,
  mergeEvents,
  visibleCalendars,
  startRedirectServer,
  base64url,
  readJson,
  CLIENT_FILE,
  SCOPE,
};
