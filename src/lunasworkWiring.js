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
//   checkpoints     lunasworkCheckpoint: iteration tags, revert-only rollback
//   run report      lunasworkReport on onRunEnd: <runsDir>/lunaswork-<id>.md
//                   + .html, and one email under "Email me when a run finishes"
//   decisions       every decision-queue answer appended to design/DECISIONS.md
//   milestone email lunasworkReport onMilestone: scores, what waits, feedback (B17)
//   iteration 0     lunasworkScaffold: stack template cards for an empty repo
//   machine guard   createMachineRuntime: watchdog task, Windows Update pause,
//                   disk cleanup, low-disk stop + email (lunasworkMachine)
//   hand-back       lunasworkHandback (C11): main's commit at the pause, then
//                   Mati's commits since -> DECISIONS.md + ARCHITECTURE.md
//   loop hooks      lunasworkHookDeps: graph + codemaps refresh after a merge
//                   (LW 2.23), i18n card, Lighthouse, reviews, second opinion,
//                   project skills at a passed gate (LW 2.16)
//   docs at SHIP    lunasworkShipDocs (LW 2.22a): the docs iteration's cards,
//                   the CHANGELOG.md commit before it, the vX.Y.Z release
//   token meter     lunasworkUsage (LW 2.17a): every Director / Playtester /
//                   Critic / reviewer `claude -p` result's usage, and God
//                   Mode's planner cost per build, booked per role and phase
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
const { createCheckpoints } = require('./lunasworkCheckpoint');
const { createLunasWorkReporter } = require('./lunasworkReport');
const { godmodeEmailOn } = require('./mailprefs');
const { answersFromTodoPeers } = require('./lunasworkDecisions');
const { feedbackFromTodoPeers } = require('./lunasworkFeedback');
const { createScaffolder } = require('./lunasworkScaffold');
const { createMachineGuard } = require('./lunasworkMachine');
const { handbackHead, readCommits } = require('./lunasworkHandback');
const { wheelFromTodoPeers } = require('./lunasworkWheel');
const { createHookDeps } = require('./lunasworkHookDeps');
const { createShipDocsDeps } = require('./lunasworkShipDocs');
const { createUsageMeter } = require('./lunasworkUsage');
const { execClaude } = require('./lunasworkCritic');

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
 *   runsDir?: ()=>string, mail?: {sender:object, prefs:object},
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

  const reporter = ctx.runsDir
    ? createLunasWorkReporter({
      runsDir: ctx.runsDir,
      mail: ctx.mail ? { sender: ctx.mail.sender, prefs: ctx.mail.prefs, enabled: godmodeEmailOn } : undefined,
      log: ctx.log,
    })
    : null;

  // LW 2.17a: the run's token accounting; the controller drains it at every phase change.
  const meter = createUsageMeter();
  const build = async (opts) => {
    const res = await ctx.builder.build(opts);
    // God Mode's planner is the one `claude -p` of a build; its workers' tabs are not metered here.
    const plan = res && typeof res === 'object' ? res.plan : null;
    if (plan && Number.isFinite(plan.costUsd) && plan.costUsd > 0) meter.add('builder', { calls: 1, costUsd: plan.costUsd });
    return res;
  };

  return createLunasWork({
    store: { load: lunasworkStore.loadRun, save: lunasworkStore.saveRun },
    settings: () => settingsStore.readSettings(),
    projectOf,
    profileFor: (projectId) => settingsStore.profileFor(settingsStore.readSettings(), projectId),
    // Iteration 0 for an empty repo; its template's profile, once Mati
    // confirmed it with the start, is kept in LunaCore's local settings.
    scaffold: createScaffolder(),
    saveProfile: (projectId, profile) => {
      const { settings, reason } = settingsStore.withProject(settingsStore.readSettings(), projectId, { profile });
      return !reason && settingsStore.writeSettings(settings);
    },
    packStatus: (repoPath) => pack.packCompleteness(repoPath),
    godModeActive,
    godModeCheckCommand: ctx.godModeCheckCommand,
    confirmStart: ctx.confirmStart,
    todoStore,
    director: (opts) => runDirector({ ...opts, env: ctx.env(), runClaude: meter.runner('director', execClaude) }),
    build,
    createAdapter: (name, opts) => createAdapter(name, opts),
    // Free providers for the Playtester while Claude is limited (freeFallback).
    playtest: ({ free, ...opts }) => runPlaytest({
      ...opts,
      env: (free && ctx.freeEnv()) || ctx.env(),
      execImpl: meter.exec('playtester', execFile),
    }),
    shipGate: ({ repoPath, scores }) => gateStatus({ shipCriteria: pack.readPackFile(repoPath, 'SHIP_CRITERIA.md') || '', scores }),
    critic: (opts) => runCritic({ ...opts, env: ctx.env(), runClaude: meter.runner('critic', execClaude) }),
    gitLog,
    syncCheckout,
    checkpoints: createCheckpoints({ log: ctx.log }),
    limitResumeAt,
    awake: createAwake(ctx.powerSaveBlocker),
    // Every decision-queue answer, one line in the project's design/DECISIONS.md.
    recordDecision: ({ repoPath, line }) => {
      const op = pack.appendDecisionEntry(line);
      const res = op ? pack.applyWrite(repoPath, op) : { ok: false, error: 'empty entry' };
      if (!res.ok && ctx.log) ctx.log(`[lunaswork] DECISIONS.md not written: ${res.error}`);
      return res.ok;
    },
    // C11: what Mati committed by hand while he had the wheel.
    handback: {
      head: (repoPath) => handbackHead(repoPath),
      commits: (repoPath, base) => readCommits(repoPath, base),
      architecture: ({ repoPath, block }) => {
        const op = pack.appendArchitecture(block);
        const res = op ? pack.applyWrite(repoPath, op) : { ok: false, error: 'empty section' };
        if (!res.ok && ctx.log) ctx.log(`[lunaswork] ARCHITECTURE.md not written: ${res.error}`);
        return res.ok;
      },
    },
    // Loop hooks (src/lunasworkLoopHooks.js): none of them can stop the run.
    ...createHookDeps({ env: ctx.env, settings: () => settingsStore.readSettings(), log: ctx.log, meter: meter.runner }),
    // LW 2.22a: SHIP is final only after the docs iteration (README, user guide, release).
    shipDocs: createShipDocsDeps({ env: ctx.env }),
    usageMeter: meter,
    onRunEnd: [...(ctx.onRunEnd || []), ...(reporter ? [reporter.onRunEnd] : [])],
    // B12 / B17: a short email per passed milestone gate, with the feedback link.
    onMilestone: reporter ? [reporter.onMilestone] : [],
    log: ctx.log,
  });
}

