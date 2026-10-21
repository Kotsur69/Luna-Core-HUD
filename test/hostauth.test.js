// Host command / grant verification (src/hostauth.js, REMOTE_HOST_PLAN
// "Passkey + session key"). A fake authenticator signs grants the way a
// phone passkey does (WebAuthn ES256, DER signature over authData ||
// sha256(clientDataJSON)); a fake session key signs commands the way
// WebCrypto does (ECDSA P-256, IEEE P1363). Every refusal has its own reason.
'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createHostAuth, REASONS } = require('../src/hostauth');
const canon = require('../src/hostcanon');

const HOST = 'KT-PC-LLM';
const RP_ID = 'luna-core-hud.vercel.app';
const ORIGIN = `https://${RP_ID}`;
const NOW = Date.UTC(2026, 9, 20, 12);
const MIN = 60 * 1000;
const HOUR = 60 * MIN;

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const sha256 = (data) => crypto.createHash('sha256').update(data).digest();
const nonce = () => b64u(crypto.randomBytes(16));

let dir;
let keysPath;
let noncesPath;
let logged;
let clock;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hostauth-'));
  keysPath = path.join(dir, 'host-keys.local.json');
  noncesPath = path.join(dir, 'host-nonces.local.json');
  logged = [];
  clock = NOW;
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function makePasskey(signCount = 0) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const credentialId = b64u(crypto.randomBytes(16));
  return { credentialId, privateKey, publicKey: b64u(publicKey.export({ type: 'spki', format: 'der' })), signCount };
}

function pair(...passkeys) {
  const keys = passkeys.map((p) => ({ credentialId: p.credentialId, publicKey: p.publicKey, signCount: p.signCount, label: 'iPhone' }));
  fs.writeFileSync(keysPath, JSON.stringify({ v: 1, keys }));
}

function makeSessionKey() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return { privateKey, pub: b64u(publicKey.export({ type: 'spki', format: 'der' })) };
}

/** What navigator.credentials.get() returns for a grant, with knobs to break each check. */
function assertGrant(passkey, grant, opt = {}) {
  const challenge = opt.challenge ?? b64u(sha256(canon.canonicalGrant(grant)));
  const clientData = { type: opt.type ?? 'webauthn.get', challenge, origin: opt.origin ?? ORIGIN, crossOrigin: false };
  const clientDataJSON = Buffer.from(JSON.stringify(clientData));
  const flags = opt.flags ?? 0x05; // UP | UV
  const count = Buffer.alloc(4);
  count.writeUInt32BE(opt.signCount ?? passkey.signCount + 1);
  const authData = Buffer.concat([sha256(opt.rpId ?? RP_ID), Buffer.from([flags]), count]);
  const signature = crypto.sign('sha256', Buffer.concat([authData, sha256(clientDataJSON)]), opt.signer ?? passkey.privateKey);
  return {
    grant,
    assertion: {
      credentialId: opt.credentialId ?? passkey.credentialId,
      authenticatorData: b64u(authData),
      clientDataJSON: b64u(clientDataJSON),
      signature: b64u(signature),
    },
  };
}

function grantFor(session, over = {}) {
  return { sessionKeyPub: session.pub, host: HOST, expires_at: clock + 11 * HOUR, nonce: nonce(), ...over };
}

function signCommand(session, over = {}) {
  const command = { host: HOST, kind: 'news.scan', payload: { full: true }, nonce: nonce(), expires_at: clock + MIN, ...over };
  const sig = crypto.sign('sha256', Buffer.from(canon.canonicalCommand(command)), { key: session.privateKey, dsaEncoding: 'ieee-p1363' });
  return { command, sig: b64u(sig) };
}

function auth(over = {}) {
  return createHostAuth({
    host: HOST,
    rpId: RP_ID,
    origin: ORIGIN,
    keysPath,
    noncesPath,
    now: () => clock,
    log: (...args) => logged.push(args.join(' ')),
    ...over,
  });
}

/** A paired passkey, a session key and a valid grant envelope for it. */
function setup() {
  const passkey = makePasskey(3);
  pair(passkey);
  const session = makeSessionKey();
  const envelope = assertGrant(passkey, grantFor(session));
  return { passkey, session, envelope };
}

function refused(result, reason) {
  assert.equal(result.ok, false);
  assert.equal(result.reason, reason);
  assert.ok(logged.some((line) => line.includes(reason)), `logged ${reason}`);
}

