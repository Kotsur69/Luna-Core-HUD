// ============================================================================
// LunaCore - YAZIO client for the Life dashboard (main process only)
// ----------------------------------------------------------------------------
// Reads today's calories, macros, steps, water and weight from YAZIO's
// UNOFFICIAL, undocumented API (the one its mobile app uses). It can break
// whenever YAZIO changes it; every response is shape-checked and a mismatch
// answers 'api-changed' instead of showing garbage. Read-only: nothing here
// ever writes to the YAZIO account.
//
// Why not the npm `yazio` package (1.1.3, last published 2024-04): its
// `main` points at a dist file that does not exist, it pulls in zod, and it
// builds the ?date= query in UTC, so between midnight and 02:00 in Poland
// it asks for yesterday. The three calls we need are a few lines of fetch.
//
// Credentials: email + password are stored encrypted with Electron
// safeStorage in yazio-cred.local.json (password reuse - Mati's data is not
// sensitive to him, the password is). No safeStorage -> memory only, like
// gcal.js. A plaintext yazio.local.json ("email password" or
// {"email","password"}) is imported once: after a successful login AND a
// successful encrypted save it is deleted. The renderer never sees the
// email, the password or a token - only numbers and fixed reason codes.
// ============================================================================

'use strict';

const fs = require('fs');
const paths = require('./paths');

const API = 'https://yzapi.yazio.com/v15';
// YAZIO's own mobile-app OAuth client, the same pair the public npm `yazio`
// package ships. Not a LunaCore secret: the password grant still needs the
// user's own email + password.
const CLIENT_ID = '1_4hiybetvfksgw40o0sog4s884kwc840wwso8go4k8c04goo4c';
const CLIENT_SECRET = '6rok2m65xuskgkgogw40wkkk8sw0osg84s8cggsc4woos4s8o';

const CRED_FILE = 'yazio-cred.local.json';
const LEGACY_FILE = 'yazio.local.json';
const FETCH_TIMEOUT_MS = 15000;
const CACHE_MS = 5 * 60 * 1000;
const HISTORY_DAYS = 7;
// Refresh the access token this long before YAZIO says it expires.
const EXPIRY_SLACK_MS = 60 * 1000;
// After a failed fetch, every call within this gap - forced or not - gets the
// same error back without touching the network (a Refresh button spammed
// against a down API must not turn into 8 requests per click).
const RETRY_GAP_MS = 15 * 1000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}/;
const MAX_EMAIL = 254;
const MAX_PASSWORD = 200;
const MEALS = ['breakfast', 'lunch', 'dinner', 'snack'];

class YazioError extends Error {
  constructor(reason) {
    super(reason);
    this.reason = reason;
  }
}

/** Local calendar date 'YYYY-MM-DD' (YAZIO's diary day is the local day). */
function ymd(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : null);
const sum0 = (xs) => xs.reduce((a, x) => a + (x || 0), 0);

function validCreds(c) {
  if (!c || typeof c !== 'object') return false;
  const { email, password } = c;
  return (
    typeof email === 'string' &&
    email.length >= 3 &&
    email.length <= MAX_EMAIL &&
    /^[^\s@]+@[^\s@]+$/.test(email) &&
    typeof password === 'string' &&
    password.length >= 1 &&
    password.length <= MAX_PASSWORD
  );
}

/** The hand-made plaintext file: {"email","password"} or "email password". */
function parseLegacy(raw) {
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  let creds = null;
  try {
    const j = JSON.parse(text);
    if (j && typeof j === 'object') creds = { email: j.email, password: j.password };
  } catch {
    const [email, ...rest] = text.split(/\s+/);
    creds = { email, password: rest.join(' ') };
  }
  return validCreds(creds) ? creds : null;
}

/**
 * /user/widgets/daily-summary -> the numbers the dashboard shows. Throws
 * 'api-changed' when the core fields are missing.
 */
function pickSummary(s) {
  if (!s || typeof s !== 'object' || !s.goals || typeof s.goals !== 'object' || !s.meals || typeof s.meals !== 'object') {
    throw new YazioError('api-changed');
  }
  const meals = MEALS.map((m) => (s.meals[m] && s.meals[m].nutrients) || {});
  const total = (key) => sum0(meals.map((n) => num(n[key])));
  const g = s.goals;
  const user = s.user && typeof s.user === 'object' ? s.user : {};
  const kcalGoal = num(g['energy.energy']);
  if (kcalGoal === null) throw new YazioError('api-changed');
  return {
    kcal: Math.round(total('energy.energy')),
    kcalGoal: Math.round(kcalGoal),
    activityKcal: Math.round(num(s.activity_energy) || 0),
    protein: Math.round(total('nutrient.protein')),
    proteinGoal: Math.round(num(g['nutrient.protein']) || 0),
    fat: Math.round(total('nutrient.fat')),
    fatGoal: Math.round(num(g['nutrient.fat']) || 0),
    carb: Math.round(total('nutrient.carb')),
    carbGoal: Math.round(num(g['nutrient.carb']) || 0),
    steps: Math.round(num(s.steps) || 0),
    stepsGoal: Math.round(num(g['activity.step']) || 0),
    water: Math.round(num(s.water_intake) || 0),
    waterGoal: Math.round(num(g.water) || 0),
    weight: num(user.current_weight),
    startWeight: num(user.start_weight),
    weightGoal: num(g['bodyvalue.weight']),
  };
}

