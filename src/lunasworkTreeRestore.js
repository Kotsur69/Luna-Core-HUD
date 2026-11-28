// ============================================================================
// LunaCore - Luna's Work rollback fallback: restore the good tag's tree
// ----------------------------------------------------------------------------
// The rollback (src/lunasworkCheckpoint.js) first reverts every commit since
// the last good tag in one `git revert` sequence. That sequence can conflict:
// the design-pack commits are kept (left out of the sequence), so a package
// that edited the same design doc no longer reverts cleanly, and other
// skipped commits (revert pairs) can do the same. Then the rollback lands the
// good tag's tree on top of the broken head in ONE new commit instead:
//
//   - in a throwaway worktree added with --no-checkout (nothing is written to
//     disk, no LFS smudge, no dirty-worktree surprises), the index is set to
//     the good tree with `git read-tree <good>`
//   - the design docs the design-pack commits touched are taken from the
//     broken head, exactly as the revert path keeps those commits
//   - `git write-tree` + `git commit-tree -p <head>` make the commit; its only
//     parent is the broken head, so the push is a plain fast-forward
//
// The worktree's own index is the scratch index: the checkpoint module's git
// runner takes no env, so src/gitScratchIndex.js (GIT_INDEX_FILE) does not fit.
// No reset, no force-push, no history rewrite: the caller pushes the commit
// the same way it pushes its revert commits, through its guarded runner.
// ============================================================================

'use strict';

const SHA_RE = /^[0-9a-f]{40}$/;
// `git ls-tree -z` entry: "<mode> <type> <sha>\t<path>".
const LS_TREE_RE = /^([0-7]{6}) [a-z]+ ([0-9a-f]{40})\t(.+)$/;
const MAX_DETAIL = 300;

/** The subject of the one commit that restores a good tag's tree. */
const treeSubject = (toTag) => `revert: roll back to ${toTag}`;

/** `git ls-tree -z` output -> [{mode, sha, path}]. */
function parseLsTree(out) {
  return String(out || '')
    .split('\0')
    .map((entry) => LS_TREE_RE.exec(entry))
    .filter(Boolean)
    .map(([, mode, sha, file]) => ({ mode, sha, path: file }));
}

/** The commit message (as `-m` args) of a tree restore. */
function treeMessageArgs({ toTag, goodSha, fromTag, undone, revertDetail }) {
  const body = [
    `Restores the tree of ${toTag} (${String(goodSha).slice(0, 12)}) in one commit: reverting the ${undone} commit(s) since it one by one did not go through.`,
    `The rolled-back work stays on the tag ${fromTag}.`,
  ];
  const why = String(revertDetail || '').trim();
  if (why) body.push(`The revert stopped with: ${why.slice(0, MAX_DETAIL)}`);
  return ['-m', treeSubject(toTag), '-m', body.join('\n')];
}

/** Puts headSha's version of every kept path into the index (or drops the path when headSha has none). */
async function keepFromHead(step, headSha, keep) {
  if (!keep.length) return { ok: true };
  const listed = await step('ls-tree', ['ls-tree', '-z', headSha, '--', ...keep]);
  if (!listed.ok) return listed;
  const entries = parseLsTree(listed.out);
  if (entries.length) {
    const added = await step('update-index', ['update-index', '--add', ...entries.flatMap((e) => ['--cacheinfo', `${e.mode},${e.sha},${e.path}`])]);
    if (!added.ok) return added;
  }
  const atHead = new Set(entries.map((e) => e.path));
  const gone = keep.filter((p) => !atHead.has(p));
  // --no-checkout: the file is missing on disk, so --remove drops it from the index.
  if (gone.length) return step('update-index', ['update-index', '--remove', '--', ...gone]);
  return { ok: true };
}

/**
 * Builds the restore commit inside `dir` (a worktree added with --detach
 * --no-checkout at headSha). Leaves the worktree's index empty again, so the
 * worktree removes cleanly.
 * @param {(cwd:string, args:string[])=>Promise<{ok:boolean, out:string, err:string}>} git guarded runner
 * @param {string} dir
 * @param {{headSha:string, goodSha:string, keep?:string[], message:string[]}} o
 *   keep: paths taken from headSha (absent there = absent in the result)
 * @returns {Promise<{ok:true, sha:string}|{ok:false, step:string, detail:string}>}
 */
async function commitGoodTree(git, dir, { headSha, goodSha, keep, message }) {
  const step = async (name, args) => {
    const res = await git(dir, args);
    return res.ok ? { ok: true, out: String(res.out || '').trim() } : { ok: false, step: name, detail: res.err };
  };
  try {
    const read = await step('read-tree', ['read-tree', goodSha]);
    if (!read.ok) return read;
    const kept = await keepFromHead(step, headSha, Array.isArray(keep) ? keep : []);
    if (!kept.ok) return kept;
    const tree = await step('write-tree', ['write-tree']);
    if (!tree.ok) return tree;
    if (!SHA_RE.test(tree.out)) return { ok: false, step: 'write-tree', detail: `not a tree sha: ${tree.out.slice(0, 80) || '(empty)'}` };
    const made = await step('commit-tree', ['commit-tree', tree.out, '-p', headSha, ...message]);
    if (!made.ok) return made;
    if (!SHA_RE.test(made.out)) return { ok: false, step: 'commit-tree', detail: `not a commit sha: ${made.out.slice(0, 80) || '(empty)'}` };
    return { ok: true, sha: made.out };
  } finally {
    // An empty index matches the empty --no-checkout folder: `worktree remove` takes it.
    await git(dir, ['read-tree', '--empty']);
  }
}

module.exports = { treeSubject, parseLsTree, treeMessageArgs, commitGoodTree };
