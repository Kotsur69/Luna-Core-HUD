// ============================================================================
// LunaCore - FreeLLMAPI gateway: port setting, URL building, status probe
// ----------------------------------------------------------------------------
// docs/FREE_PROVIDERS_SYNC_PLAN.md ("Resume here"). The FreeLLMAPI desktop app
// listens on 127.0.0.1:31415, the Docker image on 3001 - so the port is a
// setting (config/freellm.local.json, gitignored like every *.local.json).
//
// The shipped templates (config/providers.json) still carry the desktop
// default; withGatewayPort() repoints a FreeLLMAPI profile at the configured
// port at LAUNCH time, so profiles saved before a port change follow it too.
// Everything that talks to the gateway (tab env/args, the fallback proxy
// upstream, the Luna overlay fingerprint) goes through gatewayUrl().
//
// Status: probeGateway() does one GET with a short timeout; gatewayState() maps
// its outcome to 'up' | 'not-running' | 'not-installed'. Pure and exported, so
// the Setup Center can reuse the mapping.
// ============================================================================

'use strict';

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const paths = require('./paths');

const DEFAULT_GATEWAY_PORT = 31415;
const GATEWAY_HOST = '127.0.0.1';
const PROBE_TIMEOUT_MS = 1500;

/** Profiles built from these templates talk to the gateway (config/providers.json ids). */
const GATEWAY_TEMPLATE_RE = /^freellm-/;

/** The gateway origin inside a template value: `http://127.0.0.1:<port>`. */
const GATEWAY_ORIGIN_RE = /http:\/\/127\.0\.0\.1:\d{1,5}(?!\d)/g;

const GATEWAY_STATES = Object.freeze(['up', 'not-running', 'not-installed']);

const prefsFile = () => paths.local('freellm.local.json');

/**
 * An integer 1-65535, or null. Strings of digits are accepted (form input).
 * @param {unknown} value
 * @returns {number|null}
 */
function parseGatewayPort(value) {
  const n = typeof value === 'string' && /^\d{1,5}$/.test(value.trim()) ? Number(value.trim()) : value;
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : null;
}

/**
 * A valid port, else the default.
 * @param {unknown} value
 * @returns {number}
 */
function normalizeGatewayPort(value) {
  const n = parseGatewayPort(value);
  return n === null ? DEFAULT_GATEWAY_PORT : n;
}

/**
 * @param {unknown} port
 * @returns {string} e.g. http://127.0.0.1:31415 (an invalid port yields the default)
 */
function gatewayUrl(port) {
  return `http://${GATEWAY_HOST}:${normalizeGatewayPort(port)}`;
}

/**
 * @param {string} [file]
 * @returns {{port:number}} the default for a missing/broken file
 */
function loadGatewayPrefs(file = prefsFile()) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { port: normalizeGatewayPort(raw && raw.port) };
  } catch {
    return { port: DEFAULT_GATEWAY_PORT };
  }
}

/**
 * Validates and saves (tmp + rename). An invalid port is saved as the default.
 * @param {{port?:unknown}} prefs
 * @param {string} [file]
 * @returns {{ok:true, prefs:{port:number}}|{ok:false, reason:'save-failed'}}
 */
