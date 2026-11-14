// ============================================================================
// LunaCore - God Mode v2 wiring (main process, docs/tbc_docs/MULTI_GODMODE_PLAN.md A2)
// ----------------------------------------------------------------------------
// Builds the real deps of one God Mode controller (src/orchestra.js
// createOrchestra) for ONE project, from what main.js already has - the same
// split as src/lunasworkWiring.js: main only hands its handles over in `ctx`.
// The registry (src/orchestraRegistry.js) calls this once per project.
//
//   sessions     worker / fix-up tabs through the overnight guard, PTY writes
//   to-dos       ticking cards on the run's project list
//   integration  merge, PR, self-check (behind the Luna's Work secret gate)
//   reports      <runsDir>/<planId>.md + .html, the morning toast
//   state        config/orchestra/<hash>.local.json for THIS project
//                (orchestraStore.js) - bound here, so a discard
//                (saveState(null)) clears the right file
//   renderer     orchestra:changed / orchestra:planWait carry {projectId, ...}
//   power        sleep at the limit / shutdown when done: ONE flow for every
//                project (sharedPowerDeps -> the registry), handed to each
//                controller; otherRunsActive is the registry's
//                othersActive(projectId)
//   battery      one process-wide guard (makeBatteryGuard) every project's
//                run shares: on-battery warning, low-battery hold
//   recovery     the playbook's git / gh actions and its one notification
//                (orchestraRecover.js)
//
// Luna's Work overlays (worker settings, planner models) apply only to the
// project its build runs on; every other project's run is plain God Mode.
// ============================================================================

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { encodeProjectDir } = require('./observer');
const { normalizeTranscriptId } = require('./orchestraResume');
const { BRIEF_DIR, RESUME_GRACE_MS } = require('./orchestra');
const { runPlanner } = require('./orchestraPlan');
const { loadProtected } = require('./orchestraHybridGuard');
const { finishPackage, headSha, runVerify } = require('./orchestraFinish');
const { sharedVerifyQueue } = require('./verifyQueue');
const orchestraIntegrate = require('./orchestraIntegrate');
const orchestraDeps = require('./orchestraDeps');
const { renderRunReportHtml, repoPathOf } = require('./orchestraReport');
const { gitDirExists } = require('./orchestraDiagnose');
const orchestraSelfCheck = require('./orchestraSelfCheck');
const defaultStore = require('./orchestraStore');
const { lastOpenToolUse, allowRuleFor, exampleFor } = require('./orchestraSupervisor');
const { guardedSessionFactory } = require('./overnight');
const { createPowerCtl } = require('./powerctl');
const { createBatteryGuard } = require('./orchestraPower');
const { createProcessScope } = require('./procTree');
const { WATCHDOG_TICK_MS } = require('./orchestraSleep');
const orchestraRecover = require('./orchestraRecover');
const planRunStart = require('./orchestraPlanRunStart');
const planRunView = require('./orchestraPlanRunView');
const planLaunch = require('./orchestraPlanRunLaunch');
const { validateRunSlug, planPath: planDocPath } = require('./orchestraPlanRun');
const { sizePackages } = require('./orchestraPlanBuild');
const orchestraReview = require('./orchestraReview');

const RUN_ID_RE = /^[a-z0-9]{1,40}$/;
// How much of a worker's transcript is read to name the tool a permission
// prompt is about.
const APPROVAL_TAIL_BYTES = 256 * 1024;
const TOAST_TITLE = 'LunaCore God Mode';
const POWER_NOTICES = {
  sleepSoon: 'Usage limit - the PC sleeps in 60 s and wakes for the reset. Cancel on the God Mode board.',
  sleepFailed: 'Could not schedule the wake-up, so the PC stays awake.',
  shutdownSoon: 'Run finished - the PC shuts down in 2 minutes. Cancel on the God Mode board.',
  shutdownFailed: 'Could not schedule the shutdown.',
};

// The battery notification, in the UI language (pl without diacritics).
const BATTERY_NOTICES = {
  battery: {
    pl: 'Komputer dziala na baterii - system moze go uspic i przerwac przebieg God Mode. Podlacz zasilacz.',
    en: 'The PC is on battery - Windows may put it to sleep and interrupt the God Mode run. Plug in the charger.',
  },
  batteryLow: {
    pl: 'Bateria {pct}% - nowe paczki i weryfikacje czekaja na zasilacz. Dzialajace paczki pracuja dalej.',
    en: 'Battery at {pct}% - new packages and verifies wait for the charger. Running ones carry on.',
  },
};

/**
 * The battery notification body for `kind`, or null for an unknown one.
 * @param {string} kind 'battery' | 'batteryLow'
 * @param {unknown} lang 'pl' | anything else = en
 * @param {{percent?:number|null}} [info]
 * @returns {string|null}
 */
function batteryNotice(kind, lang, info = {}) {
  const entry = Object.prototype.hasOwnProperty.call(BATTERY_NOTICES, kind) ? BATTERY_NOTICES[kind] : null;
  if (!entry) return null;
  const pct = info && Number.isFinite(info.percent) ? String(info.percent) : '?';
  return entry[lang === 'pl' ? 'pl' : 'en'].replace('{pct}', pct);
}

