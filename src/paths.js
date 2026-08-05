// ============================================================================
// LunaCore - where config lives
// ----------------------------------------------------------------------------
// Two roots. The difference is invisible until the app is packaged:
//
//   BUNDLED - shipped defaults (config/*.json). Inside app.asar in a built app:
//             readable, NOT writable.
//   USER    - per-machine overrides and state (config/*.local.json). Must be
//             writable, so in a built app it cannot be the bundled directory.
//
// In a dev clone the two are the SAME directory - the repo's own config/ - so
// `npm start` and `npm test` behave exactly as they did before this module
// existed, and there is nothing to migrate for anyone already running from a
// clone. Only a genuinely packaged app (app.isPackaged) ever looks elsewhere,
// which also means a stray PORTABLE_EXECUTABLE_DIR in a dev shell cannot
// redirect config out from under you.
//
// What deliberately does NOT happen here: copying the shipped defaults into the
// user directory on first run. §7 of FUTURE_PLAN proposed that, but this
// codebase already separates the two concerns BY FILENAME - `themes.json` ships,
// `themes.local.json` is yours, and every loader merges base then local (see
// theme.js loadThemes). Copying defaults across would shadow them, so an update
// could never deliver a new theme or a corrected rate table. The user directory
// holds overrides only, and a missing override file is already a no-op
// everywhere (readJson -> null -> collect() returns early).
// ============================================================================

'use strict';

const fs = require('fs');
const path = require('path');

/** Shipped defaults. Read-only once packed into app.asar. */
const BUNDLED_DIR = path.join(__dirname, '..', 'config');

/**
 * Folder name a portable build keeps its config in, next to the .exe.
 * Visible to the user, hence the readable name rather than a dotfile.
 */
const PORTABLE_DIRNAME = 'LunaCore-config';

/**
 * Decides the writable config root from plain values - no fs, no electron, no
 * process globals. Exported so `node --test` can cover every branch without
 * launching Electron (the A3 convention: keep the decision pure, keep the
 * environment-gathering trivial).
 *
 * @param {{isPackaged:boolean, userData:string|null, portableDir:string|null,
 *   bundledDir:string}} env
 * @returns {string}
 */
function resolveUserDir(env) {
  const { isPackaged, userData, portableDir, bundledDir } = env;

  // Dev clone (npm start from source) and every test run: unchanged behaviour.
  if (!isPackaged) return bundledDir;

  // Portable build: electron-builder sets PORTABLE_EXECUTABLE_DIR to the folder
  // holding the .exe, so config travels with the app (USB stick, synced folder).
  if (portableDir) return path.join(portableDir, PORTABLE_DIRNAME);

  // Installed build: %APPDATA%/LunaCore/config on Windows, the platform
  // equivalent elsewhere - app.getPath('userData') is already per-app.
  if (userData) return path.join(userData, 'config');

  // Packaged but Electron told us nothing. Falling back to the bundled dir would
  // mean silently dropping every write, so prefer a path that at least exists.
  return bundledDir;
}

/** Electron's `app`, or null when running under plain node (tests, --check). */
function tryElectronApp() {
  try {
    const { app } = require('electron');
    return app && typeof app.getPath === 'function' ? app : null;
  } catch {
    return null;
  }
}

let cachedUserDir = null;

/**
 * The writable config root. See resolveUserDir() for the rules.
 *
 * The result is memoized, but ONLY when it was resolved from real information.
 * The degraded branch (packaged, yet Electron would not tell us userData) is
 * deliberately not cached: these modules are required at the top of main.js,
 * before app.whenReady(), so an early first call must not be able to pin the
 * whole session to the wrong directory. Re-resolving costs a string join.
 */
function userDir() {
  if (cachedUserDir !== null) return cachedUserDir;

  const app = tryElectronApp();
  let userData = null;
  if (app) {
    try {
      userData = app.getPath('userData');
    } catch {
      /* not dependable before app is ready - treat as unknown, retry later */
    }
  }

  const isPackaged = Boolean(app && app.isPackaged);
  const portableDir = process.env.PORTABLE_EXECUTABLE_DIR || null;
  const dir = resolveUserDir({ isPackaged, userData, portableDir, bundledDir: BUNDLED_DIR });

  const wasGuess = isPackaged && !portableDir && !userData;
  if (!wasGuess) cachedUserDir = dir;
  return dir;
}

/** The read-only root holding shipped defaults. */
function bundledDir() {
  return BUNDLED_DIR;
}

/** Absolute path to a shipped default file, e.g. bundled('themes.json'). */
function bundled(name) {
  return path.join(BUNDLED_DIR, name);
}

/** Absolute path to a per-machine file, e.g. local('themes.local.json'). */
function local(name) {
  return path.join(userDir(), name);
}

/**
 * Creates the user config directory if it is missing.
 *
 * Callers that write should use this rather than mkdir-ing the parent of their
 * own file: in a packaged build that parent is a path the user has never seen,
 * and creating it lazily at first write is what makes "change the theme, restart,
 * it remembered" work on a clean install.
 *
 * @returns {boolean} true if the directory exists afterwards
 */
function ensureUserDir() {
  try {
    fs.mkdirSync(userDir(), { recursive: true });
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  resolveUserDir,
  userDir,
  bundledDir,
  bundled,
  local,
  ensureUserDir,
  PORTABLE_DIRNAME,
};
