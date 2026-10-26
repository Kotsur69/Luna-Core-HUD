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
// config/lunaswork-machine.local.json: the machine guard's state (machineStore).
//
// Same contract as orchestraStore.js: a missing or broken file reads as null,
// a failed write returns false - never a throw.
// ============================================================================

'use strict';

const fs = require('fs');
const paths = require('./paths');

/**
 * One JSON file under config/ with this module's contract.
 * @param {string} name e.g. 'lunaswork.local.json'
 * @returns {{load:()=>unknown, save:(data:object|null)=>boolean}}
 */
function fileStore(name) {
  const file = () => paths.local(name);
  return {
    /** @returns {unknown} the parsed file, or null */
    load() {
      try {
        return JSON.parse(fs.readFileSync(file(), 'utf8'));
      } catch {
        return null;
      }
    },
    /** @param {object|null} data null deletes the file */
    save(data) {
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
    },
  };
}

const runStore = fileStore('lunaswork.local.json');
// The machine guard's state (src/lunasworkMachine.js): which run it set up and
// the Windows Update values to restore. Kept apart from the run on purpose.
const machineStore = fileStore('lunaswork-machine.local.json');
// "Ask Luna" (LW 2.27, src/lunasworkAsk.js): answered questions and the rate window.
const askStore = fileStore('lunaswork-ask.local.json');

module.exports = { loadRun: runStore.load, saveRun: runStore.save, machineStore, askStore };
