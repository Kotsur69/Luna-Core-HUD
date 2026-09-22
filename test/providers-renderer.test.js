// ============================================================================
// LunaCore - AI-provider Settings panel renderer tests
// ----------------------------------------------------------------------------
// providerform.js holds every PURE decision the panel makes (which fields a
// template needs, how to build an add/edit payload, which i18n key a typed
// failure reason maps to) - no document.*, no window.lunacore, so it can be
// require()'d directly from a plain `node --test` run. The DOM/IPC half lives
// in providersettings.js and is left untested for the same reason every other
// renderer modules/*.js file in this repo is (see test/ask-renderer.test.js's
// header comment): it does module-scope DOM work the moment it is imported.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { loadProviders, getProviderTemplate } = require('../src/providers');
const {
  generatedProfiles,
  templateFields,
  buildAddPayload,
  buildEditPayload,
  failureKey,
} = require('../src/renderer/modules/providerform.js');

const ROOT = path.join(__dirname, '..');
const { providers } = loadProviders();
const template = (id) => getProviderTemplate(providers, id);

// ---- generatedProfiles ---------------------------------------------------------------

test('generatedProfiles keeps only entries with a non-empty templateId', () => {
  const list = [
    { id: 'claude-cloud', templateId: null },
    { id: 'glm-1', templateId: 'glm' },
    { id: 'kimi-1', templateId: 'kimi' },
  ];
  assert.deepEqual(generatedProfiles(list).map((p) => p.id), ['glm-1', 'kimi-1']);
});

test('generatedProfiles tolerates junk input without throwing', () => {
  assert.deepEqual(generatedProfiles(undefined), []);
  assert.deepEqual(generatedProfiles(null), []);
  assert.deepEqual(generatedProfiles('nope'), []);
  assert.deepEqual(generatedProfiles([null, 42, { templateId: '' }, { templateId: 0 }]), []);
});

// ---- templateFields ---------------------------------------------------------------

test('templateFields matches every shipped template\'s real field needs', () => {
  const expected = {
    'claude-cloud': { needsApiKey: false, needsBaseUrl: false, showModel: false, showFastModel: false, showCcrPort: false },
    'lm-studio': { needsApiKey: false, needsBaseUrl: false, showModel: false, showFastModel: false, showCcrPort: false },
    glm: { needsApiKey: true, needsBaseUrl: false, showModel: true, showFastModel: true, showCcrPort: false },
    kimi: { needsApiKey: true, needsBaseUrl: false, showModel: true, showFastModel: false, showCcrPort: false },
    ollama: { needsApiKey: true, needsBaseUrl: false, showModel: true, showFastModel: true, showCcrPort: true },
    codex: { needsApiKey: true, needsBaseUrl: false, showModel: true, showFastModel: true, showCcrPort: true },
    gemini: { needsApiKey: true, needsBaseUrl: false, showModel: true, showFastModel: true, showCcrPort: true },
    grok: { needsApiKey: true, needsBaseUrl: false, showModel: true, showFastModel: true, showCcrPort: true },
    'openai-compatible': { needsApiKey: true, needsBaseUrl: false, showModel: true, showFastModel: true, showCcrPort: true },
  };
  for (const [id, want] of Object.entries(expected)) {
    assert.deepEqual(templateFields(template(id)), want, `templateFields(${id})`);
  }
});

test('templateFields behaves the same on a raw catalog entry (missing autoModel) as on a normalized one', () => {
  const raw = { id: 'kimi', requiresApiKey: true, envTemplate: { ANTHROPIC_MODEL: '{{model}}' } };
  assert.deepEqual(templateFields(raw), templateFields(template('kimi')));
});

test('templateFields shows a model field for a CCR-routed template exactly because its envTemplate now carries the placeholder', () => {
  // Since the CCR reshape, every CCR-routed template's envTemplate templates
  // {{model}}/{{fastModel}} directly (config/providers.json) - no more
  // wireVia special-casing needed, usesPlaceholder() alone is enough.
  const raw = {
    id: 'ollama',
    wireVia: 'ccr',
    requiresApiKey: true,
    envTemplate: {
      ANTHROPIC_BASE_URL: 'http://localhost:{{ccrPort}}',
      ANTHROPIC_AUTH_TOKEN: '{{apiKey}}',
      ANTHROPIC_MODEL: '{{model}}',
      ANTHROPIC_SMALL_FAST_MODEL: '{{fastModel}}',
    },
  };
  assert.equal(templateFields(raw).showModel, true);
  assert.equal(templateFields(raw).showFastModel, true);
  assert.equal(templateFields(raw).showCcrPort, true);
});

