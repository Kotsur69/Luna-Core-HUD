// ============================================================================
// LunaCore - git-sourced signal for the Active-Files Heatmap
// ----------------------------------------------------------------------------
// The heatmap's primary source (observer.js's toolEventsFromLines()) only sees
// a file when the tool that touched it carries a `file_path` input - true for
// Read/Edit/Write, false for Bash/PowerShell. A session that creates files via
// shell commands (heredocs, `Set-Content`, `New-Item`, redirects, ...) is
// therefore invisible to it: verified against a real transcript where 111 Bash
// + 16 PowerShell calls produced two Write-tool rows and nothing else, while
// `git status` in the same repo showed four real changed files.
//
// This is the second signal, layered on top rather than replacing the first:
// git does not care which tool wrote a file, only that it changed. Session
// SCOPE still matters the same way it does everywhere else in this widget, so
// a baseline snapshot at session start excludes whatever was already dirty
// before Claude touched anything (mirrors observer.js's TranscriptWatcher.
// snapshotBaseline()).
//
// Known v1 simplifications, same spirit as DONE_ACTIVE_FILES_HEATMAP_PLAN.md §4:
//   - a path already dirty at baseline stays excluded even if edited further
//     during the session - the same tradeoff the transcript path makes for a
//     resumed (--continue) session.
//   - a rename/copy (porcelain record type '2') is tracked by its NEW path
//     only; the old path's history is not carried over.
//   - non-git working directories get no git-sourced rows at all - the
//     transcript path is still the only signal there, unchanged.
// ============================================================================

'use strict';

const fs = require('fs');
const path = require('path');
const { countLines } = require('./filestat');
const { runPooledGit } = require('./gitpool');

const STATUS_TIMEOUT_MS = 8000;
const DIFF_TIMEOUT_MS = 8000;
const MAX_BUFFER = 8 * 1024 * 1024;

/** Runs git in `dir`. Resolves { ok, stdout } - never rejects, same shape as gitstation.js's helper.
 *  Exported so main.js's `files:diff` handler runs `git diff HEAD -- <file>`
 *  through the exact same spawn path this watcher uses (no second way to
 *  shell out to git). Goes through the shared pool (src/gitpool.js): a global
 *  cap on running git processes, and identical reads share one process. */
function git(dir, args, timeout = STATUS_TIMEOUT_MS) {
  return runPooledGit(dir, args, { timeout, maxBuffer: MAX_BUFFER }).then((res) => ({ ok: res.ok, stdout: res.stdout }));
}

/**
 * Parses `git status --porcelain=v2 -z` into the changed paths, dropping the
 * count-only detail gitstation.js's parseStatus() already covers - this is
 * the sibling that keeps the PATH, which is the one thing that parser throws
 * away.
 *
 * -z (NUL-terminated records, unquoted paths) rather than the default: a path
 * with a space or non-ASCII character would otherwise arrive quoted, and a
 * quoting scheme this module would have to re-implement just to strip is not
 * worth it when git already offers the un-quoted form.
 * @param {string} stdout raw `git status --porcelain=v2 -z` output
 * @returns {{path:string, untracked:boolean}[]}
 */
function parseChangedPaths(stdout) {
  const out = [];
  if (typeof stdout !== 'string' || !stdout) return out;
  const tokens = stdout.split('\0');
  let i = 0;
  while (i < tokens.length) {
    const rec = tokens[i];
    if (!rec) {
      i++;
      continue;
    }
    const kind = rec[0];
    if (kind === '1') {
      // "1 XY sub mH mI mW hH hI path" - path is the last field, so joining
      // everything after the 8 fixed fields survives a path that itself
      // contains spaces.
      const parts = rec.split(' ');
      out.push({ path: parts.slice(8).join(' '), untracked: false });
      i++;
    } else if (kind === '2') {
      // "2 XY sub mH mI mW hH hI Xscore path" - the origPath rides as a
      // SEPARATE NUL-terminated token right after this one (that's what -z
      // buys here); skip it, v1 tracks the new path only (see header).
      const parts = rec.split(' ');
      out.push({ path: parts.slice(9).join(' '), untracked: false });
      i += 2;
    } else if (kind === 'u') {
      // "u XY sub m1 m2 m3 mW h1 h2 h3 path" - an unmerged/conflicted entry.
      const parts = rec.split(' ');
      out.push({ path: parts.slice(10).join(' '), untracked: false });
      i++;
    } else if (kind === '?') {
      out.push({ path: rec.slice(2), untracked: true });
      i++;
    } else {
      // '#' branch headers, '!' ignored entries (not requested here) - skip.
      i++;
    }
  }
  return out;
}

