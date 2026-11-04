// ============================================================================
// LunaCore - God Mode v2 run persistence (ORCHESTRATOR_PLAN.md slice 4,
// per project since docs/MULTI_GODMODE_PLAN.md A1)
// ----------------------------------------------------------------------------
// One file per project: config/orchestra/<sha1(projectId)[0..16]>.local.json
// (per machine, gitignored like every *.local.*), holding the whole run - plan,
// per-package phase, worktree paths, branches - written on every transition
// so a restart can show the board again and Retry can reopen a package in its
// own worktree. Project ids are free strings, so they are never used as file
// names: '..\x' or 'CON' would escape the folder or hit a reserved device name.
// The file is an envelope {version, projectId, run}; the id inside is what
// listStored() reports and what loadRun() checks, so a hash collision or a
// file copied under another name never hands one project another's run.
// A tab with no project plans under projectId null (todo.js keeps a list for
// it too); null is stored under the hash of ''.
//
// Validation of the run itself lives in orchestraSupervisor.normalizeStoredPlan;
// this module only does the IO. Same contract as the other config loaders: a
// missing or broken file reads as null, a failed write returns false - never
// a throw.
//
// migrateLegacy() moves the single-run file older builds wrote
// (config/orchestra.local.json) into this layout once, at startup. The legacy
// file is renamed to orchestra.local.json.migrated, never deleted.
// ============================================================================

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const paths = require('./paths');

const STORE_DIR = 'orchestra';
const LEGACY_FILE = 'orchestra.local.json';
const MIGRATED_SUFFIX = '.migrated';
const FILE_SUFFIX = '.local.json';
const HASH_CHARS = 16;
const STORE_VERSION = 1;
const FILE_RE = /^[0-9a-f]{16}\.local\.json$/;
// Owner-only: the run holds prompts and local paths.
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;
// How many numbered .migrated names are tried before giving up on the rename.
const MAX_MIGRATED_NAMES = 100;

/** A valid stored id (string, or null for "no project"), or undefined for anything else. */
function normalizeId(projectId) {
  if (projectId === null || projectId === undefined) return null;
  return typeof projectId === 'string' ? projectId : undefined;
}

/**
 * The file name a project's run is stored under. Derived only from the id's
 * hash, never from the id itself.
 * @param {string|null} projectId
 * @returns {string|null} null for an id that is neither a string nor null
 */
function storeFileName(projectId) {
  const id = normalizeId(projectId);
  if (id === undefined) return null;
  const hash = crypto.createHash('sha1').update(id === null ? '' : id, 'utf8').digest('hex');
  return `${hash.slice(0, HASH_CHARS)}${FILE_SUFFIX}`;
}

/** Writes JSON through a tmp file and a rename, owner-only. */
function writeAtomic(target, value) {
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: FILE_MODE });
  fs.renameSync(tmp, target);
}

/** The parsed JSON at `file`, or null when missing or broken. */
function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const errText = (err) => (err instanceof Error ? err.message : String(err));

/** mkdir -p for a custom config root (tests); the app uses paths.ensureUserDir. */
function ensureDirFn(dirFn) {
  return () => {
    try {
      fs.mkdirSync(dirFn(), { recursive: true });
      return true;
    } catch {
      return false;
    }
  };
}

/**
 * @param {{userDir?: () => string, log?: (line:string) => void}} [opts]
 *   userDir: the config root (paths.userDir by default; a temp dir in tests)
 */
