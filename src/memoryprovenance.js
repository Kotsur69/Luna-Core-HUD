// ============================================================================
// LunaCore - where one memory came from and what happened to it (main, pure)
// ----------------------------------------------------------------------------
// The 'History' expander of the memory window's list of all memories
// (renderer memoryhistory.js, through memory:provenance in
// src/memorybrainipc.js). Read only. For one memory it gathers:
//
//   source     its `source` line read apart: a session or a God Mode run, the
//              machine, the outside-content note, 'suggested global'
//   chain      what it supersedes, recursively, and what superseded it, both
//              cut at MAX_CHAIN_DEPTH levels; the memories named need not exist
//              any more (a rejected one is deleted), and then have no title
//   refs       its links, conflicts and compatible memories, with titles
//   timeline   its events in THIS PC's memory log (the log is not synced):
//              proposed, approved, edited, ..., conflict, merged; reads are
//              counted, not listed, as there can be hundreds
//
// Everything returned is plain data; the renderer shows it with textContent.
// ============================================================================

'use strict';

const fs = require('fs');
const path = require('path');
const { GLOBAL, scoreOf } = require('./memoryrecord');
const { sourceNotes, wordsOf } = require('./memoryextract');
const { digestTranscript } = require('./memorydigest');
const { parseSteps } = require('./agytranscript');
const { scrub } = require('./hostscrub');

/** How many levels of the chain are followed each way. */
const MAX_CHAIN_DEPTH = 5;
/** Memories one direction of the chain may name in all (each level can hold 20). */
const MAX_CHAIN_NODES = 60;
/** Timeline events returned, the newest ones; `total` says how many there are. */
const MAX_TIMELINE = 60;

/** Log events about the memory itself, shown as they are. */
const OWN_EVENTS = new Set(['proposed', 'approved', 'edited', 'rejected', 'retired', 'auto-accepted', 'superseded', 'restored', 'verified', 'disputed']);

/** The sources LunaCore writes, read apart; anything else is shown as its text alone. */
const SOURCE_FORMS = [
  { kind: 'session', re: /^captured from session ([A-Za-z0-9-]+) on (.+?)(?:, |$)/ },
  { kind: 'session', re: /^proposed in session ([A-Za-z0-9-]+) on (.+?)(?:, |$)/ },
  { kind: 'godmode', re: /^captured from God Mode run (\S+) on (.+?)(?:, |$)/ },
  { kind: 'merged', re: /^merged by hand from ([a-z0-9-]+) and ([a-z0-9-]+)/ },
  { kind: 'auto-memory', re: /^claude auto-memory(?:, session ([A-Za-z0-9-]+))?/ },
];
const AUTO_ACCEPTED_NOTE = ', auto-accepted';

/**
 * A memory's source line read apart.
 * @param {string|null|undefined} source
 * @returns {{text: string, kind: 'session'|'godmode'|'merged'|'auto-memory'|'other'|null,
 *   ref: string|null, machine: string|null, outside: number, suggestedGlobal: boolean, autoAccepted: boolean}}
 *   kind null = the memory has no source (written by hand); ref = the session or run id
 */
function sourceOf(source) {
  const text = typeof source === 'string' ? source : '';
  const notes = sourceNotes(text);
  const base = { text, outside: notes.outside, suggestedGlobal: notes.suggestedGlobal, autoAccepted: text.includes(AUTO_ACCEPTED_NOTE) };
  if (!text) return { ...base, kind: null, ref: null, machine: null };
  for (const { kind, re } of SOURCE_FORMS) {
    const m = re.exec(text);
    if (!m) continue;
    if (kind === 'merged') return { ...base, kind, ref: `${m[1]}, ${m[2]}`, machine: null };
    return { ...base, kind, ref: m[1] || null, machine: m[2] || null };
  }
  return { ...base, kind: 'other', ref: null, machine: null };
}

/** id -> {id, key, title|null}: the project's memory, else a global one, else a name with no title. */
function refOf(byKey, project, id) {
  for (const key of [`${project}/${id}`, `${GLOBAL}/${id}`]) {
    const r = byKey.get(key);
    if (r) return { id, key, title: r.title };
  }
  return { id, key: `${project}/${id}`, title: null };
}

