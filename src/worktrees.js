// ============================================================================
// LunaCore - git worktrees for tabs (ORCHESTRATOR_PLAN.md, build slice 1)
// ----------------------------------------------------------------------------
// "New tab in worktree": one isolated checkout + branch per tab, so two
// Claudes working on the same project never edit the same files on disk.
//
// Layout: <repo>/../.luna-worktrees/<repo-name>/<slug> on branch luna/<slug>,
// OUTSIDE the main checkout so its watchers, tests and git status never see
// the worktree. The repo name level keeps two repos sharing one parent folder
// apart.
//
// What git does not carry: top-level `.env*` files are copied. `node_modules`
// is deliberately NOT linked - the plan's "cheap junction" idea is a trap:
// `git worktree remove` follows a junction while it deletes the worktree's
// ignored files and empties the junction's TARGET - the MAIN checkout's
// node_modules. Verified on git 2.53.0.windows.1 with AND without --force:
// git exits 0 and the target is left with 0 entries. The tab runs its own
// install instead, and removeWorktree unlinks any such link first (below).
//
// Removal (removeWorktree) is only for God Mode packages whose branch is
// pushed, and refuses a worktree with anything uncommitted: it may hold the
// only copy of that work. No --force, so git itself re-checks. Before git
// runs, every junction / symlink at <root>/node_modules, <root>/<dir>/
// node_modules and directly inside those folders is unlinked - the link
// only, never a recursive delete. A link that cannot be unlinked stops the
// removal before git is run.
//
// Branch deletion (deleteBranch) is only for branches a failed God Mode
// launch left behind: `luna/` names only, never the checked-out branch, and
// never one with commits beyond its start point.
// ============================================================================

'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const WORKTREE_DIR = '.luna-worktrees';
const BRANCH_PREFIX = 'luna/';
const MAX_SLUG_CHARS = 48;
const GIT_TIMEOUT_MS = 30000;
// `git worktree remove` deletes the folder's ignored files too: a real
// node_modules on Windows can take minutes, far longer than GIT_TIMEOUT_MS.
const REMOVE_TIMEOUT_MS = 10 * 60 * 1000;
const STDERR_TAIL_CHARS = 300;
// git's own words for "this folder is in no repository".
const NOT_REPO_RE = /not a git repository/i;
// `git worktree add` failures that can clear up on their own (a lock held by
// another git, a file still busy) - worth an automatic retry.
const TRANSIENT_ADD_RE = /\.lock\b|unable to (create|lock|unlink)|permission denied|resource (temporarily )?unavailable|device or resource busy/i;
const DEPENDENCY_DIR = 'node_modules';
const ENV_FILE_RE = /^\.env(\..+)?$/;
// A commit a new worktree may start from instead of HEAD (a dependency's
// pushed head) - full or abbreviated hex only, never a ref or an option.
const BASE_SHA_RE = /^[0-9a-f]{7,64}$/;

/**
 * Turns a free-form tab name into a safe folder + branch name: lower-case
 * a-z, 0-9 and single dashes. Anything that git ref rules or Windows paths
 * could object to (dots, slashes, spaces, `..`, `.lock`) is simply not in
 * the alphabet.
 * @param {unknown} name
 * @returns {string|null} null when nothing usable is left
 */
function slugify(name) {
  if (typeof name !== 'string') return null;
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, MAX_SLUG_CHARS)
    .replace(/^-+|-+$/g, '');
  return slug || null;
}

/**
 * @param {string} repoRoot top level of the main checkout
 * @param {string} slug
 * @returns {string}
 */
function worktreePathFor(repoRoot, slug) {
  return path.join(path.dirname(repoRoot), WORKTREE_DIR, path.basename(repoRoot), slug);
}

/** Branch prefixes a caller may ask for (God Mode free runs use luna-free/). */
const BRANCH_PREFIXES = new Set([BRANCH_PREFIX, 'luna-free/']);

/** @param {string} slug @param {string} [prefix] one of BRANCH_PREFIXES */
function branchFor(slug, prefix = BRANCH_PREFIX) {
  return `${BRANCH_PREFIXES.has(prefix) ? prefix : BRANCH_PREFIX}${slug}`;
}

/** First non-empty line of git's stderr - enough to tell the user what broke. */
function firstLine(text) {
  return (
    String(text || '')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find(Boolean) || ''
  );
}

/**
 * The line of git's stderr that says why it failed: the first `fatal:` /
 * `error:` line, else the first line. git prints progress ("Preparing
 * worktree ...") before the reason, so firstLine alone hides it.
 */