/**
 * The process-wide battery guard (src/orchestraPower.js) over Electron's
 * powerMonitor, which main hands over as plain functions.
 * @param {{
 *   anyRunActive: () => boolean, lang: () => string, toast: (title:string, body:string) => void,
 *   isOnBattery: () => boolean, onBatteryEvent: (fn:Function) => void, onAcEvent: (fn:Function) => void,
 *   log?: (line:string) => void, power?: {batteryPercent:Function},
 * }} hooks
 */
function makeBatteryGuard(hooks) {
  const power = hooks.power || createPowerCtl();
  return createBatteryGuard({
    isOnBattery: hooks.isOnBattery,
    onBatteryEvent: hooks.onBatteryEvent,
    onAcEvent: hooks.onAcEvent,
    readPercent: () => power.batteryPercent(),
    anyRunActive: hooks.anyRunActive,
    // Shown whether or not toasts are on in Settings, like the power notices.
    notify: (kind, info) => {
      const body = batteryNotice(kind, hooks.lang(), info);
      if (body) hooks.toast(TOAST_TITLE, body);
    },
    log: (line) => (hooks.log ? hooks.log(`[battery] ${line}`) : undefined),
  });
}

const errText = (err) => (err && err.message) || String(err);

/**
 * The registered project whose folder a stored run's repoPath is, or null.
 * Re-homed first: a run saved under another user's home still matches the
 * same registered project here (restore() re-homes the rest).
 * @param {{projects: () => object[], resolveStoredPath: Function}} ctx
 * @param {unknown} repoPath
 */
function projectForStoredRepo(ctx, repoPath) {
  if (typeof repoPath !== 'string' || !repoPath) return null;
  const repo = path.resolve(ctx.resolveStoredPath(repoPath) || repoPath);
  return ctx.projects().find((p) => p.path && path.resolve(p.path) === repo) || null;
}

/**
 * The repo a project's run works on, by name, for toasts and power notices
 * (several runs at once): the project folder's name, else the run's repo
 * folder, else the project's label or id.
 */
function repoNameOf(projectId, ctx, self) {
  const project = (ctx.projects() || []).find((p) => p && p.id === projectId);
  if (project && typeof project.path === 'string' && project.path) return path.basename(project.path);
  const controller = self();
  const repo = controller && typeof controller.repoPath === 'function' ? controller.repoPath() : null;
  if (typeof repo === 'string' && repo) return path.basename(repo);
  return (project && project.label) || projectId || null;
}

/** "<repo>: <text>", or the text alone when the repo has no name. */
const withRepo = (name, text) => (name ? `${name}: ${text}` : text);

/** orchestraStore.migrateLegacy's repoPath match: the legacy run's project id, or null. */
function legacyRunProject(ctx, raw) {
  const project = projectForStoredRepo(ctx, raw && raw.repoPath);
  return project ? project.id : null;
}

/**
 * The tail of a worker's transcript -> {rule, example} its permission prompt
 * is about (idea #5). Read once per prompt appearance, worker tabs only.
 * @param {{watcher?: {currentFile?: string|null}}} session
 */
