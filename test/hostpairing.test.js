// ============================================================================
// LunaCore - passkey pairing on the host (src/hostpairing.js)
// ----------------------------------------------------------------------------
// A fake supabase-js client over an in-memory host_pairings table plays the
// phone's side of the commit-reveal. Covered: the key lands in
// host-keys.local.json only after the dialog confirms, both sides derive the
// same code (the phone's WebCrypto path included), a reveal that doesn't match
// the commitment or a key swapped after the challenge never reaches the
// dialog, and "Forget all phones" empties the file and ends live grants.
// ============================================================================

'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const pairing = require('../src/hostpairing');
const canon = require('../src/hostcanon');
const { createHostAuth, REASONS } = require('../src/hostauth');

const { createHostPairing, commitmentOf, pairingCodeFor, readPairedKeys, hasPairedPhone, forgetAll, addKey, parseRequest } = pairing;

const HOST = 'KT-PC-LLM';
const NOW = Date.UTC(2026, 9, 21, 12);
const b64u = (buf) => Buffer.from(buf).toString('base64url');
const sha256 = (data) => crypto.createHash('sha256').update(data).digest();

let dir;
let keysPath;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hostpairing-'));
  keysPath = path.join(dir, 'host-keys.local.json');
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

/** Just enough of supabase-js for host_pairings. */
function fakeClient(table = []) {
  function query() {
    const q = { op: 'select', patch: null, returning: false, filters: [] };
    const match = (r) => q.filters.every((f) => f(r));
    const run = () => {
      const hits = table.filter(match);
      if (q.op === 'update') {
        hits.forEach((r) => Object.assign(r, q.patch));
        return { data: q.returning ? hits.map((r) => ({ id: r.id })) : null, error: null };
      }
      return { data: hits.map((r) => ({ ...r })), error: null };
    };
    const api = {
      select() {
        if (q.op === 'update') q.returning = true;
        return api;
      },
      update(patch) {
        q.op = 'update';
        q.patch = patch;
        return api;
      },
      eq(c, v) {
        q.filters.push((r) => r[c] === v);
        return api;
      },
      is(c, v) {
        q.filters.push((r) => (r[c] ?? null) === v);
        return api;
      },
      gt(c, v) {
        q.filters.push((r) => r[c] > v);
        return api;
      },
      order: () => api,
      limit: () => api,
      then: (res, rej) => Promise.resolve().then(run).then(res, rej),
    };
    return api;
  }
  return { table, from: () => query() };
}

/** The phone: a passkey, a secret nonce, the committed request row. */
function makePhone(over = {}) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const credentialId = b64u(crypto.randomBytes(16));
  const pub = b64u(publicKey.export({ type: 'spki', format: 'der' }));
  const phoneNonce = b64u(crypto.randomBytes(16));
  const row = {
    id: `p${crypto.randomBytes(4).toString('hex')}`,
    host: HOST,
    label: 'iPhone',
    credential_id: credentialId,
    public_key: pub,
    commitment: commitmentOf({ host: HOST, credentialId, publicKey: pub, phoneNonce }),
    host_nonce: null,
    phone_nonce: null,
    status: 'pending',
    created_at: new Date(NOW - 1000).toISOString(),
    ...over,
  };
  return { privateKey, credentialId, pub, phoneNonce, row };
}

function setup({ confirm = async () => true, rows = [] } = {}) {
  const client = fakeClient(rows);
  const prompts = [];
  let paired = 0;
  const p = createHostPairing({
    client,
    host: HOST,
    keysPath,
    confirm: async (req) => {
      prompts.push(req);
      return confirm(req);
    },
    onPaired: () => paired++,
    now: () => NOW,
    setTimer: () => 0,
    clearTimer: () => {},
    log: () => {},
  });
  return { client, prompts, p, paired: () => paired };
}

/** One full round: host challenges, phone reveals, host prompts. */
async function runPairing(env, phone) {
  env.p.open();
  await env.p.read();
  assert.ok(phone.row.host_nonce, 'the host challenged the request');
  phone.row.phone_nonce = phone.phoneNonce;
  await env.p.read();
}

test('the key is stored only after the dialog confirms', async () => {
  const phone = makePhone();
  const env = setup({ rows: [phone.row] });
  env.p.open();
  await env.p.read();
  assert.equal(hasPairedPhone(keysPath), false, 'nothing stored on the challenge');
  assert.equal(env.prompts.length, 0, 'no dialog before the reveal');
  phone.row.phone_nonce = phone.phoneNonce;
  await env.p.read();
  assert.equal(env.prompts.length, 1);
  const keys = readPairedKeys(keysPath);
  assert.equal(keys.length, 1);
  assert.equal(keys[0].credentialId, phone.credentialId);
  assert.equal(keys[0].publicKey, phone.pub);
  assert.equal(phone.row.status, 'confirmed');
  assert.equal(env.paired(), 1);
  assert.equal(env.p.isOpen(), false, 'the window closes once paired');
});

