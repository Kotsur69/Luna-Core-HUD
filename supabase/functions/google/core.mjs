// ============================================================================
// LunaCore - Supabase Edge Function `google`: the pure part (phase 5)
// ----------------------------------------------------------------------------
// docs/DONE_CLOUD_SYNC_PLAN.md phase 5. The phone has no Google login of its own:
// this function holds one refresh token (a Supabase secret, obtained once with
// scripts/google-server-token.js) and answers three POST actions:
//
//   {action:'events', from, to}  events of the calendars ticked in Google
//                                Calendar, overlapping [from, to) (<= 35 days)
//   {action:'create', draft}     one event in the primary calendar
//   {action:'mail'}              unread count in the inbox + the latest unread
//                                (sender name, subject, time): metadata only,
//                                the gmail.metadata scope can't read bodies
//
// Every call must carry a Supabase session of OWNER_USER_ID (checked against
// the Auth server, not just decoded), and a browser origin must be listed in
// ALLOWED_ORIGINS. Every value from Google is rebuilt field by field and
// capped, the same rules as src/gcal.js on a PC. No Deno globals here, so
// node --test runs it (test/googlefn.test.mjs); index.js is the Deno entry.
// ============================================================================

export const SCOPES = ['calendar.readonly', 'calendar.events', 'gmail.metadata'].map((s) => `https://www.googleapis.com/auth/${s}`);

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const CAL_API = 'https://www.googleapis.com/calendar/v3';
const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const FETCH_TIMEOUT_MS = 10000;
const DEFAULT_TTL_MS = 3600000;
const EXPIRY_SLACK_MS = 60000;
const MAX_BODY_CHARS = 4096;
const MAX_RANGE_MS = 35 * 86400000;
const MAX_CALENDARS = 25;
const MAX_PAGES = 2;
const PAGE_SIZE = 250;
const MAX_EVENTS = 500;
const MAX_TITLE_CHARS = 200;
const MAX_TEXT_CHARS = 500;
const MAX_NAME_CHARS = 80;
const LATEST_MAIL = 5;
/** A new event starts at most this far back or ahead (a phone typo, or a stolen session, can't litter year 9999). */
const CREATE_PAST_MS = 31 * 86400000;
const CREATE_AHEAD_MS = 400 * 86400000;
/** The same week asked again within this long is answered from memory (Google fan-out: up to 51 calls). */
const EVENTS_CACHE_MS = 30000;
const MAX_CACHED_WINDOWS = 8;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** Timed values must carry a zone: Google needs one, and so does "today" on the phone. */
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
const HEX_RE = /^#[0-9a-f]{6}$/i;
const EVENT_ID_RE = /^[A-Za-z0-9_@.-]{1,256}$/;
const MESSAGE_ID_RE = /^[A-Za-z0-9]{1,64}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ORIGIN_RE = /^https?:\/\/[a-z0-9.-]{1,253}(:\d{1,5})?$/;

/** Typed failure: `reason` goes to the phone, `detail` only to the function log. */
export class GoogleError extends Error {
  constructor(reason, detail) {
    super(detail || reason);
    this.reason = reason;
  }
}

/** C0/C1 controls, zero-width marks and bidi overrides: they could make a subject or sender lie on screen. */
const isHidden = (c) => c < 32 || (c >= 127 && c <= 159) || (c >= 0x200b && c <= 0x200f) || (c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069);
const isHighSurrogate = (c) => c >= 0xd800 && c <= 0xdbff;

/** Hidden characters become spaces; trimmed and capped without cutting an emoji in half. */
export function clamp(value, max) {
  if (typeof value !== 'string') return '';
  let out = '';
  for (const ch of value) out += isHidden(ch.charCodeAt(0)) ? ' ' : ch;
  out = out.trim();
  if (out.length <= max) return out;
  const cut = out.slice(0, max);
  return isHighSurrogate(cut.charCodeAt(max - 1)) ? cut.slice(0, -1) : cut;
}

