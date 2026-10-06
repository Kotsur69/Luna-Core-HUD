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

/** @param {string} slug */
function branchFor(slug) {
  return `${BRANCH_PREFIX}${slug}`;
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
 * @param {{execImpl?: Function, fsImpl?: typeof fs, base?: string}} [deps]
 *   base: commit sha to branch from instead of HEAD
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

  const branch = branchFor(slug);
  const base = typeof deps.base === 'string' && BASE_SHA_RE.test(deps.base) ? deps.base : 'HEAD';
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

module.exports = {
  removeWorktree,
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
