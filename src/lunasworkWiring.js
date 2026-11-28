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
//   run-end cleanup lunasworkRunCleanup before the report: the run's worktrees
//                   and merged luna/ branches go, kept ones are in the report
//   decisions       every decision-queue answer appended to design/DECISIONS.md
//   milestone email lunasworkReport onMilestone: scores, what waits, feedback (B17)
//   launch assets   lunasworkLaunch at SHIP: the marketing agent -> marketing/ (C10)
//   demo video      lunasworkDemo per milestone gate + at SHIP, Remotion render (B13)
//   iteration 0     lunasworkScaffold: stack template cards for an empty repo
//   machine guard   createMachineRuntime: watchdog task, Windows Update pause,
//                   disk cleanup, low-disk stop + email (lunasworkMachine)
//   hand-back       lunasworkHandback (C11): main's commit at the pause, then
//                   Mati's commits since -> DECISIONS.md + ARCHITECTURE.md
//   loop hooks     lunasworkHookDeps: graph + codemaps refresh after a merge
//                   (LW 2.23), i18n card, Lighthouse, reviews, second opinion,
//                   project skills at a passed gate (LW 2.16)
//   toggles         LW 2.25a: the Critic's variant pick at the deadline
//                   (lunasworkVariants.runCriticPick); LW 2.25b: Mati's
//                   prototype comments appended to DESIGN.md
//   docs at SHIP    lunasworkShipDocs (LW 2.22a): the docs iteration's cards,
//                   the CHANGELOG.md commit before it, the vX.Y.Z release
//   token meter     lunasworkUsage (LW 2.17a): every Director / Playtester /
//                   Critic / reviewer `claude -p` result's usage, and God
//                   Mode's planner cost per build, booked per role and phase
//   time to SHIP    lunasworkEta (LW 2.22b): the estimate from the run's pace,
//                   its open cards and ROADMAP.md - controller.shipEstimate()
//                   for the HUD dashboard, a line in the milestone email
//   phone snapshot  lunasworksnapshot (LW 2.17b): controller.phoneSnapshot()
//                   with the newest screenshots as small JPEG thumbnails;
//                   wireDecisionSync puts it throttled on every phase change
//   playtest pass   runtime.playtestOnce: one Playtester call outside a run
//                   ("Run Playtester pass", src/lunasworkPlaytestOnce.js),
//                   on Claude, metered on its own meter into result.usage
//   ask luna        lunasworkAsk (LW 2.27): wireDecisionSync hands the phone's
//                   questions to the ask service; main.js creates it
//   project queue   lunasworkQueue (B16): config/lunaswork-queue.local.json;
//                   the run email gets its QUEUE block (advancing / paused)
//   client widget   lunasworkWidget (LW 3.28b): ctx.widget into the staging
//                   deploy step and the run-end revoke
//   email replies   lunasworkMailReplies (B17, opt-in): the reporter records
//                   each sent email's thread, the controller's events start /
//                   stop the poll, replies come back through feedback()
//
// The project folder is always resolved here from the registered projects,
// and the profile from LunaCore's local settings - never from the renderer.
// ============================================================================

