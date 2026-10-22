// ============================================================================
// LunaCore - Setup Center probes + the cloud.local.json writer (main)
// ----------------------------------------------------------------------------
// The impure half of src/setupcenter.js: file checks, `gh auth status`, and a
// few HTTP requests against the user's OWN Supabase project with the
// publishable key (the same key the app already ships to the browser for
// login, so nothing secret goes over the wire). Each function answers plain
// values that setupcenter.js maps to a row; setupipc.js adds the timeouts.
//
// The writer only ever writes config/cloud.local.json (a fixed name under the
// user config dir - the renderer never names a path), tmp + rename, owner-only
// mode. A changed project URL also drops cloud-session.local.json: that
// session belongs to the old project and could never refresh against the new.
// ============================================================================

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { parseCloudConfig } = require('./cloudrows');
const center = require('./setupcenter');

const CLOUD_FILE = 'cloud.local.json';
const SESSION_FILE = 'cloud-session.local.json';
const GH_TIMEOUT_MS = 8000;
const HTTP_TIMEOUT_MS = 5000;
const MAX_SMALL_FILE = 4 * 1024 * 1024;

/**
 * @param {string} file
 * @returns {{url:string, publishableKey:string}|null} null when missing or invalid
 */
function readCloudConfig(file) {
  try {
    return parseCloudConfig(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch {
    return null;
  }
}

/**
 * Writes a VALIDATED config (setupcenter.validateCloudInput). Refuses to
 * replace a different project unless `replace` is set (the renderer asks
 * first), so a stray click cannot repoint an owner's sync.
 * @param {{url:string, publishableKey:string}} config
 * @param {{file:string, sessionFile:string, replace?:boolean}} opts
 * @returns {{ok:true, changedProject:boolean}|{ok:false, reason:'exists'|'invalid'|'save-failed'}}
 */
function writeCloudConfig(config, { file, sessionFile, replace = false }) {
  const clean = parseCloudConfig(config);
  if (!clean) return { ok: false, reason: 'invalid' };
  const current = readCloudConfig(file);
  const changedProject = Boolean(current) && current.url !== clean.url;
  if (changedProject && !replace) return { ok: false, reason: 'exists' };
  const tmp = `${file}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // A stale tmp from a crash would keep its old mode: start from a new file.
    fs.rmSync(tmp, { force: true });
    fs.writeFileSync(tmp, `${JSON.stringify({ url: clean.url, publishableKey: clean.publishableKey }, null, 2)}\n`, {
      mode: 0o600,
    });
    fs.renameSync(tmp, file);
  } catch {
    fs.rmSync(tmp, { force: true });
    return { ok: false, reason: 'save-failed' };
  }
  if (changedProject) fs.rmSync(sessionFile, { force: true });
  return { ok: true, changedProject };
}

/** Claude Code's config dir: CLAUDE_CONFIG_DIR, else ~/.claude. */
const claudeDir = (env, home) => env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');

/** Small JSON file -> object, or null. Never throws. */
function readSmallJson(file) {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > MAX_SMALL_FILE) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Whether Claude Code has a login on this machine - presence checks only,
 * nothing is read out of the credentials file. An API key in the
 * environment counts too. (macOS keeps the token in the keychain, where
 * ~/.claude.json's oauthAccount still says a login happened.)
 * @returns {boolean}
 */
function claudeLoggedIn({ env = process.env, home = os.homedir() } = {}) {
  if (typeof env.ANTHROPIC_API_KEY === 'string' && env.ANTHROPIC_API_KEY.length > 0) return true;
  if (fs.existsSync(path.join(claudeDir(env, home), '.credentials.json'))) return true;
  const state = readSmallJson(path.join(home, '.claude.json'));
  return Boolean(state && state.oauthAccount && typeof state.oauthAccount === 'object');
}

/**
 * `gh auth status` -> 'ok' | 'not-logged-in' | 'missing'. Fixed argv, no shell.
 * @param {{run?:Function}} [deps] run(file, args, opts, cb) like execFile
 */
function ghAuthStatus({ run = execFile } = {}) {
  return new Promise((resolve) => {
    run('gh', ['auth', 'status'], { timeout: GH_TIMEOUT_MS, windowsHide: true }, (err) => {
      if (!err) return resolve('ok');
      resolve(err.code === 'ENOENT' ? 'missing' : 'not-logged-in');
    });
  });
}

/**
 * One request; resolves the HTTP status (and parsed JSON when asked), or a
 * null status on a network failure / timeout. Raw bodies are never passed on.
 */
async function httpStatus(url, { method = 'GET', headers = {}, json = false, fetchImpl = fetch, timeoutMs = HTTP_TIMEOUT_MS } = {}) {
  try {
    const res = await fetchImpl(url, { method, headers, signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
    const body = json && res.ok ? await res.json().catch(() => null) : null;
    return { status: res.status, body };
  } catch {
    return { status: null, body: null };
  }
}

const keyHeaders = (config) => ({ apikey: config.publishableKey, Authorization: `Bearer ${config.publishableKey}` });

/**
 * Probes every migration table (names are fixed constants, never input).
 * @returns {Promise<{present:number, total:number, missing:string[]}>}
 */
async function probeTables(config, { fetchImpl = fetch } = {}) {
  const entries = await Promise.all(
    center.CLOUD_TABLES.map(async (t) => {
      const { status } = await httpStatus(`${config.url}/rest/v1/${t}?select=*&limit=0`, {
        headers: keyHeaders(config),
        fetchImpl,
      });
      return [t, status];
    })
  );
  return center.tablesResult(Object.fromEntries(entries));
}

/** Which OAuth providers the project has switched on (public settings endpoint). */
async function probeAuth(config, { fetchImpl = fetch } = {}) {
  const { body } = await httpStatus(`${config.url}/auth/v1/settings`, {
    headers: { apikey: config.publishableKey },
    json: true,
    fetchImpl,
  });
  if (!body) throw new Error('auth settings unavailable');
  return center.authProviders(body);
}

/** Whether each edge function is deployed (404 = not). Their secrets cannot be checked from here. */
async function probeFunctions(config, { fetchImpl = fetch } = {}) {
  const entries = await Promise.all(
    center.EDGE_FUNCTIONS.map(async (f) => {
      const { status } = await httpStatus(`${config.url}/functions/v1/${f}`, { method: 'OPTIONS', fetchImpl });
      return [f, center.functionState(status)];
    })
  );
  return Object.fromEntries(entries);
}

module.exports = {
  CLOUD_FILE,
  SESSION_FILE,
  readCloudConfig,
  writeCloudConfig,
  claudeLoggedIn,
  ghAuthStatus,
  httpStatus,
  probeTables,
  probeAuth,
  probeFunctions,
};