/**
 * @param {{fetchImpl?:Function, safeStorage?:object, credPath?:string,
 *   legacyPath?:string, now?:() => number}} [deps]
 *   Injectable so tests never touch the network, the keychain or the real
 *   config folder.
 */
function createYazio(deps = {}) {
  const doFetch = deps.fetchImpl || ((...a) => fetch(...a));
  const storage = () => deps.safeStorage || require('electron').safeStorage;
  const credFile = () => deps.credPath || paths.local(CRED_FILE);
  const legacyFile = () => deps.legacyPath || paths.local(LEGACY_FILE);
  const now = deps.now || Date.now;

  let creds = null;
  let fromLegacy = false;
  let loaded = false;
  let token = null; // { access, refresh, expiresAt }
  let cache = null; // { at, body }
  let inflight = null;
  let loginInflight = null;
  // A stored login YAZIO refused: never retried until connect(), so a changed
  // password cannot get the account locked by repeated attempts.
  let blocked = null;
  let lastFail = null; // { at, err }
  // Bumped by connect/disconnect: a fetch started for an older login is dropped.
  let gen = 0;

  function loadCreds() {
    if (loaded) return creds;
    loaded = true;
    try {
      const raw = JSON.parse(fs.readFileSync(credFile(), 'utf8'));
      const ss = storage();
      if (raw && raw.v === 1 && typeof raw.enc === 'string' && ss.isEncryptionAvailable()) {
        const c = JSON.parse(ss.decryptString(Buffer.from(raw.enc, 'base64')));
        if (validCreds(c)) creds = { email: c.email, password: c.password };
      }
    } catch (err) {
      if (err && err.code !== 'ENOENT') console.error('[yazio] stored login unreadable:', (err && (err.code || err.name)) || 'error');
    }
    if (creds) return creds;
    try {
      const legacy = parseLegacy(fs.readFileSync(legacyFile(), 'utf8'));
      if (legacy) {
        creds = legacy;
        fromLegacy = true;
      }
    } catch {
      // No plaintext file - the normal case once imported.
    }
    return creds;
  }

  /** true when the login is now on disk, encrypted. */
  function saveCreds(c) {
    try {
      const ss = storage();
      if (!ss.isEncryptionAvailable()) return false; // memory only, by design
      if (!deps.credPath) paths.ensureUserDir();
      const enc = ss.encryptString(JSON.stringify(c)).toString('base64');
      // Temp + rename: a crash mid-write never leaves a torn file. The temp
      // name still ends in .local.json, so the gitignore covers a leftover.
      const tmp = credFile().replace(/(\.local)?\.json$/, '.tmp.local.json');
      fs.writeFileSync(tmp, JSON.stringify({ v: 1, enc }), { mode: 0o600 });
      fs.renameSync(tmp, credFile());
      return true;
    } catch (err) {
      console.error('[yazio] could not store login:', (err && (err.code || err.name)) || 'error');
      return false;
    }
  }

  async function request(path, init = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    let res;
    try {
      res = await doFetch(`${API}${path}`, { ...init, signal: ctrl.signal });
    } catch {
      throw new YazioError('network');
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 401) throw new YazioError('unauthorized');
    if (res.status === 429) throw new YazioError('rate-limited');
    if (res.status === 204 || res.status === 404) return null;
    if (!res.ok) throw new YazioError(res.status >= 500 ? 'network' : 'api-changed');
    try {
      return await res.json();
    } catch {
      throw new YazioError('api-changed');
    }
  }

  async function grant(body) {
    let res;
    try {
      res = await request('/oauth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, ...body }),
      });
    } catch (err) {
      // The token endpoint answers 400/401 for a wrong email or password.
      if (err.reason === 'unauthorized' || err.reason === 'api-changed') throw new YazioError('bad-login');
      throw err;
    }
    if (!res || typeof res.access_token !== 'string' || typeof res.expires_in !== 'number') {
      throw new YazioError('api-changed');
    }
    return {
      access: res.access_token,
      refresh: typeof res.refresh_token === 'string' ? res.refresh_token : null,
      expiresAt: now() + res.expires_in * 1000,
    };
  }

  const login = (c) => grant({ grant_type: 'password', username: c.email, password: c.password });

  async function renewToken() {
    if (token && token.refresh) {
      try {
        token = await grant({ grant_type: 'refresh_token', refresh_token: token.refresh });
        return;
      } catch (err) {
        if (err.reason === 'network') throw err;
        // A dead refresh token: fall through to a fresh password login.
      }
    }
    token = await login(creds);
  }

  /** One login at a time: parallel callers (8 per fetch) share it. */
  function ensureToken() {
    if (token && token.expiresAt - EXPIRY_SLACK_MS > now()) return Promise.resolve();
    if (!loginInflight) {
      loginInflight = renewToken().finally(() => {
        loginInflight = null;
      });
    }
    return loginInflight;
  }

  async function get(path) {
    await ensureToken();
    const sent = token.access;
    try {
      return await request(path, { headers: { Authorization: `Bearer ${sent}` } });
    } catch (err) {
      if (err.reason !== 'unauthorized') throw err;
      // Revoked early (another device logged out?): one fresh login, one retry.
      // Only the first caller drops the token; the rest join its login.
      if (token && token.access === sent) token = null;
      await ensureToken();
      return request(path, { headers: { Authorization: `Bearer ${token.access}` } });
    }
  }

  async function fetchBody() {
    const today = new Date(now());
    const days = Array.from({ length: HISTORY_DAYS }, (_, i) => {
      const d = new Date(today);
      d.setDate(d.getDate() - (HISTORY_DAYS - 1 - i));
      return ymd(d);
    });
    // Token first, so the parallel calls below do not each start a login.
    await ensureToken();
    const [summaries, weight] = await Promise.all([
      Promise.all(days.map((d) => get(`/user/widgets/daily-summary?date=${d}`))),
      get(`/user/bodyvalues/weight/last?date=${days[days.length - 1]}`),
    ]);
    const picked = summaries.map(pickSummary);
    const lastWeighIn =
      weight && typeof weight === 'object' && num(weight.value) !== null && typeof weight.date === 'string' && DATE_RE.test(weight.date)
        ? { value: weight.value, date: weight.date.slice(0, 10) }
        : null;
    return {
      date: days[days.length - 1],
      today: picked[picked.length - 1],
      history: picked.map((p, i) => ({ date: days[i], kcal: p.kcal, kcalGoal: p.kcalGoal, protein: p.protein, steps: p.steps })),
      lastWeighIn,
      fetchedAt: now(),
    };
  }

  function finishImport() {
    if (!fromLegacy) return;
    if (!saveCreds(creds)) return; // keep the plaintext file: nothing else holds the login
    fromLegacy = false;
    try {
      fs.rmSync(legacyFile(), { force: true });
    } catch (err) {
      console.error('[yazio] could not remove plaintext login file:', (err && (err.code || err.name)) || 'error');
    }
  }

  /** {connected} - no network. */
  function status() {
    return { connected: Boolean(loadCreds()) };
  }

  /** Today + the last week. Cached for 5 minutes unless `force`. */
  async function body({ force = false } = {}) {
    if (!loadCreds()) throw new YazioError('not-connected');
    if (blocked) throw blocked;
    if (!force && cache && now() - cache.at < CACHE_MS) return cache.body;
    if (lastFail && now() - lastFail.at < RETRY_GAP_MS) throw lastFail.err;
    if (inflight) return inflight;
    const started = gen;
    inflight = fetchBody()
      .then((b) => {
        if (started !== gen) return b; // the login changed meanwhile
        cache = { at: now(), body: b };
        lastFail = null;
        finishImport();
        return b;
      })
      .catch((err) => {
        if (started === gen) {
          lastFail = { at: now(), err };
          if (err.reason === 'bad-login') blocked = err;
        }
        throw err;
      })
      .finally(() => {
        if (started === gen) inflight = null;
      });
    return inflight;
  }

  /** Logs in with new credentials; stored only when the login works. */
  async function connect(c) {
    if (!validCreds(c)) throw new YazioError('bad-login');
    const next = { email: c.email, password: c.password };
    const nextToken = await login(next);
    reset();
    token = nextToken;
    creds = next;
    loaded = true;
    fromLegacy = false;
    const persisted = saveCreds(next);
    // Not saved: an older login left on disk would come back after a restart.
    if (!persisted) removeFile(credFile());
    return { persisted };
  }

  /** Forgets every per-login state; in-flight fetches of the old login are dropped. */
  function reset() {
    gen += 1;
    token = null;
    cache = null;
    inflight = null;
    blocked = null;
    lastFail = null;
  }

  function removeFile(file) {
    try {
      fs.rmSync(file, { force: true });
    } catch (err) {
      console.error('[yazio] could not remove login file:', (err && (err.code || err.name)) || 'error');
    }
  }

  function disconnect() {
    reset();
    creds = null;
    loaded = true;
    fromLegacy = false;
    for (const file of [credFile(), legacyFile()]) removeFile(file);
  }

  return { status, body, connect, disconnect };
}

module.exports = { createYazio, parseLegacy, pickSummary, ymd, YazioError, MAX_EMAIL, MAX_PASSWORD };