'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const lunasworkStore = require('./lunasworkStore');
const settingsStore = require('./lunasworkSettings');
const pack = require('./lunasworkPack');
const { runDirector } = require('./lunasworkDirector');
const { runCritic, gateStatus } = require('./lunasworkCritic');
const { runResearch } = require('./lunasworkResearch');
const { runStyleCheck } = require('./lunasworkAssets');
const { runCasting } = require('./lunasworkAssetCasting');
const { runPlaytest } = require('./lunasworkPlaytest');
const { createAdapter } = require('./lunasworkAdapters');
const { planWaitDecision } = require('./orchestraPlanWait');
const { getProject } = require('./projects');
const { createLunasWork } = require('./lunaswork');
const { createCheckpoints } = require('./lunasworkCheckpoint');
const { commitDesignPack } = require('./lunasworkPackCommit');
const { createLunasWorkReporter } = require('./lunasworkReport');
const { createRunCleanup } = require('./lunasworkRunCleanup');
const { godmodeEmailOn } = require('./mailprefs');
const { answersFromTodoPeers } = require('./lunasworkDecisions');
const { feedbackFromTodoPeers } = require('./lunasworkFeedback');
const { createScaffolder } = require('./lunasworkScaffold');
const { createMachineGuard } = require('./lunasworkMachine');
const { handbackHead, readCommits } = require('./lunasworkHandback');
const { wheelFromTodoPeers } = require('./lunasworkWheel');
const { createHookDeps } = require('./lunasworkHookDeps');
const { createShipDocsDeps } = require('./lunasworkShipDocs');
const { createUsageMeter, addUsage, emptyUsage, godModeUsage } = require('./lunasworkUsage');
const { execClaude } = require('./lunasworkCritic');
const { argsUseAgy } = require('./agyexec');
const { runCriticPick } = require('./lunasworkVariants');
const { shipEstimate, etaLine } = require('./lunasworkEta');
const { buildSnapshot, createSnapshotThrottle, MAX_SHOTS } = require('./lunasworksnapshot');
const { keyScreens } = require('./lunasworkRun');
const { createAskService } = require('./lunasworkAsk');
const { runLaunchAssets } = require('./lunasworkLaunch');
const { createDemoMaker } = require('./lunasworkDemo');
const { fileQueueStore, queueEmailNote } = require('./lunasworkQueue');
const { createSecretStore } = require('./lunasworkErrorTracking');
const { reserveHold } = require('./lunasworkReserveGate');
const { toolDownNotice } = require('./lunasworkToolGuard');

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
 * `aroundChange` wraps the fast-forward itself, and only when it will move
 * HEAD (the Unity editor is parked around it, src/lunasworkEditorPark.js):
 * nothing new on origin, or a diverged checkout, never reaches it.
 * @param {string} repoPath
 * @param {{aroundChange?:(step:()=>Promise<object>)=>Promise<object>}} [opts]
 * @returns {Promise<{ok:boolean, detail?:string}>}
 */
