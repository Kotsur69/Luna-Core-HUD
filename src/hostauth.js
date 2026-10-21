// ============================================================================
// LunaCore - host gate for remote commands (passkey grant + session key)
// ----------------------------------------------------------------------------
// docs/REMOTE_HOST_PLAN.md, "Passkey + session key". This is the only thing
// standing between a row in the cloud and code running on this machine, so
// it trusts nothing that came through the cloud:
//
//   grant    {sessionKeyPub, host, expires_at, nonce} + a WebAuthn assertion
//            by a passkey paired on THIS host. The passkey public key is read
//            only from host-keys.local.json (written by pairing on the host's
//            own screen), never from the cloud. Checked: rpIdHash ==
//            sha256(rpId), clientData type 'webauthn.get', origin, challenge
//            == base64url(sha256(canonicalGrant)), user present + verified
//            flags, signature, sign count increasing, host, expiry <= 12 h.
//   command  {host, kind, payload, nonce, expires_at} signed by the grant's
//            session key (ECDSA P-256, IEEE P1363 as WebCrypto signs).
//            Checked: host, expiry <= 2 min, signature, nonce never seen
//            (persisted, pruned once expired - an expired nonce is refused
//            as expired anyway).
//
// Every refusal returns {ok: false, reason} with its own REASONS code and is
// logged. Nothing throws past verifyGrant / verifyCommand.
//
// Sign count: the WebAuthn rule (L3 §6.1.1). Synced passkeys (iCloud
// Keychain) always report 0; when both the stored and received counts are 0
// the check is skipped, otherwise the received count must be greater.
// A replayed grant envelope is harmless without the session private key
// (non-extractable on the phone), so a verified grant is cached for this run
// and re-used for every command until it expires.
// ============================================================================

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const canon = require('./hostcanon');

const REASONS = Object.freeze({
  INTERNAL: 'internal_error',
  GRANT_MALFORMED: 'grant_malformed',
  GRANT_HOST_MISMATCH: 'grant_host_mismatch',
  GRANT_EXPIRED: 'grant_expired',
  GRANT_TTL_TOO_LONG: 'grant_ttl_too_long',
  GRANT_SESSION_KEY_INVALID: 'grant_session_key_invalid',
  GRANT_NO_PAIRED_KEYS: 'grant_no_paired_keys',
  GRANT_KEYS_UNREADABLE: 'grant_keys_unreadable',
  GRANT_UNKNOWN_CREDENTIAL: 'grant_unknown_credential',
  GRANT_CLIENT_DATA_MALFORMED: 'grant_client_data_malformed',
  GRANT_WRONG_TYPE: 'grant_wrong_type',
  GRANT_WRONG_ORIGIN: 'grant_wrong_origin',
  GRANT_CHALLENGE_MISMATCH: 'grant_challenge_mismatch',
  GRANT_RP_ID_MISMATCH: 'grant_rp_id_mismatch',
  GRANT_USER_NOT_PRESENT: 'grant_user_not_present',
  GRANT_USER_NOT_VERIFIED: 'grant_user_not_verified',
  GRANT_BAD_SIGNATURE: 'grant_bad_signature',
  GRANT_SIGN_COUNT: 'grant_sign_count_not_increasing',
  GRANT_KEYS_WRITE_FAILED: 'grant_keys_write_failed',
  COMMAND_MALFORMED: 'command_malformed',
  COMMAND_HOST_MISMATCH: 'command_host_mismatch',
  COMMAND_EXPIRED: 'command_expired',
  COMMAND_TTL_TOO_LONG: 'command_ttl_too_long',
  COMMAND_BAD_SIGNATURE: 'command_bad_signature',
  COMMAND_NONCE_REPLAYED: 'command_nonce_replayed',
  COMMAND_NONCE_STORE: 'command_nonce_store_unavailable',
});

/** The phone's Vercel deployment: the passkey's relying party. */
const DEFAULT_RP_ID = 'luna-core-hud.vercel.app';
const MACHINE_RE = /^[A-Za-z0-9-]{1,63}$/;
/** "news.scan", "repo.clone", "chat.approve": dotted lowerCamel words. */
const KIND_RE = /^[a-z][A-Za-z0-9]{0,31}(\.[a-z][A-Za-z0-9]{0,31}){1,3}$/;
/** 16..48 random bytes, base64url. */
const NONCE_RE = /^[A-Za-z0-9_-]{22,64}$/;
const B64U_RE = /^[A-Za-z0-9_-]+$/;
const MAX_B64U = 8192;
/** A command's canonical form past this is not a command. */
const MAX_COMMAND_CHARS = 64 * 1024;
/** Commands that may still be live at once; past this, refuse instead of growing. */
const MAX_NONCES = 10000;
const MAX_CACHED_GRANTS = 64;
const MAX_KEYS = 32;
/** rpIdHash(32) + flags(1) + signCount(4). */
const AUTH_DATA_MIN = 37;
const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const P1363_P256_BYTES = 64;

