// ============================================================================
// LunaCore - renderer input for template-built profiles (IPC boundary)
// ----------------------------------------------------------------------------
// profiles:add-from-template and profiles:update-from-template take a payload
// straight from the renderer. This module turns that payload into the entry
// buildProfileFromTemplate() receives, and it is the place the renderer is
// NOT trusted:
//   - only the fields the Settings form actually sends survive. `extraEnv`
//     in particular never crosses IPC: it could set any env key the template
//     declares, e.g. repoint a stored GLM key's ANTHROPIC_BASE_URL at an
//     attacker's host while the key itself is kept;
//   - an edit never switches a profile's template. The stored key is kept on
//     an edit that does not resend it, so a template switch would carry a
//     GLM/Kimi key into a CCR profile (and into ccr:test-key).
// Extracted from main.js so these rules are unit-tested.
// ============================================================================

'use strict';

const { getProviderTemplate } = require('./providers');
const { getProfile, NON_SECRET_AUTH_TOKENS } = require('./profiles');
const { gatewayPortFromEnv } = require('./ccr');

/** Everything the Settings add/edit form may send (providerform.js). */
const TEMPLATE_INPUT_FIELDS = ['templateId', 'id', 'label', 'apiKey', 'baseUrl', 'model', 'fastModel', 'ccrPort', 'localLaunch'];

/**
 * Keeps only the known form fields of a renderer payload.
 * @param {unknown} payload
 * @returns {Object}
 */
function pickTemplateInput(payload) {
  const p = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
  return Object.fromEntries(
    TEMPLATE_INPUT_FIELDS.filter((k) => Object.prototype.hasOwnProperty.call(p, k)).map((k) => [k, p[k]]),
  );
}

/** A trimmed non-empty string, or ''. */
function given(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * profiles:add-from-template: the template and the entry to build from.
 * @param {unknown} payload
 * @param {Array<Object>} providers loadProviders().providers
 * @returns {{ok:true, template:Object, input:Object}|{ok:false, reason:string}}
 */
function resolveTemplateAdd(payload, providers) {
  const input = pickTemplateInput(payload);
  const template = typeof input.templateId === 'string' ? getProviderTemplate(providers, input.templateId) : null;
  if (!template) return { ok: false, reason: 'unknown-template' };
  return { ok: true, template, input };
}

/**
 * profiles:update-from-template: re-derives an existing generated profile
 * from its OWN template with the changed fields.
 *
 * profiles:list only ever sends the renderer a REDACTED profile (no env - see
 * redactProfile), so a "just change the model" edit cannot legitimately
 * resend the existing apiKey/baseUrl - it never had them. `profiles` is
 * main's own UNREDACTED in-memory copy, so every field the payload omits
 * falls back to what is already stored rather than failing the update.
 * @param {Array<Object>} profiles main's unredacted profiles
 * @param {unknown} payload
 * @param {Array<Object>} providers loadProviders().providers
 * @returns {{ok:true, template:Object, input:Object}|{ok:false, reason:string}}
 */
function resolveTemplateUpdate(profiles, payload, providers) {
  const p = pickTemplateInput(payload);
  const current = typeof p.id === 'string' ? getProfile(profiles, p.id) : null;
  if (!current) return { ok: false, reason: 'unknown-profile' };
  // A hand-written profile (no templateId) is not edited through templates.
  if (typeof current.templateId !== 'string' || !current.templateId) return { ok: false, reason: 'unknown-template' };
  if (p.templateId !== undefined && p.templateId !== current.templateId) return { ok: false, reason: 'template-mismatch' };
  const template = getProviderTemplate(providers, current.templateId);
  if (!template) return { ok: false, reason: 'unknown-template' };

  const env = current.env || {};
  // Keep-current fallback for apiKey: a profile still carrying a NON-SECRET
  // sentinel (LM Studio's 'lmstudio', or the legacy 'ccr-local' placeholder -
  // see NON_SECRET_AUTH_TOKENS in profiles.js) must not be treated as "a real
  // key already exists" - fall back to '' for those instead, so the "needs a
  // key" UI state survives an edit that doesn't resend one.
  const currentToken = typeof env.ANTHROPIC_AUTH_TOKEN === 'string' ? env.ANTHROPIC_AUTH_TOKEN : '';
  const apiKey = given(p.apiKey) || (NON_SECRET_AUTH_TOKENS.has(currentToken) ? '' : currentToken);
  const baseUrl = given(p.baseUrl) || env.ANTHROPIC_BASE_URL || '';
  // Same keep-current rule for model/fastModel (security-reviewer's Phase 3
  // finding): without it, buildProfileFromTemplate() falls back to the
  // TEMPLATE's default model whenever the payload omits one, silently
  // discarding a custom model on any edit that doesn't resend it.
  const model = given(p.model) || env.ANTHROPIC_MODEL || '';
  const fastModel = given(p.fastModel) || env.ANTHROPIC_SMALL_FAST_MODEL || '';
  // Any number the payload sends goes through as-is, so an out-of-range port
  // is rejected by buildProfileFromTemplate() exactly as on add. Otherwise
  // keep the port the current base URL implies (null for a non-local one).
  const ccrPort = typeof p.ccrPort === 'number' ? p.ccrPort : gatewayPortFromEnv(current.env);
  // Same keep-current rule for the lean-launch toggles.
  const localLaunch = p.localLaunch && typeof p.localLaunch === 'object' ? p.localLaunch : current.localLaunch;

  return {
    ok: true,
    template,
    input: {
      id: current.id,
      label: p.label || current.label,
      apiKey,
      baseUrl,
      model,
      fastModel,
      ccrPort,
      localLaunch,
    },
  };
}

module.exports = { pickTemplateInput, resolveTemplateAdd, resolveTemplateUpdate, TEMPLATE_INPUT_FIELDS };
