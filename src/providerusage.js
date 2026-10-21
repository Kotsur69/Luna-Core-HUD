// ============================================================================
// LunaCore - usage limits for every configured non-Claude provider
// ----------------------------------------------------------------------------
// The usage panel shows Claude's 5 h / weekly windows from the OAuth usage
// endpoint (src/usage.js). This module adds one entry per OTHER configured
// provider profile, read from wherever that provider exposes its quota:
//
//   codex-cli          ~/.codex/auth.json -> chatgpt.com wham/usage (a GET,
//                      no tokens), else the newest rollout log's rate limits
//   glm / Z.ai URL     {origin}/api/monitor/usage/quota/limit (profile key)
//   kimi-code          {base}/v1/usages (profile key)
//   kimi (Moonshot)    {origin}/v1/users/me/balance (profile key)
//   gemini-cli         Google login only: Code Assist retrieveUserQuota with
//                      the CLI's cached access token (never refreshed here)
//   openrouter         openrouter.ai/api/v1/key (profile key)
//
// Anything else (an API key with no quota endpoint, FreeLLMAPI, CCR routes)
// comes back as status 'unsupported' = "not available", never as an error.
// Keys only ever go to the host that issued them. Parsing lives in
// src/providerusageparse.js; every IO dep is injectable for tests.
// ============================================================================

'use strict';

const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const parse = require('./providerusageparse');

const REQUEST_TIMEOUT_MS = 8000;
/** How many newest day folders of Codex rollouts are searched. */
const CODEX_DAYS_SCANNED = 7;
const CODE_ASSIST_HOST = 'cloudcode-pa.googleapis.com';

/** Templates that are Claude itself, local models, or no model at all. */
const SKIPPED_SOURCES = new Set(['claude', 'local', 'none']);

