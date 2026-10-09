// ============================================================================
// LunaCore - Mission Control: project classes + ledger folder (main process)
// ----------------------------------------------------------------------------
// config/mission-projects.local.json (gitignored by the *.local.json rule):
//   classes:   {<project key>: 'work' | 'fun' | 'other'}  set with one click in
//              the Telemetry column; a key not listed is "unassigned"
//   pinned:    [{key, name, folders[]}]  the projects Mati always wants to
//              see, even at 0 %; `folders` are folder names whose sessions
//              count for the project when the repo is not on this PC
//   sharedDir: absolute path of the folder the PCs exchange ledger files in
//              (src/missionledgersync.js), or null. Only ever set from a
//              native folder dialog in main, never from renderer text.
//
// Same contract as the other config loaders: safe read, validate at the
// boundary, a broken file yields the empty store rather than a crash.
// ============================================================================

'use strict';

const fs = require('fs');
const path = require('path');
const paths = require('./paths');
const { validKey } = require('./missionledgersync');

const FILE_NAME = 'mission-projects.local.json';
const CLASSES = ['work', 'fun', 'other'];
const MAX_CLASSES = 500;
const MAX_DIR = 1000;
const MAX_PINNED = 20;
const MAX_FOLDERS = 5;
// A single folder name: no separators, no control chars, never '.' or '..'.
const FOLDER_RE = /^(?!\.\.?$)[^\\/\u0000-\u001f\u007f]{1,100}$/;
const PIN_NAME_RE = /^[^\u0000-\u001f\u007f]{1,100}$/;

const defaultFile = () => paths.local(FILE_NAME);

function normalizePinned(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const p of list) {
    if (!p || !validKey(p.key) || seen.has(p.key)) continue;
    if (typeof p.name !== 'string' || !PIN_NAME_RE.test(p.name)) continue;
    const folders = (Array.isArray(p.folders) ? p.folders : [])
      .filter((f) => typeof f === 'string' && FOLDER_RE.test(f))
      .slice(0, MAX_FOLDERS);
    seen.add(p.key);
    out.push({ key: p.key, name: p.name, folders });
    if (out.length >= MAX_PINNED) break;
  }
  return out;
}

function normalize(raw) {
  const classes = {};
  const src = raw && typeof raw.classes === 'object' && raw.classes ? raw.classes : {};
  for (const [key, cls] of Object.entries(src).slice(0, MAX_CLASSES)) {
    if (validKey(key) && CLASSES.includes(cls)) classes[key] = cls;
  }
  const dir = raw && raw.sharedDir;
  const sharedDir = typeof dir === 'string' && dir.length <= MAX_DIR && path.isAbsolute(dir) ? dir : null;
  return { classes, sharedDir, pinned: normalizePinned(raw && raw.pinned) };
}

function loadProjects(file = defaultFile()) {
  try {
    return normalize(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch {
    return { classes: {}, sharedDir: null, pinned: [] };
  }
}

function save(next, file) {
  if (file === defaultFile()) paths.ensureUserDir();
  fs.writeFileSync(file, JSON.stringify(next, null, 2) + '\n', 'utf8');
  return next;
}

/** Sets (or with null clears) one project's class; throws on bad input. */
function setClass(key, cls, file = defaultFile()) {
  if (!validKey(key)) throw new Error('bad project key');
  if (cls !== null && !CLASSES.includes(cls)) throw new Error('bad class');
  const cur = loadProjects(file);
  const classes = Object.fromEntries(Object.entries(cur.classes).filter(([k]) => k !== key));
  if (cls) classes[key] = cls;
  if (Object.keys(classes).length > MAX_CLASSES) throw new Error('too many projects');
  return save({ ...cur, classes }, file);
}

/** Sets (or with null clears) the shared ledger folder; absolute paths only. */
function setSharedDir(dir, file = defaultFile()) {
  if (dir !== null && (typeof dir !== 'string' || dir.length > MAX_DIR || !path.isAbsolute(dir))) {
    throw new Error('bad folder');
  }
  return save({ ...loadProjects(file), sharedDir: dir }, file);
}

/** Replaces the pinned list; invalid entries are dropped, not thrown. */
function setPinned(list, file = defaultFile()) {
  return save({ ...loadProjects(file), pinned: normalizePinned(list) }, file);
}

/** folder name (lower-case) -> {key, name}, for missionrepokey.js aliases. */
function pinnedAliases(pinned) {
  const map = new Map();
  for (const p of pinned) for (const f of p.folders) map.set(f.toLowerCase(), { key: p.key, name: p.name });
  return map;
}

module.exports = { loadProjects, setClass, setSharedDir, setPinned, pinnedAliases, CLASSES };
