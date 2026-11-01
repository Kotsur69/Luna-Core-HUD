// ============================================================================
// LunaCore - Supabase Edge Function `lunaswork-feedback` (logic; index.js is
// the Deno entry)
// ----------------------------------------------------------------------------
// docs/LUNAS_WORK_PLAN.md B17, LW 3.28b. The client feedback widget on a
// Luna's Work STAGING build posts here, without a LunaCore account:
//
//   POST {token, runId, text, url?, screenshot?}   Content-Type: application/json
//
// Authorised by the run's widget token only: a random 256-bit value LunaCore
// bakes into the staging build (src/lunasworkWidget.js). The table keeps its
// SHA-256 hash, never the token (lunaswork_widget_tokens); a token is good for
// one run, from the staging origin it was issued for, until it is revoked
// (the run ended) or expires.
//
// Every request is checked here before anything is written:
//   content-type  application/json only (415)
//   size          body <= MAX_BODY_BYTES, read with a cap (413); text, page
//                 URL and screenshot each capped (400)
//   token         well-formed, known, not revoked, not expired, same run,
//                 same Origin (401, one generic answer for every reason)
//   rate limit    per token and per client IP over RATE_WINDOW_MS, plus a cap
//                 on the rows still waiting for LunaCore to pick up (429)
//
// The text is stored as plain text and is only ever shown as text (the HUD
// panel, the phone and the run report all render it as text nodes or escape
// it). The page URL keeps origin + path only (no query / hash: they can hold
// a session). The IP is stored as a salted hash, for the rate limit only,
// and pruned after a day.
//
// Deployed with verify_jwt = false (the caller has no session):
//   supabase functions deploy lunaswork-feedback --no-verify-jwt
// Secrets: WIDGET_IP_SALT (any random string); SUPABASE_URL and
// SUPABASE_SERVICE_ROLE_KEY are provided by the platform.
// ============================================================================

const FETCH_TIMEOUT_MS = 10000;
// Kept in step with src/lunasworkWidget.js (test/lunaswork-widget-fn.test.mjs checks it).
export const MAX_TEXT = 800;
export const MAX_URL = 500;
export const MAX_SHOT_CHARS = 700000;
export const MAX_BODY_BYTES = 750000;
export const RATE_WINDOW_MS = 60 * 60 * 1000;
export const MAX_PER_TOKEN = 60;
export const MAX_PER_IP = 10;
// Rows LunaCore has not picked up yet (it is offline): past this the token waits.
export const MAX_PENDING = 200;
const HIT_KEEP_MS = 24 * 60 * 60 * 1000;

export const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
export const RUN_ID_RE = /^[a-z0-9]{1,40}$/;
const SHOT_RE = /^data:image\/(jpeg|png);base64,([A-Za-z0-9+/]+={0,2})$/;
// The first bytes of a real JPEG / PNG (LunaCore checks them again before saving).
const MAGIC = { jpeg: [0xff, 0xd8, 0xff], png: [0x89, 0x50, 0x4e, 0x47] };
const IP_RE = /^[0-9A-Fa-f:.]{2,45}$/;
const HEX64_RE = /^[0-9a-f]{64}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/** SHA-256 hex of a string (WebCrypto: Deno and Node alike). */
export async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(text)));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** The hash a token is stored and looked up under. */
export const tokenHash = (token) => sha256Hex(token);

/** Client text: line breaks kept, other control characters out, lines trimmed. */
export function cleanText(raw) {
  if (typeof raw !== 'string') return '';
  return raw
    .replace(/\r\n?/g, '\n')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f]+/g, ' ')
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}

/** origin + path of an http(s) URL (query and hash dropped), or null. */
export function cleanPageUrl(raw) {
  if (typeof raw !== 'string' || !raw || raw.length > MAX_URL * 4) return null;
  let u;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  const out = `${u.origin}${u.pathname}`;
  return out.length <= MAX_URL ? out : null;
}

/** A JPEG / PNG data URL: well-formed base64 that starts with the format's magic bytes. */
export function isImage(dataUrl) {
  const m = SHOT_RE.exec(dataUrl);
  if (!m || m[2].length % 4 !== 0) return false;
  let head;
  try {
    head = atob(m[2].slice(0, 12));
  } catch {
    return false;
  }
  return MAGIC[m[1]].every((b, i) => head.charCodeAt(i) === b);
}