test('templateFields does not show a model field for a CCR-routed template whose envTemplate has no placeholder', () => {
  // Confirms there is no more wireVia:'ccr' special-case left in templateFields().
  const raw = {
    id: 'weird',
    wireVia: 'ccr',
    requiresApiKey: true,
    envTemplate: { ANTHROPIC_BASE_URL: 'http://localhost:{{ccrPort}}', ANTHROPIC_AUTH_TOKEN: '{{apiKey}}' },
  };
  assert.equal(templateFields(raw).showModel, false);
  assert.equal(templateFields(raw).showFastModel, false);
});

test('templateFields tolerates junk input without throwing', () => {
  const empty = { needsApiKey: false, needsBaseUrl: false, showModel: false, showFastModel: false, showCcrPort: false };
  assert.deepEqual(templateFields(null), empty);
  assert.deepEqual(templateFields(undefined), empty);
  assert.deepEqual(templateFields('nope'), empty);
});

// ---- buildAddPayload ---------------------------------------------------------------

test('buildAddPayload builds a valid payload for a template that needs a key and a model', () => {
  const result = buildAddPayload({
    template: template('glm'),
    label: '  My GLM key  ',
    apiKey: '  sk-glm  ',
    model: 'glm-5.3',
    fastModel: '',
  });
  assert.deepEqual(result, {
    ok: true,
    payload: { templateId: 'glm', id: 'glm', label: 'My GLM key', apiKey: 'sk-glm', model: 'glm-5.3' },
  });
});

test('buildAddPayload omits blank optional fields entirely rather than sending empty strings', () => {
  const result = buildAddPayload({ template: template('lm-studio'), label: 'LM Studio local' });
  assert.deepEqual(result, {
    ok: true,
    payload: { templateId: 'lm-studio', id: 'lm-studio', label: 'LM Studio local' },
  });
});

test('buildAddPayload rejects a missing/blank label', () => {
  assert.deepEqual(buildAddPayload({ template: template('glm'), label: '', apiKey: 'k' }), {
    ok: false,
    reason: 'missing-label',
  });
  assert.deepEqual(buildAddPayload({ template: template('glm'), apiKey: 'k' }), {
    ok: false,
    reason: 'missing-label',
  });
});

test('buildAddPayload rejects a missing API key when the template requires one', () => {
  assert.deepEqual(buildAddPayload({ template: template('kimi'), label: 'X' }), {
    ok: false,
    reason: 'missing-api-key',
  });
});

test('buildAddPayload rejects a missing base URL when the template requires one', () => {
  // No shipped template requires a base URL anymore - exercised against a
  // synthetic template so the (still-reusable) requiresBaseUrl check itself
  // stays covered.
  const patched = { ...template('openai-compatible'), requiresBaseUrl: true };
  assert.deepEqual(buildAddPayload({ template: patched, label: 'X', apiKey: 'k' }), {
    ok: false,
    reason: 'missing-base-url',
  });
});

test('buildAddPayload no longer requires a base URL for the shipped openai-compatible template', () => {
  const result = buildAddPayload({ template: template('openai-compatible'), label: 'X', apiKey: 'k' });
  assert.equal(result.ok, true);
});

test('buildAddPayload rejects an unknown/missing template', () => {
  assert.deepEqual(buildAddPayload({ label: 'X' }), { ok: false, reason: 'unknown-template' });
  assert.deepEqual(buildAddPayload({ template: {}, label: 'X' }), { ok: false, reason: 'unknown-template' });
});

test('buildAddPayload always sets id to the templateId, matching addProfile()\'s de-dup contract', () => {
  const result = buildAddPayload({ template: template('kimi'), label: 'Second Kimi key', apiKey: 'k' });
  assert.equal(result.payload.id, 'kimi');
  assert.equal(result.payload.templateId, 'kimi');
});

test('buildAddPayload includes a valid ccrPort as a number when the template shows the field', () => {
  const result = buildAddPayload({ template: template('ollama'), label: 'Ollama', apiKey: 'k', ccrPort: '4090' });
  assert.equal(result.ok, true);
  assert.equal(result.payload.ccrPort, 4090);
  assert.equal(typeof result.payload.ccrPort, 'number');
});