function gitError(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  return lines.find((l) => /^(fatal|error):/i.test(l)) || lines[0] || '';
}

/**
 * Why git never answered, or '' when it ran and exited non-zero. A killed
 * process (our timeout) or a spawn error (string code, e.g. ENOENT) says
 * nothing about the folder - git's own exit code does.
 */
function gitBroke(err, timeoutMs = GIT_TIMEOUT_MS) {
  if (!err) return '';
  if (isTimeout(err)) return `git timed out after ${Math.round(timeoutMs / 1000)}s`;
  if (typeof err.code === 'string') return `git did not start (${err.code})`;
  return '';
}

/** A process killed by our timer (execFile sets killed / signal). */
function isTimeout(err) {
  return !!(err && (err.killed || err.signal));
}

/** git's exit code: 0 on success, null when it never exited on its own. */
function exitCode(err) {
  if (!err) return 0;
  return typeof err.code === 'number' ? err.code : null;
}

/**
 * Runs git without a shell; never rejects. Resolves
 * {ok, stdout, stderr, broke, timedOut, code, cwd, args, timeoutMs} - enough
 * for gitDetail() to say exactly what happened.
 * @param {{timeoutMs?: number}} [opts]
 */
function runGit(cwd, args, execImpl = execFile, opts = {}) {
  const timeoutMs = Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0 ? opts.timeoutMs : GIT_TIMEOUT_MS;
  return new Promise((resolve) => {
    execImpl('git', ['-C', cwd, ...args], { windowsHide: true, timeout: timeoutMs }, (err, stdout, stderr) =>
      resolve({
        ok: !err,
        stdout: String(stdout || ''),
        stderr: String(stderr || ''),
        broke: gitBroke(err, timeoutMs),
        timedOut: isTimeout(err),
        code: exitCode(err),
        cwd,
        args,
        timeoutMs,
      }),
    );
  });
}

/** The end of git's stderr on one line - the reason is usually last. */
function stderrTail(text) {
  const flat = String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .join(' | ');
  return flat.length > STDERR_TAIL_CHARS ? `...${flat.slice(-STDERR_TAIL_CHARS)}` : flat;
}

/**
 * One line that says what git was asked, where, and how it ended: exit code
 * or timeout, and the tail of its stderr. Never empty.
 * @param {{args?:string[], cwd?:string, ok?:boolean, timedOut?:boolean, broke?:string,
 *   code?:number|null, stderr?:string, timeoutMs?:number}} res a runGit result
 */
function gitDetail(res) {
  const cmd = `git ${(res.args || []).join(' ')}`.trim();
  let how;
  if (res.timedOut) how = `timed out after ${Math.round((res.timeoutMs || GIT_TIMEOUT_MS) / 1000)}s (killed, no exit code)`;
  else if (res.broke) how = res.broke;
  else how = `exit ${res.code == null ? (res.ok ? 0 : 'unknown') : res.code}, not timed out`;
  const tail = stderrTail(res.stderr);
  return `${cmd} in ${res.cwd || '?'}: ${how}${tail ? `; stderr: ${tail}` : '; no stderr'}`;
}

/**
 * Copies top-level `.env*` files the worktree does not already have (git
 * gave it every tracked one, e.g. `.env.example`).
 * @returns {number} how many were copied
 */
function copyEnvFiles(fromDir, toDir, fsImpl = fs) {
  let copied = 0;
  let entries = [];
  try {
    entries = fsImpl.readdirSync(fromDir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !ENV_FILE_RE.test(entry.name)) continue;
    const target = path.join(toDir, entry.name);
    if (fsImpl.existsSync(target)) continue;
    try {
      fsImpl.copyFileSync(path.join(fromDir, entry.name), target);
      copied += 1;
    } catch {
      /* one unreadable file must not fail the whole tab */
    }
  }
  return copied;
}

/**
 * Why `git rev-parse --show-toplevel` gave no top level. 'notRepo' only when
 * git itself says the folder is in no repository; a timeout, a git that did
 * not start, or any other failure is 'gitFailed' (retryable) - right after a
 * PC wake a fine repo can fail this way, and it must not read as "not a repo".
 * Both always carry a detail naming the command, the folder, the exit code or
 * timeout, and git's stderr.
 * @param {object} top a runGit result
 * @returns {{ok:false, error:'notRepo'|'gitFailed', detail:string, retryable?:boolean}}
 */
function topLevelFailure(top) {
  if (!top.ok) {
    if (!top.broke && NOT_REPO_RE.test(top.stderr)) return { ok: false, error: 'notRepo', detail: gitDetail(top) };
    return { ok: false, error: 'gitFailed', detail: gitDetail(top), retryable: true };
  }
  return { ok: false, error: 'gitFailed', detail: `${gitDetail(top)}; printed no top-level folder`, retryable: true };
}

