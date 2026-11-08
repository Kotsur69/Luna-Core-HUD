// ============================================================================
// LunaCore - God Mode v2 per-worker finish (DONE_ORCHESTRATOR_PLAN.md slice 4, §4)
// ----------------------------------------------------------------------------
// Deterministic, run by LunaCore rather than trusted to the worker, after a
// worker prints LUNA_DONE:
//
//   0. plan guard - plan-run packages only (pkg.planRun): changes outside
//                   docs/plans/<run>/ are reverted and the package stalls;
//                   a topic doc without sources stalls (orchestraPlanRun.js)
//   1. leftovers  - uncommitted changes in the worktree are committed as
//                   `chore: luna wip <pkg>` so nothing is lost
//   2. commits?   - a branch with no commit past its base did no work
//   3. secrets    - before the first push, the unpushed commits are scanned
//                   for secret shapes (pushSecrets.js): GitHub push
//                   protection would reject them in ANY commit; a HEAD that
//                   GitHub already rejected is never pushed again as-is
//   4. verify     - the package's verify command, in the worktree, by us
//                   (verifyQueue.js runs them one at a time)
//   5. push       - `git push -u origin <branch>`; never main, never --force
//
// The verify command comes from the planner (model output) and runs through
// a shell, the same trust level the worker already has in that worktree - it
// runs the very same command itself under the brief. It is bounded by a
// timeout (its whole process tree is stopped past it) and only ever runs in
// the package's own worktree.
//
// Every function resolves a typed result and never rejects.
// ============================================================================

'use strict';

const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const { runGit, firstLine } = require('./worktrees');
const { checkCwd } = require('./projects');
const { killTree } = require('./procTree');
const secrets = require('./pushSecrets');
const planRun = require('./orchestraPlanRun');

// Counted from the moment a verify starts (verifyQueue.js queues them); the
// full suite alone takes 11-14 min.
const VERIFY_TIMEOUT_MS = 30 * 60 * 1000;
const VERIFY_MAX_BUFFER = 4 * 1024 * 1024;
// After the tree-kill, how long the exec callback may take before the
// verify is given up on anyway (a kill that did not take).
const KILL_GRACE_MS = 30 * 1000;
// Room for the patch of every unpushed commit (the secret scan).
const SCAN_MAX_BUFFER = 16 * 1024 * 1024;

const errText = (err) => (err instanceof Error ? err.message : String(err));

// A real timer must not keep a test process (or a quitting app) alive.
const unref = (t) => {
  if (t && typeof t.unref === 'function') t.unref();
  return t;
};

/**
 * Runs a verify command in `cwd`. Output is stdout + stderr, for pasting the
 * failure back to the worker. Past opts.timeoutMs the WHOLE process tree is
 * stopped (procTree.killTree: npm -> node -> test workers), not only the
 * shell, and the result says timedOut.
 * @param {string} command
 * @param {string} cwd
 * @param {Function} [execImpl]
 * @param {{timeoutMs?:number, killTree?:Function, setTimer?:Function, clearTimer?:Function}} [opts]
 * @returns {Promise<{ok:boolean, output:string, timedOut:boolean}>}
 */
function runVerify(command, cwd, execImpl = exec, opts = {}) {
  const run = execImpl || exec;
  const timeoutMs = Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0 ? opts.timeoutMs : VERIFY_TIMEOUT_MS;
  const setTimer = opts.setTimer || setTimeout;
  const clearTimer = opts.clearTimer || clearTimeout;
  const kill = opts.killTree || killTree;
  const stopped = `[LunaCore: verify timed out after ${Math.round(timeoutMs / 60000)} min - its process tree was stopped]`;
  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    let timer = null;
    let grace = null;
    let child = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimer(timer);
      if (grace) clearTimer(grace);
      resolve(result);
    };
    try {
      child = run(command, { cwd, windowsHide: true, maxBuffer: VERIFY_MAX_BUFFER }, (err, stdout, stderr) => {
        const output = `${String(stdout || '')}\n${String(stderr || '')}`.trim();
        finish({ ok: !err && !timedOut, output: timedOut ? `${output}\n${stopped}`.trim() : output, timedOut });
      });
    } catch (err) {
      finish({ ok: false, output: errText(err), timedOut: false });
      return;
    }
    if (settled) return;
    timer = unref(
      setTimer(() => {
        timer = null;
        timedOut = true;
        const pid = child && child.pid;
        // killFailed: the tree may still run - the queue must not start
        // another suite next to it.
        let killFailed = !Number.isInteger(pid);
        Promise.resolve()
          .then(() => (Number.isInteger(pid) ? kill(pid) : { ok: false }))
          .then((r) => {
            killFailed = !(r && r.ok);
          })
          .catch(() => {
            killFailed = true;
          });
        grace = unref(setTimer(() => finish({ ok: false, output: stopped, timedOut: true, killFailed }), KILL_GRACE_MS));
      }, timeoutMs),
    );
  });
}