/** HTTPS request -> {status, body}; never rejects. */
function httpsRequest({ method = 'GET', host, pathname, headers = {}, body = null }) {
  return new Promise((resolve) => {
    const req = https.request({
      method,
      host,
      path: pathname,
      headers: {
        Accept: 'application/json',
        'User-Agent': 'LunaCore (usage-meter)',
        ...(body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {}),
        ...headers,
      },
      timeout: REQUEST_TIMEOUT_MS,
    }, (res) => {
      let data = '';
      res.on('data', (d) => { data += d; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', () => resolve({ status: 0, body: '' }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ status: 0, body: '' });
    });
    if (body) req.write(body);
    req.end();
  });
}

const DEFAULT_DEPS = {
  request: httpsRequest,
  readFile: (p) => fs.readFileSync(p, 'utf8'),
  readdir: (p) => fs.readdirSync(p),
  homedir: () => os.homedir(),
  now: () => Date.now(),
};

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** The profile's ANTHROPIC_BASE_URL as a URL, or null. */
function baseUrlOf(profile) {
  const raw = profile && profile.env && profile.env.ANTHROPIC_BASE_URL;
  if (typeof raw !== 'string' || raw === '') return null;
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

/** First non-empty env value among keys. */
function envKey(profile, keys) {
  const env = (profile && profile.env) || {};
  const hit = keys.find((k) => typeof env[k] === 'string' && env[k] !== '' && !env[k].includes('{{'));
  return hit ? env[hit] : '';
}

/**
 * Which quota source a profile uses. Template first, then the base URL, so a
 * hand-made profile pointing at Z.ai is recognized too.
 * @param {object} profile
 * @returns {'claude'|'local'|'none'|'codex'|'zai'|'kimi-code'|'moonshot'|'gemini'|'openrouter'|'other'}
 */
function usageSourceForProfile(profile) {
  if (!profile) return 'none';
  if (typeof profile.command === 'string' && profile.command.trim() === '') return 'none';
  const t = String(profile.templateId || '');
  if (t === 'lm-studio' || t === 'ollama') return 'local';
  if (t === 'codex-cli') return 'codex';
  if (t === 'gemini-cli') return 'gemini';
  if (t === 'kimi-code') return 'kimi-code';
  if (t === 'openrouter') return 'openrouter';
  const url = baseUrlOf(profile);
  const host = url ? url.hostname : '';
  if (t === 'glm' || host === 'api.z.ai' || host === 'open.bigmodel.cn') return 'zai';
  if (host === 'api.kimi.com' || host === 'api.kimi.ai') return 'kimi-code';
  if (t === 'kimi' || /^api\.moonshot\.(ai|cn)$/.test(host)) return 'moonshot';
  if (host === 'openrouter.ai') return 'openrouter';
  if (host === 'localhost' || host === '127.0.0.1') return t === '' || t === 'claude-cloud' ? 'local' : 'other';
  if (!t && !url && (!profile.command || profile.command === 'claude')) return 'claude';
  if (t === 'claude-cloud') return 'claude';
  return 'other';
}

function result(profile, status, limits = [], errorMessage = null, extra = {}) {
  return {
    providerId: usageSourceForProfile(profile),
    profileId: profile.id,
    displayName: profile.label || profile.id,
    status,
    errorMessage,
    limits,
    isFallback: false,
    updatedAt: extra.now || Date.now(),
    ...(extra.detail ? { detail: extra.detail } : {}),
  };
}

const notAvailable = (profile, reason, now) => result(profile, 'unsupported', [], reason, { now });

// --- per-source fetchers ---------------------------------------------------------

/** Codex: live backend first, newest local rollout log second. */
async function fetchCodex(profile, deps) {
  const now = deps.now();
  const home = path.join(deps.homedir(), '.codex');
  const auth = safeJson((() => { try { return deps.readFile(path.join(home, 'auth.json')); } catch { return ''; } })());
  const tokens = auth && auth.tokens;
  if (tokens && tokens.access_token) {
    const res = await deps.request({
      host: 'chatgpt.com',
      pathname: '/backend-api/wham/usage',
      headers: {
        Authorization: `Bearer ${tokens.access_token}`,
        ...(tokens.account_id ? { 'ChatGPT-Account-Id': tokens.account_id } : {}),
      },
    });
    const limits = res.status === 200 ? parse.parseCodexUsageResponse(safeJson(res.body), now) : null;
    if (limits) return result(profile, 'ok', limits, null, { now, detail: 'chatgpt' });
  }
  const fromLog = latestCodexRollout(home, deps);
  if (fromLog) return result(profile, 'ok', fromLog.limits, null, { now: fromLog.at || now, detail: 'rollout' });
  return notAvailable(profile, 'No Codex rate limits yet (sign in with ChatGPT and run codex once)', now);
}

/** Newest rollout file under ~/.codex/sessions/YYYY/MM/DD with rate limits. */
function latestCodexRollout(home, deps) {
  const list = (p) => { try { return deps.readdir(p).sort().reverse(); } catch { return []; } };
  const root = path.join(home, 'sessions');
  const days = [];
  for (const y of list(root)) {
    for (const m of list(path.join(root, y))) {
      for (const d of list(path.join(root, y, m))) {
        days.push(path.join(root, y, m, d));
        if (days.length >= CODEX_DAYS_SCANNED) break;
      }
      if (days.length >= CODEX_DAYS_SCANNED) break;
    }
    if (days.length >= CODEX_DAYS_SCANNED) break;
  }
  for (const day of days) {
    for (const file of list(day).filter((f) => f.endsWith('.jsonl'))) {
      let text = '';
      try { text = deps.readFile(path.join(day, file)); } catch { continue; }
      const hit = parse.latestCodexRateLimits(text);
      if (hit) return hit;
    }
  }
  return null;
}

async function fetchZai(profile, deps) {
  const now = deps.now();
  const key = envKey(profile, ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY']);
  if (!key) return result(profile, 'unconfigured', [], 'No API key in this profile', { now });
  const url = baseUrlOf(profile);
  const host = url && url.hostname === 'open.bigmodel.cn' ? 'open.bigmodel.cn' : 'api.z.ai';
  // The monitor endpoint takes the raw key, not "Bearer <key>".
  const res = await deps.request({ host, pathname: '/api/monitor/usage/quota/limit', headers: { Authorization: key } });
  const limits = res.status === 200 ? parse.parseZaiQuota(safeJson(res.body)) : null;
  if (limits) return result(profile, 'ok', limits, null, { now });
  return notAvailable(profile, `Quota endpoint unavailable (HTTP ${res.status}) - only Coding Plan keys report limits`, now);
}

async function fetchKimiCode(profile, deps) {
  const now = deps.now();
  const key = envKey(profile, ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']);
  if (!key) return result(profile, 'unconfigured', [], 'No API key in this profile', { now });
  const url = baseUrlOf(profile);
  const host = url ? url.hostname : 'api.kimi.com';
  const prefix = url ? url.pathname.replace(/\/+$/, '') : '/coding';
  const res = await deps.request({ host, pathname: `${prefix}/v1/usages`, headers: { Authorization: `Bearer ${key}` } });
  const limits = res.status === 200 ? parse.parseKimiCodeUsages(safeJson(res.body)) : null;
  if (limits) return result(profile, 'ok', limits, null, { now });
  return notAvailable(profile, `Kimi Code usage unavailable (HTTP ${res.status})`, now);
}

async function fetchMoonshot(profile, deps) {
  const now = deps.now();
  const key = envKey(profile, ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY']);
  if (!key) return result(profile, 'unconfigured', [], 'No API key in this profile', { now });
  const url = baseUrlOf(profile);
  const host = url && url.hostname === 'api.moonshot.cn' ? 'api.moonshot.cn' : 'api.moonshot.ai';
  const res = await deps.request({ host, pathname: '/v1/users/me/balance', headers: { Authorization: `Bearer ${key}` } });
  const limits = res.status === 200
    ? parse.parseMoonshotBalance(safeJson(res.body), host.endsWith('.cn') ? 'CNY' : 'USD')
    : null;
  if (limits) return result(profile, 'ok', limits, null, { now });
  return notAvailable(profile, `Moonshot balance unavailable (HTTP ${res.status})`, now);
}

async function fetchOpenRouter(profile, deps) {
  const now = deps.now();
  const key = envKey(profile, ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY']);
  if (!key) return result(profile, 'unconfigured', [], 'No API key in this profile', { now });
  const res = await deps.request({ host: 'openrouter.ai', pathname: '/api/v1/key', headers: { Authorization: `Bearer ${key}` } });
  const limits = res.status === 200 ? parse.parseOpenRouterKey(safeJson(res.body)) : null;
  if (limits) return result(profile, 'ok', limits, null, { now });
  return notAvailable(profile, `OpenRouter key info unavailable (HTTP ${res.status})`, now);
}

/** Gemini CLI: only a Google-account login has a quota to read. */
async function fetchGemini(profile, deps) {
  const now = deps.now();
  if (envKey(profile, ['GEMINI_API_KEY', 'GOOGLE_API_KEY'])) {
    return notAvailable(profile, 'Gemini API keys expose no quota endpoint', now);
  }
  let creds = null;
  try { creds = safeJson(deps.readFile(path.join(deps.homedir(), '.gemini', 'oauth_creds.json'))); } catch { creds = null; }
  if (!creds || !creds.access_token) return notAvailable(profile, 'No Google login cached by gemini', now);
  if (typeof creds.expiry_date === 'number' && creds.expiry_date <= now) {
    return notAvailable(profile, 'Google login expired - run gemini once to refresh it', now);
  }
  const headers = { Authorization: `Bearer ${creds.access_token}` };
  const load = await deps.request({
    method: 'POST',
    host: CODE_ASSIST_HOST,
    pathname: '/v1internal:loadCodeAssist',
    headers,
    body: JSON.stringify({ metadata: { ideType: 'IDE_UNSPECIFIED', platform: 'PLATFORM_UNSPECIFIED', pluginType: 'GEMINI' } }),
  });
  const loaded = load.status === 200 ? safeJson(load.body) : null;
  const projectRaw = loaded && loaded.cloudaicompanionProject;
  const project = typeof projectRaw === 'string' ? projectRaw : (projectRaw && projectRaw.id) || '';
  if (!project) return notAvailable(profile, `Gemini quota unavailable (HTTP ${load.status})`, now);
  const res = await deps.request({
    method: 'POST',
    host: CODE_ASSIST_HOST,
    pathname: '/v1internal:retrieveUserQuota',
    headers,
    body: JSON.stringify({ project }),
  });
  const limits = res.status === 200 ? parse.parseGeminiQuota(safeJson(res.body)) : null;
  if (limits) return result(profile, 'ok', limits, null, { now });
  return notAvailable(profile, `Gemini quota unavailable (HTTP ${res.status})`, now);
}

const FETCHERS = {
  codex: fetchCodex,
  zai: fetchZai,
  'kimi-code': fetchKimiCode,
  moonshot: fetchMoonshot,
  openrouter: fetchOpenRouter,
  gemini: fetchGemini,
};

/**
 * Usage for one profile; never rejects.
 * @param {object} profile
 * @param {object} [deps]
 */
async function fetchProviderUsage(profile, deps = {}) {
  const d = { ...DEFAULT_DEPS, ...deps };
  const fetcher = FETCHERS[usageSourceForProfile(profile)];
  if (!fetcher) return notAvailable(profile, 'This provider reports no usage limits', d.now());
  try {
    return await fetcher(profile, d);
  } catch (err) {
    return result(profile, 'error', [], (err && err.message) || 'Unknown error', { now: d.now() });
  }
}

/**
 * The profiles the panel lists besides Claude: every remote provider, one
 * entry per source + credential so two profiles sharing a key are read once.
 * @param {object[]} profiles
 * @returns {object[]}
 */
function profilesForUsage(profiles) {
  const seen = new Set();
  return (Array.isArray(profiles) ? profiles : []).filter((p) => {
    if (!p || !p.id) return false;
    const source = usageSourceForProfile(p);
    if (SKIPPED_SOURCES.has(source)) return false;
    const key = `${source}|${envKey(p, ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'FREELLM_API_KEY']) || p.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Usage for every non-Claude configured provider, in profile order. */
function fetchOtherProvidersUsage(profiles, deps = {}) {
  return Promise.all(profilesForUsage(profiles).map((p) => fetchProviderUsage(p, deps)));
}

module.exports = {
  usageSourceForProfile,
  profilesForUsage,
  fetchProviderUsage,
  fetchOtherProvidersUsage,
  latestCodexRollout,
};
