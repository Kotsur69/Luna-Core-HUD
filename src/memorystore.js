// ============================================================================
// LunaCore - the local memory mirror: markdown files on this PC (main + CLI)
// ----------------------------------------------------------------------------
// docs/untouched_docs/rag-stylememory.md, decision 8. Every memory is a file a
// person can open and edit:
//
//   <dir>/global/<id>.md
//   <dir>/projects/<host>/<owner>/<repo>/<id>.md
//
// The files are the truth on this PC. The cloud's `memory` scope carries them
// between PCs through createMemoryProvider(), a configsync.js provider: each
// sync diffs the files against the last snapshot, so an edit made in any
// editor is stamped and pushed like every other local change.
//
// A file that does not parse stops the sync (read() throws) instead of being
// skipped: a skipped file would look deleted, and the delete would travel to
// the other PCs. The broken files are reported through onInvalid.
//
// No Electron here: scripts/luna.js uses the same functions with the app closed.
// ============================================================================

'use strict';

const fs = require('fs');
const path = require('path');
const { GLOBAL, keyOf, splitKey, validProject, normalizeRecord, recordFromFile, serializeRecord } = require('./memoryrecord');
const { fingerprint } = require('./todosync');

const EXT = '.md';
/**
 * A file whose name starts with this is LunaCore's own per-project file (the
 * "where we stopped" note, src/memorynote.js), never a memory: no memory id
 * can start with it, so scan() leaves it out instead of listing it as ignored.
 */
const RESERVED_PREFIX = '_';
const MAX_FILE_BYTES = 64 * 1024;
/** projects/<host>/<owner>/<...>/<repo>: deeper than a project can be is not walked. */
const MAX_DEPTH = 9;

/** The mirror file of a unit key; throws on a key that is not one. */
function fileFor(dir, key) {
  const split = splitKey(key);
  if (!split) throw new Error('bad memory key');
  const { project, id } = split;
  return project === GLOBAL ? path.join(dir, GLOBAL, id + EXT) : path.join(dir, 'projects', ...project.split('/'), id + EXT);
}

function readEntries(folder) {
  try {
    return fs.readdirSync(folder, { withFileTypes: true });
  } catch (err) {
    if (err && err.code === 'ENOENT') return [];
    throw err;
  }
}

/** Every `.md` under `folder`, as [file, relative directory segments]. */
function walk(folder, segments = []) {
  const out = [];
  for (const entry of readEntries(folder)) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(folder, entry.name);
    if (entry.isDirectory()) {
      if (segments.length < MAX_DEPTH) out.push(...walk(full, [...segments, entry.name]));
    } else if (entry.isFile() && entry.name.endsWith(EXT)) {
      out.push([full, segments]);
    }
  }
  return out;
}

/** @returns {{record: object, mtime: number}|{error: string}|{ignored: true}} */
function readOne(file, project) {
  const id = path.basename(file, EXT);
  // README.md, Notes.md, a file in a folder that is no project: never a memory.
  if (!validProject(project) || !splitKey(`${project}/${id}`)) return { ignored: true };
  const stat = fs.statSync(file);
  if (stat.size > MAX_FILE_BYTES) return { error: 'file-too-big' };
  const res = recordFromFile(fs.readFileSync(file, 'utf8'), { project, id });
  return res.record ? { record: res.record, mtime: Math.floor(stat.mtimeMs) } : res;
}

/**
 * Reads the whole mirror.
 * @param {string} dir
 * @returns {{exists: boolean, records: [string, object][], invalid: {file: string, error: string}[],
 *   ignored: string[], mtimes: object}}
 *   records sorted by key; invalid = memory files that do not parse as they
 *   stand (they pause the sync); ignored = `.md` files that are no memory by
 *   name or place; mtimes = {<key>: the file's change time, ms}
 */
function scan(dir) {
  const exists = fs.existsSync(dir);
  const files = [
    ...walk(path.join(dir, GLOBAL)).map(([file, segs]) => [file, segs.length ? null : GLOBAL]),
    ...walk(path.join(dir, 'projects')).map(([file, segs]) => [file, segs.join('/')]),
  ];
  const records = [];
  const invalid = [];
  const ignored = [];
  const mtimes = {};
  for (const [file, project] of files) {
    if (path.basename(file).startsWith(RESERVED_PREFIX)) continue;
    let res;
    try {
      res = readOne(file, project);
    } catch (err) {
      res = { error: (err && err.code) || 'unreadable' };
    }
    if (res.record) {
      records.push([keyOf(res.record), res.record]);
      mtimes[keyOf(res.record)] = res.mtime;
    } else if (res.ignored) ignored.push(file);
    else invalid.push({ file, error: res.error });
  }
  records.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return { exists, records, invalid, ignored, mtimes };
}

/** Writes one memory to its file (atomic). The record must be valid. */
function writeRecord(dir, raw) {
  const record = normalizeRecord(raw);
  if (!record) throw new Error('invalid memory record');
  const file = fileFor(dir, keyOf(record));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  try {
    fs.writeFileSync(tmp, serializeRecord(record), 'utf8');
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
  return file;
}

function removeRecord(dir, key) {
  fs.rmSync(fileFor(dir, key), { force: true });
}

/**
 * The mirror as a configsync.js provider for the cloud's `memory` scope.
 * @param {string} dir
 * @param {{onInvalid?: (invalid: {file, error}[]) => void}} [opts] called on
 *   every read with the files that block the sync (empty when all is well)
 */
function createMemoryProvider(dir, { onInvalid = () => {} } = {}) {
  return {
    name: 'memory',
    owns: (k) => splitKey(k) !== null,
    valid(k, v) {
      const record = normalizeRecord(v);
      return record && keyOf(record) === k ? record : null;
    },
    read() {
      const { exists, records, invalid, mtimes } = scan(dir);
      onInvalid(invalid);
      if (invalid.length) throw new Error(`${invalid.length} memory file(s) do not parse`);
      // First sync on this PC: each file counts as changed when it was last
      // written (`stamps`), so the newer copy wins on either PC and a delete
      // made elsewhere only removes a file older than it. A missing folder is
      // a fresh PC, never "everything was deleted".
      return { units: records, base: 0, stamps: mtimes, fresh: !exists };
    },
    write(units, local) {
      const before = new Map(local.units.map(([k, v]) => [k, fingerprint(v)]));
      const keep = new Set();
      for (const [k, v] of units) {
        keep.add(k);
        if (before.get(k) !== fingerprint(v)) writeRecord(dir, v);
      }
      for (const k of before.keys()) if (!keep.has(k)) removeRecord(dir, k);
    },
  };
}

module.exports = { fileFor, scan, walk, writeRecord, removeRecord, createMemoryProvider, RESERVED_PREFIX };
