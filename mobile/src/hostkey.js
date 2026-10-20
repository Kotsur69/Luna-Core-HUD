// ============================================================================
// LunaCore phone - session key for host commands
// ----------------------------------------------------------------------------
// docs/REMOTE_HOST_PLAN.md, "Passkey + session key". The host side is
// src/hostauth.js; both sign/verify the canonical form of src/hostcanon.js.
//
//   session key  WebCrypto ECDSA P-256, generated with extractable = false
//                and kept in IndexedDB (a CryptoKey survives structured
//                clone, still non-extractable). Lives <= 12 h.
//   grant        once per session and host: a passkey assertion (Face ID,
//                userVerification 'required') over the challenge
//                sha256(canonicalGrant({sessionKeyPub, host, expires_at,
//                nonce})). The host checks it against the passkey it paired.
//   command      every host command is signed with the session key over
//                canonicalCommand({host, kind, payload, nonce, expires_at}),
//                expiring in < 2 min, with a fresh random nonce.
//
// The key and its grants are wiped on logout (cloud.js) and when they expire.
// Expiries sit CLOCK_MARGIN_MS under the host's caps, so a phone clock a little
// ahead of the host's is not refused as "lifetime too long".
// ============================================================================

import canon from '../../src/hostcanon.js';
import * as idb from './idb.js';

const STORE_KEY = 'hostkey:session';
const CLOCK_MARGIN_MS = 30 * 1000;
const NONCE_BYTES = 16;
const PASSKEY_TIMEOUT_MS = 60 * 1000;
const ECDSA = { name: 'ECDSA', namedCurve: 'P-256' };
const SIGN = { name: 'ECDSA', hash: 'SHA-256' };

/** {privateKey, pub, expiresAt, grants: {[host]: envelope}} or null. */
let current = null;
/** Bumped by wipe(): work started before it never stores its result. */
let generation = 0;
/** host -> pending grant promise: one Face ID prompt per host at a time. */
const pendingGrants = new Map();

const utf8 = (text) => new TextEncoder().encode(text);

function b64u(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = '';
  for (const b of view) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64u(text) {
  const bin = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

const randomNonce = () => b64u(crypto.getRandomValues(new Uint8Array(NONCE_BYTES)));

/** Only a non-extractable P-256 signing key read back from IndexedDB is used. */
function isSession(s, now) {
  return (
    Boolean(s) &&
    s.privateKey instanceof CryptoKey &&
    s.privateKey.extractable === false &&
    s.privateKey.algorithm?.namedCurve === 'P-256' &&
    typeof s.pub === 'string' &&
    Number.isFinite(s.expiresAt) &&
    s.expiresAt > now &&
    Boolean(s.grants) &&
    typeof s.grants === 'object'
  );
}

async function createSession(now) {
  const pair = await crypto.subtle.generateKey(ECDSA, false, ['sign', 'verify']);
  // The public half of a pair is always exportable; the private half is not.
  const pub = b64u(await crypto.subtle.exportKey('spki', pair.publicKey));
  return { privateKey: pair.privateKey, pub, expiresAt: now + canon.GRANT_TTL_MAX_MS - CLOCK_MARGIN_MS, grants: {} };
}

function assertCurrent(gen) {
  if (gen !== generation) throw new Error('hostkey: wiped while in use');
}

async function session() {
  const now = Date.now();
  if (current && current.expiresAt > now) return current;
  if (current) await wipe();
  const gen = generation;
  const stored = await idb.get(STORE_KEY).catch(() => null);
  if (isSession(stored, now)) {
    assertCurrent(gen);
    current = stored;
    return current;
  }
  const fresh = await createSession(now);
  assertCurrent(gen);
  await idb.put(STORE_KEY, fresh);
  current = fresh;
  return current;
}

async function requestGrant(host, credentialId) {
  const gen = generation;
  const s = await session();
  const grant = { sessionKeyPub: s.pub, host, expires_at: s.expiresAt, nonce: randomNonce() };
  const challenge = new Uint8Array(await crypto.subtle.digest('SHA-256', utf8(canon.canonicalGrant(grant))));
  const cred = await navigator.credentials.get({
    publicKey: {
      challenge,
      rpId: location.hostname,
      userVerification: 'required',
      timeout: PASSKEY_TIMEOUT_MS,
      allowCredentials: credentialId ? [{ type: 'public-key', id: fromB64u(credentialId) }] : [],
    },
  });
  if (!cred || !cred.response) throw new Error('hostkey: no passkey assertion');
  const r = cred.response;
  const envelope = {
    grant,
    assertion: {
      credentialId: b64u(cred.rawId),
      authenticatorData: b64u(r.authenticatorData),
      clientDataJSON: b64u(r.clientDataJSON),
      signature: b64u(r.signature),
    },
  };
  assertCurrent(gen);
  const next = { ...current, grants: { ...current.grants, [host]: envelope } };
  await idb.put(STORE_KEY, next);
  current = next;
  return envelope;
}

/**
 * The grant envelope for a host, asking for Face ID only when this session
 * has none for it yet. Call from a user gesture: iOS needs one for WebAuthn.
 * @param {string} host
 * @param {{credentialId?: string}} [opts] the paired passkey, when known
 */
export async function grantFor(host, { credentialId } = {}) {
  const s = await session();
  const have = s.grants[host];
  if (have && have.grant.expires_at - CLOCK_MARGIN_MS > Date.now()) return have;
  if (!pendingGrants.has(host)) {
    const p = requestGrant(host, credentialId).finally(() => pendingGrants.delete(host));
    pendingGrants.set(host, p);
  }
  return pendingGrants.get(host);
}

/**
 * A host command ready for `host_commands`: {command, sig, grant}.
 * @param {string} host
 * @param {string} kind     e.g. 'news.scan'
 * @param {object} payload  plain JSON
 * @param {{credentialId?: string}} [opts]
 */
export async function signCommand(host, kind, payload, opts) {
  const grant = await grantFor(host, opts);
  const s = await session();
  const command = { host, kind, payload, nonce: randomNonce(), expires_at: Date.now() + canon.COMMAND_TTL_MAX_MS - CLOCK_MARGIN_MS };
  const sig = await crypto.subtle.sign(SIGN, s.privateKey, utf8(canon.canonicalCommand(command)));
  return { command, sig: b64u(sig), grant };
}

/** Forget one host's grant (it refused it, e.g. after a restart): the next command asks Face ID again. */
export async function dropGrant(host) {
  if (!current || !current.grants[host]) return;
  const { [host]: _dropped, ...rest } = current.grants;
  const next = { ...current, grants: rest };
  current = next;
  await idb.put(STORE_KEY, next);
}

/** Logout / expiry: the key and every grant are gone from memory and IndexedDB. */
export async function wipe() {
  generation++;
  current = null;
  pendingGrants.clear();
  await idb.del(STORE_KEY);
}
