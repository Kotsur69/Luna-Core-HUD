// ============================================================================
// LunaCore - AI-provider Settings panel: pure form logic
// ----------------------------------------------------------------------------
// Every decision here is pure (no document.*, no window.lunacore) so it can be
// unit-tested directly (test/providers-renderer.test.js) - the DOM/IPC half
// lives in providersettings.js. This module owns:
//   - which fields a provider template actually needs (an API key, a base
//     URL, a model/fast-model override) - src/providers.js's own
//     buildProfileFromTemplate() silently accepts extra fields a template has
//     no use for, so the UI must not offer them in the first place;
//   - turning a filled-in form into the exact payload
//     profiles:add-from-template / profiles:update-from-template expect,
//     with the SAME typed rejection reasons main.js's handlers use, so an
//     obviously-invalid submission never spends an IPC round trip; and
//   - mapping a typed failure reason to the i18n key that displays it.
// ============================================================================

'use strict';

/**
 * Only entries built FROM a provider template (src/providers.js) - a
 * hand-written profile (e.g. the shipped claude-cloud) has `templateId: null`
 * and is not editable from this panel (see providersettings.js's "other
 * profiles are edited by hand" hint).
 * @param {unknown} profiles
 * @returns {Array<Object>}
 */
function generatedProfiles(profiles) {
  if (!Array.isArray(profiles)) return [];
  return profiles.filter((p) => p && typeof p.templateId === 'string' && p.templateId);
}

/** True when any envTemplate value contains the literal `{{name}}` token. */
function usesPlaceholder(envTemplate, name) {
  const token = `{{${name}}}`;
  return Object.values(envTemplate || {}).some((v) => typeof v === 'string' && v.includes(token));
}

/**
 * Which inputs the add/edit form should show for one template. `autoModel`
 * templates (LM Studio) never show a model field, since buildProfileFromTemplate()
 * has nowhere to put a value for it. Otherwise a model/fast-model field shows
 * exactly when the template's own envTemplate uses the matching `{{model}}`/
 * `{{fastModel}}` placeholder - true for every direct-wired template that
 * templates a model (GLM/Kimi) and, since the CCR reshape, every CCR-routed
 * template too (their ANTHROPIC_MODEL/ANTHROPIC_SMALL_FAST_MODEL are an
 * OPTIONAL override left blank by default - see config/providers.json). A
 * `{{ccrPort}}` placeholder likewise shows the CCR-port field.
 * @param {{requiresApiKey?:boolean, requiresBaseUrl?:boolean, autoModel?:boolean, envTemplate?:Object}} template
 * @returns {{needsApiKey:boolean, needsBaseUrl:boolean, showModel:boolean, showFastModel:boolean, showCcrPort:boolean}}
 */
function templateFields(template) {
  const t = template && typeof template === 'object' ? template : {};
  const envTemplate = t.envTemplate && typeof t.envTemplate === 'object' ? t.envTemplate : {};
  const modelCapable = t.autoModel !== true;
  return {
    needsApiKey: t.requiresApiKey === true,
    needsBaseUrl: t.requiresBaseUrl === true,
    showModel: modelCapable && usesPlaceholder(envTemplate, 'model'),
    showFastModel: modelCapable && usesPlaceholder(envTemplate, 'fastModel'),
    showCcrPort: usesPlaceholder(envTemplate, 'ccrPort'),
  };
}

const LOCAL_LAUNCH_KEYS = ['shim', 'leanMcp', 'leanTools'];

/** Only the known boolean toggles of a localLaunch block (mirrors src/locallaunch.js). */
function pickToggles(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    LOCAL_LAUNCH_KEYS.filter((k) => typeof value[k] === 'boolean').map((k) => [k, value[k]]),
  );
}

/**
 * The lean-launch toggles the form should show for a local template: the
 * template's defaults with the profile's own override on top. Null when the
 * template has no local launch settings (every cloud provider).
 * @param {{localLaunch?:Object|null}|null} template
 * @param {{localLaunch?:Object|null}|null} profile
 * @returns {{shim:boolean, leanMcp:boolean, leanTools:boolean}|null}
 */
function localLaunchState(template, profile) {
  if (!template || typeof template !== 'object' || !template.localLaunch) return null;
  const merged = { ...pickToggles(template.localLaunch), ...pickToggles(profile && profile.localLaunch) };
  return Object.fromEntries(LOCAL_LAUNCH_KEYS.map((k) => [k, merged[k] === true]));
}

/** Adds `localLaunch` to a payload when the template supports it and the form sent toggles. */
function withLocalLaunch(payload, template, rawToggles) {
  if (!template.localLaunch || !rawToggles || typeof rawToggles !== 'object') return payload;
  return { ...payload, localLaunch: pickToggles(rawToggles) };
}

/** Reads a trimmed string field, or '' for anything else. */
function trimmedString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Validates an optional `ccrPort` form field. Mirrors how apiKey/baseUrl are
 * only ever included when non-empty: a field the template does not show
 * (`fields.showCcrPort` false) is ignored entirely, even if present and even
 * if it is junk - the template has nowhere to put it. When shown, an absent/
 * blank value is fine (means "use the default port"); a present-but-invalid
 * value (not a finite number in 1-65535) is a typed rejection.
 * @param {{showCcrPort:boolean}} fields templateFields(template)'s output
 * @param {unknown} rawPort form.ccrPort
 * @returns {{ok:true, port?:number}|{ok:false, reason:'invalid-port'}}
 */
