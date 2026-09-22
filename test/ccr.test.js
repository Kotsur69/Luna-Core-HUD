// Tests for src/ccr.js's pure functions - env/port parsing, the fallback port
// list, probe classification, output redaction, and the state decision table.
// Impure functions that touch a real process or a real socket (detectCcr,
// probeGateway/findGateway's actual network round trip, startGateway,
// stopGateway, openManagementUi, testClientKey) are left untested here per
// this repo's existing convention for process-exec/network code (see
// test/lmstudiocli.test.js's header and test/lmstudio.test.js's note on
// probeEndpoint) - EXCEPT for the synchronous guard paths below that resolve
// without ever touching execFile/http, which are safe and fast to assert.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  gatewayPortFromEnv,
  candidatePorts,
  classifyProbe,
  redactCcrOutput,
  describeState,
  probeGateway,
  stopGateway,
  testClientKey,
} = require('../src/ccr');

const DEFAULT_CCR_PORT = 3456;

// ---- gatewayPortFromEnv -----------------------------------------------------

test('gatewayPortFromEnv parses a real localhost base URL', () => {
  assert.equal(gatewayPortFromEnv({ ANTHROPIC_BASE_URL: 'http://localhost:3456' }), 3456);
  assert.equal(gatewayPortFromEnv({ ANTHROPIC_BASE_URL: 'http://127.0.0.1:9999' }), 9999);
});

test('gatewayPortFromEnv falls back to DEFAULT_CCR_PORT when the var is missing', () => {
  assert.equal(gatewayPortFromEnv({}), DEFAULT_CCR_PORT);
  assert.equal(gatewayPortFromEnv(undefined), DEFAULT_CCR_PORT);
  assert.equal(gatewayPortFromEnv({ ANTHROPIC_BASE_URL: '' }), DEFAULT_CCR_PORT);
  assert.equal(gatewayPortFromEnv({ ANTHROPIC_BASE_URL: '   ' }), DEFAULT_CCR_PORT);
});

test('gatewayPortFromEnv falls back to DEFAULT_CCR_PORT on an unparseable URL', () => {
  assert.equal(gatewayPortFromEnv({ ANTHROPIC_BASE_URL: 'not a url' }), DEFAULT_CCR_PORT);
});

test('gatewayPortFromEnv returns null when the host is not localhost/127.0.0.1', () => {
  assert.equal(gatewayPortFromEnv({ ANTHROPIC_BASE_URL: 'http://example.com:3456' }), null);
  assert.equal(gatewayPortFromEnv({ ANTHROPIC_BASE_URL: 'https://api.anthropic.com' }), null);
});

test('gatewayPortFromEnv defaults the port when a localhost URL omits one', () => {
  assert.equal(gatewayPortFromEnv({ ANTHROPIC_BASE_URL: 'http://localhost' }), DEFAULT_CCR_PORT);
});

test('gatewayPortFromEnv tolerates a localhost URL with a trailing path', () => {
  assert.equal(gatewayPortFromEnv({ ANTHROPIC_BASE_URL: 'http://localhost:3456/v1' }), 3456);
});

// ---- candidatePorts ----------------------------------------------------------

test('candidatePorts returns the fallback list, expectedPort first, when expectedPort is new', () => {
  assert.deepEqual(candidatePorts(9000), [9000, 3456, 3457, 3458, 3459, 3460]);
});

test('candidatePorts de-duplicates when expectedPort is already in the default list', () => {
  assert.deepEqual(candidatePorts(3458), [3458, 3456, 3457, 3459, 3460]);
});

test('candidatePorts falls back sensibly when expectedPort is undefined/null/invalid', () => {
  assert.deepEqual(candidatePorts(undefined), [3456, 3457, 3458, 3459, 3460]);
  assert.deepEqual(candidatePorts(null), [3456, 3457, 3458, 3459, 3460]);
  assert.deepEqual(candidatePorts(-1), [3456, 3457, 3458, 3459, 3460]);
  assert.deepEqual(candidatePorts('nope'), [3456, 3457, 3458, 3459, 3460]);
});

// ---- classifyProbe ------------------------------------------------------------

test('classifyProbe returns "down" for null (no response at all)', () => {
  assert.equal(classifyProbe(null), 'down');
});

test('classifyProbe returns "up-auth" for 401/403', () => {
  assert.equal(classifyProbe({ status: 401, body: '' }), 'up-auth');
  assert.equal(classifyProbe({ status: 403, body: '' }), 'up-auth');
});

test('classifyProbe returns "up" for a 200 with a {data:[...]} body', () => {
  assert.equal(classifyProbe({ status: 200, body: JSON.stringify({ object: 'list', data: [] }) }), 'up');
});

test('classifyProbe returns "up" for a 200 with a {models:[...]} body', () => {
  assert.equal(classifyProbe({ status: 200, body: JSON.stringify({ models: [{ id: 'x' }] }) }), 'up');
});

test('classifyProbe returns "foreign" for a 200 whose body has no model-list shape', () => {
  assert.equal(classifyProbe({ status: 200, body: JSON.stringify({ hello: 'world' }) }), 'foreign');
});

test('classifyProbe returns "foreign" for a 200 with a malformed JSON body', () => {
  assert.equal(classifyProbe({ status: 200, body: 'not json' }), 'foreign');
});

test('classifyProbe returns "foreign" for a 200 with an empty body', () => {
  assert.equal(classifyProbe({ status: 200, body: '' }), 'foreign');
});

