// ============================================================================
// LunaCore - memory between PCs: the mirror <-> the cloud's `memory` scope (main)
// ----------------------------------------------------------------------------
// docs/untouched_docs/rag-stylememory.md, decisions 7-9, 14, 15. The engine is
// configsync.js with four providers: the markdown mirror (src/memorystore.js),
// the per-PC heartbeats (src/memoryhealth.js), the per-PC review signals
// (rejections, disputes, reads: src/memorysignals.js) and the per-project
// "where we stopped" notes (src/memorynote.js). The transport is the
// `memory` scope of src/cloudsync.js. No cloud, no sync: the mirror and the
// search keep working on this PC alone.
//
// Files next to each other in the config folder:
//   memory/                      the mirror (markdown, one file per memory)
//   memory-sync.local.json       the last sync's snapshot (configsync meta)
//   memory-health.local.json     every PC's heartbeat
//   memory-signals.local.json    every PC's review signals
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
const { splitKey, extraFields } = require('./memoryrecord');
const { createNoteProvider, projectOfNoteKey } = require('./memorynote');
const { scrub } = require('./hostscrub');
const { createSignalsProvider, publishSignals, collectSignals, readPeers, setPeerSource, clearPeerSource } = require('./memorysignals');

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
    signals: path.join(configDir, 'memory-signals.local.json'),
    projects: path.join(configDir, 'memory-projects.local.json'),
    // The per-type auto-accept switches (src/memoryautoaccept.js), synced in the config scope.
    autoAccept: path.join(configDir, 'memory-autoaccept.local.json'),
    // The auto-recall switch (src/memoryrecallhook.js), synced the same way.
    recall: path.join(configDir, 'memory-recall.local.json'),
  };
}

/** A carried key (lowercase snake_case) whose last word says its value is a secret. */
const SECRET_KEY_TAIL_RE = /(?:^|_)(?:key|apikey|token|secret|password|passwd|pwd)$/;

/**
 * Whether the secret scanner would change anything in the text of a memory or
 * of a "where we stopped" note. The fields a newer version wrote (record.extra)
 * leave the machine too, so their values are scanned as well. A key that names a
 * secret as its last word (db_password, api_key) is scanned as `key=value`: the
 * scrubber knows a secret by its name only in that shape, and the joined text
 * still holds the whole value for every other rule. Any other key is left out,
 * because the scrubber also flags names like token_count or password_hint, and
 * one such harmless field would hold the whole memory back from the sync.
 */
function hasSecret(record) {
  const carried = extraFields(record.extra).map(([key, value]) => (SECRET_KEY_TAIL_RE.test(key) ? `${key}=${value}` : value));
  return [record.title, record.body, record.source, record.text, ...carried].some((s) => typeof s === 'string' && scrub(s) !== s);
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
 * It also registers the other PCs' review signals as memorysignals.peerSignals(),
 * and publishes this PC's (from `log`) when they are due.
 * @param {{cloud: object, machine: string, configDir: string, onChanged?: () => void,
 *   log?: {read: () => object[]}|null}} opts
 *   cloud = startCloud()'s result; onChanged fires when the mirror's files changed;
 *   log = the memory log (src/memorylog.js); none = this PC publishes no signals
 */
function startMemory({ cloud, machine, configDir, onChanged = () => {}, log = null }) {
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
      // This PC's rejections, open disputes and reads, and the other PCs' (src/memorysignals.js).
      createSignalsProvider(p.signals),
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
  const peers = () => readPeers(p.signals, machine);
  setPeerSource(peers);

  /** This PC's signals into the file, when due; they travel with this sync. A failure here must not stop the sync. */
  function signal() {
    if (!log || typeof log.read !== 'function') return;
    try {
      const now = Date.now();
      // The peers are read after publishSignals has healed a broken file.
      publishSignals(p.signals, machine, () => collectSignals(log.read() || [], now, readPeers(p.signals, machine, now)), now);
    } catch (err) {
      console.error('[memory] signals not written:', (err && (err.code || err.message)) || 'error');
    }
  }
  const run = () => {
    try {
      signal();
      const names = sync.syncOnce();
      // Another PC's signals can add or settle a dispute on the review list.
      const changed = names.includes('memory') || names.includes('memory-signals');
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
      clearPeerSource(peers);
    },
    /** localStatus() plus the transport's {ready, lastSync, pending, error}. */
    status: () => ({ ...localStatus(configDir, machine), transport: cloud.memoryStatus() }),
  };
}

module.exports = { startMemory, guardPublish, hasSecret, localStatus, memoryPaths, SCOPE };