/**
 * Parses `git diff --numstat` into per-file added/removed counts. A binary
 * file reports `-\t-\tpath`; treated as {0,0} rather than throwing, since a
 * binary asset changing is real but has no line count to show.
 * @param {string} stdout
 * @returns {{path:string, added:number, removed:number}[]}
 */
function parseNumstat(stdout) {
  const out = [];
  if (typeof stdout !== 'string') return out;
  for (const raw of stdout.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (!line) continue;
    const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);
    if (!m) continue;
    out.push({
      path: m[3],
      added: m[1] === '-' ? 0 : Number(m[1]),
      removed: m[2] === '-' ? 0 : Number(m[2]),
    });
  }
  return out;
}

/**
 * Containment guard for the `files:diff` viewer. `file` is renderer-supplied,
 * so it is resolved against the session's own `cwd` and only accepted when it
 * stays INSIDE that directory - the handler must never diff an arbitrary path
 * off the session's repo.
 *
 * Returns the repo-relative path (what `git diff -- <path>` should get, so a
 * `..` never survives to the argv), or null when `file` resolves to cwd
 * itself or anywhere outside it.
 * @param {string} cwd absolute session directory
 * @param {string} file renderer-supplied path (relative or absolute)
 * @returns {string|null}
 */
function pathInsideCwd(cwd, file) {
  if (typeof cwd !== 'string' || !cwd || typeof file !== 'string' || !file) return null;
  const abs = path.resolve(cwd, file);
  const rel = path.relative(cwd, abs);
  if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return null;
  return rel;
}

/** realpath failures that mean "not there (any more)": a deleted file still diffs against HEAD. */
const MISSING_PATH_CODES = new Set(['ENOENT', 'ENOTDIR']);
/** realPathOrAncestor(): nothing between the file and cwd exists, so only the lexical check applies. */
const LEXICAL_ONLY = Symbol('lexicalOnly');

