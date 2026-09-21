// Tests for the AI-provider template catalog. buildProfileFromTemplate is the
// security boundary: it is the ONLY place a renderer-supplied string (an API
// key, a model name) ever becomes part of a profile's `env`, which flows
// straight into pty.spawn(). The set of env VAR NAMES a profile can ever carry
// is fixed by the shipped template (config/providers.json), never by anything
// the renderer sends - only the substituted VALUES are user-controlled.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  loadProviders,
  getProviderTemplate,
  normalizeProviderTemplate,
  allowedEnvKeys,
  buildProfileFromTemplate,
  ENV_KEY_DENY_RE,
} = require('../src/providers');

test('loadProviders reads the shipped catalog and every entry normalizes', () => {
  const { providers } = loadProviders();
  assert.ok(providers.length >= 8, `expected several shipped providers, got ${providers.length}`);
  const ids = providers.map((p) => p.id);
  for (const id of ['claude-cloud', 'lm-studio', 'glm', 'kimi', 'ollama', 'codex', 'gemini', 'grok', 'openai-compatible']) {
    assert.ok(ids.includes(id), `missing shipped provider: ${id}`);
  }
});

test('getProviderTemplate finds by id, otherwise null', () => {
  const { providers } = loadProviders();
  assert.equal(getProviderTemplate(providers, 'kimi').id, 'kimi');
  assert.equal(getProviderTemplate(providers, 'no-such-id'), null);
  assert.equal(getProviderTemplate([], 'kimi'), null);
});

test('normalizeProviderTemplate rejects entries without id, label, or wireVia', () => {
  assert.equal(normalizeProviderTemplate({ label: 'X', wireVia: 'direct' }), null);
  assert.equal(normalizeProviderTemplate({ id: 'x', wireVia: 'direct' }), null);
  assert.equal(normalizeProviderTemplate({ id: 'x', label: 'X' }), null);
});

test('normalizeProviderTemplate rejects an unknown wireVia', () => {
  assert.equal(normalizeProviderTemplate({ id: 'x', label: 'X', wireVia: 'telepathy' }), null);
});

test('normalizeProviderTemplate rejects non-objects', () => {
  assert.equal(normalizeProviderTemplate(null), null);
  assert.equal(normalizeProviderTemplate('x'), null);
  assert.equal(normalizeProviderTemplate(42), null);
});

test('normalizeProviderTemplate keeps only string values in envTemplate', () => {
  const t = normalizeProviderTemplate({
    id: 'x',
    label: 'X',
    wireVia: 'direct',
    envTemplate: { OK: 'yes', NUMBER: 8080, NESTED: { a: 1 } },
  });
  assert.deepEqual(t.envTemplate, { OK: 'yes' });
});

test('normalizeProviderTemplate coerces junk boolean/string fields to safe defaults', () => {
  const t = normalizeProviderTemplate({
    id: 'x',
    label: 'X',
    wireVia: 'direct',
    requiresApiKey: 'yes', // not === true -> false
    requiresBaseUrl: 1, // not === true -> false
    autoModel: 'yes', // not === true -> false
    defaultModel: 42, // not a string -> ''
    defaultFastModel: null, // not a string -> ''
    ccrProviderType: {}, // not a string -> ''
    docsUrl: [], // not a string -> ''
  });
  assert.equal(t.requiresApiKey, false);
  assert.equal(t.requiresBaseUrl, false);
  assert.equal(t.autoModel, false);
  assert.equal(t.defaultModel, '');
  assert.equal(t.defaultFastModel, '');
  assert.equal(t.ccrProviderType, '');
  assert.equal(t.docsUrl, '');
});

test('normalizeProviderTemplate drops envTemplate keys matching the deny-list', () => {
  const t = normalizeProviderTemplate({
    id: 'x',
    label: 'X',
    wireVia: 'direct',
    envTemplate: { ANTHROPIC_AUTH_TOKEN: '{{apiKey}}', PATH: '/evil', NODE_OPTIONS: '--inspect' },
  });
  assert.deepEqual(t.envTemplate, { ANTHROPIC_AUTH_TOKEN: '{{apiKey}}' });
});

test('ENV_KEY_DENY_RE matches the dangerous prefixes it is meant to block', () => {
  for (const key of ['PATH', 'Path', 'NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE', 'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES', 'PYTHONPATH', 'npm_config_x']) {
    assert.ok(ENV_KEY_DENY_RE.test(key), `expected deny-list to match ${key}`);
  }
  for (const key of ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL']) {
    assert.ok(!ENV_KEY_DENY_RE.test(key), `expected deny-list to allow ${key}`);
  }
});