/**
 * One direction of the chain as a tree, MAX_CHAIN_DEPTH levels deep.
 * @param {string} key the memory the tree starts from (not part of it)
 * @param {(key: string) => string[]} next the keys one step further
 * @param {Map<string, object>} byKey
 * @returns {{nodes: object[], cut: boolean}} node = {key, id, title|null, confirmed|null, children};
 *   cut = something was left out (deeper than the cap, or past the node cap). A loop
 *   (a hand-edited file) stops where it closes; a memory two branches share is shown in both.
 */
function chainTree(key, next, byKey) {
  let count = 0;
  let cut = false;
  const grow = (from, depth, path) => {
    const nodes = [];
    for (const k of next(from)) {
      if (path.has(k)) continue;
      if (count >= MAX_CHAIN_NODES) {
        cut = true;
        break;
      }
      count++;
      const r = byKey.get(k);
      const node = { key: k, id: k.slice(k.lastIndexOf('/') + 1), title: r ? r.title : null, confirmed: r ? r.confidence === 'confirmed' : null, children: [] };
      if (depth < MAX_CHAIN_DEPTH) node.children = grow(k, depth + 1, new Set([...path, k]));
      else if (next(k).some((n) => !path.has(n) && n !== k)) cut = true;
      nodes.push(node);
    }
    return nodes;
  };
  return { nodes: grow(key, 1, new Set([key])), cut };
}

/** One log event as the timeline shows it, or null when it is not about this memory. */
function timelineEvent(e, key) {
  if (OWN_EVENTS.has(e.ev) && e.key === key) {
    return { at: e.at, ev: e.ev, ...(e.by ? { by: e.by } : {}), ...(e.note ? { note: e.note } : {}) };
  }
  if (e.ev === 'conflict' && (e.key === key || e.other === key)) {
    return { at: e.at, ev: e.ev, other: e.key === key ? e.other : e.key, ...(e.note ? { note: e.note } : {}) };
  }
  if (e.ev === 'merged' && e.key === key) return { at: e.at, ev: e.ev, from: e.from };
  if (e.ev === 'merged' && Array.isArray(e.from) && e.from.includes(key)) return { at: e.at, ev: e.ev, into: e.key };
  return null;
}

/**
 * This PC's log about one memory.
 * @returns {{events: object[], total: number, reads: {found: number, opened: number, last: number|null}}}
 *   events oldest first, the newest MAX_TIMELINE of them
 */
function timelineOf(events, key) {
  const list = [];
  const reads = { found: 0, opened: 0, last: null };
  const read = (at, field) => {
    reads[field]++;
    reads.last = Math.max(reads.last || 0, at);
  };
  for (const e of Array.isArray(events) ? events : []) {
    if (!e || typeof e !== 'object') continue;
    if (e.ev === 'search' && Array.isArray(e.hits) && e.hits.includes(key)) read(e.at, 'found');
    else if (e.ev === 'get' && e.key === key) read(e.at, 'opened');
    else {
      const item = timelineEvent(e, key);
      if (item) list.push(item);
    }
  }
  list.sort((x, y) => x.at - y.at);
  return { events: list.slice(-MAX_TIMELINE), total: list.length, reads };
}

/**
 * Everything the History expander shows about one memory.
 * @param {[string, object][]} records memorystore.scan().records
 * @param {object[]} events this PC's memory log (memorylog.readLog)
 * @param {string} key a checked key
 * @returns {{ok: true, ...}|{ok: false, reason: 'not-found'}}
 */