/** HEAD of a worktree, or null. */
async function headSha(root, execImpl) {
  const res = await runGit(root, ['rev-parse', 'HEAD'], execImpl);
  return res.ok ? firstLine(res.stdout) || null : null;
}

/**
 * The commits of this branch that never reached origin, as a range for the
 * worker: past the branch's own remote ref when it was pushed before, else
 * past the package's base.
 */
async function unpushedRange(pkg, execImpl) {
  const remote = await runGit(pkg.root, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${pkg.branch}`], execImpl);
  if (remote.ok && firstLine(remote.stdout)) return `origin/${pkg.branch}..HEAD`;
  return `${pkg.baseSha || 'HEAD~1'}..HEAD`;
}

/**
 * Secret shapes on the lines added by every commit since the base that is not
 * on origin yet - GitHub push protection checks each pushed commit, not only
 * the net diff. A scan that cannot run never blocks: the push (and GitHub's
 * own check) still decides.
 * @returns {Promise<{hits:Array<object>, error:string|null}>}
 */
async function scanUnpushed(pkg, execImpl) {
  if (!pkg.baseSha) return { hits: [], error: 'no base commit' };
  const args = [
    'log', '-p', '--no-merges', '--no-color', '--no-ext-diff', '--no-textconv', '--text', '--unified=0',
    `--format=${secrets.COMMIT_MARK}%H`, `${pkg.baseSha}..HEAD`, '--not', '--remotes=origin', '--',
  ];
  const res = await runGit(pkg.root, args, execImpl, { maxBuffer: SCAN_MAX_BUFFER });
  if (!res.ok) return { hits: [], error: firstLine(res.stderr) || 'git log failed' };
  return { hits: secrets.scanAddedLines(res.stdout), error: null };
}

/**
 * Before verify and push: the HEAD GitHub already rejected is never pushed
 * again as-is, and (when asked) the unpushed commits are scanned for secret
 * shapes. Resolves the failed result, or null to go on.
 */
async function prePushBlock(pkg, execImpl) {
  if (pkg.pushBlockedSha) {
    const head = await headSha(pkg.root, execImpl);
    if (head && head === pkg.pushBlockedSha) {
      return {
        ok: false,
        stage: 'push',
        blocked: 'unchanged',
        detail: `not pushed again: HEAD ${head.slice(0, 7)} is the same commit GitHub already rejected (GH013)`,
        headSha: head,
        range: await unpushedRange(pkg, execImpl),
      };
    }
  }
  if (!pkg.scanSecrets) return null;
  const scan = await scanUnpushed(pkg, execImpl);
  if (!scan.hits.length) return null;
  return { ok: false, stage: 'secrets', hits: scan.hits, range: await unpushedRange(pkg, execImpl) };
}

/** A file's text, or null when it cannot be read. */
async function readTextOrNull(file) {
  try {
    return await fs.promises.readFile(file, 'utf8');
  } catch {
    return null;
  }
}

// git argv that undoes one change outside the plan folder. Literal pathspecs:
// a path from `git status` / `git diff` is never read as pathspec magic.
const REVERT_ARGS = {
  checkout: (p) => ['--literal-pathspecs', 'checkout', 'HEAD', '--', p],
  rmIndexed: (p) => ['--literal-pathspecs', 'rm', '-f', '-q', '--', p],
  remove: (p) => ['--literal-pathspecs', 'clean', '-f', '-q', '--', p],
  restoreBase: (p, base) => ['--literal-pathspecs', 'checkout', base, '--', p],
  dropAdded: (p) => ['--literal-pathspecs', 'rm', '-f', '-q', '--', p],
};

/** Runs revert actions; returns the paths that were and were not reverted. */
async function runReverts(pkg, actions, execImpl) {
  const done = [];
  const failed = [];
  for (const r of actions) {
    const res = await runGit(pkg.root, REVERT_ARGS[r.action](r.path, pkg.baseSha), execImpl);
    (res.ok ? done : failed).push(r.path);
  }
  return { done, failed };
}

/**
 * The plan-run finish guard (orchestraPlanRun.planRunFinishCheck): changes
 * outside docs/plans/<run>/ are reverted and the package stalls
 * `outsidePlanFolder` - uncommitted ones (tracked -> checkout, untracked ->
 * removed) and committed ones since the base (restored to the base, then
 * committed, so the next finish does not undo the revert). A topic doc
 * without sources stalls `noSources`. Resolves the failed result, or null.
 * @returns {Promise<null | {ok:false, stage:'planGuard'|'commit', reason?:string, detail:string,
 *   reverted?:string[], revertFailed?:string[]}>}
 */
async function planRunGuard(pkg, execImpl, readFileImpl = readTextOrNull) {
  const pr = pkg.planRun;
  const status = await runGit(pkg.root, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], execImpl);
  if (!status.ok) return { ok: false, stage: 'commit', detail: firstLine(status.stderr) };
  let committed = '';
  if (pkg.baseSha) {
    const diff = await runGit(pkg.root, ['diff', '--name-status', '-z', '--no-renames', `${pkg.baseSha}..HEAD`, '--'], execImpl);
    if (!diff.ok) return { ok: false, stage: 'commit', detail: firstLine(diff.stderr) };
    committed = diff.stdout;
  }
  const topicDoc =
    pr.role === planRun.ROLE_TOPIC
      ? await readFileImpl(path.join(pkg.root, planRun.topicDocPath(pr.runSlug, pr.topic)))
      : null;
  const check = planRun.planRunFinishCheck({ planRun: pr, status: status.stdout, committed, topicDoc });
  if (check.ok) return null;
  if (check.reason !== planRun.STALL_OUTSIDE) {
    return { ok: false, stage: 'planGuard', reason: check.reason, detail: check.detail };
  }
  // Uncommitted first (back to HEAD), then committed (back to the base).
  const loose = await runReverts(pkg, check.revert, execImpl);
  const old = await runReverts(pkg, check.revertCommitted, execImpl);
  const reverted = [...loose.done];
  const revertFailed = [...loose.failed, ...old.failed];
  if (old.done.length) {
    const folder = planRun.planFolder(pr.runSlug);
    const commit = await runGit(
      pkg.root,
      ['--literal-pathspecs', 'commit', '-q', '-m', `chore: luna revert changes outside ${folder}`, '--', ...old.done],
      execImpl,
    );
    (commit.ok ? reverted : revertFailed).push(...old.done);
  }
  const detail = [
    reverted.length ? `reverted outside ${planRun.planFolder(pr.runSlug)}: ${[...new Set(reverted)].join(', ')}` : '',
    revertFailed.length ? `could not revert: ${[...new Set(revertFailed)].join(', ')}` : '',
  ]
    .filter(Boolean)
    .join('; ')
    .slice(0, 600);
  return { ok: false, stage: 'planGuard', reason: check.reason, detail, reverted, revertFailed };
}

/** A verify that did not pass, as finishPackage's result. */
function verifyFailure(pkg, verified) {
  // The run was killed while this verify waited in the queue: never ran.
  if (verified.cancelled) return { ok: false, stage: 'verifyCancelled', detail: 'the run was stopped before this verify started' };
  // A timeout is no test failure: it never goes back to the worker as one.
  if (verified.timedOut) {
    const limit = Math.round(VERIFY_TIMEOUT_MS / 60000);
    return { ok: false, stage: 'verifyTimeout', detail: `\`${pkg.verify}\` ran past the ${limit} min limit${verified.reruns ? ' twice' : ''}` };
  }
  return { ok: false, stage: 'verify', output: verified.output };
}

