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
const os = require('os');

const CONFIG_DIR = path.join(__dirname, '..', 'config');
const BASE_FILE = path.join(CONFIG_DIR, 'projects.json');
const LOCAL_FILE = path.join(CONFIG_DIR, 'projects.local.json');

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
  if (typeof p.label !== 'string' || !p.label) return null;
  if (typeof p.path !== 'string' || !p.path) return null;
  return { id: p.id, label: p.label, path: path.normalize(expandHome(p.path)) };
}

/**
 * Loads projects: base (projects.json) merged with local (projects.local.json).
 * Local may override activeProject and add or replace entries by id.
 * @returns {{projects: Array<{id:string,label:string,path:string}>, activeProject: string}}
 */
function loadProjects() {
  const base = readJson(BASE_FILE) || FALLBACK;
  const local = readJson(LOCAL_FILE);

  // Keyed by id so local entries replace base entries with the same id
  // (insertion order is preserved).
  const byId = new Map();
  const collect = (src) => {
    if (!src || !Array.isArray(src.projects)) return;
    for (const raw of src.projects) {
      const p = normalizeProject(raw);
      if (p) byId.set(p.id, p);
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

// expandHome + normalizeProject are pure (no I/O) - exported for the tests.
module.exports = { loadProjects, getProject, normalizeProject, expandHome };
