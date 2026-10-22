// ============================================================================
// LunaCore - Setup Center: input validation + integration status (main, pure)
// ----------------------------------------------------------------------------
// The Setup page in Ctrl+L (renderer modules/setupcenter.js) shows one row per
// integration: ok / warning / missing plus a short note id. Decided here from
// plain probe results so every branch is unit-tested without Electron, a
// network or the CLIs; the probes themselves live in src/setupprobes.js and the
// channels in src/setupipc.js.
//
// Every friend brings their OWN Supabase project (decision 2026-10-22), so the
// cloud form's URL + key are validated here: https://<ref>.supabase.co only,
// and a publishable key - a secret / service_role key is refused outright,
// because it would sit in a plain file and bypass row level security.
//
// What leaves this module for the renderer: ids, state strings, note ids.
// Never a key, token or raw error text.
// ============================================================================

'use strict';

const { parseCloudConfig } = require('./cloudrows');
const { decideSetup } = require('./hostsetup');

const STATES = Object.freeze(['ok', 'warning', 'missing']);

/** Row order on the page. */
const INTEGRATIONS = Object.freeze([
  'claude',
  'gh',
  'cloud',
  'cloudTables',
  'cloudAuth',
  'google',
  'functions',
  'pwa',
  'host',
  'yazio',
  'agentReach',
  'lmstudio',
  'freellm',
]);

/** Note ids the renderer may get (i18n keys setup.note.<id>). */
const NOTES = Object.freeze([
  'timeout',
  'probe-failed',
  'not-installed',
  'not-logged-in',
  'not-configured',
  'needs-cloud',
  'restart',
  'not-connected',
  'not-running',
  'no-phone',
  'partial',
  'unchecked',
  'no-social',
  'no-google',
  'no-github',
]);

/** The tables supabase/migrations creates; probed by the "check" button. */
const CLOUD_TABLES = Object.freeze([
  'sync_units',
  'snapshots',
  'host_commands',
  'host_pairings',
  'host_events',
  'push_subscriptions',
  'push_sent',
]);

/** Edge functions in supabase/functions. */
const EDGE_FUNCTIONS = Object.freeze(['google', 'push']);

const DEFAULT_TIMEOUT_MS = 8000;
const MAX_INPUT_LEN = 400;
const PROJECT_URL_RE = /^https:\/\/([a-z0-9][a-z0-9-]{0,62})\.supabase\.co$/;
const PUBLISHABLE_RE = /^sb_publishable_[A-Za-z0-9_-]{16,200}$/;
const JWT_RE = /^[A-Za-z0-9_-]{10,200}\.([A-Za-z0-9_-]{10,1000})\.[A-Za-z0-9_-]{10,400}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_PWA_URL = 200;

const row = (id, state, note = null) => ({ id, state, note });

/**
 * Normalizes what the user pasted as the project URL: trims, drops one
 * trailing slash, lowercases. Anything with a path, query, port,
 * credentials or another host is refused.
 * @param {unknown} raw
 * @returns {string|null} "https://<ref>.supabase.co"
 */
function normalizeProjectUrl(raw) {
  if (typeof raw !== 'string' || raw.length > MAX_INPUT_LEN) return null;
  const text = raw.trim().replace(/\/$/, '').toLowerCase();
  return PROJECT_URL_RE.test(text) ? text : null;
}

/** The legacy anon JWT's payload role, or null when it is not a readable JWT. */
function jwtRole(key) {
  const m = JWT_RE.exec(key);
  if (!m) return null;
  try {
    const payload = JSON.parse(Buffer.from(m[1], 'base64url').toString('utf8'));
    return payload && typeof payload.role === 'string' ? payload.role : null;
  } catch {
    return null;
  }
}

/**
 * Classifies a pasted key.
 * @param {unknown} raw
 * @returns {{ok:true, key:string}|{ok:false, reason:'bad-key'|'secret-key'}}
 */
function classifyKey(raw) {
  if (typeof raw !== 'string' || raw.length > MAX_INPUT_LEN * 3) return { ok: false, reason: 'bad-key' };
  const key = raw.trim();
  if (/^sb_secret_/.test(key)) return { ok: false, reason: 'secret-key' };
  if (PUBLISHABLE_RE.test(key)) return { ok: true, key };
  const role = jwtRole(key);
  if (role === 'anon') return { ok: true, key };
  if (role) return { ok: false, reason: 'secret-key' };
  return { ok: false, reason: 'bad-key' };
}

/**
 * The cloud form, validated: what config/cloud.local.json may hold.
 * @param {unknown} input {url, key}
 * @returns {{ok:true, config:{url:string, publishableKey:string}}|{ok:false, reason:string}}
 */