const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const isB64u = (v) => typeof v === 'string' && v.length > 0 && v.length <= MAX_B64U && B64U_RE.test(v);
const isTime = (v) => Number.isSafeInteger(v) && v > 0;
const sha256 = (data) => crypto.createHash('sha256').update(data).digest();
const refuse = (reason) => ({ ok: false, reason });

class Refusal extends Error {
  constructor(reason) {
    super(reason);
    this.reason = reason;
  }
}

/** Write next to the target, then rename: a crash never leaves half a file. */
function writeAtomic(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}

/** SPKI base64url -> P-256 KeyObject, or null. */
function p256Key(spkiB64u) {
  if (!isB64u(spkiB64u)) return null;
  try {
    const key = crypto.createPublicKey({ key: Buffer.from(spkiB64u, 'base64url'), format: 'der', type: 'spki' });
    return key.asymmetricKeyType === 'ec' && key.asymmetricKeyDetails?.namedCurve === 'prime256v1' ? key : null;
  } catch {
    return null;
  }
}

// ---- paired passkeys (host-keys.local.json) ---------------------------------

/**
 * {v, keys: [{credentialId, publicKey (SPKI b64url), signCount, ...}]}.
 * Throws Refusal: no file -> no paired keys, anything unreadable -> unreadable.
 */
function readKeys(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new Refusal(err.code === 'ENOENT' ? REASONS.GRANT_NO_PAIRED_KEYS : REASONS.GRANT_KEYS_UNREADABLE);
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Refusal(REASONS.GRANT_KEYS_UNREADABLE);
  }
  if (!isObject(data) || !Array.isArray(data.keys) || data.keys.length > MAX_KEYS) throw new Refusal(REASONS.GRANT_KEYS_UNREADABLE);
  if (data.keys.length === 0) throw new Refusal(REASONS.GRANT_NO_PAIRED_KEYS);
  return data;
}

function storeSignCount(file, data, credentialId, signCount) {
  const keys = data.keys.map((k) => (isObject(k) && k.credentialId === credentialId ? { ...k, signCount } : k));
  try {
    writeAtomic(file, { ...data, keys });
  } catch {
    throw new Refusal(REASONS.GRANT_KEYS_WRITE_FAILED);
  }
}

// ---- seen nonces (host-nonces.local.json) -----------------------------------

/**
 * Persisted {nonce: expires_at}. A file that exists but can't be read fails
 * closed on every call until fixed: forgetting nonces would allow replays.
 */
function createNonceStore(file, now) {
  let nonces = null;

  function load() {
    if (nonces) return nonces;
    let text = null;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    const map = new Map();
    if (text !== null) {
      const data = JSON.parse(text);
      if (!isObject(data) || !isObject(data.nonces)) throw new Error('nonce store malformed');
      for (const [n, exp] of Object.entries(data.nonces)) {
        if (!NONCE_RE.test(n) || !isTime(exp)) throw new Error('nonce store malformed');
        map.set(n, exp);
      }
    }
    nonces = map;
    return nonces;
  }

  const seen = (nonce) => load().has(nonce);

  function record(nonce, expiresAt) {
    const t = now();
    const next = new Map([...load()].filter(([, exp]) => exp > t));
    if (next.size >= MAX_NONCES) throw new Error('nonce store full');
    next.set(nonce, expiresAt);
    writeAtomic(file, { v: 1, nonces: Object.fromEntries(next) });
    nonces = next;
  }

  return { seen, record };
}

// ---- grant checks -------------------------------------------------------------

function parseGrantEnvelope(envelope) {
  if (!isObject(envelope) || !isObject(envelope.grant) || !isObject(envelope.assertion)) return null;
  const { sessionKeyPub, host, expires_at, nonce } = envelope.grant;
  const a = envelope.assertion;
  const ok =
    isB64u(sessionKeyPub) &&
    typeof host === 'string' &&
    MACHINE_RE.test(host) &&
    isTime(expires_at) &&
    typeof nonce === 'string' &&
    NONCE_RE.test(nonce) &&
    [a.credentialId, a.authenticatorData, a.clientDataJSON, a.signature].every(isB64u);
  if (!ok) return null;
  return {
    grant: { sessionKeyPub, host, expires_at, nonce },
    credentialId: a.credentialId,
    authData: Buffer.from(a.authenticatorData, 'base64url'),
    clientDataJSON: Buffer.from(a.clientDataJSON, 'base64url'),
    signature: Buffer.from(a.signature, 'base64url'),
  };
}

