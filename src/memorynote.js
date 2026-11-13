// ============================================================================
// LunaCore - the "where we stopped" note: one status per project (main + CLI)
// ----------------------------------------------------------------------------
// docs/untouched_docs/rag-stylememory.md, "Improvements proposed after phase 4",
// item 3. Every session capture (src/memorycapture.js) also asks the extractor
// for ONE short status of the project: what was being built, what is done,
// what is left. It is kept as a single file per project, overwritten by the
// next capture that has something to say:
//
//   <dir>/projects/<host>/<owner>/<repo>/_where-we-stopped.md
//   ---
//   date: 2026-11-12
//   session: <the transcript it came from>
//   at: <when that transcript was last written, ms>
//   ---
//   <one paragraph, at most MAX_NOTE_CHARS>
//
// It is a status that decays, not a fact, so it needs no approval and never
// goes through the inbox. It is no memory record either: memorystore.scan()
// skips the file (RESERVED_PREFIX), so search, memory_get, the inbox and the
// review list never see it. Only the project card (src/memorycard.js) shows
// it, framed as data, until it is NOTE_MAX_AGE_DAYS old.
//
// Between PCs it travels in the `memory` scope as the unit
// `<project>/_where-we-stopped` (createNoteProvider, a configsync.js provider
// beside the mirror's). The model writes the text only: project, date and
// session come from the capture. The text is secret-scrubbed before it is
// written, and a note that still trips the scanner (a hand edit) is held back
// from the cloud like a memory (memorysync.guardPublish).
// ============================================================================

'use strict';

const fs = require('fs');
const path = require('path');
const { GLOBAL, DATE_RE, validProject, parseFrontmatter, cleanLine } = require('./memoryrecord');
const { walk } = require('./memorystore');
const { fingerprint } = require('./todosync');
const { scrub } = require('./hostscrub');

const NOTE_ID = '_where-we-stopped';
const NOTE_FILE = `${NOTE_ID}.md`;
const KEY_SUFFIX = `/${NOTE_ID}`;
/** One short paragraph (the plan's "about 600 characters"). */
const MAX_NOTE_CHARS = 600;
/** Less than this is no status worth replacing the last one with. */
const MIN_NOTE_CHARS = 20;
/** Of a longer answer only this much is looked at. */
const MAX_RAW_STATUS_CHARS = 4 * MAX_NOTE_CHARS;
/** The card shows a note up to this many whole days after its date. */
const NOTE_MAX_AGE_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_FILE_BYTES = 16 * 1024;
const CUT_MARK = ' ...';
/** A Claude Code session id (the transcript's file name): a uuid. */
const SESSION_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;
/** What a model writes when it has no status to give. */
const EMPTY_STATUS_RE = /^(none|n\/?a|null|nothing( to (report|note))?|no (meaningful |clear |real )?(status|progress|work)( (to report|to note|in progress))?)[.!]?$/i;

const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const errText = (err) => (err && (err.code || err.message)) || 'error';

/** The unit key of a project's note. */
const noteKey = (project) => `${project}${KEY_SUFFIX}`;

/** `<project>/_where-we-stopped` -> project, or null for any other key. */
function projectOfNoteKey(key) {
  if (typeof key !== 'string' || !key.endsWith(KEY_SUFFIX)) return null;
  const project = key.slice(0, -KEY_SUFFIX.length);
  return project !== GLOBAL && validProject(project) ? project : null;
}

/** One clean line cut to MAX_NOTE_CHARS at a word, with a mark that it was cut. */
function fitNote(text) {
  if (text.length <= MAX_NOTE_CHARS) return text;
  const head = text.slice(0, MAX_NOTE_CHARS - CUT_MARK.length);
  const atWord = head.replace(/\s+\S*$/, '');
  return `${atWord || head}${CUT_MARK}`;
}

/** A note's `at` (ms): a number, or its text as a frontmatter value is read; anything else is unknown. */
function atOf(raw) {
  const n = typeof raw === 'string' && /^\d{1,16}$/.test(raw) ? Number(raw) : raw;
  return Number.isSafeInteger(n) && n >= 0 ? n : undefined;
}

