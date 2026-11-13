// ============================================================================
// LunaCore - one memory: its shape, its markdown file, its sync key (pure)
// ----------------------------------------------------------------------------
// docs/untouched_docs/rag-stylememory.md, section 4. A memory is one fact:
//
//   ---
//   id: worktree-node-modules-junction
//   type: gotcha
//   project: github.com/owner/repo      (or `global`)
//   title: Do not junction node_modules into a worktree
//   created: 2026-10-21
//   confidence: confirmed
//   supersedes: []
//   links: [gm-deps-asar-lock]
//   ---
//   <markdown body>
//
// Optional, only once something set them (brainFields()): usefulness (0-100),
// usefulness_note, usefulness_at, last_used, archived, conflicts, compatible.
//
// The same record travels three ways: as that file in the local mirror
// (src/memorystore.js), as the `value` of a sync unit in the cloud's `memory`
// scope, and as a row of the search index (src/memoryindex.js). It is FLAT on
// purpose: Postgres jsonb reorders nested keys, and the sync fingerprint
// (todosync.fingerprint) only sorts the top level.
//
// The unit key is `<project>/<id>`. A project is its normalised origin remote
// (`host/owner/repo`, src/missionrepokey.js) so two PCs with different user
// folders agree on it; `global` holds what is true everywhere.
//
// Everything here is untrusted input at some point (a hand-edited file, a row
// another machine wrote), so checkRecord() rebuilds the record field by field
// and drops what it does not know.
// ============================================================================

'use strict';

const TYPES = ['decision', 'gotcha', 'how-to', 'project-fact', 'preference', 'domain', 'digest', 'reference'];
const CONFIDENCE = ['confirmed', 'observed', 'inferred'];
const GLOBAL = 'global';

const ID_RE = /^[a-z0-9][a-z0-9-]{0,79}$/;
const AREA_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const SEGMENT_RE = /^[a-z0-9][a-z0-9._-]*$/;
// A project segment becomes a folder of the mirror. One that ends like a
// memory file (`x.md`) or its temp file would collide with that file and make
// every later write fail; a trailing dot is not a name Windows tools can use.
const RESERVED_SEGMENT_RE = /(\.md|\.tmp|\.)$/;
/** host/owner/repo, plus the sub-groups some hosts allow. */
const MIN_PROJECT_SEGMENTS = 3;
const MAX_PROJECT_SEGMENTS = 8;
const MAX_PROJECT = 110;
const MAX_TITLE = 200;
const MAX_SOURCE = 300;
const MAX_REFS = 20;
/** One fact, a few hundred words. Units sync whole, newest wins (decision 18). */
const MAX_BODY = 5000;
/** configsync.js refuses to push a value over docsync.MAX_DOC_BYTES (7000). */
const MAX_RECORD_BYTES = 6500;
/** The usefulness scan's score runs 0-100; its reason is one short line. */
const MAX_USEFULNESS = 100;
const MAX_USEFULNESS_NOTE = 200;

const isPlainObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

// Control characters (terminal escapes, NUL), invisible format characters
// (zero-width, bidi overrides) and Unicode tag characters have no place in a
// fact and can hide text from the person reviewing it. Postgres jsonb also
// refuses NUL and lone surrogates: one such unit would fail its whole push batch.
const INVISIBLE_RE = /[\p{Cc}\p{Cf}\u{E0000}-\u{E007F}]/gu;
const INVISIBLE_KEEP_LINES_RE = /(?![\n\t])[\p{Cc}\p{Cf}\u{E0000}-\u{E007F}]/gu;
/** One line of clean text. */
const cleanLine = (s) => s.toWellFormed().replace(INVISIBLE_RE, ' ').replace(/\s+/g, ' ').trim();
/** Multi-line clean text: newlines and tabs stay. */
const cleanText = (s) => s.replace(/\r\n?/g, '\n').toWellFormed().replace(INVISIBLE_KEEP_LINES_RE, '').trim();