function checkClientData(raw, expectedChallenge, origin) {
  let cd;
  try {
    cd = JSON.parse(raw.toString('utf8'));
  } catch {
    throw new Refusal(REASONS.GRANT_CLIENT_DATA_MALFORMED);
  }
  if (!isObject(cd) || typeof cd.challenge !== 'string') throw new Refusal(REASONS.GRANT_CLIENT_DATA_MALFORMED);
  if (cd.type !== 'webauthn.get') throw new Refusal(REASONS.GRANT_WRONG_TYPE);
  if (cd.origin !== origin || cd.crossOrigin === true) throw new Refusal(REASONS.GRANT_WRONG_ORIGIN);
  if (cd.challenge.replace(/=+$/, '') !== expectedChallenge) throw new Refusal(REASONS.GRANT_CHALLENGE_MISMATCH);
}

function checkAuthData(authData, rpIdHash) {
  if (authData.length < AUTH_DATA_MIN) throw new Refusal(REASONS.GRANT_MALFORMED);
  if (!crypto.timingSafeEqual(authData.subarray(0, 32), rpIdHash)) throw new Refusal(REASONS.GRANT_RP_ID_MISMATCH);
  const flags = authData[32];
  if (!(flags & FLAG_UP)) throw new Refusal(REASONS.GRANT_USER_NOT_PRESENT);
  if (!(flags & FLAG_UV)) throw new Refusal(REASONS.GRANT_USER_NOT_VERIFIED);
  return authData.readUInt32BE(33);
}

// ---- the gate -------------------------------------------------------------------

/**
 * @param {object} opts
 * @param {string} opts.host       this machine's name; grants and commands must name it
 * @param {string} opts.keysPath   host-keys.local.json (paired passkeys)
 * @param {string} opts.noncesPath host-nonces.local.json (seen command nonces)
 * @param {string} [opts.rpId]     the passkey relying party (the phone's domain)
 * @param {string} [opts.origin]   the phone's origin, as clientDataJSON reports it
 * @param {() => number} [opts.now]
 * @param {(...args: string[]) => void} [opts.log]
 */
