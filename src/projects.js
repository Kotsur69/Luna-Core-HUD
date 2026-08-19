// ============================================================================
// LunaCore - project / working-directory switcher
// ----------------------------------------------------------------------------
// Loads the list of working directories from config/projects.json (plus an
// optional config/projects.local.json override, gitignored). Each entry says
// WHICH FOLDER to start a PTY session in. Switching project = restart the
// session with a new `cwd`.
//
// Paths may start with "~" (expanded to the home directory), which is what makes
// the config PORTABLE across machines (different drive letters / user names).
// Validate at the boundary: entries without id/label/path are rejected. Whether
// the directory actually exists is checked by main.js just before spawning -
// a repo may only exist on one machine.
// ============================================================================

'use strict';

const fs = require('fs');
const path = require('path');
const paths = require('./paths');
const os = require('os');
const { hasText, normalizeText } = require('./localized');

// `paths` (config roots) is not `path` (the node module) - this file needs both,
// and it is the only one that does. Shipped projects come from the bundled root;
// the user's override lives in the WRITABLE root, resolved lazily because this
// module is required before app.whenReady(). See paths.js.
const BASE_FILE = paths.bundled('projects.json');
const localFile = () => paths.local('projects.local.json');

// Emergency list used when the config is missing or broken - we always have
// somewhere to start.
const FALLBACK = {
  activeProject: 'home',
  projects: [{ id: 'home', label: 'Home (~)', path: '~' }],
};

/** Safe read + JSON parse. Returns null when the file is missing or invalid. */
function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null; // file does not exist, or is not valid JSON
  }
}

