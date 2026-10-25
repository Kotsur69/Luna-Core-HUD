// ============================================================================
// LunaCore - Luna's Work wiring (main process)
// ----------------------------------------------------------------------------
// Builds the real deps of the run controller (src/lunaswork.js) from what
// main.js already has, so main.js itself only hands its handles over:
//
//   run store       lunasworkStore (config/lunaswork.local.json)
//   settings        lunasworkSettings (models, freeFallback, project profile)
//   roles           runDirector / runPlaytest + createAdapter / runCritic
//   build           the God Mode builder (src/lunasworkBuild.js)
//   usage limits    orchestraPlanWait.planWaitDecision for the resume time
//   keep awake      an Electron powerSaveBlocker for the run's length
//   checkout sync   fetch + ff-only after each build (the merge went to origin)
//
// The project folder is always resolved here from the registered projects,
// and the profile from LunaCore's local settings - never from the renderer.
// ============================================================================

'use strict';

const { execFile } = require('child_process');
const lunasworkStore = require('./lunasworkStore');
const settingsStore = require('./lunasworkSettings');
const pack = require('./lunasworkPack');
const { runDirector } = require('./lunasworkDirector');
const { runCritic, gateStatus } = require('./lunasworkCritic');
const { runPlaytest } = require('./lunasworkPlaytest');
const { createAdapter } = require('./lunasworkAdapters');
const { planWaitDecision } = require('./orchestraPlanWait');
const { getProject } = require('./projects');
const { createLunasWork } = require('./lunaswork');

const GIT_LOG_COMMITS = 40;
const GIT_TIMEOUT_MS = 15000;

/** The last commits of the repo, one line each ('' on failure). */
function gitLog(repoPath) {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['log', '--oneline', '--no-decorate', '-n', String(GIT_LOG_COMMITS)],
      { cwd: repoPath, timeout: GIT_TIMEOUT_MS, windowsHide: true, maxBuffer: 1024 * 1024 },
      (err, stdout) => resolve(err ? '' : String(stdout || '')),
    );
  });
}

// A branch name as `git rev-parse --abbrev-ref HEAD` prints it; nothing else goes into a refspec.
const BRANCH_RE = /^[A-Za-z0-9._/-]{1,200}$/;

function git(cwd, args) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, timeout: GIT_TIMEOUT_MS, windowsHide: true, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) =>
      resolve({ ok: !err, out: String(stdout || '').trim(), err: String(stderr || '').trim().split('\n')[0] }),
    );
  });
}

/**
 * Fast-forwards the project checkout to what God Mode merged on origin.
 * Only a fast-forward: local work is never merged over or thrown away.
 * @returns {Promise<{ok:boolean, detail?:string}>}
 */
async function syncCheckout(repoPath) {
  const head = await git(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const branch = head.ok ? head.out : '';
  if (!BRANCH_RE.test(branch) || branch === 'HEAD' || branch.includes('..')) return { ok: false, detail: 'not on a branch' };
  const fetched = await git(repoPath, ['fetch', 'origin', `refs/heads/${branch}`]);
  if (!fetched.ok) return { ok: false, detail: `fetch failed: ${fetched.err}` };
  const merged = await git(repoPath, ['merge', '--ff-only', 'FETCH_HEAD']);
  return merged.ok ? { ok: true } : { ok: false, detail: `no fast-forward: ${merged.err}` };
}

/** Keeps the PC from suspending while a run is going (released at its end). */
function createAwake(powerSaveBlocker) {
  let id = null;
  return {
    hold: () => {
      if (id === null) id = powerSaveBlocker.start('prevent-app-suspension');
    },
    release: () => {
      if (id !== null && powerSaveBlocker.isStarted(id)) powerSaveBlocker.stop(id);
      id = null;
    },
  };
}

/**
 * @param {{
 *   projects: ()=>object[], resolveDir: (p:string)=>string|null,
 *   readTodos: (projectId:string)=>object[], writeTodos: (projectId:string, list:object[])=>boolean,
 *   onTodosChanged: (projectId:string)=>void,
 *   orchestra: {view:()=>object|null, planWait:()=>object|null},
 *   builder: {build:Function},
 *   godModeCheckCommand: ()=>string,
 *   env: ()=>object, freeEnv: ()=>object|null,
 *   usageLimits: ()=>object[],
 *   confirmStart: (ctx:{projectId:string, repoPath:string, profile:object, checkCommand:string})=>Promise<boolean>,
 *   powerSaveBlocker: {start:Function, stop:Function, isStarted:Function},
 *   onRunEnd?: Array<(run:object)=>void>, log?: (line:string)=>void,
 * }} ctx
 */
function createLunasWorkRuntime(ctx) {
  const projectOf = (projectId) => {
    const project = getProject(ctx.projects(), projectId);
    if (!project) return null;
    return { id: project.id, repoPath: typeof project.path === 'string' ? ctx.resolveDir(project.path) : null };
  };

  // Mutual exclusion, Luna's Work side: an unsettled God Mode plan (held or
  // running) or a planning wait on the same project.
  const godModeActive = ({ projectId }) => {
    const view = ctx.orchestra.view();
    const wait = ctx.orchestra.planWait();
    const planOpen = !!view && view.projectId === projectId && !view.settled && !view.killed;
    const waiting = !!wait && wait.projectId === projectId && wait.state !== 'failed';
    return planOpen || waiting;
  };

  const todoStore = (projectId) => ({
    read: () => ctx.readTodos(projectId),
    write: (list) => {
      const ok = ctx.writeTodos(projectId, list);
      if (ok) ctx.onTodosChanged(projectId);
      return ok;
    },
  });

  const limitResumeAt = (res) => {
    const decision = planWaitDecision({
      res: { ok: false, error: 'limit', detail: res && res.detail },
      limits: ctx.usageLimits(),
      now: Date.now(),
    });
    return decision.action === 'wait' ? decision.resumeAt : null;
  };

  return createLunasWork({
    store: { load: lunasworkStore.loadRun, save: lunasworkStore.saveRun },
    settings: () => settingsStore.readSettings(),
    projectOf,
    profileFor: (projectId) => settingsStore.profileFor(settingsStore.readSettings(), projectId),
    packStatus: (repoPath) => pack.packCompleteness(repoPath),
    godModeActive,
    godModeCheckCommand: ctx.godModeCheckCommand,
    confirmStart: ctx.confirmStart,
    todoStore,
    director: (opts) => runDirector({ ...opts, env: ctx.env() }),
    build: (opts) => ctx.builder.build(opts),
    createAdapter: (name, opts) => createAdapter(name, opts),
    // Free providers for the Playtester while Claude is limited (freeFallback).
    playtest: ({ free, ...opts }) => runPlaytest({ ...opts, env: (free && ctx.freeEnv()) || ctx.env() }),
    shipGate: ({ repoPath, scores }) => gateStatus({ shipCriteria: pack.readPackFile(repoPath, 'SHIP_CRITERIA.md') || '', scores }),
    critic: (opts) => runCritic({ ...opts, env: ctx.env() }),
    gitLog,
    syncCheckout,
    limitResumeAt,
    awake: createAwake(ctx.powerSaveBlocker),
    onRunEnd: ctx.onRunEnd || [],
    log: ctx.log,
  });
}

module.exports = { createLunasWorkRuntime, createAwake, syncCheckout };
