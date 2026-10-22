// ============================================================================
// LunaCore - Luna's Work run persistence (docs/LUNAS_WORK_PLAN.md, slice 1)
// ----------------------------------------------------------------------------
// config/lunaswork.local.json (per machine, gitignored like every *.local.*):
// the whole run - phase, iteration, models, history - written on every
// transition so a restart resumes it. Separate from God Mode's
// orchestra.local.json on purpose: the two modes never share state.
// Validation of what comes back lives in lunasworkRules.normalizeStoredRun;
// this module only does the IO.
//
// Same contract as orchestraStore.js: a missing or broken file reads as null,
// a failed write returns false - never a throw.
// ============================================================================

'use strict';

const fs = require('fs');
const paths = require('./paths');

const file = () => paths.local('lunaswork.local.json');

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
    // Owner-only: it holds local paths and run history.
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, target);
    return true;
  } catch {
    return false;
  }
}

module.exports = { loadRun, saveRun };