/**
 * The finish sequence for one package.
 * @param {{id:string, root:string, cwd:string, branch:string, baseSha:string|null, verify:string,
 *          pushOnVerifyFail?:boolean, scanSecrets?:boolean, pushBlockedSha?:string|null}} pkg
 *   scanSecrets: scan the unpushed commits for secret shapes before verify;
 *   pushBlockedSha: the HEAD GitHub already rejected (GH013) - never pushed as-is again;
 *   verifiedSha: a HEAD that already passed verify (a retried push) - not verified again
 * @param {{execImpl?:Function, verifyImpl?:Function}} [deps]
 * @returns {Promise<
 *   {ok:true, headSha:string|null, files:string[]}
 *   | {ok:false, stage:'commit'|'noCommits'|'push'|'verifyTimeout', detail:string,
 *      blocked?:'secret'|'rule'|'unchanged', headSha?:string|null, range?:string}
 *   | {ok:false, stage:'planGuard', reason:'outsidePlanFolder'|'noSources'|'badPlanRun', detail:string,
 *      reverted?:string[], revertFailed?:string[]}
 *   | {ok:false, stage:'secrets', hits:Array<object>, range:string}
 *   | {ok:false, stage:'verify', output:string}>}
 */
async function finishPackage(pkg, deps = {}) {
  const execImpl = deps.execImpl;
  const verifyImpl = deps.verifyImpl || runVerify;
  // The worktree folder may be gone (deleted by hand, other PC after a
  // restore): say so instead of a git/verify ENOENT.
  const cwdOk = checkCwd(pkg.root, deps.isDirImpl);
  if (!cwdOk.ok) return { ok: false, stage: 'commit', detail: `worktree folder missing: ${cwdOk.detail}` };

  // Plan runs only (explicit pkg.planRun flag): before the leftovers commit
  // could sweep a change outside the plan folder into the branch.
  if (pkg.planRun != null) {
    if (!planRun.isPlanRunPackage(pkg)) {
      return { ok: false, stage: 'planGuard', reason: planRun.STALL_BAD_PLAN_RUN, detail: 'unreadable planRun flag' };
    }
    const guarded = await planRunGuard(pkg, execImpl, deps.readFileImpl);
    if (guarded) return guarded;
  }

  const status = await runGit(pkg.root, ['status', '--porcelain'], execImpl);
  if (!status.ok) return { ok: false, stage: 'commit', detail: firstLine(status.stderr) };
  if (status.stdout.trim()) {
    const add = await runGit(pkg.root, ['add', '-A'], execImpl);
    const commit = add.ok ? await runGit(pkg.root, ['commit', '-m', `chore: luna wip ${pkg.id}`], execImpl) : add;
    if (!commit.ok) return { ok: false, stage: 'commit', detail: firstLine(commit.stderr) };
  }

  if (pkg.baseSha) {
    const ahead = await runGit(pkg.root, ['rev-list', '--count', `${pkg.baseSha}..HEAD`, '--'], execImpl);
    if (ahead.ok && Number(firstLine(ahead.stdout)) === 0) {
      return { ok: false, stage: 'noCommits', detail: '' };
    }
  }

  // Before verify: no 14 min test run for a push that cannot succeed.
  const blocked = await prePushBlock(pkg, execImpl);
  if (blocked) return blocked;

  // Full ref name: a branch value can never be read as a push option.
  const pushBranch = () => runGit(pkg.root, ['push', '-u', 'origin', `refs/heads/${pkg.branch}`], execImpl);

  // A push retried by the recovery playbook (orchestraRecover.js): the very
  // HEAD that already passed verify is not verified again.
  const alreadyVerified = !!pkg.verifiedSha && (await headSha(pkg.root, execImpl)) === pkg.verifiedSha;
  if (pkg.verify && !alreadyVerified) {
    const verified = await verifyImpl(pkg.verify, pkg.cwd || pkg.root);
    if (!verified.ok) {
      const failed = verifyFailure(pkg, verified);
      // Free runs (orchestraFree.js) save the work on their own branch even
      // when verify fails; the worker is still asked to fix it.
      if (pkg.pushOnVerifyFail) {
        const saved = await pushBranch();
        return { ...failed, pushed: saved.ok };
      }
      return failed;
    }
  }

  const push = await pushBranch();
  if (!push.ok) {
    // Every remote: line (GitHub names rule, file and commit there), redacted.
    const detail = secrets.pushRejectionDetail(push.stderr);
    const kind = secrets.pushBlockKind(push.stderr);
    // headSha: the verified HEAD, so a retried push skips the verify.
    if (!kind) {
      const verified = pkg.verify ? await headSha(pkg.root, execImpl) : null;
      return { ok: false, stage: 'push', detail, ...(verified ? { headSha: verified } : {}) };
    }
    return { ok: false, stage: 'push', detail, blocked: kind, headSha: await headSha(pkg.root, execImpl), range: await unpushedRange(pkg, execImpl) };
  }

  return { ok: true, headSha: await headSha(pkg.root, execImpl), files: await changedFiles(pkg, execImpl) };
}

/** Repo-relative paths the branch changed since its base (overlap guard). */
async function changedFiles(pkg, execImpl) {
  if (!pkg.baseSha) return [];
  const res = await runGit(pkg.root, ['diff', '--name-only', `${pkg.baseSha}..HEAD`, '--'], execImpl);
  if (!res.ok) return [];
  return res.stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 300);
}

module.exports = { finishPackage, runVerify, headSha, scanUnpushed, unpushedRange, VERIFY_TIMEOUT_MS, KILL_GRACE_MS };
