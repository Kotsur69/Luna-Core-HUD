// ============================================================================
// LunaCore - memory between PCs: the mirror <-> the cloud's `memory` scope (main)
// ----------------------------------------------------------------------------
// docs/untouched_docs/rag-stylememory.md, decisions 7-9, 14, 15. The engine is
// configsync.js with three providers: the markdown mirror (src/memorystore.js),
// the per-PC heartbeats (src/memoryhealth.js) and the per-project "where we
// stopped" notes (src/memorynote.js). The transport is the
// `memory` scope of src/cloudsync.js. No cloud, no sync: the mirror and the
// search keep working on this PC alone.
//
// Files next to each other in the config folder:
//   memory/                      the mirror (markdown, one file per memory)
//   memory-sync.local.json       the last sync's snapshot (configsync meta)
//   memory-health.local.json     every PC's heartbeat
//   memory-projects.local.json   the projects with memory switched on
//
// Before a memory leaves the machine it goes through the secret scanner
// (src/hostscrub.js). One that trips it is held back - it stays in the mirror,
// the cloud keeps whatever older version it has - and is listed in status()
// until its text is fixed.
// ============================================================================

'use strict';

const path = require('path');
const { createConfigSync } = require('./configsync');
const { createMemoryProvider, scan } = require('./memorystore');
const { createHealthProvider, touch, summarize } = require('./memoryhealth');
const { readEnabled } = require('./memoryprojects');
const { splitKey } = require('./memoryrecord');
const { createNoteProvider, projectOfNoteKey } = require('./memorynote');
const { scrub } = require('./hostscrub');

const SCOPE = 'memory';
const SYNC_INTERVAL_MS = 60 * 1000;
const SYNC_DEBOUNCE_MS = 3000;
const FIRST_SYNC_MS = 8000;

/** The memory files of one config folder. */
function memoryPaths(configDir) {
  return {
    dir: path.join(configDir, 'memory'),
    meta: path.join(configDir, 'memory-sync.local.json'),
    health: path.join(configDir, 'memory-health.local.json'),
    projects: path.join(configDir, 'memory-projects.local.json'),
  };
}

/** Whether the secret scanner would change anything in the text of a memory or of a "where we stopped" note. */
function hasSecret(record) {
  return [record.title, record.body, record.source, record.text].some((s) => typeof s === 'string' && scrub(s) !== s);
}

/** A unit whose text the secret scanner guards: a memory or a note (src/memorynote.js). */
const guarded = (k) => splitKey(k) !== null || projectOfNoteKey(k) !== null;

/**
 * Wraps a publish hook: memories and notes that hold a secret are not handed on.
 * @param {(doc: {units, gone}) => void} onPublish
 * @param {(keys: string[]) => void} onBlocked called on every publish with the held-back keys
 */
function guardPublish(onPublish, onBlocked) {
  return (doc) => {
    const blocked = [];
    const units = doc.units.filter(({ k, v }) => {
      const held = guarded(k) && hasSecret(v);
      if (held) blocked.push(k);
      return !held;
    });
    onBlocked(blocked);
    onPublish({ units, gone: doc.gone });
  };
}

/**
 * What can be said about the memory store from its files alone (the CLI has
 * nothing else).
 * @returns {{dir: string, count: number, invalid: {file, error}[], blocked: string[],
 *   enabled: string[], machines: object[]}}
 */
function localStatus(configDir, machine, now = Date.now()) {
  const p = memoryPaths(configDir);
  const { records, invalid, ignored } = scan(p.dir);
  return {
    dir: p.dir,
    count: records.length,
    invalid,
    ignored,
    blocked: records.filter(([, r]) => hasSecret(r)).map(([k]) => k),
    enabled: readEnabled(p.projects),
    machines: summarize(p.health, machine, now),
  };
}

/**
 * The real thing for main.js: a sync every minute, soon() after a local change,
 * and one soon after the cloud brings another PC's memories.
 * @param {{cloud: object, machine: string, configDir: string, onChanged?: () => void}} opts
 *   cloud = startCloud()'s result; onChanged fires when the mirror's files changed
 */
function startMemory({ cloud, machine, configDir, onChanged = () => {} }) {
  const p = memoryPaths(configDir);
  const hooks = cloud.hooks(SCOPE);
  let broken = 0; // memory files that do not parse: the sync is paused while > 0
  const sync = createConfigSync({
    providers: [
      createMemoryProvider(p.dir, {
        onInvalid: (list) => {
          broken = list.length;
        },
      }),
      createHealthProvider(p.health),
      // One "where we stopped" note per project, in the same folder (src/memorynote.js).
      createNoteProvider(p.dir),
    ],
    metaFile: p.meta,
    extraPeers: hooks.extraPeers,
    onPublish: guardPublish(hooks.onPublish, (keys) => {
      if (keys.length) console.error(`[memory] ${keys.length} memory file(s) held back by the secret scanner`);
    }),
  });

  /**
   * This PC's heartbeat: "my memories synced at <at>". Not sent while a broken
   * file pauses the sync or the transport reports an error: a PC in that state
   * must look silent to the others, not healthy. A failure here must not stop
   * the memories from syncing.
   */
  function beat() {
    const { lastSync, error } = cloud.memoryStatus();
    if (!lastSync || error || broken) return;
    try {
      touch(p.health, machine, { at: lastSync, count: scan(p.dir).records.length });
    } catch (err) {
      console.error('[memory] heartbeat not written:', (err && (err.code || err.message)) || 'error');
    }
  }
  const run = () => {
    try {
      const changed = sync.syncOnce().includes('memory');
      beat();
      if (changed) onChanged();
    } catch (err) {
      console.error('[memory] sync failed:', (err && (err.code || err.message)) || 'error');
    }
  };
  let timer = setTimeout(run, FIRST_SYNC_MS);
  const interval = setInterval(run, SYNC_INTERVAL_MS);
  interval.unref();
  const soon = () => {
    clearTimeout(timer);
    timer = setTimeout(run, SYNC_DEBOUNCE_MS);
  };
  cloud.onPulled((scope) => scope === SCOPE && soon());

  return {
    /** Debounced sync, e.g. after a memory was written here. */
    soon,
    stop() {
      clearTimeout(timer);
      clearInterval(interval);
    },
    /** localStatus() plus the transport's {ready, lastSync, pending, error}. */
    status: () => ({ ...localStatus(configDir, machine), transport: cloud.memoryStatus() }),
  };
}

module.exports = { startMemory, guardPublish, hasSecret, localStatus, memoryPaths, SCOPE };