function provenance(records, events, key) {
  const byKey = new Map(records);
  const r = byKey.get(key);
  if (!r) return { ok: false, reason: 'not-found' };
  // Who replaced whom: old key -> the keys of the memories that name it in `supersedes`.
  const supersededBy = new Map();
  for (const [k, other] of records) {
    for (const old of other.supersedes) {
      const oldKey = `${other.project}/${old}`;
      supersededBy.set(oldKey, [...(supersededBy.get(oldKey) || []), k]);
    }
  }
  const down = (k) => {
    const rec = byKey.get(k);
    return rec ? rec.supersedes.map((id) => `${rec.project}/${id}`) : [];
  };
  const up = (k) => [...(supersededBy.get(k) || [])].sort();
  const refs = (field) => (r[field] || []).map((id) => refOf(byKey, r.project, id));
  return {
    ok: true,
    key,
    id: r.id,
    project: r.project,
    type: r.type,
    title: r.title,
    confidence: r.confidence,
    created: r.created,
    last_verified: r.last_verified || null,
    last_used: r.last_used || null,
    archived: r.archived || null,
    ...scoreOf(r),
    source: sourceOf(r.source),
    supersedes: chainTree(key, down, byKey),
    supersededBy: chainTree(key, up, byKey),
    links: refs('links'),
    conflicts: refs('conflicts'),
    compatible: refs('compatible'),
    // The log is per PC: the window says so next to the timeline.
    timeline: timelineOf(events, key),
  };
}

// --- the origin-session drawer: the excerpt a memory was proposed from ----------
//
// originSnippet() finds the transcript (a Claude Code session, an agy
// conversation) or the God Mode run report a memory's source names and returns
// the window of about ORIGIN_MAX_LINES lines that shares the most words with
// the memory. Files are looked up only by the id the source line carries, and
// only under the roots main hands in: a file whose real path (symlinks
// resolved) is not inside its root is never read. The excerpt is scrubbed of
// secret-shaped text (src/hostscrub.js) before and after it is cut.

/** The excerpt the drawer shows and Interrogate sends: about 20 lines, about 2,000 characters. */
const ORIGIN_MAX_LINES = 20;
const ORIGIN_MAX_CHARS = 2000;
/** One line of the excerpt is cut here: a long assistant reply would fill the window alone. */
const ORIGIN_LINE_CHARS = 400;
/** Of a longer file only the end is read, as capture does. */
const ORIGIN_READ_BYTES = 8 * 1024 * 1024;
/** Lines of one file that are looked at at all. */
const ORIGIN_MAX_SCAN_LINES = 40000;
/** Transcript lines digested together: a failed call is noted on its own line within one chunk. */
const DIGEST_CHUNK_LINES = 50;
/** Project folders of the Claude Code transcripts dir that are listed, and transcripts tried per memory. */
const MAX_PROJECT_DIRS = 3000;
const MAX_CANDIDATE_FILES = 6;
/** Keywords of the memory a window is matched against, and how many are reported back. */
const MAX_KEYWORDS = 60;
const MAX_MATCHED_SHOWN = 12;
/** A session label (memorypropose.sessionLabel, a transcript name's start) and a God Mode run id. */
const SESSION_REF_RE = /^[A-Za-z0-9-]{1,64}$/;
const RUN_REF_RE = /^[a-z0-9]{1,40}$/;
/** agy's conversation transcripts, newest format first (src/agywatcher.js TRANSCRIPT_FILES). */
const AGY_TRANSCRIPT_FILES = Object.freeze(['transcript_full.jsonl', 'transcript.jsonl']);

const cutLine = (s) => (s.length > ORIGIN_LINE_CHARS ? `${s.slice(0, ORIGIN_LINE_CHARS).trimEnd()} ...` : s);

/**
 * The real path of `file` when it is a regular file inside `root` (both
 * resolved, symlinks followed), else null. A symlink as the file itself is refused.
 * @param {string} root
 * @param {string} file
 * @returns {Promise<string|null>}
 */
async function realInside(root, file) {
  try {
    if (typeof root !== 'string' || !root || typeof file !== 'string' || !file) return null;
    const st = await fs.promises.lstat(file);
    if (!st.isFile() || st.isSymbolicLink()) return null;
    const [realRoot, realFile] = await Promise.all([fs.promises.realpath(root), fs.promises.realpath(file)]);
    const rel = path.relative(realRoot, realFile);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
    return realFile;
  } catch (err) {
    if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) return null;
    throw err;
  }
}

/** Directory entries of `dir`, [] when it does not exist. */
async function entriesOf(dir) {
  try {
    return await fs.promises.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) return [];
    throw err;
  }
}

