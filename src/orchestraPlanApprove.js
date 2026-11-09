// ============================================================================
// LunaCore - Free God Mode v2: "Approve plan" (slice F4a, decision D2)
// ----------------------------------------------------------------------------
// A finished plan run's PLAN.md lives on the synthesis package's luna-plan/
// branch (it carries every topic doc and CRITIQUE.md too: the synthesis
// worktree starts from the critique's head, which merged the topics).
// Approve, in order:
//
//   1. approveTarget(view)   the run is ready, has a PLAN.md doc on a safe
//                            luna-plan/ branch and a known base branch
//   2. the main checkout is ON the base branch (the merge lands there)
//   3. scope check           `git diff --name-only <base>...<branch>`: every
//                            path the branch adds must be inside
//                            docs/plans/<slug>/ - anything else refuses the
//                            approve before anything is merged
//   4. PLAN.md is read from the branch (`git show`)
//   5. `git merge --no-ff` into the base; a conflict is aborted and refused
//   6. every UNCHECKED task becomes a to-do (planTodoImport.js) - idempotent,
//      so a second Approve merges nothing new and adds no card
//
// Nothing is pushed: the base branch only moves locally, like a merge Mati
// makes by hand. Git runs without a shell; every argv value is a fixed word,
// a validated base branch, a luna-plan/<slug> branch or a fixed path.
// Every function resolves and never rejects.
// ============================================================================

'use strict';

const { execFile } = require('child_process');
const { runGit, firstLine, gitError } = require('./worktrees');
const { isBaseBranch } = require('./orchestraSupervisor');
const { isSafePlanBranch } = require('./orchestraPlanRunLaunch');
const { validateRunSlug, planPath, isInsidePlanFolder } = require('./orchestraPlanRun');
const { importPlanTodos } = require('./planTodoImport');

const PLAN_DOC_FILE = 'PLAN.md';
const MAX_PLAN_BYTES = 512 * 1024;
const MAX_OUTSIDE_LISTED = 20;
const MAX_DETAIL_CHARS = 400;
const SHA_RE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

const refuse = (error, extra = {}) => ({ ok: false, error, ...extra });
const cap = (s) => String(s || '').slice(0, MAX_DETAIL_CHARS);

/**
 * What an approve of this run would merge, or why it cannot.
 * @param {object|null} view the controller's view
 * @returns {{ok:true, runSlug:string, branch:string, base:string}
 *   | {ok:false, error:'notPlanRun'|'notReady'|'noPlanDoc'|'noBase'|'unsafeBranch'}}
 */
function approveTarget(view) {
  const pr = view && view.planRun;
  if (!pr || !validateRunSlug(pr.runSlug).ok) return refuse('notPlanRun');
  if (pr.ready !== true) return refuse('notReady');
  const doc = (Array.isArray(pr.docs) ? pr.docs : []).find((d) => d && d.file === PLAN_DOC_FILE);
  if (!doc || typeof doc.branch !== 'string') return refuse('noPlanDoc');
  const base = view.baseBranch;
  if (!isBaseBranch(base)) return refuse('noBase');
  if (!isSafePlanBranch(doc.branch, base)) return refuse('unsafeBranch');
  return { ok: true, runSlug: pr.runSlug, branch: doc.branch, base };
}

/**
 * Paths a branch changes since it left the base, outside the plan folder.
 * @param {string} nameZ `git diff --name-only -z` output
 * @param {string} runSlug
 * @returns {string[]}
 */
function outsidePaths(nameZ, runSlug) {
  return String(nameZ || '')
    .split('\0')
    .filter(Boolean)
    .filter((p) => !isInsidePlanFolder(p, runSlug));
}

/**
 * Steps 2-5: checks and merges.
 * @param {{repoPath:string, target:{runSlug:string, branch:string, base:string}}} args
 * @param {Function} [execImpl]
 * @returns {Promise<{ok:true, alreadyMerged:boolean, planText:string}
 *   | {ok:false, error:string, detail?:string, outside?:string[]}>}
 */
