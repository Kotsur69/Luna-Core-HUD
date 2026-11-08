// ============================================================================
// LunaCore - free-model fallback chains (config loader + pure selection)
// ----------------------------------------------------------------------------
// A chain is an ordered list of CAPABLE free models behind one Anthropic-
// compatible gateway (FreeLLMAPI). src/fallbackproxy.js sends every request
// to the first model that is not cooling down; when that model answers with
// a limit (429), an outage (5xx/529) or "unknown model", it cools down and
// the SAME request goes to the next one - the tab never changes options.
//
// Config: config/freechains.json (+ freechains.local.json override, same id
// wins). Same contract as the other loaders: safe read, validate at the
// boundary, a broken file yields an empty list. Weak models are refused here,
// so a chain can never quietly fall down to a flash/mini model.
//
// Substitution guard (Free God Mode v2, slice F3): a chain may declare
// `"expect": ["nemotron-3-ultra", "gpt-oss-120b"]` - substrings of the
// gateway's X-Routed-Via answer header (`<platform>/<model>`). A build-run
// answer routed to anything else is refused as `substituted` by the proxy.
// A malformed list is ignored with a warning, never fatal.
// ============================================================================

'use strict';

const fs = require('fs');
const paths = require('./paths');
const { hasText, normalizeText } = require('./localized');

const BASE_FILE = paths.bundled('freechains.json');
const localFile = () => paths.local('freechains.local.json');

const CHAIN_ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,119}$/;
const MAX_MODELS = 16;
/** One `expect` entry: a short, plain substring of X-Routed-Via. */
const EXPECT_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@ -]{0,59}$/;
const MAX_EXPECT = 16;

/**
 * Models too weak for unattended coding work. Speed does not matter here,
 * quality does: flash / lite / mini / nano / small-parameter models are out.
 */
const WEAK_MODEL_PATTERNS = [
  /flash/i,
  // Word-start anchored: "gemini" must not read as "mini".
  /(^|[^a-z])lite\b/i,
  /(^|[^a-z])mini\b/i,
  /(^|[^a-z])nano\b/i,
  /haiku/i,
  /(^|[^0-9])[1-9](\.\d)?b\b/i, // 1b..9b parameter counts
  /\b(small|tiny)\b/i,
  /^auto$/i, // the gateway's own router may pick any model, weak ones too
];

/**
 * Cooldowns after a failure, by kind. A `limit` that names no reset time
 * (no Retry-After, no "~Xm" hint) is read as a daily cap: the model waits
 * 30 min, then one request re-probes it (same idea as FALLBACK_WAIT_MS in
 * src/orchestraPlanWait.js).
 */
const COOLDOWN_MS = {
  limit: 30 * 60 * 1000,
  outage: 30 * 1000,
  unknown: 60 * 60 * 1000,
  // The gateway answered from a model outside the chain's `expect` list.
  substituted: 10 * 60 * 1000,
};

/** The gateway's whole-route exhaustion ("All models rate-limited ...", "All models exhausted ..."). */
const ALL_MODELS_RE = /\ball models\b/i;
/** "Soonest cooldown reset ~12m" / "Soonest reset ~45s" in a gateway error. */
const RESET_HINT_RE = /soonest (?:cooldown )?reset ~(\d+(?:\.\d+)?)\s*([smh])/i;
const HINT_UNIT_MS = { s: 1000, m: 60 * 1000, h: 60 * 60 * 1000 };

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** True for a model id this module refuses to put in a chain. */
function isWeakModel(id) {
  return WEAK_MODEL_PATTERNS.some((re) => re.test(String(id || '')));
}

const defaultWarn = (msg) => console.warn(msg);

/**
 * A chain's `expect` list: distinct, trimmed short strings. Undefined when
 * the chain has none; null (plus a warning) when it is malformed - the guard
 * is then off for that chain rather than the chain being dropped.
 * @param {unknown} raw
 * @param {string} chainId
 * @param {(msg:string) => void} warn
 * @returns {string[]|null|undefined}
 */
function normalizeExpect(raw, chainId, warn) {
  if (raw === undefined) return undefined;
  const list = Array.isArray(raw) ? raw.map((e) => (typeof e === 'string' ? e.trim() : e)) : null;
  const valid = list !== null && list.length > 0 && list.length <= MAX_EXPECT
    && list.every((e) => typeof e === 'string' && EXPECT_RE.test(e));
  if (!valid) {
    warn(`[freechains] chain "${chainId}": "expect" must be 1-${MAX_EXPECT} short strings - ignored, substitution guard off`);
    return null;
  }
  return [...new Set(list)];
}

/**
 * Validates one chain: {id, label, models[], expect?[]} with only capable,
 * well-formed, distinct model ids. Null when nothing usable is left.
 * @param {object} raw
 * @param {{warn?: (msg:string) => void}} [opts]
 */
function normalizeChain(raw, { warn = defaultWarn } = {}) {
  if (!raw || typeof raw !== 'object' || !CHAIN_ID_RE.test(String(raw.id || ''))) return null;
  const seen = new Set();
  const models = (Array.isArray(raw.models) ? raw.models : [])
    .filter((m) => typeof m === 'string' && MODEL_ID_RE.test(m) && !isWeakModel(m))
    .filter((m) => (seen.has(m) ? false : (seen.add(m), true)))
    .slice(0, MAX_MODELS);
  if (models.length === 0) return null;
  const chain = { id: raw.id, label: hasText(raw.label) ? normalizeText(raw.label) : raw.id, models };
  const expect = normalizeExpect(raw.expect, raw.id, warn);
  return expect ? { ...chain, expect } : chain;
}