/** The end of a file as text, ORIGIN_READ_BYTES at most; a cut first line is dropped. */
async function readTail(file) {
  const handle = await fs.promises.open(file, 'r');
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, ORIGIN_READ_BYTES);
    const buf = Buffer.alloc(length);
    await handle.read(buf, 0, length, size - length);
    const text = buf.toString('utf8');
    return length < size ? text.slice(text.indexOf('\n') + 1) : text;
  } finally {
    await handle.close();
  }
}

/**
 * The files a session label may name: Claude Code transcripts whose name starts
 * with it, in any project folder, and agy conversations whose folder does.
 * @returns {Promise<{file: string, root: string, format: 'claude'|'agy'}[]>}
 */
async function sessionCandidates(ref, transcriptsDir, agyDir) {
  const found = [];
  if (typeof transcriptsDir === 'string' && transcriptsDir) {
    const dirs = (await entriesOf(transcriptsDir)).filter((e) => e.isDirectory()).slice(0, MAX_PROJECT_DIRS);
    for (const d of dirs) {
      for (const f of await entriesOf(path.join(transcriptsDir, d.name))) {
        if (f.isFile() && f.name.startsWith(ref) && f.name.endsWith('.jsonl')) {
          found.push({ file: path.join(transcriptsDir, d.name, f.name), root: transcriptsDir, format: 'claude' });
        }
      }
      if (found.length >= MAX_CANDIDATE_FILES) return found;
    }
  }
  if (typeof agyDir === 'string' && agyDir) {
    const lower = ref.toLowerCase();
    for (const d of await entriesOf(agyDir)) {
      if (!d.isDirectory() || !d.name.toLowerCase().startsWith(lower)) continue;
      for (const name of AGY_TRANSCRIPT_FILES) {
        found.push({ file: path.join(agyDir, d.name, '.system_generated', 'logs', name), root: agyDir, format: 'agy' });
      }
      if (found.length >= MAX_CANDIDATE_FILES * 2) break;
    }
  }
  return found;
}

/** A Claude Code transcript as digest lines (src/memorydigest.js): what was typed, answered and run. */
function claudeLines(jsonl) {
  const raw = jsonl.split('\n').slice(-ORIGIN_MAX_SCAN_LINES);
  const out = [];
  for (let i = 0; i < raw.length; i += DIGEST_CHUNK_LINES) {
    const { text } = digestTranscript(raw.slice(i, i + DIGEST_CHUNK_LINES).join('\n'));
    if (text) out.push(...scrub(text).split('\n'));
  }
  return out;
}

/** An agy transcript as one line per step that says something. */
function agyLines(jsonl) {
  const { steps } = parseSteps(jsonl.split('\n').slice(-ORIGIN_MAX_SCAN_LINES).join('\n'));
  const out = [];
  for (const s of steps) {
    const text = (s.content || s.error || '').trim();
    if (!text) continue;
    out.push(...scrub(`${s.type}: ${text}`).split('\n'));
  }
  return out;
}

/** Text lines of a file in the given format, scrubbed, cut, blank ones dropped. */
function linesOf(text, format) {
  let lines;
  if (format === 'claude') lines = claudeLines(text);
  else if (format === 'agy') lines = agyLines(text);
  else lines = scrub(text).split('\n').slice(-ORIGIN_MAX_SCAN_LINES);
  return lines.map((l) => cutLine(l.replace(/\s+$/, ''))).filter((l) => l.trim());
}

/**
 * The window of ORIGIN_MAX_LINES lines that holds the most distinct keywords
 * (ties: the most hits, then the later window: a lesson tends to land late).
 * No hit at all: the last window. Pure.
 * @param {string[]} lines
 * @param {Set<string>} keywords
 * @returns {{start: number, end: number, matched: string[], score: number}}
 */
