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

/** Cooldowns after a failure, by kind. */
const COOLDOWN_MS = {
  limit: 60 * 1000,
  outage: 30 * 1000,
  unknown: 60 * 60 * 1000,
};

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

/**
 * Validates one chain: {id, label, models[]} with only capable, well-formed,
 * distinct model ids. Null when nothing usable is left.
 */
function normalizeChain(raw) {
  if (!raw || typeof raw !== 'object' || !CHAIN_ID_RE.test(String(raw.id || ''))) return null;
  const seen = new Set();
  const models = (Array.isArray(raw.models) ? raw.models : [])
    .filter((m) => typeof m === 'string' && MODEL_ID_RE.test(m) && !isWeakModel(m))
    .filter((m) => (seen.has(m) ? false : (seen.add(m), true)))
    .slice(0, MAX_MODELS);
  if (models.length === 0) return null;
  return { id: raw.id, label: hasText(raw.label) ? normalizeText(raw.label) : raw.id, models };
}

/** Base chains merged with local ones (same id = local wins). Never throws. */
function loadChains({ base = BASE_FILE, local = null } = {}) {
  const byId = new Map();
  for (const src of [readJson(base), readJson(local || localFile())]) {
    const list = src && Array.isArray(src.chains) ? src.chains : [];
    for (const raw of list) {
      const chain = normalizeChain(raw);
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

/**
 * The order to try models in right now: those not cooling down in chain
 * order, then the cooling ones by soonest-free (so a fully limited chain
 * still tries something instead of failing outright).
 * @param {{models:string[]}} chain
 * @param {Map<string, number>} cooldowns model -> epoch ms it is free again
 * @param {number} now
 */
function attemptOrder(chain, cooldowns, now) {
  const until = (m) => (cooldowns && cooldowns.get(m)) || 0;
  const ready = chain.models.filter((m) => until(m) <= now);
  const cooling = chain.models.filter((m) => until(m) > now).sort((a, b) => until(a) - until(b));
  return [...ready, ...cooling];
}

/**
 * Classifies an upstream answer: 'ok' (pass it through), or a failure kind
 * that moves the request to the next model, or 'fatal' (pass it through -
 * another model would fail the same way, e.g. a bad gateway key).
 * @param {number} status
 * @param {string} [body] the (small) error body, when buffered
 * @returns {'ok'|'limit'|'outage'|'unknown'|'fatal'}
 */
function classifyFailure(status, body = '') {
  if (status >= 200 && status < 400) return 'ok';
  if (status === 429) return 'limit';
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

/** A new cooldown map with `model` cooling for its failure kind. */
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
  classifyFailure,
  retryAfterMs,
  withCooldown,
  COOLDOWN_MS,
};