/** Base chains merged with local ones (same id = local wins). Never throws. */
function loadChains({ base = BASE_FILE, local = null, warn = defaultWarn } = {}) {
  const byId = new Map();
  for (const src of [readJson(base), readJson(local || localFile())]) {
    const list = src && Array.isArray(src.chains) ? src.chains : [];
    for (const raw of list) {
      const chain = normalizeChain(raw, { warn });
      if (chain) byId.set(chain.id, chain);
    }
  }
  return [...byId.values()];
}

/** A chain by id, or null. */
function getChain(chains, id) {
  return (chains || []).find((c) => c.id === id) || null;
}

/**
 * The chain a profile runs on: its own `fallbackChain`, else its template's.
 * @returns {object|null}
 */
function resolveProfileChain(profile, providers, chains) {
  if (!profile) return null;
  const template = profile.templateId ? (providers || []).find((p) => p && p.id === profile.templateId) : null;
  const id = profile.fallbackChain || (template && template.fallbackChain) || null;
  return id ? getChain(chains, id) : null;
}

const cooledUntil = (cooldowns, m) => (cooldowns && cooldowns.get(m)) || 0;

/** The models not cooling down right now, in chain order. */
function readyModels(chain, cooldowns, now) {
  return chain.models.filter((m) => cooledUntil(cooldowns, m) <= now);
}

/** Epoch ms the first cooling model of the chain is free again, or null. */
function soonestCooldown(chain, cooldowns, now) {
  const times = chain.models.map((m) => cooledUntil(cooldowns, m)).filter((t) => t > now);
  return times.length ? Math.min(...times) : null;
}

/**
 * The order to try models in right now: those not cooling down in chain
 * order, then the cooling ones by soonest-free.
 * @param {{models:string[]}} chain
 * @param {Map<string, number>} cooldowns model -> epoch ms it is free again
 * @param {number} now
 */
function attemptOrder(chain, cooldowns, now) {
  const until = (m) => cooledUntil(cooldowns, m);
  const ready = readyModels(chain, cooldowns, now);
  const cooling = chain.models.filter((m) => until(m) > now).sort((a, b) => until(a) - until(b));
  return [...ready, ...cooling];
}

/**
 * Classifies an upstream answer: 'ok' (pass it through), a failure kind that
 * moves the request to the next model, 'throttled' (the gateway's own per-key
 * request window - wait briefly and send the same request again), or 'fatal'
 * (pass it through - another model would fail the same way, e.g. a bad
 * gateway key).
 *
 * A gateway 429 that is not "All models ..." is FreeLLMAPI's 120-requests-
 * per-minute guard on the unified key ("Rate limit exceeded: more than 120
 * requests per minute. Retry in 7s."): every model would get the same answer.
 * @param {number} status
 * @param {string} [body] the (small) error body, when buffered
 * @returns {'ok'|'limit'|'throttled'|'outage'|'unknown'|'fatal'}
 */
function classifyFailure(status, body = '') {
  if (status >= 200 && status < 400) return 'ok';
  if (status === 429) return ALL_MODELS_RE.test(String(body)) ? 'limit' : 'throttled';
  if (status === 408 || status === 529 || status >= 500) return 'outage';
  if ((status === 400 || status === 404 || status === 422)
    && /model|not (found|supported|available)|unknown|no (available )?provider/i.test(String(body))) return 'unknown';
  if (status === 402 || (status === 403 && /quota|limit|credit/i.test(String(body)))) return 'limit';
  return 'fatal';
}

/** Retry-After (seconds or HTTP date) in ms, or null. */
function retryAfterMs(headers, now = Date.now()) {
  const raw = headers && headers['retry-after'];
  if (raw === undefined || raw === null || raw === '') return null;
  const secs = Number(raw);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const at = Date.parse(String(raw));
  return Number.isFinite(at) ? Math.max(0, at - now) : null;
}

/**
 * The reset hint in a gateway error ("Soonest cooldown reset ~12m"), in ms.
 * Null when there is none.
 * @param {string} body
 * @returns {number|null}
 */
function resetHintMs(body) {
  const m = RESET_HINT_RE.exec(String(body || ''));
  if (!m) return null;
  const ms = Number(m[1]) * HINT_UNIT_MS[m[2].toLowerCase()];
  return Number.isFinite(ms) ? ms : null;
}

/**
 * True when the gateway's X-Routed-Via value names one of the expected
 * models (case-insensitive substring match).
 * @param {string} routedVia e.g. "nvidia/nemotron-3-ultra"
 * @param {string[]} expect
 * @returns {boolean}
 */
function routedMatches(routedVia, expect) {
  const value = String(routedVia || '').toLowerCase();
  return Array.isArray(expect) && expect.some((e) => value.includes(String(e).toLowerCase()));
}

/**
 * A new cooldown map with `model` cooling for its failure kind. For a limit,
 * `retryMs` (Retry-After, else the gateway's "~Xm" hint) wins over the
 * default.
 */
function withCooldown(cooldowns, model, kind, now, retryMs = null) {
  const next = new Map(cooldowns || []);
  const ms = retryMs !== null && kind === 'limit' ? Math.max(retryMs, 1000) : (COOLDOWN_MS[kind] || COOLDOWN_MS.outage);
  next.set(model, now + ms);
  return next;
}

module.exports = {
  isWeakModel,
  normalizeChain,
  loadChains,
  getChain,
  resolveProfileChain,
  attemptOrder,
  readyModels,
  soonestCooldown,
  classifyFailure,
  retryAfterMs,
  resetHintMs,
  routedMatches,
  withCooldown,
  COOLDOWN_MS,
};
