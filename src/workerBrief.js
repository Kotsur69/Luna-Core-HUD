// ============================================================================
// LunaCore - where a worker's task brief lives (God Mode, Luna's Work)
// ----------------------------------------------------------------------------
// A worker tab reads its brief from `<cwd>/.luna-brief/<name>.md`: INSIDE the
// folder the tab starts in. Claude Code 2.1.326+ stops a tab at an "Adding a
// new directory ... This session hasn't worked here before" dialog for every
// --add-dir outside a trusted folder, and the old brief folder
// (<userDir>/tasks) was outside every repo. Nothing is written into
// ~/.claude.json: running Claude processes overwrite that file.
//
// Contract: a brief is always created with briefPathIn(cwd, name), so its
// parent is BRIEF_FOLDER directly inside the tab's cwd. launch.js relies on
// that to name the brief by its cwd-relative path in the first message.
//
// A worker's `git add -A` must never commit a brief. Two guards:
//   1. `<cwd>/.luna-brief/.gitignore` holding `*` - written with the brief,
//      synchronously, so it holds from the first byte and also covers a cwd
//      that is not (yet) a repo. It ignores itself too.
//   2. `.luna-brief/` in the repo's COMMON git dir `info/exclude` (shared by
//      every worktree, resolved with `git rev-parse --git-common-dir`). Added
//      once, idempotently, never into the tracked .gitignore. Unanchored, so
//      a project that lives in a sub-folder of its repo is covered as well.
//
// Cleanup (removeWorkerBrief) only ever deletes a `.md` file whose parent is
// a BRIEF_FOLDER, plus that folder (non-recursively) once nothing but its
// .gitignore is left. A `.luna-brief` folder, brief or .gitignore that is a
// link (a repo could commit one) is never written or deleted through.
// ============================================================================

'use strict';

const fs = require('fs');
const path = require('path');
const { runGit, firstLine } = require('./worktrees');

const BRIEF_FOLDER = '.luna-brief';
const EXCLUDE_LINE = `${BRIEF_FOLDER}/`;
// Lines that already exclude the folder (anchored or not).
const EXCLUDE_LINES = new Set([EXCLUDE_LINE, `/${EXCLUDE_LINE}`]);
const FOLDER_GITIGNORE = '.gitignore';
const FOLDER_GITIGNORE_TEXT = '# LunaCore worker briefs - never committed\n*\n';
// A brief file name: our own slugs only, never a path.
const BRIEF_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/;

const errText = (err) => (err instanceof Error ? err.message : String(err));

/** True when `p` exists and is a symlink / junction (never followed). */
function isLink(p, fsImpl) {
  try {
    return fsImpl.lstatSync(p).isSymbolicLink();
  } catch (err) {
    if (err && err.code === 'ENOENT') return false;
    throw err;
  }
}

/**
 * The brief file of a worker that starts in `cwd`.
 * @param {string} cwd the tab's working folder (absolute)
 * @param {string} name file name without `.md` (a worktree slug, a run id)
 * @returns {string}
 */
function briefPathIn(cwd, name) {
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) throw new TypeError('brief cwd must be an absolute path');
  if (typeof name !== 'string' || !BRIEF_NAME_RE.test(name)) throw new TypeError(`invalid brief name: ${JSON.stringify(name)}`);
  return path.join(cwd, BRIEF_FOLDER, `${name}.md`);
}

/** True for a path briefPathIn() could have made: `<dir>/.luna-brief/<file>.md`. */
function isWorkerBrief(file) {
  return (
    typeof file === 'string' &&
    path.isAbsolute(file) &&
    path.basename(path.dirname(file)) === BRIEF_FOLDER &&
    /\.md$/i.test(file) &&
    BRIEF_NAME_RE.test(path.basename(file))
  );
}

/**
 * The cwd-relative path a worker's first message names, with forward
 * slashes (`.luna-brief/pkg.md`), or null for any other brief path.
 * @param {string} file
 * @returns {string|null}
 */
function relativeBriefPath(file) {
  return isWorkerBrief(file) ? `${BRIEF_FOLDER}/${path.basename(file)}` : null;
}

/**
 * Writes a brief: its folder, the folder's ignore-everything .gitignore, then
 * the brief itself (0600). For a `.luna-brief` brief it also starts the
 * info/exclude entry (excludeBriefFolder) without waiting: guard 1 already
 * holds, and a failure there is logged, never thrown.
 * @param {string} file
 * @param {string} text
 * @param {{fsImpl?:typeof fs, exclude?:(dir:string)=>Promise<object>, log?:(msg:string)=>void}} [deps]
 * @returns {boolean} false when the brief could not be written
 */