// ---- grants -----------------------------------------------------------------

test('a valid grant from a paired passkey is accepted and the sign count is stored', () => {
  const { session, envelope } = setup();
  const result = auth().verifyGrant(envelope);
  assert.equal(result.ok, true);
  assert.equal(result.grant.sessionKeyPub, session.pub);
  assert.equal(JSON.parse(fs.readFileSync(keysPath, 'utf8')).keys[0].signCount, 4);
});

test('the passkey public key comes only from the injected keys file', () => {
  const { passkey, session } = setup();
  const stranger = makePasskey(0);
  // An attacker's passkey with a matching credential id but its own key: refused.
  const forged = assertGrant(passkey, grantFor(session), { signer: stranger.privateKey });
  refused(auth().verifyGrant(forged), REASONS.GRANT_BAD_SIGNATURE);
  refused(auth().verifyGrant(assertGrant(stranger, grantFor(session))), REASONS.GRANT_UNKNOWN_CREDENTIAL);
});

test('no keys file means no paired phone', () => {
  const session = makeSessionKey();
  refused(auth().verifyGrant(assertGrant(makePasskey(), grantFor(session))), REASONS.GRANT_NO_PAIRED_KEYS);
});

test('a corrupt keys file is refused, not trusted', () => {
  const { envelope } = setup();
  fs.writeFileSync(keysPath, '{not json');
  refused(auth().verifyGrant(envelope), REASONS.GRANT_KEYS_UNREADABLE);
});

test('grant: wrong rpIdHash is refused', () => {
  const { passkey, session } = setup();
  refused(auth().verifyGrant(assertGrant(passkey, grantFor(session), { rpId: 'evil.example' })), REASONS.GRANT_RP_ID_MISMATCH);
});

test('grant: wrong clientData origin is refused', () => {
  const { passkey, session } = setup();
  refused(auth().verifyGrant(assertGrant(passkey, grantFor(session), { origin: 'https://evil.example' })), REASONS.GRANT_WRONG_ORIGIN);
});

test('grant: clientData type other than webauthn.get is refused', () => {
  const { passkey, session } = setup();
  refused(auth().verifyGrant(assertGrant(passkey, grantFor(session), { type: 'webauthn.create' })), REASONS.GRANT_WRONG_TYPE);
});

test('grant: a challenge for another grant is refused', () => {
  const { passkey, session } = setup();
  const other = b64u(sha256(canon.canonicalGrant(grantFor(session))));
  refused(auth().verifyGrant(assertGrant(passkey, grantFor(session), { challenge: other })), REASONS.GRANT_CHALLENGE_MISMATCH);
});

test('grant: a tampered grant (session key swapped after signing) is refused', () => {
  const { session, envelope } = setup();
  const swapped = { ...envelope, grant: { ...envelope.grant, sessionKeyPub: makeSessionKey().pub } };
  assert.notEqual(swapped.grant.sessionKeyPub, session.pub);
  refused(auth().verifyGrant(swapped), REASONS.GRANT_CHALLENGE_MISMATCH);
});

test('grant: missing user-verified flag is refused', () => {
  const { passkey, session } = setup();
  refused(auth().verifyGrant(assertGrant(passkey, grantFor(session), { flags: 0x01 })), REASONS.GRANT_USER_NOT_VERIFIED);
});

test('grant: missing user-present flag is refused', () => {
  const { passkey, session } = setup();
  refused(auth().verifyGrant(assertGrant(passkey, grantFor(session), { flags: 0x04 })), REASONS.GRANT_USER_NOT_PRESENT);
});

test('grant: a non-increasing sign count is refused', () => {
  const { passkey, session } = setup();
  refused(auth().verifyGrant(assertGrant(passkey, grantFor(session), { signCount: 3 })), REASONS.GRANT_SIGN_COUNT);
  refused(auth().verifyGrant(assertGrant(passkey, grantFor(session), { signCount: 2 })), REASONS.GRANT_SIGN_COUNT);
});

test('grant: a replayed assertion is refused on a fresh host by its sign count', () => {
  const { envelope } = setup();
  assert.equal(auth().verifyGrant(envelope).ok, true);
  // A restarted host (no grant cache) sees the same assertion again.
  refused(auth().verifyGrant(envelope), REASONS.GRANT_SIGN_COUNT);
});

