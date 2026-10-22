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
// `git worktree remove --force` follows a junction and empties the MAIN
// checkout's node_modules (verified). The tab runs its own install instead.
//
// Removal (removeWorktree) is only for God Mode packages whose branch is
// pushed, and refuses a worktree with anything uncommitted: it may hold the
// only copy of that work. No --force, so git itself re-checks.
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

/** Runs git without a shell; resolves {ok, stdout, stderr}, never rejects. */
function runGit(cwd, args, execImpl = execFile) {
  return new Promise((resolve) => {
    execImpl(
      'git',
      ['-C', cwd, ...args],
      { windowsHide: true, timeout: GIT_TIMEOUT_MS },
      (err, stdout, stderr) => resolve({ ok: !err, stdout: String(stdout || ''), stderr: String(stderr || '') }),
    );
  });
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
 * @returns {Promise<{ok:true, cwd:string, root:string, branch:string, envCopied:number}
 *   | {ok:false, error:'badName'|'notRepo'|'noCommits'|'exists'|'gitFailed', detail?:string}>}
 */
async function addWorktree(repoPath, name, deps = {}) {
  const execImpl = deps.execImpl || execFile;
  const fsImpl = deps.fsImpl || fs;

  const slug = slugify(name);
  if (!slug) return { ok: false, error: 'badName' };

  const top = await runGit(repoPath, ['rev-parse', '--show-toplevel'], execImpl);
  const repoRoot = top.ok ? firstLine(top.stdout) : '';
  if (!repoRoot) return { ok: false, error: 'notRepo' };
  const root = path.resolve(repoRoot);

  const head = await runGit(root, ['rev-parse', '--verify', 'HEAD'], execImpl);
  if (!head.ok) return { ok: false, error: 'noCommits' };

  const target = worktreePathFor(root, slug);
  if (fsImpl.existsSync(target)) return { ok: false, error: 'exists', detail: target };

  const branch = branchFor(slug, deps.branchPrefix);
  const base =typeof deps.base === 'string' && BASE_SHA_RE.test(deps.base) ? deps.base : 'HEAD';
  const add = await runGit(root, ['worktree', 'add', '-b', branch, target, base], execImpl);
  if (!add.ok) return { ok: false, error: 'gitFailed', detail: firstLine(add.stderr) };

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

/**
 * Removes a worktree whose work is safe elsewhere (pushed). Refuses when it
 * has uncommitted changes; the branch itself is kept.
 * @param {string} repoPath any folder of the main checkout
 * @param {string} root the worktree's top folder
 * @returns {Promise<{ok:true} | {ok:false, error:'dirty'|'gitFailed', detail?:string}>}
 */
async function removeWorktree(repoPath, root, deps = {}) {
  const execImpl = deps.execImpl || execFile;
  const status = await runGit(root, ['status', '--porcelain'], execImpl);
  if (!status.ok) return { ok: false, error: 'gitFailed', detail: firstLine(status.stderr) };
  if (status.stdout.trim()) return { ok: false, error: 'dirty' };
  const res = await runGit(repoPath, ['worktree', 'remove', '--', root], execImpl);
  return res.ok ? { ok: true } : { ok: false, error: 'gitFailed', detail: firstLine(res.stderr) };
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

module.exports = {
  removeWorktree,
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
};
