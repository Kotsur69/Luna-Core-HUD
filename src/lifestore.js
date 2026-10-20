// ============================================================================
// LunaCore - Life dashboard: one small JSON store (main process)
// ----------------------------------------------------------------------------
// The check-in, habits, goals and score-settings files share the contract of
// src/lifebudget.js:
//   - load()   for display: never throws, a missing or broken file shows the
//              defaults;
//   - update() for writes: only a MISSING file (ENOENT) starts from the
//              defaults; any other read or parse failure throws 'unreadable'
//              and the file is left alone, so a sync lock or a half-written
//              file can never be replaced by an empty store;
//   - writes go to a temp file + rename, so a crash never truncates the file.
// Each file is config/<name>.local.json (gitignored by the *.local.json rule).
// ============================================================================

'use strict';

const fs = require('fs');
const paths = require('./paths');

// Printable text only: no C0/C1 control characters, no zero-width or bidi
// override / invisible formatting characters and blank-looking fillers
// (they could make a name display as something else, or as nothing).
const TEXT_RE = new RegExp('^[^\\u0000-\\u001f\\u007f-\\u009f\\u00ad\\u061c\\u115f-\\u1160\\u180e\\u200b-\\u200f\\u2028-\\u202e\\u2060-\\u206f\\u3164\\ufeff\\uffa0]*$');

/** A trimmed, printable string of 1..max chars, or null. */
function cleanText(v, max) {
  if (typeof v !== 'string' || v.length > max * 4) return null;
  const s = v.trim();
  // isWellFormed: a lone surrogate would be saved and shown as U+FFFD.
  return s && s.length <= max && TEXT_RE.test(s) && s.isWellFormed() ? s : null;
}

/** 12 hex chars from Web Crypto (global in Node 19+ and Electron). */
function newId() {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(6));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** life-x.local.json -> life-x.<tag>.local.json, still covered by the gitignore rule. */
function sibling(file, tag) {
  return file.endsWith('.local.json') ? `${file.slice(0, -'.local.json'.length)}.${tag}.local.json` : `${file}.${tag}`;
}

/**
 * @param {{fileName:string, defaults:()=>object, normalize:(raw:unknown)=>object}} spec
 * @returns {{load:Function, update:Function, defaultFile:()=>string}}
 */
function createStore({ fileName, defaults, normalize }) {
  const defaultFile = () => paths.local(fileName);

  function load(file = defaultFile()) {
    try {
      return normalize(JSON.parse(fs.readFileSync(file, 'utf8')));
    } catch {
      return defaults();
    }
  }

  function loadForWrite(file) {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (err) {
      if (err && err.code === 'ENOENT') return defaults();
      throw new Error('unreadable');
    }
    try {
      return normalize(JSON.parse(text));
    } catch {
      throw new Error('unreadable');
    }
  }

  function save(next, file) {
    if (file === defaultFile()) paths.ensureUserDir();
    const tmp = sibling(file, `${process.pid}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', 'utf8');
    try {
      fs.renameSync(tmp, file);
    } catch (err) {
      fs.rmSync(tmp, { force: true });
      throw err;
    }
    return next;
  }

  /**
   * Reads for write, applies `fn` (which throws on bad input), normalizes and
   * saves. @returns {object} the saved store
   */
  function update(fn, file = defaultFile()) {
    return save(normalize(fn(loadForWrite(file))), file);
  }

  return { load, update, defaultFile };
}

module.exports = { createStore, cleanText, newId, TEXT_RE };
