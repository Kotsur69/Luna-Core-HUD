'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const c = require('../src/setupcenter');

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (role) => `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ iss: 'supabase', ref: 'abcdefghij', role })}.${'s'.repeat(43)}`;
const URL_OK = 'https://abcdefghijklmnopqrst.supabase.co';
const KEY_OK = 'sb_publishable_AbCdEfGhIjKlMnOpQrStUv_123';

// ---- Supabase URL / key validation ----------------------------------------

test('project URL: https on *.supabase.co only, normalized', () => {
  assert.equal(c.normalizeProjectUrl(`  ${URL_OK}/ `), URL_OK);
  assert.equal(c.normalizeProjectUrl('https://ABCdefghijklmnopqrst.supabase.co'), URL_OK);
  for (const bad of [
    'http://abc.supabase.co',
    'https://abc.supabase.co.evil.com',
    'https://evil.com/?x=.supabase.co',
    'https://abc.supabase.co/rest/v1',
    'https://abc.supabase.co:8443',
    'https://user:pw@abc.supabase.co',
    'https://a.b.supabase.co',
    'abc.supabase.co',
    '',
    null,
    42,
    `https://${'a'.repeat(500)}.supabase.co`,
  ]) {
    assert.equal(c.normalizeProjectUrl(bad), null, String(bad));
  }
});

test('key: publishable and legacy anon accepted, secret and service_role refused', () => {
  assert.deepEqual(c.classifyKey(` ${KEY_OK} `), { ok: true, key: KEY_OK });
  assert.equal(c.classifyKey(jwt('anon')).ok, true);
  assert.deepEqual(c.classifyKey('sb_secret_AbCdEfGhIjKlMnOpQrStUv'), { ok: false, reason: 'secret-key' });
  assert.deepEqual(c.classifyKey(jwt('service_role')), { ok: false, reason: 'secret-key' });
  for (const bad of ['', 'hello', 'sb_publishable_short', '<script>', null, {}, 'a'.repeat(5000)]) {
    assert.equal(c.classifyKey(bad).ok, false, String(bad));
  }
});

test('validateCloudInput returns exactly what cloud.local.json may hold', () => {
  assert.deepEqual(c.validateCloudInput({ url: `${URL_OK}/`, key: KEY_OK }), {
    ok: true,
    config: { url: URL_OK, publishableKey: KEY_OK },
  });
  assert.deepEqual(c.validateCloudInput({ url: 'https://x.example.com', key: KEY_OK }), { ok: false, reason: 'bad-url' });
  assert.deepEqual(c.validateCloudInput({ url: URL_OK, key: 'sb_secret_xxxxxxxxxxxxxxxxxxxxxxxx' }), {
    ok: false,
    reason: 'secret-key',
  });
  assert.deepEqual(c.validateCloudInput(null), { ok: false, reason: 'bad-url' });
  assert.deepEqual(c.validateCloudInput('x'), { ok: false, reason: 'bad-url' });
});

test('projectRef, PWA URL and user id helpers', () => {
  assert.equal(c.projectRef(URL_OK), 'abcdefghijklmnopqrst');
  assert.equal(c.projectRef('https://evil.com'), null);
  assert.equal(c.normalizePwaUrl('https://luna.vercel.app'), 'https://luna.vercel.app/');
  assert.equal(c.normalizePwaUrl('http://luna.vercel.app'), null);
  assert.equal(c.normalizePwaUrl('javascript:alert(1)'), null);
  assert.equal(c.normalizePwaUrl('https://u:p@luna.vercel.app'), null);
  assert.equal(c.normalizePwaUrl('https://localhost'), null);
  assert.equal(c.normalizePwaUrl(`https://a.app/${'x'.repeat(300)}`), null);
  assert.equal(c.cleanUserId('3F2504E0-4F89-11D3-9A0C-0305E82C3301'), '3f2504e0-4f89-11d3-9a0c-0305e82c3301');
  assert.equal(c.cleanUserId('not-a-uuid'), null);
});

// ---- status mapping per integration ---------------------------------------

const m = (id, r) => {
  const row = c.mapStatus(id, r);
  return [row.state, row.note];
};

