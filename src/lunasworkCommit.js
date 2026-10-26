// ============================================================================
// LunaCore - Luna's Work: a local commit of the files the loop writes itself
// (LW 2.16 project skills, LW 2.22a CHANGELOG.md)
// ----------------------------------------------------------------------------
// commitPaths() puts exactly the given repo-relative paths into ONE commit on
// the checkout's branch:
//
//   - built off to the side: a throwaway index (read-tree HEAD + add the
//     paths), write-tree, commit-tree on HEAD. The checkout's own index and
//     every other change in it are left alone, and no project hook runs
//   - then those paths are staged and the checkout fast-forwarded to it
//   - NEVER pushed. God Mode branches every package worktree from the
//     checkout's HEAD (src/worktrees.js), so the commit rides in the next
//     iteration's merge and reaches origin with it - no side push
//
// Paths that do not exist are left out. Always resolves
// {ok, committed, sha?, error?, detail?}; a failure moves nothing (the commit
// object is left dangling, the files stay in the working tree).
// ============================================================================

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const GIT_TIMEOUT_MS = 30 * 1000;
const SHA_RE = /^[0-9a-f]{40}$/;
const BRANCH_REF_RE = /^refs\/heads\/[A-Za-z0-9._/-]{1,200}$/;
const MAX_PATHS = 50;
const MAX_PATH_CHARS = 300;
const MAX_MESSAGE_CHARS = 200;
const MAX_ERR_CHARS = 200;

const clip = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, MAX_ERR_CHARS);

/** A repo-relative path git may take after `--`: never absolute, never `..`, never an option. */
function safeRelPath(p) {
  if (typeof p !== 'string' || !p || p.length > MAX_PATH_CHARS || p.includes('\0')) return false;
  if (path.isAbsolute(p) || path.win32.isAbsolute(p) || /^[A-Za-z]:/.test(p) || p.startsWith('-') || p.startsWith('~')) return false;
  return p.replace(/\\/g, '/').split('/').every((s) => s && s !== '.' && s !== '..');
}

/**
 * @param {{execImpl?:Function, env?:()=>object}} [deps] execImpl: child_process.execFile compatible
 */
function createCommitter(deps = {}) {
  const execImpl = typeof deps.execImpl === 'function' ? deps.execImpl : execFile;
  const envOf = () => (typeof deps.env === 'function' ? deps.env() : process.env);

  function git(cwd, args, extraEnv = {}) {
    return new Promise((resolve) => {
      try {
        execImpl('git', args, { cwd, timeout: GIT_TIMEOUT_MS, windowsHide: true, maxBuffer: 1024 * 1024, env: { ...envOf(), ...extraEnv } },
          (err, stdout, stderr) => resolve({ ok: !err, out: String(stdout || '').trim(), err: clip(String(stderr || '').trim() || (err && err.message)) }));
      } catch (err) {
        resolve({ ok: false, out: '', err: clip(err && err.message) });
      }
    });
  }

  /** HEAD's tree plus the paths, built in a throwaway index. */
  async function treeWith(repoPath, paths) {
    const tmpIndex = path.join(os.tmpdir(), `lw-commit-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.index`);
    const extra = { GIT_INDEX_FILE: tmpIndex };
    try {
      // -f: a project that ignores .claude/ still gets exactly these files.
      for (const args of [['read-tree', 'HEAD'], ['add', '-f', '--', ...paths]]) {
        const res = await git(repoPath, args, extra);
        if (!res.ok) return { err: res.err };
      }
      const tree = await git(repoPath, ['write-tree'], extra);
      return tree.ok ? { tree: tree.out } : { err: tree.err };
    } finally {
      fs.rmSync(tmpIndex, { force: true });
    }
  }

  async function commitUnsafe(repoPath, paths, message) {
    const ref = await git(repoPath, ['symbolic-ref', '-q', 'HEAD']);
    if (!ref.ok || !BRANCH_REF_RE.test(ref.out) || ref.out.includes('..')) return { ok: false, committed: false, error: 'notOnBranch' };
    const built = await treeWith(repoPath, paths);
    const head = await git(repoPath, ['rev-parse', 'HEAD^{tree}']);
    if (!built.tree || !head.ok) return { ok: false, committed: false, error: 'notStaged', detail: built.err || head.err };
    if (built.tree === head.out) return { ok: true, committed: false };
    const commit = await git(repoPath, ['commit-tree', built.tree, '-p', 'HEAD', '-m', message]);
    if (!commit.ok || !SHA_RE.test(commit.out)) return { ok: false, committed: false, error: 'notCommitted', detail: commit.err };
    // Staged first: the fast-forward then finds these paths already matching its result.
    const staged = await git(repoPath, ['add', '-f', '--', ...paths]);
    const merged = staged.ok ? await git(repoPath, ['merge', '--ff-only', '-q', commit.out]) : staged;
    if (!merged.ok) return { ok: false, committed: false, error: 'notFastForwarded', detail: merged.err };
    return { ok: true, committed: true, sha: commit.out };
  }

  /**
   * @param {{repoPath:string, paths:string[], message:string}} opts
   * @returns {Promise<{ok:boolean, committed:boolean, sha?:string, error?:string, detail?:string}>}
   */
  async function commitPaths(opts) {
    const o = opts && typeof opts === 'object' ? opts : {};
    if (typeof o.repoPath !== 'string' || !path.isAbsolute(o.repoPath)) return { ok: false, committed: false, error: 'noRepo' };
    const wanted = [...new Set(Array.isArray(o.paths) ? o.paths : [])];
    if (!wanted.length || wanted.length > MAX_PATHS || !wanted.every(safeRelPath)) return { ok: false, committed: false, error: 'badPaths' };
    const message = clip(o.message).slice(0, MAX_MESSAGE_CHARS);
    if (!message) return { ok: false, committed: false, error: 'noMessage' };
    const paths = wanted.map((p) => p.replace(/\\/g, '/')).filter((p) => fs.existsSync(path.join(o.repoPath, p)));
    if (!paths.length) return { ok: true, committed: false };
    try {
      return await commitUnsafe(o.repoPath, paths, message);
    } catch (err) {
      return { ok: false, committed: false, error: 'crashed', detail: clip(err && err.message) };
    }
  }

  return { commitPaths };
}

module.exports = { createCommitter, safeRelPath };