function validateCloudInput(input) {
  if (!input || typeof input !== 'object') return { ok: false, reason: 'bad-url' };
  const url = normalizeProjectUrl(input.url);
  if (!url) return { ok: false, reason: 'bad-url' };
  const key = classifyKey(input.key);
  if (!key.ok) return key;
  // The same check the sync engine runs on load: a file we write must load.
  const config = parseCloudConfig({ url, publishableKey: key.key });
  return config ? { ok: true, config } : { ok: false, reason: 'bad-key' };
}

/** "https://abc.supabase.co" -> "abc" (for dashboard links), or null. */
function projectRef(url) {
  const m = typeof url === 'string' ? PROJECT_URL_RE.exec(url) : null;
  return m ? m[1] : null;
}

/**
 * The phone PWA's address (their own Vercel deploy). https only, no
 * credentials, short enough for a small QR code.
 * @param {unknown} raw
 * @returns {string|null}
 */
function normalizePwaUrl(raw) {
  if (typeof raw !== 'string' || raw.length > MAX_PWA_URL) return null;
  let u;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.username || u.password || !u.hostname.includes('.')) return null;
  const text = u.toString();
  return text.length <= MAX_PWA_URL ? text : null;
}

/** A Supabase user id, or null. Shown so the user can set OWNER_USER_ID. */
const cleanUserId = (v) => (typeof v === 'string' && UUID_RE.test(v) ? v.toLowerCase() : null);

// ---- per-integration mapping: probe result -> {id, state, note} ------------
// A probe that failed or timed out arrives as {failed: 'timeout'|'probe-failed'}.

const MAPPERS = {
  /** {installed, loggedIn} */
  claude: (r) => {
    if (!r.installed) return row('claude', 'missing', 'not-installed');
    return r.loggedIn ? row('claude', 'ok') : row('claude', 'warning', 'not-logged-in');
  },
  /** 'ok' | 'not-logged-in' | 'missing' */
  gh: (r) => {
    if (r.value === 'ok') return row('gh', 'ok');
    if (r.value === 'not-logged-in') return row('gh', 'warning', 'not-logged-in');
    return row('gh', 'missing', 'not-installed');
  },
  /** {fileValid, running, loggedIn} - running = the sync engine loaded it this start */
  cloud: (r) => {
    if (!r.fileValid) return row('cloud', 'missing', 'not-configured');
    if (!r.running) return row('cloud', 'warning', 'restart');
    return r.loggedIn ? row('cloud', 'ok') : row('cloud', 'warning', 'not-logged-in');
  },
  /** {configured, checked, present, total} */
  cloudTables: (r) => {
    if (!r.configured) return row('cloudTables', 'missing', 'needs-cloud');
    if (!r.checked) return row('cloudTables', 'warning', 'unchecked');
    if (r.present === r.total && r.total > 0) return row('cloudTables', 'ok');
    return row('cloudTables', r.present > 0 ? 'warning' : 'missing', 'partial');
  },
  /** {configured, github, google} */
  cloudAuth: (r) => {
    if (!r.configured) return row('cloudAuth', 'missing', 'needs-cloud');
    if (!r.github) return row('cloudAuth', 'missing', 'no-github');
    return r.google ? row('cloudAuth', 'ok') : row('cloudAuth', 'warning', 'no-google');
  },
  /** {configured, connected} (gcal.status()) */
  google: (r) => {
    if (!r.configured) return row('google', 'missing', 'not-configured');
    return r.connected ? row('google', 'ok') : row('google', 'warning', 'not-connected');
  },
  /** {configured, google, push}: 'deployed' | 'missing' | 'unknown' each */
  functions: (r) => {
    if (!r.configured) return row('functions', 'missing', 'needs-cloud');
    const states = EDGE_FUNCTIONS.map((f) => r[f]);
    if (states.every((s) => s === 'deployed')) return row('functions', 'ok');
    if (states.every((s) => s === 'missing')) return row('functions', 'missing', 'not-configured');
    return row('functions', 'warning', states.includes('unknown') ? 'probe-failed' : 'partial');
  },
  /** {url} */
  pwa: (r) => (r.url ? row('pwa', 'ok') : row('pwa', 'missing', 'not-configured')),
  /** {configured, loggedIn, paired} -> hostsetup.decideSetup */
  host: (r) => {
    const s = decideSetup(r);
    if (s === 'ready') return row('host', 'ok');
    if (s === 'pair') return row('host', 'warning', 'no-phone');
    return row('host', 'missing', s === 'no-cloud' ? 'needs-cloud' : 'not-logged-in');
  },
  /** {connected} */
  yazio: (r) => (r.connected ? row('yazio', 'ok') : row('yazio', 'missing', 'not-connected')),
  /** missionnews status(): {installed, ready, social:{x, reddit}} */
  agentReach: (r) => {
    if (!r.installed) return row('agentReach', 'missing', 'not-installed');
    if (!r.ready) return row('agentReach', 'warning', 'not-installed');
    const social = r.social || {};
    return social.x || social.reddit ? row('agentReach', 'ok') : row('agentReach', 'warning', 'no-social');
  },
  /** {running, cli} */
  lmstudio: (r) => {
    if (r.running) return row('lmstudio', 'ok');
    return r.cli ? row('lmstudio', 'warning', 'not-running') : row('lmstudio', 'missing', 'not-installed');
  },
  /** freellmgateway GATEWAY_STATES */
  freellm: (r) => {
    if (r.value === 'up') return row('freellm', 'ok');
    if (r.value === 'not-running') return row('freellm', 'warning', 'not-running');
    return row('freellm', 'missing', 'not-installed');
  },
};