/**
 * Creates a worktree + branch for a new tab, branching from the current HEAD
 * of the checkout `repoPath` lives in.
 *
 * When `repoPath` is a sub-folder of its repo, the returned `cwd` is the same
 * sub-folder inside the worktree, so the tab opens where the project does.
 *
 * @param {string} repoPath the project's folder
 * @param {unknown} name tab / branch name as typed
 * @param {{execImpl?: Function, fsImpl?: typeof fs, base?: string, branchPrefix?: string}} [deps]
 *   base: commit sha to branch from instead of HEAD
 *   branchPrefix: 'luna/' (default) or 'luna-free/' - anything else is ignored
 * A failure that may clear up on its own (git hung, did not start, a lock)
 * carries `retryable: true`. A failure after git already created the folder
 * carries its `root` and `branch`, so the caller can clean it up.
 * @returns {Promise<{ok:true, cwd:string, root:string, branch:string, envCopied:number}
 *   | {ok:false, error:'badName'|'notRepo'|'noCommits'|'exists'|'gitFailed', detail?:string,
 *      retryable?:boolean, root?:string, branch?:string}>}
 */
async function addWorktree(repoPath, name, deps = {}) {
  const execImpl = deps.execImpl || execFile;
  const fsImpl = deps.fsImpl || fs;

  const slug = slugify(name);
  if (!slug) return { ok: false, error: 'badName', detail: `no usable letters or digits in ${JSON.stringify(String(name))}` };

  const top = await runGit(repoPath, ['rev-parse', '--show-toplevel'], execImpl);
  const repoRoot = top.ok ? firstLine(top.stdout) : '';
  if (!repoRoot) return topLevelFailure(top);
  const root = path.resolve(repoRoot);

  const head = await runGit(root, ['rev-parse', '--verify', 'HEAD'], execImpl);
  // A hung git says nothing about the commits either.
  if (head.broke) return { ok: false, error: 'gitFailed', detail: gitDetail(head), retryable: true };
  if (!head.ok) return { ok: false, error: 'noCommits', detail: gitDetail(head) };

  const target = worktreePathFor(root, slug);
  if (fsImpl.existsSync(target)) return { ok: false, error: 'exists', detail: target };

  const branch = branchFor(slug, deps.branchPrefix);
  const base =typeof deps.base === 'string' && BASE_SHA_RE.test(deps.base) ? deps.base : 'HEAD';
  const add = await runGit(root, ['worktree', 'add', '-b', branch, target, base], execImpl);
  if (!add.ok) {
    const reason = gitError(add.stderr);
    const failed = {
      ok: false,
      error: 'gitFailed',
      detail: reason && !add.broke ? reason : gitDetail(add),
      retryable: !!add.broke || TRANSIENT_ADD_RE.test(add.stderr),
    };
    // The folder did not exist before this call: whatever is there now is ours.
    return fsImpl.existsSync(target) ? { ...failed, root: target, branch } : failed;
  }

  const envCopied = copyEnvFiles(root, target, fsImpl);

  const rel = path.relative(root, path.resolve(repoPath));
  const sub = rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? path.join(target, rel) : target;
  const cwd = fsImpl.existsSync(sub) ? sub : target;

  return { ok: true, cwd, root: target, branch, envCopied };
}

/**
 * How many uncommitted changes the checkout has - worktrees branch from
 * HEAD, so the God Mode plan warns that workers will not see them.
 * @param {string} repoPath
 * @returns {Promise<number|null>} null when it is not a repo or git failed
 */
async function dirtyCount(repoPath, deps = {}) {
  const res = await runGit(repoPath, ['status', '--porcelain'], deps.execImpl || execFile);
  if (!res.ok) return null;
  return res.stdout.split('\n').filter((l) => l.trim()).length;
}

/** fs.lstatSync or null - a missing path is simply not a link. */
function lstatOrNull(p, fsImpl) {
  try {
    return fsImpl.lstatSync(p);
  } catch {
    return null;
  }
}

/** Directory entry names, [] when the folder cannot be read. */
function namesIn(dir, fsImpl) {
  try {
    return fsImpl.readdirSync(dir);
  } catch {
    return [];
  }
}

/**
 * Removes ONE link - the link itself, never what it points to. A Windows
 * junction is a directory reparse point: unlink handles it on current Node,
 * rmdir (non-recursive) is the fallback. Throws when neither works.
 */
