// ============================================================================
// LunaCore - which files named by memories changed since they were checked (main + CLI)
// ----------------------------------------------------------------------------
// The review list's 'changed' flag (src/memoryreview.js): a confirmed memory
// names files of its repository in backticks (anchorsOf), and one of them has
// a commit after the day the memory was last known to be true (checkedOn). The
// memory may describe code that is not there any more, so it goes on Mati's
// review list. Nothing is edited or deleted here: this file only reads git.
//
// reviewList stays pure and synchronous. It takes the result of this file as
// data: {<project>: Map<anchorPath, newestCommitISO>}. Git runs here, never
// per memory and never from a render loop:
//
//   per project root ONE `git log --since=<oldest check day> --name-only --
//   <every anchor path>` (execFile, no shell, GIT_TIMEOUT_MS), parsed into the Map;
//   at most one call in flight per project; the answer is cached until the
//   repository's HEAD moves or CHANGES_TTL_MS passes.
//
// Hanging git calls once piled up by the hundred in this app, hence the
// in-flight guard and the cache. A failed call yields no 'changed' flags for
// that project and one console.error with the reason; it is cached like an
// answer, so a broken repository is not asked again on every repaint.
// ============================================================================

'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { DATE_RE } = require('./memoryrecord');
const { anchorsOf, checkedOn, supersededKeys } = require('./memoryreview');
const { findRepo } = require('./missionrepokey');

/** A cached answer is asked again after this long, even when HEAD did not move. */
const CHANGES_TTL_MS = 2 * 60 * 1000;
/** One git log of one project; a slower one is killed and counts as failed. */
const GIT_TIMEOUT_MS = 15000;
const GIT_MAX_BUFFER = 8 * 1024 * 1024;
/**
 * Past this many characters of paths the call names no paths and the answer
 * is filtered here instead: Windows caps a command line at 32,767 characters.
 */
const MAX_PATHSPEC_CHARS = 16000;
/** Starts a commit's line in the git output; a file name never holds it. */
const COMMIT_MARK = '\u0001';
const DAY_MS = 24 * 60 * 60 * 1000;
/** A loose ref or HEAD file is a line or two; anything bigger is not read. */
const MAX_REF_BYTES = 4096;

/** Characters of git's own first stderr line kept in a failure's reason. */
const MAX_STDERR_REASON_CHARS = 200;
/** Node's code for a child whose output passed maxBuffer (it is killed too). */
const MAXBUFFER_CODE = 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';

const errText = (err) => (err && (err.code || err.message)) || 'error';
const isMap = (v) => v instanceof Map;