function approvalRuleFor(session) {
  const none = { rule: null, example: null };
  const file = session.watcher && session.watcher.currentFile;
  if (!file) return none;
  let fd = null;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const length = Math.min(size, APPROVAL_TAIL_BYTES);
    const buf = Buffer.alloc(length);
    fs.readSync(fd, buf, 0, length, size - length);
    const open = lastOpenToolUse(buf.toString('utf8'));
    return { rule: allowRuleFor(open), example: exampleFor(open) };
  } catch {
    return none;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

/**
 * Luna's Work's view of God Mode (lunasworkBuild.js / lunasworkWiring.js):
 * one run per project, picked by the project or by the plan id a call carries.
 * @param {() => object} registry the orchestraRegistry, read lazily
 */
function godModeFacade(registry) {
  const runOf = (projectId) => registry().get(projectId);
  const onPlanRun = (payload, fn) => {
    const owner = registry().byPlanId(payload && payload.planId);
    return owner ? fn(owner.controller) : Promise.resolve({ ok: false, error: 'noPlan' });
  };
  return {
    makePlan: (planCtx) => registry().ensure(planCtx.projectId).makePlan(planCtx),
    launch: (payload) => onPlanRun(payload, (c) => c.launch(payload)),
    finishRun: (payload) => onPlanRun(payload, (c) => c.finishRun(payload)),
    cancelPlanWait: (projectId) => (runOf(projectId) ? runOf(projectId).cancelPlanWait() : null),
    view: (projectId) => (runOf(projectId) ? runOf(projectId).view() : null),
    planWait: (projectId) => (runOf(projectId) ? runOf(projectId).planWait() : null),
  };
}

/** Worker / fix-up tabs and what the supervisor does with them. */
function sessionDeps(ctx) {
  return {
    addWorktree: ctx.worktrees.addWorktree,
    dirtyCount: ctx.worktrees.dirtyCount,
    readTodos: ctx.readTodos,
    // Every worker / fix-up tab joins the overnight guard: keep-awake while a
    // run has tabs, plus the LM Studio watchdog for local-model workers. The
    // tab closing ends it (overnight.forgetSession in the close path).
    createSession: guardedSessionFactory(ctx.createSession, ctx.overnight),
    briefDir: () => path.join(ctx.userDir(), BRIEF_DIR),
    // A worker brief's "## Project memory" section (src/memoryinject.js), or null.
    projectMemory: (repoPath, pkg) => (typeof ctx.projectMemory === 'function' ? ctx.projectMemory(repoPath, pkg) : null),
    writeBrief: (file, text) => {
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, text, { encoding: 'utf8', mode: 0o600 });
        return true;
      } catch {
        return false;
      }
    },
    // Each package worktree gets its own dependencies (one install at a
    // time across every run), checked before a worker starts or a verify runs.
    installDeps: (root, opts) => orchestraDeps.installWorktreeDeps(root, { fresh: !!(opts && opts.fresh) }),
    checkDeps: (root) => orchestraDeps.checkNodeModules(root),
    depsBusy: (root) => orchestraDeps.installInFlight(root),
    // Slice 4 supervisor. Package verifies of every project's run share one
    // serial queue (verifyQueue.js); hooks feed the board's "waiting to verify".
    finishPackage: (pkg, hooks) =>
      finishPackage(pkg, { verifyImpl: (command, cwd) => sharedVerifyQueue().run(command, cwd, hooks || {}) }),
    headSha,
    sessionAlive: (id) => {
      const s = ctx.sessions.get(id);
      return !!(s && s.proc);
    },
    // Multi-line text goes in as a bracketed paste + Enter (see pty:paste);
    // a bare control byte (the kill switch's Esc) is written raw. Pasted text
    // can carry tool output (a failed verify), so control characters are
    // stripped first: an embedded ESC[201~ would end the paste early and turn
    // the rest into live keystrokes.
    writePty: (id, text, opts = {}) => {
      const s = ctx.sessions.get(id);
      if (!s || !s.proc) return false;
      if (opts.paste) {
        // eslint-disable-next-line no-control-regex
        const clean = String(text).replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
        s.proc.write(`\x1b[200~${clean}\x1b[201~`);
        s.proc.write('\r');
      } else {
        s.proc.write(text);
      }
      return true;
    },
    // Second pass + slice 5.
    closeSession: (id) => ctx.closeSession(id),
    // A resume after a PC shutdown (orchestraResume.js): the worker's
    // conversation id (the watcher's follows /clear, like tabResume.tabRecord)
    // and whether its transcript reached the disk.
    transcriptIdOf: (id) => {
      const s = ctx.sessions.get(id);
      return s ? (s.watcher && s.watcher.sessionUuid) || s.transcriptId || null : null;
    },
    transcriptExists: (cwd, uuid) => {
      // Defence in depth: only a UUID ever becomes part of the path.
      if (typeof cwd !== 'string' || !normalizeTranscriptId(uuid)) return false;
      const file = path.join(os.homedir(), '.claude', 'projects', encodeProjectDir(cwd), `${uuid}.jsonl`);
      try {
        return fs.statSync(file).isFile();
      } catch (err) {
        if (err && err.code !== 'ENOENT') ctx.log(`[orchestra] transcript check failed: ${err.code || err.message}`);
        return false;
      }
    },
  };
}

/** The run's project to-do list: ticking and editing cards. */
function todoDeps(ctx) {
  return {
    tickTodos: (projectId, ats) => {
      const wanted = new Set(ats);
      const list = ctx.readTodos(projectId);
      const next = list.map((t) => (wanted.has(t.at) && !t.done ? { ...t, done: true, doneAt: Date.now() } : t));
      if (next.some((t, i) => t !== list[i]) && ctx.writeTodos(projectId, next)) ctx.send('todo:changed', { projectId });
    },
    updateTodos: (projectId, fn) => {
      const list = ctx.readTodos(projectId);
      const next = fn(list);
      if (next !== list && ctx.writeTodos(projectId, next)) ctx.send('todo:changed', { projectId });
    },
  };
}

/** execImpl / verifyImpl whose children a process scope tracks. */
const scopedIo = (scope) => ({
  execImpl: scope.execFile,
  verifyImpl: (command, cwd) => runVerify(command, cwd, scope.exec),
});

