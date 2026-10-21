// Phone pairing (mobile/src/hostpair.js): the code the phone shows must be the
// one the host's dialog shows (src/hostpairing.js), from the same request.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { codeFor, HOST_RE } from '../mobile/src/hostpair.js';

const require = createRequire(import.meta.url);
const { pairingCodeFor } = require('../src/hostpairing');

test('codeFor (WebCrypto) matches the host for the same pairing', async () => {
  const req = { host: 'KT-NO-MMAZUR', credentialId: 'Y3JlZGVudGlhbC1pZC0x', publicKey: 'cHVibGljLWtleS1zcGtp', hostNonce: 'aG9zdC1ub25jZS0xMjM0NTY3', phoneNonce: 'cGhvbmUtbm9uY2UtMTIzNDU2' };
  const code = await codeFor(req);
  assert.match(code, /^\d{6}$/);
  assert.equal(code, pairingCodeFor(req));
  assert.notEqual(await codeFor({ ...req, hostNonce: 'b3RoZXItaG9zdC1ub25jZS0x' }), code);
});

test('HOST_RE: the machine names hostauth accepts', () => {
  assert.ok(HOST_RE.test('KT-PC-LLM'));
  assert.ok(!HOST_RE.test('a b'));
  assert.ok(!HOST_RE.test(''));
  assert.ok(!HOST_RE.test('x'.repeat(64)));
});
