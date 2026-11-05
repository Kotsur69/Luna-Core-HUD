// ============================================================================
// Shared helpers for tests that must hold up on a loaded machine (several
// package suites running at once, real git and child processes taking seconds).
//
// Lives outside test/ on purpose: `node --test` with no arguments runs every
// .js file under a test/ folder, so a helper there would be run as a test file.
// It is also outside package.json's build.files, so it never ships.
// ============================================================================

'use strict';

const fs = require('fs');
const util = require('util');
const { execFile } = require('child_process');

// fs.promises.rm retries with a linear backoff (retryDelay longer each try):
// 15 tries x 200 ms add up to ~24 s before it gives up.
const RM_MAX_RETRIES = 15;
const RM_RETRY_DELAY_MS = 200;

/**
 * Removes a throwaway folder that git or another child process just worked in.
 * On a busy Windows machine the process (or a git.exe child a killed `git`
 * leaves behind) can hold the folder a moment longer, so the first removal
 * answers EPERM/EBUSY. fs.promises.rm retries until the holder exits; rmSync
 * is no use here - on Node 24 it gives up after ~1 ms whatever maxRetries says.
 * Always await it, or the retry outlives the test.
 * @param {string} dir
 * @returns {Promise<void>}
 */
function removeDir(dir) {
  return fs.promises.rm(dir, { recursive: true, force: true, maxRetries: RM_MAX_RETRIES, retryDelay: RM_RETRY_DELAY_MS });
}

const WAIT_TIMEOUT_MS = 20000;
const WAIT_INTERVAL_MS = 10;

/**
 * Polls until `condition()` is truthy, instead of sleeping a fixed time and
 * hoping the work is done by then. Rejects after `timeoutMs` so a broken test
 * fails with `message` rather than hanging. The caller still asserts the exact
 * outcome afterwards; this only decides when to look.
 * @param {() => unknown} condition
 * @param {{timeoutMs?:number, intervalMs?:number, message?:string}} [opts]
 * @returns {Promise<void>}
 */
async function waitFor(condition, { timeoutMs = WAIT_TIMEOUT_MS, intervalMs = WAIT_INTERVAL_MS, message = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (condition()) return;
    if (Date.now() >= deadline) throw new Error(`waitFor timed out after ${timeoutMs} ms: ${message}`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

// The app caps its git calls at 15-60 s as a guard against a hung git. Under
// load one real `git` call has taken longer than that, so a correct repo read
// as a failure. Tests about git's output get a cap that load does not reach.
const PATIENT_GIT_MS = 120000;

/**
 * A git runner with the `run(cwd, args)` shape of src/lunasworkHandback.js
 * (resolves {ok, out, err}, never rejects), with a patient cap. Pass it through
 * a module's `run` seam.
 * @param {string} cwd
 * @param {string[]} args
 * @returns {Promise<{ok:boolean, out:string, err:string}>}
 */
function patientGit(cwd, args) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, timeout: PATIENT_GIT_MS, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) =>
      resolve({ ok: !err, out: String(stdout || ''), err: String(stderr || '').trim().split('\n')[0] }),
    );
  });
}

/**
 * For modules with no runner seam: raises the timeout of every `git` call made
 * through child_process.execFile to at least PATIENT_GIT_MS. Such modules take
 * `const { execFile } = require('child_process')` when they load, so call this
 * BEFORE requiring them. Each test file runs in its own process, so the patch
 * stays inside that file. Calls that are not git, or set no timeout, pass
 * through untouched.
 * @param {typeof import('child_process')} childProcess
 * @returns {() => void} restores the original execFile
 */
function patientGitExecFile(childProcess) {
  const original = childProcess.execFile;
  function patientExecFile(file, args, options, callback) {
    const hasCap = file === 'git' && Array.isArray(args) && options && typeof options === 'object' && options.timeout > 0;
    if (!hasCap) return original.apply(this, arguments);
    return original.call(this, file, args, { ...options, timeout: Math.max(options.timeout, PATIENT_GIT_MS) }, callback);
  }
  // Keep util.promisify(execFile) answering {stdout, stderr} like the original.
  patientExecFile[util.promisify.custom] = original[util.promisify.custom];
  childProcess.execFile = patientExecFile;
  return () => {
    childProcess.execFile = original;
  };
}

module.exports = { removeDir, waitFor, patientGit, patientGitExecFile, PATIENT_GIT_MS };