test('rejected in the dialog: no key, the row says rejected', async () => {
  const phone = makePhone();
  const env = setup({ rows: [phone.row], confirm: async () => false });
  await runPairing(env, phone);
  assert.equal(env.prompts.length, 1);
  assert.equal(fs.existsSync(keysPath), false);
  assert.equal(phone.row.status, 'rejected');
});

test('a dialog that throws counts as rejected', async () => {
  const phone = makePhone();
  const env = setup({ rows: [phone.row], confirm: async () => Promise.reject(new Error('no display')) });
  await runPairing(env, phone);
  assert.equal(fs.existsSync(keysPath), false);
  assert.equal(phone.row.status, 'rejected');
});

test('code derivation: host and phone (WebCrypto) show the same 6 digits', async () => {
  const phone = makePhone();
  const env = setup({ rows: [phone.row] });
  await runPairing(env, phone);
  const req = { host: HOST, credentialId: phone.credentialId, publicKey: phone.pub, hostNonce: phone.row.host_nonce, phoneNonce: phone.phoneNonce };
  // The phone's path: subtle.digest over the same canonical bytes.
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(canon.canonicalPairing(req))));
  const phoneCode = canon.pairingCode(digest);
  assert.match(phoneCode, /^\d{6}$/);
  assert.equal(env.prompts[0].code, phoneCode);
  assert.equal(pairingCodeFor(req), phoneCode);
});

test('pairingCode: first 4 bytes big-endian mod 10^6, zero-padded', () => {
  assert.equal(canon.pairingCode(Buffer.from([0, 0, 0, 7])), '000007');
  assert.equal(canon.pairingCode(Buffer.from([0xff, 0xff, 0xff, 0xff])), String(0xffffffff % 1000000).padStart(6, '0'));
  assert.throws(() => canon.pairingCode(Buffer.from([1, 2])), TypeError);
  // Every input field changes the code's input.
  const base = { host: HOST, credentialId: 'c', publicKey: 'k', hostNonce: 'h', phoneNonce: 'p' };
  const text = canon.canonicalPairing(base);
  for (const k of Object.keys(base)) assert.notEqual(canon.canonicalPairing({ ...base, [k]: 'x' }), text, k);
});

test('a reveal that does not match the commitment never reaches the dialog', async () => {
  const phone = makePhone();
  const env = setup({ rows: [phone.row] });
  env.p.open();
  await env.p.read();
  phone.row.phone_nonce = b64u(crypto.randomBytes(16));
  await env.p.read();
  assert.equal(env.prompts.length, 0);
  assert.equal(phone.row.status, 'rejected');
  assert.equal(fs.existsSync(keysPath), false);
});

test('a key swapped into the row after the challenge is never stored', async () => {
  const phone = makePhone();
  const attacker = makePhone();
  const env = setup({ rows: [phone.row] });
  env.p.open();
  await env.p.read();
  // A stolen session rewrites the row: the attacker's key and a matching commitment.
  Object.assign(phone.row, {
    credential_id: attacker.credentialId,
    public_key: attacker.pub,
    commitment: commitmentOf({ host: HOST, credentialId: attacker.credentialId, publicKey: attacker.pub, phoneNonce: attacker.phoneNonce }),
    phone_nonce: attacker.phoneNonce,
  });
  await env.p.read();
  assert.equal(env.prompts.length, 0, 'the host checks against its own snapshot');
  assert.equal(fs.existsSync(keysPath), false);
});

test('a changed host_nonce on the row is refused', async () => {
  const phone = makePhone();
  const env = setup({ rows: [phone.row] });
  env.p.open();
  await env.p.read();
  phone.row.host_nonce = b64u(crypto.randomBytes(16));
  phone.row.phone_nonce = phone.phoneNonce;
  await env.p.read();
  assert.equal(env.prompts.length, 0);
  assert.equal(phone.row.status, 'rejected');
});

test('nothing happens while the pairing window is closed', async () => {
  const phone = makePhone();
  const env = setup({ rows: [phone.row] });
  await env.p.read();
  assert.equal(phone.row.host_nonce, null);
  env.p.open();
  env.p.close();
  await env.p.read();
  assert.equal(phone.row.host_nonce, null);
});