function saveGatewayPrefs(prefs, file = prefsFile()) {
  const clean = { port: normalizeGatewayPort(prefs && prefs.port) };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(clean, null, 2)}\n`);
    fs.renameSync(tmp, file);
    return { ok: true, prefs: clean };
  } catch {
    return { ok: false, reason: 'save-failed' };
  }
}

/**
 * A copy of a FreeLLMAPI profile with every gateway origin in its env values
 * and args pointed at `port`. Any other profile is returned unchanged.
 * @param {Object} profile
 * @param {unknown} port
 * @returns {Object}
 */
function withGatewayPort(profile, port) {
  if (!profile || typeof profile.templateId !== 'string' || !GATEWAY_TEMPLATE_RE.test(profile.templateId)) return profile;
  const origin = gatewayUrl(port);
  const swap = (v) => (typeof v === 'string' ? v.replace(GATEWAY_ORIGIN_RE, origin) : v);
  const env = profile.env && typeof profile.env === 'object'
    ? Object.fromEntries(Object.entries(profile.env).map(([k, v]) => [k, swap(v)]))
    : profile.env;
  const args = Array.isArray(profile.args) ? profile.args.map(swap) : profile.args;
  return { ...profile, env, args };
}

/**
 * Maps one probe outcome to a status. Any HTTP answer means the gateway is up
 * (even 401/404: something is listening and speaking HTTP). A timeout means
 * something holds the port but does not answer - treated as not running.
 * @param {{answered?:boolean, timedOut?:boolean, installed?:boolean}} outcome
 * @returns {'up'|'not-running'|'not-installed'}
 */
function gatewayState(outcome) {
  const o = outcome || {};
  if (o.answered === true) return 'up';
  if (o.timedOut === true || o.installed === true) return 'not-running';
  return 'not-installed';
}

/**
 * Best-effort check for a desktop install. A Docker install cannot be seen
 * from here, so a stopped Docker gateway reads as 'not-installed'.
 * @param {{env?:Object, platform?:string, exists?:(p:string)=>boolean}} [deps]
 * @returns {boolean}
 */
function isGatewayInstalled({ env = process.env, platform = process.platform, exists = fs.existsSync } = {}) {
  const candidates = [];
  if (platform === 'win32') {
    for (const base of [env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs'), env.ProgramFiles, env.LOCALAPPDATA]) {
      if (base) candidates.push(path.join(base, 'FreeLLMAPI'), path.join(base, 'freellmapi'));
    }
  } else if (platform === 'darwin') {
    candidates.push('/Applications/FreeLLMAPI.app', path.join(os.homedir(), 'Applications', 'FreeLLMAPI.app'));
  } else {
    candidates.push('/opt/FreeLLMAPI', '/usr/bin/freellmapi', path.join(os.homedir(), '.local', 'bin', 'freellmapi'));
  }
  return candidates.some((p) => {
    try {
      return exists(p);
    } catch {
      return false;
    }
  });
}

/**
 * One GET on the gateway root, bounded by timeoutMs. Never rejects.
 * @param {unknown} port
 * @param {{httpImpl?:Object, timeoutMs?:number}} [deps]
 * @returns {Promise<{answered:boolean, timedOut:boolean}>}
 */
function probeGateway(port, { httpImpl = http, timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };
    let req;
    const timer = setTimeout(() => {
      finish({ answered: false, timedOut: true });
      if (req) req.destroy();
    }, timeoutMs);
    try {
      req = httpImpl.get({ host: GATEWAY_HOST, port: normalizeGatewayPort(port), path: '/', timeout: timeoutMs }, (res) => {
        finish({ answered: true, timedOut: false });
        // The headers are the answer; a streaming body must not hold the socket open.
        res.resume();
        req.destroy();
      });
      req.on('error', () => finish({ answered: false, timedOut: false }));
      req.on('timeout', () => {
        finish({ answered: false, timedOut: true });
        req.destroy();
      });
    } catch {
      finish({ answered: false, timedOut: false });
    }
  });
}

/**
 * Probe + install check -> one state string.
 * @param {unknown} port
 * @param {{probe?:Function, installed?:Function}} [deps]
 * @returns {Promise<'up'|'not-running'|'not-installed'>}
 */
async function gatewayStatus(port, { probe = probeGateway, installed = isGatewayInstalled } = {}) {
  const outcome = await probe(port);
  if (outcome && outcome.answered) return gatewayState(outcome);
  return gatewayState({ ...outcome, installed: installed() });
}

module.exports = {
  DEFAULT_GATEWAY_PORT,
  GATEWAY_STATES,
  PROBE_TIMEOUT_MS,
  parseGatewayPort,
  normalizeGatewayPort,
  gatewayUrl,
  loadGatewayPrefs,
  saveGatewayPrefs,
  withGatewayPort,
  gatewayState,
  isGatewayInstalled,
  probeGateway,
  gatewayStatus,
};
