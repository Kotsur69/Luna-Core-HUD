// ============================================================================
// LunaCore - the project list as cloud units (main)
// ----------------------------------------------------------------------------
// A provider for src/configsync.js: the projects switcher's list (projects.js,
// base projects.json + projects.local.json) as one unit per project:
//
//   proj:entry:<id> = {label, path}     path under the home dir -> "~/..."
//
// A PC adds the projects it lacks and drops the ones another PC deleted, but
// a project it already has keeps its own path and label: the same repo may
// live in another folder here. Ids in removedIds are tombstones on the first
// sync, so a default deleted long ago is not brought back by a fresh PC.
//
// Cloud values are untrusted: a path becomes a terminal's working directory,
// so only "~", "~/..." and absolute local paths pass (no UNC shares).
// ============================================================================

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { mergeProjects } = require('./projects');
const { hasText, normalizeText } = require('./localized');

const PREFIX = 'proj:entry:';
const ID_RE = /^[A-Za-z0-9._-]{1,80}$/;
const MAX_LABEL = 300; // JSON length, a localized {pl, en} label included
const MAX_PATH = 1000;
/** Arrivals stop here: a hostile peer cannot flood the switcher (or the to-do sync). */
const MAX_PROJECTS = 200;
const DAY_MS = 24 * 60 * 60 * 1000;
/** A removedIds tombstone is at least this recent, so the merge's 90-day TTL keeps it. */
const SEED_WINDOW_MS = 30 * DAY_MS;
const isPlainObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
/** '__proto__', 'constructor'... pass the pattern but are no project ids. */
const validId = (id) => typeof id === 'string' && ID_RE.test(id) && id !== '__proto__' && !Object.hasOwn(Object.prototype, id);
const sameDir =(a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);

/** An absolute path under the home dir -> "~" / "~/a/b"; anything else unchanged. */
function portablePath(p, home = os.homedir()) {
  if (sameDir(p, home)) return '~';
  const prefix = home.endsWith(path.sep) ? home : home + path.sep;
  if (p.length > prefix.length && sameDir(p.slice(0, prefix.length), prefix)) {
    return '~/' + p.slice(prefix.length).split(path.sep).join('/');
  }
  return p;
}

/**
 * Only "~", "~/..." (or "~\..."), a drive path "C:\..." or a plain POSIX "/x".
 * Everything else that Windows treats as absolute - UNC shares (\\host\share),
 * device paths (\??\UNC\..., \\.\...) - could reach the network (NTLM) and is
 * never a working directory from the cloud.
 */
function validPath(p) {
  if (typeof p !== 'string' || !p || p.length > MAX_PATH || p.includes('\0')) return false;
  return p === '~' || /^~[\\/]/.test(p) || /^[A-Za-z]:[\\/]/.test(p) || /^\/(?![\\/?.])/.test(p);
}

/** A cloud value -> {label, path}, or null. */
function validEntry(v) {
  if (!isPlainObject(v) || !hasText(v.label) || !validPath(v.path)) return null;
  const label = normalizeText(v.label);
  if (JSON.stringify(label).length > MAX_LABEL) return null;
  return { label, path: v.path };
}

/** null when the file is missing; throws when it exists but is unreadable. */
function readDoc(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw err;
  }
  const doc = JSON.parse(text);
  if (!isPlainObject(doc)) throw new Error('not a JSON object');
  return doc;
}

/** Temp file + rename; the temp name still matches the *.local.json gitignore. */
function writeAtomic(file, text) {
  const tmp = file.replace(/(\.local)?\.json$/, '.tmp.local.json');
  try {
    fs.writeFileSync(tmp, text, 'utf8');
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

const toUnits = (projects) => projects.map((p) => [PREFIX + p.id, { label: p.label, path: portablePath(p.path) }]);
const idOf = (k) => k.slice(PREFIX.length);

/**
 * @param {{baseFile: string, localFile: string}} files the two files projects.js reads
 */
function createProjectsProvider({ baseFile, localFile }) {
  return {
    name: 'projects',
    owns: (k) => k.startsWith(PREFIX),
    valid: (k, v) => (validId(idOf(k)) ? validEntry(v) : null),

    /** @returns {{units, base, gone, doc, baseDoc}} throws when a file is unreadable */
    read(now) {
      const baseDoc = readDoc(baseFile) || { projects: [] };
      const doc = readDoc(localFile);
      const units = toUnits(mergeProjects(baseDoc, doc).projects);
      const base = doc ? Math.floor(Math.min(fs.statSync(localFile).mtimeMs, now)) : 0;
      const alive = new Set(units.map(([k]) => k));
      const removed = doc && Array.isArray(doc.removedIds) ? doc.removedIds : [];
      // Stamped when the file last changed (not now): a project re-added on
      // another PC after this removal still wins.
      const seed = Math.max(base, now - SEED_WINDOW_MS);
      const gone = {};
      for (const id of removed) {
        if (validId(id) && !alive.has(PREFIX + id)) gone[PREFIX + id] = seed;
      }
      return { units, base, gone, doc, baseDoc };
    },

    /** A project this PC already has keeps its own value (its folder may differ here). */
    resolve(merged, local) {
      const mine = new Map(local.units);
      let room = MAX_PROJECTS - merged.filter(([k]) => mine.has(k)).length;
      return merged
        .filter(([k]) => mine.has(k) || room-- > 0)
        .map(([k, v]) => [k, mine.has(k) ? mine.get(k) : v]);
    },

    /** Writes projects.local.json so that loadProjects() lists exactly `units`. */
    write(units, local) {
      const doc = local.doc || {};
      const ids = new Set(units.map(([k]) => idOf(k)));
      const baseKeys = new Set(toUnits(mergeProjects(local.baseDoc, null).projects).map(([k]) => k));
      const all = Array.isArray(doc.projects) ? doc.projects : [];
      const hasId = (p) => p && typeof p.id === 'string';
      const raw = new Map(all.filter(hasId).map((p) => [p.id, p]));
      // Entries loadProjects() cannot read stay as the user wrote them.
      const projects = all.filter((p) => !hasId(p));
      for (const [k, v] of units) {
        const id = idOf(k);
        // Keep this PC's own entry as written; a base entry needs no copy.
        if (raw.has(id)) projects.push(raw.get(id));
        else if (!baseKeys.has(k)) projects.push({ id, label: v.label, path: v.path });
      }
      // Every project that was listed and is gone now is recorded, like removeProject()
      // does; one the cloud brought back is taken off the list.
      const oldRemoved = Array.isArray(doc.removedIds) ? doc.removedIds : [];
      const removedIds = [...new Set([...oldRemoved, ...local.units.map(([k]) => idOf(k))])].filter((id) => !ids.has(id));
      fs.mkdirSync(path.dirname(localFile), { recursive: true });
      writeAtomic(localFile, JSON.stringify({ ...doc, projects, removedIds }, null, 2) + '\n');
    },
  };
}

module.exports = { createProjectsProvider, portablePath, validEntry, writeAtomic, PREFIX, MAX_PROJECTS };
