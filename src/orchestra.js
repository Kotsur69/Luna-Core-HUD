// ============================================================================
// LunaCore - God Mode v2 run controller (ORCHESTRATOR_PLAN.md, build slice 3)
// ----------------------------------------------------------------------------
// Slice 3 scope: plan -> review -> launch. One plan at a time lives here, in
// the main process: the renderer only ever sees a view of it and refers to it
// by id, so it can approve, edit a prompt or launch - never name a folder, a
// branch or a profile.
//
// Launching a package = a fresh worktree (src/worktrees.js) + a brief file +
// a normal tab whose `claude` starts with "read your brief" as its first
// message (launch.js withTaskBrief). Approve launches every package with no
// dependencies, up to MAX_PARALLEL; the rest wait on the board for a manual
// Launch - waiting for a package to FINISH is the supervisor's job (slice 4).
//
// Not here yet (slice 4): DONE markers, verify, push, ticking to-dos,
// persistence. A plan lives until it is discarded or LunaCore restarts.
// ============================================================================

'use strict';

const path = require('path');
const {
  validatePlan,
  estimatePlan,
  MAX_PARALLEL,
  MAX_PROMPT_CHARS,
  PLANNER_MODEL,
} = require('./orchestraPlan');

const BRIEF_DIR = 'tasks';

/**
 * The brief a worker reads first: LunaCore's own fixed contract around the
 * planner's prompt, so the rules do not depend on the planner remembering
 * them.
 * @param {{id:string, title:string, prompt:string, verify:string}} pkg
 * @param {string} branch
 * @returns {string}
 */
function briefText(pkg, branch) {
  return [
    `# LunaCore task: ${pkg.title}`,
    '',
    `Package \`${pkg.id}\` of a God Mode plan. You are in an isolated git worktree on branch \`${branch}\`.`,
    '',
    pkg.prompt,
    '',
    '## Verify',
    pkg.verify ? `Run \`${pkg.verify}\` and fix until it passes.` : 'Check your work with the project\'s tests before you finish.',
    '',
    '## Rules',
    '- Work only in this worktree. Do not push, merge or switch branches.',
    '- When the work is done and verified, commit it on this branch with a conventional commit message.',
    `- End your final message with the line \`LUNA_DONE ${pkg.id}\`, or \`LUNA_BLOCKED ${pkg.id}: <reason>\` if you cannot finish.`,
    '',
  ].join('\n');
}

/**
 * @param {{
 *   runPlanner: Function, addWorktree: Function, createSession: Function,
 *   readTodos: Function, dirtyCount: Function, writeBrief: Function,
 *   briefDir: () => string, now?: () => number,
 * }} deps
 */