/**
 * Rebuilds a note from untrusted input (a file, a cloud row).
 * @param {unknown} raw
 * @returns {{project: string, text: string, date: string, session: string, at?: number}|null}
 *   at = when the session it came from last wrote its transcript (ms), when known
 */
function checkNote(raw) {
  if (!isObject(raw)) return null;
  if (raw.project === GLOBAL || !validProject(raw.project)) return null;
  const text = typeof raw.text === 'string' ? cleanLine(raw.text) : '';
  if (!text || text.length > MAX_NOTE_CHARS) return null;
  if (typeof raw.date !== 'string' || !DATE_RE.test(raw.date)) return null;
  if (typeof raw.session !== 'string' || !SESSION_RE.test(raw.session)) return null;
  const at = atOf(raw.at);
  return { project: raw.project, text, date: raw.date, session: raw.session, ...(at !== undefined ? { at } : {}) };
}

/**
 * The status the extractor gave (its answer's `status`), or null when it said
 * nothing meaningful: a capture without one leaves the previous note as it is.
 * @param {unknown} answer the parsed JSON the model returned
 * @returns {string|null}
 */
function statusFrom(answer) {
  const raw = isObject(answer) && typeof answer.status === 'string' ? cleanLine(answer.status.slice(0, MAX_RAW_STATUS_CHARS)) : '';
  if (raw.length < MIN_NOTE_CHARS || EMPTY_STATUS_RE.test(raw)) return null;
  return fitNote(raw);
}

/** The mirror file of a project's note; throws on a project that is not one. */
function noteFile(dir, project) {
  if (project === GLOBAL || !validProject(project)) throw new Error('bad note project');
  return path.join(dir, 'projects', ...project.split('/'), NOTE_FILE);
}

const serializeNote = (note) =>
  `---\ndate: ${note.date}\nsession: ${note.session}\n${note.at !== undefined ? `at: ${note.at}\n` : ''}---\n${note.text}\n`;

/** A note file -> note. The path is the identity: `project` comes from where the file lies. */
function noteFromFile(text, project) {
  const parsed = parseFrontmatter(text);
  if (!parsed) return null;
  const { front, body } = parsed;
  return checkNote({ project, text: body, date: front.date, session: front.session, at: front.at });
}

/**
 * Every note in the mirror.
 * @param {string} dir the mirror folder (memorysync.memoryPaths().dir)
 * @returns {{exists: boolean, notes: [string, object][], invalid: {file: string, error: string}[], mtimes: object}}
 *   notes sorted by key; invalid = note files that do not parse (they pause the note sync)
 */
function scanNotes(dir) {
  const notes = [];
  const invalid = [];
  const mtimes = {};
  for (const [file, segments] of walk(path.join(dir, 'projects'))) {
    if (path.basename(file) !== NOTE_FILE) continue;
    const project = segments.join('/');
    // A note in a folder that is no project is never read, like a stray memory file.
    if (project === GLOBAL || !validProject(project)) continue;
    try {
      const stat = fs.statSync(file);
      const note = stat.size <= MAX_FILE_BYTES ? noteFromFile(fs.readFileSync(file, 'utf8'), project) : null;
      if (!note) {
        invalid.push({ file, error: stat.size > MAX_FILE_BYTES ? 'file-too-big' : 'bad-note' });
        continue;
      }
      notes.push([noteKey(project), note]);
      mtimes[noteKey(project)] = Math.floor(stat.mtimeMs);
    } catch (err) {
      invalid.push({ file, error: errText(err) });
    }
  }
  notes.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return { exists: fs.existsSync(dir), notes, invalid, mtimes };
}

/**
 * The note of one project, or null (none, or a file that does not parse).
 * Never throws: no note is a normal outcome for the card.
 * @param {string} dir
 * @param {string|null} project
 */
function readNote(dir, project) {
  if (!project || project === GLOBAL || !validProject(project)) return null;
  try {
    const file = noteFile(dir, project);
    const stat = fs.statSync(file);
    return stat.size <= MAX_FILE_BYTES ? noteFromFile(fs.readFileSync(file, 'utf8'), project) : null;
  } catch (err) {
    if (!err || err.code !== 'ENOENT') console.error('[memory] where-we-stopped note unreadable:', errText(err));
    return null;
  }
}

