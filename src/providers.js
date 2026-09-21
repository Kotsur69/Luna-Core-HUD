// ============================================================================
// LunaCore - AI provider templates
// ----------------------------------------------------------------------------
// A "provider" (LM Studio, Ollama, Kimi, GLM, Codex, Gemini, Grok, a generic
// OpenAI-compatible endpoint, ...) is a TEMPLATE, shipped read-only in
// config/providers.json. buildProfileFromTemplate() turns one, plus whatever
// the user filled in (an API key, a model name), into a plain profile object
// in the EXACT shape src/profiles.js already understands. Every downstream
// consumer - spawnInto(), the renderer's profile switcher, /ask, lmstudio.js -
// needs zero changes: a generated profile is indistinguishable from a
// hand-written one in config/profiles.local.json.
//
// SECURITY BOUNDARY: profile.env ends up in pty.spawn()'s environment for a
// real child process, so this is the one place a renderer-supplied string
// must never become an env VAR NAME - only a value. The set of names a
// profile can ever carry is fixed by the template's own `envTemplate` keys
// (a shipped, code-reviewed file); anything the caller passes under
// `extraEnv` is filled into KNOWN placeholders only and any key outside that
// fixed set is silently dropped, never merged in. ENV_KEY_DENY_RE is
// defense-in-depth on top of that, in case a future template itself is ever
// malformed (PATH, NODE_*, LD_*, ... are never something a template should
// set at all).
// ============================================================================

'use strict';

const fs = require('fs');
const paths = require('./paths');
const { hasText, normalizeText } = require('./localized');

const BASE_FILE = paths.bundled('providers.json');

const WIRE_VIA_VALUES = new Set(['direct', 'ccr']);

/** Env var name prefixes a provider template must never be allowed to set. */
const ENV_KEY_DENY_RE = /^(PATH|Path|NODE_|ELECTRON_|LD_|DYLD_|PYTHON|npm_)/;

/** The port a locally-managed claude-code-router instance listens on. */
const DEFAULT_CCR_PORT = 3456;

/** Safe read + JSON parse. Returns null when the file is missing or invalid. */
function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** Validates and normalizes one provider template. Returns an object or null. */
function normalizeProviderTemplate(p) {
  if (!p || typeof p !== 'object') return null;
  if (typeof p.id !== 'string' || !p.id) return null;
  if (!hasText(p.label)) return null;
  if (!WIRE_VIA_VALUES.has(p.wireVia)) return null;

  const rawEnvTemplate =
    p.envTemplate && typeof p.envTemplate === 'object' && !Array.isArray(p.envTemplate)
      ? p.envTemplate
      : {};
  const envTemplate = Object.fromEntries(
    Object.entries(rawEnvTemplate).filter(
      ([k, v]) => typeof v === 'string' && !ENV_KEY_DENY_RE.test(k)
    )
  );

  return {
    id: p.id,
    label: normalizeText(p.label),
    wireVia: p.wireVia,
    requiresApiKey: p.requiresApiKey === true,
    requiresBaseUrl: p.requiresBaseUrl === true,
    autoModel: p.autoModel === true,
    defaultModel: typeof p.defaultModel === 'string' ? p.defaultModel : '',
    defaultFastModel: typeof p.defaultFastModel === 'string' ? p.defaultFastModel : '',
    ccrProviderType: typeof p.ccrProviderType === 'string' ? p.ccrProviderType : '',
    docsUrl: typeof p.docsUrl === 'string' ? p.docsUrl : '',
    envTemplate,
  };
}

/**
 * Loads the shipped provider catalog (config/providers.json). No local
 * override: this is a template list, not per-machine state - see
 * config/profiles.local.json for where a generated profile (with its secret)
 * actually lands.
 * @returns {{providers: Array}}
 */
function loadProviders() {
  const base = readJson(BASE_FILE);
  const raw = base && Array.isArray(base.providers) ? base.providers : [];
  const providers = raw.map(normalizeProviderTemplate).filter(Boolean);
  return { providers };
}

/** Returns the template with the given id, or null. */
function getProviderTemplate(providers, id) {
  return providers.find((p) => p.id === id) || null;
}

/**
 * The exact set of env var names a template is permitted to write.
 * @param {{envTemplate: Object}} template
 * @returns {Set<string>}
 */
