// ============================================================================
// LunaCore - local model endpoint health (LM Studio / Ollama / vLLM)
// ----------------------------------------------------------------------------
// Answers the question the profile switcher cannot: I PICKED THE LOCAL PROFILE,
// IS THERE ACTUALLY ANYTHING THERE? Switching to "LM Studio (local)" only sets
// ANTHROPIC_BASE_URL on the next spawn - if the server is closed, or is running
// with no model loaded, the tab looks identical and every prompt fails inside
// the CLI, several seconds later, with an error that names neither cause.
//
// Passive Observer, same discipline as ports.js/mcphealth.js: local HTTP GET on
// a slow timer, no writes, and nothing here ever reaches the model. ZERO EXTRA
// TOKENS holds trivially - the requests do not go to Anthropic at all.
//
// TWO REAL TRAPS THIS MODULE EXISTS TO SURFACE, both of which cost a session:
//
//   1. BASE URL WITH A TRAILING /v1. Claude Code appends `/v1/messages` to
//      ANTHROPIC_BASE_URL itself, so `http://localhost:1234/v1` becomes a
//      request to `/v1/v1/messages` -> 404 on every turn. LunaCore shipped
//      exactly this in config/profiles.json until 2026-08-19, which is why the
//      LM Studio profile never once connected. baseUrlWarning() names it.
//   2. SERVER UP, NOTHING LOADED. LM Studio answers /api/v0/models perfectly
//      well while every entry reads `state: "not-loaded"`. "Up" is therefore
//      not the useful signal - "a model is loaded" is.
//
// Endpoint choice: /api/v0/models carries `state` and `max_context_length`,
// which is what makes the loaded-vs-downloaded distinction visible. /v1/models
// (OpenAI-compat, and what Ollama/vLLM speak) carries neither, so it is the
// fallback: it still proves the server is alive and lists ids.
// ============================================================================

'use strict';

const http = require('http');

// Slow on purpose. This answers "is my local stack up", which changes on human
// timescales (you alt-tab to LM Studio and load a model), not machine ones.
const SAMPLE_MS = 5000;
const PROBE_TIMEOUT_MS = 2500;

// Richest first: v0 carries load state, the OpenAI-compat route does not.
const MODEL_PATHS = ['/api/v0/models', '/v1/models'];

/** Hostnames that mean "this machine". Anything else is somebody's server. */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]']);

/**
 * Strips a trailing slash and a trailing `/v1` from a base URL.
 *
 * Both directions of this are load-bearing. Claude Code wants the ORIGIN
 * (trap 1 above), while the health probe below wants to reach `/api/v0/models`
 * on that same origin - so a config that carries the `/v1` anyway still gets
 * probed correctly instead of silently reporting the server as down.
 * @param {string} url
 * @returns {string} normalized origin, or '' when the input is unusable
 */
function normalizeBaseUrl(url) {
  const raw = typeof url === 'string' ? url.trim() : '';
  if (!raw) return '';
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return '';
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
  const tail = parsed.pathname.replace(/\/+$/, '').replace(/\/v1$/i, '');
  return `${parsed.origin}${tail}`;
}

/**
 * The local endpoint a profile's env points at, or null when it points nowhere
 * local. Pure - a profile object in, a string out - so the "is this local"
 * rule is pinned by tests rather than discovered in the field.
 * @param {{env?: Object}} profile
 * @returns {string|null}
 */
function localEndpointFromProfile(profile) {
  const env = profile && profile.env && typeof profile.env === 'object' ? profile.env : null;
  if (!env) return null;
  const base = typeof env.ANTHROPIC_BASE_URL === 'string' ? env.ANTHROPIC_BASE_URL : '';
  if (!base) return null;
  let host;
  try {
    host = new URL(base).hostname;
  } catch {
    return null;
  }
  if (!LOCAL_HOSTS.has(host)) return null;
  return normalizeBaseUrl(base) || null;
}

/**
 * The `/v1` trap, as a check rather than a comment. Returns a machine-readable
 * code (the renderer owns the wording, in both languages) or null when clean.
 * @param {{env?: Object}} profile
 * @returns {'double-v1'|null}
 */
