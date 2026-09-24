// ============================================================================
// LunaCore - template profile input tests (src/profileinput.js)
// ----------------------------------------------------------------------------
// The renderer payload for profiles:add/update-from-template is untrusted.
// Two attacks are pinned here: an `extraEnv` that repoints a stored key's
// base URL, and an edit that switches a GLM profile to a CCR template while
// keeping its key. The keep-current rules moved out of main.js are pinned too.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { loadProviders, buildProfileFromTemplate } = require('../src/providers');
const { pickTemplateInput, resolveTemplateAdd, resolveTemplateUpdate } = require('../src/profileinput');

const { providers } = loadProviders();

const glmProfile = {
  id: 'glm',
  label: 'My GLM',
  templateId: 'glm',
  env: {
    ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic',
    ANTHROPIC_AUTH_TOKEN: 'real-glm-secret',
    ANTHROPIC_MODEL: 'glm-custom',
    ANTHROPIC_SMALL_FAST_MODEL: 'glm-fast-custom',
  },
};
const ollamaProfile = {
  id: 'ollama',
  label: 'Ollama',
  templateId: 'ollama',
  env: { ANTHROPIC_BASE_URL: 'http://localhost:3460', ANTHROPIC_AUTH_TOKEN: 'ccr-client-key' },
};
const lmProfile = {
  id: 'lm-studio',
  label: 'LM Studio',
  templateId: 'lm-studio',
  env: { ANTHROPIC_BASE_URL: 'http://localhost:1234', ANTHROPIC_AUTH_TOKEN: 'lmstudio' },
  localLaunch: { shim: false },
};
const handWritten = { id: 'claude-cloud', label: 'Claude', templateId: null, env: {} };
const profiles = [glmProfile, ollamaProfile, lmProfile, handWritten];

test('pickTemplateInput keeps only the form fields', () => {
  const picked = pickTemplateInput({
    templateId: 'glm',
    id: 'glm',
    label: 'x',
    apiKey: 'k',
    extraEnv: { ANTHROPIC_BASE_URL: 'https://evil.example' },
    env: { A: '1' },
    command: 'rm',
    args: ['-rf'],
    autoModel: true,
  });
  assert.deepEqual(Object.keys(picked).sort(), ['apiKey', 'id', 'label', 'templateId']);
});

test('pickTemplateInput tolerates junk payloads', () => {
  for (const bad of [null, undefined, 'x', 42, ['glm']]) assert.deepEqual(pickTemplateInput(bad), {});
});

test('resolveTemplateAdd rejects an unknown template and drops extraEnv', () => {
  assert.deepEqual(resolveTemplateAdd({ templateId: 'nope' }, providers), { ok: false, reason: 'unknown-template' });
  assert.deepEqual(resolveTemplateAdd({ templateId: { id: 'glm' } }, providers), { ok: false, reason: 'unknown-template' });
  const resolved = resolveTemplateAdd(
    { templateId: 'glm', id: 'glm', label: 'GLM', apiKey: 'k', extraEnv: { ANTHROPIC_BASE_URL: 'https://evil.example' } },
    providers,
  );
  assert.equal(resolved.ok, true);
  const built = buildProfileFromTemplate(resolved.template, resolved.input);
  assert.equal(built.profile.env.ANTHROPIC_BASE_URL, 'https://api.z.ai/api/anthropic');
});

test('an edit cannot repoint a stored key through extraEnv', () => {
  const resolved = resolveTemplateUpdate(
    profiles,
    { id: 'glm', extraEnv: { ANTHROPIC_BASE_URL: 'https://evil.example' } },
    providers,
  );
  assert.equal(resolved.ok, true);
  const built = buildProfileFromTemplate(resolved.template, resolved.input);
  assert.equal(built.profile.env.ANTHROPIC_BASE_URL, 'https://api.z.ai/api/anthropic');
  assert.equal(built.profile.env.ANTHROPIC_AUTH_TOKEN, 'real-glm-secret');
});

test('an edit never switches a profile to another template', () => {
  assert.deepEqual(
    resolveTemplateUpdate(profiles, { id: 'glm', templateId: 'ollama', ccrPort: 9999 }, providers),
    { ok: false, reason: 'template-mismatch' },
  );
  const same = resolveTemplateUpdate(profiles, { id: 'glm', templateId: 'glm' }, providers);
  assert.equal(same.ok, true);
  assert.equal(same.template.id, 'glm');
});

test('an edit refuses unknown and hand-written profiles', () => {
  for (const id of ['nope', undefined, 42]) {
    assert.deepEqual(resolveTemplateUpdate(profiles, { id }, providers), { ok: false, reason: 'unknown-profile' });
  }
  assert.deepEqual(
    resolveTemplateUpdate(profiles, { id: 'claude-cloud', templateId: 'glm', apiKey: 'k' }, providers),
    { ok: false, reason: 'unknown-template' },
  );
});

test('an edit keeps every field the payload does not resend', () => {
  const resolved = resolveTemplateUpdate(profiles, { id: 'glm' }, providers);
  assert.deepEqual(resolved.input, {
    id: 'glm',
    label: 'My GLM',
    apiKey: 'real-glm-secret',
    baseUrl: 'https://api.z.ai/api/anthropic',
    model: 'glm-custom',
    fastModel: 'glm-fast-custom',
    ccrPort: null,
    localLaunch: undefined,
  });
});

test('an edit applies the fields the payload does send', () => {
  const resolved = resolveTemplateUpdate(
    profiles,
    { id: 'glm', label: 'Renamed', apiKey: ' new-key ', model: 'glm-6' },
    providers,
  );
  assert.equal(resolved.input.label, 'Renamed');
  assert.equal(resolved.input.apiKey, 'new-key');
  assert.equal(resolved.input.model, 'glm-6');
  assert.equal(resolved.input.fastModel, 'glm-fast-custom');
});

test('a non-secret sentinel is never kept as a real key', () => {
  const resolved = resolveTemplateUpdate(profiles, { id: 'lm-studio' }, providers);
  assert.equal(resolved.input.apiKey, '');
  assert.deepEqual(resolved.input.localLaunch, { shim: false });
});

test('an edit keeps the current CCR port and passes any sent number through for validation', () => {
  assert.equal(resolveTemplateUpdate(profiles, { id: 'ollama' }, providers).input.ccrPort, 3460);
  assert.equal(resolveTemplateUpdate(profiles, { id: 'ollama', ccrPort: '4000' }, providers).input.ccrPort, 3460);
  assert.equal(resolveTemplateUpdate(profiles, { id: 'ollama', ccrPort: 4000 }, providers).input.ccrPort, 4000);
  for (const bad of [0, -5, 70000]) {
    const resolved = resolveTemplateUpdate(profiles, { id: 'ollama', ccrPort: bad }, providers);
    assert.deepEqual(buildProfileFromTemplate(resolved.template, resolved.input), { ok: false, reason: 'invalid-port' }, String(bad));
  }
});