function allowedEnvKeys(template) {
  return new Set(Object.keys((template && template.envTemplate) || {}));
}

/** Replaces every {{name}} token in `str` with `vars[name]` (or ''). */
function fillTemplate(str, vars) {
  return str.replace(/\{\{(\w+)\}\}/g, (_m, name) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : ''
  );
}

/**
 * Builds a plain profile object (same shape as normalizeProfile()'s output)
 * from a provider template plus user-supplied values. Never throws.
 *
 * @param {Object} template a normalized entry from loadProviders()
 * @param {{id?:string, label?:string, apiKey?:string, model?:string,
 *   fastModel?:string, baseUrl?:string, ccrPort?:number,
 *   extraEnv?:Object}} entry
 * @returns {{ok:true, profile:Object}|{ok:false, reason:string}}
 */
function buildProfileFromTemplate(template, entry) {
  if (!template || typeof template !== 'object' || !WIRE_VIA_VALUES.has(template.wireVia)) {
    return { ok: false, reason: 'invalid-template' };
  }
  const e = entry && typeof entry === 'object' ? entry : {};
  if (typeof e.id !== 'string' || !e.id) return { ok: false, reason: 'missing-id' };
  if (!hasText(e.label)) return { ok: false, reason: 'missing-label' };

  const apiKey = typeof e.apiKey === 'string' ? e.apiKey.trim() : '';
  if (template.requiresApiKey && !apiKey) return { ok: false, reason: 'missing-api-key' };

  const baseUrl = typeof e.baseUrl === 'string' ? e.baseUrl.trim() : '';
  if (template.requiresBaseUrl && !baseUrl) return { ok: false, reason: 'missing-base-url' };

  const vars = {
    apiKey,
    model: (typeof e.model === 'string' && e.model.trim()) || template.defaultModel,
    fastModel: (typeof e.fastModel === 'string' && e.fastModel.trim()) || template.defaultFastModel,
    baseUrl,
    ccrPort: Number.isFinite(e.ccrPort) && e.ccrPort > 0 ? Math.round(e.ccrPort) : DEFAULT_CCR_PORT,
  };

  const allowed = allowedEnvKeys(template);
  const env = {};
  for (const key of allowed) {
    env[key] = fillTemplate(template.envTemplate[key], vars);
  }
  // `extraEnv` (if ever passed by a caller) may only supply VALUES for keys
  // the template already declares - it can never introduce a new key. This
  // is the actual security check: everything above already only writes keys
  // from `allowed`, so this loop is a no-op by construction, but it stays
  // explicit rather than trusting that invariant silently.
  if (e.extraEnv && typeof e.extraEnv === 'object') {
    for (const [key, value] of Object.entries(e.extraEnv)) {
      if (allowed.has(key) && typeof value === 'string') env[key] = value;
    }
  }

  // A CCR-routed profile's `env` only ever points `claude` at the LOCAL
  // router (ANTHROPIC_BASE_URL=http://localhost:{{ccrPort}}), never at the
  // real provider - so the real apiKey/baseUrl the user just typed in must be
  // kept SOMEWHERE, or claude-code-router (src/ccr.js, a later phase) would
  // have nothing to configure its own Providers entry from. Kept OUT of
  // `env` on purpose: `env` feeds pty.spawn() for the `claude` process
  // directly, and that process never needs the real provider secret, only
  // CCR does. `ccrConfig` is stripped by redactProfile() exactly like `env`.
  const ccrConfig =
    template.wireVia === 'ccr'
      ? {
          providerType: template.ccrProviderType,
          ...(template.requiresApiKey ? { apiKey } : {}),
          ...(template.requiresBaseUrl ? { baseUrl } : {}),
        }
      : null;

  return {
    ok: true,
    profile: {
      id: e.id,
      label: normalizeText(e.label),
      command: 'claude',
      args: [],
      env,
      autoModel: template.autoModel,
      templateId: template.id,
      ccrConfig,
    },
  };
}

module.exports = {
  loadProviders,
  getProviderTemplate,
  normalizeProviderTemplate,
  allowedEnvKeys,
  buildProfileFromTemplate,
  ENV_KEY_DENY_RE,
  DEFAULT_CCR_PORT,
};
