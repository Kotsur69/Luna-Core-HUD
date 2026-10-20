// ============================================================================
// LunaCore - usage limits for non-Claude providers
// (src/providerusageparse.js + src/providerusage.js)
// ----------------------------------------------------------------------------
// Parsers run against fixtures shaped like each provider's real payload; the
// fetchers run against an injected request/readFile, so nothing leaves the
// machine and no key is ever sent anywhere.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const parse = require('../src/providerusageparse');
const {
  usageSourceForProfile,
  profilesForUsage,
  fetchProviderUsage,
  fetchOtherProvidersUsage,
} = require('../src/providerusage');

const NOW = Date.parse('2026-10-20T12:00:00Z');

// --- fixtures -----------------------------------------------------------------

const CODEX_ROLLOUT = [
  JSON.stringify({ timestamp: '2026-10-20T10:00:00Z', type: 'session_meta', payload: { id: 'x' } }),
  JSON.stringify({
    timestamp: '2026-10-20T11:00:00Z',
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: null,
      rate_limits: {
        primary: { used_percent: 10, window_minutes: 300, resets_in_seconds: 600 },
        secondary: { used_percent: 30, window_minutes: 10080, resets_in_seconds: 3600 },
      },
    },
  }),
  '{"broken": ',
  JSON.stringify({
    timestamp: '2026-10-20T11:30:00Z',
    type: 'event_msg',
    payload: {
      type: 'token_count',
      rate_limits: {
        primary: { used_percent: 42.4, window_minutes: 300, resets_at: 1792497600 },
        secondary: { used_percent: 61, window_minutes: 10080, resets_in_seconds: 7200 },
      },
    },
  }),
  JSON.stringify({ timestamp: '2026-10-20T11:31:00Z', type: 'response_item', payload: { type: 'message' } }),
].join('\n');

const CODEX_WHAM = {
  plan_type: 'plus',
  rate_limit: {
    allowed: true,
    limit_reached: false,
    primary_window: { used_percent: 7, limit_window_seconds: 18000, reset_after_seconds: 1800 },
    secondary_window: { used_percent: 55, limit_window_seconds: 604800, reset_at: 1792800000 },
  },
};

const ZAI_QUOTA = {
  code: 200,
  success: true,
  data: {
    limits: [
      { type: 'TOKENS_LIMIT', unit: 3, number: 5, usage: 800000, currentValue: 200000, percentage: 25, nextResetTime: 1792490000000 },
      { type: 'TIME_LIMIT', unit: 5, number: 1, usage: 1000, currentValue: 120, remaining: 880, percentage: 12 },
    ],
  },
};

