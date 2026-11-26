// ============================================================================
// LunaCore - Luna's Work: git hygiene at the end of a run
// ----------------------------------------------------------------------------
// Every build makes one worktree + `luna/<pkg>-<stamp>` branch per God Mode
// package, and a red self-check pushes its integration branch. God Mode's own
// post-merge cleanup (orchestraCleanup.cleanupMergedRun) runs only when a
// merge lands, and the machine guard's (lunasworkMachine) only between builds
// for pushed, clean worktrees - so a run used to leave its last iterations'
// worktrees and branches behind (one Unity run: 11 worktrees, 8 local
// branches and one on origin).
//
// The controller records the branches each build used (runBranchesOf, kept
// on run.branches). When the run ends, with any verdict, atRunEnd():
//
//   1. lists what LunaCore writes and left uncommitted in the checkout
//      (design/ and .gitattributes) and logs it
//   2. fetches origin (--prune), so "merged" is judged against origin/<base>
//   3. removes the worktree of every recorded branch - never one with an open
//      tab, never a dirty one (worktrees.removeWorktree refuses it, and it
//      unlinks node_modules junctions first, so their targets keep every file).
//      removeWorktree closes Unity editors open on the worktree first; then
//      any editor still open under .luna-worktrees/<project> is closed too
//      (src/unityWorktreeEditors.js) - never one on the main checkout, never
//      one on a worktree with an open tab
//   4. deletes each recorded local and remote luna/ branch whose tip
//      origin/<base> contains: merged, or merged and later rolled back (the
//      revert commits come after it). A branch with unmerged work (a red
//      integration branch, a package that never merged) is kept.
//
// Nothing is removed while God Mode has a plan open on the project. The
// result rides on the run snapshot (run.gitCleanup) into the run report,
// whose "Branches and worktrees" section (cleanupSection) lists every kept
// branch and worktree folder and why, and every Unity editor it closed. Every function resolves and never rejects.
// ============================================================================

'use strict';

const path = require('path');
const worktrees = require('./worktrees');
const unityEditors = require('./unityWorktreeEditors');

// Only LunaCore's own branch names (worktrees.js deletes nothing else).
const OWN_BRANCH_RE = /^luna\/[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_RUN_BRANCHES = 200;
const MAX_LISTED = 50;
// What LunaCore writes into the checkout itself: the design pack and (older builds) .gitattributes.
const LUNACORE_PATHS = Object.freeze(['design', '.gitattributes']);
const REASONS = Object.freeze({
  notMerged: 'unmerged work',
  checkedOut: 'its worktree is still there',
  dirty: 'uncommitted changes',
  openTab: 'a tab is open in it',
  godModeBusy: 'God Mode had a plan open on the project',
  linkRemoveFailed: 'a node_modules link would not go',
  gitFailed: 'git failed',
  editorOpen: 'a Unity editor on it would not close',
});

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const errText = (err) => (err instanceof Error ? err.message : String(err));
const reasonText = (r) => REASONS[r] || String(r || 'failed').slice(0, 60);
const samePath = (a, b) => {
  const norm = (p) => path.resolve(p).replace(/[\\/]+$/, '').toLowerCase();
  return norm(a) === norm(b);
};
const isWithin = (parent, child) => unityEditors.isWithin(parent, child);

// ---- pure ----------------------------------------------------------------------------

/** `known` plus `more`: each luna/ name once, oldest dropped past MAX_RUN_BRANCHES (also the stored-run check). */
function withRunBranches(known, more = []) {
  const all = [...(Array.isArray(known) ? known : []), ...(Array.isArray(more) ? more : [])];
  return [...new Set(all.filter((b) => typeof b === 'string' && OWN_BRANCH_RE.test(b)))].slice(-MAX_RUN_BRANCHES);
}

/** The luna/ branches one build used: its packages' (God Mode's settled view) and a pushed red integration branch. */
function runBranchesOf(buildResult) {
  const r = isObj(buildResult) ? buildResult : {};
  const packages = isObj(r.plan) && Array.isArray(r.plan.packages) ? r.plan.packages : [];
  const selfCheck = isObj(r.integration) && isObj(r.integration.selfCheck) ? r.integration.selfCheck : {};
  return withRunBranches(packages.map((p) => (isObj(p) ? p.branch : null)), [selfCheck.pushedIntegrationBranch]);
}

/** `git status --porcelain` -> the paths (a rename gives its new name). */
function porcelainPaths(out) {
  return String(out || '')
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 3)
    .map((l) => {
      const p = l.slice(3);
      const arrow = p.indexOf(' -> ');
      return (arrow >= 0 ? p.slice(arrow + 4) : p).replace(/^"|"$/g, '');
    });
}

