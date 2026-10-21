// ============================================================================
// LunaCore - Supabase Edge Function `push` (logic; index.js is the Deno entry)
// ----------------------------------------------------------------------------
// docs/REMOTE_HOST_PLAN.md H4. Sends Web Push to the owner's phone
// subscriptions (table push_subscriptions) with the VAPID key from the
// function's secrets. Two callers:
//
//   a host / PC   (the owner's session token)  {event, machine, key, window?, level?}
//                 event = approval | done | failed | usage
//   the schedule  (header x-cron-secret = CRON_SECRET)  {event: 'offline-check'}
//                 the default host's heartbeat (snapshots kind 'host') older
//                 than OFFLINE_MS -> "host offline", once per outage
//
// Bodies are generic and built here from the event alone ("Approval needed on
// KT-PC-LLM"): a caller's text never reaches a notification, so no command or
// code ever shows on a lock screen. Each `key` fires once (table push_sent,
// insert-or-ignore). A subscription the push service answers 404 / 410 for is
// deleted.
//
// Secrets: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT (mailto:...),
// OWNER_USER_ID, CRON_SECRET, PUSH_LANG (pl | en, default pl); SUPABASE_URL
// and SUPABASE_SERVICE_ROLE_KEY are provided by the platform.
// ============================================================================

const FETCH_TIMEOUT_MS = 10000;
const MAX_BODY_CHARS = 1024;
const MAX_SUBSCRIPTIONS = 20;
export const OFFLINE_MS = 5 * 60 * 1000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MACHINE_RE = /^[A-Za-z0-9-]{1,63}$/;
const KEY_RE = /^[A-Za-z0-9:._-]{1,120}$/;
const HOST_EVENTS = ['approval', 'done', 'failed', 'usage'];
const WINDOWS = ['fiveHour', 'sevenDay'];
const LEVELS = [80, 95];

const TEXT = {
  pl: {
    approval: 'Potrzebna zgoda na {machine}',
    done: 'Sesja zakonczona na {machine}',
    failed: 'Sesja nie powiodla sie na {machine}',
    offline: 'Host {machine} jest offline',
    fiveHour: 'Limit Claude 5 h: {level}%',
    sevenDay: 'Limit Claude tygodniowy: {level}%',
  },
  en: {
    approval: 'Approval needed on {machine}',
    done: 'Session finished on {machine}',
    failed: 'Session failed on {machine}',
    offline: 'Host {machine} is offline',
    fiveHour: 'Claude 5 h limit at {level}%',
    sevenDay: 'Claude weekly limit at {level}%',
  },
};

const fill = (s, vars) => s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));

/**
 * The notification for an event: {title, body, tag, url}. Only validated
 * values go in (machine name, window, level), never free text.
 */
export function notification(req, lang = 'pl') {
  const t = TEXT[lang] || TEXT.pl;
  if (req.event === 'usage') {
    return { title: 'LunaCore', body: fill(t[req.window], { level: req.level }), tag: `usage-${req.window}`, url: '/#today' };
  }
  return { title: 'LunaCore', body: fill(t[req.event], { machine: req.machine }), tag: `${req.event}-${req.machine}`, url: '/#host' };
}

/** A host's request body -> {ok: true, event, machine, key, window?, level?} or {ok: false}. */
export function parsePushRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false };
  if (body.event === 'offline-check') return { ok: true, event: 'offline-check' };
  if (!HOST_EVENTS.includes(body.event)) return { ok: false };
  if (typeof body.machine !== 'string' || !MACHINE_RE.test(body.machine)) return { ok: false };
  if (typeof body.key !== 'string' || !KEY_RE.test(body.key)) return { ok: false };
  if (body.event === 'usage') {
    if (!WINDOWS.includes(body.window) || !LEVELS.includes(body.level)) return { ok: false };
    return { ok: true, event: 'usage', machine: body.machine, key: body.key, window: body.window, level: body.level };
  }
  return { ok: true, event: body.event, machine: body.machine, key: body.key };
}

/**
 * The offline check's verdict: the key to fire once for this outage, or null.
 * @param {{machine: string|null, updatedAt: number|null}} seen
 */
export function offlineKey(seen, now) {
  if (!seen || typeof seen.machine !== 'string' || !MACHINE_RE.test(seen.machine)) return null;
  if (!Number.isFinite(seen.updatedAt) || now - seen.updatedAt <= OFFLINE_MS) return null;
  return `offline:${seen.machine}:${seen.updatedAt}`;
}

