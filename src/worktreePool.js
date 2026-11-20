// ============================================================================
// LunaCore - main node_modules validation + optional warm worktree pool
// ----------------------------------------------------------------------------
// Two safeguards for worktree setup:
//   1. checkMainNodeModules / linkNodeModules: validates that the main
//      checkout's `node_modules` exists and holds at least one real (non-dot)
//      package before creating a worktree junction. Never links to a missing
//      or empty folder. Removal always unlinks junctions first via
//      worktrees.unlinkDependencyLinks before `git worktree remove`.
//   2. createWorktreePool: optional small pool of pre-warmed worktrees per
//      repo. Claiming a warm worktree resets it to the requested branch and
//      base commit, avoiding a full checkout when one is ready; draining
//      removes every unused warm worktree safely through removeWorktree.
// ============================================================================

'use strict';

const path = require('path');
const { plainFs } = require('./plainFs');

const DEPENDENCY_DIR = 'node_modules';
const DEFAULT_WARM_POOL_SIZE = 2;
const MAX_WARM_POOL_SIZE = 8;
const WARM_SLUG_PREFIX = 'warm-';
const BASE_SHA_RE = /^[0-9a-f]{7,64}$/;
// Only temporary warm branches created by this pool may ever be force-deleted.
const WARM_BRANCH_RE = /^(?:luna|luna-free|luna-plan)\/warm-[a-z0-9-]+$/;

const errText = (err) => (err instanceof Error ? err.message : String(err));

/** Case-insensitive resolved key on Windows so two spellings hit one pool bucket. */
function repoKey(repoPath) {
  const abs = path.resolve(String(repoPath || ''));
  return process.platform === 'win32' ? abs.toLowerCase() : abs;
}

/**
 * Validates that the main checkout's `node_modules` directory exists, is a
 * directory (dangling links fail statSync), and contains at least one real
 * non-dotfile dependency entry (`.bin` / `.package-lock.json` alone count as
 * empty).
 * @param {string} repoRoot
 * @param {object} [fsImpl]
 * @returns {{ok: true, dir: string, entries: number}
 *   | {ok: false, reason: 'badPath'|'missing'|'notDir'|'unreadable'|'empty', dir: string, detail: string}}
 */
function checkMainNodeModules(repoRoot, fsImpl = plainFs()) {
  if (typeof repoRoot !== 'string' || !repoRoot.trim()) {
    return { ok: false, reason: 'badPath', dir: '', detail: 'main checkout path is missing' };
  }
  const dir = path.resolve(repoRoot, DEPENDENCY_DIR);
  let st;
  try {
    st = fsImpl.statSync(dir);
  } catch {
    return { ok: false, reason: 'missing', dir, detail: `${dir} does not exist` };
  }
  if (!st || !st.isDirectory()) {
    return { ok: false, reason: 'notDir', dir, detail: `${dir} is not a directory` };
  }
  let entries;
  try {
    entries = fsImpl.readdirSync(dir);
  } catch (err) {
    return { ok: false, reason: 'unreadable', dir, detail: `${dir} cannot be read: ${errText(err)}` };
  }
  const packages = entries.filter((name) => !String(name).startsWith('.'));
  if (!packages.length) {
    return { ok: false, reason: 'empty', dir, detail: `${dir} is empty` };
  }
  return { ok: true, dir, entries: packages.length };
}

/**
 * Creates a `node_modules` junction/symlink from `worktreeRoot` to `mainRoot`
 * ONLY after confirming `mainRoot/node_modules` is populated. Refuses to
 * overwrite an existing target path.
 * @param {string} mainRoot
 * @param {string} worktreeRoot
 * @param {object} [fsImpl]
 * @returns {{ok: true, source: string, target: string}
 *   | {ok: false, error: 'badPath'|'emptyNodeModules'|'targetExists'|'linkFailed', reason?: string, detail: string}}
 */