/**
 * The run report's "Branches and worktrees" section, or null when the run
 * had nothing to clean up.
 * @param {object} result atRunEnd's answer (run.gitCleanup)
 * @param {{forEmail?:boolean}} [opts] forEmail: worktree folder names only, no local paths
 * @returns {{intro:string, items:string[]}|null}
 */
function cleanupSection(result, opts = {}) {
  if (!isObj(result)) return null;
  const where = (root) => (opts.forEmail ? path.basename(String(root)) : String(root));
  const wt = isObj(result.worktrees) ? result.worktrees : { removed: [], kept: [] };
  const local = isObj(result.branches) ? result.branches : { deleted: [], kept: [] };
  const remote = isObj(result.remote) ? result.remote : { deleted: [], kept: [] };
  const files = Array.isArray(result.files) ? result.files : [];
  const kept = new Map();
  for (const [where, list] of [['local', local.kept], ['origin', remote.kept]]) {
    for (const k of Array.isArray(list) ? list : []) {
      const entry = kept.get(k.branch) || { where: [], reason: reasonText(k.reason) };
      kept.set(k.branch, { ...entry, where: [...entry.where, where] });
    }
  }
  const editors = isObj(result.editors) ? result.editors : {};
  const closed = Array.isArray(editors.closed) ? editors.closed.filter(isObj) : [];
  const notClosed = Array.isArray(editors.failed) ? editors.failed.filter(isObj) : [];
  const editorAt = (e) => (typeof e.projectPath === 'string' && e.projectPath ? where(e.projectPath) : 'an unknown folder');
  const items = [
    ...[...kept].map(([branch, k]) => `Kept ${branch} (${k.where.join(' + ')}): ${k.reason}`),
    ...(Array.isArray(wt.kept) ? wt.kept : []).map((w) => `Worktree kept: ${where(w.root)} (${w.branch}): ${reasonText(w.reason)}`),
    ...closed.map((e) => `Closed Unity editor on ${editorAt(e)} (pid ${e.pid}, ${e.how === 'killed' ? 'killed' : 'quit'})`),
    ...notClosed.map((e) => `Unity editor not closed: ${editorAt(e)}${e.pid ? ` (pid ${e.pid})` : ''}`),
    ...files.map((f) => `Uncommitted in the checkout: ${f}`),
  ].slice(0, MAX_LISTED);
  const counts = [wt.removed.length, local.deleted.length, remote.deleted.length];
  if (!items.length && !counts.some(Boolean) && !result.error) return null;
  const error = result.error ? ` Cleanup stopped early: ${reasonText(result.error)}.` : '';
  const editorNote = closed.length ? ` Closed ${closed.length} Unity editor(s) left open on worktrees.` : '';
  return {
    intro: `Removed ${counts[0]} worktree(s); deleted ${counts[1]} local and ${counts[2]} origin branch(es) already on the base branch.${editorNote}${error}`,
    items,
  };
}

// ---- git ---------------------------------------------------------------------------

const DEFAULT_GIT = Object.freeze({
  run: (cwd, args) => worktrees.runGit(cwd, args),
  listWorktrees: (repo) => worktrees.listWorktrees(repo),
  removeWorktree: (repo, root) => worktrees.removeWorktree(repo, root),
  pruneWorktrees: (repo) => worktrees.pruneWorktrees(repo),
  deleteMergedBranch: (repo, branch, base) => worktrees.deleteMergedBranch(repo, branch, base),
  deleteMergedRemoteBranch: (repo, branch, base) => worktrees.deleteMergedRemoteBranch(repo, branch, base),
  pruneOrigin: (repo) => worktrees.pruneOrigin(repo),
});

// The sweep looks for a Unity project up to the worktree folder's sub-folders' sub-folders.
const SWEEP_PROJECT_DEPTH = 3;
const DEFAULT_CLOSE_EDITORS = (root, opts) => unityEditors.closeEditorsIfUnity(root, { ...opts, maxDepth: SWEEP_PROJECT_DEPTH });