/**
 * One probe result -> one row. A thrown mapper (malformed probe output) is a
 * warning, never a crash of the whole page.
 * @param {string} id
 * @param {object} result
 */
function mapStatus(id, result) {
  const r = result && typeof result === 'object' ? result : { failed: 'probe-failed' };
  if (r.failed) return row(id, 'warning', r.failed === 'timeout' ? 'timeout' : 'probe-failed');
  try {
    return MAPPERS[id](r);
  } catch {
    return row(id, 'warning', 'probe-failed');
  }
}

/**
 * Runs fn() but gives up after `ms`: the page never waits on a hung CLI.
 * @returns {Promise<object>} the probe's value (objects pass through, scalars
 *   become {value}), or {failed:'timeout'|'probe-failed'}
 */
function withTimeout(fn, ms = DEFAULT_TIMEOUT_MS) {
  let timer = null;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ failed: 'timeout' }), ms);
  });
  const run = Promise.resolve()
    .then(fn)
    .then((v) => (v && typeof v === 'object' ? v : { value: v }))
    .catch(() => ({ failed: 'probe-failed' }));
  return Promise.race([run, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Every integration in parallel, each under its own timeout.
 * @param {Record<string, () => unknown>} probes keyed by INTEGRATIONS id
 * @param {{timeoutMs?:number, timeouts?:Record<string, number>}} [opts]
 *   timeouts = per-id overrides (a probe that has to start Python needs longer)
 * @returns {Promise<{id:string, state:string, note:string|null}[]>} INTEGRATIONS order
 */
async function collectStatus(probes, { timeoutMs = DEFAULT_TIMEOUT_MS, timeouts = {} } = {}) {
  const results = await Promise.all(
    INTEGRATIONS.map((id) =>
      typeof probes[id] === 'function'
        ? withTimeout(probes[id], Object.hasOwn(timeouts, id) ? timeouts[id] : timeoutMs)
        : Promise.resolve({ failed: 'probe-failed' })
    )
  );
  return INTEGRATIONS.map((id, i) => mapStatus(id, results[i]));
}

/**
 * The table probe's HTTP answers -> {present, total, missing}. PostgREST says
 * 404 for a table that does not exist; 2xx and 401/403 (RLS, revoked grants)
 * mean it is there. Anything else (or a network failure, null) is unknown and
 * counted as not present so the user re-checks.
 * @param {Record<string, number|null>} statusByTable
 */
function tablesResult(statusByTable) {
  const missing = CLOUD_TABLES.filter((t) => {
    const s = statusByTable[t];
    return !(Number.isInteger(s) && ((s >= 200 && s < 300) || s === 401 || s === 403));
  });
  return { present: CLOUD_TABLES.length - missing.length, total: CLOUD_TABLES.length, missing };
}

/** An edge function probe's HTTP status -> 'deployed' | 'missing' | 'unknown'. */
function functionState(status) {
  if (!Number.isInteger(status)) return 'unknown';
  if (status === 404) return 'missing';
  return status >= 200 && status < 500 ? 'deployed' : 'unknown';
}

/** GET /auth/v1/settings body -> {github, google} (strict booleans). */
function authProviders(body) {
  const ext = body && typeof body === 'object' && body.external && typeof body.external === 'object' ? body.external : {};
  return { github: ext.github === true, google: ext.google === true };
}

module.exports = {
  STATES,
  INTEGRATIONS,
  NOTES,
  CLOUD_TABLES,
  EDGE_FUNCTIONS,
  DEFAULT_TIMEOUT_MS,
  normalizeProjectUrl,
  classifyKey,
  validateCloudInput,
  projectRef,
  normalizePwaUrl,
  cleanUserId,
  mapStatus,
  withTimeout,
  collectStatus,
  tablesResult,
  functionState,
  authProviders,
};
