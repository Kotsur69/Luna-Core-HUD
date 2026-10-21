// ============================================================================
// LunaCore - passkey pairing on the host's own screen (main, host mode)
// ----------------------------------------------------------------------------
// docs/REMOTE_HOST_PLAN.md, "Passkey + session key". The phone
// (mobile/src/views/pair.js) creates a passkey and offers its public key to
// this host through `host_pairings`, commit-reveal (src/hostcanon.js):
//
//   pending row, no host_nonce   the host snapshots {credentialId, publicKey,
//                                commitment} and writes a random host_nonce
//   phone_nonce arrives          checked against the snapshot's commitment;
//                                the code from the snapshot + both nonces is
//                                shown in a dialog on this machine
//   Mati confirms                only now the key goes into
//                                host-keys.local.json; the row says confirmed
//
// The host acts only on its in-memory snapshot, never on key fields read from
// the row later, and only while the pairing window is open (first run, or the
// tray's "Pair a phone"). A row edited after the snapshot fails the commitment
// or shows a code that doesn't match the phone's. Keys are never re-read from
// the cloud. "Forget all phones" empties the file: hostauth.js re-checks the
// file on every command, so live grants die with it.
// ============================================================================

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const canon = require('./hostcanon');

const WINDOW_MS = 10 * 60 * 1000;
const POLL_MS = 3000;
/** A request older than this is never shown. */
const MAX_AGE_MS = WINDOW_MS;
const BATCH = 10;
/** hostauth.js MAX_KEYS. */
const MAX_KEYS = 32;
const HOST_NONCE_BYTES = 16;
const B64U_RE = /^[A-Za-z0-9_-]+$/;
const NONCE_RE = /^[A-Za-z0-9_-]{22,64}$/;
const COMMIT_RE = /^[A-Za-z0-9_-]{43}$/;
const LABEL_RE = /^[\p{L}\p{N} ._'-]{1,64}$/u;
const COLUMNS = 'id,host,label,credential_id,public_key,commitment,host_nonce,phone_nonce,status,created_at';

const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const sha256 = (data) => crypto.createHash('sha256').update(data).digest();
const errText = (err) => String(err instanceof Error ? err.message : err).slice(0, 300);

/** A P-256 SPKI public key, base64url, or false. */
function isP256Spki(b64u) {
  if (typeof b64u !== 'string' || b64u.length < 64 || b64u.length > 400 || !B64U_RE.test(b64u)) return false;
  try {
    const key = crypto.createPublicKey({ key: Buffer.from(b64u, 'base64url'), format: 'der', type: 'spki' });
    return key.asymmetricKeyType === 'ec' && key.asymmetricKeyDetails?.namedCurve === 'prime256v1';
  } catch {
    return false;
  }
}

/** base64url(sha256(canonicalCommit)): what the phone sends first. */
const commitmentOf = (req) => sha256(canon.canonicalCommit(req)).toString('base64url');

/** The 6 digits both screens show. */
const pairingCodeFor = (req) => canon.pairingCode(sha256(canon.canonicalPairing(req)));

/** A raw row -> the request the host may snapshot, or null. */
function parseRequest(row, host) {
  if (!isObject(row) || typeof row.id !== 'string' || !row.id || row.id.length > 64 || row.host !== host) return null;
  const credentialId = row.credential_id;
  if (typeof credentialId !== 'string' || credentialId.length < 16 || credentialId.length > 1400 || !B64U_RE.test(credentialId)) return null;
  if (!isP256Spki(row.public_key) || typeof row.commitment !== 'string' || !COMMIT_RE.test(row.commitment)) return null;
  const label = typeof row.label === 'string' && LABEL_RE.test(row.label) ? row.label : 'iPhone';
  return { id: row.id, credentialId, publicKey: row.public_key, commitment: row.commitment, label };
}

// ---- host-keys.local.json ---------------------------------------------------

function writeAtomic(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data) + '\n', { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** The paired keys; a missing file is none. Throws on a file that exists but is broken. */
function readPairedKeys(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const data = JSON.parse(text);
  if (!isObject(data) || !Array.isArray(data.keys)) throw new Error('host keys malformed');
  return data.keys.filter(isObject);
}

/** Whether a phone is paired. A broken file counts as none (setup shows again). */
function hasPairedPhone(file) {
  try {
    return readPairedKeys(file).length > 0;
  } catch {
    return false;
  }
}

/** Adds one confirmed key (replacing the same credential). Throws when it can't be stored. */
function addKey(file, { credentialId, publicKey, label }, now = Date.now()) {
  const keys = readPairedKeys(file).filter((k) => k.credentialId !== credentialId);
  if (keys.length >= MAX_KEYS) throw new Error('too many paired phones');
  writeAtomic(file, { v: 1, keys: [...keys, { credentialId, publicKey, signCount: 0, label, pairedAt: now }] });
}

/** "Forget all phones": no key left, so no grant verifies any more. */
function forgetAll(file) {
  writeAtomic(file, { v: 1, keys: [] });
}

// ---- the pairing loop -----------------------------------------------------------

/**
 * @param {{
 *   client: object,                       logged-in supabase-js client (or a fake)
 *   host: string,                         this machine's name
 *   keysPath: string,                     host-keys.local.json
 *   confirm: (req: {code: string, label: string}) => Promise<boolean>,  the dialog
 *   onPaired?: () => void,
 *   now?: () => number, random?: (n: number) => Buffer,
 *   setTimer?: Function, clearTimer?: Function, log?: (line: string) => void,
 * }} deps
 */
function createHostPairing({
  client,
  host,
  keysPath,
  confirm,
  onPaired = () => {},
  now = Date.now,
  random = (n) => crypto.randomBytes(n),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  log = (line) => console.error(line),
}) {
  /** row id -> snapshot taken when this host challenged it. */
  const challenged = new Map();
  let openUntil = 0;
  let timer = null;
  let running = null;

  const isOpen = () => openUntil > now();

  async function setStatus(id, status) {
    const { error } = await client.from('host_pairings').update({ status }).eq('id', id).eq('status', 'pending');
    if (error) log(`[hostpairing] ${id}: writing ${status} failed: ${error.code || 'error'}`);
  }

  async function challenge(row) {
    const req = parseRequest(row, host);
    if (!req) {
      log(`[hostpairing] malformed request ${typeof row?.id === 'string' ? row.id.slice(0, 64) : '?'}`);
      if (typeof row?.id === 'string') await setStatus(row.id, 'rejected');
      return;
    }
    const hostNonce = random(HOST_NONCE_BYTES).toString('base64url');
    const { data, error } = await client
      .from('host_pairings')
      .update({ host_nonce: hostNonce })
      .eq('id', req.id)
      .eq('status', 'pending')
      .is('host_nonce', null)
      .select('id');
    if (error || !Array.isArray(data) || data.length !== 1) return;
    challenged.set(req.id, { ...req, hostNonce });
  }

  async function reveal(row, snap) {
    challenged.delete(snap.id);
    const phoneNonce = row.phone_nonce;
    const intact =
      row.host_nonce === snap.hostNonce &&
      typeof phoneNonce === 'string' &&
      NONCE_RE.test(phoneNonce) &&
      commitmentOf({ host, credentialId: snap.credentialId, publicKey: snap.publicKey, phoneNonce }) === snap.commitment;
    if (!intact) {
      log(`[hostpairing] ${snap.id}: reveal does not match the commitment, refused`);
      return setStatus(snap.id, 'rejected');
    }
    const code = pairingCodeFor({ host, credentialId: snap.credentialId, publicKey: snap.publicKey, hostNonce: snap.hostNonce, phoneNonce });
    let ok = false;
    try {
      ok = (await confirm({ code, label: snap.label })) === true;
    } catch (err) {
      log(`[hostpairing] confirm dialog failed: ${errText(err)}`);
    }
    if (!ok) return setStatus(snap.id, 'rejected');
    try {
      addKey(keysPath, snap, now());
    } catch (err) {
      log(`[hostpairing] storing the key failed: ${errText(err)}`);
      return setStatus(snap.id, 'rejected');
    }
    log(`[hostpairing] paired ${snap.label}`);
    await setStatus(snap.id, 'confirmed');
    openUntil = 0;
    onPaired();
  }

  async function readOnce() {
    const { data, error } = await client
      .from('host_pairings')
      .select(COLUMNS)
      .eq('host', host)
      .eq('status', 'pending')
      .gt('created_at', new Date(now() - MAX_AGE_MS).toISOString())
      .order('created_at', { ascending: true })
      .limit(BATCH);
    if (error || !Array.isArray(data)) {
      log(`[hostpairing] read failed: ${(error && error.code) || 'error'}`);
      return;
    }
    // One dialog at a time, in arrival order.
    for (const row of data) {
      if (!isOpen()) return;
      if (!isObject(row) || typeof row.id !== 'string') continue;
      const snap = challenged.get(row.id);
      if (snap) {
        if (row.phone_nonce) await reveal(row, snap);
      } else if (row.host_nonce === null || row.host_nonce === undefined) {
        await challenge(row);
      }
      // A row challenged by an earlier run (or someone else) is left alone.
    }
  }

  /** One read at a time; never rejects. */
  function read() {
    if (!isOpen()) return Promise.resolve();
    if (!running) {
      running = readOnce()
        .catch((err) => log(`[hostpairing] read crashed: ${errText(err)}`))
        .finally(() => (running = null));
    }
    return running;
  }

  function schedule() {
    clearTimer(timer);
    timer = setTimer(async () => {
      timer = null;
      if (!isOpen()) return close();
      await read();
      if (isOpen()) schedule();
    }, POLL_MS);
  }

  function close() {
    openUntil = 0;
    clearTimer(timer);
    timer = null;
    challenged.clear();
  }

  return {
    /** Opens (or extends) the pairing window. */
    open() {
      openUntil = now() + WINDOW_MS;
      log('[hostpairing] pairing window open (10 min)');
      read();
      schedule();
    },
    close,
    isOpen,
    read,
  };
}

module.exports = {
  createHostPairing,
  parseRequest,
  commitmentOf,
  pairingCodeFor,
  readPairedKeys,
  hasPairedPhone,
  addKey,
  forgetAll,
  WINDOW_MS,
};