/** Merge, PR, self-check and branch cleanup (orchestraIntegrate / orchestraSelfCheck). */
function integrationDeps(ctx) {
  const resolve = (r) => orchestraIntegrate.runResolver({ ...r, env: ctx.toolEnv() });
  const wt = ctx.worktrees;
  return {
    usageResetAt: ctx.usageResetAt,
    baseBranchOf: (repoPath) => orchestraIntegrate.baseBranchOf(repoPath),
    mergeDeps: (root, branches) => orchestraIntegrate.mergeDeps(root, branches, { resolve }),
    createPr: (args) => orchestraIntegrate.createPr({ ...args, env: ctx.toolEnv() }),
    // extra.beforePush: the end-of-run self-check gate (orchestraFinalize.js).
    // extra.scope: the pass's process scope (src/procTree.js) - git, npm
    // and the resolver run through it, so a timed-out pass can be killed.
    integrateMerge: (args, extra) => {
      const scope = extra && extra.scope ? extra.scope : null;
      return orchestraIntegrate.integrateMerge(args, {
        addWorktree: wt.addWorktree,
        removeWorktree: wt.removeWorktree,
        resolve: scope ? (r) => orchestraIntegrate.runResolver({ ...r, env: ctx.toolEnv() }, scope.execFile) : resolve,
        // The integration worktree's install queues behind the package installs;
        // verifyImpl comes from integrateMerge, so a scoped pass stays killable.
        installImpl: (root, verifyImpl) => orchestraDeps.runQueued(() => orchestraIntegrate.ensureInstall(root, verifyImpl)),
        ...(scope ? scopedIo(scope) : {}),
        ...(extra && typeof extra.beforePush === 'function' ? { beforePush: extra.beforePush } : {}),
      });
    },
    runSelfCheck: ctx.secretGate.wrapSelfCheck((args) =>
      orchestraSelfCheck.runSelfCheck(args, args && args.scope ? scopedIo(args.scope) : undefined),
    ),
    createProcessScope: () => createProcessScope(),
    pushBranch: ctx.secretGate.wrapPushBranch((root, branch) => orchestraSelfCheck.pushBranch(root, branch)),
    removeWorktree: wt.removeWorktree,
    // Failed-launch cleanup + the orphan-branch sweep (orchestraCleanup.js).
    deleteBranch: wt.deleteBranch,
    listOwnBranches: wt.listOwnBranches,
    worktreeBranches: wt.worktreeBranches,
  };
}

/** (planId, line) => void: one line appended to <runsDir>/<planId>.md. */
function appendRunReport(ctx) {
  return (planId, line) => {
    if (typeof planId !== 'string' || !RUN_ID_RE.test(planId) || !ctx.ensureUserDir()) return;
    try {
      fs.appendFileSync(path.join(ctx.runsDir(), `${planId}.md`), `${line}\n`, { encoding: 'utf8', mode: 0o600 });
    } catch (err) {
      ctx.logError(`[orchestra] could not append to the run report: ${errText(err)}`);
    }
  };
}

/**
 * Hands a finished run to main's run capture (src/memoryruncapture.js), which
 * makes one memory-extractor call per run. Fire and forget: nothing here may
 * delay or break the report or its email.
 */
function captureRun(ctx, self, planId) {
  if (typeof ctx.onRunReport !== 'function') return;
  try {
    const controller = self();
    const view = controller ? controller.view() : null;
    const repoPath = controller && typeof controller.repoPath === 'function' ? controller.repoPath() : null;
    if (!view || view.id !== planId || typeof repoPath !== 'string' || !repoPath) return;
    Promise.resolve(ctx.onRunReport({ runId: planId, repoPath, view })).catch((err) => ctx.logError(`[orchestra] run capture failed: ${errText(err)}`));
  } catch (err) {
    ctx.logError(`[orchestra] run capture failed: ${errText(err)}`);
  }
}

/** The run report (<runsDir>/<planId>.md + .html), snapshots and the morning toast. */
function reportDeps(projectId, ctx, self) {
  return {
    putSnapshot: (run) => ctx.putSnapshot(run),
    // Called once per report the finalizer writes (orchestraFinalize.js sendReport).
    onReport: (planId, text, summary) => {
      captureRun(ctx, self, planId);
      return ctx.onReport(planId, text, summary);
    },
    writeReport: (planId, text) => {
      if (!RUN_ID_RE.test(planId) || !ctx.ensureUserDir()) return null;
      try {
        const dir = ctx.runsDir();
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, `${planId}.md`);
        fs.writeFileSync(file, text, { encoding: 'utf8', mode: 0o600 });
        // The same run as a standalone page with charts, next to the .md.
        try {
          const view = self().view() || {};
          const repoPath = repoPathOf(text);
          const html = renderRunReportHtml(view, { now: Date.now(), suggestions: view.suggestions, repoPath, gitDirExists: gitDirExists(repoPath) });
          fs.writeFileSync(path.join(dir, `${planId}.html`), html, { encoding: 'utf8', mode: 0o600 });
        } catch (err) {
          ctx.logError(`[orchestra] html report failed: ${errText(err)}`);
        }
        return file;
      } catch {
        return null;
      }
    },
    appendReport: appendRunReport(ctx),
    // The morning report toast, when OS notifications are on (Settings). It
    // names the repo: several projects can finish overnight.
    notify: ({ pushed, total, failed }) => {
      if (!ctx.readUiPrefs().notificationsEnabled) return;
      const body = `${pushed}/${total} pushed${failed ? ' - integration needs you' : ''}`;
      ctx.toast(TOAST_TITLE, withRepo(repoNameOf(projectId, ctx, self), body));
    },
    onRunEvent: (kind, data) => {
      // The whole run waits for Mati: say so even with the board closed.
      // Not when the recovery playbook's ask already said it (orchestraRecover.js).
      if (kind === 'noNodeModules' && !(data && data.asked) && ctx.readUiPrefs().notificationsEnabled) {
        ctx.toast(TOAST_TITLE, orchestraDeps.noNodeModulesText((data && data.dir) || '?', { cause: data && data.cause, missing: data && data.missing }));
      }
      if (ctx.readUiPrefs().voiceEnabled === false) return;
      if (kind === 'done') ctx.playCue('voice.done');
      else if (kind === 'needYou' || kind === 'stalled' || kind === 'overlap' || kind === 'noNodeModules' || kind === 'recoverAsk') {
        ctx.playCue('voice.needYou');
      }
    },
  };
}

