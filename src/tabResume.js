// ============================================================================
// LunaCore - resume the tabs of the last run (after a crash or a power cut)
// ----------------------------------------------------------------------------
// Every `claude` tab LunaCore starts has a pinned conversation id
// (src/launch.js withSessionId). This store keeps the open tabs' ids in
// <userDir>/tabs.local.json while the app runs. On the next start the tabs of
// the run before are offered once ("Resume" next to the new-tab button): each
// one is reopened in its folder with `claude --resume <id>`. Nothing is sent
// to the model - the conversation is only reopened.
//
// File: { current: [tab], previous: [tab] }, tab = {profileId, projectId,
// cwd, transcriptId}. `current` is rewritten on every tab change; at load,
// what was `current` joins `previous` (so a second crash before Mati pressed
// Resume loses nothing). Resume or dismiss empties `previous`.
//
// Not kept: God Mode worker tabs (the run restores those itself), bare
// shells and foreign CLIs (no conversation id), a tab that never wrote a
// transcript (nothing to resume).
//
// Same contract as the config loaders: a broken or missing file is an empty
// list, never a crash; every field is validated on read.
// ============================================================================

'use strict';

const fs = require('fs');
const path = require('path');

const FILE_NAME = 'tabs.local.json';
const MAX_TABS = 20;
const MAX_TEXT = 1024;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const textOrNull = (v) => (typeof v === 'string' && v.length > 0 && v.length <= MAX_TEXT ? v : null);

/**
 * One stored tab, validated. Null when it cannot be resumed.
 * @param {unknown} raw
 * @returns {{profileId: string, projectId: string|null, cwd: string, transcriptId: string}|null}
 */
function cleanTab(raw) {
  if (!isObj(raw)) return null;
  const profileId = textOrNull(raw.profileId);
  const cwd = textOrNull(raw.cwd);
  const transcriptId = typeof raw.transcriptId === 'string' && UUID_RE.test(raw.transcriptId) ? raw.transcriptId.toLowerCase() : null;
  if (!profileId || !cwd || !transcriptId) return null;
  return { profileId, projectId: textOrNull(raw.projectId), cwd, transcriptId };
}

/** Validated tabs, one per conversation, newest kept when over the cap. */
function cleanTabs(list) {
  const seen = new Set();
  const out = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const tab = cleanTab(raw);
    if (!tab || seen.has(tab.transcriptId)) continue;
    seen.add(tab.transcriptId);
    out.push(tab);
  }
  return out.slice(-MAX_TABS);
}

/**
 * The record of a live session, or null for a tab that is not Mati's own
 * `claude` conversation (God Mode worker, bare shell, one-off command).
 * `session.watcher.sessionUuid` follows /clear; transcriptId is the launch id.
 * @param {object} session main.js session
 */
function tabRecord(session) {
  if (!isObj(session) || session.task || session.launchTask || session.commandOverride) return null;
  const id = (session.watcher && session.watcher.sessionUuid) || session.transcriptId;
  return cleanTab({ profileId: session.profileId, projectId: session.projectId, cwd: session.cwd, transcriptId: id });
}

/**
 * @param {object} deps
 * @param {() => string|null} deps.dir folder of the store file (null = not available: nothing is kept)
 * @param {(tab: object) => boolean} [deps.hasTranscript] whether the conversation exists on disk
 * @param {object} [deps.fsImpl]
 * @param {(line: string) => void} [deps.log]
 */
function createTabResume({ dir, hasTranscript = () => true, fsImpl = fs, log = () => {} }) {
  let previous = [];
  let lastWritten = null;

  const filePath = () => {
    const d = dir();
    return d ? path.join(d, FILE_NAME) : null;
  };

  function read() {
    const file = filePath();
    if (!file) return { current: [], previous: [] };
    try {
      const data = JSON.parse(fsImpl.readFileSync(file, 'utf8'));
      return { current: cleanTabs(isObj(data) ? data.current : []), previous: cleanTabs(isObj(data) ? data.previous : []) };
    } catch (err) {
      if (!err || err.code !== 'ENOENT') log(`[tabresume] unreadable store, starting empty: ${err && err.message}`);
      return { current: [], previous: [] };
    }
  }

  function write(current) {
    const file = filePath();
    if (!file) return;
    const body = JSON.stringify({ current, previous }, null, 2);
    if (body === lastWritten) return;
    try {
      const tmp = `${file}.tmp`;
      fsImpl.writeFileSync(tmp, body, { encoding: 'utf8', mode: 0o600 });
      fsImpl.renameSync(tmp, file);
      lastWritten = body;
    } catch (err) {
      log(`[tabresume] could not write the store: ${err && err.message}`);
    }
  }

  return {
    /** Call once at start, BEFORE the first tab opens: last run's tabs become `previous`. */
    load() {
      const stored = read();
      previous = cleanTabs([...stored.previous, ...stored.current]);
      write([]);
      return previous.length;
    },

    /** The open tabs changed (or a tab got a new conversation id). */
    save(sessions) {
      const current = cleanTabs((Array.isArray(sessions) ? sessions : []).map(tabRecord).filter(Boolean));
      // A tab resumed from `previous` is live again: it is no longer "last run".
      const live = new Set(current.map((t) => t.transcriptId));
      previous = previous.filter((t) => !live.has(t.transcriptId));
      write(current);
    },

    /** Last run's tabs that can still be resumed. */
    pending() {
      return previous.filter((tab) => {
        try {
          return hasTranscript(tab) === true;
        } catch {
          return false;
        }
      });
    },

    /** Hands out the resumable tabs and forgets last run (Resume or Dismiss). */
    take() {
      const tabs = this.pending();
      previous = [];
      lastWritten = null;
      return tabs;
    },
  };
}

module.exports = { createTabResume, tabRecord, cleanTab, cleanTabs, FILE_NAME, MAX_TABS };