function resolveCcrPort(fields, rawPort) {
  if (!fields.showCcrPort) return { ok: true };
  if (rawPort === undefined || rawPort === null || rawPort === '') return { ok: true };
  const num = typeof rawPort === 'number' ? rawPort : Number(rawPort);
  if (!Number.isFinite(num) || num < 1 || num > 65535) {
    return { ok: false, reason: 'invalid-port' };
  }
  return { ok: true, port: Math.round(num) };
}

/**
 * Builds the `profiles:add-from-template` payload from the add form, or a
 * typed rejection - the SAME reasons buildProfileFromTemplate() would return,
 * checked client-side first so an incomplete form never spends a round trip.
 * @param {{template:Object, label:string, apiKey?:string, baseUrl?:string,
 *   model?:string, fastModel?:string}} form
 * @returns {{ok:true, payload:Object}|{ok:false, reason:string}}
 */
function buildAddPayload(form) {
  const f = form && typeof form === 'object' ? form : {};
  const template = f.template;
  if (!template || typeof template !== 'object' || !template.id) {
    return { ok: false, reason: 'unknown-template' };
  }

  const label = trimmedString(f.label);
  if (!label) return { ok: false, reason: 'missing-label' };

  const fields = templateFields(template);
  const apiKey = trimmedString(f.apiKey);
  if (fields.needsApiKey && !apiKey) return { ok: false, reason: 'missing-api-key' };

  const baseUrl = trimmedString(f.baseUrl);
  if (fields.needsBaseUrl && !baseUrl) return { ok: false, reason: 'missing-base-url' };

  const ccrPort = resolveCcrPort(fields, f.ccrPort);
  if (!ccrPort.ok) return { ok: false, reason: ccrPort.reason };

  // `id` is fixed to the template's own id (never derived from the label) so
  // a repeat "add GLM" round-trips through addProfile()'s existing
  // uniqueId(slugify(...)) de-dup (kimi, kimi-2, ...) instead of scattering
  // ids derived from whatever label text the user happened to type.
  const payload = { templateId: template.id, id: template.id, label };
  if (apiKey) payload.apiKey = apiKey;
  if (baseUrl) payload.baseUrl = baseUrl;
  const model = trimmedString(f.model);
  if (model) payload.model = model;
  const fastModel = trimmedString(f.fastModel);
  if (fastModel) payload.fastModel = fastModel;
  if (ccrPort.port !== undefined) payload.ccrPort = ccrPort.port;

  return { ok: true, payload: withLocalLaunch(payload, template, f.localLaunch) };
}

/**
 * Builds the `profiles:update-from-template` payload from the edit form, or
 * a typed rejection. `hasApiKey`/`hasBaseUrl` come from the profile's own
 * redacted state (src/profiles.js's redactProfile()) - a blank apiKey/baseUrl
 * is only ever a validation error when the template needs one AND none is
 * already stored; otherwise a blank field means "keep the current value",
 * which main.js's update handler already implements.
 * @param {{id:string, template:Object, label:string, apiKey?:string,
 *   baseUrl?:string, model?:string, fastModel?:string, hasApiKey?:boolean,
 *   hasBaseUrl?:boolean}} form
 * @returns {{ok:true, payload:Object}|{ok:false, reason:string}}
 */
function buildEditPayload(form) {
  const f = form && typeof form === 'object' ? form : {};
  const id = trimmedString(f.id);
  if (!id) return { ok: false, reason: 'unknown-profile' };

  const template = f.template;
  if (!template || typeof template !== 'object' || !template.id) {
    return { ok: false, reason: 'unknown-template' };
  }

  const label = trimmedString(f.label);
  if (!label) return { ok: false, reason: 'missing-label' };

  const fields = templateFields(template);
  const apiKey = trimmedString(f.apiKey);
  if (fields.needsApiKey && !apiKey && f.hasApiKey !== true) return { ok: false, reason: 'missing-api-key' };

  const baseUrl = trimmedString(f.baseUrl);
  if (fields.needsBaseUrl && !baseUrl && f.hasBaseUrl !== true) return { ok: false, reason: 'missing-base-url' };

  const ccrPort = resolveCcrPort(fields, f.ccrPort);
  if (!ccrPort.ok) return { ok: false, reason: ccrPort.reason };

  const payload = { id, templateId: template.id, label };
  if (apiKey) payload.apiKey = apiKey;
  if (baseUrl) payload.baseUrl = baseUrl;
  const model = trimmedString(f.model);
  if (model) payload.model = model;
  const fastModel = trimmedString(f.fastModel);
  if (fastModel) payload.fastModel = fastModel;
  if (ccrPort.port !== undefined) payload.ccrPort = ccrPort.port;

  return { ok: true, payload: withLocalLaunch(payload, template, f.localLaunch) };
}

/** Every typed reason profiles:add/update-from-template can return. */
const FAILURE_KEYS = {
  'missing-label': 'providers.error.missingLabel',
  'missing-api-key': 'providers.error.missingApiKey',
  'missing-base-url': 'providers.error.missingBaseUrl',
  'missing-id': 'providers.error.missingId',
  'invalid-port': 'providers.error.invalidPort',
  'unknown-template': 'providers.error.unknownTemplate',
  'unknown-profile': 'providers.error.unknownProfile',
  'save-failed': 'providers.error.saveFailed',
};

/** Maps a typed failure reason to its i18n key; unknown reasons fall back to a generic one. */
function failureKey(reason) {
  return FAILURE_KEYS[reason] || 'providers.error.generic';
}

export { generatedProfiles, templateFields, localLaunchState, buildAddPayload, buildEditPayload, failureKey };