/**
 * The machine guard (src/lunasworkMachine.js) over the real OS. Attach it
 * before controller.resume() and reconcile() after.
 * @param {{
 *   controller: object,
 *   launch: {command:string, args:string[]},
 *   runsRoot: ()=>string,
 *   godModeBusy: ()=>boolean,
 *   worktreeInUse: (root:string)=>boolean,
 *   mail?: {sender:{status:Function, send:Function}},
 *   log?: (line:string)=>void,
 * }} ctx
 */
function createMachineRuntime(ctx) {
  const user = process.env.USERDOMAIN && process.env.USERNAME ? `${process.env.USERDOMAIN}\\${process.env.USERNAME}` : null;
  return createMachineGuard({
    controller: ctx.controller,
    store: lunasworkStore.machineStore,
    launch: ctx.launch,
    user,
    runsRoot: ctx.runsRoot,
    godModeBusy: ctx.godModeBusy,
    worktreeInUse: ctx.worktreeInUse,
    // The low-disk alert goes out whatever the run-email setting says.
    email: ctx.mail
      ? async (msg) => {
        if (!ctx.mail.sender.status().connected) throw new Error('gmail not connected');
        return ctx.mail.sender.send(msg);
      }
      : undefined,
    log: ctx.log,
  });
}

/**
 * The decision queue's phone round trip:
 *   out  every controller event: the pending decisions go into the `godmode`
 *        snapshot (only when they changed; [] once the run ends)
 *   back after each `todos` pull: the answers the phone wrote there
 *        (lunasworkDecisions.answersFromTodoPeers) go to applyAnswers(),
 *        which accepts only pending ids of this run and listed options
 *
 * Mid-run feedback (B17) rides the same way when putFeedback is given:
 *   out  the run's feedback section (each item's status) into the snapshot
 *   back the phone / web form's `lunaswork-feedback:<id>` units go to
 *        applyFeedback() (lunasworkFeedback.feedbackFromTodoPeers)
 * So does the wheel (C11): its state rides in the feedback section, and the
 * phone's `lunaswork-wheel:<id>` units go to applyWheel() (newest one, once).
 * @param {{controller:{subscribe:Function, status:Function, applyAnswers:Function, applyFeedback?:Function, applyWheel?:Function},
 *   cloud:{onPulled:Function, hooks:Function}|null, putDecisions:(list:object[])=>unknown,
 *   putFeedback?:(section:object|null)=>unknown, log?:(line:string)=>void}} ctx
 * @returns {{publish:()=>void, pullAnswers:()=>number}}
 */
function wireDecisionSync({ controller, cloud, putDecisions, putFeedback, log = () => {} }) {
  /** Puts `value` through `put` only when it changed since the last put. */
  const changedPut = (what, put) => {
    let last = null;
    return (value) => {
      const key = JSON.stringify(value);
      if (key === last) return;
      last = key;
      try {
        Promise.resolve(put(value)).catch((err) => log(`[lunaswork] ${what} snapshot failed: ${err && err.message}`));
      } catch (err) {
        log(`[lunaswork] ${what} snapshot failed: ${err && err.message}`);
      }
    };
  };
  const putDecisionList = changedPut('decisions', putDecisions);
  const putFeedbackSection = typeof putFeedback === 'function' ? changedPut('feedback', putFeedback) : null;
  const publish = (status = controller.status()) => {
    putDecisionList(status && Array.isArray(status.pendingDecisions) ? status.pendingDecisions : []);
    if (putFeedbackSection) putFeedbackSection((status && status.feedback) || null);
  };
  const pullAnswers = () => {
    if (!cloud) return 0;
    try {
      const peers = cloud.hooks('todos').extraPeers();
      if (typeof controller.applyFeedback === 'function') controller.applyFeedback(feedbackFromTodoPeers(peers));
      if (typeof controller.applyWheel === 'function') {
        Promise.resolve(controller.applyWheel(wheelFromTodoPeers(peers))).catch((err) => log(`[lunaswork] wheel action failed: ${err && err.message}`));
      }
      return controller.applyAnswers(answersFromTodoPeers(peers));
    } catch (err) {
      log(`[lunaswork] decision answers not read: ${err && err.message}`);
      return 0;
    }
  };
  controller.subscribe((event) => publish(event && event.status));
  if (cloud) cloud.onPulled((scope) => scope === 'todos' && pullAnswers());
  return { publish, pullAnswers };
}

module.exports = { createLunasWorkRuntime, createMachineRuntime, createAwake, syncCheckout, wireDecisionSync };
