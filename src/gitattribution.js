// ============================================================================
// LunaCore - per-terminal attribution for git-sourced Active Files rows
// ----------------------------------------------------------------------------
// gitfiles.js's GitFileWatcher reads the WHOLE repo's `git status`, so every
// terminal open on the same project used to show every other terminal's
// changes - an idle tab lit up with work it never did. Git cannot say who
// wrote a file, so this module decides it from the one signal LunaCore does
// have per terminal: its own transcript's tool lifecycle.
//
// Rule: a git-detected path is claimed by a session when it first appears (or
// its +/- changes) while that session is ACTIVE - a tool call still running,
// or one that started/ended within ACTIVITY_WINDOW_MS. Once claimed it stays
// claimed, so its stats keep updating after the session goes quiet. A path
// another session's transcript EDITED (exact, structuredPatch-backed) is never
// claimed by anyone else.
//
// Known limit: two sessions running shell tools in the same window can both
// claim one new file. That is ambiguous at git's level of detail and is still
// far closer to the truth than the old "everyone sees everything".
// ============================================================================

'use strict';

const path = require('path');

/** Two GitFileWatcher intervals (5s each) plus slack: a Bash call that wrote
 *  a file just before ending must still count when the next poll sees it. */
const ACTIVITY_WINDOW_MS = 12000;

/** Comparison key only - Windows paths differ in case and slash direction
 *  between git (path.resolve) and the CLI's file_path inputs. */
function pathKey(file) {
  const abs = path.resolve(String(file || ''));
  return process.platform === 'win32' ? abs.toLowerCase() : abs;
}

/** Per-session state: tool activity + which paths it has claimed. */
class SessionAttribution {
  constructor() {
    this.openTools = new Set();
    this.lastToolAt = 0;
    /** Paths this session's own transcript edited (pathKey form). */
    this.edited = new Set();
    /** Paths claimed from git (pathKey form). */
    this.claimed = new Set();
    /** pathKey -> "added:removed" from the previous git emission. */
    this.prevStats = new Map();
  }

  /**
   * Folds transcript tool events (observer.js foldToolEvents() output).
   * @param {{phase:'start'|'end', id?:string, file?:string, added?:number, removed?:number}[]} events
   * @param {number} now
   */
  noteToolEvents(events, now) {
    if (!Array.isArray(events)) return;
    for (const ev of events) {
      if (!ev) continue;
      if (ev.phase === 'start') {
        if (ev.id) this.openTools.add(ev.id);
      } else {
        if (ev.id) this.openTools.delete(ev.id);
        if (ev.file && (ev.added || 0) + (ev.removed || 0) > 0) this.edited.add(pathKey(ev.file));
      }
      this.lastToolAt = now;
    }
  }

  /** @param {number} now */
  isActive(now) {
    return this.openTools.size > 0 || (this.lastToolAt > 0 && now - this.lastToolAt <= ACTIVITY_WINDOW_MS);
  }

  /**
   * Filters one repo-wide git emission down to this session's own paths.
   * @param {{file:string, added:number, removed:number}[]} files
   * @param {{now:number, foreignEdited:Set<string>}} ctx foreignEdited = other
   *   sessions' transcript-edited paths, in pathKey form
   * @returns {{file:string, added:number, removed:number}[]}
   */
  attribute(files, { now, foreignEdited }) {
    const active = this.isActive(now);
    const foreign = foreignEdited instanceof Set ? foreignEdited : new Set();
    const nextStats = new Map();
    const own = [];
    for (const f of Array.isArray(files) ? files : []) {
      if (!f || !f.file) continue;
      const key = pathKey(f.file);
      const stat = `${f.added || 0}:${f.removed || 0}`;
      nextStats.set(key, stat);
      if (!this.claimed.has(key)) {
        const isNewOrChanged = this.prevStats.get(key) !== stat;
        const otherSessionsEdit = foreign.has(key) && !this.edited.has(key);
        if (active && isNewOrChanged && !otherSessionsEdit) this.claimed.add(key);
      }
      if (this.claimed.has(key)) own.push(f);
    }
    this.prevStats = nextStats;
    return own;
  }
}

module.exports = { SessionAttribution, pathKey, ACTIVITY_WINDOW_MS };