test('a row challenged by someone else, old, for another host or malformed is not prompted', async () => {
  const foreign = makePhone({ host_nonce: b64u(crypto.randomBytes(16)) });
  const old = makePhone({ created_at: new Date(NOW - pairing.WINDOW_MS - 1).toISOString() });
  const other = makePhone({ host: 'OTHER-PC' });
  const broken = makePhone({ public_key: 'not-a-key-'.repeat(8) });
  const env = setup({ rows: [foreign.row, old.row, other.row, broken.row] });
  env.p.open();
  await env.p.read();
  assert.equal(old.row.host_nonce, null);
  assert.equal(other.row.host_nonce, null);
  assert.equal(broken.row.host_nonce, null);
  assert.equal(broken.row.status, 'rejected');
  foreign.row.phone_nonce = foreign.phoneNonce;
  await env.p.read();
  assert.equal(env.prompts.length, 0);
});

test('parseRequest: shape checks', () => {
  const phone = makePhone();
  assert.ok(parseRequest(phone.row, HOST));
  assert.equal(parseRequest(phone.row, 'OTHER'), null);
  assert.equal(parseRequest({ ...phone.row, commitment: 'short' }, HOST), null);
  assert.equal(parseRequest({ ...phone.row, credential_id: 'a+b/c' }, HOST), null);
  assert.equal(parseRequest({ ...phone.row, label: '<script>' }, HOST).label, 'iPhone', 'odd labels fall back');
});

test('addKey replaces the same credential and keeps the others', () => {
  const a = makePhone();
  const b = makePhone();
  addKey(keysPath, { credentialId: a.credentialId, publicKey: a.pub, label: 'A' }, 1);
  addKey(keysPath, { credentialId: b.credentialId, publicKey: b.pub, label: 'B' }, 2);
  addKey(keysPath, { credentialId: a.credentialId, publicKey: a.pub, label: 'A2' }, 3);
  const keys = readPairedKeys(keysPath);
  assert.deepEqual(keys.map((k) => k.label).sort(), ['A2', 'B']);
  assert.ok(keys.every((k) => k.signCount === 0));
});

test('hasPairedPhone: missing or broken file is no phone', () => {
  assert.equal(hasPairedPhone(keysPath), false);
  fs.writeFileSync(keysPath, '{nope');
  assert.equal(hasPairedPhone(keysPath), false);
});

// ---- forget all phones -----------------------------------------------------------

/** A WebAuthn grant from the paired passkey, as the phone sends it. */
function grantEnvelope(phone, sessionPub, now) {
  const grant = { sessionKeyPub: sessionPub, host: HOST, expires_at: now + 60 * 60 * 1000, nonce: b64u(crypto.randomBytes(16)) };
  const challenge = sha256(canon.canonicalGrant(grant)).toString('base64url');
  const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge, origin: 'https://luna-core-hud.vercel.app' }));
  const authData = Buffer.concat([sha256('luna-core-hud.vercel.app'), Buffer.from([0x05]), Buffer.from([0, 0, 0, 0])]);
  const signature = crypto.sign('sha256', Buffer.concat([authData, sha256(clientDataJSON)]), phone.privateKey);
  return {
    grant,
    assertion: { credentialId: phone.credentialId, authenticatorData: b64u(authData), clientDataJSON: b64u(clientDataJSON), signature: b64u(signature) },
  };
}

test('forget all phones empties the file and invalidates live grants', async () => {
  const phone = makePhone();
  const env = setup({ rows: [phone.row] });
  await runPairing(env, phone);

  const auth = createHostAuth({ host: HOST, keysPath, noncesPath: path.join(dir, 'host-nonces.local.json'), now: () => NOW, log: () => {} });
  const session = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const envelope = grantEnvelope(phone, b64u(session.publicKey.export({ type: 'spki', format: 'der' })), NOW);
  const sign = () => {
    const command = { host: HOST, kind: 'git.fetchAll', payload: {}, nonce: b64u(crypto.randomBytes(16)), expires_at: NOW + 60 * 1000 };
    const sig = crypto.sign('sha256', Buffer.from(canon.canonicalCommand(command)), { key: session.privateKey, dsaEncoding: 'ieee-p1363' });
    return { grant: envelope, command, sig: b64u(sig) };
  };
  assert.equal(auth.verifyCommand(sign()).ok, true, 'the paired phone can command');

  forgetAll(keysPath);
  auth.forgetGrants();
  assert.deepEqual(JSON.parse(fs.readFileSync(keysPath, 'utf8')), { v: 1, keys: [] });
  assert.equal(hasPairedPhone(keysPath), false);
  assert.deepEqual(auth.verifyCommand(sign()), { ok: false, reason: REASONS.GRANT_NO_PAIRED_KEYS });
  assert.deepEqual(auth.verifyGrant(envelope), { ok: false, reason: REASONS.GRANT_NO_PAIRED_KEYS });
});