test('classifyProbe returns "foreign" for any other status code', () => {
  assert.equal(classifyProbe({ status: 404, body: '' }), 'foreign');
  assert.equal(classifyProbe({ status: 500, body: '' }), 'foreign');
});

test('classifyProbe tolerates a malformed probe object instead of throwing', () => {
  assert.equal(classifyProbe(undefined), 'down');
  assert.equal(classifyProbe({}), 'down');
  assert.equal(classifyProbe('not an object'), 'down');
});

// ---- redactCcrOutput -----------------------------------------------------------

test('redactCcrOutput strips a ccr_web_token query string off a printed URL', () => {
  const raw = 'CCR service started at http://127.0.0.1:3458/?ccr_web_token=abc123secret (pid 456).';
  const redacted = redactCcrOutput(raw);
  assert.ok(!redacted.includes('ccr_web_token'));
  assert.ok(!redacted.includes('abc123secret'));
  assert.ok(redacted.includes('http://127.0.0.1:3458/'));
  assert.ok(redacted.includes('(pid 456).'));
});

test('redactCcrOutput passes a bare URL with no token through unchanged', () => {
  const raw = 'Gateway listening on http://127.0.0.1:3456/v1/models';
  assert.equal(redactCcrOutput(raw), raw);
});

test('redactCcrOutput strips a bare ccr_web_token pair outside a full URL', () => {
  const redacted = redactCcrOutput('token=ccr_web_token=xyz should not leak');
  assert.ok(!redacted.includes('ccr_web_token'));
});

test('redactCcrOutput caps oversized input to 500 chars', () => {
  const redacted = redactCcrOutput('a'.repeat(5000));
  assert.equal(redacted.length, 500);
});

test('redactCcrOutput handles non-string/null input safely', () => {
  assert.equal(redactCcrOutput(null), '');
  assert.equal(redactCcrOutput(undefined), '');
  assert.equal(redactCcrOutput(42), '');
  assert.equal(redactCcrOutput({}), '');
});

// ---- describeState -------------------------------------------------------------

test('describeState: not installed always wins, regardless of other signals', () => {
  assert.deepEqual(describeState({ installed: false, probe: 'up' }), {
    state: 'not-installed',
    reason: 'ccr-not-on-path',
    port: null,
  });
});

test('describeState: installed but no response is "down"', () => {
  assert.deepEqual(describeState({ installed: true, probe: 'down', expectedPort: 3456 }), {
    state: 'down',
    reason: 'gateway-not-listening',
    port: 3456,
  });
  assert.deepEqual(describeState({ installed: true, probe: null, expectedPort: 3456 }).state, 'down');
});

test('describeState: no response while LunaCore itself started it is "starting"', () => {
  assert.deepEqual(
    describeState({ installed: true, probe: 'down', expectedPort: 3456, startedByUs: true }),
    { state: 'starting', reason: 'start-in-progress', port: 3456 }
  );
});

test('describeState: "up-auth" probe maps to "auth-required"', () => {
  assert.deepEqual(describeState({ installed: true, probe: 'up-auth', foundPort: 3456 }), {
    state: 'auth-required',
    reason: 'gateway-requires-client-key',
    port: 3456,
  });
});

test('describeState: "foreign" probe maps to "foreign-port"', () => {
  assert.deepEqual(describeState({ installed: true, probe: 'foreign', foundPort: 3456 }), {
    state: 'foreign-port',
    reason: 'port-owned-by-another-process',
    port: 3456,
  });
});

test('describeState: "up" on the expected port is healthy', () => {
  assert.deepEqual(
    describeState({ installed: true, probe: 'up', expectedPort: 3456, foundPort: 3456 }),
    { state: 'up', reason: 'gateway-healthy', port: 3456 }
  );
});

test('describeState: "up" on a different port than expected is "port-mismatch"', () => {
  assert.deepEqual(
    describeState({ installed: true, probe: 'up', expectedPort: 3456, foundPort: 3457 }),
    { state: 'port-mismatch', reason: 'gateway-on-different-port', port: 3457 }
  );
});

test('describeState: "up" with no foundPort falls back to expectedPort', () => {
  assert.deepEqual(describeState({ installed: true, probe: 'up', expectedPort: 3456 }), {
    state: 'up',
    reason: 'gateway-healthy',
    port: 3456,
  });
});

// ---- impure functions: synchronous guard paths only (no real execFile/http) ---

test('probeGateway resolves null without any network attempt for an invalid port', async () => {
  assert.equal(await probeGateway(0), null);
  assert.equal(await probeGateway(-1), null);
  assert.equal(await probeGateway(NaN), null);
});

test('stopGateway({startedByUs:false}) resolves "not-ours" without ever calling ccr', async () => {
  const result = await stopGateway({ startedByUs: false });
  assert.deepEqual(result, { ok: false, reason: 'not-ours' });
});

test('stopGateway({}) (no startedByUs) also resolves "not-ours"', async () => {
  const result = await stopGateway({});
  assert.deepEqual(result, { ok: false, reason: 'not-ours' });
});

test('testClientKey resolves a typed "down" for a blank token without any network attempt', async () => {
  assert.deepEqual(await testClientKey(3456, ''), { ok: false, reason: 'down' });
  assert.deepEqual(await testClientKey(3456, '   '), { ok: false, reason: 'down' });
  assert.deepEqual(await testClientKey(3456, null), { ok: false, reason: 'down' });
});