async function syncCheckout(repoPath, opts = {}) {
  const head = await git(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const branch = head.ok ? head.out : '';
  if (!BRANCH_RE.test(branch) || branch === 'HEAD' || branch.includes('..')) return { ok: false, detail: 'not on a branch' };
  const fetched = await git(repoPath, ['fetch', 'origin', `refs/heads/${branch}`]);
  if (!fetched.ok) return { ok: false, detail: `fetch failed: ${fetched.err}` };
  // Already up to date: FETCH_HEAD is HEAD or one of its ancestors.
  if ((await git(repoPath, ['merge-base', '--is-ancestor', 'FETCH_HEAD', 'HEAD'])).ok) return { ok: true };
  if (!(await git(repoPath, ['merge-base', '--is-ancestor', 'HEAD', 'FETCH_HEAD'])).ok) {
    return { ok: false, detail: 'no fast-forward: the checkout has commits origin does not have' };
  }
  const inTheWay = await untrackedInTheWay(repoPath);
  if (!inTheWay.ok) return { ok: false, detail: `no fast-forward: ${inTheWay.err}` };
  const notMeta = inTheWay.paths.filter((p) => !isUnityMeta(p));
  if (notMeta.length) {
    return { ok: false, detail: `no fast-forward: untracked files in the way: ${notMeta.slice(0, MAX_LISTED_PATHS).join(', ')}` };
  }
  const around = typeof opts.aroundChange === 'function' ? opts.aroundChange : (step) => step();
  let displaced = [];
  const merged = await around(async () => {
    // Inside the wrap: the parked editor cannot regenerate the .meta between the move and the merge.
    const moved = await displaceFiles(repoPath, inTheWay.paths);
    if (!moved.ok) return moved;
    displaced = moved.paths;
    return git(repoPath, ['merge', '--ff-only', 'FETCH_HEAD']);
  });
  if (!merged.ok) return { ok: false, detail: `no fast-forward: ${merged.err}` };
  return displaced.length ? { ok: true, displaced } : { ok: true };
}

// How many blocking paths a refusal names (the run log line is capped anyway).
const MAX_LISTED_PATHS = 5;

/**
 * A Unity .meta file. A live editor writes one for every asset that lacks it,
 * so a builder that commits a script without its .meta leaves the editor's
 * checkout with an untracked .meta that the merge then adds: it blocks every
 * later fast-forward. Its local GUID is the editor's own guess; the committed
 * one wins.
 */
const isUnityMeta = (rel) => rel.endsWith('.meta');

/**
 * Untracked, not ignored files in the checkout that FETCH_HEAD adds, the ones
 * `git merge --ff-only` refuses to overwrite.
 * @returns {Promise<{ok:true, paths:string[]}|{ok:false, err:string}>}
 */
async function untrackedInTheWay(repoPath) {
  const added = await git(repoPath, ['diff', '--name-only', '-z', '--no-renames', '--diff-filter=A', 'HEAD', 'FETCH_HEAD']);
  if (!added.ok) return { ok: false, err: `diff failed: ${added.err}` };
  const addedSet = new Set(added.out.split('\0').filter(Boolean));
  if (!addedSet.size) return { ok: true, paths: [] };
  const untracked = await git(repoPath, ['ls-files', '-z', '--others', '--exclude-standard']);
  if (!untracked.ok) return { ok: false, err: `ls-files failed: ${untracked.err}` };
  return { ok: true, paths: untracked.out.split('\0').filter((p) => addedSet.has(p)) };
}

/**
 * Moves repo-relative files into <git dir>/lunacore-displaced/<stamp>/, so the
 * local copies are kept (never tracked, never deleted) and the merge can write.
 * @returns {Promise<{ok:true, paths:string[]}|{ok:false, err:string}>}
 */
async function displaceFiles(repoPath, paths) {
  if (!paths.length) return { ok: true, paths: [] };
  const gitDir = await git(repoPath, ['rev-parse', '--absolute-git-dir']);
  if (!gitDir.ok || !gitDir.out) return { ok: false, err: `git dir not found: ${gitDir.err}` };
  const target = path.join(gitDir.out, 'lunacore-displaced', String(Date.now()));
  const root = path.resolve(repoPath);
  const moved = [];
  for (const rel of paths) {
    const from = path.resolve(root, rel);
    // Paths come from git, but never move anything outside the checkout.
    if (!from.startsWith(root + path.sep)) return { ok: false, err: `refused path outside the checkout: ${rel}` };
    try {
      const to = path.join(target, rel);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.renameSync(from, to);
      moved.push(rel);
    } catch (err) {
      return { ok: false, err: `could not move ${rel} aside: ${err.message}` };
    }
  }
  return { ok: true, paths: moved };
}

/**
 * One call booked on a fresh meter of its own; the answer gets its tokens as
 * `usage` (lunasworkUsage's Usage shape, all zero when nothing was recorded),
 * replacing any `usage` the answer had - the meter is the one source.
 * @param {(meter:{exec:Function, runner:Function})=>Promise<unknown>} call
 */
async function meteredPass(call) {
  const own = createUsageMeter();
  const res = await call(own);
  const usage = own.drain().reduce((sum, entry) => addUsage(sum, entry.usage), emptyUsage());
  return res && typeof res === 'object' && !Array.isArray(res) ? { ...res, usage } : res;
}

const THUMB_WIDTH = 240;
const THUMB_QUALITY = 60;
const MAX_THUMB_CHARS = 24 * 1024;

/**
 * A screenshot as a small JPEG data URL, or null. Electron's nativeImage
 * (main process only); under plain Node (tests) there is none and the
 * snapshot simply goes without thumbnails.
 */
function thumbnail(file) {
  try {
    const { nativeImage } = require('electron');
    if (!nativeImage || typeof file !== 'string') return null;
    const img = nativeImage.createFromPath(file);
    if (img.isEmpty()) return null;
    const url = `data:image/jpeg;base64,${img.resize({ width: THUMB_WIDTH }).toJPEG(THUMB_QUALITY).toString('base64')}`;
    return url.length <= MAX_THUMB_CHARS ? url : null;
  } catch {
    return null;
  }
}

/** The run's newest key-screen screenshots as thumbnails, newest first. */
function thumbnailsOf(run, makeThumb = thumbnail) {
  return keyScreens(run && run.laps)
    .sort((a, b) => b.n - a.n)
    .slice(0, MAX_SHOTS)
    .map((s) => ({ name: s.name, n: s.n, src: makeThumb(s.screenshot) }))
    .filter((s) => s.src);
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
 * The reporter's mail with the run's QUEUE block (B16) put on top of the text.
 * @param {{sender:{status:Function, send:Function}}|undefined} mail
 * @param {string} note queueEmailNote output ('' = unchanged)
 */
function mailWithNote(mail, note) {
  if (!mail || !note) return mail;
  const { sender } = mail;
  return {
    ...mail,
    sender: {
      status: () => sender.status(),
      send: (msg) => sender.send({ ...msg, text: `${note}

${msg.text}` }),
    },
  };
}

/**
 * execClaude for every role call: a `--model agy` call (the role set to agy,
 * or the agy fallback) gets the agy profile's env and runs on agy
 * (src/agyexec.js); every other call is the plain `claude -p`, unless the
 * Claude account its env runs on is held by its reserve - then nothing is
 * spawned and the call answers {error:'limit', detail, resumeAt}.
 * @param {{exec?:Function, agyEnv?:()=>object|null, reserveUntil?:(accountId:string)=>number|null,
 *   now?:()=>number, log?:(line:string)=>void}} [deps]
 * @returns {(call:object)=>Promise<object>}
 */
function createHeadlessRunner({ exec = execClaude, agyEnv = () => null, reserveUntil, now = Date.now, log } = {}) {
  return (call) => {
    if (argsUseAgy(call && call.args)) return exec({ ...call, agyEnv: agyEnv() });
    const held = reserveHold(call && call.env, reserveUntil, { now: now(), log });
    return held ? Promise.resolve(held) : exec(call);
  };
}

/**
 * The Playtester call booked on a meter `m`; free providers only when asked
 * for (freeFallback). Its Claude call carries the same reserve gate as
 * runHeadless (runPlaytest checks it right before spawning; agy is not gated).
 * @param {{env:()=>object, freeEnv:()=>object|null, agyEnv:()=>object|null,
 *   reserveUntil?:(accountId:string)=>number|null, now?:()=>number, log?:(line:string)=>void,
 *   run?:Function}} deps run: runPlaytest (tests inject a fake)
 */
function createPlaytestOn({ env, freeEnv, agyEnv, reserveUntil, now = Date.now, log, run = runPlaytest }) {
  const gate = (callEnv) => reserveHold(callEnv, reserveUntil, { now: now(), log });
  return (m) => ({ free, ...opts }) => run({
    ...opts,
    env: (free && freeEnv()) || env(),
    // A Playtester set to agy runs in the agy profile's env.
    agyEnv: agyEnv(),
    gate,
    execImpl: m.exec('playtester', execFile),
  });
}

/**
 * @param {{
 *   projects: ()=>object[], resolveDir: (p:string)=>string|null,
 *   readTodos: (projectId:string)=>object[], writeTodos: (projectId:string, list:object[])=>boolean,
 *   onTodosChanged: (projectId:string)=>void,
 *   orchestra: {view:(projectId:string)=>object|null, planWait:(projectId:string)=>object|null},
 *   builder: {build:Function},
 *   godModeCheckCommand: ()=>string,
 *   env: ()=>object, freeEnv: ()=>object|null,
 *   agyEnv?: ()=>object|null (the agy profile's env: roles set to agy, the agy fallback),
 *   usageLimits: ()=>object[],
 *   accountFailover?: (resetsAt:number|null)=>boolean,
 *   reserveUntil?: (accountId:string)=>number|null (the reserve reset of a held account, else null),
 *   confirmStart: (ctx:{projectId:string, repoPath:string, profile:object, checkCommand:string})=>Promise<boolean>,
 *   powerSaveBlocker: {start:Function, stop:Function, isStarted:Function},
 *   onRunEnd?: Array<(run:object)=>void>, log?: (line:string)=>void,
 *   worktreeInUse?: (root:string)=>boolean (a tab is open in that folder: the run-end cleanup keeps it;
 *     without it no worktree is removed),
 *   notify?: (title:string, body:string)=>void (a desktop notification: a kit tool is down),
 *   runsDir?: ()=>string, mail?: {sender:object, prefs:object}, secretStore?: object,
 *   queue?: {read:()=>object, write:(q:object)=>boolean},
 *   widget?: {prepare:Function, revoke:Function} (lunasworkWidget.createWidget),
 *   mailReplies?: {record:Function, sync:Function, attach:Function} (lunasworkMailReplies.createMailReplies),
 * }} ctx
 */
function createLunasWorkRuntime(ctx) {
  const projectOf = (projectId) => {
    const project = getProject(ctx.projects(), projectId);
    if (!project) return null;
    return { id: project.id, repoPath: typeof project.path === 'string' ? ctx.resolveDir(project.path) : null };
  };

  // Mutual exclusion, Luna's Work side: an unsettled God Mode plan (held or
  // running) or a planning wait on the same project. God Mode keeps one run
  // per project (orchestraRegistry.js), so what comes back is that project's
  // own run - also a run filed under it from an older build's single file.
  const godModeActive = ({ projectId }) => {
    const view = ctx.orchestra.view(projectId);
    const wait = ctx.orchestra.planWait(projectId);
    const planOpen = !!view && !view.settled && !view.killed;
    const waiting = !!wait && wait.state !== 'failed';
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

  const reporterMail = ctx.mail ? { sender: ctx.mail.sender, prefs: ctx.mail.prefs, enabled: godmodeEmailOn } : undefined;
  const reporterOpts = ctx.runsDir
    ? {
      runsDir: ctx.runsDir,
      // C10: launch assets at SHIP; B13: a walkthrough video per milestone gate.
      // The marketing agent's claude -p is gated on the account reserve too.
      launch: (run) => runLaunchAssets({ run, env: ctx.env(), runClaude: runHeadless }),
      demo: createDemoMaker({ runsDir: ctx.runsDir, log: ctx.log }),
      ...(ctx.mailReplies ? { threads: ctx.mailReplies } : {}),
      log: ctx.log,
    }
    : null;
  const reporter = reporterOpts ? createLunasWorkReporter({ ...reporterOpts, mail: reporterMail }) : null;
  // B16: a run that ends with something queued gets its own reporter, whose
  // mail carries the QUEUE block; the files and the dedupe mark are the same.
  const onRunEndReport = (run) => {
    const note = queueEmailNote(run && run.queue);
    if (!note) return reporter.onRunEnd(run);
    return createLunasWorkReporter({ ...reporterOpts, mail: mailWithNote(reporterMail, note) }).onRunEnd(run);
  };
  // Run-end git hygiene (src/lunasworkRunCleanup.js) goes first: the report then lists the kept branches.
  const runCleanup = createRunCleanup({
    inUse: ctx.worktreeInUse,
    busy: (run) => typeof run.projectId === 'string' && godModeActive({ projectId: run.projectId }),
    log: ctx.log,
  });
  const onRunEndGit = async (run) => {
    const gitCleanup = await runCleanup.atRunEnd(run);
    return reporter ? onRunEndReport({ ...run, gitCleanup }) : null;
  };

  // LW 2.17a: the run's token accounting; the controller drains it at every phase change.
  const meter = createUsageMeter();

  /** The agy profile's env (src/agyprofile.js), or null when there is none. */
  const agyEnvNow = () => (typeof ctx.agyEnv === 'function' ? ctx.agyEnv() || null : null);
  // Every role call, gated on the account reserve (src/lunasworkReserveGate.js).
  const runHeadless = createHeadlessRunner({ agyEnv: agyEnvNow, reserveUntil: ctx.reserveUntil, log: ctx.log });
  const playtestOn = createPlaytestOn({
    env: ctx.env, freeEnv: ctx.freeEnv, agyEnv: agyEnvNow, reserveUntil: ctx.reserveUntil, log: ctx.log,
  });

  // "Run Playtester pass": always on Claude (ctx.env() with the account layer),
  // metered on its own meter - a run on another project must not be booked with it.
  const playtestOnce = (opts) => meteredPass((own) => playtestOn(own)({ ...opts, free: false }));

  const build = async (opts) => {
    const res = await ctx.builder.build(opts);
    // The build's God Mode run, booked under the builder: the tokens its planner,
    // worker tabs and reviews reported, per model (plan.usage), and the CLI's own cost.
    const usage = godModeUsage(res && typeof res === 'object' ? res.plan : null);
    if (usage) meter.add('builder', usage);
    return res;
  };

  // LW 2.22b: the time-to-SHIP estimate of a run record; null when it cannot be made.
  const estimateOf = (run) => {
    try {
      if (!run || typeof run !== 'object') return null;
      const cards = typeof run.projectId === 'string' ? ctx.readTodos(run.projectId) : [];
      const roadmapMd = typeof run.repoPath === 'string' ? pack.readPackFile(run.repoPath, 'ROADMAP.md') : null;
      return shipEstimate(run, { cards, roadmapMd });
    } catch (err) {
      if (ctx.log) ctx.log(`[lunaswork] time-to-SHIP estimate failed: ${err && err.message}`);
      return null;
    }
  };
  const milestoneMail = reporter
    ? (run, mctx) => reporter.onMilestone(run, { ...mctx, timeToShip: etaLine(estimateOf(run)) })
    : null;

  const controller = createLunasWork({
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
    director: (opts) => runDirector({ ...opts, env: ctx.env(), runClaude: meter.runner('director', runHeadless) }),
    build,
    createAdapter: (name, opts) => createAdapter(name, opts),
    // Free providers for the Playtester while Claude is limited (freeFallback).
    playtest: playtestOn(meter),
    shipGate: ({ repoPath, scores }) => gateStatus({ shipCriteria: pack.readPackFile(repoPath, 'SHIP_CRITERIA.md') || '', scores }),
    critic: (opts) => runCritic({ ...opts, env: ctx.env(), runClaude: meter.runner('critic', runHeadless) }),
    // Idea #14: "like X" references in the pack researched into design/references/.
    research: (opts) => runResearch({ ...opts, env: ctx.env(), log: ctx.log, runClaude: runHeadless }),
    // LW 3.37: the Critic's art-direction check of new game assets (design/ASSETS.md).
    styleCheck: (opts) => runStyleCheck({ ...opts, env: ctx.env(), runClaude: runHeadless }),
    // The Director casts the source of auto asset rows; library key status is booleans only.
    assetCasting: (opts) => runCasting({ ...opts, env: ctx.env(), keyStatus: ctx.assetKeyStatus, runClaude: runHeadless }),
    // Asset cards on a Unity run name the asset pipeline's art root (per-PC setting).
    assetArtRoot: () => settingsStore.assetToolsFor(settingsStore.readSettings()).artRoot,
    // The Higgsfield credit price the asset cost estimate uses (per-PC setting).
    assetUsdPerCredit: () => settingsStore.assetToolsFor(settingsStore.readSettings()).higgsfieldUsdPerCredit,
    gitLog,
    syncCheckout,
    checkpoints: createCheckpoints({ log: ctx.log }),
    // Commits + pushes the design pack the Critic / Director wrote (src/lunasworkPackCommit.js).
    packCommit: (opts) => commitDesignPack(opts),
    // LW 3.28b: the client feedback widget - baked into staging deploys only,
    // its token revoked when the run ends.
    ...(ctx.widget ? { widget: ctx.widget, staging: { widget: ctx.widget } } : {}),
    // B17 opt-in: email replies; polled only while a run is active and the setting is on.
    ...(ctx.mailReplies ? { mailReplies: ctx.mailReplies } : {}),
    limitResumeAt,
    accountFailover: ctx.accountFailover,
    // The agy fallback only takes over when an agy profile exists.
    agyReady: () => agyEnvNow() !== null,
    awake: createAwake(ctx.powerSaveBlocker),
    // Every decision-queue answer, one line in the project's design/DECISIONS.md.
    recordDecision: ({ repoPath, line }) => {
      const op = pack.appendDecisionEntry(line);
      const res = op ? pack.applyWrite(repoPath, op) : { ok: false, error: 'empty entry' };
      if (!res.ok && ctx.log) ctx.log(`[lunaswork] DECISIONS.md not written: ${res.error}`);
      return res.ok;
    },
    // LW 2.25a: nobody picked a design variant by the deadline - the Critic does.
    pickVariant: (opts) => runCriticPick({ ...opts, env: ctx.env(), runClaude: meter.runner('critic', runHeadless) }),
    // LW 2.25b: Mati's prototype comments, appended to DESIGN.md (never a rewrite).
    appendDesign: ({ repoPath, text }) => {
      const op = pack.appendDesign(text);
      const res = op ? pack.applyWrite(repoPath, op) : { ok: false, error: 'empty append' };
      if (!res.ok && ctx.log) ctx.log(`[lunaswork] DESIGN.md not written: ${res.error}`);
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
    ...createHookDeps({
      env: ctx.env,
      settings: () => settingsStore.readSettings(),
      log: ctx.log,
      meter: meter.runner,
      // Reviews and project skills on agy when the reviewer role is agy; the second opinion's agy CLI.
      runClaude: runHeadless,
      agyEnv: agyEnvNow,
    }),
    // LW 2.22a: SHIP is final only after the docs iteration (README, user guide, release).
    shipDocs: createShipDocsDeps({ env: ctx.env }),
    usageMeter: meter,
    // C9: the error tracking DSN, kept on this PC (safeStorage, else a gitignored *.local.json).
    errorTracking: { store: ctx.secretStore || createSecretStore({ log: ctx.log }), log: ctx.log },
    onRunEnd: [...(ctx.onRunEnd || []), onRunEndGit],
    // B12 / B17: a short email per passed milestone gate, with the feedback link.
    onMilestone: milestoneMail ? [milestoneMail] : [],
    // Tool kit: a tool that is down, or an inconclusive playtest (its environment failed),
    // pauses the run - Mati gets a desktop notification.
    onToolDown: typeof ctx.notify === 'function'
      ? [(_run, down) => ctx.notify("Luna's Work paused", toolDownNotice(down))]
      : [],
    queue: ctx.queue || fileQueueStore(),
    log: ctx.log,
  });
  if (ctx.mailReplies) ctx.mailReplies.attach(controller);

  return {
    ...controller,
    /** LW 2.22b: the current run's time-to-SHIP estimate, or null. */
    shipEstimate: () => estimateOf(controller.snapshot()),
    /** LW 2.17b: the phone snapshot of the current run, or null without one. */
    phoneSnapshot: () => {
      const run = controller.snapshot();
      if (!run) return null;
      return buildSnapshot({ status: controller.status(), run, eta: estimateOf(run), shots: thumbnailsOf(run) });
    },
    /** One Playtester pass outside a run (src/lunasworkPlaytestOnce.js); result.usage = its tokens. */
    playtestOnce,
    /** The reset time of a usage-limit answer, or null - as the run computes it. */
    limitResumeAt,
  };
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
 * LW 2.27 "Ask Luna": the read-only question service (src/lunasworkAsk.js)
 * over the real run store, its own store and `claude -p`. It reads the
 * persisted run, never the controller.
 * @param {{env:()=>object, runsDir:()=>string, putAsks?:(section:object|null)=>unknown, log?:(line:string)=>void}} ctx
 */
function createAskRuntime(ctx) {
  const log = ctx.log || (() => {});
  return createAskService({
    loadRun: lunasworkStore.loadRun,
    store: lunasworkStore.askStore,
    runsDir: ctx.runsDir,
    env: ctx.env,
    runClaude: execClaude,
    onChange: (section) => {
      if (typeof ctx.putAsks !== 'function') return;
      Promise.resolve(ctx.putAsks(section)).catch((err) => log(`[lunaswork] asks snapshot failed: ${err && err.message}`));
    },
    log,
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
 *
 * LW 2.17b, when putLunasWork is given: controller.phoneSnapshot() goes out
 * on every phase change (and decision / feedback / wheel change), throttled
 * by lunasworksnapshot.createSnapshotThrottle.
 *
 * LW 2.27, when `ask` is given (lunasworkAsk.createAskService): the phone's
 * `lunaswork-ask:<id>` questions go to ask.pullQuestions(), which validates,
 * caps and rate-limits them here on the PC; the answers go out by the
 * service's own onChange.
 *
 * The project queue (B16) goes out only: putQueue gets readQueue()'s list on
 * every controller event and every publish() (the IPC calls it after an edit).
 * @param {{controller:{subscribe:Function, status:Function, applyAnswers:Function, applyFeedback?:Function, applyWheel?:Function},
 *   cloud:{onPulled:Function, hooks:Function}|null, putDecisions:(list:object[])=>unknown,
 *   putFeedback?:(section:object|null)=>unknown, putLunasWork?:(snap:object|null)=>unknown,
 *   ask?:{pullQuestions:(peers:unknown)=>number},
 *   readQueue?:()=>object[], putQueue?:(list:object[])=>unknown,
 *   throttle?:object, log?:(line:string)=>void}} ctx
 * @returns {{publish:()=>void, pullAnswers:()=>number}}
 */
function wireDecisionSync({ controller, cloud, putDecisions, putFeedback, putLunasWork, ask, readQueue, putQueue, throttle = {}, log = () => {} }) {
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
  const putQueueList = typeof putQueue === 'function' && typeof readQueue === 'function' ? changedPut('queue', putQueue) : null;
  const publish = (status = controller.status()) => {
    putDecisionList(status && Array.isArray(status.pendingDecisions) ? status.pendingDecisions : []);
    if (putFeedbackSection) putFeedbackSection((status && status.feedback) || null);
    if (putQueueList) {
      try {
        putQueueList(readQueue());
      } catch (err) {
        log(`[lunaswork] queue not read: ${err && err.message}`);
      }
    }
  };
  const pullAnswers = () => {
    if (!cloud) return 0;
    try {
      const peers = cloud.hooks('todos').extraPeers();
      if (ask && typeof ask.pullQuestions === 'function') {
        try {
          ask.pullQuestions(peers);
        } catch (err) {
          log(`[lunaswork] phone questions not read: ${err && err.message}`);
        }
      }
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
  const phone = typeof putLunasWork === 'function' && typeof controller.phoneSnapshot === 'function'
    ? createSnapshotThrottle({ ...throttle, publish: putLunasWork, log })
    : null;
  const SNAPSHOT_EVENTS = ['phase', 'decision', 'feedback', 'wheel', 'stopping'];
  controller.subscribe((event) => {
    publish(event && event.status);
    if (phone && event && SNAPSHOT_EVENTS.includes(event.type)) phone.poke(() => controller.phoneSnapshot());
  });
  if (cloud) cloud.onPulled((scope) => scope === 'todos' && pullAnswers());
  return { publish, pullAnswers };
}

module.exports = {
  createLunasWorkRuntime, createMachineRuntime, createAskRuntime, createAwake, syncCheckout, wireDecisionSync,
  thumbnail, thumbnailsOf, mailWithNote, meteredPass, createHeadlessRunner, createPlaytestOn,
};