test('claude + gh', () => {
  assert.deepEqual(m('claude', { installed: false }), ['missing', 'not-installed']);
  assert.deepEqual(m('claude', { installed: true, loggedIn: false }), ['warning', 'not-logged-in']);
  assert.deepEqual(m('claude', { installed: true, loggedIn: true }), ['ok', null]);
  assert.deepEqual(m('gh', { value: 'ok' }), ['ok', null]);
  assert.deepEqual(m('gh', { value: 'not-logged-in' }), ['warning', 'not-logged-in']);
  assert.deepEqual(m('gh', { value: 'missing' }), ['missing', 'not-installed']);
});

test('cloud, tables, auth, functions', () => {
  assert.deepEqual(m('cloud', { fileValid: false }), ['missing', 'not-configured']);
  assert.deepEqual(m('cloud', { fileValid: true, running: false }), ['warning', 'restart']);
  assert.deepEqual(m('cloud', { fileValid: true, running: true, loggedIn: false }), ['warning', 'not-logged-in']);
  assert.deepEqual(m('cloud', { fileValid: true, running: true, loggedIn: true }), ['ok', null]);

  assert.deepEqual(m('cloudTables', { configured: false }), ['missing', 'needs-cloud']);
  assert.deepEqual(m('cloudTables', { configured: true, checked: false }), ['warning', 'unchecked']);
  assert.deepEqual(m('cloudTables', { configured: true, checked: true, present: 7, total: 7 }), ['ok', null]);
  assert.deepEqual(m('cloudTables', { configured: true, checked: true, present: 3, total: 7 }), ['warning', 'partial']);
  assert.deepEqual(m('cloudTables', { configured: true, checked: true, present: 0, total: 7 }), ['missing', 'partial']);

  assert.deepEqual(m('cloudAuth', { configured: false }), ['missing', 'needs-cloud']);
  assert.deepEqual(m('cloudAuth', { configured: true, github: false, google: true }), ['missing', 'no-github']);
  assert.deepEqual(m('cloudAuth', { configured: true, github: true, google: false }), ['warning', 'no-google']);
  assert.deepEqual(m('cloudAuth', { configured: true, github: true, google: true }), ['ok', null]);

  assert.deepEqual(m('functions', { configured: false }), ['missing', 'needs-cloud']);
  assert.deepEqual(m('functions', { configured: true, google: 'deployed', push: 'deployed' }), ['ok', null]);
  assert.deepEqual(m('functions', { configured: true, google: 'missing', push: 'missing' }), ['missing', 'not-configured']);
  assert.deepEqual(m('functions', { configured: true, google: 'deployed', push: 'missing' }), ['warning', 'partial']);
  assert.deepEqual(m('functions', { configured: true, google: 'deployed', push: 'unknown' }), ['warning', 'probe-failed']);
});

test('google, pwa, host, yazio, agent-reach, lm studio, freellm', () => {
  assert.deepEqual(m('google', { configured: false, connected: false }), ['missing', 'not-configured']);
  assert.deepEqual(m('google', { configured: true, connected: false }), ['warning', 'not-connected']);
  assert.deepEqual(m('google', { configured: true, connected: true }), ['ok', null]);
  assert.deepEqual(m('pwa', { url: null }), ['missing', 'not-configured']);
  assert.deepEqual(m('pwa', { url: 'https://a.app/' }), ['ok', null]);
  assert.deepEqual(m('host', { configured: false }), ['missing', 'needs-cloud']);
  assert.deepEqual(m('host', { configured: true, loggedIn: false }), ['missing', 'not-logged-in']);
  assert.deepEqual(m('host', { configured: true, loggedIn: true, paired: false }), ['warning', 'no-phone']);
  assert.deepEqual(m('host', { configured: true, loggedIn: true, paired: true }), ['ok', null]);
  assert.deepEqual(m('yazio', { connected: false }), ['missing', 'not-connected']);
  assert.deepEqual(m('yazio', { connected: true }), ['ok', null]);
  assert.deepEqual(m('agentReach', { installed: false, ready: false }), ['missing', 'not-installed']);
  assert.deepEqual(m('agentReach', { installed: true, ready: false }), ['warning', 'not-installed']);
  assert.deepEqual(m('agentReach', { installed: true, ready: true, social: { x: false, reddit: false } }), ['warning', 'no-social']);
  assert.deepEqual(m('agentReach', { installed: true, ready: true, social: { x: true } }), ['ok', null]);
  assert.deepEqual(m('lmstudio', { running: true }), ['ok', null]);
  assert.deepEqual(m('lmstudio', { running: false, cli: true }), ['warning', 'not-running']);
  assert.deepEqual(m('lmstudio', { running: false, cli: false }), ['missing', 'not-installed']);
  assert.deepEqual(m('freellm', { value: 'up' }), ['ok', null]);
  assert.deepEqual(m('freellm', { value: 'not-running' }), ['warning', 'not-running']);
  assert.deepEqual(m('freellm', { value: 'not-installed' }), ['missing', 'not-installed']);
});

