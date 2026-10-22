// ============================================================================
// LunaCore - whole settings files as cloud units (main)
// ----------------------------------------------------------------------------
// Providers for src/configsync.js: machine-independent settings files that
// travel whole, one unit per file, newest wins (docs/DONE_CLOUD_SYNC_PLAN.md, 2b):
//
//   doc:prompts      prompts.local.json
//   doc:libraries    libraries.local.json
//   doc:rates        rates.local.json
//   mc:rules         missioncontrol.local.json
//
// Not cheatsheets: a cheatsheet command is typed into the terminal on click,
// so a cloud row must never be able to change one (Mati, 2026-10-15).
//
// The unit value is the parsed file. Every loader (prompts.js, libraries.js,
// ...) re-validates its file on each read, so a cloud value only has to be a
// plain object of a size one cloud row can hold. A deleted file is a
// tombstone: it is deleted on the other PCs too. Whatever the cloud replaces
// or deletes is kept as one <name>.bak.local.json, so a wrong delete (a config
// dir that was briefly missing) can be undone. A file too big for one row,
// or unreadable, is skipped (never published, never overwritten).
// ============================================================================

'use strict';

const fs = require('fs');
const path = require('path');
const { writeAtomic } = require('./projectsync');

/**
 * UTF-8 bytes of the JSON text. The server refuses a jsonb value of 16 KiB
 * (pg_column_size), and jsonb can take about twice the text's size (per-key
 * headers, numbers as numeric), so the cap leaves that much room: a refused
 * row would fail its whole push batch, again and again.
 */
const MAX_DOC_BYTES = 7000;

const DOCS = [
  ['doc:prompts', 'prompts.local.json'],
  ['doc:libraries', 'libraries.local.json'],
  ['doc:rates', 'rates.local.json'],
  ['mc:rules', 'missioncontrol.local.json'],
];

/** prompts.local.json -> prompts.bak.local.json (still gitignored, never packed). */
const backupOf = (file) => file.replace(/(\.local)?\.json$/, '.bak.local.json');
const isPlainObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const fits = (doc) => Buffer.byteLength(JSON.stringify(doc), 'utf8') <= MAX_DOC_BYTES;

/**
 * @param {{name: string, file: string}} opts name doubles as the unit key
 */
function createDocProvider({ name, file }) {
  return {
    name,
    owns: (k) => k === name,
    valid: (k, v) => (k === name && isPlainObject(v) && fits(v) ? v : null),

    /** @returns {{units, base}} throws when the file is unreadable or too big */
    read(now) {
      let text;
      try {
        text = fs.readFileSync(file, 'utf8');
      } catch (err) {
        if (err && err.code === 'ENOENT') return { units: [], base: 0 };
        throw err;
      }
      const doc = JSON.parse(text);
      if (!isPlainObject(doc)) throw new Error('not a JSON object');
      if (!fits(doc)) throw new Error(`too big to sync (over ${MAX_DOC_BYTES} bytes)`);
      return { units: [[name, doc]], base: Math.floor(Math.min(fs.statSync(file).mtimeMs, now)) };
    },

    /** The file it replaces or deletes is kept as <name>.bak.local.json. */
    write(units) {
      const unit = units.find(([k]) => k === name);
      if (fs.existsSync(file)) fs.copyFileSync(file, backupOf(file));
      if (!unit) {
        fs.rmSync(file, { force: true });
        return;
      }
      fs.mkdirSync(path.dirname(file), { recursive: true });
      writeAtomic(file, JSON.stringify(unit[1], null, 2) + '\n');
    },
  };
}

/** @param {(fileName: string) => string} resolve e.g. paths.local */
const docProviders = (resolve) => DOCS.map(([name, fileName]) => createDocProvider({ name, file: resolve(fileName) }));

module.exports = { createDocProvider, docProviders, MAX_DOC_BYTES };