/**
 * At most `max` calls per `windowMs` in this isolate. Best effort (a cold
 * start resets it), but it stops a stolen session or a refresh loop from
 * burning the Google quota the PCs share.
 */
export function createLimiter(max, windowMs, now = Date.now) {
  let stamps = [];
  return () => {
    const t = now();
    stamps = stamps.filter((s) => t - s < windowMs);
    if (stamps.length >= max) return false;
    stamps = [...stamps, t];
    return true;
  };
}

export function validTime(value, allDay) {
  if (typeof value !== 'string') return null;
  return (allDay ? DATE_RE : DATETIME_RE).test(value) && !Number.isNaN(Date.parse(value)) ? value : null;
}

/** All-day dates sort as local midnight, before the timed events of their day. */
export function compareEvents(a, b) {
  const at = (ev) => Date.parse(ev.allDay ? `${ev.start}T00:00:00` : ev.start);
  return at(a) - at(b) || (b.allDay === true) - (a.allDay === true);
}

/** ALLOWED_ORIGINS ("https://a.vercel.app, http://localhost:4173") -> a Set; junk entries are dropped, none set = no browser allowed. */
export function parseOrigins(raw) {
  const list = typeof raw === 'string' ? raw.split(',').map((s) => s.trim().replace(/\/$/, '').toLowerCase()) : [];
  return new Set(list.filter((o) => ORIGIN_RE.test(o)));
}

export function corsHeaders(origin, allowed) {
  const base = { Vary: 'Origin' };
  if (!origin || !allowed.has(origin.toLowerCase())) return base;
  return {
    ...base,
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
    'Access-Control-Max-Age': '600',
  };
}

/** The request body -> {ok:true, action, ...} or {ok:false}. */
export function parseRequest(body, now = Date.now()) {
  if (!body || typeof body !== 'object') return { ok: false };
  if (body.action === 'mail') return { ok: true, action: 'mail' };
  if (body.action === 'events') {
    const from = validTime(body.from, false);
    const to = validTime(body.to, false);
    if (!from || !to) return { ok: false };
    const span = Date.parse(to) - Date.parse(from);
    if (span <= 0 || span > MAX_RANGE_MS) return { ok: false };
    return { ok: true, action: 'events', from, to };
  }
  if (body.action === 'create') {
    const draft = normalizeDraft(body.draft);
    if (!draft) return { ok: false };
    // An all-day date parses as UTC midnight: close enough for a window this wide.
    const start = Date.parse(draft.start);
    if (start < now - CREATE_PAST_MS || start > now + CREATE_AHEAD_MS) return { ok: false };
    return { ok: true, action: 'create', draft };
  }
  return { ok: false };
}

/** A new event from the phone, or null. End is exclusive (all-day: the day after). */
export function normalizeDraft(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const allDay = raw.allDay === true;
  const title = clamp(raw.title, MAX_TITLE_CHARS);
  const start = validTime(raw.start, allDay);
  const end = validTime(raw.end, allDay);
  if (!title || !start || !end || Date.parse(end) <= Date.parse(start)) return null;
  if (Date.parse(end) - Date.parse(start) > MAX_RANGE_MS) return null;
  return { title, start, end, allDay, location: clamp(raw.location, MAX_TEXT_CHARS) };
}

/** A calendar's display name; '' when the only name there is an email address. */
function calendarName(c) {
  const name = clamp(c.summaryOverride || c.summary, MAX_NAME_CHARS);
  return name && !name.includes('@') ? name : '';
}

/** The calendars shown in Google Calendar (ticked in its sidebar), as src/gcal.js. */
export function visibleCalendars(items) {
  return (Array.isArray(items) ? items : [])
    .filter((c) => c && typeof c.id === 'string' && c.id && (c.selected === true || c.primary === true))
    .slice(0, MAX_CALENDARS)
    .map((c) => ({
      id: c.id,
      name: calendarName(c),
      color: typeof c.backgroundColor === 'string' && HEX_RE.test(c.backgroundColor) ? c.backgroundColor : null,
    }));
}

