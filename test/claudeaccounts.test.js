// Tests for Claude account failover (src/claudeaccounts.js), the resume
// command a switched tab starts with (src/launch.js withAccountResume) and
// the account layer in buildSessionEnv (src/sessionenv.js).
//
// Why this file matters: a wrong pick here either keeps every tab on the
// limited account (failover silently never happens) or sends a provider
// profile's traffic (z.ai, LM Studio) to Anthropic with a subscription token.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  createClaudeAccounts,
  pickActive,
  authLayerFor,
  usesOwnBackend,
  extractToken,
  sanitize,
  ACCOUNT_ENV,
  UNKNOWN_RESET_MS,
} = require('../src/claudeaccounts');
const { withAccountResume, ACCOUNT_RESUME_MESSAGE } = require('../src/launch');
const { buildSessionEnv, setAccountLayer } = require('../src/sessionenv');

const TOKEN_A = `sk-ant-oat01-${'a'.repeat(40)}`;
const TOKEN_B = `sk-ant-oat01-${'b'.repeat(40)}`;
const UUID = '123e4567-e89b-12d3-a456-426614174000';

/** A reversible stand-in for Electron's safeStorage. */
const fakeStorage = (available = true) => ({
  isEncryptionAvailable: () => available,
  encryptString: (s) => Buffer.from(`enc:${s}`, 'utf8'),
  decryptString: (b) => b.toString('utf8').replace(/^enc:/, ''),
});

