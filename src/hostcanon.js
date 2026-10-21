// ============================================================================
// LunaCore - canonical JSON for host grants and commands (main + phone)
// ----------------------------------------------------------------------------
// docs/REMOTE_HOST_PLAN.md, "Passkey + session key". The phone signs these
// bytes (mobile/src/hostkey.js) and the host verifies them (src/hostauth.js),
// so both sides import this one file: the form is byte-identical by build.
//
// Canonical form: JSON with object keys sorted (UTF-16 code unit order, the
// default Array#sort) at every depth, no whitespace, strings and numbers as
// JSON.stringify writes them. Anything JSON cannot carry the same way twice
// (undefined, functions, NaN, Dates, class instances, BigInt) throws a
// TypeError instead of being silently dropped or coerced.
//
// Pairing (src/hostpairing.js, mobile/src/hostpair.js) is commit-reveal, so
// a stolen cloud session can't grind a key whose code matches the phone's:
//   commit  the phone sends sha256(canonicalCommit) with its key, nonce secret
//   host    adds its own random hostNonce once it has seen the commitment
//   reveal  the phone sends phoneNonce; the host checks it against the commit
//   code    both show pairingCode(sha256(canonicalPairing)), 6 digits
// ============================================================================

'use strict';

/** The longest a passkey-signed session grant may live. */
const GRANT_TTL_MAX_MS = 12 * 60 * 60 * 1000;
/** The longest a session-key-signed command may live. */
const COMMAND_TTL_MAX_MS = 2 * 60 * 1000;
/** Deeper payloads are refused: no command needs them, a stack overflow does. */
const MAX_DEPTH = 32;

function isPlainObject(v) {
  if (v === null || typeof v !== 'object') return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function write(value, depth) {
  if (depth > MAX_DEPTH) throw new TypeError('canonicalJson: nested too deep');
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'string':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError('canonicalJson: non-finite number');
      return JSON.stringify(value);
    case 'object':
      break;
    default:
      throw new TypeError(`canonicalJson: unsupported ${typeof value}`);
  }
  if (Array.isArray(value)) return `[${value.map((v) => write(v, depth + 1)).join(',')}]`;
  if (!isPlainObject(value)) throw new TypeError('canonicalJson: not a plain object');
  const parts = Object.keys(value)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${write(value[k], depth + 1)}`);
  return `{${parts.join(',')}}`;
}

/** value -> canonical JSON string. Throws TypeError on anything not plain JSON. */
function canonicalJson(value) {
  return write(value, 0);
}

/** The signed part of a host command: exactly these five fields. */
function canonicalCommand(cmd) {
  const { host, kind, payload, nonce, expires_at } = cmd || {};
  return canonicalJson({ host, kind, payload, nonce, expires_at });
}

/** The passkey-signed part of a session grant: exactly these four fields. */
function canonicalGrant(grant) {
  const { sessionKeyPub, host, expires_at, nonce } = grant || {};
  return canonicalJson({ sessionKeyPub, host, expires_at, nonce });
}

/** What the phone commits to before the host's nonce is known. */
function canonicalCommit(req) {
  const { host, credentialId, publicKey, phoneNonce } = req || {};
  return canonicalJson({ host, credentialId, publicKey, phoneNonce });
}

/** The whole pairing, both nonces included: the input of the 6-digit code. */
function canonicalPairing(req) {
  const { host, credentialId, publicKey, hostNonce, phoneNonce } = req || {};
  return canonicalJson({ host, credentialId, publicKey, hostNonce, phoneNonce });
}

/** sha256(canonicalPairing) bytes -> "042917": the first 4 bytes, big-endian, mod 10^6. */
function pairingCode(digest) {
  const b = digest;
  if (!b || b.length < 4) throw new TypeError('pairingCode: digest too short');
  const n = ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0;
  return String(n % 1000000).padStart(6, '0');
}

module.exports = {
  canonicalJson,
  canonicalCommand,
  canonicalGrant,
  canonicalCommit,
  canonicalPairing,
  pairingCode,
  GRANT_TTL_MAX_MS,
  COMMAND_TTL_MAX_MS,
  MAX_DEPTH,
};