/**
 * Renames the package branch in its worktree (`git branch -m`), so the next
 * push goes out under the new name. Both names must be LunaCore's own shape.
 * @returns {Promise<{ok:boolean, detail?:string}>}
 */
async function renameBranchGit(root, from, to, execImpl) {
  const { runGit, firstLine } = require('./worktrees');
  if (!orchestraRecover.BRANCH_RE.test(String(from || '')) || !orchestraRecover.BRANCH_RE.test(String(to || ''))) return { ok: false, detail: 'not a LunaCore branch name' };
  const res = await runGit(root, ['branch', '-m', from, to], execImpl);
  return res.ok ? { ok: true } : { ok: false, detail: firstLine(res.stderr) || 'git branch -m failed' };
}

/**
 * `gh auth status`: true = logged in, false = gh says it is not, null =
 * cannot tell (gh missing, timed out) - the retry then goes ahead.
 * @param {object} env
 * @param {Function} [execImpl] child_process.execFile shape
 * @returns {Promise<boolean|null>}
 */
function ghAuthStatus(env, execImpl) {
  const run = execImpl || require('child_process').execFile;
  return new Promise((resolve) => {
    try {
      run('gh', ['auth', 'status'], { env, windowsHide: true, timeout: 20000 }, (err) => {
        if (!err) return resolve(true);
        resolve(err.code === 'ENOENT' || err.killed ? null : false);
      });
    } catch {
      resolve(null);
    }
  });
}

/**
 * The recovery playbook's process-bound actions (orchestraRecover.js): the
 * branch rename, `gh auth status`, and the ask - an OS toast in the UI
 * language, shown whether or not toasts are on (the run cannot go on alone).
 * The board shows the same ask from the package's stall history.
 */
function recoverDeps(ctx) {
  return {
    renameBranch: (root, from, to) => renameBranchGit(root, from, to),
    ghAuthOk: () => ghAuthStatus(ctx.toolEnv()),
    notifyRecover: (ask) => {
      const lang = ctx.readUiPrefs().lang === 'pl' ? 'pl' : 'en';
      const text = ask && ask.text && ask.text[lang];
      if (text) ctx.toast(text.title, text.body);
    },
  };
}

// A plan doc is Markdown: anything bigger is not read (copy / sizing).
const MAX_PLAN_DOC_BYTES = 512 * 1024;
// Task sizing counts lines of existing files; bigger files count as huge.
const MAX_SIZING_FILE_BYTES = 4 * 1024 * 1024;