function bestWindow(lines, keywords) {
  const hits = lines.map((l) => [...wordsOf(l)].filter((w) => keywords.has(w)));
  let best = { start: Math.max(0, lines.length - ORIGIN_MAX_LINES), distinct: 0, total: 0 };
  for (let start = 0; start < lines.length; start++) {
    const slice = hits.slice(start, start + ORIGIN_MAX_LINES);
    const distinct = new Set(slice.flat()).size;
    const total = slice.reduce((n, h) => n + h.length, 0);
    if (distinct > best.distinct || (distinct === best.distinct && distinct > 0 && total >= best.total)) best = { start, distinct, total };
  }
  const end = Math.min(lines.length, best.start + ORIGIN_MAX_LINES);
  const matched = [...new Set(hits.slice(best.start, end).flat())];
  return { start: best.start, end, matched, score: best.distinct };
}

/** The excerpt text of a window: scrubbed whole, cut to ORIGIN_MAX_CHARS, scrubbed again. */
function excerptOf(lines) {
  const joined = scrub(lines.join('\n'));
  if (joined.length <= ORIGIN_MAX_CHARS) return { text: joined, truncated: false };
  return { text: scrub(`${joined.slice(0, ORIGIN_MAX_CHARS).trimEnd()} ...`), truncated: true };
}

/** The keywords of a memory: the words of its title, then of its body, capped. */
function keywordsOf(record) {
  return new Set([...wordsOf(`${record.title || ''} ${record.body || ''}`)].slice(0, MAX_KEYWORDS));
}

/**
 * The excerpt of the session or run a memory was proposed from.
 * @param {{record: {title: string, body: string, source?: string}, transcriptsDir?: string|null,
 *   runsDir?: string|null, agyDir?: string|null}} opts
 *   transcriptsDir = Claude Code's projects folder (~/.claude/projects); runsDir = LunaCore's
 *   run reports (<userDir>/runs, <runId>.md); agyDir = agy's conversations (<agy appData>/brain)
 * @returns {Promise<{ok: true, kind: 'session'|'godmode', format: 'claude'|'agy'|'report', ref: string,
 *   file: string, excerpt: string, lines: number, matched: string[], truncated: boolean}
 *   |{ok: false, reason: 'no-source'|'not-found'|'empty'}>}
 *   file = the file's name only; matched = the memory's words the excerpt holds
 */
async function originSnippet({ record, transcriptsDir = null, runsDir = null, agyDir = null } = {}) {
  if (!record || typeof record !== 'object') return { ok: false, reason: 'no-source' };
  const src = sourceOf(record.source);
  let candidates;
  if (src.kind === 'godmode' && RUN_REF_RE.test(src.ref || '') && typeof runsDir === 'string' && runsDir) {
    candidates = [{ file: path.join(runsDir, `${src.ref}.md`), root: runsDir, format: 'report' }];
  } else if ((src.kind === 'session' || src.kind === 'auto-memory') && SESSION_REF_RE.test(src.ref || '')) {
    candidates = await sessionCandidates(src.ref, transcriptsDir, agyDir);
  } else {
    return { ok: false, reason: 'no-source' };
  }
  const keywords = keywordsOf(record);
  let best = null;
  let read = 0;
  for (const c of candidates) {
    const real = await realInside(c.root, c.file);
    if (!real) continue;
    read++;
    const lines = linesOf(await readTail(real), c.format);
    if (!lines.length) continue;
    const win = bestWindow(lines, keywords);
    if (!best || win.score > best.win.score) best = { c, lines, win };
  }
  if (!best) return { ok: false, reason: read ? 'empty' : 'not-found' };
  const { c, lines, win } = best;
  const { text, truncated } = excerptOf(lines.slice(win.start, win.end));
  return {
    ok: true,
    kind: src.kind === 'godmode' ? 'godmode' : 'session',
    format: c.format,
    ref: src.ref,
    file: path.basename(c.file),
    excerpt: text,
    lines: text.split('\n').length,
    matched: win.matched.slice(0, MAX_MATCHED_SHOWN),
    truncated,
  };
}

module.exports = {
  provenance,
  sourceOf,
  timelineOf,
  chainTree,
  originSnippet,
  bestWindow,
  realInside,
  MAX_CHAIN_DEPTH,
  MAX_CHAIN_NODES,
  MAX_TIMELINE,
  ORIGIN_MAX_LINES,
  ORIGIN_MAX_CHARS,
};
