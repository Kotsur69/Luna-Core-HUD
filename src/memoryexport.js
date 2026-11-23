// ============================================================================
// LunaCore - "Export all": every memory copied to a backup folder (main + CLI)
// ----------------------------------------------------------------------------
// The memory window's "Export all" button (memory:export in src/memoryipc.js,
// the folder picked in main's own dialog) and `luna memory export <dir>`
// (scripts/luna.js, LunaCore closed) both call exportAll():
//
//   <destDir>/lunacore-memory-backup-YYYY-MM-DD/
//     global/<id>.md
//     projects/<host>/<owner>/<repo>/<id>.md
//     projects/<host>/<owner>/<repo>/_where-we-stopped.md
//     export-manifest.json   {kind, version, date, exportedAt, counts, skipped}
//
// Only plain files of the mirror that parse are copied (memorystore.scan,
// memorynote.scanNotes; a symlink is not), byte for byte as they are on disk;
// the bytes copied are the bytes checked. Each one is checked again with the
// sync's secret guard (memorysync.hasSecret), on the parsed record and on its
// raw text: a file that trips it is skipped and listed in the manifest, never
// copied. Files that do not parse are listed as skipped too.
//
// A folder of that name that already exists is never written into: the next
// free name (-2, -3, ...) is taken. Refused targets: a memory folder that does
// not exist, a target that is not an existing absolute folder, a path with a
// `..` segment, and a target inside the memory folder (the backup would back
// itself up on the next run). No Electron here.
// ============================================================================

'use strict';

const fs = require('fs');
const path = require('path');
const { scan, fileFor } = require('./memorystore');
const { scanNotes, noteFile } = require('./memorynote');
const { hasSecret } = require('./memorysync');
const { GLOBAL, splitKey, recordFromFile } = require('./memoryrecord');

const BACKUP_PREFIX = 'lunacore-memory-backup-';
const MANIFEST_FILE = 'export-manifest.json';
const MANIFEST_KIND = 'lunacore-memory-backup';
const MANIFEST_VERSION = 1;
/** Free names tried after the plain one (-2 ... -MAX_NAME_TRIES). */
const MAX_NAME_TRIES = 99;
/** Larger than any valid memory or note file (memorystore MAX_FILE_BYTES). */
const MAX_FILE_BYTES = 64 * 1024;
/** Skipped files the manifest and the result name; the count says how many there were. */
const MAX_SKIPPED_LISTED = 500;

const errText = (err) => (err && (err.code || err.message)) || 'error';
const isoDate = (ms) => new Date(ms).toISOString().slice(0, 10);
const refuse = (reason) => ({ ok: false, reason });
/** A path relative to the memory folder, with forward slashes (the manifest is read on any OS). */
const relOf = (dir, file) => path.relative(dir, file).split(path.sep).join('/');

/** Whether `p` is an existing folder (symlinks followed). */
function isFolder(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch (err) {
    if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) return false;
    throw err;
  }
}

