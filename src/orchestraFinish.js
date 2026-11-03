// ============================================================================
// LunaCore - God Mode v2 per-worker finish (ORCHESTRATOR_PLAN.md slice 4, §4)
// ----------------------------------------------------------------------------
// Deterministic, run by LunaCore rather than trusted to the worker, after a
// worker prints LUNA_DONE:
//
//   1. leftovers  - uncommitted changes in the worktree are committed as
//                   `chore: luna wip <pkg>` so nothing is lost
//   2. commits?   - a branch with no commit past its base did no work
//   3. verify     - the package's verify command, in the worktree, by us
//   4. push       - `git push -u origin <branch>`; never main, never --force
//
// The verify command comes from the planner (model output) and runs through
// a shell, the same trust level the worker already has in that worktree - it
// runs the very same command itself under the brief. It is bounded by a
// timeout and only ever runs in the package's own worktree.
//
// Every function resolves a typed result and never rejects.
// ============================================================================

'use strict';

const { exec, execFile } = require('child_process');
const { runGit, firstLine } = require('./worktrees');
const { checkCwd } = require('./projects');

const VERIFY_TIMEOUT_MS = 15 * 60 * 1000;
const VERIFY_MAX_BUFFER = 4 * 1024 * 1024;
const TIMED_OUT_NOTE = '[LunaCore: verify timed out]';

/**
 * Stops a verify that ran past its cap together with everything it started.
 * exec's own `timeout` kills only the shell: on Windows the npm and
 * `node --test` processes under it kept running for hours, and the CPU they
 * held timed out the next package's verify too. taskkill /T takes the whole
 * tree; child.kill() afterwards is the fallback, and the only step elsewhere.
 * @param {{pid?:number, kill:Function}} child
 * @param {{platform?:string, execFileImpl?:Function}} [io]
 */
function killTree(child, io = {}) {
  const fallback = () => {
    try {
      child.kill();
    } catch {
      /* already gone */
    }
  };
  const platform = io.platform || process.platform;
  if (platform !== 'win32' || !child || !Number.isInteger(child.pid)) return fallback();
  (io.execFileImpl || execFile)('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, fallback);
}

/**
 * Runs a verify command in `cwd`. Output is stdout + stderr, for pasting the
 * failure back to the worker. Past VERIFY_TIMEOUT_MS the whole process tree
 * is stopped (killTree) and the output ends with TIMED_OUT_NOTE.
 * @param {string} command
 * @param {string} cwd
 * @param {Function} [execImpl]
 * @param {{capMs?:number, setTimer?:Function, clearTimer?:Function, killTree?:Function}} [io] test seams
 * @returns {Promise<{ok:boolean, output:string}>}
 */
function runVerify(command, cwd, execImpl = exec, io = {}) {
  const setTimer = io.setTimer || setTimeout;
  const clearTimer = io.clearTimer || clearTimeout;
  const stop = io.killTree || killTree;
  return new Promise((resolve) => {
    let capped = false;
    let settled = false;
    let timer = null;
    // No exec `timeout`: it would kill the shell first, and the tree under it
    // can no longer be found from there.
    const child = execImpl(command, { cwd, windowsHide: true, maxBuffer: VERIFY_MAX_BUFFER }, (err, stdout, stderr) => {
      settled = true;
      if (timer) clearTimer(timer);
      const output = `${String(stdout || '')}\n${String(stderr || '')}`.trim();
      // err.killed: exec stopped it itself (its output went over maxBuffer).
      const timedOut = capped || Boolean(err && err.killed);
      resolve({ ok: !err && !capped, output: timedOut ? `${output}\n${TIMED_OUT_NOTE}` : output });
    });
    if (settled) return;
    timer = setTimer(() => {
      capped = true;
      stop(child);
    }, io.capMs || VERIFY_TIMEOUT_MS);
    // The verify's own process keeps a real run alive; the timer must not.
    if (timer && typeof timer.unref === 'function') timer.unref();
  });
}

/** HEAD of a worktree, or null. */
async function headSha(root, execImpl) {
  const res = await runGit(root, ['rev-parse', 'HEAD'], execImpl);
  return res.ok ? firstLine(res.stdout) || null : null;
}

/**
 * The finish sequence for one package.
 * @param {{id:string, root:string, cwd:string, branch:string, baseSha:string|null, verify:string,
 *          pushOnVerifyFail?:boolean}} pkg
 * @param {{execImpl?:Function, verifyImpl?:Function}} [deps]
 * @returns {Promise<
 *   {ok:true, headSha:string|null, files:string[]}
 *   | {ok:false, stage:'commit'|'noCommits'|'push', detail:string}
 *   | {ok:false, stage:'verify', output:string}>}
 */
async function finishPackage(pkg, deps = {}) {
  const execImpl = deps.execImpl;
  const verifyImpl = deps.verifyImpl || runVerify;
  // The worktree folder may be gone (deleted by hand, other PC after a
  // restore): say so instead of a git/verify ENOENT.
  const cwdOk = checkCwd(pkg.root, deps.isDirImpl);
  if (!cwdOk.ok) return { ok: false, stage: 'commit', detail: `worktree folder missing: ${cwdOk.detail}` };

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

  // Full ref name: a branch value can never be read as a push option.
  const pushBranch = () => runGit(pkg.root, ['push', '-u', 'origin', `refs/heads/${pkg.branch}`], execImpl);

  if (pkg.verify) {
    const verified = await verifyImpl(pkg.verify, pkg.cwd || pkg.root);
    if (!verified.ok) {
      // Free runs (orchestraFree.js) save the work on their own branch even
      // when verify fails; the worker is still asked to fix it.
      if (pkg.pushOnVerifyFail) {
        const saved = await pushBranch();
        return { ok: false, stage: 'verify', output: verified.output, pushed: saved.ok };
      }
      return { ok: false, stage: 'verify', output: verified.output };
    }
  }

  const push = await pushBranch();
  if (!push.ok) return { ok: false, stage: 'push', detail: firstLine(push.stderr) };

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

module.exports = { finishPackage, runVerify, killTree, headSha, VERIFY_TIMEOUT_MS };
