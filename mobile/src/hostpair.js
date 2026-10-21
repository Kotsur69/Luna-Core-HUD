// ============================================================================
// LunaCore phone - pair a passkey with a host (REMOTE_HOST_PLAN H1)
// ----------------------------------------------------------------------------
// The host side is src/hostpairing.js; both derive the code with
// src/hostcanon.js. Commit-reveal, so a stolen cloud session can't grind a key
// whose code matches this phone's:
//
//   1. a new passkey (WebAuthn, rp = this domain, ES256, user verification)
//   2. offer {credentialId, publicKey, commitment = sha256(canonicalCommit)};
//      phoneNonce stays in memory
//   3. the host writes its host_nonce -> reveal phoneNonce, show the code
//   4. Mati compares the codes and confirms on the host; the row says
//      confirmed / rejected
//
// Only the credential id is kept on the phone (to ask for that passkey when
// signing grants, hostkey.js); the private key never leaves the authenticator.
// ============================================================================

import canon from '../../src/hostcanon.js';
import * as idb from './idb.js';

const ES256 = -7;
const NONCE_BYTES = 16;
const PASSKEY_TIMEOUT_MS = 60 * 1000;
const POLL_MS = 2000;
/** src/hostpairing.js WINDOW_MS: past this the host never answers. */
const GIVE_UP_MS = 10 * 60 * 1000;
const NONCE_RE = /^[A-Za-z0-9_-]{22,64}$/;
/** hostauth.js MACHINE_RE. */
export const HOST_RE = /^[A-Za-z0-9-]{1,63}$/;
const pairedKey = (host) => `hostkey:paired:${host}`;

const utf8 = (text) => new TextEncoder().encode(text);

function b64u(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = '';
  for (const b of view) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const sha256 = async (text) => new Uint8Array(await crypto.subtle.digest('SHA-256', utf8(text)));
const randomB64u = (n) => b64u(crypto.getRandomValues(new Uint8Array(n)));

/** Step 1: a new passkey for this host. Call from a user gesture (iOS). */
async function createPasskey(host) {
  const cred = await navigator.credentials.create({
    publicKey: {
      rp: { id: location.hostname, name: 'LunaCore' },
      user: { id: crypto.getRandomValues(new Uint8Array(16)), name: `lunacore-${host}`, displayName: `LunaCore ${host}` },
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      pubKeyCredParams: [{ type: 'public-key', alg: ES256 }],
      authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
      attestation: 'none',
      timeout: PASSKEY_TIMEOUT_MS,
    },
  });
  const r = cred && cred.response;
  if (!r || typeof r.getPublicKey !== 'function') throw new Error('pair-unsupported');
  if (typeof r.getPublicKeyAlgorithm === 'function' && r.getPublicKeyAlgorithm() !== ES256) throw new Error('pair-unsupported');
  const spki = r.getPublicKey();
  if (!spki) throw new Error('pair-unsupported');
  return { credentialId: b64u(cred.rawId), publicKey: b64u(spki) };
}

/** The 6 digits for a full pairing (both nonces known). */
export async function codeFor(req) {
  return canon.pairingCode(await sha256(canon.canonicalPairing(req)));
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The whole pairing. Resolves 'confirmed' | 'rejected' | 'timeout'.
 * @param {{cloud: object, host: string, label: string,
 *   onCode: (code: string) => void, isCancelled?: () => boolean}} opts
 */
export async function pairWithHost({ cloud, host, label, onCode, isCancelled = () => false }) {
  if (!HOST_RE.test(host)) throw new Error('pair-bad-host');
  const { credentialId, publicKey } = await createPasskey(host);
  const phoneNonce = randomB64u(NONCE_BYTES);
  const commitment = b64u(await sha256(canon.canonicalCommit({ host, credentialId, publicKey, phoneNonce })));
  const id = await cloud.pairOffer({ host, label, credential_id: credentialId, public_key: publicKey, commitment });

  const until = Date.now() + GIVE_UP_MS;
  let revealed = false;
  while (Date.now() < until && !isCancelled()) {
    await wait(POLL_MS);
    const row = await cloud.pairRead(id).catch(() => null);
    if (!row) continue;
    if (row.status === 'confirmed' || row.status === 'rejected') {
      if (row.status === 'confirmed') await idb.put(pairedKey(host), credentialId);
      return row.status;
    }
    if (!revealed && typeof row.host_nonce === 'string' && NONCE_RE.test(row.host_nonce)) {
      await cloud.pairReveal(id, phoneNonce);
      revealed = true;
      onCode(await codeFor({ host, credentialId, publicKey, hostNonce: row.host_nonce, phoneNonce }));
    }
  }
  return 'timeout';
}

/** The passkey paired with `host` on this phone, for hostkey.grantFor(). */
export async function pairedCredential(host) {
  const id = await idb.get(pairedKey(host)).catch(() => null);
  return typeof id === 'string' ? id : null;
}
