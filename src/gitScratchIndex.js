// ============================================================================
// LunaCore - a throwaway git index in its own private temp folder
// ----------------------------------------------------------------------------
// Luna's Work builds commits off to the side with GIT_INDEX_FILE pointing at a
// throwaway index. That index must NOT sit directly in the %TEMP% root: on some
// Windows machines `git read-tree` there fails with "unable to write new index
// file" (git's lock + rename dance is refused in the root but works in a
// subfolder). So every call gets its own mkdtemp folder, removed afterwards
// even when the git steps failed.
// ============================================================================

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// Node 24 on Windows can answer EPERM/EBUSY right after git.exe exits:
// fs.promises.rm retries (linear backoff) until the handle is gone.
const RM_MAX_RETRIES = 10;
const RM_RETRY_DELAY_MS = 100;
const INDEX_FILE = 'scratch.index';

/**
 * Runs `fn(indexPath)` with a fresh index path inside a private folder under
 * `base`, and removes that folder afterwards whatever `fn` did.
 * @template T
 * @param {string} prefix folder name prefix, e.g. 'lw-commit-'
 * @param {(indexPath:string)=>Promise<T>} fn
 * @param {{base?:string, onCleanupError?:(err:Error, dir:string)=>void}} [opts]
 * @returns {Promise<T>}
 */
async function withScratchIndex(prefix, fn, opts = {}) {
  const base = typeof opts.base === 'string' && opts.base ? opts.base : os.tmpdir();
  const dir = await fs.promises.mkdtemp(path.join(base, prefix));
  try {
    return await fn(path.join(dir, INDEX_FILE));
  } finally {
    try {
      await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: RM_MAX_RETRIES, retryDelay: RM_RETRY_DELAY_MS });
    } catch (err) {
      // A leftover scratch folder must not turn a finished commit into a failure: report it, do not throw.
      if (typeof opts.onCleanupError === 'function') opts.onCleanupError(err, dir);
    }
  }
}

module.exports = { withScratchIndex };