/** `global` or a normalised remote; never a path segment like `..`. */
function validProject(p) {
  if (p === GLOBAL) return true;
  if (typeof p !== 'string' || p.length > MAX_PROJECT) return false;
  const parts = p.split('/');
  if (parts.length < MIN_PROJECT_SEGMENTS || parts.length > MAX_PROJECT_SEGMENTS) return false;
  return parts.every((s) => SEGMENT_RE.test(s) && !RESERVED_SEGMENT_RE.test(s));
}

/** `git:host/owner/repo` (missionrepokey) or a bare remote -> project, or null. */
function projectFromRepoKey(key) {
  if (typeof key !== 'string') return null;
  const p = key.startsWith('git:') ? key.slice(4) : key;
  return p !== GLOBAL && validProject(p) ? p : null;
}

const keyOf = (record) => `${record.project}/${record.id}`;

/** `<project>/<id>` -> {project, id}, or null. */
function splitKey(key) {
  const i = typeof key === 'string' ? key.lastIndexOf('/') : -1;
  if (i < 1) return null;
  const project = key.slice(0, i);
  const id = key.slice(i + 1);
  return validProject(project) && ID_RE.test(id) ? { project, id } : null;
}

function refs(list) {
  if (!Array.isArray(list)) return [];
  return [...new Set(list.filter((x) => typeof x === 'string' && ID_RE.test(x)))].slice(0, MAX_REFS);
}

/**
 * Rebuilds a record from untrusted input.
 * @returns {{record: object}|{error: string}} error = the first field that failed
 */
function checkRecord(raw) {
  if (!isPlainObject(raw)) return { error: 'not-an-object' };
  if (typeof raw.id !== 'string' || !ID_RE.test(raw.id)) return { error: 'bad-id' };
  if (!TYPES.includes(raw.type)) return { error: 'bad-type' };
  if (!validProject(raw.project)) return { error: 'bad-project' };
  const title = typeof raw.title === 'string' ? cleanLine(raw.title) : '';
  if (!title || title.length > MAX_TITLE) return { error: 'bad-title' };
  const body = typeof raw.body === 'string' ? cleanText(raw.body) : '';
  if (!body) return { error: 'empty-body' };
  if (body.length > MAX_BODY) return { error: 'body-too-long' };
  if (typeof raw.created !== 'string' || !DATE_RE.test(raw.created)) return { error: 'bad-created' };
  if (!CONFIDENCE.includes(raw.confidence)) return { error: 'bad-confidence' };
  if (raw.last_verified != null && (typeof raw.last_verified !== 'string' || !DATE_RE.test(raw.last_verified))) {
    return { error: 'bad-last-verified' };
  }
  if (raw.area != null && (typeof raw.area !== 'string' || !AREA_RE.test(raw.area))) return { error: 'bad-area' };
  if (raw.source != null && typeof raw.source !== 'string') return { error: 'bad-source' };
  const source = cleanLine((raw.source || '').slice(0, MAX_SOURCE));

  const record = {
    id: raw.id,
    type: raw.type,
    project: raw.project,
    ...(raw.area ? { area: raw.area } : {}),
    title,
    created: raw.created,
    ...(raw.last_verified ? { last_verified: raw.last_verified } : {}),
    ...(source ? { source } : {}),
    confidence: raw.confidence,
    ...brainFields(raw),
    supersedes: refs(raw.supersedes),
    links: refs(raw.links).filter((x) => x !== raw.id),
    body,
  };
  if (Buffer.byteLength(JSON.stringify(record), 'utf8') > MAX_RECORD_BYTES) return { error: 'record-too-big' };
  return { record };
}

/** usefulness 0-100 as a number, or as the text a frontmatter line holds; anything else -> null. */
function toScore(v) {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d{1,3}$/.test(v.trim()) ? Number(v) : NaN;
  return Number.isInteger(n) && n >= 0 && n <= MAX_USEFULNESS ? n : null;
}
const isDate = (v) => typeof v === 'string' && DATE_RE.test(v);

/**
 * The optional fields the usefulness scan, decay and the conflict resolver add
 * (src/memoryscan.js, src/memorydecay.js, src/memoryconflict.js). A record
 * without them gets none: an older file loads, and syncs, exactly as before.
 * A bad value is dropped instead of failing the record: these fields are
 * advisory, and a file that does not parse pauses the whole sync.
 */