/** One API event in the phone's shape; null for cancelled, declined or unusable ones. */
export function normalizeEvent(raw, cal) {
  if (!raw || typeof raw !== 'object' || raw.status === 'cancelled') return null;
  const self = Array.isArray(raw.attendees) ? raw.attendees.find((a) => a && a.self) : null;
  if (self && self.responseStatus === 'declined') return null;
  const s = raw.start || {};
  const e = raw.end || {};
  const allDay = typeof s.date === 'string';
  const start = validTime(allDay ? s.date : s.dateTime, allDay);
  if (!start) return null;
  return {
    id: typeof raw.id === 'string' && EVENT_ID_RE.test(raw.id) ? raw.id : '',
    uid: typeof raw.iCalUID === 'string' ? raw.iCalUID.slice(0, 300) : '',
    title: clamp(raw.summary, MAX_TITLE_CHARS) || '(no title)',
    start,
    end: validTime(allDay ? e.date : e.dateTime, allDay) || start,
    allDay,
    location: clamp(raw.location, MAX_TEXT_CHARS),
    calendar: cal.name,
    color: cal.color,
  };
}

/** One copy of an event that sits in two calendars; sorted, capped, `uid` dropped. */
export function mergeEvents(lists) {
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

/** `"Jan Kowalski" <jan@x.pl>` -> Jan Kowalski; a bare address stays an address. */
export function senderName(from) {
  const raw = clamp(from, 300);
  const m = /^(.*?)\s*<([^>]*)>$/.exec(raw);
  const name = m ? m[1].replace(/^"(.*)"$/, '$1').trim() : '';
  return clamp(name || (m ? m[2] : raw), MAX_NAME_CHARS);
}

/** A messages.get (format=metadata) reply -> {from, subject, at} or null. */
export function mailItem(msg) {
  if (!msg || typeof msg !== 'object') return null;
  const headers = msg.payload && Array.isArray(msg.payload.headers) ? msg.payload.headers : [];
  const header = (name) => {
    const hit = headers.find((x) => x && typeof x.name === 'string' && x.name.toLowerCase() === name);
    return hit && typeof hit.value === 'string' ? hit.value : '';
  };
  const at = Number(msg.internalDate);
  return {
    from: senderName(header('from')),
    subject: clamp(header('subject'), MAX_TITLE_CHARS) || '(no subject)',
    at: Number.isFinite(at) && at > 0 ? at : null,
  };
}

/**
 * Google calls with one refresh token. The access token is kept for the life
 * of the isolate, so a warm function doesn't refresh on every call.
 * @param {{clientId:string, clientSecret:string, refreshToken:string, fetchImpl?:Function, now?:()=>number}} opts
 */
export function createGoogle({ clientId, clientSecret, refreshToken, fetchImpl = fetch, now = Date.now }) {
  let access = null; // {token, expiresAt}
  let refreshing = null; // one token request at a time, shared by concurrent calls
  const weeks = new Map(); // `${from}|${to}` -> {at, reply}

  async function call(url, init) {
    try {
      return await fetchImpl(url, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    } catch (err) {
      throw new GoogleError('google-network', err && err.message);
    }
  }

  function accessToken() {
    if (access && access.expiresAt > now()) return Promise.resolve(access.token);
    refreshing ??= refresh().finally(() => (refreshing = null));
    return refreshing;
  }

  async function refresh() {
    const res = await call(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: 'refresh_token' }).toString(),
    });
    const body = await res.json().catch(() => ({}));
    // invalid_grant = revoked, expired (a "Testing" app's 7 days) or the password changed.
    if (!res.ok) throw new GoogleError(body.error === 'invalid_grant' ? 'google-auth' : 'google-failed', `token: ${String(body.error)}`);
    if (typeof body.access_token !== 'string') throw new GoogleError('google-failed', 'no access_token');
    const ttl = Number.isFinite(body.expires_in) ? body.expires_in * 1000 : DEFAULT_TTL_MS;
    access = { token: body.access_token, expiresAt: now() + ttl - EXPIRY_SLACK_MS };
    return access.token;
  }

  async function api(method, url, body) {
    const token = await accessToken();
    const res = await call(url, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (res.status === 401) access = null;
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      const msg = err && err.error && typeof err.error.message === 'string' ? err.error.message.slice(0, 300) : '';
      // 403 naming a scope: the token was made without it (re-run the token script).
      const reason = res.status === 403 && /scope|insufficient/i.test(msg) ? 'google-scope' : 'google-failed';
      throw new GoogleError(reason, `HTTP ${res.status} ${method} ${logPath(url)} ${msg}`);
    }
    try {
      return await res.json();
    } catch {
      throw new GoogleError('google-failed', `unreadable reply ${logPath(url)}`);
    }
  }

  async function calendarEvents(cal, from, to) {
    const out = [];
    let pageToken = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const q = new URLSearchParams({ timeMin: from, timeMax: to, singleEvents: 'true', orderBy: 'startTime', maxResults: String(PAGE_SIZE) });
      if (pageToken) q.set('pageToken', pageToken);
      const body = await api('GET', `${CAL_API}/calendars/${encodeURIComponent(cal.id)}/events?${q}`);
      for (const raw of Array.isArray(body.items) ? body.items : []) {
        const ev = normalizeEvent(raw, cal);
        if (ev) out.push(ev);
      }
      pageToken = typeof body.nextPageToken === 'string' ? body.nextPageToken : null;
      if (!pageToken) break;
    }
    return out;
  }

  async function events(from, to) {
    const key = `${from}|${to}`;
    const hit = weeks.get(key);
    if (hit && now() - hit.at < EVENTS_CACHE_MS) return hit.reply;
    const list = await api('GET', `${CAL_API}/users/me/calendarList?minAccessRole=reader&maxResults=250`);
    const cals = visibleCalendars(list.items);
    const lists = await Promise.all(cals.map((c) => calendarEvents(c, from, to)));
    const reply = { events: mergeEvents(lists) };
    weeks.delete(key);
    weeks.set(key, { at: now(), reply });
    if (weeks.size > MAX_CACHED_WINDOWS) weeks.delete(weeks.keys().next().value);
    return reply;
  }

  async function create(draft) {
    const when = (v) => (draft.allDay ? { date: v } : { dateTime: v });
    const raw = await api('POST', `${CAL_API}/calendars/primary/events`, {
      summary: draft.title,
      start: when(draft.start),
      end: when(draft.end),
      ...(draft.location ? { location: draft.location } : {}),
    });
    // The week the phone reads next must show the new event.
    weeks.clear();
    const ev = normalizeEvent(raw, { name: '', color: null });
    if (!ev) throw new GoogleError('google-failed', 'unreadable created event');
    const { uid, ...event } = ev;
    return { event };
  }

  async function mail() {
    const label = await api('GET', `${GMAIL_API}/labels/INBOX`);
    // gmail.metadata refuses `q`; label ids filter the same way.
    const list = await api('GET', `${GMAIL_API}/messages?labelIds=INBOX&labelIds=UNREAD&maxResults=${LATEST_MAIL}`);
    const ids = (Array.isArray(list.messages) ? list.messages : [])
      .map((m) => m && m.id)
      .filter((id) => typeof id === 'string' && MESSAGE_ID_RE.test(id))
      .slice(0, LATEST_MAIL);
    const q = 'format=metadata&metadataHeaders=From&metadataHeaders=Subject';
    const msgs = await Promise.all(ids.map((id) => api('GET', `${GMAIL_API}/messages/${id}?${q}`)));
    const unread = Number(label.messagesUnread);
    return {
      unread: Number.isInteger(unread) && unread >= 0 ? unread : 0,
      latest: msgs.map(mailItem).filter(Boolean),
    };
  }

  return { events, create, mail };
}

