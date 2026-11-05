// ============================================================================
// LunaCore - the host log file (main, host mode)
// ----------------------------------------------------------------------------
// docs/tbc_docs/REMOTE_HOST_PLAN.md, "Security review" J-M: host.log used to rotate
// only when host mode started, and a host runs for days. This appender keeps
// the size it wrote in memory and rotates (file -> file.old, one generation)
// as soon as the file passes the cap, at any time, not just at start.
//
// The log is a convenience: a failed write or rotation never throws into the
// caller (console.log / console.error of the whole host).
// ============================================================================

'use strict';

const nodeFs = require('fs');
const path = require('path');

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;

/**
 * @param {string} file
 * @param {{maxBytes?: number, fs?: typeof nodeFs, onError?: (what: string, err: Error) => void}} [opts]
 * @returns {{append: (line: string) => void, size: () => number}}
 */
function createHostLog(file, { maxBytes = DEFAULT_MAX_BYTES, fs = nodeFs, onError = () => {} } = {}) {
  let size = 0;

  function rotate() {
    try {
      fs.renameSync(file, `${file}.old`); // replaces the previous .old
    } catch (err) {
      if (err && err.code !== 'ENOENT') onError('rotate', err);
    }
    size = 0;
  }

  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    size = fs.existsSync(file) ? fs.statSync(file).size : 0;
  } catch (err) {
    onError('open', err);
  }
  if (size > maxBytes) rotate();

  return {
    append(line) {
      const text = `${line}\n`;
      try {
        fs.appendFileSync(file, text);
        size += Buffer.byteLength(text, 'utf8');
      } catch {
        return; // a locked file must not break the host
      }
      if (size > maxBytes) rotate();
    },
    size: () => size,
  };
}

module.exports = { createHostLog, DEFAULT_MAX_BYTES };