/**
 * Writes (overwrites) a project's note, atomically. The text is scrubbed of
 * anything secret-shaped and cut to MAX_NOTE_CHARS first, whatever the caller did.
 * @param {string} dir
 * @param {{project: string, text: string, date: string, session: string}} raw
 * @returns {string} the file
 */
function writeNote(dir, raw) {
  const text = isObject(raw) && typeof raw.text === 'string' ? fitNote(cleanLine(scrub(raw.text))) : '';
  const note = checkNote({ ...(isObject(raw) ? raw : {}), text });
  if (!note) throw new Error('invalid where-we-stopped note');
  const file = noteFile(dir, note.project);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  try {
    fs.writeFileSync(tmp, serializeNote(note), 'utf8');
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
  return file;
}

/**
 * writeNote for capture. Pieces are not captured in the order their sessions
 * ran (a backlog after a restart, a long idle tab), so a note never replaces
 * one from a session that wrote later (`at`). A note that cannot be written is
 * logged, never thrown, so it cannot make a transcript piece be paid for again.
 * @param {string} dir
 * @param {{project: string, text: string, date: string, session: string, at: number}} raw
 * @returns {boolean} whether it was written
 */
function saveNote(dir, raw) {
  try {
    const current = isObject(raw) ? readNote(dir, raw.project) : null;
    if (current && current.at !== undefined && !(atOf(raw.at) >= current.at)) return false;
    writeNote(dir, raw);
    return true;
  } catch (err) {
    console.error('[memory] where-we-stopped note not written:', errText(err));
    return false;
  }
}

function removeNote(dir, project) {
  fs.rmSync(noteFile(dir, project), { force: true });
}

/**
 * Whole days from the note's date to `now`. A date up to a day ahead (another
 * time zone, a clock behind) counts as 0; one further ahead, or no real date,
 * counts as Infinity: a note dated in the future would otherwise never expire.
 */
function noteAgeDays(note, now) {
  const at = Date.parse(`${note.date}T00:00:00Z`);
  if (!Number.isFinite(at) || at - now > DAY_MS) return Infinity;
  return Math.max(0, Math.floor((now - at) / DAY_MS));
}

/** Whether the card still shows a note: at most NOTE_MAX_AGE_DAYS old. */
const isFreshNote = (note, now) => Boolean(note) && noteAgeDays(note, now) <= NOTE_MAX_AGE_DAYS;

/**
 * The notes as a configsync.js provider for the cloud's `memory` scope.
 * Like the mirror's provider, a file that does not parse stops this provider's
 * sync (read() throws) instead of looking deleted on the other PCs.
 * @param {string} dir the mirror folder
 */
function createNoteProvider(dir) {
  return {
    name: 'memory-notes',
    owns: (k) => projectOfNoteKey(k) !== null,
    valid(k, v) {
      const note = checkNote(v);
      // A note with something secret-shaped in it is not taken from the cloud either.
      return note && noteKey(note.project) === k && scrub(note.text) === note.text ? note : null;
    },
    read() {
      const { exists, notes, invalid, mtimes } = scanNotes(dir);
      // configsync logs this on every sync until the file is fixed or a capture rewrites it.
      if (invalid.length) throw new Error(`${invalid.length} where-we-stopped note(s) do not parse, e.g. ${invalid[0].file} (${invalid[0].error})`);
      // As for the memories: on a first sync each file counts from its own change time.
      return { units: notes, base: 0, stamps: mtimes, fresh: !exists };
    },
    write(units, local) {
      const before = new Map(local.units.map(([k, v]) => [k, fingerprint(v)]));
      const keep = new Set();
      for (const [k, v] of units) {
        keep.add(k);
        if (before.get(k) !== fingerprint(v)) writeNote(dir, v);
      }
      for (const k of before.keys()) if (!keep.has(k)) removeNote(dir, projectOfNoteKey(k));
    },
  };
}

module.exports = {
  checkNote,
  statusFrom,
  noteKey,
  projectOfNoteKey,
  noteFile,
  scanNotes,
  readNote,
  writeNote,
  saveNote,
  noteAgeDays,
  isFreshNote,
  createNoteProvider,
  NOTE_ID,
  NOTE_FILE,
  MAX_NOTE_CHARS,
  NOTE_MAX_AGE_DAYS,
};