function brainFields(raw) {
  const out = {};
  const score = toScore(raw.usefulness);
  if (score !== null) {
    out.usefulness = score;
    const note = typeof raw.usefulness_note === 'string' ? cleanLine(raw.usefulness_note).slice(0, MAX_USEFULNESS_NOTE) : '';
    if (note) out.usefulness_note = note;
    if (isDate(raw.usefulness_at)) out.usefulness_at = raw.usefulness_at;
  }
  if (isDate(raw.last_used)) out.last_used = raw.last_used;
  if (isDate(raw.archived)) out.archived = raw.archived;
  for (const field of ['conflicts', 'compatible']) {
    const ids = refs(raw[field]).filter((x) => x !== raw.id);
    if (ids.length) out[field] = ids;
  }
  return out;
}

/** A record's score for the UI: {usefulness, usefulness_note} with null when it was never scanned. */
const scoreOf = (record) => ({
  usefulness: Number.isInteger(record.usefulness) ? record.usefulness : null,
  usefulness_note: record.usefulness_note || null,
});

/** A clean record, or null. */
function normalizeRecord(raw) {
  const res = checkRecord(raw);
  return res.record || null;
}

// --- frontmatter ---------------------------------------------------------------
// A small YAML subset, enough for these files and for Claude Code auto-memory:
// `key: value`, quoted strings, inline lists, and one level of nesting.

function parseScalar(text) {
  const s = text.trim();
  if (s.startsWith('"')) {
    try {
      const v = JSON.parse(s);
      if (typeof v === 'string') return v;
    } catch {
      /* not a JSON string: fall through and keep the text */
    }
    return s.replace(/^"|"$/g, '');
  }
  if (s.length >= 2 && s.startsWith("'") && s.endsWith("'")) return s.slice(1, -1).replace(/''/g, "'");
  // An unquoted value ends at a ` #` comment, as in YAML.
  return s.replace(/\s+#.*$/, '').trim();
}

function parseValue(text) {
  const s = text.trim();
  const list = /^\[(.*)\]\s*(#.*)?$/.exec(s);
  if (!list) return parseScalar(s);
  return list[1]
    .split(',')
    .map((x) => parseScalar(x))
    .filter((x) => x !== '');
}

const unsafeKey = (k) => k === '__proto__' || Object.hasOwn(Object.prototype, k);

/**
 * @param {string} text a markdown file
 * @returns {{front: object, body: string}|null} null when there is no frontmatter block
 */
function parseFrontmatter(text) {
  if (typeof text !== 'string') return null;
  const lines = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n');
  if (lines[0].trim() !== '---') return null;
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
  if (end < 0) return null;
  const front = {};
  let parent = null;
  for (const line of lines.slice(1, end)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const m = /^(\s*)([A-Za-z_][\w-]*):(.*)$/.exec(line);
    if (!m || unsafeKey(m[2])) continue;
    const [, indent, key, rest] = m;
    if (indent && parent) {
      front[parent][key] = parseValue(rest);
    } else if (!indent && !rest.trim()) {
      parent = key;
      front[key] = {};
    } else if (!indent) {
      parent = null;
      front[key] = parseValue(rest);
    }
  }
  return { front, body: lines.slice(end + 1).join('\n').trim() };
}

const BARE_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]*( [A-Za-z0-9._/-]+)*$/;
const emit = (v) => (BARE_RE.test(v) ? v : JSON.stringify(v));

/** A record -> the markdown file the mirror keeps. parse(serialize(r)) gives r back. */
function serializeRecord(record) {
  const front = [
    ['id', record.id],
    ['type', record.type],
    ['project', record.project],
    ['area', record.area],
    ['title', record.title],
    ['created', record.created],
    ['last_verified', record.last_verified],
    ['source', record.source],
    ['confidence', record.confidence],
    ['usefulness', record.usefulness === undefined ? undefined : String(record.usefulness)],
    ['usefulness_note', record.usefulness_note],
    ['usefulness_at', record.usefulness_at],
    ['last_used', record.last_used],
    ['archived', record.archived],
  ]
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}: ${emit(v)}`);
  front.push(`supersedes: [${record.supersedes.join(', ')}]`, `links: [${record.links.join(', ')}]`);
  // Written only when set, so a file without them stays byte for byte the same.
  for (const field of ['conflicts', 'compatible']) if (Array.isArray(record[field]) && record[field].length) front.push(`${field}: [${record[field].join(', ')}]`);
  return `---\n${front.join('\n')}\n---\n${record.body}\n`;
}

/** The first line of a body as a title, when a hand-written file has none. */
function titleFromBody(body) {
  const line = body.split('\n').find((l) => l.trim()) || '';
  return line
    .replace(/^[#>*\-\s]+/, '')
    .replace(/[*_`]/g, '')
    .trim()
    .slice(0, 120);
}