/** A file's text, or null (missing, not a file, too big, unreadable). */
function readCapped(file, maxBytes) {
  try {
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.size > maxBytes) return null;
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** `rel` inside `root` (no escape through `..`, a drive or a backslash path), as an absolute path, or null. */
function insideRoot(root, rel) {
  if (typeof root !== 'string' || !root || typeof rel !== 'string' || !rel) return null;
  const abs = path.resolve(root, rel);
  const back = path.relative(path.resolve(root), abs);
  return back && !back.startsWith('..') && !path.isAbsolute(back) ? abs : null;
}

/**
 * Like insideRoot, but after resolving symlinks / junctions on both sides: a
 * committed link in an intermediate folder cannot point the read outside the
 * worktree. Null for a missing path too.
 */
function insideRealRoot(root, rel) {
  const abs = insideRoot(root, rel);
  if (!abs) return null;
  try {
    const real = fs.realpathSync(abs);
    const back = path.relative(fs.realpathSync(root), real);
    return back && !back.startsWith('..') && !path.isAbsolute(back) ? real : null;
  } catch {
    return null;
  }
}

// docs/plans/<slug>/REVIEW.md - the only file the free-branch review writes.
const REVIEW_DOC_RE = /^docs\/plans\/([a-z0-9]+(?:-[a-z0-9]+)*)\/REVIEW\.md$/;

/**
 * F5: writes docs/plans/<slug>/REVIEW.md in the repo checkout. The path is
 * LunaCore's own shape, checked again here; the folder is made inside the
 * repo and re-checked after symlinks / junctions are resolved.
 * @returns {boolean}
 */
function writeReviewDoc(ctx, repoPath, relPath, text) {
  const m = REVIEW_DOC_RE.exec(String(relPath || ''));
  if (!m || !validateRunSlug(m[1]).ok || typeof text !== 'string') return false;
  const abs = insideRoot(repoPath, relPath);
  if (!abs) return false;
  try {
    // One level at a time, each checked after links are resolved BEFORE the
    // next is made: a docs/ or docs/plans/ junction never gets a folder made
    // outside the repo.
    for (const dir of ['docs', 'docs/plans', `docs/plans/${m[1]}`]) {
      if (!fs.existsSync(path.join(repoPath, dir))) fs.mkdirSync(path.join(repoPath, dir));
      if (!insideRealRoot(repoPath, dir) || !fs.statSync(path.join(repoPath, dir)).isDirectory()) return false;
    }
    // An existing REVIEW.md must be a plain file, never a link to elsewhere.
    const existing = fs.lstatSync(abs, { throwIfNoEntry: false });
    if (existing && !existing.isFile()) return false;
    fs.writeFileSync(abs, text, 'utf8');
    return true;
  } catch (err) {
    ctx.logError(`[orchestra] could not write ${relPath}: ${errText(err)}`);
    return false;
  }
}

/**
 * Hybrid runs (F6c) and the opt-in free-branch review (F5): the read-only
 * headless Claude review, the diff it reads, the coding profile hybrid free
 * packages run on (never auto:easy) and REVIEW.md in the repo.
 */
function reviewDeps(ctx) {
  return {
    runReview: (args) => orchestraReview.runReview(args),
    reviewDiff: (input) => orchestraReview.readDiff(input, require('./worktrees').runGit),
    codingProfileId: () => (ctx.codingProfileId ? ctx.codingProfileId() : null),
    writeReviewDoc: (repoPath, relPath, text) => writeReviewDoc(ctx, repoPath, relPath, text),
  };
}

/** The plan workers' Playwright-only MCP config file, next to the briefs. */
const PLAN_MCP_FILE = 'luna-plan-mcp.json';

/**
 * Free God Mode v2 plan runs (orchestraPlanRunStart / -Launch / -View): the
 * topic split, the plan profile, and the doc side - copies of every written
 * .md next to the run report (<runsDir>/<planId>-plan/) and the fs helpers
 * PLAN.md's task sizing reads the worktree with.
 */
function planRunDeps(ctx) {
  return {
    runTopicSplit: (args) => planRunStart.runTopicSplit(args),
    planProfile: () => (ctx.planRunProfile ? ctx.planRunProfile() : null),
    // Written on every worker start (a stale or edited copy never survives);
    // null = the worker runs without Playwright, still locked down.
    planMcpConfigPath: () => {
      const file = path.join(ctx.userDir(), BRIEF_DIR, PLAN_MCP_FILE);
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(planLaunch.planMcpConfig(), null, 2), { encoding: 'utf8', mode: 0o600 });
        return file;
      } catch (err) {
        ctx.logError(`[orchestra] could not write the plan workers' MCP config: ${errText(err)}`);
        return null;
      }
    },
    planDocs: {
      read: (pkg) => {
        const abs = pkg && pkg.planRun ? insideRealRoot(pkg.root, pkg.planRun.outputPath) : null;
        return abs ? readCapped(abs, MAX_PLAN_DOC_BYTES) : null;
      },
      save: (planId, file, text) => {
        const dir = planRunView.planDocsDir(planId);
        if (!dir || !/^[A-Za-z0-9-]+\.md$/.test(String(file)) || !ctx.ensureUserDir()) return false;
        try {
          const folder = path.join(ctx.runsDir(), dir);
          fs.mkdirSync(folder, { recursive: true });
          fs.writeFileSync(path.join(folder, file), String(text), { encoding: 'utf8', mode: 0o600 });
          return true;
        } catch (err) {
          ctx.logError(`[orchestra] could not copy the plan doc ${file}: ${errText(err)}`);
          return false;
        }
      },
      sizing: (text, { root, splitsSent, planPath }) =>
        planRunView.planSizingStep(text, { splitsSent, planPath, ...sizingFs(root) }),
    },
  };
}

/**
 * The fs helpers strict task sizing (planTasks.js) reads a tree with.
 * Model-written paths: only files inside `root` are looked at.
 * @param {string} root a worktree or the repo
 */
function sizingFs(root) {
  return {
    repoRoot: root,
    fileExists: (_abs, rel) => {
      const abs = insideRealRoot(root, rel);
      try {
        return !!abs && fs.lstatSync(abs).isFile();
      } catch {
        return false;
      }
    },
    lineCount: (_abs, rel) => {
      const abs = insideRealRoot(root, rel);
      const body = abs ? readCapped(abs, MAX_SIZING_FILE_BYTES) : null;
      return body === null ? Number.MAX_SAFE_INTEGER : body.split(/\r?\n/).length;
    },
  };
}

// The worktree state an auto-split planner sees: short, never the diff itself.
const MAX_STATE_CHARS = 4000;

/**
 * Free God Mode v2 build runs (orchestraPlanBuild.js / orchestraAutoSplit.js):
 * an approved plan's PLAN.md, strict sizing against the repo, the free
 * planner's env (the coding profile) and a stuck worktree's state.
 */
function planBuildDeps(ctx) {
  return {
    // Only docs/plans/<slug>/PLAN.md inside the repo, for a valid slug.
    readPlanDoc: (repoPath, slug) => {
      if (!validateRunSlug(slug).ok) return null;
      const abs = insideRealRoot(repoPath, planDocPath(slug));
      return abs ? readCapped(abs, MAX_PLAN_DOC_BYTES) : null;
    },
    sizePackages: (repoPath, packages) => sizePackages(packages, sizingFs(repoPath)),
    freePlannerEnv: () => (ctx.freePlannerEnv ? ctx.freePlannerEnv() : null),
    worktreeState: async (root, baseSha) => {
      const { runGit } = require('./worktrees');
      const stat = baseSha ? await runGit(root, ['diff', '--stat', baseSha, '--']) : { ok: false };
      const status = await runGit(root, ['status', '--short']);
      return {
        diffStat: stat.ok ? stat.stdout.slice(0, MAX_STATE_CHARS) : '',
        status: status.ok ? status.stdout.slice(0, MAX_STATE_CHARS) : '',
      };
    },
  };
}