test('grant: a synced passkey that always reports 0 is accepted (WebAuthn rule)', () => {
  const passkey = makePasskey(0);
  pair(passkey);
  const session = makeSessionKey();
  assert.equal(auth().verifyGrant(assertGrant(passkey, grantFor(session), { signCount: 0 })).ok, true);
});

test('grant: a counter going back to 0 after a non-zero one is refused', () => {
  const { passkey, session } = setup();
  refused(auth().verifyGrant(assertGrant(passkey, grantFor(session), { signCount: 0 })), REASONS.GRANT_SIGN_COUNT);
});

test('grant: expired is refused', () => {
  const { passkey, session } = setup();
  refused(auth().verifyGrant(assertGrant(passkey, grantFor(session, { expires_at: clock - 1 }))), REASONS.GRANT_EXPIRED);
});

test('grant: a lifetime over 12 h is refused', () => {
  const { passkey, session } = setup();
  const env = assertGrant(passkey, grantFor(session, { expires_at: clock + 12 * HOUR + 1 }));
  refused(auth().verifyGrant(env), REASONS.GRANT_TTL_TOO_LONG);
});

test('grant: another host is refused', () => {
  const { passkey, session } = setup();
  refused(auth().verifyGrant(assertGrant(passkey, grantFor(session, { host: 'KT-NO-MMAZUR' }))), REASONS.GRANT_HOST_MISMATCH);
});

test('grant: a session key that is not P-256 is refused', () => {
  const passkey = makePasskey(3);
  pair(passkey);
  const ed = crypto.generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'der' });
  refused(auth().verifyGrant(assertGrant(passkey, grantFor({ pub: b64u(ed) }))), REASONS.GRANT_SESSION_KEY_INVALID);
});

test('grant: malformed envelopes are refused without throwing', () => {
  for (const bad of [null, 'x', {}, { grant: {} }, { grant: { host: HOST }, assertion: {} }, { grant: grantFor(makeSessionKey()), assertion: { credentialId: '!!' } }]) {
    const result = auth().verifyGrant(bad);
    assert.equal(result.ok, false);
    assert.equal(result.reason, REASONS.GRANT_MALFORMED);
  }
});

// ---- commands ---------------------------------------------------------------

test('a signed command under a valid grant is accepted', () => {
  const { session, envelope } = setup();
  const { command, sig } = signCommand(session);
  const result = auth().verifyCommand({ grant: envelope, command, sig });
  assert.equal(result.ok, true);
  assert.deepEqual(result.command, command);
});

test('one grant serves many commands within a host run', () => {
  const { session, envelope } = setup();
  const a = auth();
  for (let i = 0; i < 3; i++) assert.equal(a.verifyCommand({ grant: envelope, ...signCommand(session) }).ok, true);
});

test('a command signed the way the phone signs it (WebCrypto, non-extractable) is accepted', async () => {
  const subtle = crypto.webcrypto.subtle;
  const keyPair = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  assert.equal(keyPair.privateKey.extractable, false);
  const session = { pub: b64u(await subtle.exportKey('spki', keyPair.publicKey)) };
  const passkey = makePasskey(3);
  pair(passkey);
  const envelope = assertGrant(passkey, grantFor(session));
  const command = { host: HOST, kind: 'repo.clone', payload: { url: 'https://github.com/Kotsur69/x' }, nonce: nonce(), expires_at: clock + MIN };
  const sig = await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keyPair.privateKey, Buffer.from(canon.canonicalCommand(command)));
  assert.equal(auth().verifyCommand({ grant: envelope, command, sig: b64u(sig) }).ok, true);
});

test('command: a tampered payload is refused', () => {
  const { session, envelope } = setup();
  const { command, sig } = signCommand(session);
  refused(auth().verifyCommand({ grant: envelope, command: { ...command, payload: { full: false } }, sig }), REASONS.COMMAND_BAD_SIGNATURE);
});

test('command: a tampered kind is refused', () => {
  const { session, envelope } = setup();
  const { command, sig } = signCommand(session);
  refused(auth().verifyCommand({ grant: envelope, command: { ...command, kind: 'repo.clone' }, sig }), REASONS.COMMAND_BAD_SIGNATURE);
});

test('command: signed by another key than the granted session key is refused', () => {
  const { envelope } = setup();
  refused(auth().verifyCommand({ grant: envelope, ...signCommand(makeSessionKey()) }), REASONS.COMMAND_BAD_SIGNATURE);
});

