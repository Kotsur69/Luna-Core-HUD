// ============================================================================
// LunaCore - local launch prep tests (src/locallaunch.js)
// ----------------------------------------------------------------------------
// Everything a LM Studio tab needs decided BEFORE its pty spawns: the shim URL,
// which model every tier maps to, the loaded context length, and the lean
// launch flags. The prep is pure over injected deps, so no LM Studio, no shim
// and no filesystem are touched here.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  normalizeLocalLaunch,
  resolveLocalLaunch,
  buildLocalEnv,
  buildLocalArgs,
  prepareLocalLaunch,
  launchWhenReady,
  LEAN_DISALLOWED_TOOLS,
  TIER_MODEL_KEYS,
} = require('../src/locallaunch');
const { SHIM_TOKEN_HEADER } = require('../src/lmstudioshim');

/** What buildLocalEnv adds with nothing else known: the 50-minute timeout. */
const TIMEOUT_ONLY = { API_TIMEOUT_MS: '3000000' };

const lmProfile = (extra = {}) => ({
  id: 'lm-studio',
  templateId: 'lm-studio',
  autoModel: true,
  env: { ANTHROPIC_BASE_URL: 'http://localhost:1234', ANTHROPIC_AUTH_TOKEN: 'lmstudio' },
  ...extra,
});
const providers = [
  { id: 'lm-studio', localLaunch: { shim: true, leanMcp: true, leanTools: true } },
  { id: 'glm', localLaunch: null },
];

// --- schema -----------------------------------------------------------------

test('normalizeLocalLaunch keeps only boolean known keys', () => {
  assert.deepStrictEqual(
    normalizeLocalLaunch({ shim: true, leanMcp: 'yes', leanTools: false, evil: true }),
    { shim: true, leanTools: false },
  );
  assert.strictEqual(normalizeLocalLaunch(null), null);
  assert.strictEqual(normalizeLocalLaunch([true]), null);
  assert.strictEqual(normalizeLocalLaunch('x'), null);
});

test('resolveLocalLaunch inherits the template and lets the profile override', () => {
  assert.deepStrictEqual(resolveLocalLaunch(lmProfile(), providers), { shim: true, leanMcp: true, leanTools: true });
  assert.deepStrictEqual(
    resolveLocalLaunch(lmProfile({ localLaunch: { leanTools: false } }), providers),
    { shim: true, leanMcp: true, leanTools: false },
  );
});

test('resolveLocalLaunch is null for profiles without a local launch block', () => {
  assert.strictEqual(resolveLocalLaunch({ id: 'claude', templateId: null, env: {} }, providers), null);
  assert.strictEqual(resolveLocalLaunch({ id: 'g', templateId: 'glm', env: {} }, providers), null);
});

// --- env ------------------------------------------------------------------