/** Whether `real` lies strictly inside `realCwd` (both already resolved). */
function isStrictlyInside(realCwd, real) {
  const rel = path.relative(realCwd, real);
  return Boolean(rel) && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

/**
 * The real path of `abs`, or of its nearest existing ancestor when it does
 * not exist (a deleted file), walking up no further than `cwd`;
 * LEXICAL_ONLY when nothing below cwd exists, null when a path on the way
 * cannot be resolved for another reason (EACCES, ELOOP, ...).
 * @returns {Promise<string|typeof LEXICAL_ONLY|null>}
 */
async function realPathOrAncestor(abs, cwd) {
  let current = abs;
  for (;;) {
    try {
      return await fs.promises.realpath(current);
    } catch (err) {
      if (!MISSING_PATH_CODES.has(err && err.code)) return null;
      const parent = path.dirname(current);
      // Reached cwd (or the root) without finding anything: lexical check only.
      if (parent === current || path.relative(cwd, parent) === '') return LEXICAL_ONLY;
      current = parent;
    }
  }
}

/**
 * The symlink-aware half of the files:diff containment guard. pathInsideCwd()
 * is lexical only, so a symlink inside the repo that points outside passes
 * it; this resolves both the session's cwd and the file with realpath and
 * accepts the file only when its real path is still strictly inside the real
 * cwd. A file that does not exist (deleted, still diffs against HEAD) is
 * judged by its nearest existing ancestor - for a plain deleted file that is
 * its own folder, inside cwd. Any other resolution failure refuses (fails
 * closed). Call it after pathInsideCwd(), not instead of it.
 * @param {string} cwd absolute session directory
 * @param {string} file renderer-supplied path (relative or absolute)
 * @returns {Promise<boolean>}
 */
async function realPathInsideCwd(cwd, file) {
  if (!pathInsideCwd(cwd, file)) return false;
  const abs = path.resolve(cwd, file);
  let realCwd;
  try {
    realCwd = await fs.promises.realpath(cwd);
  } catch (err) {
    // A cwd that is gone: nothing to resolve against, git reports its own reason.
    return MISSING_PATH_CODES.has(err && err.code);
  }
  const real = await realPathOrAncestor(abs, cwd);
  if (real === null) return false;
  // Nothing on the way exists but cwd itself: only the lexical check applies.
  if (real === LEXICAL_ONLY) return true;
  return isStrictlyInside(realCwd, real);
}

/**
 * Snapshot of every dirty path at session start - the baseline that keeps
 * pre-existing uncommitted work from being misattributed to this session.
 * @param {string} cwd
 * @returns {Promise<Set<string>|null>} null = not a git repo (or git failed);
 *   the watcher reads that as "never poll this session".
 */
async function snapshotDirtyPaths(cwd) {
  const res = await git(cwd, ['status', '--porcelain=v2', '-z']);
  if (!res.ok) return null;
  return new Set(parseChangedPaths(res.stdout).map((e) => e.path));
}

/**
 * Caps how much of an untracked file this module will read for a line count -
 * the one place this feature reads file CONTENT rather than metadata (same
 * exception class as files:check-exist's fs.existsSync poll, ACTIVE_FILES_
 * HEATMAP_PLAN.md §5.6 item 3: a narrow, bounded, read-only exception to the
 * "no new I/O" rule, not a new pattern).
 */
const MAX_UNTRACKED_READ_BYTES = 512 * 1024;

/** Line count of a new untracked file, capped and read-only. 0 on any error. */
function readUntrackedLineCount(absPath) {
  let fd;
  try {
    const st = fs.statSync(absPath);
    if (!st.isFile()) return 0;
    fd = fs.openSync(absPath, 'r');
    const len = Math.min(st.size, MAX_UNTRACKED_READ_BYTES);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, 0);
    return countLines(buf.toString('utf8'));
  } catch {
    return 0;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/**
 * Reads the files git considers changed in `cwd`, minus whatever was already
 * dirty at `baseline`, with real added/removed counts.
 *
 * Tracked files get one batched `git diff HEAD --numstat` call (not one per
 * file - the whole point of reading git status once per tick is that it stays
 * cheap on a real repo). Untracked files have nothing to diff against, so
 * their "added" count comes from the file itself (see readUntrackedLineCount) -
 * the same treatment filestat.js already gives a brand-new file written by
 * the Write tool.
 * @param {string} cwd
 * @param {Set<string>} baseline paths to exclude (already dirty at session start)
 * @returns {Promise<{file:string, added:number, removed:number}[]>} absolute paths
 */
async function readChangedFiles(cwd, baseline) {
  const known = baseline instanceof Set ? baseline : new Set();
  const res = await git(cwd, ['status', '--porcelain=v2', '-z']);
  if (!res.ok) return [];

  const entries = parseChangedPaths(res.stdout).filter((e) => !known.has(e.path));
  if (entries.length === 0) return [];

  const tracked = entries.filter((e) => !e.untracked);
  const untracked = entries.filter((e) => e.untracked);

  const statByPath = new Map();
  if (tracked.length > 0) {
    // Against HEAD so a change already staged still shows - a fresh repo with
    // no commits yet has no HEAD and this call simply fails; the fallback
    // below (0/0) is a dim row, not a crash.
    const diff = await git(cwd, ['diff', 'HEAD', '--numstat', '--', ...tracked.map((e) => e.path)], DIFF_TIMEOUT_MS);
    if (diff.ok) {
      for (const row of parseNumstat(diff.stdout)) statByPath.set(row.path, row);
    }
  }

  const out = [];
  for (const e of tracked) {
    const stat = statByPath.get(e.path);
    out.push({ file: path.resolve(cwd, e.path), added: stat ? stat.added : 0, removed: stat ? stat.removed : 0 });
  }
  for (const e of untracked) {
    const abs = path.resolve(cwd, e.path);
    out.push({ file: abs, added: readUntrackedLineCount(abs), removed: 0 });
  }
  return out;
}

/**
 * Polls `readChangedFiles()` on a timer, scoped to one session's directory -
 * the git-status sibling of observer.js's TranscriptWatcher, same start/stop/
 * tick shape so main.js wires it in identically.
 *
 * Never polls a non-git directory: the first snapshot decides that once, and
 * a directory that is not a repo costs nothing on every later tick.
 *
 * Single-flight: a tick that comes while the previous one is still waiting on
 * git is skipped, so a slow git (a loaded machine) never stacks up processes
 * for this folder. A stop() during start()'s first snapshot wins: no timer is
 * created afterwards.
 */
class GitFileWatcher {
  /**
   * @param {string} cwd
   * @param {(files: {file:string, added:number, removed:number}[]) => void} onFiles
   * @param {{intervalMs?: number, snapshot?: typeof snapshotDirtyPaths, read?: typeof readChangedFiles}} [opts]
   *   snapshot / read: injected by tests in place of the real git calls
   */
  constructor(cwd, onFiles, opts = {}) {
    this.cwd = cwd;
    this.onFiles = typeof onFiles === 'function' ? onFiles : null;
    // Slower than the transcript watcher's 1.5s: a shell-out on every tick is
    // real disk I/O on a real repo, and this signal only needs to be "pretty
    // fresh", not turn-by-turn - matched to activefiles.js's own self-heal
    // sweep (STALE_CHECK_MS) rather than invented separately.
    this.intervalMs = opts.intervalMs || 5000;
    this.snapshot = typeof opts.snapshot === 'function' ? opts.snapshot : snapshotDirtyPaths;
    this.read = typeof opts.read === 'function' ? opts.read : readChangedFiles;
    this.timer = null;
    // Bumped by every stop(): a start() or tick() begun under an older run
    // drops its answer instead of creating a timer or emitting stale files.
    this.run = 0;
    this.startingRun = null;
    this.inFlight = false;
    this.baseline = null;
    this.isRepo = true;
    // Cheap change-detection so an unchanged status does not re-emit the same
    // payload every tick - mirrors the point of TranscriptWatcher's mtime check.
    this.lastKey = '';
  }

  async start() {
    if (this.timer || this.startingRun === this.run) return;
    const run = this.run;
    this.startingRun = run;
    let snap;
    try {
      snap = await this.snapshot(this.cwd);
    } finally {
      if (this.startingRun === run) this.startingRun = null;
    }
    if (run !== this.run) return;
    if (snap === null) {
      this.isRepo = false;
      return;
    }
    this.baseline = snap;
    this.timer = setInterval(() => this.tick(), this.intervalMs);
    this.tick();
  }

  stop() {
    this.run += 1;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick() {
    if (!this.isRepo || !this.onFiles || this.inFlight) return;
    const run = this.run;
    this.inFlight = true;
    let files;
    try {
      files = await this.read(this.cwd, this.baseline || new Set());
    } finally {
      this.inFlight = false;
    }
    if (run !== this.run) return;
    const key = files.map((f) => `${f.file}:${f.added}:${f.removed}`).sort().join('|');
    if (key === this.lastKey) return;
    this.lastKey = key;
    this.onFiles(files);
  }
}

module.exports = {
  git,
  pathInsideCwd,
  realPathInsideCwd,
  parseChangedPaths,
  parseNumstat,
  snapshotDirtyPaths,
  readChangedFiles,
  readUntrackedLineCount,
  GitFileWatcher,
  MAX_UNTRACKED_READ_BYTES,
};