/** A Google URL for the log: no query, and calendar ids (often email addresses) masked. */
export const logPath = (url) => url.split('?')[0].replace(/\/calendars\/[^/]+/, '/calendars/*');

const STATUS = {
  'bad-request': 400,
  'rate-limited': 429,
  'not-logged-in': 401,
  'not-owner': 403,
  'bad-origin': 403,
  'not-configured': 503,
  'google-auth': 502,
  'google-scope': 502,
  'google-network': 504,
  'google-failed': 502,
};

/** The publishable key the Auth server wants next to a user token. */
function publishableKey(env) {
  try {
    const keys = JSON.parse(env.SUPABASE_PUBLISHABLE_KEYS || '{}');
    if (keys && typeof keys.default === 'string') return keys.default;
  } catch {
    // Older projects only have the legacy anon key.
  }
  return env.SUPABASE_ANON_KEY || '';
}

/** Who sent this token, asked from the Auth server (a decoded but unchecked JWT proves nothing). */
async function sessionUser(req, env, fetchImpl) {
  const auth = req.headers.get('authorization') || '';
  if (!/^Bearer [A-Za-z0-9._-]{20,4096}$/.test(auth) || !env.SUPABASE_URL) return null;
  let res;
  try {
    res = await fetchImpl(`${env.SUPABASE_URL}/auth/v1/user`, {
      headers: { Authorization: auth, apikey: publishableKey(env) },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  const user = await res.json().catch(() => null);
  return user && typeof user.id === 'string' ? user.id : null;
}

/**
 * The whole request -> Response. `google` is created lazily from the env and
 * kept by the caller (index.js), so its access token survives warm calls;
 * `limits` (per action: () => boolean) is kept there for the same reason.
 * @param {Request} req
 * @param {{env:Record<string,string|undefined>, fetchImpl?:Function, google:()=>ReturnType<typeof createGoogle>|null,
 *   limits?:Record<string,()=>boolean>, log?:Function}} deps
 */
export async function handle(req, { env, fetchImpl = fetch, google, limits = {}, log = () => {} }) {
  const origin = req.headers.get('origin') || '';
  const cors = corsHeaders(origin, parseOrigins(env.ALLOWED_ORIGINS));
  const reply = (status, body) =>
    new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
  const fail = (reason) => reply(STATUS[reason] || 500, { error: reason });

  // A browser on an unlisted origin gets nothing; a request with no Origin
  // (curl, a script with a stolen token) still has to pass the owner check.
  if (origin && !cors['Access-Control-Allow-Origin']) return fail('bad-origin');
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (req.method !== 'POST') return fail('bad-request');

  const owner = typeof env.OWNER_USER_ID === 'string' && UUID_RE.test(env.OWNER_USER_ID) ? env.OWNER_USER_ID.toLowerCase() : null;
  const uid = await sessionUser(req, env, fetchImpl);
  if (!uid) return fail('not-logged-in');
  if (!owner) return fail('not-configured');
  if (uid.toLowerCase() !== owner) return fail('not-owner');

  if (Number(req.headers.get('content-length')) > MAX_BODY_CHARS) return fail('bad-request');
  const text = await req.text().catch(() => '');
  if (!text || text.length > MAX_BODY_CHARS) return fail('bad-request');
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return fail('bad-request');
  }
  const parsed = parseRequest(body);
  if (!parsed.ok) return fail('bad-request');
  const allow = limits[parsed.action];
  if (allow && !allow()) return fail('rate-limited');

  const g = google();
  if (!g) return fail('not-configured');
  try {
    if (parsed.action === 'events') return reply(200, await g.events(parsed.from, parsed.to));
    if (parsed.action === 'create') return reply(200, await g.create(parsed.draft));
    return reply(200, await g.mail());
  } catch (err) {
    const reason = err instanceof GoogleError ? err.reason : 'google-failed';
    log(`[google] ${parsed.action} failed: ${reason}: ${err && err.message}`);
    return fail(reason);
  }
}

/** The Google client from the function's secrets, or null while any is missing. */
export function googleFromEnv(env, fetchImpl) {
  const clientId = env.GOOGLE_CLIENT_ID;
  const clientSecret = env.GOOGLE_CLIENT_SECRET;
  const refreshToken = env.GOOGLE_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) return null;
  return createGoogle({ clientId, clientSecret, refreshToken, ...(fetchImpl ? { fetchImpl } : {}) });
}