/** This project's stored run and the renderer events, bound to `projectId`. */
function stateDeps(projectId, ctx, store) {
  return {
    // A saved run is only brought back for a folder that is still one of the
    // registered projects - the file is on disk, so it is not trusted to name
    // where LunaCore opens tabs and runs git. Nor while another project's run
    // holds the same repo.
    loadState: () => {
      const raw = store.loadRun(projectId);
      if (!raw || !projectForStoredRepo(ctx, raw.repoPath)) return null;
      const repo = ctx.resolveStoredPath(raw.repoPath) || raw.repoPath;
      if (ctx.registry().repoBusy(projectId, repo)) {
        ctx.logError('[orchestra] stored run not restored: another project holds its repo');
        return null;
      }
      return raw;
    },
    saveState: (data) => {
      if (!store.saveRun(projectId, data)) ctx.logError('[orchestra] could not save the God Mode run (config/orchestra)');
    },
    onChange: (view) => {
      ctx.send('orchestra:changed', { projectId, view });
      ctx.builder.onChange(view, projectId);
    },
    // The phone keeps one live view per project (main, godmodesnapshot.livesEntry).
    onLive: (view) => ctx.onLive(view, projectId),
    onPlanWait: (state) => ctx.send('orchestra:planWait', { projectId, state }),
    // A restored run's folders and briefs re-homed onto this PC (src/projects.js).
    resolvePath: (p) => ctx.resolveStoredPath(p),
    resolveFile: (p) => ctx.resolveStoredPath(p, (f) => fs.existsSync(f)),
    flush: () => ctx.flushTodos(),
  };
}

/** Usage limits, free providers, sleep / shutdown and the cross-run guards. */
function powerDeps(projectId, ctx, shared, self) {
  return {
    // Planning that hit the Claude limit waits for the reset (orchestraPlanWait.js).
    usageLimits: () => ctx.usageLimits(),
    // ...unless another Claude account is free (src/claudeaccounts.js).
    accountFailover: (resetsAt) => ctx.accountFailover(resetsAt),
    freshEnv: () => ctx.toolEnv(),
    // "Free providers" runs: the first profile with a fallback chain (orchestraFree.js).
    freeProfileId: () => ctx.freeProfileId(),
    // Hybrid runs (F6): the shipped protected paths plus the repo's own
    // .lunacore/hybrid-protected.json; a broken file never throws.
    hybridProtected: (repoPath) => loadProtected({ repoPath }),
    // Sleep at the usage limit / shut down when done: the registry's one flow
    // for every run (sharedPowerDeps). Missing = a powerless single run.
    ...(shared && shared.powerFlow ? { powerFlow: shared.powerFlow } : {}),
    // Low battery holds new workers / verifies (one guard for every run).
    battery: ctx.battery || null,
    // Shutdown when done waits for every other project's run too.
    otherRunsActive: () => ctx.registry().othersActive(projectId),
    // The same repo twice is refused (makePlan -> 'repoBusy').
    repoBusy: (repoPath) => ctx.registry().repoBusy(projectId, repoPath),
    // A controller without the shared flow (orchestra.js builds its own)
    // notifies through this one, named by repo: which run asked for it.
    notifyPower: (kind) => {
      const body = POWER_NOTICES[kind];
      if (body) ctx.toast(TOAST_TITLE, withRepo(repoNameOf(projectId, ctx, self), body));
    },
  };
}

/**
 * The deps of the registry's ONE sleep / shutdown flow (orchestraPower.js
 * createPowerFlow minus getRun, which the registry aggregates over its
 * runs). A change re-sends every run's view: they all carry the same power
 * state.
 * @param {object} ctx the same ctx makeOrchestraDeps takes
 */
function sharedPowerDeps(ctx) {
  return {
    power: createPowerCtl(),
    awake: { release: () => ctx.overnight.suspendAwake(), restore: () => ctx.overnight.restoreAwake() },
    flush: () => ctx.flushTodos(),
    // Shown whether or not toasts are on in Settings: the PC is about to go.
    // One flow for every run, so the notice names no single repo.
    notify: (kind) => {
      const body = POWER_NOTICES[kind];
      if (body) ctx.toast(TOAST_TITLE, body);
    },
    appendReport: appendRunReport(ctx),
    onChange: () => {
      for (const { projectId, view } of ctx.registry().views()) ctx.send('orchestra:changed', { projectId, view });
    },
    graceMs: RESUME_GRACE_MS,
    log: (line) => ctx.log(`[power] ${line}`),
  };
}

/**
 * Luna's Work's overlays for this project's run: package models in the plan,
 * the build's worker settings and its own merge confirmation. They apply only
 * while Luna's Work builds on THIS project.
 */