test('allowedEnvKeys returns exactly the envTemplate key set', () => {
  const t = normalizeProviderTemplate({
    id: 'x',
    label: 'X',
    wireVia: 'direct',
    envTemplate: { ANTHROPIC_BASE_URL: 'https://x', ANTHROPIC_AUTH_TOKEN: '{{apiKey}}' },
  });
  assert.deepEqual([...allowedEnvKeys(t)].sort(), ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL']);
});

test('buildProfileFromTemplate fills placeholders and never invents extra env keys', () => {
  const { providers } = loadProviders();
  const kimi = getProviderTemplate(providers, 'kimi');
  const result = buildProfileFromTemplate(kimi, { id: 'kimi', label: 'Kimi', apiKey: 'sk-test-123' });
  assert.equal(result.ok, true);
  assert.equal(result.profile.id, 'kimi');
  assert.equal(result.profile.command, 'claude');
  assert.equal(result.profile.templateId, 'kimi');
  assert.equal(result.profile.env.ANTHROPIC_AUTH_TOKEN, 'sk-test-123');
  assert.equal(result.profile.env.ANTHROPIC_MODEL, 'kimi-k2-0905-preview'); // falls back to defaultModel
  assert.deepEqual(Object.keys(result.profile.env).sort(), [...allowedEnvKeys(kimi)].sort());
});

test('buildProfileFromTemplate honors an explicit model over the template default', () => {
  const { providers } = loadProviders();
  const kimi = getProviderTemplate(providers, 'kimi');
  const result = buildProfileFromTemplate(kimi, { id: 'kimi', label: 'Kimi', apiKey: 'k', model: 'kimi-custom' });
  assert.equal(result.profile.env.ANTHROPIC_MODEL, 'kimi-custom');
});

test('buildProfileFromTemplate fills every env key of the multi-key glm template correctly', () => {
  const { providers } = loadProviders();
  const glm = getProviderTemplate(providers, 'glm');
  const result = buildProfileFromTemplate(glm, {
    id: 'glm',
    label: 'GLM',
    apiKey: 'glm-key',
    model: 'glm-custom',
    fastModel: 'glm-custom-flash',
  });
  assert.equal(result.ok, true);
  const { env } = result.profile;
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'glm-key');
  // {{model}} is reused across every "default X model" slot.
  for (const key of [
    'ANTHROPIC_MODEL',
    'ANTHROPIC_DEFAULT_OPUS_MODEL',
    'ANTHROPIC_DEFAULT_SONNET_MODEL',
    'ANTHROPIC_DEFAULT_FABLE_MODEL',
    'CLAUDE_CODE_SUBAGENT_MODEL',
  ]) {
    assert.equal(env[key], 'glm-custom', `${key} should carry the model`);
  }
  // {{fastModel}} is reused across the "fast" slots.
  assert.equal(env.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'glm-custom-flash');
  assert.equal(env.ANTHROPIC_SMALL_FAST_MODEL, 'glm-custom-flash');
  // A static value with no {{placeholder}} passes through unchanged.
  assert.equal(env.API_TIMEOUT_MS, '3000000');
  assert.deepEqual(Object.keys(env).sort(), [...allowedEnvKeys(glm)].sort());
});

test('buildProfileFromTemplate falls back to the template defaultFastModel when none is given', () => {
  const { providers } = loadProviders();
  const glm = getProviderTemplate(providers, 'glm');
  const result = buildProfileFromTemplate(glm, { id: 'glm', label: 'GLM', apiKey: 'k' });
  assert.equal(result.ok, true);
  assert.equal(result.profile.env.ANTHROPIC_SMALL_FAST_MODEL, 'glm-5.3-flash');
  assert.equal(result.profile.env.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'glm-5.3-flash');
});

test('buildProfileFromTemplate rejects a renderer-supplied env key that is not in the template', () => {
  // Simulates a malicious/buggy renderer payload trying to smuggle an extra
  // env var through the `extraEnv` escape hatch - it must be silently dropped,
  // not merged in, since that is exactly the RCE-shaped surface this guards.
  const { providers } = loadProviders();
  const kimi = getProviderTemplate(providers, 'kimi');
  const result = buildProfileFromTemplate(kimi, {
    id: 'kimi',
    label: 'Kimi',
    apiKey: 'k',
    extraEnv: { LD_PRELOAD: '/evil.so', NODE_OPTIONS: '--inspect=0.0.0.0:9229', RANDOM_KEY: 'x' },
  });
  assert.equal(result.ok, true);
  assert.equal(result.profile.env.LD_PRELOAD, undefined);
  assert.equal(result.profile.env.NODE_OPTIONS, undefined);
  assert.equal(result.profile.env.RANDOM_KEY, undefined);
  assert.deepEqual(Object.keys(result.profile.env).sort(), [...allowedEnvKeys(kimi)].sort());
});