/**
 * @param {{git?:Partial<typeof DEFAULT_GIT>, inUse?:(root:string)=>boolean, busy?:(run:object)=>boolean,
 *   log?:(line:string)=>void, closeEditors?:(root:string, opts:object)=>Promise<{closed:object[], failed:object[]}>}} [deps]
 *   inUse: a tab is open in that folder (without it every worktree counts as in use and stays)
 *   busy: God Mode has a plan open on the run's project
 *   closeEditors: the end-of-run sweep of Unity editors under the project's worktree folder
 */
function createRunCleanup(deps = {}) {
  const git = { ...DEFAULT_GIT, ...(isObj(deps.git) ? deps.git : {}) };
  const inUse = typeof deps.inUse === 'function' ? deps.inUse : () => true;
  const busy = typeof deps.busy === 'function' ? deps.busy : () => false;
  const log = typeof deps.log === 'function' ? deps.log : () => {};
  const closeEditors = typeof deps.closeEditors === 'function' ? deps.closeEditors : DEFAULT_CLOSE_EDITORS;

  async function leftoverFiles(repoPath) {
    const res = await git.run(repoPath, ['status', '--porcelain', '--untracked-files=all', '--', ...LUNACORE_PATHS]);
    return res && res.ok ? porcelainPaths(res.stdout).slice(0, MAX_LISTED) : [];
  }

  async function baseBranch(repoPath) {
    const res = await git.run(repoPath, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
    const name = res && res.ok ? String(res.stdout).trim() : '';
    return worktrees.isSafeBase(name) && !OWN_BRANCH_RE.test(name) ? name : null;
  }

  /** Adds a removeWorktree / closeEditors answer's editors to out.editors. */
  function addEditors(out, editors) {
    if (!isObj(editors)) return;
    for (const key of ['closed', 'failed']) {
      if (Array.isArray(editors[key])) out.editors[key].push(...editors[key].filter(isObj));
    }
  }

  async function removeWorktrees(repoPath, branches, out) {
    const listed = await git.listWorktrees(repoPath);
    if (!Array.isArray(listed)) return { error: 'worktreeListFailed', listed: null };
    const own = new Set(branches);
    for (const w of listed) {
      if (!isObj(w) || !own.has(w.branch) || samePath(w.root, repoPath)) continue;
      if (inUse(w.root)) {
        out.worktrees.kept.push({ root: w.root, branch: w.branch, reason: 'openTab' });
        continue;
      }
      const res = await git.removeWorktree(repoPath, w.root);
      addEditors(out, res && res.editors);
      if (res && res.ok) {
        out.worktrees.removed.push(w.root);
        if (res.fallback) log(`[lunaswork] worktree ${w.root} deleted without git (${res.fallback})`);
        continue;
      }
      const editorStuck = isObj(res && res.editors) && Array.isArray(res.editors.failed) && res.editors.failed.length > 0;
      const reason = editorStuck && res.error === 'gitFailed' ? 'editorOpen' : (res && res.error) || 'failed';
      out.worktrees.kept.push({ root: w.root, branch: w.branch, reason });
      log(`[lunaswork] worktree ${w.root} kept: ${(res && (res.detail || res.error)) || 'failed'}`);
    }
    const pruned = await git.pruneWorktrees(repoPath);
    if (pruned && pruned.ok === false) log(`[lunaswork] git worktree prune failed: ${pruned.detail || pruned.error || 'failed'}`);
    return { error: null, listed };
  }

  /**
   * Closes any Unity editor still open under the project's worktree folder
   * (.luna-worktrees/<project>) - never one on the main checkout or the run's
   * repoPath, never one on a worktree with an open tab.
   */
  async function sweepEditors(run, listed, out, tag) {
    const main = listed.find((w) => isObj(w) && typeof w.root === 'string');
    if (!main) return;
    const mainRoot = path.resolve(main.root);
    const sweepRoot = path.dirname(worktrees.worktreePathFor(mainRoot, 'x'));
    const openTabs = listed.filter((w) => isObj(w) && typeof w.root === 'string' && !samePath(w.root, mainRoot) && inUse(w.root)).map((w) => w.root);
    const skip = (projectPath) => openTabs.some((root) => isWithin(root, projectPath));
    let res;
    try {
      res = await closeEditors(sweepRoot, { repoPath: [mainRoot, run.repoPath], skip });
    } catch (err) {
      res = { closed: [], failed: [{ pid: null, projectPath: null, detail: errText(err).slice(0, 200) }] };
    }
    addEditors(out, res);
    for (const f of isObj(res) && Array.isArray(res.failed) ? res.failed : []) {
      log(`${tag}: Unity editor ${(f && f.pid) || '?'} not closed: ${(f && f.detail) || 'failed'}`);
    }
    const closed = isObj(res) && Array.isArray(res.closed) ? res.closed.length : 0;
    if (closed) log(`${tag}: closed ${closed} Unity editor(s) still open under ${sweepRoot}`);
  }

  /** Deletes what origin/<base> contains, locally and on origin; 'missing' = already gone. */
  async function deleteBranches(repoPath, branches, base, out) {
    for (const [del, bucket] of [[git.deleteMergedBranch, out.branches], [git.deleteMergedRemoteBranch, out.remote]]) {
      for (const branch of branches) {
        const res = await del(repoPath, branch, base);
        if (res && res.ok) bucket.deleted.push(branch);
        else if (!res || res.error !== 'missing') bucket.kept.push({ branch, reason: (res && res.error) || 'failed' });
      }
    }
  }

  /**
   * @param {{id?:string, repoPath?:string, branches?:string[]}} run the finished run
   * @returns {Promise<{ok:boolean, files:string[], worktrees:{removed:string[], kept:object[]},
   *   branches:{deleted:string[], kept:object[]}, remote:{deleted:string[], kept:object[]}, error?:string}>}
   */
  async function atRunEnd(run) {
    const out = {
      ok: true,
      files: [],
      worktrees: { removed: [], kept: [] },
      branches: { deleted: [], kept: [] },
      remote: { deleted: [], kept: [] },
      editors: { closed: [], failed: [] },
    };
    const tag = `[lunaswork] run ${isObj(run) ? String(run.id || '?').slice(0, 64) : '?'}`;
    try {
      if (!isObj(run) || typeof run.repoPath !== 'string' || !path.isAbsolute(run.repoPath)) return { ...out, ok: false, error: 'noRepo' };
      out.files = await leftoverFiles(run.repoPath);
      if (out.files.length) log(`${tag} left uncommitted LunaCore files in the checkout: ${out.files.join(', ')}`);
      const branches = withRunBranches(run.branches);
      if (!branches.length) return out;
      if (busy(run)) {
        out.branches.kept.push(...branches.map((branch) => ({ branch, reason: 'godModeBusy' })));
        log(`${tag}: God Mode has a plan open on the project - its ${branches.length} branch(es) are left for later`);
        return out;
      }
      const base = await baseBranch(run.repoPath);
      if (!base) return { ...out, ok: false, error: 'noBaseBranch' };
      const fetched = await git.pruneOrigin(run.repoPath);
      // A stale origin/<base> only makes fewer branches look merged: the cleanup still goes on.
      if (!fetched || !fetched.ok) log(`${tag}: fetch from origin failed (${(fetched && (fetched.detail || fetched.error)) || 'failed'})`);
      const removal = await removeWorktrees(run.repoPath, branches, out);
      if (removal.error) out.error = removal.error;
      else await sweepEditors(run, removal.listed, out, tag);
      await deleteBranches(run.repoPath, branches, base, out);
      const kept = new Set([...out.branches.kept, ...out.remote.kept].map((k) => k.branch));
      log(`${tag} cleanup: ${out.worktrees.removed.length} worktree(s) removed, ${out.branches.deleted.length} local + ${out.remote.deleted.length} origin branch(es) deleted${kept.size ? `, kept ${[...kept].join(', ')}` : ''}`);
      return out;
    } catch (err) {
      // The detail (it may hold a local path) goes to the log only, never into the report or email.
      log(`${tag} cleanup failed: ${errText(err)}`);
      return { ...out, ok: false, error: 'failed' };
    }
  }

  return { atRunEnd };
}

module.exports = { MAX_RUN_BRANCHES, LUNACORE_PATHS, withRunBranches, runBranchesOf, porcelainPaths, cleanupSection, createRunCleanup };