function createOrchestraStore(opts = {}) {
  const userDir = opts.userDir || paths.userDir;
  const ensureUserDir = opts.userDir ? ensureDirFn(opts.userDir) : paths.ensureUserDir;
  const log = opts.log || (() => {});

  const storeDir = () => path.join(userDir(), STORE_DIR);
  const fileFor = (projectId) => {
    const name = storeFileName(projectId);
    return name ? path.join(storeDir(), name) : null;
  };

  /**
   * @param {string|null} projectId
   * @returns {unknown} the stored run, or null (none, broken, or another project's)
   */
  function loadRun(projectId) {
    const file = fileFor(projectId);
    if (!file) return null;
    const env = readJson(file);
    if (!isObj(env) || normalizeId(env.projectId) !== normalizeId(projectId)) return null;
    return env.run === undefined ? null : env.run;
  }

  /**
   * @param {string|null} projectId
   * @param {object|null} data serialized run; null deletes the project's file
   * @returns {boolean}
   */
  function saveRun(projectId, data) {
    const file = fileFor(projectId);
    if (!file) return false;
    try {
      if (data === null) {
        fs.rmSync(file, { force: true });
        return true;
      }
      if (!ensureUserDir()) return false;
      fs.mkdirSync(storeDir(), { recursive: true, mode: DIR_MODE });
      writeAtomic(file, { version: STORE_VERSION, projectId: normalizeId(projectId), run: data });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * The projects with a stored run, from the ids inside the files. A file
   * whose name does not match its own id (copied, renamed) is skipped.
   * @returns {Array<string|null>}
   */
  function listStored() {
    let names;
    try {
      names = fs.readdirSync(storeDir());
    } catch {
      return [];
    }
    const out = [];
    for (const name of names.filter((n) => FILE_RE.test(n)).sort()) {
      const env = readJson(path.join(storeDir(), name));
      const id = isObj(env) ? normalizeId(env.projectId) : undefined;
      if (id !== undefined && storeFileName(id) === name) out.push(id);
    }
    return out;
  }

  /** A free name for the renamed legacy file: an earlier .migrated is never overwritten. */
  function migratedName(legacy) {
    const first = `${legacy}${MIGRATED_SUFFIX}`;
    if (!fs.existsSync(first)) return first;
    for (let n = 2; n < MAX_MIGRATED_NAMES; n += 1) {
      const next = `${first}.${n}`;
      if (!fs.existsSync(next)) return next;
    }
    return null;
  }

  /** The legacy run's project: its own projectId, else what main matches by repoPath. */
  function legacyProjectId(raw, resolveProjectId) {
    if (typeof raw.projectId === 'string' && raw.projectId) return raw.projectId;
    if (typeof resolveProjectId !== 'function') return null;
    try {
      const resolved = resolveProjectId(raw);
      return typeof resolved === 'string' && resolved ? resolved : null;
    } catch (err) {
      log(`[orchestra] legacy run project lookup failed: ${errText(err)}`);
      return null;
    }
  }

  /**
   * Moves the single-run file older builds wrote into the per-project layout.
   * The new file is written first, then the legacy one is renamed - never
   * deleted. An unmatched or broken legacy file is left alone and logged; so
   * is one whose project already has a stored run (that one is newer).
   * @param {(raw:object) => string|null|undefined} resolveProjectId main's
   *   repoPath match against the registered projects, for a run without an id
   * @returns {{migrated:boolean, reason:string, projectId?:string, renamedTo?:string}}
   */
  function migrateLegacy(resolveProjectId) {
    const legacy = path.join(userDir(), LEGACY_FILE);
    if (!fs.existsSync(legacy)) return { migrated: false, reason: 'none' };
    const raw = readJson(legacy);
    if (!isObj(raw)) {
      log(`[orchestra] legacy ${LEGACY_FILE} is broken - left in place`);
      return { migrated: false, reason: 'broken' };
    }
    const projectId = legacyProjectId(raw, resolveProjectId);
    if (!projectId) {
      log(`[orchestra] legacy ${LEGACY_FILE} matches no registered project - left in place`);
      return { migrated: false, reason: 'unmatched' };
    }
    if (fs.existsSync(fileFor(projectId))) {
      log(`[orchestra] legacy ${LEGACY_FILE} not migrated: its project already has a stored run`);
      return { migrated: false, reason: 'exists', projectId };
    }
    if (!saveRun(projectId, raw)) {
      log(`[orchestra] could not write the migrated run - legacy ${LEGACY_FILE} left in place`);
      return { migrated: false, reason: 'writeFailed', projectId };
    }
    const target = migratedName(legacy);
    try {
      if (!target) throw new Error('no free .migrated name');
      fs.renameSync(legacy, target);
    } catch (err) {
      // The run is in the new layout already; the 'exists' rule above keeps
      // a later start from migrating the legacy file a second time.
      log(`[orchestra] migrated, but could not rename ${LEGACY_FILE}: ${errText(err)}`);
      return { migrated: true, reason: 'renameFailed', projectId };
    }
    log(`[orchestra] migrated ${LEGACY_FILE} to ${STORE_DIR}/${storeFileName(projectId)}`);
    return { migrated: true, reason: 'ok', projectId, renamedTo: target };
  }

  return { loadRun, saveRun, listStored, migrateLegacy };
}

// The app's own store, on the real config root.
const defaultStore = createOrchestraStore({ log: (line) => console.info(line) });

module.exports = {
  createOrchestraStore,
  storeFileName,
  loadRun: defaultStore.loadRun,
  saveRun: defaultStore.saveRun,
  listStored: defaultStore.listStored,
  migrateLegacy: defaultStore.migrateLegacy,
  loadSettledRuns,
  saveSettledRuns,
  STORE_DIR,
  LEGACY_FILE,
};

// config/orchestra-settled.local.json: runs whose merge landed, for the
// one-time start-up cleanup sweep (orchestraCleanup.js sweepSettledRuns -
// entries are validated there). Same contract: broken -> [], write -> bool.
const settledFile = () => paths.local('orchestra-settled.local.json');

/** @returns {unknown[]} the stored ledger entries (unchecked), [] when none */
function loadSettledRuns() {
  try {
    const data = JSON.parse(fs.readFileSync(settledFile(), 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

/** @param {object[]} list @returns {boolean} */
function saveSettledRuns(list) {
  try {
    if (!paths.ensureUserDir()) return false;
    const target = settledFile();
    const tmp = `${target}.tmp`;
    // Owner-only: it holds local repo paths.
    fs.writeFileSync(tmp, JSON.stringify(Array.isArray(list) ? list : [], null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, target);
    return true;
  } catch {
    return false;
  }
}