test('buildProfileFromTemplate fails when a required API key is missing', () => {
  const { providers } = loadProviders();
  const kimi = getProviderTemplate(providers, 'kimi');
  const result = buildProfileFromTemplate(kimi, { id: 'kimi', label: 'Kimi' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'missing-api-key');
});

test('buildProfileFromTemplate does not require an API key when the template does not need one', () => {
  const { providers } = loadProviders();
  const lmStudio = getProviderTemplate(providers, 'lm-studio');
  const result = buildProfileFromTemplate(lmStudio, { id: 'lm-studio', label: 'LM Studio' });
  assert.equal(result.ok, true);
  assert.equal(result.profile.env.ANTHROPIC_AUTH_TOKEN, 'lmstudio');
  assert.equal(result.profile.autoModel, true);
});

test('buildProfileFromTemplate rejects when a required base URL is missing', () => {
  const { providers } = loadProviders();
  const generic = getProviderTemplate(providers, 'openai-compatible');
  const result = buildProfileFromTemplate(generic, { id: 'custom', label: 'Custom', apiKey: 'k' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'missing-base-url');
});

test('buildProfileFromTemplate persists the real apiKey/baseUrl of a CCR-routed provider in ccrConfig, not env', () => {
  // env only ever points claude at the LOCAL router - the real secret/endpoint
  // has to survive somewhere for claude-code-router (a later phase) to read,
  // or it is silently lost the moment this call returns.
  const { providers } = loadProviders();
  const generic = getProviderTemplate(providers, 'openai-compatible');
  const result = buildProfileFromTemplate(generic, {
    id: 'custom',
    label: 'Custom',
    apiKey: 'sk-custom-secret',
    baseUrl: 'https://my-endpoint.example/v1',
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.profile.ccrConfig, {
    providerType: 'openai-compatible',
    apiKey: 'sk-custom-secret',
    baseUrl: 'https://my-endpoint.example/v1',
  });
  // The real secret/endpoint must NOT leak into env - env only carries the
  // fixed local-router pointer.
  assert.equal(JSON.stringify(result.profile.env).includes('sk-custom-secret'), false);
  assert.equal(JSON.stringify(result.profile.env).includes('my-endpoint'), false);
});

test('buildProfileFromTemplate sets ccrConfig to null for a direct-wired template', () => {
  const { providers } = loadProviders();
  const kimi = getProviderTemplate(providers, 'kimi');
  const result = buildProfileFromTemplate(kimi, { id: 'kimi', label: 'Kimi', apiKey: 'k' });
  assert.equal(result.profile.ccrConfig, null);
});

test('buildProfileFromTemplate omits apiKey/baseUrl from ccrConfig when the template does not require them', () => {
  const { providers } = loadProviders();
  const ollama = getProviderTemplate(providers, 'ollama'); // requiresApiKey: false, no baseUrl
  const result = buildProfileFromTemplate(ollama, { id: 'ollama', label: 'Ollama' });
  assert.equal(result.ok, true);
  assert.deepEqual(result.profile.ccrConfig, { providerType: 'ollama' });
});

test('buildProfileFromTemplate rejects a null/invalid template', () => {
  assert.equal(buildProfileFromTemplate(null, { id: 'x', label: 'X' }).ok, false);
  assert.equal(buildProfileFromTemplate({}, { id: 'x', label: 'X' }).ok, false);
});

test('buildProfileFromTemplate rejects an entry without id or label', () => {
  const { providers } = loadProviders();
  const kimi = getProviderTemplate(providers, 'kimi');
  assert.equal(buildProfileFromTemplate(kimi, { label: 'Kimi', apiKey: 'k' }).ok, false);
  assert.equal(buildProfileFromTemplate(kimi, { id: 'kimi', apiKey: 'k' }).ok, false);
});

test('buildProfileFromTemplate fills a CCR-routed template with the given port', () => {
  const { providers } = loadProviders();
  const ollama = getProviderTemplate(providers, 'ollama');
  const result = buildProfileFromTemplate(ollama, { id: 'ollama', label: 'Ollama', ccrPort: 4090 });
  assert.equal(result.ok, true);
  assert.equal(result.profile.env.ANTHROPIC_BASE_URL, 'http://localhost:4090');
});

test('buildProfileFromTemplate defaults the CCR port when none is given', () => {
  const { providers } = loadProviders();
  const ollama = getProviderTemplate(providers, 'ollama');
  const result = buildProfileFromTemplate(ollama, { id: 'ollama', label: 'Ollama' });
  assert.equal(result.ok, true);
  assert.match(result.profile.env.ANTHROPIC_BASE_URL, /^http:\/\/localhost:\d+$/);
});
