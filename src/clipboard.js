// ============================================================================
// LunaCore - clipboard history (LUNACORE_HUD_WIDGET_PLAN.md §2)
// ----------------------------------------------------------------------------
// Keeps the last MAX_ENTRIES text clips in config/clipboard.local.json so a
// snippet copied ten minutes ago can still be injected into the session.
//
// OFF BY DEFAULT, AND THAT IS NOT A TASTE DECISION. Every other watcher in
// this app reads something the user is already showing us: ports it is
// listening on, the transcript it wrote, its own CPU. A clipboard poller reads
// everything the user copies ANYWHERE on the machine - password managers
// included - and writes it to disk in plain text. LunaCore's whole promise is
// "I only read what the README lists", so this one ships disabled and the user
// turns it on knowing what it does (`clipboardEnabled` in uiprefs.js). That is
// also why the watcher is startable/stoppable at runtime rather than being
// spun up unconditionally at boot like PortWatcher: switching it off has to
// actually stop the reading, not just hide the panel.
//
// The pure half (normalizeEntry / pushEntry / removeEntry) is separated from
// the I/O half for the reason filestat.js documents: it makes the interesting
// behaviour - dedupe, MRU ordering, the cap - testable without a real
// clipboard or a real disk.
// ============================================================================

'use strict';

const fs = require('fs');
const paths = require('./paths');

const file = () => paths.local('clipboard.local.json');

// A history, not a file store. 20 is the number the widget plan asked for.
const MAX_ENTRIES = 20;
// Per-clip cap. Copying a whole file into the terminal is a real thing people
// do, and neither the list nor the JSON on disk should grow to that size - the
// clip is dropped rather than truncated, since a silently half-pasted snippet
// is worse than an absent one.
const MAX_ENTRY_CHARS = 4000;
// Poll interval. Faster than the 2 s samplers because a clipboard write is a
// deliberate user action and the copy usually precedes the paste by a second;
// still cheap, since this is an in-process read, not a shell spawn.
const SAMPLE_MS = 1200;

/**
 * Validates one clip. Returns the trimmed text, or null when it is not worth
 * keeping (empty, whitespace-only, oversized, or not a string at all).
 * @param {unknown} text
 * @returns {string|null}
 */
function normalizeEntry(text) {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (trimmed.length > MAX_ENTRY_CHARS) return null;
  return trimmed;
}

/**
 * Adds a clip to the front of the history.
 *
 * The text IS the identity: re-copying something you already have should move
 * it back to the top, not create a second row that differs only in timestamp.
 * Returns a NEW array (the immutability rule) so a caller holding the old list
 * - the renderer mid-render, say - never sees it mutate underneath.
 *
 * @param {Array<{text:string, at:number}>} list
 * @param {string} text already normalized
 * @param {number} [now]
 * @returns {Array<{text:string, at:number}>}
 */
function pushEntry(list, text, now = Date.now()) {
  const current = Array.isArray(list) ? list : [];
  const without = current.filter((entry) => entry.text !== text);
  return [{ text, at: now }, ...without].slice(0, MAX_ENTRIES);
}

/**
 * Drops one clip by its text (same identity rule as pushEntry).
 * @returns {Array<{text:string, at:number}>} a new array
 */
function removeEntry(list, text) {
  const current = Array.isArray(list) ? list : [];
  return current.filter((entry) => entry.text !== text);
}

/**
 * Sanitizes a raw parsed history: drops malformed rows, re-applies the cap.
 * Boundary validation - the file is user-editable and may predate any of the
 * rules above.
 */
function normalizeHistory(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const text = normalizeEntry(entry.text);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    const at = Number(entry.at);
    out.push({ text, at: Number.isFinite(at) ? at : 0 });
    if (out.length >= MAX_ENTRIES) break;
  }
  return out;
}

/** Reads the stored history; an empty list when the file is missing or corrupt. */
function readHistory() {
  try {
    return normalizeHistory(JSON.parse(fs.readFileSync(file(), 'utf8')));
  } catch {
    return [];
  }
}

/**
 * Writes the history.
 * @returns {boolean} whether the write succeeded
 */
function writeHistory(list) {
  try {
    paths.ensureUserDir();
    const safe = normalizeHistory(list);
    fs.writeFileSync(file(), JSON.stringify(safe, null, 2) + '\n', 'utf8');
    return true;
  } catch {
    return false;
  }
}

/** Deletes the stored history file as well as clearing the list in memory. */
function clearHistory() {
  try {
    fs.rmSync(file(), { force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Polls a clipboard reader and grows the history.
 *
 * `readText` is injected rather than imported from electron so this whole class
 * is testable with a plain function - the same reason ports.js takes its
 * scanner as a parameter in tests.
 */
class ClipboardWatcher {
  /**
   * @param {() => string} readText
   * @param {(list: Array<{text:string, at:number}>) => void} onChange
   * @param {number} [intervalMs]
   */
  constructor(readText, onChange, intervalMs = SAMPLE_MS) {
    this.readText = readText;
    this.onChange = onChange;
    this.intervalMs = intervalMs;
    this.timer = null;
    this.list = [];
    // What the clipboard held on the previous tick. Seeded on start() so
    // whatever was already copied BEFORE the user opted in is not swept up
    // retroactively - only what they copy from here on.
    this.last = null;
  }

  start() {
    if (this.timer) return;
    this.list = readHistory();
    try {
      this.last = normalizeEntry(this.readText());
    } catch {
      this.last = null;
    }
    this.timer = setInterval(() => this.tick(), this.intervalMs);
    if (this.timer.unref) this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One poll. Exposed so a test can drive it without waiting on a timer. */
  tick() {
    let text = null;
    try {
      text = normalizeEntry(this.readText());
    } catch {
      // A clipboard held open by another process throws; skip this tick.
      return;
    }
    if (!text || text === this.last) return;
    this.last = text;
    this.list = pushEntry(this.list, text);
    writeHistory(this.list);
    this.onChange(this.list);
  }

  current() {
    return this.list;
  }

  /** Applies an edit made from the UI (remove/clear) to the live list. */
  setList(list) {
    this.list = normalizeHistory(list);
    writeHistory(this.list);
    this.onChange(this.list);
    return this.list;
  }
}

module.exports = {
  normalizeEntry,
  pushEntry,
  removeEntry,
  normalizeHistory,
  readHistory,
  writeHistory,
  clearHistory,
  ClipboardWatcher,
  MAX_ENTRIES,
  MAX_ENTRY_CHARS,
};