test('buildAddPayload omits ccrPort entirely when left blank', () => {
  const result = buildAddPayload({ template: template('ollama'), label: 'Ollama', apiKey: 'k' });
  assert.equal(result.ok, true);
  assert.equal('ccrPort' in result.payload, false);
});

test('buildAddPayload rejects an out-of-range or non-numeric ccrPort', () => {
  for (const bad of [0, -1, 65536, 999999, 'not-a-port', NaN]) {
    assert.deepEqual(
      buildAddPayload({ template: template('ollama'), label: 'Ollama', apiKey: 'k', ccrPort: bad }),
      { ok: false, reason: 'invalid-port' },
      `expected ccrPort ${bad} to be rejected`
    );
  }
});

test('buildAddPayload ignores ccrPort for a template that does not show the field', () => {
  // glm's envTemplate never templates {{ccrPort}} - the field is not shown,
  // so even a junk value is silently dropped rather than validated.
  const result = buildAddPayload({ template: template('glm'), label: 'GLM', apiKey: 'k', ccrPort: 'garbage' });
  assert.equal(result.ok, true);
  assert.equal('ccrPort' in result.payload, false);
});

// ---- buildEditPayload ---------------------------------------------------------------

test('buildEditPayload keeps the profile id and allows a blank key/baseUrl when one is already stored', () => {
  const result = buildEditPayload({
    id: 'glm-1',
    template: template('glm'),
    label: 'Renamed',
    apiKey: '',
    model: 'glm-5.3',
    hasApiKey: true,
  });
  assert.deepEqual(result, {
    ok: true,
    payload: { id: 'glm-1', templateId: 'glm', label: 'Renamed', model: 'glm-5.3' },
  });
});

test('buildEditPayload rejects a blank key when none is stored yet and the template requires one', () => {
  const result = buildEditPayload({
    id: 'kimi-1',
    template: template('kimi'),
    label: 'X',
    apiKey: '',
    hasApiKey: false,
  });
  assert.deepEqual(result, { ok: false, reason: 'missing-api-key' });
});

test('buildEditPayload rejects a missing/blank id as unknown-profile', () => {
  assert.deepEqual(buildEditPayload({ template: template('glm'), label: 'X', hasApiKey: true }), {
    ok: false,
    reason: 'unknown-profile',
  });
  assert.deepEqual(buildEditPayload({ id: '  ', template: template('glm'), label: 'X', hasApiKey: true }), {
    ok: false,
    reason: 'unknown-profile',
  });
});

test('buildEditPayload includes a non-blank apiKey/baseUrl when the caller does provide a replacement', () => {
  const result = buildEditPayload({
    id: 'oc-1',
    template: template('openai-compatible'),
    label: 'X',
    apiKey: 'new-key',
    baseUrl: 'https://new.example.com',
    hasApiKey: true,
    hasBaseUrl: true,
  });
  assert.deepEqual(result.payload, {
    id: 'oc-1',
    templateId: 'openai-compatible',
    label: 'X',
    apiKey: 'new-key',
    baseUrl: 'https://new.example.com',
  });
});

test('buildEditPayload includes a valid ccrPort and rejects an invalid one', () => {
  const valid = buildEditPayload({
    id: 'ollama-1',
    template: template('ollama'),
    label: 'Ollama',
    hasApiKey: true,
    ccrPort: 4090,
  });
  assert.equal(valid.ok, true);
  assert.equal(valid.payload.ccrPort, 4090);

  const invalid = buildEditPayload({
    id: 'ollama-1',
    template: template('ollama'),
    label: 'Ollama',
    hasApiKey: true,
    ccrPort: 70000,
  });
  assert.deepEqual(invalid, { ok: false, reason: 'invalid-port' });
});

test('buildEditPayload ignores ccrPort for a template that does not show the field', () => {
  const result = buildEditPayload({
    id: 'glm-1',
    template: template('glm'),
    label: 'GLM',
    hasApiKey: true,
    ccrPort: 'garbage',
  });
  assert.equal(result.ok, true);
  assert.equal('ccrPort' in result.payload, false);
});

// ---- failureKey ---------------------------------------------------------------

test('failureKey maps every typed reason returned by main.js\'s handlers to a providers.error.* key', () => {
  const map = {
    'missing-label': 'providers.error.missingLabel',
    'missing-api-key': 'providers.error.missingApiKey',
    'missing-base-url': 'providers.error.missingBaseUrl',
    'missing-id': 'providers.error.missingId',
    'invalid-port': 'providers.error.invalidPort',
    'unknown-template': 'providers.error.unknownTemplate',
    'unknown-profile': 'providers.error.unknownProfile',
    'save-failed': 'providers.error.saveFailed',
  };
  for (const [reason, key] of Object.entries(map)) {
    assert.equal(failureKey(reason), key, reason);
  }
});