function linkNodeModules(mainRoot, worktreeRoot, fsImpl = plainFs()) {
  if (typeof worktreeRoot !== 'string' || !worktreeRoot.trim()) {
    return { ok: false, error: 'badPath', detail: 'worktree path is missing' };
  }
  const check = checkMainNodeModules(mainRoot, fsImpl);
  if (!check.ok) {
    return { ok: false, error: 'emptyNodeModules', reason: check.reason, detail: check.detail };
  }
  const target = path.resolve(worktreeRoot, DEPENDENCY_DIR);
  let existing = null;
  try {
    existing = fsImpl.lstatSync(target);
  } catch {
    existing = null;
  }
  if (existing) {
    return { ok: false, error: 'targetExists', detail: `${target} already exists` };
  }
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  try {
    fsImpl.symlinkSync(check.dir, target, linkType);
    return { ok: true, source: check.dir, target };
  } catch (err) {
    return { ok: false, error: 'linkFailed', detail: `could not link ${target}: ${errText(err)}` };
  }
}

/** Clamps pool size to `1..MAX_WARM_POOL_SIZE`. */
function clampPoolSize(value) {
  if (!Number.isInteger(value) || value < 1) return DEFAULT_WARM_POOL_SIZE;
  return Math.min(value, MAX_WARM_POOL_SIZE);
}

/**
 * Creates an optional bounded warm worktree pool.
 * @param {{
 *   maxSize?: number,
 *   linkNodeModules?: boolean,
 *   branchPrefix?: string,
 *   addWorktree: Function,
 *   removeWorktree: Function,
 *   unlinkDependencyLinks?: Function,
 *   runGit: Function,
 *   copyEnvFiles: Function,
 *   slugify: Function,
 *   branchFor: Function,
 *   gitError: Function,
 *   firstLine: Function,
 *   fsImpl?: object,
 *   execImpl?: Function,
 *   now?: () => number,
 * }} [deps]
 */
