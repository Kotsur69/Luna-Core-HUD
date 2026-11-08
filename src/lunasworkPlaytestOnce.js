// ============================================================================
// LunaCore - Luna's Work "Run Playtester pass" (main process)
// ----------------------------------------------------------------------------
// One explore pass of the Playtester on a project's app, without a run: no
// Director, no build, no Critic, nothing committed, merged or pushed. To see
// what the Playtester finds before (or between) full runs.
//
//   guards   one pass at a time; refused while a Luna's Work run is active on
//            the same project; only a registered project with a folder on
//            this PC and a saved profile - read ONLY through
//            lunasworkSettings.profileFor, never taken from the renderer
//   confirm  a native dialog like a run start's, with the profile's commands
//            (profileSummary): the renderer can write a profile, so only
//            Mati's native yes runs its startCommand
//   pass     createAdapter(profile.adapter, {projectDir, runId: fresh,
//            iteration: 1}) -> start -> deps.playtest in 'explore' mode (the
//            wiring's playtestOnce: the run's Playtester call, ctx.env() with
//            the Claude account layer, metered) -> stop() ALWAYS, in finally
//   limit    {error:'limit'}: accountFailover(resetsAt) - another Claude
//            account took over -> one retry on the still running app;
//            otherwise the answer is 'limit' with the reset time
//   result   <runsRoot>/lunaswork-<runId>/result.json, next to iter-1/; the
//            renderer gets publicResult(): texts, scores, journeys, console
//            errors, warnings, cost and small JPEG thumbnails - never a path
//
// IPC  lunaswork:playtestOnce {projectId} -> {ok:true, result}
//        | {ok:false, reason, resetsAt?, error?, detail?, evidence?}
// Push lunaswork:event {type:'playtestOnce', stage, projectId}
//        stage = starting | playing | stopping | done
// The evidence folder of the last pass opens through lunaswork:openEvidence
// {what:'playtestOnce'} (src/lunasworkipc.js, lastEvidence() below).
// ============================================================================

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const settingsStore = require('./lunasworkSettings');
const { effectiveModels } = require('./lunasworkRun');
const { stagingLines } = require('./lunasworkStaging');
const { parseQueueRequest } = require('./lunasworkipc');
const { getProject, resolveProjectDir } = require('./projects');
const { createAdapter: createTesterAdapter } = require('./lunasworkAdapters');
const { addUsage } = require('./lunasworkUsage');