/**
 * A mirror file -> record. The path is the identity: `project` and `id` come
 * from where the file lies, whatever its frontmatter says.
 * @param {string} text
 * @param {{project: string, id: string}} where
 * @returns {{record: object}|{error: string}}
 */
function recordFromFile(text, { project, id }) {
  const parsed = parseFrontmatter(text);
  if (!parsed) return { error: 'no-frontmatter' };
  const { front, body } = parsed;
  return checkRecord({
    ...front,
    id,
    project,
    title: typeof front.title === 'string' && front.title.trim() ? front.title : titleFromBody(body),
    // A file written by hand, or by an agent, is not confirmed until Mati says so.
    confidence: front.confidence === undefined ? 'observed' : front.confidence,
    body,
  });
}

// --- Claude Code auto-memory ---------------------------------------------------

/** Auto-memory `metadata.type` -> memory type. */
const AUTO_TYPE = { user: 'preference', feedback: 'preference', project: 'project-fact', reference: 'reference' };

const slug = (s) =>
  String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);

/**
 * One Claude Code auto-memory file (~/.claude/projects/<slug>/memory/*.md) ->
 * record. These were written on purpose and are loaded into every session
 * today, so they arrive `confirmed`.
 * @param {string} text
 * @param {{fileId: string, project: string, fallbackDate: string}} ctx
 * @returns {{record: object}|{error: string}}
 */
function fromAutoMemory(text, { fileId, project, fallbackDate }) {
  const parsed = parseFrontmatter(text);
  if (!parsed) return { error: 'no-frontmatter' };
  const { front, body } = parsed;
  const meta = isPlainObject(front.metadata) ? front.metadata : {};
  const autoType = typeof meta.type === 'string' ? meta.type : front.type;
  const modified = typeof meta.modified === 'string' ? meta.modified.slice(0, 10) : '';
  const session = typeof meta.originSessionId === 'string' ? meta.originSessionId.replace(/[^A-Za-z0-9-]/g, '').slice(0, 64) : '';
  const id = slug(typeof front.name === 'string' && front.name ? front.name : fileId);
  return checkRecord({
    id,
    type: AUTO_TYPE[autoType] || 'project-fact',
    // What is known about the user holds in every project.
    project: autoType === 'user' ? GLOBAL : project,
    title: typeof front.description === 'string' && front.description.trim() ? front.description.slice(0, MAX_TITLE) : titleFromBody(body),
    created: DATE_RE.test(modified) ? modified : fallbackDate,
    source: session ? `claude auto-memory, session ${session}` : 'claude auto-memory',
    confidence: 'confirmed',
    supersedes: [],
    links: [...body.matchAll(/\[\[([a-z0-9-]+)\]\]/g)].map((m) => m[1]),
    body,
  });
}

module.exports = {
  TYPES,
  CONFIDENCE,
  GLOBAL,
  MAX_BODY,
  MAX_TITLE,
  MAX_SOURCE,
  MAX_RECORD_BYTES,
  MAX_USEFULNESS,
  MAX_USEFULNESS_NOTE,
  slug,
  scoreOf,
  validProject,
  projectFromRepoKey,
  keyOf,
  splitKey,
  checkRecord,
  normalizeRecord,
  parseFrontmatter,
  serializeRecord,
  recordFromFile,
  fromAutoMemory,
};
