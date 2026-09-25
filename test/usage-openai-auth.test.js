'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { OpenAiAdapter } = require('../src/usage');

test('OpenAiAdapter never picks ANTHROPIC_AUTH_TOKEN (a Kimi/CCR key) as the OpenAI key', () => {
  const profile = { templateId: 'kimi', env: { ANTHROPIC_AUTH_TOKEN: 'sk-kimi-secret' } };
  assert.equal(new OpenAiAdapter().getAuth(profile).apiKey, undefined);
});

test('OpenAiAdapter uses OPENAI_API_KEY when a profile sets one', () => {
  const profile = { templateId: 'codex', env: { ANTHROPIC_AUTH_TOKEN: 'ccr-client', OPENAI_API_KEY: 'sk-openai' } };
  assert.equal(new OpenAiAdapter().getAuth(profile).apiKey, 'sk-openai');
});

test('OpenAiAdapter reports unconfigured, with no network call, when only a foreign key is present', async () => {
  const profile = { templateId: 'gemini', env: { ANTHROPIC_AUTH_TOKEN: 'ccr-client' } };
  const usage = await new OpenAiAdapter().fetchUsage(profile);
  assert.equal(usage.status, 'unconfigured');
});
