// ============================================================================
// LunaCore - Mission Control: project classes + pinned projects (main process)
// ----------------------------------------------------------------------------
// config/mission-projects.local.json (gitignored by the *.local.json rule):
//   classes:   {<project key>: 'work' | 'fun' | 'other'}  set with one click in
//              the Telemetry column; a key not listed is "unassigned"
//   pinned:    [{key, name, folders[]}]  the projects Mati always wants to
//              see, even at 0 %; `folders` are folder names whose sessions
//              count for the project when the repo is not on this PC
//   unpinned:  [{key, name, folders[]}]  projects unpinned from the UI; kept
//              so their folder aliases still count and a re-pin restores them
//
// A `sharedDir` key from the old folder sync (before the cloud) is dropped on
// read, so the next save removes it from the file.
//
// Same contract as the other config loaders: safe read, validate at the
// boundary, a broken file yields the empty store rather than a crash.
// ============================================================================

'use strict';

const fs = require('fs');
const paths = require('./paths');
const { validKey } = require('./missionledgersync');

const FILE_NAME = 'mission-projects.local.json';
const CLASSES = ['work', 'fun', 'other'];
const MAX_CLASSES = 500;
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
  const pinned = normalizePinned(raw && raw.pinned);
  const pinnedKeys = new Set(pinned.map((p) => p.key));
  const unpinned = normalizePinned(raw && raw.unpinned).filter((p) => !pinnedKeys.has(p.key));
  return { classes, pinned, unpinned };
}

function loadProjects(file = defaultFile()) {
  try {
    return normalize(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch {
    return { classes: {}, pinned: [], unpinned: [] };
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

/** Replaces the pinned list; invalid entries are dropped, not thrown. */
function setPinned(list, file = defaultFile()) {
  return save({ ...loadProjects(file), pinned: normalizePinned(list) }, file);
}

/**
 * Pins (on = true) or unpins one project. Unpinning parks the entry in
 * `unpinned` so its folder aliases survive; re-pinning restores them. `name`
 * is used only for a project never pinned before. Throws on bad input.
 */
function setPin(key, on, name, file = defaultFile()) {
  if (!validKey(key)) throw new Error('bad project key');
  const cur = loadProjects(file);
  const entry = cur.pinned.find((p) => p.key === key) ||
    cur.unpinned.find((p) => p.key === key) || { key, name, folders: [] };
  if (typeof entry.name !== 'string' || !PIN_NAME_RE.test(entry.name)) throw new Error('bad project name');
  const pinned = cur.pinned.filter((p) => p.key !== key);
  const unpinned = cur.unpinned.filter((p) => p.key !== key);
  if (on) {
    if (pinned.length >= MAX_PINNED) throw new Error('too many pins');
    pinned.push(entry);
  } else {
    unpinned.unshift(entry);
  }
  return save({ ...cur, pinned, unpinned: unpinned.slice(0, MAX_PINNED) }, file);
}

/** Pinned + unpinned entries: everything whose folder aliases count. */
const aliasEntries = (projects) => [...projects.pinned, ...(projects.unpinned || [])];

/** folder name (lower-case) -> {key, name}, for missionrepokey.js aliases. */
function pinnedAliases(pinned) {
  const map = new Map();
  for (const p of pinned) for (const f of p.folders) map.set(f.toLowerCase(), { key: p.key, name: p.name });
  return map;
}

module.exports = { loadProjects, setClass, setPinned, setPin, aliasEntries, pinnedAliases, normalize, normalizePinned, CLASSES, MAX_CLASSES };