/**
 * The request body -> what may be stored, or why not. Unknown keys are
 * ignored; nothing in them is ever stored.
 * @returns {{ok:true, token:string, runId:string, text:string, pageUrl:string|null, screenshot:string|null}|{ok:false, error:string}}
 */
export function parseSubmission(body) {
  if (!isObj(body)) return { ok: false, error: 'bad-request' };
  if (typeof body.token !== 'string' || !TOKEN_RE.test(body.token)) return { ok: false, error: 'not-allowed' };
  if (typeof body.runId !== 'string' || !RUN_ID_RE.test(body.runId)) return { ok: false, error: 'bad-request' };
  if (typeof body.text !== 'string' || body.text.length > MAX_TEXT * 2) return { ok: false, error: 'too-long' };
  const text = cleanText(body.text);
  if (!text) return { ok: false, error: 'empty' };
  if (text.length > MAX_TEXT) return { ok: false, error: 'too-long' };
  let pageUrl = null;
  if (body.url !== undefined && body.url !== null) {
    pageUrl = cleanPageUrl(body.url);
    if (!pageUrl) return { ok: false, error: 'bad-url' };
  }
  let screenshot = null;
  if (body.screenshot !== undefined && body.screenshot !== null) {
    if (typeof body.screenshot !== 'string' || body.screenshot.length > MAX_SHOT_CHARS) return { ok: false, error: 'too-large' };
    if (!isImage(body.screenshot)) return { ok: false, error: 'bad-screenshot' };
    screenshot = body.screenshot;
  }
  return { ok: true, token: body.token, runId: body.runId, text, pageUrl, screenshot };
}

/**
 * Whether a token row lets this request in. One answer for every refusal,
 * so a caller learns nothing about why.
 * @param {{id:string, user_id:string, run_id:string, origin:string, expires_at:string, revoked_at:string|null}|null} row
 * @param {{runId:string, origin:string|null, now:number}} req
 * @returns {boolean}
 */
export function tokenAllows(row, { runId, origin, now }) {
  if (!isObj(row) || !UUID_RE.test(String(row.id)) || !UUID_RE.test(String(row.user_id))) return false;
  if (row.revoked_at !== null && row.revoked_at !== undefined) return false;
  const expires = Date.parse(row.expires_at);
  if (!Number.isFinite(expires) || expires <= now) return false;
  if (row.run_id !== runId) return false;
  // The widget runs on the staging origin; a browser always sends Origin on this cross-site POST.
  return typeof origin === 'string' && origin === row.origin;
}

/**
 * The rate-limit verdict over the window's counts.
 * @param {{token:number, ip:number, pending:number}} counts
 * @returns {{ok:true}|{ok:false, retryAfterSec:number}}
 */
export function rateVerdict(counts) {
  const c = isObj(counts) ? counts : {};
  const over = (n, max) => !Number.isFinite(n) || n >= max;
  if (over(c.token, MAX_PER_TOKEN) || over(c.ip, MAX_PER_IP) || over(c.pending, MAX_PENDING)) {
    return { ok: false, retryAfterSec: Math.round(RATE_WINDOW_MS / 1000) };
  }
  return { ok: true };
}

/** The caller's IP as the platform reports it, or 'unknown'. */
export function clientIp(headers) {
  const first = (v) => (typeof v === 'string' ? v.split(',')[0].trim() : '');
  for (const v of [headers.get('cf-connecting-ip'), headers.get('x-real-ip'), first(headers.get('x-forwarded-for'))]) {
    if (typeof v === 'string' && IP_RE.test(v.trim())) return v.trim();
  }
  return 'unknown';
}

/**
 * The body as text, read with a cap: a larger one is never buffered whole.
 * @returns {Promise<string|null>} null when over `max` bytes or unreadable
 */
export async function readCapped(req, max = MAX_BODY_BYTES) {
  const declared = Number(req.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > max) return null;
  if (!req.body) return '';
  const reader = req.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(all);
  } catch {
    return null;
  }
}

/**
 * The tables this function touches, over PostgREST with the service role.
 * Only ever called after parseSubmission: every value is validated.
 */