test('command: wrong host is refused', () => {
  const { session, envelope } = setup();
  refused(auth().verifyCommand({ grant: envelope, ...signCommand(session, { host: 'KT-NO-MMAZUR' }) }), REASONS.COMMAND_HOST_MISMATCH);
});

test('command: expired is refused', () => {
  const { session, envelope } = setup();
  refused(auth().verifyCommand({ grant: envelope, ...signCommand(session, { expires_at: clock - 1 }) }), REASONS.COMMAND_EXPIRED);
});

test('command: a lifetime over 2 min is refused', () => {
  const { session, envelope } = setup();
  refused(auth().verifyCommand({ grant: envelope, ...signCommand(session, { expires_at: clock + 2 * MIN + 1 }) }), REASONS.COMMAND_TTL_TOO_LONG);
});

test('command: a replayed nonce is refused, also after a host restart', () => {
  const { session, envelope } = setup();
  const signed = signCommand(session);
  const a = auth();
  assert.equal(a.verifyCommand({ grant: envelope, ...signed }).ok, true);
  refused(a.verifyCommand({ grant: envelope, ...signed }), REASONS.COMMAND_NONCE_REPLAYED);
  // Restarted host: grant cache gone, nonce store persisted. A fresh grant
  // (new Face ID) still cannot replay the old command.
  const passkey2 = makePasskey(10);
  pair(passkey2);
  const env2 = assertGrant(passkey2, grantFor(session));
  refused(auth().verifyCommand({ grant: env2, ...signed }), REASONS.COMMAND_NONCE_REPLAYED);
});

test('command: an expired grant refuses commands even when cached', () => {
  const { session, envelope } = setup();
  const a = auth();
  assert.equal(a.verifyCommand({ grant: envelope, ...signCommand(session) }).ok, true);
  clock = envelope.grant.expires_at + 1;
  refused(a.verifyCommand({ grant: envelope, ...signCommand(session) }), REASONS.GRANT_EXPIRED);
});

test('command: forgetting all phones ends a cached grant at once', () => {
  const { session, envelope } = setup();
  const a = auth();
  assert.equal(a.verifyCommand({ grant: envelope, ...signCommand(session) }).ok, true);
  fs.unlinkSync(keysPath);
  refused(a.verifyCommand({ grant: envelope, ...signCommand(session) }), REASONS.GRANT_NO_PAIRED_KEYS);
  pair(makePasskey(0));
  refused(a.verifyCommand({ grant: envelope, ...signCommand(session) }), REASONS.GRANT_UNKNOWN_CREDENTIAL);
});

test('command: a bad grant refuses the command with the grant reason', () => {
  const { passkey, session } = setup();
  const env = assertGrant(passkey, grantFor(session), { flags: 0x01 });
  refused(auth().verifyCommand({ grant: env, ...signCommand(session) }), REASONS.GRANT_USER_NOT_VERIFIED);
});

test('command: malformed input is refused without throwing', () => {
  const { session, envelope } = setup();
  const good = signCommand(session);
  const cases = [
    null,
    { grant: envelope },
    { grant: envelope, command: { ...good.command, kind: '../../etc' }, sig: good.sig },
    { grant: envelope, command: { ...good.command, nonce: 'short' }, sig: good.sig },
    { grant: envelope, command: { ...good.command, payload: 'x' }, sig: good.sig },
    { grant: envelope, command: good.command, sig: 'not base64url!' },
  ];
  for (const c of cases) {
    const result = auth().verifyCommand(c);
    assert.equal(result.ok, false);
    assert.equal(result.reason, REASONS.COMMAND_MALFORMED);
  }
});

test('nonce store prunes expired nonces when it writes', () => {
  const { session, envelope } = setup();
  const a = auth();
  assert.equal(a.verifyCommand({ grant: envelope, ...signCommand(session) }).ok, true);
  clock += 3 * MIN;
  assert.equal(a.verifyCommand({ grant: envelope, ...signCommand(session) }).ok, true);
  const stored = JSON.parse(fs.readFileSync(noncesPath, 'utf8'));
  assert.equal(Object.keys(stored.nonces).length, 1);
});

test('a corrupt nonce store fails closed', () => {
  const { session, envelope } = setup();
  fs.writeFileSync(noncesPath, 'garbage');
  refused(auth().verifyCommand({ grant: envelope, ...signCommand(session) }), REASONS.COMMAND_NONCE_STORE);
});

test('every reason code is distinct', () => {
  const values = Object.values(REASONS);
  assert.equal(new Set(values).size, values.length);
});