function createOrchestra(deps) {
  const now = deps.now || Date.now;
  /** @type {null|object} */
  let plan = null;
  let busy = false;

  function view() {
    if (!plan) return null;
    return {
      id: plan.id,
      projectId: plan.projectId,
      notes: plan.notes,
      warnings: plan.warnings,
      errors: plan.errors,
      estimate: plan.estimate,
      costUsd: plan.costUsd,
      dirty: plan.dirty,
      model: PLANNER_MODEL,
      packages: plan.packages.map((p) => ({
        id: p.id,
        title: p.title,
        prompt: p.prompt,
        files: p.files,
        dependsOn: p.dependsOn,
        verify: p.verify,
        model: p.model,
        todos: p.todoAts.map((at) => plan.todoText.get(at) || String(at)),
        state: p.state,
        sessionId: p.sessionId,
        branch: p.branch,
        error: p.error,
      })),
    };
  }

  /**
   * Runs the planner for one project. Replaces any previous plan, except one
   * that already launched workers - that run is still on the board.
   * @param {{projectId:string|null, repoPath:string, profileId:string, env:object}} ctx
   */
  async function makePlan(ctx) {
    if (busy) return { ok: false, error: 'busy' };
    if (plan && plan.packages.some((p) => p.state === 'launched')) {
      return { ok: false, error: 'runActive' };
    }
    const openTodos = deps.readTodos(ctx.projectId).filter((t) => !t.done);
    if (!openTodos.length) return { ok: false, error: 'noTodos' };

    busy = true;
    try {
      const [res, dirty] = await Promise.all([
        deps.runPlanner({ cwd: ctx.repoPath, env: ctx.env, openTodos }),
        deps.dirtyCount(ctx.repoPath),
      ]);
      if (!res.ok) return res;
      const checked = validatePlan(res.raw, openTodos);
      plan = {
        id: `p${now().toString(36)}`,
        projectId: ctx.projectId,
        repoPath: ctx.repoPath,
        profileId: ctx.profileId,
        notes: checked.notes,
        warnings: checked.warnings,
        errors: checked.errors,
        estimate: estimatePlan(checked.packages, openTodos),
        costUsd: res.costUsd,
        dirty,
        todoText: new Map(openTodos.map((t) => [t.at, t.text])),
        packages: checked.packages.map((p) => ({ ...p, state: 'pending', sessionId: null, branch: null, error: null })),
      };
      return { ok: true, plan: view() };
    } finally {
      busy = false;
    }
  }

  /** Worktree + brief + tab for one package. Never throws. */
  async function launchOne(pkg, stamp) {
    const wt = await deps.addWorktree(plan.repoPath, `${pkg.id}-${stamp}`);
    if (!wt.ok) return { ...pkg, state: 'failed', error: wt.error };
    const briefPath = path.join(deps.briefDir(), `${path.basename(wt.root)}.md`);
    if (!deps.writeBrief(briefPath, briefText(pkg, wt.branch))) {
      return { ...pkg, state: 'failed', error: 'briefFailed', branch: wt.branch };
    }
    const session = deps.createSession({
      profileId: plan.profileId,
      projectId: plan.projectId,
      cwd: wt.cwd,
      branch: wt.branch,
      task: { briefPath, model: pkg.model },
    });
    if (!session) return { ...pkg, state: 'failed', error: 'noTab', branch: wt.branch };
    return { ...pkg, state: 'launched', sessionId: session.id, branch: wt.branch, error: null };
  }

  /**
   * Launches packages of the current plan. `ids` null = Approve: every
   * pending package without dependencies, up to MAX_PARALLEL. Prompt edits
   * from the review overlay apply before launch.
   * @param {unknown} payload {planId, ids?: string[]|null, prompts?: {[id]: string}}
   */
  async function launch(payload) {
    const o = payload && typeof payload === 'object' ? payload : {};
    if (!plan || o.planId !== plan.id) return { ok: false, error: 'noPlan' };
    if (plan.errors.length) return { ok: false, error: 'planErrors' };
    if (busy) return { ok: false, error: 'busy' };

    const edits = o.prompts && typeof o.prompts === 'object' ? o.prompts : {};
    plan.packages = plan.packages.map((p) => {
      const edited = typeof edits[p.id] === 'string' ? edits[p.id].trim().slice(0, MAX_PROMPT_CHARS) : '';
      return p.state === 'pending' && edited ? { ...p, prompt: edited } : p;
    });

    const pending = plan.packages.filter((p) => p.state === 'pending' || p.state === 'failed');
    const chosen = Array.isArray(o.ids)
      ? pending.filter((p) => o.ids.includes(p.id))
      : pending.filter((p) => !p.dependsOn.length).slice(0, MAX_PARALLEL);
    if (!chosen.length) return { ok: false, error: 'nothingToLaunch' };

    busy = true;
    try {
      const stamp = now().toString(36).slice(-5);
      for (const pkg of chosen) {
        const done = await launchOne(pkg, stamp);
        plan.packages = plan.packages.map((p) => (p.id === pkg.id ? done : p));
      }
      return { ok: true, plan: view() };
    } finally {
      busy = false;
    }
  }

  /** A closed tab leaves its worktree; the board says so. */
  function onSessionClosed(sessionId) {
    if (!plan) return false;
    const hit = plan.packages.some((p) => p.sessionId === sessionId && p.state === 'launched');
    if (hit) {
      plan.packages = plan.packages.map((p) => (p.sessionId === sessionId ? { ...p, state: 'closed' } : p));
    }
    return hit;
  }

  function discard() {
    if (busy) return false;
    plan = null;
    return true;
  }

  return { makePlan, launch, view, discard, onSessionClosed, isBusy: () => busy };
}

module.exports = { createOrchestra, briefText, BRIEF_DIR };