const KIMI_CODE_USAGES = {
  usage: { limit: '2000', used: '500', remaining: '1500', resetTime: '2026-10-25T00:00:00Z' },
  limits: [
    { window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' }, detail: { limit: '200', remaining: '150', resetTime: '2026-10-20T14:00:00Z' } },
  ],
};

const MOONSHOT_BALANCE = { code: 0, data: { available_balance: 49.584, voucher_balance: 46.58, cash_balance: 3.0 }, status: true };

const GEMINI_QUOTA = {
  buckets: [
    { modelId: 'gemini-3-pro', tokenType: 'REQUESTS', remainingFraction: 0.75, resetTime: '2026-10-21T00:00:00Z' },
    { modelId: 'gemini-3-pro', tokenType: 'INPUT_TOKENS', remainingFraction: 0.4, resetTime: '2026-10-21T00:00:00Z' },
    { modelId: 'gemini-3-flash', remainingFraction: 1 },
    { modelId: 'no-fraction' },
  ],
};

// --- pure parsers ---------------------------------------------------------------

test('latestCodexRateLimits takes the NEWEST token_count event and skips broken lines', () => {
  const hit = parse.latestCodexRateLimits(CODEX_ROLLOUT);
  assert.equal(hit.at, Date.parse('2026-10-20T11:30:00Z'));
  assert.deepEqual(hit.limits.map((l) => [l.window, l.percentUsed]), [['5h', 42], ['weekly', 61]]);
  // Absolute epoch seconds and relative seconds both become ISO times.
  assert.equal(hit.limits[0].resetsAt, new Date(1792497600 * 1000).toISOString());
  assert.equal(hit.limits[1].resetsAt, '2026-10-20T13:30:00.000Z');
});

test('latestCodexRateLimits returns null for a log without rate limits', () => {
  assert.equal(parse.latestCodexRateLimits(''), null);
  assert.equal(parse.latestCodexRateLimits('{"type":"x"}\nnot json'), null);
});

test('parseCodexUsageResponse reads the backend window spelling', () => {
  const limits = parse.parseCodexUsageResponse(CODEX_WHAM, NOW);
  assert.deepEqual(limits.map((l) => [l.window, l.percentUsed]), [['5h', 7], ['weekly', 55]]);
  assert.equal(limits[0].resetsAt, new Date(NOW + 1800 * 1000).toISOString());
  assert.equal(limits[1].resetsAt, new Date(1792800000 * 1000).toISOString());
  assert.equal(parse.parseCodexUsageResponse({}, NOW), null);
});

test('parseZaiQuota maps the 5 h token window and the monthly tool quota', () => {
  const limits = parse.parseZaiQuota(ZAI_QUOTA);
  assert.equal(limits.length, 2);
  assert.deepEqual([limits[0].window, limits[0].percentUsed, limits[0].unit], ['5h', 25, 'tokens']);
  assert.equal(limits[0].resetsAt, new Date(1792490000000).toISOString());
  assert.deepEqual([limits[1].window, limits[1].label, limits[1].percentUsed], ['monthly', 'Tool calls (MCP)', 12]);
  assert.equal(limits[1].resetsAt, null);
  assert.equal(parse.parseZaiQuota({ code: 401 }), null);
});

test('parseZaiQuota derives the percentage when only counts are given', () => {
  const limits = parse.parseZaiQuota({ data: { limits: [{ type: 'TOKENS_LIMIT', unit: 3, number: 5, usage: 400, currentValue: 100 }] } });
  assert.equal(limits[0].percentUsed, 25);
});

test('parseKimiCodeUsages reads the rolling window and the weekly summary', () => {
  const limits = parse.parseKimiCodeUsages(KIMI_CODE_USAGES);
  assert.deepEqual(limits.map((l) => [l.window, l.percentUsed]), [['5h', 25], ['weekly', 25]]);
  assert.equal(limits[1].resetsAt, '2026-10-25T00:00:00.000Z');
  assert.equal(parse.parseKimiCodeUsages({ usage: { limit: '0', used: '0' } }), null);
});

test('parseMoonshotBalance yields a value-only balance row', () => {
  const [row] = parse.parseMoonshotBalance(MOONSHOT_BALANCE, 'USD');
  assert.equal(row.window, 'balance');
  assert.equal(row.percentUsed, null);
  assert.equal(row.valueText, '49.58 USD');
  assert.equal(parse.parseMoonshotBalance({ code: 1 }), null);
});

test('parseGeminiQuota collapses buckets per model to the most-used one', () => {
  const limits = parse.parseGeminiQuota(GEMINI_QUOTA);
  assert.deepEqual(limits.map((l) => [l.label, l.percentUsed]), [['gemini-3-pro', 60], ['gemini-3-flash', 0]]);
  assert.equal(limits[0].window, 'daily');
  assert.equal(parse.parseGeminiQuota({}), null);
});

test('parseOpenRouterKey: percentage with a cap, value row without one', () => {
  const capped = parse.parseOpenRouterKey({ data: { usage: 2.5, limit: 10 } });
  assert.equal(capped[0].percentUsed, 25);
  const free = parse.parseOpenRouterKey({ data: { usage: 0, limit: null, is_free_tier: true } });
  assert.equal(free[0].percentUsed, null);
  assert.match(free[0].label, /Free tier/);
  assert.equal(parse.parseOpenRouterKey({}), null);
});

test('toIso and windowForMinutes edge cases', () => {
  assert.equal(parse.toIso(null), null);
  assert.equal(parse.toIso(0), null);
  assert.equal(parse.toIso('garbage'), null);
  assert.equal(parse.toIso('2026-10-20T00:00:00Z'), '2026-10-20T00:00:00.000Z');
  assert.equal(parse.windowForMinutes(300), '5h');
  assert.equal(parse.windowForMinutes(43200), 'monthly');
  assert.equal(parse.windowForMinutes(90), 'custom');
  assert.equal(parse.labelForMinutes(120), '2-hour window');
});

// --- source detection -------------------------------------------------------------

test('usageSourceForProfile recognizes templates and hand-made base URLs', () => {
  const cases = [
    [{ id: 'claude-cloud', command: 'claude', env: {} }, 'claude'],
    [{ id: 'shell', command: '', env: {} }, 'none'],
    [{ id: 'lm', templateId: 'lm-studio', env: { ANTHROPIC_BASE_URL: 'http://localhost:1234' } }, 'local'],
    [{ id: 'cx', templateId: 'codex-cli', command: 'codex', env: {} }, 'codex'],
    [{ id: 'gm', templateId: 'gemini-cli', command: 'gemini', env: {} }, 'gemini'],
    [{ id: 'glm-5.3', command: 'claude', env: { ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic' } }, 'zai'],
    [{ id: 'k', templateId: 'kimi', env: { ANTHROPIC_BASE_URL: 'https://api.moonshot.ai/anthropic' } }, 'moonshot'],
    [{ id: 'kc', templateId: 'kimi-code', env: {} }, 'kimi-code'],
    [{ id: 'or', templateId: 'openrouter', env: {} }, 'openrouter'],
    [{ id: 'fl', templateId: 'freellm-claude', env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:31415' } }, 'other'],
    [{ id: 'ccr', templateId: 'codex', env: { ANTHROPIC_BASE_URL: 'http://localhost:3456' } }, 'other'],
  ];
  for (const [profile, want] of cases) assert.equal(usageSourceForProfile(profile), want, profile.id);
});

test('profilesForUsage skips Claude, local and shell profiles and dedupes shared keys', () => {
  const profiles = [
    { id: 'claude-cloud', command: 'claude', env: {} },
    { id: 'lm', templateId: 'lm-studio', env: {} },
    { id: 'shell', command: '', env: {} },
    { id: 'glm-a', templateId: 'glm', env: { ANTHROPIC_AUTH_TOKEN: 'same' } },
    { id: 'glm-b', templateId: 'glm', env: { ANTHROPIC_AUTH_TOKEN: 'same' } },
    { id: 'cx', templateId: 'codex-cli', command: 'codex', env: {} },
  ];
  assert.deepEqual(profilesForUsage(profiles).map((p) => p.id), ['glm-a', 'cx']);
  assert.deepEqual(profilesForUsage(null), []);
});

// --- fetchers (injected IO) -------------------------------------------------------

function fakeDeps({ files = {}, dirs = {}, responses = {} } = {}) {
  const calls = [];
  const norm = (p) => p.split(path.sep).join('/');
  return {
    calls,
    deps: {
      now: () => NOW,
      homedir: () => '/home/u',
      readFile: (p) => {
        const hit = files[norm(p)];
        if (hit === undefined) throw new Error('ENOENT');
        return hit;
      },
      readdir: (p) => {
        const hit = dirs[norm(p)];
        if (!hit) throw new Error('ENOENT');
        return hit;
      },
      request: async (req) => {
        calls.push(req);
        const r = responses[`${req.host}${req.pathname}`];
        return r || { status: 404, body: '' };
      },
    },
  };
}

test('Codex: the live backend wins and gets the account header', async () => {
  const { deps, calls } = fakeDeps({
    files: { '/home/u/.codex/auth.json': JSON.stringify({ tokens: { access_token: 'at', account_id: 'acc' } }) },
    responses: { 'chatgpt.com/backend-api/wham/usage': { status: 200, body: JSON.stringify(CODEX_WHAM) } },
  });
  const usage = await fetchProviderUsage({ id: 'cx', templateId: 'codex-cli', command: 'codex', label: 'Codex' }, deps);
  assert.equal(usage.status, 'ok');
  assert.equal(usage.detail, 'chatgpt');
  assert.equal(usage.limits[1].percentUsed, 55);
  assert.equal(calls[0].headers.Authorization, 'Bearer at');
  assert.equal(calls[0].headers['ChatGPT-Account-Id'], 'acc');
});

test('Codex: falls back to the newest rollout log when the backend fails', async () => {
  const { deps } = fakeDeps({
    dirs: {
      '/home/u/.codex/sessions': ['2026'],
      '/home/u/.codex/sessions/2026': ['10'],
      '/home/u/.codex/sessions/2026/10': ['19', '20'],
      '/home/u/.codex/sessions/2026/10/20': ['rollout-a.jsonl', 'notes.txt'],
      '/home/u/.codex/sessions/2026/10/19': [],
    },
    files: { '/home/u/.codex/sessions/2026/10/20/rollout-a.jsonl': CODEX_ROLLOUT },
  });
  const usage = await fetchProviderUsage({ id: 'cx', templateId: 'codex-cli', command: 'codex' }, deps);
  assert.equal(usage.status, 'ok');
  assert.equal(usage.detail, 'rollout');
  assert.equal(usage.limits[0].percentUsed, 42);
});

test('Codex: nothing anywhere -> not available, not an error', async () => {
  const { deps } = fakeDeps();
  const usage = await fetchProviderUsage({ id: 'cx', templateId: 'codex-cli', command: 'codex' }, deps);
  assert.equal(usage.status, 'unsupported');
});

test('Z.ai: raw key goes only to the Z.ai monitor endpoint', async () => {
  const { deps, calls } = fakeDeps({
    responses: { 'api.z.ai/api/monitor/usage/quota/limit': { status: 200, body: JSON.stringify(ZAI_QUOTA) } },
  });
  const profile = { id: 'glm-5.3', command: 'claude', env: { ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic', ANTHROPIC_AUTH_TOKEN: 'zk' } };
  const usage = await fetchProviderUsage(profile, deps);
  assert.equal(usage.status, 'ok');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].host, 'api.z.ai');
  assert.equal(calls[0].headers.Authorization, 'zk');
});

test('Z.ai: a missing or placeholder key is unconfigured, with no request', async () => {
  const { deps, calls } = fakeDeps();
  const usage = await fetchProviderUsage({ id: 'g', templateId: 'glm', env: { ANTHROPIC_AUTH_TOKEN: '{{apiKey}}' } }, deps);
  assert.equal(usage.status, 'unconfigured');
  assert.equal(calls.length, 0);
});

test('Kimi Code: reads {base}/v1/usages on the profile host', async () => {
  const { deps, calls } = fakeDeps({
    responses: { 'api.kimi.com/coding/v1/usages': { status: 200, body: JSON.stringify(KIMI_CODE_USAGES) } },
  });
  const profile = { id: 'kc', templateId: 'kimi-code', env: { ANTHROPIC_BASE_URL: 'https://api.kimi.com/coding/', ANTHROPIC_API_KEY: 'kk' } };
  const usage = await fetchProviderUsage(profile, deps);
  assert.equal(usage.status, 'ok');
  assert.equal(calls[0].headers.Authorization, 'Bearer kk');
});

test('Moonshot: CNY balance for the .cn host', async () => {
  const { deps } = fakeDeps({
    responses: { 'api.moonshot.cn/v1/users/me/balance': { status: 200, body: JSON.stringify(MOONSHOT_BALANCE) } },
  });
  const profile = { id: 'k', templateId: 'kimi', env: { ANTHROPIC_BASE_URL: 'https://api.moonshot.cn/anthropic', ANTHROPIC_AUTH_TOKEN: 'mk' } };
  const usage = await fetchProviderUsage(profile, deps);
  assert.equal(usage.limits[0].valueText, '49.58 CNY');
});

test('Gemini: an API key is not available, an expired login is not available', async () => {
  const { deps, calls } = fakeDeps({
    files: { '/home/u/.gemini/oauth_creds.json': JSON.stringify({ access_token: 'g', expiry_date: NOW - 1 }) },
  });
  const withKey = await fetchProviderUsage({ id: 'gm', templateId: 'gemini-cli', command: 'gemini', env: { GEMINI_API_KEY: 'k' } }, deps);
  assert.equal(withKey.status, 'unsupported');
  const expired = await fetchProviderUsage({ id: 'gm', templateId: 'gemini-cli', command: 'gemini', env: {} }, deps);
  assert.equal(expired.status, 'unsupported');
  assert.match(expired.errorMessage, /expired/);
  assert.equal(calls.length, 0);
});

test('Gemini: a valid login resolves the project, then reads the quota', async () => {
  const { deps, calls } = fakeDeps({
    files: { '/home/u/.gemini/oauth_creds.json': JSON.stringify({ access_token: 'g', expiry_date: NOW + 60000 }) },
    responses: {
      'cloudcode-pa.googleapis.com/v1internal:loadCodeAssist': { status: 200, body: JSON.stringify({ cloudaicompanionProject: 'proj-1' }) },
      'cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota': { status: 200, body: JSON.stringify(GEMINI_QUOTA) },
    },
  });
  const usage = await fetchProviderUsage({ id: 'gm', templateId: 'gemini-cli', command: 'gemini', env: {} }, deps);
  assert.equal(usage.status, 'ok');
  assert.equal(JSON.parse(calls[1].body).project, 'proj-1');
});

test('a provider with no quota source is not available, never an error', async () => {
  const { deps, calls } = fakeDeps();
  const usage = await fetchProviderUsage({ id: 'fl', templateId: 'freellm-claude', env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:31415' } }, deps);
  assert.equal(usage.status, 'unsupported');
  assert.equal(calls.length, 0);
});

test('a throwing request becomes an error entry, not a rejection', async () => {
  const { deps } = fakeDeps();
  deps.request = async () => { throw new Error('boom'); };
  const usage = await fetchProviderUsage({ id: 'or', templateId: 'openrouter', env: { ANTHROPIC_AUTH_TOKEN: 'k' } }, deps);
  assert.equal(usage.status, 'error');
  assert.equal(usage.errorMessage, 'boom');
});

test('fetchOtherProvidersUsage returns one entry per listed profile in order', async () => {
  const { deps } = fakeDeps();
  const out = await fetchOtherProvidersUsage([
    { id: 'claude-cloud', command: 'claude', env: {} },
    { id: 'or', templateId: 'openrouter', env: {} },
    { id: 'cx', templateId: 'codex-cli', command: 'codex', env: {} },
  ], deps);
  assert.deepEqual(out.map((u) => [u.profileId, u.status]), [['or', 'unconfigured'], ['cx', 'unsupported']]);
});
