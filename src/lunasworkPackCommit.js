// ============================================================================
// LunaCore - Luna's Work: commit the design pack (docs/tbc_docs/LUNAS_WORK_PLAN.md)
// ----------------------------------------------------------------------------
// The Critic rewrites design/ARCHITECTURE.md and appends to DECISIONS.md,
// PLAYTEST_LOG.md and TEST_PLAN.md; the Director may append to DESIGN.md.
// Those edits land in the target checkout (the base branch). Left uncommitted,
// God Mode worktrees (branched from main) read stale docs, the docs never
// reach the remote, and a rollback leaves them in an unclear state.
//
// commitDesignPack() stages ONLY those design/ files, by explicit path (never
// `git add -A` / `.`), commits them with a pathspec so nothing else that is
// staged or dirty goes along, and pushes the base branch. Nothing changed =
// no commit. It never throws; a failure comes back as {ok:false, error} and
// the controller logs it and carries on.
//
// Order in the loop: the controller calls it after the Director and before
// the checkpoint tag, so iter-N tags a head that holds the design pack.
// lunasworkCheckpoint's rollback skips commits whose subject starts with
// PACK_COMMIT_PREFIX, so a revert never drops the design-pack history.
// ============================================================================

'use strict';

const { execGit, guardedGit, PACK_COMMIT_PREFIX } = require('./lunasworkCheckpoint');

const DESIGN_DIR = 'design';
// The files the Critic and the Director write.
const PACK_COMMIT_FILES = Object.freeze(['ARCHITECTURE.md', 'DECISIONS.md', 'PLAYTEST_LOG.md', 'TEST_PLAN.md', 'DESIGN.md']);
const BRANCH_RE = /^[A-Za-z0-9._/-]{1,200}$/;

// Repos whose last push failed: the next call pushes again even with nothing new.
const unpushed = new Set();

/** The commit subject of a pack commit. */
const packCommitMessage = (label) => `${PACK_COMMIT_PREFIX} ${String(label || 'design pack').replace(/[\x00-\x1f\x7f]+/g, ' ').trim().slice(0, 100)}`; // eslint-disable-line no-control-regex

/** True for a commit subject made by this module. */
const isPackCommitSubject = (subject) => String(subject || '').startsWith(PACK_COMMIT_PREFIX);

/**
 * @param {{repoPath:string, label?:string, git?:(cwd:string, args:string[])=>Promise<{ok:boolean,out:string,err:string}>}} o
 * @returns {Promise<{ok:boolean, committed:boolean, pushed:boolean, files:string[], error?:string, detail?:string}>}
 */
async function commitDesignPack(o) {
  const git = guardedGit((o && o.git) || execGit);
  const repoPath = o && o.repoPath;
  const out = { ok: true, committed: false, pushed: false, files: [] };
  const fail = (error, detail) => ({ ...out, ok: false, error, ...(detail ? { detail } : {}) });
  if (typeof repoPath !== 'string' || !repoPath) return fail('noRepo');

  const head = await git(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const branch = head.ok ? head.out : '';
  if (!BRANCH_RE.test(branch) || branch === 'HEAD' || branch.includes('..')) return fail('notOnBranch');

  const status = await git(repoPath, ['status', '--porcelain', '--untracked-files=all', '--', ...PACK_COMMIT_FILES.map((f) => `${DESIGN_DIR}/${f}`)]);
  if (!status.ok) return fail('statusFailed', status.err);
  // The runner trims the output, so the first line may have lost its leading status space.
  const changed = new Set(status.out.split('\n').map((line) => line.replace(/^\s*\S+\s+/, '').trim()));
  const files = PACK_COMMIT_FILES.map((f) => `${DESIGN_DIR}/${f}`).filter((p) => changed.has(p));

  if (files.length) {
    const added = await git(repoPath, ['add', '--', ...files]);
    if (!added.ok) return fail('addFailed', added.err);
    // The pathspec commits these files only, even when something else is staged.
    const made = await git(repoPath, ['commit', '-m', packCommitMessage(o.label), '--', ...files]);
    if (!made.ok) return fail('commitFailed', made.err);
    out.committed = true;
    out.files = files;
    unpushed.add(repoPath);
  } else if (!unpushed.has(repoPath)) {
    return out;
  }

  const pushed = await git(repoPath, ['push', 'origin', `refs/heads/${branch}:refs/heads/${branch}`]);
  if (!pushed.ok) return fail('pushFailed', pushed.err);
  unpushed.delete(repoPath);
  return { ...out, pushed: true };
}

module.exports = { PACK_COMMIT_PREFIX, PACK_COMMIT_FILES, packCommitMessage, isPackCommitSubject, commitDesignPack };