export function createDb({ url, serviceKey, fetchImpl = fetch }) {
  const headers = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' };
  const rest = (path, init = {}) =>
    fetchImpl(`${url}/rest/v1/${path}`, { ...init, headers: { ...headers, ...(init.headers || {}) }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  const enc = encodeURIComponent;
  const count = async (path, max) => {
    const res = await rest(`${path}&select=id&limit=${max + 1}`);
    if (!res.ok) throw new Error(`count ${res.status}`);
    const rows = await res.json();
    return Array.isArray(rows) ? rows.length : max + 1;
  };
  return {
    async tokenByHash(hash) {
      if (!HEX64_RE.test(hash)) return null;
      const res = await rest(`lunaswork_widget_tokens?select=id,user_id,run_id,origin,expires_at,revoked_at&token_hash=eq.${hash}&limit=1`);
      if (!res.ok) throw new Error(`token ${res.status}`);
      const rows = await res.json();
      return Array.isArray(rows) && rows[0] ? rows[0] : null;
    },
    async counts(tokenId, ipHash, since) {
      const at = enc(new Date(since).toISOString());
      const [token, ip, pending] = await Promise.all([
        count(`lunaswork_widget_hits?token_id=eq.${enc(tokenId)}&at=gte.${at}`, MAX_PER_TOKEN),
        count(`lunaswork_widget_hits?ip_hash=eq.${enc(ipHash)}&at=gte.${at}`, MAX_PER_IP),
        count(`lunaswork_client_feedback?token_id=eq.${enc(tokenId)}`, MAX_PENDING),
      ]);
      return { token, ip, pending };
    },
    async recordHit(tokenId, ipHash) {
      const res = await rest('lunaswork_widget_hits', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ token_id: tokenId, ip_hash: ipHash }) });
      if (!res.ok) throw new Error(`hit ${res.status}`);
    },
    async pruneHits(before) {
      await rest(`lunaswork_widget_hits?at=lt.${enc(new Date(before).toISOString())}`, { method: 'DELETE' });
    },
    async insertFeedback(row) {
      const res = await rest('lunaswork_client_feedback', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(row) });
      if (!res.ok) throw new Error(`feedback ${res.status}`);
    },
  };
}

const CORS = {
  // No cookies or credentials are ever used: the token in the body is the only key.
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'content-type',
  'Access-Control-Max-Age': '600',
};

/**
 * The whole request -> Response.
 * @param {Request} req
 * @param {{env: Record<string, string|undefined>, db: () => ReturnType<typeof createDb>|null,
 *   now?: () => number, log?: Function}} deps
 */
export async function handle(req, { env, db, now = Date.now, log = () => {} }) {
  const reply = (status, body, extra = {}) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extra },
    });
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST') return reply(405, { error: 'method' });
  const type = (req.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/json') return reply(415, { error: 'content-type' });

  const text = await readCapped(req, MAX_BODY_BYTES);
  if (text === null) return reply(413, { error: 'too-large' });
  let parsed;
  try {
    parsed = parseSubmission(JSON.parse(text));
  } catch {
    parsed = { ok: false, error: 'bad-request' };
  }
  if (!parsed.ok) return reply(parsed.error === 'not-allowed' ? 401 : 400, { error: parsed.error });

  const d = db();
  if (!d) return reply(503, { error: 'not-configured' });
  try {
    const row = await d.tokenByHash(await tokenHash(parsed.token));
    if (!tokenAllows(row, { runId: parsed.runId, origin: req.headers.get('origin'), now: now() })) return reply(401, { error: 'not-allowed' });
    const ipHash = await sha256Hex(`${env.WIDGET_IP_SALT || ''}|${clientIp(req.headers)}`);
    const verdict = rateVerdict(await d.counts(row.id, ipHash, now() - RATE_WINDOW_MS));
    if (!verdict.ok) return reply(429, { error: 'rate-limited' }, { 'Retry-After': String(verdict.retryAfterSec) });
    await d.recordHit(row.id, ipHash);
    await d.insertFeedback({
      user_id: row.user_id,
      token_id: row.id,
      run_id: row.run_id,
      text: parsed.text,
      page_url: parsed.pageUrl,
      screenshot: parsed.screenshot,
    });
    d.pruneHits(now() - HIT_KEEP_MS).catch((err) => log(`[lunaswork-feedback] prune failed: ${err && err.message}`));
    return reply(201, { ok: true });
  } catch (err) {
    log(`[lunaswork-feedback] store failed: ${err && err.message}`);
    return reply(502, { error: 'store-failed' });
  }
}