function createWorktreePool(deps = {}) {
  const maxSize = clampPoolSize(deps.maxSize);
  const defaultLink = deps.linkNodeModules === true;
  const defaultBranchPrefix = deps.branchPrefix;
  const fsImpl = deps.fsImpl || plainFs();
  const execImpl = deps.execImpl;
  const now = deps.now || Date.now;
  /** @type {Map<string, {list: Array<object>, inFlight: number, epoch: number}>} */
  const buckets = new Map();
  let seq = 0;

  const bucketOf = (repoPath) => {
    const key = repoKey(repoPath);
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { list: [], inFlight: 0, epoch: 0 };
      buckets.set(key, bucket);
    }
    return bucket;
  };

  function pruneEmptyBucket(key) {
    const bucket = buckets.get(key);
    if (bucket && bucket.list.length === 0 && bucket.inFlight === 0) buckets.delete(key);
  }

  async function deleteWarmBranch(repoPath, branch, runExec) {
    if (typeof branch === 'string' && WARM_BRANCH_RE.test(branch)) {
      await deps.runGit(repoPath, ['branch', '-D', '--', branch], runExec);
    }
  }

  async function discardEntry(entry, opts = {}) {
    const rmExec = opts.execImpl || execImpl;
    const rmFs = opts.fsImpl || fsImpl;
    if (!rmFs.existsSync(entry.root)) {
      await deps.runGit(entry.repoPath, ['worktree', 'prune'], rmExec);
      await deleteWarmBranch(entry.repoPath, entry.branch, rmExec);
      return { ok: true };
    }
    const removed = await deps.removeWorktree(entry.repoPath, entry.root, { execImpl: rmExec, fsImpl: rmFs });
    if (removed && removed.ok) await deleteWarmBranch(entry.repoPath, entry.branch, rmExec);
    return removed;
  }

  async function resolveRepoRoot(repoPath, runExec) {
    const top = await deps.runGit(repoPath, ['rev-parse', '--show-toplevel'], runExec);
    const root = top.ok ? deps.firstLine(top.stdout) : '';
    return root ? path.resolve(root) : path.resolve(repoPath);
  }

  async function resolveStartRef(repoPath, base, runExec) {
    if (typeof base === 'string' && BASE_SHA_RE.test(base)) return base;
    const head = await deps.runGit(repoPath, ['rev-parse', '--verify', 'HEAD'], runExec);
    const sha = head.ok ? deps.firstLine(head.stdout) : '';
    return sha || null;
  }

  /**
   * Re-queues an untouched warm entry only if the repo was not drained since
   * `epoch` and the bucket is still below capacity; otherwise discards it.
   */
  async function returnOrDiscard(key, bucket, epoch, entry, opts) {
    if (buckets.get(key) === bucket && bucket.epoch === epoch && bucket.list.length < maxSize) {
      bucket.list.unshift(entry);
      return;
    }
    await discardEntry(entry, opts);
  }

  /**
   * Pre-creates one clean standby worktree for `repoPath` when the pool is
   * below `maxSize`. Validates main's `node_modules` up front when
   * `linkNodeModules` is enabled.
   */
  async function warm(repoPath, opts = {}) {
    if (typeof repoPath !== 'string' || !repoPath.trim()) {
      return { ok: false, error: 'badRepo', detail: 'repoPath is required' };
    }
    const key = repoKey(repoPath);
    const bucket = bucketOf(repoPath);
    if (bucket.list.length + bucket.inFlight >= maxSize) {
      return { ok: true, warmed: false, size: bucket.list.length };
    }
    const wantLink = typeof opts.linkNodeModules === 'boolean' ? opts.linkNodeModules : defaultLink;
    const runExec = opts.execImpl || execImpl;
    const runFs = opts.fsImpl || fsImpl;
    const warmEpoch = bucket.epoch;
    bucket.inFlight += 1;
    try {
      seq += 1;
      const stamp = now().toString(36).slice(-5);
      const warmName = `${WARM_SLUG_PREFIX}${seq}-${stamp}`;
      const wt = await deps.addWorktree(repoPath, warmName, {
        execImpl: runExec,
        fsImpl: runFs,
        branchPrefix: opts.branchPrefix || defaultBranchPrefix,
        linkNodeModules: wantLink,
      });
      if (!wt.ok) {
        // Clean up any partial worktree left when post-add linking failed.
        if (wt.root) await discardEntry({ repoPath, root: wt.root, branch: wt.branch || null }, opts);
        return wt;
      }
      const repoRoot = await resolveRepoRoot(repoPath, runExec);
      const entry = {
        repoPath,
        repoRoot,
        root: wt.root,
        cwd: wt.cwd,
        branch: wt.branch,
        nodeModulesLinked: wt.nodeModulesLinked === true,
        createdAt: now(),
      };
      if (bucket.epoch !== warmEpoch || bucket.list.length >= maxSize) {
        await discardEntry(entry, opts);
        return { ok: true, warmed: false, size: bucket.list.length };
      }
      bucket.list.push(entry);
      return {
        ok: true,
        warmed: true,
        size: bucket.list.length,
        root: entry.root,
        branch: entry.branch,
        ...(entry.nodeModulesLinked ? { nodeModulesLinked: true } : {}),
      };
    } finally {
      bucket.inFlight = Math.max(0, bucket.inFlight - 1);
      pruneEmptyBucket(key);
    }
  }

  /** Aligns a warm entry's node_modules junction state with `wantLink`. */
  async function syncJunction(entry, wantLink, runFs) {
    if (wantLink && !entry.nodeModulesLinked) {
      const linked = linkNodeModules(entry.repoRoot, entry.root, runFs);
      if (!linked.ok) return { action: 'returnErr', result: linked };
      entry.nodeModulesLinked = true;
      return { action: 'ok' };
    }
    if (!wantLink && entry.nodeModulesLinked) {
      if (typeof deps.unlinkDependencyLinks !== 'function') return { action: 'discard' };
      const unlinked = deps.unlinkDependencyLinks(entry.root, runFs);
      if (!unlinked || !unlinked.ok) return { action: 'discard' };
      entry.nodeModulesLinked = false;
    }
    return { action: 'ok' };
  }

  /** Attempts to claim one warm entry for `targetBranch`. */
  async function claimEntry(entry, { repoPath, targetBranch, wantLink, opts, runExec, runFs, key, bucket, epoch }) {
    if (!runFs.existsSync(entry.root)) {
      await discardEntry(entry, opts);
      return null;
    }
    const status = await deps.runGit(entry.root, ['status', '--porcelain'], runExec);
    if (!status.ok || status.stdout.trim()) {
      await discardEntry(entry, opts);
      return null;
    }
    const synced = await syncJunction(entry, wantLink, runFs);
    if (synced.action === 'returnErr') {
      await returnOrDiscard(key, bucket, epoch, entry, opts);
      return synced.result;
    }
    if (synced.action === 'discard') {
      await discardEntry(entry, opts);
      return null;
    }
    const startRef = await resolveStartRef(repoPath, opts.base, runExec);
    if (!startRef) {
      await returnOrDiscard(key, bucket, epoch, entry, opts);
      return null;
    }
    const checkedOut = await deps.runGit(entry.root, ['checkout', '-b', targetBranch, startRef], runExec);
    if (!checkedOut.ok) {
      if (/already exists/i.test(checkedOut.stderr)) {
        await returnOrDiscard(key, bucket, epoch, entry, opts);
        return { ok: false, error: 'gitFailed', detail: deps.gitError(checkedOut.stderr) || 'branch already exists' };
      }
      await discardEntry(entry, opts);
      return null;
    }
    if (entry.branch && entry.branch !== targetBranch) {
      await deleteWarmBranch(repoPath, entry.branch, runExec);
    }
    const envCopied = deps.copyEnvFiles(entry.repoRoot, entry.root, runFs);
    return {
      ok: true,
      cwd: entry.cwd,
      root: entry.root,
      branch: targetBranch,
      envCopied,
      fromPool: true,
      ...(entry.nodeModulesLinked ? { nodeModulesLinked: true } : {}),
    };
  }

  /**
   * Claims a pre-warmed worktree for `repoPath` and switches it onto the
   * requested branch, or falls back cleanly to `addWorktree` when the pool is
   * empty or the standby entry is no longer clean.
   */
  async function acquire(repoPath, name, opts = {}) {
    if (typeof repoPath !== 'string' || !repoPath.trim()) {
      return { ok: false, error: 'badRepo', detail: 'repoPath is required' };
    }
    const slug = deps.slugify(name);
    if (!slug) {
      return { ok: false, error: 'badName', detail: `no usable letters or digits in ${JSON.stringify(String(name))}` };
    }
    const wantLink = typeof opts.linkNodeModules === 'boolean' ? opts.linkNodeModules : defaultLink;
    const runExec = opts.execImpl || execImpl;
    const runFs = opts.fsImpl || fsImpl;
    const targetBranch = deps.branchFor(slug, opts.branchPrefix || defaultBranchPrefix);
    const key = repoKey(repoPath);
    const bucket = buckets.get(key);

    if (bucket) {
      const epoch = bucket.epoch;
      while (bucket.list.length > 0 && bucket.epoch === epoch) {
        const entry = bucket.list.shift();
        const claimed = await claimEntry(entry, { repoPath, targetBranch, wantLink, opts, runExec, runFs, key, bucket, epoch });
        if (claimed) {
          pruneEmptyBucket(key);
          return claimed;
        }
      }
      pruneEmptyBucket(key);
    }

    return deps.addWorktree(repoPath, name, {
      ...opts,
      execImpl: runExec,
      fsImpl: runFs,
      branchPrefix: opts.branchPrefix || defaultBranchPrefix,
      linkNodeModules: wantLink,
    });
  }

  /**
   * Removes every unused warm worktree for `repoPath` (or all repos when
   * omitted) through `removeWorktree` so junctions are always unlinked first.
   */
  async function drain(repoPath, opts = {}) {
    const keys = repoPath ? [repoKey(repoPath)] : [...buckets.keys()];
    let removed = 0;
    const errors = [];
    for (const key of keys) {
      const bucket = buckets.get(key);
      if (!bucket) continue;
      bucket.epoch += 1;
      const entries = bucket.list.splice(0);
      pruneEmptyBucket(key);
      for (const entry of entries) {
        const res = await discardEntry(entry, opts);
        if (res && res.ok) removed += 1;
        else errors.push((res && res.detail) || `could not remove ${entry.root}`);
      }
    }
    return { ok: errors.length === 0, removed, errors };
  }

  function stats(repoPath) {
    if (repoPath) {
      const bucket = buckets.get(repoKey(repoPath));
      return { size: bucket ? bucket.list.length : 0, maxSize };
    }
    let size = 0;
    for (const bucket of buckets.values()) size += bucket.list.length;
    return { size, maxSize };
  }

  return { warm, acquire, drain, stats, maxSize };
}

module.exports = {
  checkMainNodeModules,
  linkNodeModules,
  createWorktreePool,
  DEFAULT_WARM_POOL_SIZE,
  MAX_WARM_POOL_SIZE,
};
