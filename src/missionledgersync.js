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
//   ], blocks:[
//     [startMs, endMs, projectKey, projectName]      <- focus time (missionfocus.js)
//   ]}
//
// Only token counts per hour/project/model and when work happened per project
// leave this PC - never prompts, code, paths or transcript text. `blocks` is
// optional (files from before it read as none). LunaCore does no networking here.
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
const MAX_BLOCKS = 10000;
/** One focus block cannot be longer than this (a reply every < 10 min for 2 days). */
const MAX_BLOCK_MS = 2 * DAY_MS;
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

/** A peer focus block, or null when any field is off. */
function validBlock(b, now) {
  if (!Array.isArray(b) || b.length !== 4) return null;
  const [start, end, key, name] = b;
  if (!Number.isInteger(start) || !Number.isInteger(end) || end <= start || end - start > MAX_BLOCK_MS) return null;
  if (start < now - HISTORY_DAYS * DAY_MS - DAY_MS || end > now + DAY_MS) return null;
  if (typeof key !== 'string' || !KEY_RE.test(key)) return null;
  if (typeof name !== 'string' || !NAME_RE.test(name)) return null;
  return [start, end, key, name];
}

/**
 * Writes JSON into the shared folder: tmp file + rename, so a sync tool never
 * sees half a file. Random name + 'wx': anyone who can write to the synced
 * folder could plant a symlink at a guessable temp name; 'wx' fails instead
 * of following it.
 */
function writeSharedJson(file, data) {
  const tmp = `${file}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(data), { encoding: 'utf8', flag: 'wx' });
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

/** A regular (non-link) file of at most maxBytes, parsed as JSON; null otherwise. */
function readSharedJson(file, maxBytes = MAX_FILE_BYTES) {
  let st;
  try {
    st = fs.lstatSync(file);
  } catch {
    return null;
  }
  if (!st.isFile() || st.size > maxBytes) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** Writes this PC's rows, plus its focus blocks when given. */
function writeOwn(dir, machine, rows, now = Date.now(), blocks) {
  if (!MACHINE_RE.test(machine)) throw new Error('bad machine name');
  const body = { v: VERSION, machine, updatedAt: now, rows };
  writeSharedJson(path.join(dir, `ledger-${machine}.json`), Array.isArray(blocks) ? { ...body, blocks } : body);
}

/** One peer file -> {machine, updatedAt, rows, blocks} or null. */
function readPeer(file, machine, now) {
  const data = readSharedJson(file);
  if (!data || data.v !== VERSION || data.machine !== machine || !Array.isArray(data.rows)) return null;
  const updatedAt = Number.isFinite(data.updatedAt) ? data.updatedAt : 0;
  const keys = new Set();
  // A peer flooding distinct projects would otherwise reach the renderer;
  // rows and blocks draw on one key budget.
  const admit = (key) => {
    if (!keys.has(key) && keys.size >= MAX_PEER_KEYS) return false;
    keys.add(key);
    return true;
  };
  const rows = [];
  for (const raw of data.rows.slice(0, MAX_ROWS)) {
    const r = validRow(raw, now);
    if (r && admit(r[1])) rows.push(r);
  }
  const blocks = [];
  for (const raw of Array.isArray(data.blocks) ? data.blocks.slice(0, MAX_BLOCKS) : []) {
    const b = validBlock(raw, now);
    if (b && admit(b[2])) blocks.push(b);
  }
  return { machine, updatedAt, rows, blocks };
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

module.exports = {
  machineName,
  writeOwn,
  readPeers,
  validRow,
  validBlock,
  validKey,
  writeSharedJson,
  readSharedJson,
  MACHINE_RE,
  MAX_PEERS,
  MAX_PEER_KEYS,
  MAX_FILE_BYTES,
};