/** Whether `child` is `parent` or lies inside it, both real paths. */
function within(parent, child) {
  const rel = path.relative(parent, child);
  // A child named '..x' is inside; only '..' itself or a '../' prefix leaves.
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/**
 * Why a target is refused, or null when it is fine.
 * @param {unknown} dir the memory folder
 * @param {unknown} destDir the folder the backup goes into
 * @returns {string|null}
 */
function targetRefusal(dir, destDir) {
  if (typeof dir !== 'string' || !dir || !isFolder(dir)) return 'no-memory-dir';
  if (typeof destDir !== 'string' || !destDir || !path.isAbsolute(destDir)) return 'bad-target';
  if (destDir.split(/[\\/]+/).includes('..')) return 'bad-target';
  if (!isFolder(destDir)) return 'target-missing';
  if (within(fs.realpathSync(dir), fs.realpathSync(destDir))) return 'inside-memory-dir';
  return null;
}

/** Makes the backup folder under destDir: the first free name. */
function makeBackupFolder(destDir, date) {
  const base = `${BACKUP_PREFIX}${date}`;
  for (let n = 1; n <= MAX_NAME_TRIES; n++) {
    const folder = path.join(destDir, n === 1 ? base : `${base}-${n}`);
    try {
      fs.mkdirSync(folder);
      return folder;
    } catch (err) {
      if (!err || err.code !== 'EEXIST') throw err;
    }
  }
  return null;
}

/**
 * A file's text, or null when it is no plain file of the mirror: a symlink, a
 * path whose real location is outside the mirror, or too big to be a memory.
 */
function readSmall(realDir, file) {
  let st;
  try {
    st = fs.lstatSync(file);
  } catch (err) {
    // Deleted since the scan (a sync, an approval): listed as skipped, the rest still exports.
    if (err && err.code === 'ENOENT') return null;
    throw err;
  }
  if (!st.isFile() || st.size > MAX_FILE_BYTES) return null;
  if (!within(realDir, fs.realpathSync(file))) return null;
  return fs.readFileSync(file, 'utf8');
}

/** Writes one copied file under the backup folder; never overwrites, never leaves it. */
function writeCopy(folder, rel, text) {
  const target = path.join(folder, ...rel.split('/'));
  if (!within(folder, target)) throw new Error('copy outside the backup folder');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, text, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
}

/**
 * What to copy: each valid memory and note as {rel, text}, and what is skipped.
 * @returns {{copies: {rel: string, text: string, kind: 'memory'|'note', project: string}[],
 *   skipped: {file: string, reason: 'secret'|'invalid'}[]}}
 */
function collect(dir) {
  const copies = [];
  const skipped = [];
  const realDir = fs.realpathSync(dir);
  const { records, invalid } = scan(dir);
  for (const [key] of records) {
    const file = fileFor(dir, key);
    const { project, id } = splitKey(key);
    const text = readSmall(realDir, file);
    // The bytes copied are parsed and checked again: the file may have changed since the scan.
    const parsed = text === null ? {} : recordFromFile(text, { project, id });
    if (!parsed.record) skipped.push({ file: relOf(dir, file), reason: 'invalid' });
    // The parsed record, and the raw text too: a frontmatter field the parser drops is still copied.
    else if (hasSecret(parsed.record) || hasSecret({ text })) skipped.push({ file: relOf(dir, file), reason: 'secret' });
    else copies.push({ rel: relOf(dir, file), text, kind: 'memory', project });
  }
  const notes = scanNotes(dir);
  for (const [, note] of notes.notes) {
    const file = noteFile(dir, note.project);
    const text = readSmall(realDir, file);
    if (text === null) skipped.push({ file: relOf(dir, file), reason: 'invalid' });
    else if (hasSecret({ text })) skipped.push({ file: relOf(dir, file), reason: 'secret' });
    else copies.push({ rel: relOf(dir, file), text, kind: 'note', project: note.project });
  }
  for (const bad of [...invalid, ...notes.invalid]) skipped.push({ file: relOf(dir, bad.file), reason: 'invalid' });
  return { copies, skipped };
}

/**
 * Copies every valid memory and "where we stopped" note to a new backup folder.
 * @param {{dir: string, destDir: string, now?: number}} opts dir = the memory mirror
 *   (memorysync.memoryPaths().dir); destDir = an existing absolute folder; now = ms
 * @returns {{ok: true, folder: string, name: string, files: number, memories: number, notes: number,
 *   projects: number, skipped: {file: string, reason: string}[], skippedCount: number}
 *   |{ok: false, reason: 'no-memory-dir'|'bad-target'|'target-missing'|'inside-memory-dir'|'name-taken'|'failed'}}
 */
function exportAll({ dir, destDir, now = Date.now() } = {}) {
  let refusal;
  try {
    refusal = targetRefusal(dir, destDir);
  } catch (err) {
    console.error('[memory] export target unreadable:', errText(err));
    return refuse('failed');
  }
  if (refusal) return refuse(refusal);
  const at = Number.isFinite(now) ? now : Date.now();
  const date = isoDate(at);
  try {
    const { copies, skipped } = collect(dir);
    const folder = makeBackupFolder(destDir, date);
    if (!folder) return refuse('name-taken');
    for (const c of copies) writeCopy(folder, c.rel, c.text);
    const memories = copies.filter((c) => c.kind === 'memory');
    const counts = {
      memories: memories.length,
      global: memories.filter((c) => c.project === GLOBAL).length,
      notes: copies.length - memories.length,
      projects: new Set(copies.map((c) => c.project).filter((p) => p !== GLOBAL)).size,
      skipped: skipped.length,
    };
    const listed = skipped.slice(0, MAX_SKIPPED_LISTED);
    const manifest = { kind: MANIFEST_KIND, version: MANIFEST_VERSION, date, exportedAt: new Date(at).toISOString(), counts, skipped: listed };
    fs.writeFileSync(path.join(folder, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    return {
      ok: true,
      folder,
      name: path.basename(folder),
      files: copies.length,
      memories: counts.memories,
      notes: counts.notes,
      projects: counts.projects,
      skipped: listed,
      skippedCount: skipped.length,
    };
  } catch (err) {
    console.error('[memory] export failed:', errText(err));
    return refuse('failed');
  }
}

module.exports = { exportAll, targetRefusal, BACKUP_PREFIX, MANIFEST_FILE, MANIFEST_KIND };