function unlinkOnly(p, fsImpl) {
  try {
    fsImpl.unlinkSync(p);
  } catch (unlinkErr) {
    try {
      fsImpl.rmdirSync(p);
    } catch {
      throw unlinkErr;
    }
  }
}

/**
 * Every place under `root` where a dependency link can sit: node_modules of
 * the root and of each direct sub-folder (e.g. mobile/node_modules).
 * @returns {string[]}
 */
function dependencyDirs(root, fsImpl) {
  const dirs = [path.join(root, DEPENDENCY_DIR)];
  for (const name of namesIn(root, fsImpl)) {
    if (name === DEPENDENCY_DIR || name === '.git') continue;
    const sub = path.join(root, name);
    const st = lstatOrNull(sub, fsImpl);
    if (st && st.isDirectory() && !st.isSymbolicLink()) dirs.push(path.join(sub, DEPENDENCY_DIR));
  }
  return dirs;
}

/**
 * The links in one node_modules: the folder itself when it is a link, else
 * the links directly inside it and inside its @scope folders (npm link,
 * workspaces).
 * @returns {string[]}
 */
function linksIn(dir, fsImpl) {
  const st = lstatOrNull(dir, fsImpl);
  if (!st) return [];
  if (st.isSymbolicLink()) return [dir];
  if (!st.isDirectory()) return [];
  const links = [];
  for (const name of namesIn(dir, fsImpl)) {
    const p = path.join(dir, name);
    const entry = lstatOrNull(p, fsImpl);
    if (!entry) continue;
    if (entry.isSymbolicLink()) links.push(p);
    else if (name.startsWith('@') && entry.isDirectory()) {
      for (const scoped of namesIn(p, fsImpl)) {
        const sp = path.join(p, scoped);
        const se = lstatOrNull(sp, fsImpl);
        if (se && se.isSymbolicLink()) links.push(sp);
      }
    }
  }
  return links;
}

/**
 * Unlinks every dependency junction / symlink under `root` (see the header):
 * git would otherwise delete THROUGH it and empty the target.
 * @returns {{ok:true, unlinked:string[]} | {ok:false, detail:string}}
 */
function unlinkDependencyLinks(root, fsImpl = fs) {
  const unlinked = [];
  for (const dir of dependencyDirs(root, fsImpl)) {
    for (const link of linksIn(dir, fsImpl)) {
      try {
        unlinkOnly(link, fsImpl);
        unlinked.push(link);
      } catch (err) {
        const why = err && err.code ? err.code : err instanceof Error ? err.message : String(err);
        return { ok: false, detail: `cannot unlink ${link} (${why}); git worktree remove was not run` };
      }
    }
  }
  return { ok: true, unlinked };
}

/**
 * Removes a worktree whose work is safe elsewhere (pushed). Refuses when it
 * has uncommitted changes; the branch itself is kept. Dependency links are
 * unlinked first, and a link that will not go stops the removal before git
 * runs. git gets REMOVE_TIMEOUT_MS: deleting a real node_modules is slow.
 * @param {string} repoPath any folder of the main checkout
 * @param {string} root the worktree's top folder
 * @param {{execImpl?: Function, fsImpl?: typeof fs}} [deps]
 * @returns {Promise<{ok:true} | {ok:false, error:'dirty'|'linkRemoveFailed'|'gitFailed', detail?:string}>}
 */
async function removeWorktree(repoPath, root, deps = {}) {
  const execImpl = deps.execImpl || execFile;
  const fsImpl = deps.fsImpl || fs;
  const status = await runGit(root, ['status', '--porcelain'], execImpl);
  if (!status.ok) return { ok: false, error: 'gitFailed', detail: gitDetail(status) };
  if (status.stdout.trim()) return { ok: false, error: 'dirty', detail: firstLine(status.stdout) };
  const links = unlinkDependencyLinks(root, fsImpl);
  if (!links.ok) return { ok: false, error: 'linkRemoveFailed', detail: links.detail };
  const res = await runGit(repoPath, ['worktree', 'remove', '--', root], execImpl, { timeoutMs: REMOVE_TIMEOUT_MS });
  if (res.ok) return { ok: true };
  const reason = res.broke ? '' : gitError(res.stderr);
  return { ok: false, error: 'gitFailed', detail: reason ? `${reason} (${gitDetail(res)})` : gitDetail(res) };
}