/** Expands a leading "~" to the home directory; returns a normalized path. */
function expandHome(p) {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

/** Validates and normalizes a single project entry. Returns an object or null. */
function normalizeProject(p) {
  if (!p || typeof p !== 'object') return null;
  if (typeof p.id !== 'string' || !p.id) return null;
  // Label may be a string or a { pl, en } object - see src/localized.js.
  if (!hasText(p.label)) return null;
  if (typeof p.path !== 'string' || !p.path) return null;
  return {
    id: p.id,
    label: normalizeText(p.label),
    path: path.normalize(expandHome(p.path)),
  };
}

/**
 * Loads projects: base (projects.json) merged with local (projects.local.json).
 * Local may override activeProject and add or replace entries by id.
 * @returns {{projects: Array<{id:string,label:string,path:string}>, activeProject: string}}
 */
function loadProjects() {
  const base = readJson(BASE_FILE) || FALLBACK;
  const local = readJson(localFile());

  // Ids the user deleted via the UI. Needed because a deleted entry may come
  // from the READ-ONLY base file - removeProject() cannot erase it there, so
  // it records the id here instead and every load filters it back out.
  const removed = new Set(
    local && Array.isArray(local.removedIds) ? local.removedIds : []
  );

  // Keyed by id so local entries replace base entries with the same id
  // (insertion order is preserved).
  const byId = new Map();
  const collect = (src) => {
    if (!src || !Array.isArray(src.projects)) return;
    for (const raw of src.projects) {
      const p = normalizeProject(raw);
      if (p && !removed.has(p.id)) byId.set(p.id, p);
    }
  };
  collect(base);
  collect(local);

  let projects = [...byId.values()];
  if (projects.length === 0) {
    projects = [{ id: 'home', label: 'Home (~)', path: os.homedir() }];
  }

  // activeProject precedence: local > base > first available.
  let activeProject =
    (local && typeof local.activeProject === 'string' && local.activeProject) ||
    (typeof base.activeProject === 'string' && base.activeProject) ||
    projects[0].id;
  if (!byId.has(activeProject)) activeProject = projects[0].id;

  return { projects, activeProject };
}

/** Returns the project with the given id, or null. */
function getProject(projects, id) {
  return projects.find((p) => p.id === id) || null;
}

/** Turns a label into an id-safe slug. Falls back to "project" so an
 *  all-symbol label (rare, but a folder can be named anything) never yields
 *  an empty id. */
function slugify(label) {
  const slug = String(label)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'project';
}

/** First of base, base-2, base-3, ... not already in `existingIds`. */
function uniqueId(base, existingIds) {
  if (!existingIds.has(base)) return base;
  let i = 2;
  while (existingIds.has(`${base}-${i}`)) i++;
  return `${base}-${i}`;
}

/**
 * Adds one project to projects.local.json (creating it if missing) and
 * returns the freshly reloaded { projects, activeProject } - same shape as
 * loadProjects(), so main.js can drop the result straight into its `projects`
 * list. Never touches activeProject: adding a folder must not silently
 * switch the caller's tab away from wherever it currently is (main.js's
 * switch-project IPC handles that separately, on the caller's request).
 *
 * The id is derived from the label (defaulting to the folder's own name) and
 * de-duplicated against every existing project, base + local alike, so a
 * second "my-app" on another drive does not collide with or overwrite the
 * first.
 *
 * Re-adding a folder that is ALREADY in the list (same resolved path, e.g.
 * the "+" dialog pointed at a folder twice) is a no-op: the existing entry
 * is returned as-is rather than creating a second switcher option for the
 * same directory.
 * @param {{label?:string, path:string}} entry
 * @returns {{projects, activeProject, addedId:string}|null} null when `path`
 *   is missing/blank. `addedId` lets the caller select/switch to the new
 *   (or matching pre-existing) entry without having to re-derive its slug
 *   from the label.
 */
function addProject(entry) {
  if (!entry || typeof entry.path !== 'string' || !entry.path.trim()) return null;

  const resolvedPath = path.normalize(expandHome(entry.path.trim()));
  const current = loadProjects();

  // Case-insensitive compare: Windows paths differing only by case are the
  // same directory on disk, and would otherwise pass as "distinct".
  const dupe = current.projects.find(
    (p) => p.path.toLowerCase() === resolvedPath.toLowerCase()
  );
  if (dupe) return { ...current, addedId: dupe.id };

  const label = typeof entry.label === 'string' && entry.label.trim()
    ? entry.label.trim()
    : path.basename(resolvedPath) || resolvedPath;

  const existingIds = new Set(current.projects.map((p) => p.id));
  const id = uniqueId(slugify(label), existingIds);

  const local = readJson(localFile()) || {};
  const list = Array.isArray(local.projects) ? local.projects.slice() : [];
  list.push({ id, label, path: entry.path.trim() });

  paths.ensureUserDir();
  fs.writeFileSync(
    localFile(),
    JSON.stringify({ ...local, projects: list }, null, 2) + '\n',
    'utf8'
  );

  return { ...loadProjects(), addedId: id };
}

/**
 * Removes one project by id and returns the freshly reloaded
 * { projects, activeProject } - same shape as loadProjects().
 *
 * Works for BOTH kinds of entry:
 *   - local-only (added via the "+" dialog): dropped straight out of
 *     projects.local.json's `projects` array.
 *   - shipped in the read-only base file (config/projects.json): the base
 *     file itself is never touched, so the id is recorded in local's
 *     `removedIds` instead - loadProjects() filters it back out on every
 *     read. This is how a stale/duplicate DEFAULT entry (not just a
 *     user-added one) becomes deletable from the app.
 *
 * Never picks a new activeProject itself: if the removed entry was active,
 * loadProjects()'s existing "activeProject not in byId -> first available"
 * fallback takes over, same as it already does for a bad/missing id.
 * @param {string} id
 * @returns {{projects, activeProject}|null} null when `id` is missing/blank.
 */
function removeProject(id) {
  if (typeof id !== 'string' || !id) return null;

  const local = readJson(localFile()) || {};
  const list = Array.isArray(local.projects) ? local.projects.filter((p) => p && p.id !== id) : [];
  const removedIds = new Set(Array.isArray(local.removedIds) ? local.removedIds : []);
  removedIds.add(id);

  paths.ensureUserDir();
  fs.writeFileSync(
    localFile(),
    JSON.stringify({ ...local, projects: list, removedIds: [...removedIds] }, null, 2) + '\n',
    'utf8'
  );

  return loadProjects();
}

// expandHome + normalizeProject + slugify + uniqueId are pure (no I/O) -
// exported for the tests. addProject/removeProject do real file I/O (write
// projects.local.json) and are covered by the manual checklist instead, same
// as loadProjects() itself.
module.exports = {
  loadProjects,
  getProject,
  normalizeProject,
  expandHome,
  addProject,
  removeProject,
  slugify,
  uniqueId,
};