test('buildLocalEnv maps every tier to the model and sets the context length', () => {
  const env = buildLocalEnv({ profileEnv: {}, model: 'qwen/qwen3-coder-next', contextLength: 131072, shimUrl: 'http://127.0.0.1:5555', shimToken: 't' });
  for (const key of TIER_MODEL_KEYS) assert.strictEqual(env[key], 'qwen/qwen3-coder-next');
  assert.strictEqual(env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, '131072');
  assert.strictEqual(env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:5555');
});

test('buildLocalEnv never overrides a value the profile sets explicitly', () => {
  const env = buildLocalEnv({
    profileEnv: { ANTHROPIC_DEFAULT_HAIKU_MODEL: 'small', CLAUDE_CODE_MAX_CONTEXT_TOKENS: '8192' },
    model: 'big',
    contextLength: 131072,
    shimUrl: null,
  });
  assert.strictEqual(env.ANTHROPIC_DEFAULT_HAIKU_MODEL, undefined);
  assert.strictEqual(env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, undefined);
  assert.strictEqual(env.ANTHROPIC_DEFAULT_OPUS_MODEL, 'big');
});

test('buildLocalEnv hands the shim token to the CLI as a custom header', () => {
  const env = buildLocalEnv({ profileEnv: {}, model: null, contextLength: null, shimUrl: 'http://127.0.0.1:5555', shimToken: 'abc' });
  assert.strictEqual(env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:5555');
  assert.strictEqual(env.ANTHROPIC_CUSTOM_HEADERS, `${SHIM_TOKEN_HEADER}: abc`);
});

test('buildLocalEnv keeps the profile custom headers and replaces a stale shim token', () => {
  const env = buildLocalEnv({
    profileEnv: { ANTHROPIC_CUSTOM_HEADERS: `X-Team: luna\r\n${SHIM_TOKEN_HEADER.toUpperCase()}: old\n\n` },
    model: null,
    contextLength: null,
    shimUrl: 'http://127.0.0.1:5555',
    shimToken: 'new',
  });
  assert.strictEqual(env.ANTHROPIC_CUSTOM_HEADERS, `X-Team: luna\n${SHIM_TOKEN_HEADER}: new`);
});

test('buildLocalEnv keeps inherited custom headers when the profile sets none', () => {
  const base = { model: null, contextLength: null, shimUrl: 'http://127.0.0.1:5555', shimToken: 'tok' };
  const inherited = buildLocalEnv({ ...base, profileEnv: {}, inheritedEnv: { ANTHROPIC_CUSTOM_HEADERS: `X-Shell: 1\n${SHIM_TOKEN_HEADER}: stale` } });
  assert.strictEqual(inherited.ANTHROPIC_CUSTOM_HEADERS, `X-Shell: 1\n${SHIM_TOKEN_HEADER}: tok`);
  const own = buildLocalEnv({ ...base, profileEnv: { ANTHROPIC_CUSTOM_HEADERS: 'X-Profile: 2' }, inheritedEnv: { ANTHROPIC_CUSTOM_HEADERS: 'X-Shell: 1' } });
  assert.strictEqual(own.ANTHROPIC_CUSTOM_HEADERS, `X-Profile: 2\n${SHIM_TOKEN_HEADER}: tok`);
});

test('buildLocalEnv never routes through the shim without its token', () => {
  const env = buildLocalEnv({ profileEnv: {}, model: null, contextLength: null, shimUrl: 'http://127.0.0.1:5555', shimToken: '' });
  assert.deepStrictEqual(env, TIMEOUT_ONLY);
});

test('buildLocalEnv keeps a timeout the profile sets itself', () => {
  const env = buildLocalEnv({ profileEnv: { API_TIMEOUT_MS: '60000' }, model: null, contextLength: null, shimUrl: null });
  assert.deepStrictEqual(env, {});
});

test('buildLocalEnv omits what it does not know', () => {
  assert.deepStrictEqual(buildLocalEnv({ profileEnv: {}, model: null, contextLength: 0, shimUrl: null }), TIMEOUT_ONLY);
  assert.deepStrictEqual(buildLocalEnv({ profileEnv: {}, model: null, contextLength: -5, shimUrl: null }), TIMEOUT_ONLY);
});

// --- args -----------------------------------------------------------------

test('buildLocalArgs emits quoted lean flags per toggle', () => {
  const all = buildLocalArgs({ shim: true, leanMcp: true, leanTools: true }, { mcpConfigPath: 'C:\\data\\empty.json' });
  assert.deepStrictEqual(all.args, [
    '--strict-mcp-config', '--mcp-config', "'C:\\data\\empty.json'",
    '--disallowedTools', `'${LEAN_DISALLOWED_TOOLS.join(',')}'`,
  ]);
  assert.deepStrictEqual(buildLocalArgs({ leanMcp: false, leanTools: false }, {}).args, []);
  assert.deepStrictEqual(buildLocalArgs({ leanTools: true }, {}).args.slice(0, 1), ['--disallowedTools']);
});

test('buildLocalArgs skips lean MCP when the path is missing or unsafe to quote', () => {
  const unsafe = buildLocalArgs({ leanMcp: true }, { mcpConfigPath: "C:\\it's\\x.json" });
  assert.deepStrictEqual(unsafe.args, []);
  assert.deepStrictEqual(unsafe.notes, ['mcp-config-unavailable']);
  assert.deepStrictEqual(buildLocalArgs({ leanMcp: true }, { mcpConfigPath: null }).notes, ['mcp-config-unavailable']);
});

test('the lean tool list only names built-in CLI tools, never harness content', () => {
  for (const name of LEAN_DISALLOWED_TOOLS) assert.match(name, /^[A-Za-z]+$/);
  for (const kept of ['Read', 'Edit', 'Write', 'Bash', 'PowerShell', 'Grep', 'Glob', 'Skill', 'Agent']) {
    assert.ok(!LEAN_DISALLOWED_TOOLS.includes(kept), `${kept} must stay available`);
  }
});

// --- prep -----------------------------------------------------------------

const loadedRow = { id: 'qwen/qwen3-coder-next', type: 'llm', loaded: true, loadedContext: 131072 };
const deps = (over = {}) => ({
  probe: async () => ({ up: true, models: [loadedRow] }),
  ensureShim: async () => ({ ok: true, url: 'http://127.0.0.1:5555', token: 'tok' }),
  ensureMcpFile: () => 'C:\\data\\empty.json',
  timeoutMs: 200,
  ...over,
});
const lean = { shim: true, leanMcp: true, leanTools: true };

test('prepareLocalLaunch resolves shim, model, context and flags', async () => {
  const prep = await prepareLocalLaunch(lmProfile(), lean, deps());
  assert.strictEqual(prep.envOverrides.ANTHROPIC_BASE_URL, 'http://127.0.0.1:5555');
  assert.strictEqual(prep.envOverrides.ANTHROPIC_CUSTOM_HEADERS, `${SHIM_TOKEN_HEADER}: tok`);
  assert.strictEqual(prep.envOverrides.ANTHROPIC_MODEL, 'qwen/qwen3-coder-next');
  assert.strictEqual(prep.envOverrides.CLAUDE_CODE_MAX_CONTEXT_TOKENS, '131072');
  assert.ok(prep.extraArgs.includes('--strict-mcp-config'));
  assert.deepStrictEqual(prep.notes, []);
});

test('prepareLocalLaunch honours an explicit profile model', async () => {
  const other = { id: 'other', type: 'llm', loaded: true, loadedContext: 4096 };
  const prep = await prepareLocalLaunch(
    lmProfile({ env: { ...lmProfile().env, ANTHROPIC_MODEL: 'other' } }),
    lean,
    deps({ probe: async () => ({ up: true, models: [loadedRow, other] }) }),
  );
  assert.strictEqual(prep.envOverrides.ANTHROPIC_MODEL, undefined);
  assert.strictEqual(prep.envOverrides.ANTHROPIC_DEFAULT_SONNET_MODEL, 'other');
  assert.strictEqual(prep.envOverrides.CLAUDE_CODE_MAX_CONTEXT_TOKENS, '4096');
});

test('prepareLocalLaunch falls back to the direct upstream when the shim fails', async () => {
  const prep = await prepareLocalLaunch(lmProfile(), lean, deps({ ensureShim: async () => ({ ok: false, reason: 'error' }) }));
  assert.strictEqual(prep.envOverrides.ANTHROPIC_BASE_URL, undefined);
  assert.ok(prep.notes.includes('shim-failed'));
});

test('prepareLocalLaunch treats a shim result without a token as a failed shim', async () => {
  const prep = await prepareLocalLaunch(lmProfile(), lean, deps({ ensureShim: async () => ({ ok: true, url: 'http://127.0.0.1:5555' }) }));
  assert.strictEqual(prep.envOverrides.ANTHROPIC_BASE_URL, undefined);
  assert.strictEqual(prep.envOverrides.ANTHROPIC_CUSTOM_HEADERS, undefined);
  assert.ok(prep.notes.includes('shim-failed'));
});

test('prepareLocalLaunch survives a probe that hangs past the timeout', async () => {
  const prep = await prepareLocalLaunch(lmProfile(), lean, deps({ probe: () => new Promise(() => {}), timeoutMs: 20 }));
  assert.strictEqual(prep.envOverrides.ANTHROPIC_MODEL, undefined);
  assert.ok(prep.notes.includes('probe-failed'));
  assert.strictEqual(prep.envOverrides.ANTHROPIC_BASE_URL, 'http://127.0.0.1:5555');
});

test('prepareLocalLaunch never rejects, even when a dep throws', async () => {
  const prep = await prepareLocalLaunch(lmProfile(), lean, deps({
    probe: async () => { throw new Error('boom'); },
    ensureShim: async () => { throw new Error('boom'); },
    ensureMcpFile: () => { throw new Error('boom'); },
  }));
  assert.deepStrictEqual(prep.envOverrides, TIMEOUT_ONLY);
  assert.ok(prep.notes.includes('shim-failed'));
  assert.ok(prep.notes.includes('probe-failed'));
});

test('prepareLocalLaunch skips the shim when it is toggled off', async () => {
  let called = false;
  const prep = await prepareLocalLaunch(lmProfile(), { ...lean, shim: false }, deps({ ensureShim: async () => { called = true; return { ok: true, url: 'x' }; } }));
  assert.strictEqual(called, false);
  assert.strictEqual(prep.envOverrides.ANTHROPIC_BASE_URL, undefined);
});

// --- launch sequencing ------------------------------------------------------

test('launchWhenReady spawns once prep is done and the session is still current', async () => {
  const session = { id: 's1', spawnSeq: 0 };
  const spawned = [];
  await launchWhenReady(session, lmProfile(), {
    prepare: async () => ({ envOverrides: { A: '1' }, extraArgs: [], notes: [] }),
    spawn: (s, p, launch) => spawned.push(launch.envOverrides.A),
    isLive: () => true,
  });
  assert.deepStrictEqual(spawned, ['1']);
});

test('launchWhenReady rejects when spawn throws, so the caller can surface it', async () => {
  const session = { id: 's1', spawnSeq: 0 };
  await assert.rejects(launchWhenReady(session, lmProfile(), {
    prepare: async () => ({ envOverrides: {}, extraArgs: [], notes: [] }),
    spawn: () => { throw new Error('pty spawn failed'); },
    isLive: () => true,
  }), /pty spawn failed/);
});

test('launchWhenReady drops a stale prep after a newer launch or a close', async () => {
  const session = { id: 's1', spawnSeq: 0 };
  const spawned = [];
  let release;
  const slow = launchWhenReady(session, lmProfile(), {
    prepare: () => new Promise((r) => { release = () => r({ envOverrides: { A: 'old' }, extraArgs: [], notes: [] }); }),
    spawn: (s, p, launch) => spawned.push(launch.envOverrides.A),
    isLive: () => true,
  });
  await launchWhenReady(session, lmProfile(), {
    prepare: async () => ({ envOverrides: { A: 'new' }, extraArgs: [], notes: [] }),
    spawn: (s, p, launch) => spawned.push(launch.envOverrides.A),
    isLive: () => true,
  });
  release();
  await slow;
  assert.deepStrictEqual(spawned, ['new']);

  const closed = { id: 's2', spawnSeq: 0 };
  await launchWhenReady(closed, lmProfile(), {
    prepare: async () => ({ envOverrides: {}, extraArgs: [], notes: [] }),
    spawn: () => spawned.push('closed'),
    isLive: () => false,
  });
  assert.deepStrictEqual(spawned, ['new']);
});
