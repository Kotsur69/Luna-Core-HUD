// Canonical JSON for host commands and grants (src/hostcanon.js,
// REMOTE_HOST_PLAN "Passkey + session key"): the phone signs these bytes and
// the host verifies them, so the form must be byte-identical and stable.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const canon = require('../src/hostcanon');

test('canonicalJson sorts keys at every depth and drops whitespace', () => {
  const a = canon.canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: 'x' } });
  const b = canon.canonicalJson({ a: { c: 'x', d: [3, { y: 2, z: 1 }] }, b: 1 });
  assert.equal(a, '{"a":{"c":"x","d":[3,{"y":2,"z":1}]},"b":1}');
  assert.equal(a, b);
});

test('canonicalJson keeps array order and escapes strings like JSON', () => {
  assert.equal(canon.canonicalJson([2, 1, 'a"b\n', true, false, null]), '[2,1,"a\\"b\\n",true,false,null]');
  assert.equal(canon.canonicalJson({ 'ż': 1, z: 2, Z: 3 }), '{"Z":3,"z":2,"ż":1}');
});

test('canonicalJson refuses values JSON cannot carry the same way twice', () => {
  for (const bad of [undefined, () => 1, Symbol('s'), 1n, NaN, Infinity, new Date(0), { a: undefined }, [undefined]]) {
    assert.throws(() => canon.canonicalJson(bad), TypeError);
  }
});

test('canonicalJson refuses nesting past the depth cap', () => {
  let deep = 1;
  for (let i = 0; i < canon.MAX_DEPTH + 1; i++) deep = [deep];
  assert.throws(() => canon.canonicalJson(deep), TypeError);
});

test('canonicalCommand signs exactly host, kind, payload, nonce, expires_at', () => {
  const cmd = { kind: 'news.scan', host: 'KT-PC-LLM', payload: { b: 2, a: 1 }, nonce: 'n'.repeat(22), expires_at: 1000, sig: 'ignored', extra: 1 };
  assert.equal(
    canon.canonicalCommand(cmd),
    '{"expires_at":1000,"host":"KT-PC-LLM","kind":"news.scan","nonce":"nnnnnnnnnnnnnnnnnnnnnn","payload":{"a":1,"b":2}}',
  );
});

test('canonicalGrant signs exactly sessionKeyPub, host, expires_at, nonce', () => {
  const grant = { sessionKeyPub: 'PUB', host: 'KT-PC-LLM', expires_at: 5, nonce: 'abc', other: true };
  assert.equal(canon.canonicalGrant(grant), '{"expires_at":5,"host":"KT-PC-LLM","nonce":"abc","sessionKeyPub":"PUB"}');
});

test('the TTL caps are the plan values', () => {
  assert.equal(canon.GRANT_TTL_MAX_MS, 12 * 60 * 60 * 1000);
  assert.equal(canon.COMMAND_TTL_MAX_MS, 2 * 60 * 1000);
});