const CHANNEL = 'lunaswork:playtestOnce';
const EVENT_TYPE = 'playtestOnce';
const STAGES = Object.freeze(['starting', 'playing', 'stopping', 'done']);
const MODE = 'explore';
const ITERATION = 1;
const RESULT_FILE = 'result.json';
// Another Claude account took over: the next call's env runs on it (the run waits the same, src/lunaswork.js).
const ACCOUNT_SWITCH_RETRY_MS = 3000;
// "pt" + time + random: lowercase letters and digits only (the adapters' run id rule), never a run's "lw" id.
const RUN_ID_PREFIX = 'pt';
const MAX_THUMBS = 24;
const MAX_CONSOLE_ERRORS = 30;
const MAX_WARNINGS = 50;
const MAX_TEXT_CHARS = 300;
const MAX_CODE_CHARS = 60;
// The renderer's lists, capped here too (validateReport caps them upstream).
const MAX_FINDINGS = 100;
const MAX_STEPS = 20;
const MAX_ROWS = 100;
const MAX_FILES = 5;
// An absolute path in an error text (C:\..., \server\..., /...), at a word start.
const ABS_PATH_RE = /(?<=^|[\s'"(=])(?:[A-Za-z]:[\\/]|\\\\|\/)[^\s'"<>|)]*/g;

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const errText = (err) => (err instanceof Error ? err.message : String(err));
const capped = (v, max = MAX_TEXT_CHARS) => (typeof v === 'string' ? v.slice(0, max) : '');
const list = (v) => (Array.isArray(v) ? v : []);
const finiteOrNull = (v) => (Number.isFinite(v) ? v : null);
const isLimit = (res) => isObj(res) && res.error === 'limit';
const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const fileName = (p) => path.basename(p.replace(/[\\/]+$/, '')) || '...';
/** An error text for the renderer: capped, every absolute path cut to its file name. */
const withoutPaths = (v) => capped(capped(v, MAX_TEXT_CHARS * 2).replace(ABS_PATH_RE, fileName));

/** A fresh run id for one pass. */
function newPassId(now) {
  return `${RUN_ID_PREFIX}${now().toString(36)}${crypto.randomBytes(3).toString('hex')}`;
}

/**
 * The profile's commands as dialog rows: everything the pass runs on this PC.
 * @param {object} profile a validated profile (lunasworkSettings.profileFor)
 * @returns {string[]}
 */
function profileSummary(profile) {
  const p = isObj(profile) ? profile : {};
  return [
    `Tester: ${p.adapter || 'web'}`,
    `Start command: ${p.startCommand || '-'}`,
    ...(p.seedCommand ? [`Seed command: ${p.seedCommand}`] : []),
    `App URL: ${p.url || '-'}`,
    // LW 3.28a: a staging profile tests its staging URL; Mati sees its commands too.
    ...stagingLines(p),
  ];
}

/**
 * The native confirmation, the same shape as a run start's.
 * @param {{dialog:{showMessageBox:Function}, getWindow:()=>object|null}} deps
 * @returns {(ctx:{repoPath:string, profile:object})=>Promise<boolean>}
 */
function createConfirmDialog({ dialog, getWindow }) {
  return async ({ repoPath, profile }) => {
    const win = getWindow();
    if (!win || win.isDestroyed()) return false;
    const { response } = await dialog.showMessageBox(win, {
      type: 'warning',
      buttons: ['Run Playtester pass', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      title: "Luna's Work - one Playtester pass",
      message: `Run one Playtester pass in "${repoPath}"?`,
      detail: [
        'LunaCore starts the app with the command below, the Playtester plays it once (a claude -p call on your Claude account) and the app is stopped again. Nothing is built, committed, merged or pushed.',
        '',
        ...profileSummary(profile),
      ].join('\n'),
    });
    return response === 0;
  };
}

/** result.json of one pass, pretty-printed (it is read by people). */
function writeResultFile(file, record) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
}

/** The thumbnail maker of the main process (Electron's nativeImage); loaded on first use. */
function defaultThumb(file) {
  return require('./lunasworkWiring').thumbnail(file);
}

// ---- the renderer's view ------------------------------------------------------------

function warningView(w) {
  const src = isObj(w) ? w : {};
  const text = [src.title, src.criterion, src.name, src.journey, src.screen, src.file, src.detail]
    .find((v) => typeof v === 'string' && v);
  return { code: capped(src.code, MAX_CODE_CHARS) || 'warning', text: withoutPaths(text) };
}

/** Whether `file` resolves to a path inside `dir`. */
function isInside(dir, file) {
  if (typeof dir !== 'string' || !dir || typeof file !== 'string' || !file) return false;
  const root = path.resolve(dir);
  return path.resolve(root, file).startsWith(root + path.sep);
}

/**
 * Thumbnails for the first findings that have a screenshot inside the pass's
 * evidence folder (validateReport already checked it; this is the second
 * lock before main reads an image for the renderer). A failed one is skipped.
 */
function thumbMaker(makeThumb, log, evidenceDir) {
  let made = 0;
  return (file) => {
    if (made >= MAX_THUMBS || !isInside(evidenceDir, file)) return null;
    try {
      const src = makeThumb(file);
      if (typeof src !== 'string' || !src.startsWith('data:image/')) return null;
      made += 1;
      return src;
    } catch (err) {
      log(`[lunaswork] playtest pass: thumbnail failed: ${errText(err)}`);
      return null;
    }
  };
}

/**
 * What the renderer may see of a pass: no file path, every list capped.
 * @param {object} record the pass record (see pass() below)
 * @param {{makeThumb:(file:string)=>string|null, log:Function, evidenceDir?:string}} opts
 *   evidenceDir: the pass's folder - only screenshots inside it get a thumbnail
 */
function publicResult(record, { makeThumb, log, evidenceDir }) {
  const res = isObj(record.playtest) ? record.playtest : {};
  const report = isObj(res.report) ? res.report : {};
  const thumb = thumbMaker(makeThumb, log, evidenceDir);
  const findings = list(report.findings).filter(isObj).slice(0, MAX_FINDINGS).map((f) => ({
    kind: capped(f.kind, MAX_CODE_CHARS),
    severity: capped(f.severity, MAX_CODE_CHARS),
    title: capped(f.title),
    steps: list(f.steps).slice(0, MAX_STEPS).map((s) => capped(s)),
    consoleErrors: list(f.consoleErrors).slice(0, MAX_CONSOLE_ERRORS).map((s) => withoutPaths(s)),
    files: list(f.files).filter((p) => typeof p === 'string').slice(0, MAX_FILES).map(fileName),
    thumb: thumb(f.screenshot),
  }));
  return {
    runId: record.runId,
    projectId: record.projectId,
    mode: MODE,
    model: typeof res.model === 'string' ? res.model : null,
    costUsd: finiteOrNull(res.costUsd),
    usage: isObj(res.usage) ? res.usage : null,
    durationMs: finiteOrNull(res.durationMs),
    retried: record.retried === true,
    findings,
    scores: list(report.scores).filter(isObj).slice(0, MAX_ROWS)
      .map((s) => ({ milestone: capped(s.milestone), criterion: capped(s.criterion), score: finiteOrNull(s.score) })),
    journeys: list(report.journeys).filter(isObj).slice(0, MAX_ROWS).map((j) => ({ name: capped(j.name), passed: j.passed === true })),
    consoleErrors: [...new Set(findings.flatMap((f) => f.consoleErrors))].slice(0, MAX_CONSOLE_ERRORS),
    warnings: list(report.warnings).slice(0, MAX_WARNINGS).map(warningView),
  };
}

// ---- the service --------------------------------------------------------------------

/**
 * @param {{
 *   projects: ()=>object[],
 *   controller: {isActiveOn:(projectId:string)=>boolean},
 *   confirm: (ctx:{projectId:string, repoPath:string, profile:object})=>Promise<boolean>,
 *   createAdapter?: (name:string, opts:{projectDir:string, runId:string, iteration:number})=>{
 *     evidenceDir:string, start:(profile:object)=>Promise<{url?:string}>, stop:()=>Promise<unknown>},
 *   playtest: (opts:object)=>Promise<object>,
 *   limitResumeAt?: (res:object)=>number|null,
 *   accountFailover?: (resetsAt:number|null)=>boolean,
 *   readSettings?: ()=>object, resolveDir?: (p:string)=>string|null,
 *   writeResult?: (file:string, record:object)=>void, makeThumb?: (file:string)=>string|null,
 *   newRunId?: ()=>string, now?: ()=>number, sleep?: (ms:number)=>Promise<void>, log?: (line:string)=>void,
 * }} deps
 * @returns {{run:(projectId:string, opts?:{onProgress?:(stage:string)=>void})=>Promise<object>,
 *   busy:()=>boolean, lastEvidence:()=>{projectId:string, runId:string, evidenceDir:string}|null}}
 */
function createPlaytestOnce(deps) {
  const now = deps.now || Date.now;
  const sleep = deps.sleep || realSleep;
  const log = deps.log || (() => {});
  const readSettings = deps.readSettings || (() => settingsStore.readSettings());
  const resolveDir = deps.resolveDir || resolveProjectDir;
  const newRunId = deps.newRunId || (() => newPassId(now));
  const writeResult = deps.writeResult || writeResultFile;
  const makeThumb = deps.makeThumb || defaultThumb;
  const createAdapter = deps.createAdapter || createTesterAdapter;
  let running = false;
  let lastEvidence = null;

  const runActiveOn = (projectId) => deps.controller.isActiveOn(projectId) === true;

  /** The project, its folder, profile and models - or the reason a pass may not run. */
  function prepare(projectId) {
    const projects = deps.projects();
    const project = Array.isArray(projects) ? getProject(projects, projectId) : null;
    if (!project) return { reason: 'bad-project' };
    if (runActiveOn(project.id)) return { reason: 'run-active' };
    const repoPath = typeof project.path === 'string' ? resolveDir(project.path) : null;
    if (typeof repoPath !== 'string' || !path.isAbsolute(repoPath)) return { reason: 'no-folder' };
    const settings = readSettings();
    const profile = settingsStore.profileFor(settings, project.id);
    if (!profile) return { reason: 'no-profile' };
    return { project, repoPath, profile, models: effectiveModels(settings, project.id).models };
  }

  /** The reset time of a limit answer: its own, else the usage-limit table's, else null. */
  function resetTimeOf(res) {
    if (Number.isFinite(res.resumeAt)) return res.resumeAt;
    return finiteOrNull(deps.limitResumeAt ? deps.limitResumeAt(res) : null);
  }

  /** The explore pass; on a usage limit one retry when another Claude account took over. */
  async function playWithFailover(ctx) {
    const call = async () => {
      const res = await deps.playtest({
        projectDir: ctx.repoPath, adapter: ctx.adapter, url: ctx.url, mode: MODE, models: ctx.models, iteration: ITERATION,
      });
      return isObj(res) ? res : { ok: false, error: 'failed' };
    };
    let res = await call();
    let retried = false;
    if (isLimit(res) && deps.accountFailover && deps.accountFailover(resetTimeOf(res))) {
      log('[lunaswork] playtest pass: usage limit, switched to another Claude account, retrying once');
      await sleep(ACCOUNT_SWITCH_RETRY_MS);
      retried = true;
      const first = res;
      const second = await call();
      // The limited call may have spent tokens too: the pass reports both.
      res = isObj(first.usage) || isObj(second.usage) ? { ...second, usage: addUsage(first.usage, second.usage) } : second;
    }
    if (isLimit(res)) return { outcome: 'limit', resetsAt: resetTimeOf(res), retried, playtest: res };
    if (!res.ok) {
      return { outcome: 'failed', error: capped(res.error, MAX_CODE_CHARS) || 'failed', detail: capped(res.detail), retried, playtest: res };
    }
    return { outcome: 'ok', retried, playtest: res };
  }

  /** Starts the app and plays it. Never throws: a failure is an outcome. */
  async function startAndPlay(adapter, ready, progress) {
    progress('starting');
    let url = null;
    try {
      const started = await adapter.start(ready.profile);
      url = isObj(started) && typeof started.url === 'string' ? started.url : null;
    } catch (err) {
      return { outcome: 'appFailed', detail: capped(errText(err)) };
    }
    progress('playing');
    try {
      return { url, ...(await playWithFailover({ ...ready, adapter, url })) };
    } catch (err) {
      return { url, outcome: 'failed', error: 'crashed', detail: capped(errText(err)) };
    }
  }

  async function stopQuietly(adapter) {
    try {
      await adapter.stop();
    } catch (err) {
      log(`[lunaswork] playtest pass: could not stop the app: ${errText(err)}`);
    }
  }

  function saveResult(adapter, record) {
    try {
      writeResult(path.join(path.dirname(adapter.evidenceDir), RESULT_FILE), record);
    } catch (err) {
      log(`[lunaswork] playtest pass: result.json not written: ${errText(err)}`);
    }
  }

  /**
   * The IPC answer for a finished pass. `evidence`: this pass has a folder
   * that lunaswork:openEvidence {what:'playtestOnce'} opens.
   */
  function answerOf(record, evidenceDir) {
    if (record.outcome === 'ok') return { ok: true, result: publicResult(record, { makeThumb, log, evidenceDir }) };
    const evidence = lastEvidence !== null;
    if (record.outcome === 'limit') return { ok: false, reason: 'limit', resetsAt: record.resetsAt, evidence };
    // result.json keeps the full detail; the renderer gets it without paths.
    if (record.outcome === 'appFailed') return { ok: false, reason: 'app-failed', detail: withoutPaths(record.detail), evidence };
    return { ok: false, reason: 'playtest-failed', error: record.error, detail: withoutPaths(record.detail), evidence };
  }

  /** One pass on a prepared project: the app is stopped whatever happens after it was created. */
  async function pass(ready, progress) {
    const runId = newRunId();
    // A new pass: the folder of the one before is no longer "the last pass".
    lastEvidence = null;
    let adapter;
    try {
      adapter = createAdapter(ready.profile.adapter, { projectDir: ready.repoPath, runId, iteration: ITERATION });
    } catch (err) {
      log(`[lunaswork] playtest pass: no tester adapter: ${errText(err)}`);
      return { ok: false, reason: 'failed' };
    }
    const startedAt = now();
    let outcome;
    try {
      outcome = await startAndPlay(adapter, ready, progress);
    } finally {
      progress('stopping');
      await stopQuietly(adapter);
    }
    const evidenceDir = typeof adapter.evidenceDir === 'string' && adapter.evidenceDir ? adapter.evidenceDir : null;
    if (evidenceDir) lastEvidence = { projectId: ready.project.id, runId, evidenceDir };
    const record = {
      projectId: ready.project.id, runId, mode: MODE, adapter: ready.profile.adapter, startedAt, finishedAt: now(), ...outcome,
    };
    if (evidenceDir) saveResult(adapter, record);
    progress('done');
    return answerOf(record, evidenceDir);
  }

  /** Progress must never break the pass. */
  const progressOf = (onProgress) => (stage) => {
    if (typeof onProgress !== 'function') return;
    try {
      onProgress(stage);
    } catch (err) {
      log(`[lunaswork] playtest pass: progress event failed: ${errText(err)}`);
    }
  };

  async function run(projectId, { onProgress } = {}) {
    if (running) return { ok: false, reason: 'busy' };
    running = true;
    try {
      const ready = prepare(projectId);
      if (ready.reason) return { ok: false, reason: ready.reason };
      const confirmed = (await deps.confirm({ projectId: ready.project.id, repoPath: ready.repoPath, profile: ready.profile })) === true;
      if (!confirmed) return { ok: false, reason: 'declined' };
      // The dialog may have stood open while a run started on this project.
      if (runActiveOn(ready.project.id)) return { ok: false, reason: 'run-active' };
      return await pass(ready, progressOf(onProgress));
    } finally {
      running = false;
    }
  }

  return { run, busy: () => running, lastEvidence: () => (lastEvidence ? { ...lastEvidence } : null) };
}

// ---- IPC ----------------------------------------------------------------------------

/**
 * lunaswork:playtestOnce. The payload is exactly {projectId} (lunasworkipc's
 * request parser); everything else is looked up in main.
 * @param {{ipcMain:{handle:Function}, service:{run:Function}, send?:(channel:string, payload:object)=>void}} deps
 */
function registerPlaytestOnceIpc({ ipcMain, service, send }) {
  ipcMain.handle(CHANNEL, async (_event, req) => {
    try {
      const parsed = parseQueueRequest(req);
      if (!parsed) return { ok: false, reason: 'bad-project' };
      const onProgress = (stage) => {
        if (typeof send === 'function') send('lunaswork:event', { type: EVENT_TYPE, stage, projectId: parsed.projectId });
      };
      return await service.run(parsed.projectId, { onProgress });
    } catch (err) {
      console.error('[lunaswork] playtestOnce failed:', err && err.message);
      return { ok: false, reason: 'failed' };
    }
  });
}

module.exports = {
  CHANNEL,
  EVENT_TYPE,
  STAGES,
  RESULT_FILE,
  ACCOUNT_SWITCH_RETRY_MS,
  profileSummary,
  createConfirmDialog,
  publicResult,
  createPlaytestOnce,
  registerPlaytestOnceIpc,
};