function baseUrlWarning(profile) {
  const env = profile && profile.env && typeof profile.env === 'object' ? profile.env : null;
  if (!env) return null;
  const base = typeof env.ANTHROPIC_BASE_URL === 'string' ? env.ANTHROPIC_BASE_URL.trim() : '';
  if (!base) return null;
  let tail;
  try {
    tail = new URL(base).pathname;
  } catch {
    return null;
  }
  return /\/v1\/?$/i.test(tail) ? 'double-v1' : null;
}

/**
 * Normalizes one model entry from either endpoint shape into one row.
 *
 * /v1/models has no `state`, so `loaded` is null there rather than false:
 * "this endpoint cannot tell us" and "this model is not loaded" are different
 * answers, and rendering the second when we mean the first would put a red
 * warning on a perfectly healthy Ollama.
 */
function normalizeModel(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = typeof raw.id === 'string' ? raw.id : '';
  if (!id) return null;
  const state = typeof raw.state === 'string' ? raw.state : '';
  const max = Number(raw.max_context_length);
  const loadedCtx = Number(raw.loaded_context_length);
  return {
    id,
    type: typeof raw.type === 'string' ? raw.type : '',
    quantization: typeof raw.quantization === 'string' ? raw.quantization : '',
    // null = the endpoint does not report load state at all (see above).
    loaded: state ? state === 'loaded' : null,
    maxContext: Number.isFinite(max) && max > 0 ? Math.round(max) : null,
    loadedContext: Number.isFinite(loadedCtx) && loadedCtx > 0 ? Math.round(loadedCtx) : null,
  };
}

/** Parses either endpoint's body into rows. Returns [] on anything unexpected. */
function parseModels(body) {
  let data;
  try {
    data = typeof body === 'string' ? JSON.parse(body) : body;
  } catch {
    return [];
  }
  const list = data && Array.isArray(data.data) ? data.data : [];
  return list.map(normalizeModel).filter(Boolean);
}

/**
 * The model a session launched right now would actually talk to.
 *
 * Embedding models are excluded: LM Studio happily keeps one loaded alongside
 * an LLM, and handing Claude Code an embedding id produces a failure that
 * looks like a broken endpoint rather than a wrong model.
 * @param {Array} models
 * @returns {Object|null}
 */
function pickLoadedModel(models) {
  const rows = Array.isArray(models) ? models : [];
  const usable = rows.filter((m) => m && m.type !== 'embeddings');
  return usable.find((m) => m.loaded === true) || null;
}

/**
 * The ANTHROPIC_MODEL to inject for a profile that asked for it, or null.
 *
 * Opt-in per profile (`autoModel: true`) and never an override: a profile that
 * names its own model, or a user who set ANTHROPIC_MODEL in their environment,
 * means it. Pure so spawnInto() can call it synchronously off the watcher's
 * last sample - see src/main.js.
 * @param {{env?: Object, autoModel?: boolean}} profile
 * @param {{models?: Array}|null} snapshot
 * @returns {string|null}
 */
function resolveAutoModel(profile, snapshot) {
  if (!profile || profile.autoModel !== true) return null;
  if (
    profile.env &&
    typeof profile.env.ANTHROPIC_MODEL === 'string' &&
    profile.env.ANTHROPIC_MODEL
  ) {
    return null;
  }
  const loaded = pickLoadedModel(snapshot && snapshot.models);
  return loaded ? loaded.id : null;
}

/** GETs one URL with a hard timeout. Resolves {ok, body} - never rejects. */
function get(url, timeoutMs) {
  return new Promise((resolve) => {
    let req;
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (req) req.destroy();
      resolve(result);
    };
    try {
      req = http.get(url, { timeout: timeoutMs }, (res) => {
        // A 404 here is information, not noise: it is how we learn this server
        // speaks the other endpoint shape and should be retried on the next
        // path rather than reported as down.
        if (res.statusCode !== 200) {
          res.resume();
          finish({ ok: false, status: res.statusCode, body: '' });
          return;
        }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          body += chunk;
          // A local endpoint answering a model list in megabytes is not one we
          // want to hold in memory; bail rather than grow unbounded.
          if (body.length > 512 * 1024) finish({ ok: false, status: 0, body: '' });
        });
        res.on('end', () => finish({ ok: true, status: 200, body }));
        res.on('error', () => finish({ ok: false, status: 0, body: '' }));
      });
    } catch {
      resolve({ ok: false, status: 0, body: '' });
      return;
    }
    req.on('timeout', () => finish({ ok: false, status: 0, body: '' }));
    req.on('error', () => finish({ ok: false, status: 0, body: '' }));
  });
}