// Only branches LunaCore itself names (`luna/<slug>`) may ever be deleted.
const OWN_BRANCH_RE = /^luna\/[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * How many commits `branch` has that its start point does not: with a
 * recorded base sha, `base..branch`; without one, the commits no other LOCAL
 * branch reaches (a pushed branch from an earlier run counts as having work).
 * @returns {Promise<number|null>} null when git failed
 */
async function ownCommitCount(repoPath, branch, base, execImpl) {
  const ref = `refs/heads/${branch}`;
  const args =
    typeof base === 'string' && BASE_SHA_RE.test(base)
      ? ['rev-list', '--count', `${base}..${ref}`]
      : ['rev-list', '--count', ref, '--not', `--exclude=${branch}`, '--branches'];
  const res = await runGit(repoPath, args, execImpl);
  const n = res.ok ? Number.parseInt(firstLine(res.stdout), 10) : NaN;
  return Number.isInteger(n) ? n : null;
}

/**
 * Deletes a branch left by a failed God Mode launch. Refuses anything that
 * is not LunaCore's own `luna/` branch, the checked-out branch, and a branch
 * with commits beyond its start point - real work is never deleted.
 * @param {string} repoPath any folder of the main checkout
 * @param {unknown} branch e.g. `luna/core-abc12`
 * @param {{execImpl?: Function, base?: string|null}} [deps] base: the sha the
 *   branch was created from (pkg.baseSha / the dependency head)
 * @returns {Promise<{ok:true} | {ok:false, error:'badName'|'checkedOut'|'hasCommits'|'gitFailed', detail?:string}>}
 */
async function deleteBranch(repoPath, branch, deps = {}) {
  const execImpl = deps.execImpl || execFile;
  if (typeof branch !== 'string' || !branch.startsWith(BRANCH_PREFIX) || !OWN_BRANCH_RE.test(branch)) {
    return { ok: false, error: 'badName' };
  }
  const head = await runGit(repoPath, ['symbolic-ref', '--quiet', '--short', 'HEAD'], execImpl);
  if (head.ok && firstLine(head.stdout) === branch) return { ok: false, error: 'checkedOut' };
  const own = await ownCommitCount(repoPath, branch, deps.base, execImpl);
  if (own === null) return { ok: false, error: 'gitFailed', detail: 'rev-list failed' };
  if (own > 0) return { ok: false, error: 'hasCommits', detail: String(own) };
  const res = await runGit(repoPath, ['branch', '-D', '--', branch], execImpl);
  return res.ok ? { ok: true } : { ok: false, error: 'gitFailed', detail: firstLine(res.stderr) };
}

/**
 * Local branch names under `luna/`.
 * @returns {Promise<string[]|null>} null when git failed
 */
async function listOwnBranches(repoPath, deps = {}) {
  const res = await runGit(
    repoPath,
    ['for-each-ref', '--format=%(refname:short)', `refs/heads/${BRANCH_PREFIX}`],
    deps.execImpl || execFile,
  );
  if (!res.ok) return null;
  return res.stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((b) => OWN_BRANCH_RE.test(b));
}

/**
 * Branches checked out in any worktree of the repo (the main one included).
 * @returns {Promise<string[]|null>} null when git failed
 */
async function worktreeBranches(repoPath, deps = {}) {
  const res = await runGit(repoPath, ['worktree', 'list', '--porcelain'], deps.execImpl || execFile);
  if (!res.ok) return null;
  return res.stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith('branch refs/heads/'))
    .map((l) => l.slice('branch refs/heads/'.length));
}

/**
 * Why `git rev-parse --verify HEAD` failed, in the words other callers use:
 * 'notRepo' only when git says so, 'noCommits' for a repo without a HEAD,
 * else 'gitFailed' (a timeout, a git that did not start, anything else).
 * @param {object} res a failed runGit result
 * @returns {'notRepo'|'noCommits'|'gitFailed'}
 */
function headFailureReason(res) {
  if (res.broke) return 'gitFailed';
  if (NOT_REPO_RE.test(res.stderr)) return 'notRepo';
  if (/needed a single revision|unknown revision|ambiguous argument 'HEAD'/i.test(res.stderr)) return 'noCommits';
  return 'gitFailed';
}

module.exports = {
  removeWorktree,
  unlinkDependencyLinks,
  headFailureReason,
  gitDetail,
  GIT_TIMEOUT_MS,
  REMOVE_TIMEOUT_MS,
  deleteBranch,
  listOwnBranches,
  worktreeBranches,
  WORKTREE_DIR,
  BRANCH_PREFIX,
  MAX_SLUG_CHARS,
  slugify,
  worktreePathFor,
  branchFor,
  copyEnvFiles,
  addWorktree,
  dirtyCount,
  runGit,
  firstLine,
  gitError,
};
