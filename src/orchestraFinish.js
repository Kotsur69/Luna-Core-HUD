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

const { exec } = require('child_process');
const { runGit, firstLine } = require('./worktrees');

const VERIFY_TIMEOUT_MS = 15 * 60 * 1000;
const VERIFY_MAX_BUFFER = 4 * 1024 * 1024;

/**
 * Runs a verify command in `cwd`. Output is stdout + stderr, for pasting the
 * failure back to the worker.
 * @returns {Promise<{ok:boolean, output:string}>}
 */
function runVerify(command, cwd, execImpl = exec) {
  return new Promise((resolve) => {
    execImpl(
      command,
      { cwd, windowsHide: true, timeout: VERIFY_TIMEOUT_MS, maxBuffer: VERIFY_MAX_BUFFER },
      (err, stdout, stderr) => {
        const output = `${String(stdout || '')}\n${String(stderr || '')}`.trim();
        const timedOut = err && err.killed;
        resolve({ ok: !err, output: timedOut ? `${output}\n[LunaCore: verify timed out]` : output });
      },
    );
  });
}

/** HEAD of a worktree, or null. */
async function headSha(root, execImpl) {
  const res = await runGit(root, ['rev-parse', 'HEAD'], execImpl);
  return res.ok ? firstLine(res.stdout) || null : null;
}

/**
 * The finish sequence for one package.
 * @param {{id:string, root:string, cwd:string, branch:string, baseSha:string|null, verify:string}} pkg
 * @param {{execImpl?:Function, verifyImpl?:Function}} [deps]
 * @returns {Promise<
 *   {ok:true, headSha:string|null, files:string[]}
 *   | {ok:false, stage:'commit'|'noCommits'|'push', detail:string}
 *   | {ok:false, stage:'verify', output:string}>}
 */
async function finishPackage(pkg, deps = {}) {
  const execImpl = deps.execImpl;
  const verifyImpl = deps.verifyImpl || runVerify;

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

  if (pkg.verify) {
    const verified = await verifyImpl(pkg.verify, pkg.cwd || pkg.root);
    if (!verified.ok) return { ok: false, stage: 'verify', output: verified.output };
  }

  // Full ref name: a branch value can never be read as a push option.
  const push = await runGit(pkg.root, ['push', '-u', 'origin', `refs/heads/${pkg.branch}`], execImpl);
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

module.exports = { finishPackage, runVerify, headSha, VERIFY_TIMEOUT_MS };