/**
 * Probes one endpoint for its model list.
 * @param {string} baseUrl already normalized (no trailing /v1)
 * @returns {Promise<{up:boolean, models:Array, source:string, ms:number}>}
 */
async function probeEndpoint(baseUrl, { timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  const base = normalizeBaseUrl(baseUrl);
  const started = Date.now();
  if (!base) return { up: false, models: [], source: '', ms: 0 };

  for (const tail of MODEL_PATHS) {
    const res = await get(`${base}${tail}`, timeoutMs);
    if (!res.ok) continue;
    const models = parseModels(res.body);
    // An empty 200 still proves the server answered; the tile distinguishes
    // "up, nothing downloaded" from "down" on its own.
    return { up: true, models, source: tail, ms: Date.now() - started };
  }
  return { up: false, models: [], source: '', ms: Date.now() - started };
}

/**
 * Polls whichever local endpoint the ACTIVE profile points at, and pushes only
 * when the reading changed - same shape and same reason as media.js's
 * MediaSampler (a shell-free HTTP round trip here, but the "don't spam IPC with
 * an unchanged reading" rule is identical).
 *
 * setEndpoint(null) stops the polling entirely: on the Claude Cloud profile
 * there is no local server to ask about, and a timer quietly knocking on a
 * closed port forever is exactly the kind of thing this HUD is supposed to
 * catch other programs doing.
 */
class LocalModelWatcher {
  constructor(intervalMs = SAMPLE_MS, onUpdate = null) {
    this.intervalMs = intervalMs;
    this.onUpdate = onUpdate;
    this.timer = null;
    this.endpoint = null;
    this.latest = null;
    this.latestKey = '';
    this.busy = false;
  }

  /** Points the watcher at a new endpoint (or null to idle it). */
  setEndpoint(baseUrl) {
    const next = baseUrl ? normalizeBaseUrl(baseUrl) : '';
    if (next === (this.endpoint || '')) return;
    this.endpoint = next || null;
    // The previous server's reading must not survive the switch - it would
    // otherwise sit there looking like the new one's answer until the first
    // tick lands.
    this.latest = null;
    this.latestKey = '';
    if (!this.endpoint) {
      this.stop();
      this.push(null);
      return;
    }
    this.start();
    this.tick();
  }

  start() {
    if (this.timer || !this.endpoint) return;
    this.timer = setInterval(() => this.tick(), this.intervalMs);
    if (this.timer.unref) this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  push(state) {
    if (this.onUpdate) this.onUpdate(state);
  }

  async tick() {
    if (this.busy || !this.endpoint) return;
    this.busy = true;
    const endpoint = this.endpoint;
    try {
      const probe = await probeEndpoint(endpoint);
      // The profile may have been switched while the request was in flight -
      // publishing this now would attribute one server's answer to another.
      if (endpoint !== this.endpoint) return;
      const loaded = pickLoadedModel(probe.models);
      const state = {
        endpoint,
        up: probe.up,
        source: probe.source,
        models: probe.models,
        loaded,
        // Kept separate from `loaded` so the renderer never has to re-derive
        // it: "up with nothing loaded" is the state worth shouting about.
        idle: probe.up && !loaded,
        checkedAt: Date.now(),
      };
      const key = JSON.stringify({ ...state, checkedAt: 0 });
      if (key !== this.latestKey) {
        this.latestKey = key;
        this.latest = state;
        this.push(state);
      }
    } finally {
      this.busy = false;
    }
  }

  current() {
    return this.latest;
  }
}

module.exports = {
  LocalModelWatcher,
  probeEndpoint,
  normalizeBaseUrl,
  localEndpointFromProfile,
  baseUrlWarning,
  parseModels,
  normalizeModel,
  pickLoadedModel,
  resolveAutoModel,
  SAMPLE_MS,
};
