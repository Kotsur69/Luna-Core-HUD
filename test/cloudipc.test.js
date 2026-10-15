// ============================================================================
// LunaCore - cloud IPC (src/cloudipc.js)
// ----------------------------------------------------------------------------
// The renderer gets who is logged in and how the sync is doing - never a
// token - and can only ask for login / logout / sync now, rate-limited.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { registerCloudIpc } = require('../src/cloudipc.js');

function harness(cloudOverrides = {}) {
  const handlers = new Map();
  const calls = { login: 0, logout: 0, sync: 0 };
  let t = 1_000_000;
  const cloud = {
    status: () => ({
      configured: true,
      loggedIn: true,
      user: 'Kotsur69',
      ready: true,
      lastSync: 123,
      pending: 2,
      error: null,
      access_token: 'SECRET',
    }),
    login: async () => (calls.login++, { ok: true }),
    logout: async () => {
      calls.logout++;
    },
    syncNow: async () => (calls.sync++, { ok: true }),
    ...cloudOverrides,
  };
  registerCloudIpc({ ipcMain: { handle: (ch, fn) => handlers.set(ch, fn) }, cloud, now: () => t });
  return {
    call: (ch, arg) => handlers.get(ch)({}, arg),
    calls,
    tick: (ms) => (t += ms),
    channels: [...handlers.keys()].sort(),
  };
}

test('exactly the four channels', () => {
  assert.deepEqual(harness().channels, ['cloud:login', 'cloud:logout', 'cloud:status', 'cloud:syncNow']);
});

test('status: whitelisted fields only, no token ever', async () => {
  const res = await harness().call('cloud:status');
  assert.deepEqual(res, { ok: true, configured: true, loggedIn: true, user: 'Kotsur69', lastSync: 123, pending: 2, error: null });
  assert.equal(JSON.stringify(res).includes('SECRET'), false);
});

test('status: cloud off is a plain answer, not an error', async () => {
  const res = await harness({ status: () => ({ configured: false, loggedIn: false }) }).call('cloud:status');
  assert.deepEqual(res, { ok: true, configured: false, loggedIn: false, user: null, lastSync: null, pending: 0, error: null });
});

test('status: odd values from inside are clamped, unknown errors become "failed"', async () => {
  const res = await harness({
    status: () => ({ configured: true, loggedIn: true, user: 'x'.repeat(500), lastSync: 'soon', pending: -3, error: 'raw stack trace' }),
  }).call('cloud:status');
  assert.equal(res.user.length, 100);
  assert.equal(res.lastSync, null);
  assert.equal(res.pending, 0);
  assert.equal(res.error, 'failed');
});

test('login passes through the fixed reason; a second click while waiting is rate-limited', async () => {
  const h = harness({ login: async () => ({ ok: false, reason: 'timeout' }) });
  assert.deepEqual(await h.call('cloud:login'), { ok: false, reason: 'timeout' });
  assert.deepEqual(await h.call('cloud:login'), { ok: false, reason: 'rate-limited' });
  h.tick(5000);
  assert.deepEqual(await h.call('cloud:login'), { ok: false, reason: 'timeout' });
});

test('login: an unexpected reason or a throw becomes "failed"', async () => {
  assert.deepEqual(await harness({ login: async () => ({ ok: false, reason: '<img src=x>' }) }).call('cloud:login'), { ok: false, reason: 'failed' });
  assert.deepEqual(await harness({ login: async () => { throw new Error('boom'); } }).call('cloud:login'), { ok: false, reason: 'failed' });
});

test('sync now is rate-limited; payloads are ignored', async () => {
  const h = harness();
  assert.deepEqual(await h.call('cloud:syncNow', { evil: true }), { ok: true });
  assert.deepEqual(await h.call('cloud:syncNow'), { ok: false, reason: 'rate-limited' });
  assert.equal(h.calls.sync, 1);
});

test('logout', async () => {
  const h = harness();
  assert.deepEqual(await h.call('cloud:logout'), { ok: true });
  assert.equal(h.calls.logout, 1);
});