/** The first non-empty line of git's stderr: no colour codes, no control characters, capped. */
function firstStderrLine(stderr) {
  const lines = String(stderr || '').split(/\r?\n/);
  const said = lines.find((l) => l.trim()) || '';
  return said
    .replace(/\u001b\[[0-9;]*[A-Za-z]/g, '')
    .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .trim()
    .slice(0, MAX_STDERR_REASON_CHARS)
    .trim();
}

/**
 * Why a git call failed, in a few words. Never err.message: it repeats the
 * whole command line (the repository folder and every anchor path).
 * @param {Error & {code?: string|number|null, killed?: boolean, signal?: string|null}} error execFile's error
 * @param {string} stderr
 * @returns {string}
 */
function gitFailure(error, stderr) {
  // A child over maxBuffer is killed as well: say which limit it hit.
  if (error.code === MAXBUFFER_CODE) return 'output too large';
  if (error.killed) return 'timeout';
  if (typeof error.code === 'number') {
    const said = firstStderrLine(stderr);
    return said ? `exit ${error.code}: ${said}` : `exit ${error.code}`;
  }
  return error.code || error.signal || 'error';
}

/** The day before `day` (YYYY-MM-DD): git reads a bare date as that day at the current time of day. */
const dayBefore = (day) => new Date(Date.parse(`${day}T00:00:00Z`) - DAY_MS).toISOString().slice(0, 10);

/**
 * What to ask git per project: the anchors of its confirmed, active memories
 * and the oldest day one of them was checked.
 * @param {[string, object][]} records memorystore.scan().records
 * @param {object} roots {<project>: its repository folder on this PC}
 * @returns {Object<string, {root: string, since: string, paths: string[]}>} paths sorted, without repeats
 */
function changeQueries(records, roots) {
  const known = roots && typeof roots === 'object' ? roots : {};
  const gone = supersededKeys(records);
  const byProject = new Map();
  for (const [key, record] of records) {
    if (record.confidence !== 'confirmed' || record.archived || gone.has(key)) continue;
    const root = Object.hasOwn(known, record.project) ? known[record.project] : null;
    if (typeof root !== 'string' || !path.isAbsolute(root)) continue;
    const anchors = anchorsOf(record.body);
    const since = checkedOn(record);
    if (!anchors.length || !DATE_RE.test(String(since))) continue;
    const q = byProject.get(record.project) || { root, since, paths: new Set() };
    for (const anchor of anchors) q.paths.add(anchor);
    byProject.set(record.project, { ...q, since: since < q.since ? since : q.since });
  }
  const out = {};
  for (const [project, q] of byProject) out[project] = { root: q.root, since: q.since, paths: [...q.paths].sort() };
  return out;
}

/**
 * The git arguments of one query. No shell: every value is one argument.
 * --literal-pathspecs: a `[` in a memory's path is a character, not a glob.
 * @param {{root: string, since: string, paths: string[]}} query
 * @returns {string[]}
 */
function gitArgs({ root, since, paths }) {
  const named = paths.reduce((sum, p) => sum + p.length + 1, 0) <= MAX_PATHSPEC_CHARS;
  return [
    '-C',
    root,
    '-c',
    'core.quotepath=off',
    '--literal-pathspecs',
    'log',
    `--since=${dayBefore(since)}`,
    `--format=${COMMIT_MARK}%cI`,
    '--name-only',
    '--no-color',
    '--no-show-signature',
    ...(named ? ['--', ...paths] : []),
  ];
}

/**
 * git log output -> the newest commit time of each wanted path.
 * @param {string} stdout `--format=<COMMIT_MARK>%cI --name-only`
 * @param {string[]} paths the anchors asked about; any other file is ignored
 * @returns {Map<string, string>} path -> ISO time (UTC) of its newest commit
 */
function parseChanges(stdout, paths) {
  const wanted = new Set(paths);
  const newest = new Map();
  let at = null;
  for (const raw of String(stdout || '').split('\n')) {
    const row = raw.replace(/\r$/, '');
    if (row.startsWith(COMMIT_MARK)) {
      const ms = Date.parse(row.slice(COMMIT_MARK.length).trim());
      at = Number.isFinite(ms) ? ms : null;
      continue;
    }
    const file = row.trim();
    if (!file || at === null || !wanted.has(file)) continue;
    const seen = newest.get(file);
    if (!seen || Date.parse(seen) < at) newest.set(file, new Date(at).toISOString());
  }
  return newest;
}

/**
 * Runs one query. Never rejects.
 * @param {{root: string, since: string, paths: string[]}} query
 * @param {{exec?: Function}} [opts]
 * @returns {Promise<{ok: true, changes: Map<string, string>}|{ok: false, reason: string}>}
 */
function readChanges(query, { exec = execFile } = {}) {
  const { root, since, paths } = query || {};
  if (typeof root !== 'string' || !path.isAbsolute(root) || !DATE_RE.test(String(since)) || !Array.isArray(paths) || !paths.length) {
    return Promise.resolve({ ok: false, reason: 'bad-query' });
  }
  return new Promise((resolve) => {
    try {
      exec('git', gitArgs({ root, since, paths }), { timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER, windowsHide: true }, (error, stdout, stderr) => {
        if (error) return resolve({ ok: false, reason: gitFailure(error, stderr) });
        resolve({ ok: true, changes: parseChanges(stdout, paths) });
      });
    } catch (err) {
      resolve({ ok: false, reason: errText(err) });
    }
  });
}

/** A small file's text, or null. */
function readSmall(file) {
  try {
    if (fs.statSync(file).size > MAX_REF_BYTES) return null;
    return fs.readFileSync(file, 'utf8').trim();
  } catch {
    return null;
  }
}

/**
 * Where the repository's HEAD points now, cheaply (two small reads, no git
 * process), or null when it cannot be told: then only the TTL renews the cache.
 * @param {string} root
 * @returns {string|null}
 */
function headSignature(root) {
  try {
    const repo = findRepo(root);
    if (!repo) return null;
    const head = readSmall(path.join(repo.gitDir, 'HEAD'));
    if (!head) return null;
    const ref = /^ref:\s*(refs\/[\w./-]+)$/.exec(head);
    if (!ref || ref[1].split('/').includes('..')) return head;
    const loose = readSmall(path.join(repo.gitDir, ...ref[1].split('/')));
    if (loose) return `${head} ${loose}`;
    // A packed ref: its file changes whenever a packed ref moves.
    const packed = fs.statSync(path.join(repo.gitDir, 'packed-refs'));
    return `${head} packed ${packed.size} ${packed.mtimeMs}`;
  } catch {
    return null;
  }
}

const sameMap = (a, b) => isMap(a) && isMap(b) && a.size === b.size && [...a].every(([k, v]) => b.get(k) === v);

/** Whether a cached answer holds every path the query asks about, from early enough. */
const covers = (old, q) => old.root === q.root && old.since <= q.since && q.paths.every((p) => old.paths.has(p));

/**
 * The cache in front of readChanges.
 * @param {{exec?: Function, now?: () => number, ttlMs?: number, headOf?: (root: string) => string|null}} [deps]
 * @returns {{current: () => Object<string, Map<string, string>>, refresh: (records: [string, object][], roots: object) => Promise<boolean>}}
 *   current = the cached answers (never starts git), for reviewList's `changes`;
 *   refresh = asks git for the projects whose answer is missing or old; resolves
 *   true when an answer differs from the one it replaces. Never rejects.
 */
function createChangeTracker({ exec = execFile, now = Date.now, ttlMs = CHANGES_TTL_MS, headOf = headSignature } = {}) {
  /** project -> {query: {root, since, paths: Set}, sig, at, changes: Map|null} */
  const cache = new Map();
  /** project -> the call in flight */
  const inflight = new Map();

  const fresh = (entry, query, sig) => Boolean(entry) && covers(entry.query, query) && now() - entry.at < ttlMs && (sig === null || entry.sig === sig);

  async function ask(project, query, sig) {
    const res = await readChanges(query, { exec });
    if (!res.ok) console.error(`[memory] changed files of ${project} unknown, git log failed:`, res.reason);
    const before = cache.get(project);
    const changes = res.ok ? res.changes : null;
    cache.set(project, { query: { ...query, paths: new Set(query.paths) }, sig, at: now(), changes });
    if (!before) return changes !== null;
    return before.changes === null ? changes !== null : !sameMap(before.changes, changes);
  }

  function start(project, query) {
    let sig = null;
    try {
      sig = headOf(query.root);
    } catch (err) {
      console.error('[memory] repository HEAD unreadable:', errText(err));
    }
    if (fresh(cache.get(project), query, sig)) return Promise.resolve(false);
    const job = ask(project, query, sig)
      .catch((err) => {
        console.error(`[memory] changed files of ${project} failed:`, errText(err));
        return false;
      })
      .finally(() => inflight.delete(project));
    inflight.set(project, job);
    return job;
  }

  return {
    current() {
      const out = {};
      for (const [project, entry] of cache) if (entry.changes) out[project] = entry.changes;
      return out;
    },
    async refresh(records, roots) {
      let queries;
      try {
        queries = changeQueries(records, roots);
      } catch (err) {
        console.error('[memory] changed files: queries failed:', errText(err));
        return false;
      }
      const jobs = Object.entries(queries).map(([project, query]) => inflight.get(project) || start(project, query));
      return (await Promise.all(jobs)).some(Boolean);
    },
  };
}

/** A tracker's cached answers, or none: a failure there must not hide a list. */
function currentChanges(tracker) {
  if (!tracker) return {};
  try {
    return tracker.current() || {};
  } catch (err) {
    console.error('[memory] changed files unavailable:', errText(err));
    return {};
  }
}

/**
 * For an IPC handler: the cached answers, after starting a background
 * refresh; when it lands with a different answer, `repaint` runs (the IPC's
 * onChanged). Never throws, never waits for git.
 * @param {{current: Function, refresh: Function}|null} tracker createChangeTracker()
 * @param {[string, object][]} records
 * @param {object} rootsHere {<project>: its folder on this PC}
 * @param {() => void} repaint
 * @returns {Object<string, Map<string, string>>}
 */
function cachedChanges(tracker, records, rootsHere, repaint) {
  if (!tracker) return {};
  try {
    Promise.resolve(tracker.refresh(records, rootsHere))
      .then((differs) => {
        if (differs) repaint();
      })
      .catch((err) => console.error('[memory] changed files refresh failed:', errText(err)));
  } catch (err) {
    console.error('[memory] changed files refresh failed:', errText(err));
  }
  return currentChanges(tracker);
}

module.exports = {
  createChangeTracker,
  currentChanges,
  cachedChanges,
  changeQueries,
  gitArgs,
  parseChanges,
  readChanges,
  headSignature,
  CHANGES_TTL_MS,
  GIT_TIMEOUT_MS,
  MAX_PATHSPEC_CHARS,
};