test('failureKey falls back to a generic key for an unknown reason', () => {
  assert.equal(failureKey('something-new'), 'providers.error.generic');
  assert.equal(failureKey(undefined), 'providers.error.generic');
  assert.equal(failureKey(null), 'providers.error.generic');
});

// ---- i18n: the AI-providers section's own strings ---------------------------------------

test('every providers.* i18n key used by the panel exists in both languages', () => {
  const i18nSrc = fs.readFileSync(path.join(ROOT, 'src/renderer/i18n.js'), 'utf8');
  const enAt = i18nSrc.indexOf('\n  en: {');
  assert.ok(enAt > 0, 'i18n.js should have a `pl` block followed by an `en` block');
  const pl = i18nSrc.slice(0, enAt);
  const en = i18nSrc.slice(enAt);

  const settingsSrc = fs.readFileSync(
    path.join(ROOT, 'src/renderer/modules/providersettings.js'),
    'utf8'
  );
  const htmlSrc = fs.readFileSync(path.join(ROOT, 'src/renderer/index.html'), 'utf8');

  const keys = new Set([
    ...[...settingsSrc.matchAll(/t\('((?:providers|termcustom\.section\.providers)\.[a-zA-Z.]+)'/g)].map(
      (m) => m[1]
    ),
    ...[...settingsSrc.matchAll(/t\('(termcustom\.section\.providers)'/g)].map((m) => m[1]),
    ...[...htmlSrc.matchAll(/data-i18n(?:-ph|-title|-aria)?="((?:providers|termcustom\.section\.providers)[a-zA-Z.]*)"/g)].map(
      (m) => m[1]
    ),
  ]);

  assert.ok(keys.size > 0, 'found no providers.* keys to check - did the selectors drift?');
  for (const key of keys) {
    assert.ok(pl.includes(`'${key}':`), `missing pl translation: ${key}`);
    assert.ok(en.includes(`'${key}':`), `missing en translation: ${key}`);
  }
});

test('every providers.* i18n key is present in both languages, independent of current usage', () => {
  // Broader than the scan above: many of this panel's keys are only ever
  // reached through a variable (titleKey/labelKey in providersettings.js,
  // FAILURE_KEYS in providerform.js), which the literal-t('...') scan cannot
  // see - so this pins the full set the plan specifies, regardless of how
  // the code happens to reference each one.
  const i18nSrc = fs.readFileSync(path.join(ROOT, 'src/renderer/i18n.js'), 'utf8');
  const enAt = i18nSrc.indexOf('\n  en: {');
  const pl = i18nSrc.slice(0, enAt);
  const en = i18nSrc.slice(enAt);

  const expectedKeys = [
    'termcustom.section.providers',
    'providers.hint',
    'providers.loading',
    'providers.empty',
    'providers.other',
    'providers.item.keySet',
    'providers.item.noKey',
    'providers.item.baseUrlSet',
    'providers.item.baseUrlMissing',
    'providers.item.model',
    'providers.action.add',
    'providers.action.edit',
    'providers.action.remove',
    'providers.action.save',
    'providers.action.cancel',
    'providers.action.docs',
    'providers.remove.confirm',
    'providers.form.add.title',
    'providers.form.edit.title',
    'providers.form.template',
    'providers.form.label',
    'providers.form.label.ph',
    'providers.form.apiKey',
    'providers.form.apiKey.ph',
    'providers.form.apiKey.keepPh',
    'providers.form.baseUrl',
    'providers.form.baseUrl.ph',
    'providers.form.model',
    'providers.form.model.ph',
    'providers.form.fastModel',
    'providers.note.ccr',
    'providers.note.autoModel',
    'providers.saved.add',
    'providers.saved.edit',
    'providers.error.missingLabel',
    'providers.error.missingApiKey',
    'providers.error.missingBaseUrl',
    'providers.error.missingId',
    'providers.error.unknownTemplate',
    'providers.error.unknownProfile',
    'providers.error.saveFailed',
    'providers.error.generic',
  ];

  for (const key of expectedKeys) {
    assert.ok(pl.includes(`'${key}':`), `missing pl translation: ${key}`);
    assert.ok(en.includes(`'${key}':`), `missing en translation: ${key}`);
  }
});
