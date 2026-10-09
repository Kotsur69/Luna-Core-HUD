// ============================================================================
// LunaCore - Mission Control: share the Claude ledger between PCs (main)
// ----------------------------------------------------------------------------
// All of Mati's PCs share ONE Claude account and so one weekly limit; each PC
// only sees its own transcripts. So every PC writes its own aggregates to a
// shared folder that some file-sync tool (Syncthing, ...) mirrors, and reads
// the other PCs' files from it:
//
//   <dir>/ledger-<machine>.json = {v:1, machine, updatedAt, rows:[
//     [hourEpochMs, projectKey, projectName, model, input, cacheWrite, cacheRead, output]
//   ]}
//
// Only token counts per hour/project/model leave this PC - never prompts,
// code, paths or transcript text. LunaCore itself does no networking here.
//
// Trust boundary: a peer file is written by another machine and moved by a
// sync tool, so it is untrusted input. Name pattern, size, count, version and
// every row field are checked; anything off is dropped, never thrown.
// ============================================================================

'use strict';

const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

const VERSION = 1;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const HISTORY_DAYS = 14;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_ROWS = 50000;
const MAX_PEERS = 8;
/** Distinct projects one peer may report - same cap as missionprojects.js. */
const MAX_PEER_KEYS = 500;
const MAX_TOKENS = 1e12;
const MACHINE_RE = /^[A-Za-z0-9-]{1,63}$/;
const FILE_RE = /^ledger-([A-Za-z0-9-]{1,63})\.json$/;
const KEY_RE = /^(other|git:[a-z0-9.-]+(\/[a-z0-9._-]+)+|local:[^\u0000-\u001f\u007f]{1,100})$/;
const NAME_RE = /^[^\u0000-\u001f\u007f]{1,100}$/;
const MODEL_RE = /^[A-Za-z0-9._-]{1,80}$/;

/** os.hostname() -> a safe file-name part. */
function machineName(host) {
  const clean = String(host || '')
    .replace(/[^A-Za-z0-9-]/g, '-')
    .slice(0, 63);
  return clean || 'pc';
}

const isCount = (v) => Number.isInteger(v) && v >= 0 && v <= MAX_TOKENS;

/** A peer row, or null when any field is off. */
function validRow(r, now) {
  if (!Array.isArray(r) || r.length !== 8) return null;
  const [hour, key, name, model, ...tokens] = r;
  if (!Number.isInteger(hour) || hour % HOUR_MS !== 0) return null;
  if (hour < now - HISTORY_DAYS * DAY_MS - HOUR_MS || hour > now + DAY_MS) return null;
  if (typeof key !== 'string' || !KEY_RE.test(key)) return null;
  if (typeof name !== 'string' || !NAME_RE.test(name)) return null;
  if (typeof model !== 'string' || !MODEL_RE.test(model)) return null;
  if (!tokens.every(isCount)) return null;
  return [hour, key, name, model, ...tokens];
}

/** Writes this PC's rows (tmp file + rename, so a sync never sees half a file). */
function writeOwn(dir, machine, rows, now = Date.now()) {
  if (!MACHINE_RE.test(machine)) throw new Error('bad machine name');
  const file = path.join(dir, `ledger-${machine}.json`);
  // Random name + 'wx': anyone who can write to the synced folder could plant a
  // symlink at a guessable temp name; 'wx' fails instead of following it.
  const tmp = `${file}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify({ v: VERSION, machine, updatedAt: now, rows }), { encoding: 'utf8', flag: 'wx' });
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

/** One peer file -> {machine, updatedAt, rows} or null. */
function readPeer(file, machine, now) {
  let st;
  try {
    st = fs.lstatSync(file);
  } catch {
    return null;
  }
  if (!st.isFile() || st.size > MAX_FILE_BYTES) return null;
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
  if (!data || data.v !== VERSION || data.machine !== machine || !Array.isArray(data.rows)) return null;
  const updatedAt = Number.isFinite(data.updatedAt) ? data.updatedAt : 0;
  const rows = [];
  const keys = new Set();
  for (const raw of data.rows.slice(0, MAX_ROWS)) {
    const r = validRow(raw, now);
    if (!r) continue;
    // A peer flooding distinct projects would otherwise reach the renderer.
    if (!keys.has(r[1]) && keys.size >= MAX_PEER_KEYS) continue;
    keys.add(r[1]);
    rows.push(r);
  }
  return { machine, updatedAt, rows };
}

/** Every other PC's file in `dir`; a missing folder is an empty list. */
function readPeers(dir, ownMachine, now = Date.now()) {
  if (typeof dir !== 'string' || !dir) return [];
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const peers = [];
  for (const name of names.sort()) {
    const m = FILE_RE.exec(name);
    // Windows file names are case-insensitive: "home" is our own "HOME" file.
    if (!m || m[1].toLowerCase() === String(ownMachine).toLowerCase()) continue;
    const peer = readPeer(path.join(dir, name), m[1], now);
    if (peer) peers.push(peer);
    if (peers.length >= MAX_PEERS) break;
  }
  return peers;
}

/** A project key as missionrepokey.js produces it ("other", "git:...", "local:..."). */
const validKey = (key) => typeof key === 'string' && KEY_RE.test(key);

module.exports = { machineName, writeOwn, readPeers, validRow, validKey, MAX_PEERS, MAX_PEER_KEYS, MAX_FILE_BYTES };
