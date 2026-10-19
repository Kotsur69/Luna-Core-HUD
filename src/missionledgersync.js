// ============================================================================
// LunaCore - Mission Control: the Claude ledger shared between PCs (main)
// ----------------------------------------------------------------------------
// All of Mati's PCs share ONE Claude account and so one weekly limit; each PC
// only sees its own transcripts. So every PC puts its own aggregates in its
// `ledger` cloud snapshot (missionledgerservice.js) and reads the other PCs':
//
//   {v:1, machine, rows:[
//     [hourEpochMs, projectKey, projectName, model, input, cacheWrite, cacheRead, output]
//   ], blocks:[
//     [startMs, endMs, projectKey, projectName]      <- focus time (missionfocus.js)
//   ]}
//
// Only token counts per hour/project/model and when work happened per project
// leave this PC - never prompts, code, paths or transcript text. `blocks` is
// optional (bodies without it read as none).
//
// Trust boundary: a peer body is written by another machine, so it is
// untrusted input. Version, count, and every row field are checked; anything
// off is dropped, never thrown. Also home of the shared machine-name and
// project-key checks the other sync modules use.
// ============================================================================

'use strict';

const VERSION = 1;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const HISTORY_DAYS = 14;
const MAX_ROWS = 50000;
const MAX_BLOCKS = 10000;
/** One focus block cannot be longer than this (a reply every < 10 min for 2 days). */
const MAX_BLOCK_MS = 2 * DAY_MS;
const MAX_PEERS = 8;
/** Distinct projects one peer may report - same cap as missionprojects.js. */
const MAX_PEER_KEYS = 500;
const MAX_TOKENS = 1e12;
const MACHINE_RE = /^[A-Za-z0-9-]{1,63}$/;
const KEY_RE = /^(other|git:[a-z0-9.-]+(\/[a-z0-9._-]+)+|local:[^\u0000-\u001f\u007f]{1,100})$/;
const NAME_RE = /^[^\u0000-\u001f\u007f]{1,100}$/;
const MODEL_RE = /^[A-Za-z0-9._-]{1,80}$/;

/** os.hostname() -> a safe machine name (letters, digits, '-'). */
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
 * A parsed peer body (a cloud snapshot) -> {machine,
 * updatedAt, rows, blocks} or null. `machine` is who it must claim to be.
 */
function parsePeer(data, machine, now) {
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

/** A project key as missionrepokey.js produces it ("other", "git:...", "local:..."). */
const validKey = (key) => typeof key === 'string' && KEY_RE.test(key);

module.exports = {
  machineName,
  parsePeer,
  validRow,
  validBlock,
  validKey,
  MACHINE_RE,
  MAX_PEERS,
  MAX_PEER_KEYS,
};