/** Same-length compare, so the cron secret can't be guessed by timing. */
export function sameSecret(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function sessionUser(req, env, fetchImpl) {
  const auth = req.headers.get('authorization') || '';
  if (!/^Bearer [A-Za-z0-9._-]{20,4096}$/.test(auth) || !env.SUPABASE_URL) return null;
  try {
    const res = await fetchImpl(`${env.SUPABASE_URL}/auth/v1/user`, {
      headers: { Authorization: auth, apikey: env.SUPABASE_ANON_KEY || '' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const user = await res.json().catch(() => null);
    return user && typeof user.id === 'string' ? user.id : null;
  } catch {
    return null;
  }
}

/**
 * The tables this function touches, over PostgREST with the service role.
 * @returns {{subscriptions, dropSubscription, claimOnce, defaultHostSeen}}
 */
export function createDb({ url, serviceKey, fetchImpl = fetch }) {
  const headers = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' };
  const rest = (path, init = {}) =>
    fetchImpl(`${url}/rest/v1/${path}`, { ...init, headers: { ...headers, ...(init.headers || {}) }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  const enc = encodeURIComponent;
  return {
    async subscriptions(userId) {
      const res = await rest(`push_subscriptions?select=id,endpoint,p256dh,auth&user_id=eq.${enc(userId)}&limit=${MAX_SUBSCRIPTIONS}`);
      if (!res.ok) throw new Error(`subscriptions ${res.status}`);
      const rows = await res.json();
      return Array.isArray(rows) ? rows : [];
    },
    async dropSubscription(id) {
      await rest(`push_subscriptions?id=eq.${enc(id)}`, { method: 'DELETE' });
    },
    /** true the first time `key` is seen for the user, false after. */
    async claimOnce(userId, key) {
      const res = await rest('push_sent?on_conflict=user_id,key', {
        method: 'POST',
        headers: { Prefer: 'resolution=ignore-duplicates,return=representation' },
        body: JSON.stringify({ user_id: userId, key }),
      });
      if (!res.ok) throw new Error(`push_sent ${res.status}`);
      const rows = await res.json();
      return Array.isArray(rows) && rows.length === 1;
    },
    /** The default host (sync unit host:default) and its last heartbeat. */
    async defaultHostSeen(userId) {
      const r1 = await rest(`sync_units?select=value&user_id=eq.${enc(userId)}&scope=eq.config&key=eq.${enc('host:default')}&deleted_at=is.null&limit=1`);
      const units = r1.ok ? await r1.json() : [];
      const machine = Array.isArray(units) && units[0] && units[0].value && units[0].value.machine;
      if (typeof machine !== 'string' || !MACHINE_RE.test(machine)) return null;
      const r2 = await rest(`snapshots?select=updated_at&user_id=eq.${enc(userId)}&kind=eq.host&machine=eq.${enc(machine)}&limit=1`);
      const rows = r2.ok ? await r2.json() : [];
      const at = Array.isArray(rows) && rows[0] ? Date.parse(rows[0].updated_at) : NaN;
      return { machine, updatedAt: Number.isFinite(at) ? at : null };
    },
  };
}

/**
 * Sends one notification to every subscription; drops the gone ones.
 * @returns {Promise<{sent: number, dropped: number}>}
 */
export async function fanOut({ db, sendPush, userId, payload, log }) {
  const subs = await db.subscriptions(userId);
  let sent = 0;
  let dropped = 0;
  for (const s of subs) {
    try {
      await sendPush({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify(payload));
      sent++;
    } catch (err) {
      const status = err && err.statusCode;
      if (status === 404 || status === 410) {
        await db.dropSubscription(s.id);
        dropped++;
      } else {
        log(`[push] send failed: ${status || (err && err.message)}`);
      }
    }
  }
  return { sent, dropped };
}

/**
 * The whole request -> Response.
 * @param {Request} req
 * @param {{env: Record<string, string|undefined>, fetchImpl?: Function,
 *   db: () => ReturnType<typeof createDb>|null, sendPush: Function|null,
 *   now?: () => number, log?: Function}} deps
 */
export async function handle(req, { env, fetchImpl = fetch, db, sendPush, now = Date.now, log = () => {} }) {
  const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
  // Called by the host's Electron process and by the schedule, never by a browser page.
  if (req.method !== 'POST') return reply(400, { error: 'bad-request' });
  const owner = typeof env.OWNER_USER_ID === 'string' && UUID_RE.test(env.OWNER_USER_ID) ? env.OWNER_USER_ID.toLowerCase() : null;
  const d = db();
  if (!owner || !d || !sendPush) return reply(503, { error: 'not-configured' });

  const text = await req.text().catch(() => '');
  if (!text || text.length > MAX_BODY_CHARS) return reply(400, { error: 'bad-request' });
  let parsed;
  try {
    parsed = parsePushRequest(JSON.parse(text));
  } catch {
    parsed = { ok: false };
  }
  if (!parsed.ok) return reply(400, { error: 'bad-request' });

  if (parsed.event === 'offline-check') {
    if (!sameSecret(req.headers.get('x-cron-secret') || '', env.CRON_SECRET || '')) return reply(401, { error: 'not-allowed' });
    const key = offlineKey(await d.defaultHostSeen(owner), now());
    if (!key || !(await d.claimOnce(owner, key))) return reply(200, { sent: 0 });
    const machine = key.split(':')[1];
    return reply(200, await fanOut({ db: d, sendPush, userId: owner, payload: notification({ event: 'offline', machine }, env.PUSH_LANG), log }));
  }

  const uid = await sessionUser(req, env, fetchImpl);
  if (!uid) return reply(401, { error: 'not-logged-in' });
  if (uid.toLowerCase() !== owner) return reply(403, { error: 'not-owner' });
  try {
    if (!(await d.claimOnce(owner, parsed.key))) return reply(200, { sent: 0, duplicate: true });
    return reply(200, await fanOut({ db: d, sendPush, userId: owner, payload: notification(parsed, env.PUSH_LANG), log }));
  } catch (err) {
    log(`[push] ${parsed.event} failed: ${err && err.message}`);
    return reply(502, { error: 'push-failed' });
  }
}
