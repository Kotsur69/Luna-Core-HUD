// ============================================================================
// LunaCore - which host the phone preselects (main)
// ----------------------------------------------------------------------------
// docs/REMOTE_HOST_PLAN.md, host runtime. `--make-default` writes the sync
// unit `host:default` = {machine} (scope `config`, newest wins) through the
// configsync.js provider below; every PC keeps the cloud's value in
// host-default.local.json, so a later --make-default on another host wins
// simply by being newer. A host started without the flag only shows online.
// ============================================================================

'use strict';

const fs = require('fs');
const path = require('path');
const { readDoc, writeAtomic } = require('./projectsync');

const KEY = 'host:default';
const MACHINE_RE = /^[A-Za-z0-9-]{1,63}$/;

const validDefault = (v) =>
  v && typeof v === 'object' && !Array.isArray(v) && typeof v.machine === 'string' && MACHINE_RE.test(v.machine) ? { machine: v.machine } : null;

/** Records this host as the default; the next config sync pushes it. */
function writeDefault(file, machine) {
  if (!MACHINE_RE.test(machine)) throw new Error('bad-machine');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeAtomic(file, JSON.stringify({ machine }) + '\n');
}

/** The default host's machine name, or null. Never throws. */
function readDefault(file) {
  try {
    const v = validDefault(readDoc(file));
    return v ? v.machine : null;
  } catch {
    return null;
  }
}

/** A configsync.js provider for the one unit. */
function createHostDefaultProvider(file) {
  return {
    name: 'host',
    owns: (k) => k === KEY,
    valid: (k, v) => (k === KEY ? validDefault(v) : null),
    read(now) {
      const v = validDefault(readDoc(file));
      // Stamped with the file's change time on a first sync: a fresh
      // --make-default beats an older default from another host.
      const base = v ? Math.floor(Math.min(fs.statSync(file).mtimeMs, now)) : 0;
      return { units: v ? [[KEY, v]] : [], base };
    },
    write(units) {
      const hit = units.find(([k]) => k === KEY);
      if (hit) writeDefault(file, hit[1].machine);
      else fs.rmSync(file, { force: true });
    },
  };
}

module.exports = { createHostDefaultProvider, writeDefault, readDefault, KEY };