async function mergePlanBranch({ repoPath, target }, execImpl = execFile) {
  const { runSlug, branch, base } = target;
  const git = (args, opts) => runGit(repoPath, args, execImpl, opts);

  const head = await git(['rev-parse', '--abbrev-ref', 'HEAD']);
  if (!head.ok) return refuse('gitFailed', { detail: cap(head.broke || gitError(head.stderr)) });
  const current = firstLine(head.stdout);
  if (current !== base) return refuse('notOnBase', { detail: cap(current) });

  // A merge the user has in progress is theirs: never merge over or abort it.
  const pending = await git(['rev-parse', '--verify', '--quiet', 'MERGE_HEAD']);
  if (pending.ok) return refuse('mergeInProgress');

  // One commit for the scope check, the read and the merge (the branch could
  // move in between; a same-named tag never shadows it).
  const ref = await git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`]);
  const sha = ref.ok ? firstLine(ref.stdout) : '';
  if (!SHA_RE.test(sha)) return refuse('noBranch', { detail: branch });

  // Three dots: only what the branch changed since it left the base.
  const diff = await git(['diff', '--name-only', '-z', '--no-renames', `refs/heads/${base}...${sha}`, '--'], { maxBuffer: 4 * 1024 * 1024 });
  if (!diff.ok) return refuse('gitFailed', { detail: cap(diff.broke || gitError(diff.stderr)) });
  const outside = outsidePaths(diff.stdout, runSlug);
  if (outside.length) {
    const listed = outside.slice(0, MAX_OUTSIDE_LISTED);
    return refuse('outsidePlanFolder', { outside: listed, detail: cap(listed.join(', ')) });
  }
  const alreadyMerged = !diff.stdout.split('\0').some(Boolean);

  const show = await git(['show', `${sha}:${planPath(runSlug)}`], { maxBuffer: MAX_PLAN_BYTES });
  if (!show.ok) return refuse('noPlanDoc', { detail: cap(gitError(show.stderr)) });

  if (!alreadyMerged) {
    const merged = await git(['merge', '--no-ff', '--no-edit', '-m', `docs: approve plan ${runSlug}`, sha]);
    if (!merged.ok) {
      // Only OUR conflicted merge leaves MERGE_HEAD (none was there before):
      // abort it so the checkout is as it was. A refused merge (dirty files
      // in the way) left nothing to abort.
      const started = await git(['rev-parse', '--verify', '--quiet', 'MERGE_HEAD']);
      if (started.ok) await git(['merge', '--abort']);
      return refuse('mergeConflict', { detail: cap(merged.broke || gitError(merged.stderr) || firstLine(merged.stdout)) });
    }
  }
  return { ok: true, alreadyMerged, planText: show.stdout };
}

/**
 * The approve service main wires (one approve at a time per run).
 * @param {{readTodos:(projectId:string|null)=>object[], writeTodos:(projectId:string|null, list:object[])=>boolean,
 *   onTodosChanged?:(projectId:string|null)=>void, now?:()=>number, execImpl?:Function}} deps
 * @returns {(args:{projectId:string|null, repoPath:string, view:object}) => Promise<object>}
 */
function createPlanApprover(deps) {
  const now = deps.now || Date.now;
  const inFlight = new Set();
  return async function approvePlan({ projectId, repoPath, view }) {
    const target = approveTarget(view);
    if (!target.ok) return target;
    if (typeof repoPath !== 'string' || !repoPath) return refuse('noRepo');
    const key = `${repoPath}\0${target.runSlug}`;
    if (inFlight.has(key)) return refuse('busy');
    inFlight.add(key);
    try {
      const merged = await mergePlanBranch({ repoPath, target }, deps.execImpl || execFile);
      if (!merged.ok) return merged;
      const imported = importPlanTodos(deps.readTodos(projectId), merged.planText, { runSlug: target.runSlug, now: now() });
      if (!imported.ok) return refuse(imported.error);
      if (imported.created > 0) {
        if (!deps.writeTodos(projectId, imported.list)) return refuse('todoWriteFailed');
        if (deps.onTodosChanged) deps.onTodosChanged(projectId);
      }
      return {
        ok: true,
        runSlug: target.runSlug,
        branch: target.branch,
        base: target.base,
        alreadyMerged: merged.alreadyMerged,
        created: imported.created,
        skipped: imported.skipped,
        checked: imported.checked,
        full: imported.full,
      };
    } finally {
      inFlight.delete(key);
    }
  };
}

module.exports = { approveTarget, outsidePaths, mergePlanBranch, createPlanApprover };