function makeStore({ available = true, start = 1_000_000 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-accounts-'));
  const file = path.join(dir, 'claude-accounts.local.json');
  const clock = { now: start };
  const store = createClaudeAccounts({
    file: () => file,
    safeStorage: () => fakeStorage(available),
    now: () => clock.now,
  });
  return { store, file, clock };
}

test('pickActive: first account without a cooldown wins', () => {
  const accounts = [{ id: 'a' }, { id: 'b' }];
  assert.equal(pickActive(accounts, {}, 10).id, 'a');
  assert.equal(pickActive(accounts, { a: 50 }, 10).id, 'b');
  // Expired cooldown: back to the preferred account.
  assert.equal(pickActive(accounts, { a: 5 }, 10).id, 'a');
});

test('pickActive: all cooling down -> the one that resets soonest', () => {
  assert.equal(pickActive([{ id: 'a' }, { id: 'b' }], { a: 90, b: 40 }, 10).id, 'b');
  assert.equal(pickActive([], {}, 10), null);
});

test('authLayerFor: steers plain Claude launches only', () => {
  const account = { id: 'a', token: TOKEN_A };
  assert.deepEqual(authLayerFor({ PATH: 'x' }, account), { CLAUDE_CODE_OAUTH_TOKEN: TOKEN_A, [ACCOUNT_ENV]: 'a' });
  assert.deepEqual(authLayerFor({ ANTHROPIC_BASE_URL: 'https://api.z.ai' }, account), {});
  assert.deepEqual(authLayerFor({ ANTHROPIC_API_KEY: 'k' }, account), {});
  assert.deepEqual(authLayerFor({ CLAUDE_CODE_OAUTH_TOKEN: TOKEN_B }, account), {});
  assert.deepEqual(authLayerFor({}, null), {});
  assert.equal(usesOwnBackend({ ANTHROPIC_AUTH_TOKEN: 't' }), true);
  assert.equal(usesOwnBackend({ ANTHROPIC_BASE_URL: '' }), false);
});

test('extractToken: joins a token split across wrapped terminal lines', () => {
  const half = TOKEN_A.length / 2;
  assert.equal(extractToken(`  ${TOKEN_A.slice(0, half)}\r\n${TOKEN_A.slice(half)}  `), TOKEN_A);
  assert.equal(extractToken('sk-ant-api03-nope'), null);
  assert.equal(extractToken(42), null);
});

test('sanitize: drops malformed accounts and orphan limits', () => {
  const out = sanitize({
    accounts: [{ id: 'a', label: 'A', token: TOKEN_A }, { id: 'BAD ID', token: TOKEN_B }, { id: 'c', token: 'x' }],
    limits: { a: 5, ghost: 9 },
  });
  assert.deepEqual(out.accounts.map((a) => a.id), ['a']);
  assert.deepEqual(out.limits, { a: 5 });
});

test('store: add encrypts, list never returns a token', () => {
  const { store, file } = makeStore();
  const res = store.add('matitrampolin', TOKEN_A);
  assert.equal(res.ok, true);
  const disk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(disk.v, 1);
  assert.equal(typeof disk.enc, 'string');
  assert.ok(!fs.readFileSync(file, 'utf8').includes(TOKEN_A), 'token must not be stored in plaintext');
  const view = store.list();
  assert.equal(view.accounts.length, 1);
  assert.equal(view.accounts[0].active, true);
  assert.ok(!JSON.stringify(view).includes('sk-ant'), 'list must not leak a token');
});

test('store: rejects bad input, duplicates, and saving without encryption', () => {
  const { store } = makeStore();
  assert.equal(store.add('x', 'not a token').error, 'badToken');
  assert.equal(store.add('   ', TOKEN_A).error, 'badLabel');
  assert.equal(store.add('a', TOKEN_A).ok, true);
  assert.equal(store.add('again', TOKEN_A).error, 'duplicate');
  const { store: plain } = makeStore({ available: false });
  assert.equal(plain.add('a', TOKEN_A).error, 'noEncryption');
});

test('store: a limit switches to the next account, then back after the reset', () => {
  const { store, clock } = makeStore();
  const a = store.add('A', TOKEN_A).id;
  const b = store.add('B', TOKEN_B).id;
  assert.equal(store.active().id, a);

  const res = store.markLimited(a, clock.now + 5000);
  assert.equal(res.switchTo.id, b);
  assert.equal(store.active().id, b);
  assert.equal(store.authLayer({}).CLAUDE_CODE_OAUTH_TOKEN, TOKEN_B);

  clock.now += 6000;
  assert.equal(store.active().id, a, 'the preferred account is back once its limit reset');
});

test('store: both limited -> no switch; unknown reset uses the fallback cooldown', () => {
  const { store, clock } = makeStore();
  const a = store.add('A', TOKEN_A).id;
  const b = store.add('B', TOKEN_B).id;
  assert.equal(store.markLimited(a, null).switchTo.id, b);
  assert.equal(store.list().accounts[0].limitedUntil, clock.now + UNKNOWN_RESET_MS);
  assert.equal(store.markLimited(b, clock.now + 1000).switchTo, null);
  assert.equal(store.freeAccount(), null);
  assert.equal(store.failoverActive(null), false);
});

test('store: a later reset wins (a weekly wall outlasts a 5 h one)', () => {
  const { store, clock } = makeStore();
  const a = store.add('A', TOKEN_A).id;
  store.add('B', TOKEN_B);
  store.markLimited(a, clock.now + 100_000);
  store.markLimited(a, clock.now + 10);
  assert.equal(store.list().accounts[0].limitedUntil, clock.now + 100_000);
});

test('store: moveUp, clearLimit and remove', () => {
  const { store, clock } = makeStore();
  const a = store.add('A', TOKEN_A).id;
  const b = store.add('B', TOKEN_B).id;
  assert.equal(store.moveUp(b).ok, true);
  assert.equal(store.active().id, b);
  store.markLimited(b, clock.now + 9999);
  assert.equal(store.active().id, a);
  store.clearLimit(b);
  assert.equal(store.active().id, b);
  assert.equal(store.remove(b).ok, true);
  assert.equal(store.active().id, a);
  assert.equal(store.remove('zzz').error, 'notFound');
});

test('store: a second process sees writes from the first (mtime refresh)', () => {
  const { store, file } = makeStore();
  const other = createClaudeAccounts({ file: () => file, safeStorage: () => fakeStorage(), now: () => 1_000_000 });
  assert.equal(other.active(), null);
  store.add('A', TOKEN_A);
  // Force a distinct mtime: some filesystems round to whole seconds.
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(file, later, later);
  assert.equal(other.active().label, 'A');
});

test('withAccountResume: resumes the same conversation with a continue message', () => {
  const cmd = withAccountResume('claude --model opus', UUID);
  assert.equal(cmd, `claude '${ACCOUNT_RESUME_MESSAGE}' --model opus --resume ${UUID}`);
});

test('withAccountResume: a God Mode worker keeps its flags, not its brief', () => {
  const task = { briefPath: 'C:/runs/p1/brief.md', model: 'opus', permissionMode: 'acceptEdits' };
  const cmd = withAccountResume('claude', UUID, task);
  assert.ok(cmd.includes('--permission-mode acceptEdits'));
  assert.ok(cmd.includes('--model opus'));
  assert.ok(cmd.endsWith(`--resume ${UUID}`));
  assert.ok(!cmd.includes('task brief'), 'the task must not start over');
});

test('withAccountResume: refuses what it cannot resume safely', () => {
  assert.equal(withAccountResume('codex', UUID), null);
  assert.equal(withAccountResume('claude -c', UUID), null);
  assert.equal(withAccountResume('claude', 'not-a-uuid'), null);
  assert.equal(withAccountResume('', UUID), null);
});

test('buildSessionEnv: applies the account layer last, sees the merged env', () => {
  try {
    setAccountLayer((env) => (env.ANTHROPIC_BASE_URL ? {} : { CLAUDE_CODE_OAUTH_TOKEN: TOKEN_A }));
    assert.equal(buildSessionEnv({ PATH: 'x' }, {}).CLAUDE_CODE_OAUTH_TOKEN, TOKEN_A);
    assert.equal(buildSessionEnv({}, { ANTHROPIC_BASE_URL: 'http://lm' }).CLAUDE_CODE_OAUTH_TOKEN, undefined);
    // An inherited token / marker from an outer LunaCore tab is never reused.
    setAccountLayer(() => ({}));
    const env = buildSessionEnv({ CLAUDE_CODE_OAUTH_TOKEN: TOKEN_B, [ACCOUNT_ENV]: 'x' }, {});
    assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
    assert.equal(env[ACCOUNT_ENV], undefined);
    // A throwing layer never breaks a launch.
    setAccountLayer(() => {
      throw new Error('boom');
    });
    assert.equal(buildSessionEnv({ A: '1' }).A, '1');
  } finally {
    setAccountLayer(null);
  }
});