function createHostAuth({ host, keysPath, noncesPath, rpId = DEFAULT_RP_ID, origin = `https://${rpId}`, now = Date.now, log = console.warn }) {
  const rpIdHash = sha256(rpId);
  const nonceStore = createNonceStore(noncesPath, now);
  /** sha256(envelope) -> {grant, sessionKey}: grants verified in this run. */
  const grants = new Map();

  function report(result, what) {
    if (!result.ok) log(`[hostauth] refused ${what}: ${result.reason}`);
    return result;
  }

  function guarded(what, fn) {
    try {
      return report(fn(), what);
    } catch (err) {
      if (err instanceof Refusal) return report(refuse(err.reason), what);
      log(`[hostauth] ${what} check failed: ${err && err.message}`);
      return report(refuse(REASONS.INTERNAL), what);
    }
  }

  function checkLifetime(expiresAt, max, expired, tooLong) {
    const t = now();
    if (expiresAt <= t) throw new Refusal(expired);
    if (expiresAt - t > max) throw new Refusal(tooLong);
  }

  function cacheGrant(id, entry) {
    for (const [k, v] of grants) if (v.grant.expires_at <= now()) grants.delete(k);
    if (grants.size >= MAX_CACHED_GRANTS) grants.delete(grants.keys().next().value);
    grants.set(id, entry);
  }

  /** Throws Refusal; returns {grant, sessionKey}. */
  function grantOrThrow(envelope) {
    const parsed = parseGrantEnvelope(envelope);
    if (!parsed) throw new Refusal(REASONS.GRANT_MALFORMED);
    const { grant } = parsed;
    if (grant.host !== host) throw new Refusal(REASONS.GRANT_HOST_MISMATCH);
    checkLifetime(grant.expires_at, canon.GRANT_TTL_MAX_MS, REASONS.GRANT_EXPIRED, REASONS.GRANT_TTL_TOO_LONG);

    const id = sha256(canon.canonicalJson({ grant, assertion: envelope.assertion })).toString('hex');
    const cached = grants.get(id);
    // A cached grant still needs its passkey paired: "Forget all phones"
    // empties the keys file and must end live sessions at once.
    const keys = readKeys(keysPath);
    const paired = keys.keys.find((k) => isObject(k) && k.credentialId === parsed.credentialId);
    if (!paired) throw new Refusal(REASONS.GRANT_UNKNOWN_CREDENTIAL);
    if (cached) return cached;

    const sessionKey = p256Key(grant.sessionKeyPub);
    if (!sessionKey) throw new Refusal(REASONS.GRANT_SESSION_KEY_INVALID);
    const passkey = p256Key(paired.publicKey);
    if (!passkey) throw new Refusal(REASONS.GRANT_KEYS_UNREADABLE);

    const challenge = sha256(canon.canonicalGrant(grant)).toString('base64url');
    checkClientData(parsed.clientDataJSON, challenge, origin);
    const signCount = checkAuthData(parsed.authData, rpIdHash);

    const signed = Buffer.concat([parsed.authData, sha256(parsed.clientDataJSON)]);
    if (!crypto.verify('sha256', signed, passkey, parsed.signature)) throw new Refusal(REASONS.GRANT_BAD_SIGNATURE);

    const stored = Number.isSafeInteger(paired.signCount) && paired.signCount > 0 ? paired.signCount : 0;
    if ((signCount !== 0 || stored !== 0) && signCount <= stored) throw new Refusal(REASONS.GRANT_SIGN_COUNT);
    if (signCount > stored) storeSignCount(keysPath, keys, paired.credentialId, signCount);

    const entry = { grant, sessionKey };
    cacheGrant(id, entry);
    return entry;
  }

  /** envelope {grant, assertion} -> {ok: true, grant} | {ok: false, reason}. */
  function verifyGrant(envelope) {
    return guarded('grant', () => ({ ok: true, grant: grantOrThrow(envelope).grant }));
  }

  function parseCommand(input) {
    if (!isObject(input) || !isObject(input.command) || !isB64u(input.sig)) return null;
    const { host: h, kind, payload, nonce, expires_at } = input.command;
    const ok =
      typeof h === 'string' &&
      MACHINE_RE.test(h) &&
      typeof kind === 'string' &&
      KIND_RE.test(kind) &&
      isObject(payload) &&
      typeof nonce === 'string' &&
      NONCE_RE.test(nonce) &&
      isTime(expires_at);
    if (!ok) return null;
    const command = { host: h, kind, payload, nonce, expires_at };
    let text;
    try {
      text = canon.canonicalCommand(command);
    } catch {
      return null;
    }
    return text.length <= MAX_COMMAND_CHARS ? { command, text } : null;
  }

  /**
   * {grant: envelope, command, sig} -> {ok: true, command} | {ok: false, reason}.
   * The nonce is recorded only once everything else passed.
   */
  function verifyCommand(input) {
    return guarded('command', () => {
      const parsed = parseCommand(input);
      if (!parsed) throw new Refusal(REASONS.COMMAND_MALFORMED);
      const { command, text } = parsed;
      if (command.host !== host) throw new Refusal(REASONS.COMMAND_HOST_MISMATCH);
      checkLifetime(command.expires_at, canon.COMMAND_TTL_MAX_MS, REASONS.COMMAND_EXPIRED, REASONS.COMMAND_TTL_TOO_LONG);

      const { sessionKey } = grantOrThrow(input.grant);
      const sig = Buffer.from(input.sig, 'base64url');
      const valid = sig.length === P1363_P256_BYTES && crypto.verify('sha256', Buffer.from(text, 'utf8'), { key: sessionKey, dsaEncoding: 'ieee-p1363' }, sig);
      if (!valid) throw new Refusal(REASONS.COMMAND_BAD_SIGNATURE);

      let replayed;
      try {
        replayed = nonceStore.seen(command.nonce);
        if (!replayed) nonceStore.record(command.nonce, command.expires_at);
      } catch (err) {
        log(`[hostauth] nonce store: ${err && err.message}`);
        throw new Refusal(REASONS.COMMAND_NONCE_STORE);
      }
      if (replayed) throw new Refusal(REASONS.COMMAND_NONCE_REPLAYED);
      return { ok: true, command };
    });
  }

  /** "Forget all phones": drops the grants verified in this run (the keys file is emptied separately). */
  function forgetGrants() {
    grants.clear();
  }

  return { verifyGrant, verifyCommand, forgetGrants };
}

module.exports = { createHostAuth, REASONS, DEFAULT_RP_ID };