test('a failed or malformed probe is a warning, never a crash; notes are known ids', () => {
  assert.deepEqual(m('claude', { failed: 'timeout' }), ['warning', 'timeout']);
  assert.deepEqual(m('gh', { failed: 'probe-failed' }), ['warning', 'probe-failed']);
  assert.deepEqual(m('yazio', null), ['warning', 'probe-failed']);
  for (const id of c.INTEGRATIONS) {
    for (const r of [{}, { failed: 'timeout' }, { configured: true }]) {
      const row = c.mapStatus(id, r);
      assert.ok(c.STATES.includes(row.state), `${id} ${row.state}`);
      assert.ok(row.note === null || c.NOTES.includes(row.note), `${id} ${row.note}`);
    }
  }
});

// ---- runner: timeouts, parallel, order ------------------------------------

test('withTimeout: value, scalar, throw, hang', async () => {
  assert.deepEqual(await c.withTimeout(() => ({ a: 1 }), 50), { a: 1 });
  assert.deepEqual(await c.withTimeout(() => 'up', 50), { value: 'up' });
  assert.deepEqual(
    await c.withTimeout(() => {
      throw new Error('boom secret-token');
    }, 50),
    { failed: 'probe-failed' }
  );
  assert.deepEqual(await c.withTimeout(() => new Promise(() => {}), 20), { failed: 'timeout' });
});

test('collectStatus runs every probe, keeps the page order and maps a hung one to timeout', async () => {
  const probes = {
    claude: () => ({ installed: true, loggedIn: true }),
    gh: () => new Promise(() => {}), // a hung CLI
    freellm: async () => 'up',
    lmstudio: () => ({ running: true }),
    agentReach: () => new Promise((r) => setTimeout(() => r({ installed: true, ready: true, social: { x: true } }), 40)),
  };
  const started = Date.now();
  const rows = await c.collectStatus(probes, { timeoutMs: 25, timeouts: { agentReach: 500 } });
  assert.ok(Date.now() - started < 1000);
  assert.deepEqual(
    rows.map((r) => r.id),
    [...c.INTEGRATIONS]
  );
  const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
  assert.equal(byId.claude.state, 'ok');
  assert.deepEqual([byId.gh.state, byId.gh.note], ['warning', 'timeout']);
  assert.equal(byId.freellm.state, 'ok');
  assert.equal(byId.agentReach.state, 'ok', 'per-id timeout override');
  assert.deepEqual([byId.yazio.state, byId.yazio.note], ['warning', 'probe-failed'], 'no probe given');
  // Rows carry only id / state / note.
  for (const r of rows) assert.deepEqual(Object.keys(r).sort(), ['id', 'note', 'state']);
});

test('HTTP answer mapping for tables, functions and auth settings', () => {
  const all = Object.fromEntries(c.CLOUD_TABLES.map((t) => [t, 200]));
  assert.deepEqual(c.tablesResult(all), { present: 7, total: 7, missing: [] });
  const r = c.tablesResult({ ...all, host_events: 404, push_sent: null, snapshots: 401, sync_units: 500 });
  assert.equal(r.present, 4);
  assert.deepEqual(r.missing.sort(), ['host_events', 'push_sent', 'sync_units']);
  assert.equal(c.functionState(404), 'missing');
  assert.equal(c.functionState(204), 'deployed');
  assert.equal(c.functionState(401), 'deployed');
  assert.equal(c.functionState(503), 'unknown');
  assert.equal(c.functionState(null), 'unknown');
  assert.deepEqual(c.authProviders({ external: { github: true, google: 'yes' } }), { github: true, google: false });
  assert.deepEqual(c.authProviders(null), { github: false, google: false });
});