function writeWorkerBrief(file, text, deps = {}) {
  const fsImpl = deps.fsImpl || fs;
  const log = deps.log || ((msg) => console.error(msg));
  const dir = path.dirname(file);
  try {
    // A repo could commit `.luna-brief` (or a brief name) as a link pointing
    // elsewhere: writing through it would land outside the worker's folder.
    if (isLink(dir, fsImpl) || isLink(file, fsImpl)) throw new Error('brief folder or file is a link');
    fsImpl.mkdirSync(dir, { recursive: true });
    if (path.basename(dir) === BRIEF_FOLDER) {
      const ignore = path.join(dir, FOLDER_GITIGNORE);
      // lstat, not exists: a dangling link must not be written through either.
      if (isLink(ignore, fsImpl)) throw new Error('brief folder .gitignore is a link');
      if (!fsImpl.existsSync(ignore)) fsImpl.writeFileSync(ignore, FOLDER_GITIGNORE_TEXT, 'utf8');
    }
    fsImpl.writeFileSync(file, text, { encoding: 'utf8', mode: 0o600 });
  } catch (err) {
    log(`[brief] could not write ${file}: ${errText(err)}`);
    return false;
  }
  if (isWorkerBrief(file)) {
    const exclude = deps.exclude || ((cwd) => excludeBriefFolder(cwd, { fsImpl }));
    Promise.resolve()
      .then(() => exclude(path.dirname(dir)))
      .then((res) => {
        if (res && res.ok === false && res.error !== 'notRepo') {
          log(`[brief] info/exclude not updated for ${dir}: ${res.error}${res.detail ? ` (${res.detail})` : ''}`);
        }
      })
      .catch((err) => log(`[brief] info/exclude failed for ${dir}: ${errText(err)}`));
  }
  return true;
}

// One update of an exclude file at a time in this process: two packages
// launched together must not both append the line.
let excludeChain = Promise.resolve();

/**
 * Adds EXCLUDE_LINE to the common git dir's info/exclude of the repo `dir`
 * is in, unless an equivalent line is already there.
 * @param {string} dir any folder of the repo (a worktree's cwd)
 * @param {{execImpl?:Function, fsImpl?:typeof fs}} [deps]
 * @returns {Promise<{ok:true, added:boolean, file:string} | {ok:false, error:'notRepo'|'gitFailed'|'writeFailed', detail?:string}>}
 */
function excludeBriefFolder(dir, deps = {}) {
  const run = excludeChain.then(() => excludeOnce(dir, deps));
  excludeChain = run.catch(() => {});
  return run;
}

async function excludeOnce(dir, deps) {
  const fsImpl = deps.fsImpl || fs;
  const res = await runGit(dir, ['rev-parse', '--git-common-dir'], deps.execImpl);
  const out = res.ok ? firstLine(res.stdout) : '';
  if (!out) {
    const notRepo = !res.broke && /not a git repository/i.test(res.stderr);
    return { ok: false, error: notRepo ? 'notRepo' : 'gitFailed', detail: firstLine(res.stderr) || res.broke || undefined };
  }
  const file = path.join(path.resolve(dir, out), 'info', 'exclude');
  try {
    let current = '';
    try {
      current = fsImpl.readFileSync(file, 'utf8');
    } catch (err) {
      if (!err || err.code !== 'ENOENT') throw err;
    }
    if (current.split(/\r?\n/).some((l) => EXCLUDE_LINES.has(l.trim()))) return { ok: true, added: false, file };
    fsImpl.mkdirSync(path.dirname(file), { recursive: true });
    const sep = current && !current.endsWith('\n') ? '\n' : '';
    fsImpl.appendFileSync(file, `${sep}# LunaCore worker briefs\n${EXCLUDE_LINE}\n`, 'utf8');
    return { ok: true, added: true, file };
  } catch (err) {
    return { ok: false, error: 'writeFailed', detail: errText(err) };
  }
}

/**
 * Deletes a worker brief, and its folder once only the folder's .gitignore
 * is left. Anything that is not a `.luna-brief/*.md` path is refused.
 * @param {unknown} file
 * @param {{fsImpl?:typeof fs}} [deps]
 * @returns {boolean} true when the brief is gone (or never existed)
 */
function removeWorkerBrief(file, deps = {}) {
  if (!isWorkerBrief(file)) return false;
  const fsImpl = deps.fsImpl || fs;
  const dir = path.dirname(file);
  try {
    // Never through a linked brief folder: only our own real folder is cleaned.
    if (isLink(dir, fsImpl)) throw new Error('brief folder is a link');
    fsImpl.rmSync(file, { force: true });
  } catch (err) {
    console.error(`[brief] could not remove ${file}: ${errText(err)}`);
    return false;
  }
  try {
    const left = fsImpl.readdirSync(dir);
    if (left.every((n) => n === FOLDER_GITIGNORE)) {
      // Our own .gitignore, then the folder - never a recursive delete.
      if (left.length) fsImpl.unlinkSync(path.join(dir, FOLDER_GITIGNORE));
      fsImpl.rmdirSync(dir);
    }
  } catch (err) {
    // The brief itself is gone; a folder left behind is ignored by git anyway.
    if (!err || err.code !== 'ENOENT') console.error(`[brief] could not tidy ${dir}: ${errText(err)}`);
  }
  return true;
}

module.exports = {
  BRIEF_FOLDER,
  EXCLUDE_LINE,
  briefPathIn,
  isWorkerBrief,
  relativeBriefPath,
  writeWorkerBrief,
  excludeBriefFolder,
  removeWorkerBrief,
};
