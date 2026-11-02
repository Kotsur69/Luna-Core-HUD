// ============================================================================
// LunaCore - God Mode v2 run persistence (ORCHESTRATOR_PLAN.md slice 4)
// ----------------------------------------------------------------------------
// config/orchestra.local.json (per machine, gitignored like every *.local.*):
// the whole run - plan, per-package phase, worktree paths, branches - written
// on every transition so a restart can show the board again and Retry can
// reopen a package in its own worktree. Validation of what comes back lives
// in orchestraSupervisor.normalizeStoredPlan; this module only does the IO.
//
// Same contract as the other config loaders: a missing or broken file reads
// as null, a failed write returns false - never a throw.
// ============================================================================

'use strict';

const fs = require('fs');
const paths = require('./paths');

const file = () => paths.local('orchestra.local.json');

/** @returns {unknown} the parsed file, or null */
function loadRun() {
  try {
    return JSON.parse(fs.readFileSync(file(), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * @param {object|null} data serialized run; null deletes the file
 * @returns {boolean}
 */
function saveRun(data) {
  try {
    if (data === null) {
      fs.rmSync(file(), { force: true });
      return true;
    }
    if (!paths.ensureUserDir()) return false;
    const target = file();
    const tmp = `${target}.tmp`;
    // Owner-only: it holds prompts and local paths.
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, target);
    return true;
  } catch {
    return false;
  }
}

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

module.exports = { loadRun, saveRun, loadSettledRuns, saveSettledRuns };