function builderDeps(projectId, ctx, self) {
  const building = () => ctx.builder.isBuilding(projectId);
  const wrapped = ctx.builder.wrapPlanner(runPlanner);
  return {
    // Luna's Work resumes its own build after a restart: God Mode's shutdown
    // countdown does not drive the same run (Resume now by hand still works).
    autoResumeBlocked: () => building(),
    runPlanner: (args) => (building() ? wrapped(args) : runPlanner(args)),
    workerSettings: () => {
      const prefs = ctx.readUiPrefs();
      const base = {
        model: prefs.orchestraWorkerModel,
        permissionMode: prefs.orchestraPermissionMode,
        effort: prefs.orchestraWorkerEffort,
        integration: prefs.orchestraIntegration,
        allowedTools: prefs.orchestraAllowedTools,
        checkCommand: prefs.orchestraCheckCommand,
        // Opt-in God Mode evolutions, fixed into each new plan (orchestraSupervisor PLAN_OPT_IN_FLAGS).
        abBuild: prefs.orchestraAbBuild === true,
        selfHeal: prefs.orchestraSelfHeal === true,
        contextGuard: prefs.orchestraContextGuard === true,
      };
      return building() ? ctx.builder.workerSettings(base) : base;
    },
    // The Approve screen's / phone's worker model becomes the saved pref
    // (orchestra.js validates it first; writeUiPrefs allow-lists it again).
    saveWorkerModel: (model) => {
      if (typeof ctx.writeUiPrefs !== 'function') return;
      if (!ctx.writeUiPrefs({ orchestraWorkerModel: model })) ctx.log('[orchestra] worker model pref write failed');
    },
    // Merge mode pushes the base branch with no PR review: Mati confirms it
    // here, natively - a renderer can ask for it, never grant it. A Luna's
    // Work build's own plan was confirmed the same way when Mati started that run.
    confirmMerge: async (base) => {
      if (ctx.builder.ownsMerge(self().view())) return true;
      const answer = ctx.messageBox({
        type: 'warning',
        buttons: ['Merge and push', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
        title: 'God Mode - merge into base branch',
        message: `Merge every pushed package into "${base || '?'}" and push it?`,
        detail:
          'Packages are merged in dependency order in a separate worktree and verified after each merge. Nothing is pushed if a verify fails or a conflict cannot be resolved. There is no PR review.',
      });
      if (!answer) return false;
      const { response } = await answer;
      return response === 0;
    },
  };
}

/**
 * The deps of one project's God Mode controller.
 * @param {string|null} projectId the registry key this controller is bound to
 * @param {{
 *   registry: () => {get:Function, othersActive:Function, repoBusy:Function},
 *   builder: {isBuilding:Function, wrapPlanner:Function, workerSettings:Function, ownsMerge:Function, onChange:Function},
 *   secretGate: {wrapSelfCheck:Function, wrapPushBranch:Function},
 *   overnight: {suspendAwake:Function, restoreAwake:Function},
 *   sessions: Map<string, object>, send: (channel:string, payload:unknown) => void,
 *   readUiPrefs: () => object, writeUiPrefs?: (partial:object) => object|null, readTodos: Function, writeTodos: Function,
 *   createSession: Function, closeSession: Function, usageResetAt: () => number|null,
 *   toolEnv: () => object, userDir: () => string, ensureUserDir: () => boolean, runsDir: () => string,
 *   worktrees: {addWorktree:Function, dirtyCount:Function, removeWorktree:Function,
 *     deleteBranch:Function, listOwnBranches:Function, worktreeBranches:Function},
 *   putSnapshot: Function, onReport: Function, onLive: (view:object|null, projectId:string|null) => void,
 *   onRunReport?: (run:{runId:string, repoPath:string, view:object}) => Promise<unknown>|void,
 *   messageBox: (opts:object) => Promise<{response:number}>|null, toast: (title:string, body:string) => void,
 *   projects: () => object[], resolveStoredPath: Function, flushTodos: () => void,
 *   usageLimits: () => object[], accountFailover: Function, freeProfileId: () => string|null,
 *   codingProfileId?: () => string|null,
 *   planRunProfile?: () => {id:string, command:string, env:object}|null,
 *   freePlannerEnv?: () => object|null,
 *   playCue: (key:string) => void, log: (line:string) => void, logError: (line:string) => void,
 *   store?: {loadRun:Function, saveRun:Function},
 * }} ctx
 * @param {{powerFlow?: object|null}} [shared] what the registry shares between its runs
 * @returns {object} createOrchestra deps
 */
function makeOrchestraDeps(projectId, ctx, shared = {}) {
  const store = ctx.store || defaultStore;
  // This controller, once the registry has made it (deps are built first).
  const self = () => ctx.registry().get(projectId);
  return {
    ...sessionDeps(ctx),
    ...todoDeps(ctx),
    ...integrationDeps(ctx),
    ...reportDeps(projectId, ctx, self),
    ...stateDeps(projectId, ctx, store),
    ...powerDeps(projectId, ctx, shared, self),
    ...builderDeps(projectId, ctx, self),
    ...recoverDeps(ctx),
    ...planRunDeps(ctx),
    ...planBuildDeps(ctx),
    ...reviewDeps(ctx),
    // The watchdog interval (main.js ticks the registry at it): a tick much
    // later than this means the PC slept (orchestraSleep.js).
    tickMs: WATCHDOG_TICK_MS,
    log: (line) => ctx.log(line),
  };
}

module.exports = {
  makeOrchestraDeps,
  writeReviewDoc,
  sharedPowerDeps,
  projectForStoredRepo,
  legacyRunProject,
  approvalRuleFor,
  godModeFacade,
  makeBatteryGuard,
  batteryNotice,
  BATTERY_NOTICES,
  renameBranchGit,
  ghAuthStatus,
};
