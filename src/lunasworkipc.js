// ============================================================================
// LunaCore - Luna's Work IPC (main process, docs/tbc_docs/LUNAS_WORK_PLAN.md slice 1.2c)
// ----------------------------------------------------------------------------
// lunaswork:getSettings    {projectId} -> view
// lunaswork:saveSettings   {projectId, models?, projectModels?, freeFallback?, profile?,
//                           designVariants?, mockupFirst?} -> view
//                          | {ok:false, reason:'bad-profile', field, detail}
// lunaswork:scaffoldPack   {projectId} -> {ok, created, skipped, failed, pack}
// lunaswork:packStatus     {projectId} -> {ok, pack}
// lunaswork:startInterview {projectId} -> {ok, pack} | {ok:false, reason}
//
// With a run controller (src/lunaswork.js) passed in:
// lunaswork:start          {projectId, models?} -> {ok, status} | {ok:false, reason, message?}
// lunaswork:stop           (no payload) -> {ok, status} | {ok:false, reason, message}
// lunaswork:status         (no payload) -> {ok, status}
// lunaswork:steer          {projectId, text} -> {ok} | {ok:false, reason}
// lunaswork:openEvidence   (no payload) -> {ok} | {ok:false, reason}
//                          {what:'playtestOnce'}: the last "Run Playtester pass"
//                          folder instead (src/lunasworkPlaytestOnce.js); same checks
// lunaswork:handOver       {runId?} -> {ok, status} | {ok:false, reason, message?}
// lunaswork:handBack       {runId?} -> {ok, status} | {ok:false, reason, message?}
//                          "Hand me the wheel" (C11); runId, when sent, must
//                          be the current run's - a stale panel is refused
// lunaswork:dashboard     (no payload) -> {ok, dashboard} | {ok:false, reason}
//                          the current run for the HUD dashboard (LW 2.17a,
//                          lunasworkDashboardView.dashboardView); null without a run
// lunaswork:screenshot     {runId, file} -> {ok, dataUrl} | {ok:false, reason}
//                          one image ONLY from config/runs/lunaswork-<runId>/ of
//                          the current (or last) run: file is relative to it;
//                          `..`, absolute paths, streams, symlinks and hardlinks
//                          are refused (lunasworkDashboardView.readScreenshot)
// lunaswork:ask            {question} -> {ok, item} | {ok:false, reason, retryAt?}
//                          "Ask Luna" (LW 2.27): a read-only answer about the run
//                          (src/lunasworkAsk.js); question one line, 1..500 chars,
//                          10 per hour with the phone's - enforced here, on the PC
// With a queue store passed in (B16, src/lunasworkQueue.js):
// lunaswork:queueList      (no payload) -> {ok, queue}
// lunaswork:queueAdd       {projectId} -> {ok, queue} | {ok:false, reason}
//                          only a known project with a folder, a valid
//                          profile and a complete design pack, and only
//                          after Mati confirms its commands natively
//                          (confirmQueueAdd); profile + check command pinned
// lunaswork:queueRemove    {projectId} -> {ok, queue} | {ok:false, reason}
// lunaswork:queueMove      {projectId, delta: -1|1} -> {ok, queue} | {ok:false, reason}
//                          queue = [{projectId, label, startCommand, url, addedAt}]
// lunaswork:event          main -> renderer push, {type, status}, on every
//                          controller event (phase, wait, resume, stopping, wheel)
//
// view = {ok, projectId, roles, choices, models, projectModels, freeFallback, profile,
//         designVariants, mockupFirst}  (the LW 2.25 toggles are per project)
// models = LunaCore's default per role; projectModels = this project's override.
// Every status that leaves main goes through lunasworkStatus.publicStatus.
// pack = {complete, missing, empty}
//
// The renderer only ever names a KNOWN project by id - never a folder, a
// file or a brief. Every payload is checked here: types, lengths, the role and
// model lists, and the profile through lunasworkSettings.validateProfile.
// A start's models override is this run's only and is checked like the
// settings' models; nothing else of a start payload reaches the controller.
// The profile's commands are saved only to LunaCore's local settings file
// (the trust boundary described in lunasworkSettings.js).
// ============================================================================

'use strict';

const fs = require('fs');
const path = require('path');
const settingsStore = require('./lunasworkSettings');
const pack = require('./lunasworkPack');
const { ROLES, MODEL_CHOICES } = require('./lunasworkRules');
const { getProject, resolveProjectDir } = require('./projects');
const { keyFor } = require('./todo');
const { publicStatus, publicEvent, evidenceDirOf } = require('./lunasworkStatus');
const { STEER_TAG, MAX_ITEMS: MAX_TODO_ITEMS } = require('./todorows');
const { RUN_ID_RE } = require('./lunasworkWheel');
const { dashboardView, readScreenshot } = require('./lunasworkDashboardView');
const { cleanQuestion } = require('./lunasworkAskModel');
const queueStore = require('./lunasworkQueue');

const MAX_ID_CHARS = 200;
// A steer card is one line typed into the dashboard, so it keeps its own
// small cap (index.html #lw-steer-text, i18n lw.err.bad-text) instead of the
// to-do title cap.
const MAX_STEER_CHARS = 1000;
// Opening a tab is a side effect a double click must not repeat.
const INTERVIEW_GAP_MS = 3000;
// unityMcpUrl / scene: the unity adapter's fields (src/lunasworkAdapterProfiles.js).
const PROFILE_FIELDS = ['adapter', 'startCommand', 'url', 'unityMcpUrl', 'scene', 'readyTimeoutSec', 'checkCommand'];
const MAX_PROFILE_STRING = settingsStore.MAX_COMMAND_CHARS;

const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/** A steer card's text: one trimmed line, 1..MAX_STEER_CHARS, or null. */
function parseSteerText(raw) {
  if (typeof raw !== 'string' || raw.length > MAX_STEER_CHARS * 2) return null;
  const text = raw.trim();
  if (!text || text.length > MAX_STEER_CHARS || CONTROL_CHARS.test(text)) return null;
  return text;
}

/**
 * A wheel request (C11): nothing, or {runId} naming a run. Null when it is
 * malformed - any other key, or a run id that is not one.
 * @returns {{runId?:string}|null}
 */
function parseWheelRequest(req) {
  if (req === undefined || req === null) return {};
  if (!isObject(req)) return null;
  const keys = Object.keys(req);
  if (keys.some((k) => k !== 'runId')) return null;
  if (req.runId === undefined) return {};
  return typeof req.runId === 'string' && RUN_ID_RE.test(req.runId) ? { runId: req.runId } : null;
}

/**
 * A queue request: exactly the listed keys, a well-formed project id, and
 * for a move a delta of -1 or 1. Null when anything else is in it.
 * @returns {{projectId:string, delta?:number}|null}
 */
function parseQueueRequest(req, { move = false } = {}) {
  if (!isObject(req)) return null;
  const allowed = move ? ['projectId', 'delta'] : ['projectId'];
  if (Object.keys(req).some((k) => !allowed.includes(k))) return null;
  const projectId = queueStore.cleanProjectId(projectIdOf(req));
  if (!projectId) return null;
  if (!move) return { projectId };
  return req.delta === -1 || req.delta === 1 ? { projectId, delta: req.delta } : null;
}

/** The project id of a request, or null when it is malformed. */
function projectIdOf(req) {
  if (!isObject(req)) return null;
  const id = req.projectId;
  return typeof id === 'string' && id.length > 0 && id.length <= MAX_ID_CHARS ? id : null;
}

/**
 * A partial { role: choice } map, or null when anything in it is unknown -
 * a bad model payload is refused as a whole, never half-applied.
 */
function parseModels(raw) {
  if (!isObject(raw)) return null;
  const out = {};
  for (const [role, choice] of Object.entries(raw)) {
    if (!ROLES.includes(role) || !MODEL_CHOICES.includes(choice)) return null;
    out[role] = choice;
  }
  return out;
}

/** Copies only the known profile fields, refusing oversized strings before validation. */
function parseProfile(raw) {
  if (!isObject(raw)) return null;
  const out = {};
  for (const key of PROFILE_FIELDS) {
    const v = raw[key];
    if (v === undefined) continue;
    if (typeof v === 'string' && v.length > MAX_PROFILE_STRING) return null;
    out[key] = v;
  }
  return out;
}

/** Which form field a validateProfile reason is about (its first word). */
function fieldOf(reason) {
  const m = /^(adapter|startCommand|url|unityMcpUrl|scene|readyTimeoutSec|checkCommand)\b/.exec(String(reason || ''));
  if (m) return m[1];
  return /adapter/.test(String(reason || '')) ? 'adapter' : 'profile';
}

function defaultWriteBrief(file, text) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text, { encoding: 'utf8', mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {{ipcMain:object, projects:()=>object[], createSession:(opts:object)=>object|null,
 *   briefDir:()=>string, controller?:{start:Function, stop:Function, status:Function, subscribe:Function},
 *   send?:(channel:string, payload:object)=>void,
 *   todos?:{read:(projectId:string)=>object[], write:(projectId:string, list:object[])=>boolean, changed:(projectId:string)=>void},
 *   runsRoot?:()=>string, openPath?:(dir:string)=>Promise<string>|string,
 *   ask?:{ask:(question:string, opts:object)=>Promise<object>},
 *   queue?:{read:()=>object, write:(q:object)=>boolean}, queueChanged?:()=>void,
 *   confirmQueueAdd?:(ctx:{projectId:string, repoPath:string, profile:object, checkCommand:string})=>Promise<boolean>,
 *   checkCommandFor?:(profile:object)=>string,
 *   playtestPass?:{lastEvidence:()=>{projectId:string, runId:string, evidenceDir:string}|null},
 *   settingsFile?:string, writeBrief?:Function, resolveDir?:Function,
 *   now?:()=>number}} deps  settingsFile / writeBrief / resolveDir / now: test seams
 */
function registerLunasworkIpc(deps) {
  const {
    ipcMain,
    projects,
    createSession,
    briefDir,
    controller,
    send,
    todos,
    runsRoot,
    openPath,
    ask,
    playtestPass,
    settingsFile,
    queue,
    queueChanged,
    confirmQueueAdd,
    checkCommandFor = (profile) => profile.checkCommand || '',
    writeBrief = defaultWriteBrief,
    resolveDir = resolveProjectDir,
    now = Date.now,
  } = deps;
  const read = () => (settingsFile ? settingsStore.readSettings(settingsFile) : settingsStore.readSettings());
  const write = (s) => (settingsFile ? settingsStore.writeSettings(s, settingsFile) : settingsStore.writeSettings(s));
  let lastInterviewAt = -Infinity;

  /** The known project a request names, or null. */
  function projectOf(req) {
    const id = projectIdOf(req);
    if (!id) return null;
    const list = projects();
    return (Array.isArray(list) && getProject(list, id)) || null;
  }

  /** The project's folder on this PC, or null when it does not exist here. */
  function repoOf(project) {
    const dir = project && typeof project.path === 'string' ? resolveDir(project.path) : null;
    return typeof dir === 'string' && path.isAbsolute(dir) ? dir : null;
  }

  function view(settings, projectId) {
    return {
      ok: true,
      projectId,
      roles: [...ROLES],
      choices: [...MODEL_CHOICES],
      models: settings.models,
      projectModels: settingsStore.normalizeModelOverride((settings.projects[keyFor(projectId)] || {}).models),
      freeFallback: settings.freeFallback,
      profile: settingsStore.profileFor(settings, projectId),
      ...settingsStore.togglesFor(settings, projectId),
    };
  }

  /** Runs a handler, turning any throw into a plain failure for the renderer. */
  const guarded = (name, fn) => (_event, req) => {
    try {
      return fn(req);
    } catch (err) {
      console.error(`[lunaswork] ${name} failed:`, err && err.message);
      return { ok: false, reason: 'failed' };
    }
  };

  ipcMain.handle('lunaswork:getSettings', guarded('getSettings', (req) => {
    const project = projectOf(req);
    if (!project) return { ok: false, reason: 'bad-project' };
    return view(read(), project.id);
  }));

  ipcMain.handle('lunaswork:saveSettings', guarded('saveSettings', (req) => {
    const project = projectOf(req);
    if (!project) return { ok: false, reason: 'bad-project' };
    let next = read();

    if (req.models !== undefined) {
      const models = parseModels(req.models);
      if (!models) return { ok: false, reason: 'bad-models' };
      next = { ...next, models: { ...next.models, ...models } };
    }
    if (req.projectModels !== undefined) {
      // "Save as this project's default" from the start dialog; null clears it.
      const models = req.projectModels === null ? {} : parseModels(req.projectModels);
      if (!models) return { ok: false, reason: 'bad-models' };
      next = settingsStore.withProject(next, project.id, { models }).settings;
    }
    if (req.freeFallback !== undefined) {
      if (typeof req.freeFallback !== 'boolean') return { ok: false, reason: 'bad-value' };
      next = { ...next, freeFallback: req.freeFallback };
    }
    // LW 2.25a / 2.25b: per-project toggles, booleans only.
    for (const toggle of settingsStore.TOGGLES) {
      if (req[toggle] === undefined) continue;
      const res = settingsStore.withProject(next, project.id, { [toggle]: req[toggle] });
      if (res.reason) return { ok: false, reason: 'bad-value' };
      next = res.settings;
    }
    if (req.profile !== undefined) {
      const raw = req.profile === null ? null : parseProfile(req.profile);
      if (req.profile !== null && !raw) {
        return { ok: false, reason: 'bad-profile', field: 'profile', detail: 'profile is malformed' };
      }
      const res = settingsStore.withProject(next, project.id, { profile: raw });
      if (res.reason) return { ok: false, reason: 'bad-profile', field: fieldOf(res.reason), detail: res.reason };
      next = res.settings;
    }

    if (!write(next)) return { ok: false, reason: 'write-failed' };
    return view(read(), project.id);
  }));

  ipcMain.handle('lunaswork:packStatus', guarded('packStatus', (req) => {
    const project = projectOf(req);
    if (!project) return { ok: false, reason: 'bad-project' };
    const repo = repoOf(project);
    if (!repo) return { ok: false, reason: 'no-folder' };
    return { ok: true, pack: pack.packCompleteness(repo) };
  }));

  ipcMain.handle('lunaswork:scaffoldPack', guarded('scaffoldPack', (req) => {
    const project = projectOf(req);
    if (!project) return { ok: false, reason: 'bad-project' };
    const repo = repoOf(project);
    if (!repo) return { ok: false, reason: 'no-folder' };
    const res = pack.scaffoldPack(repo);
    return { ...res, pack: pack.packCompleteness(repo) };
  }));

  ipcMain.handle('lunaswork:startInterview', guarded('startInterview', (req) => {
    const project = projectOf(req);
    if (!project) return { ok: false, reason: 'bad-project' };
    const repo = repoOf(project);
    if (!repo) return { ok: false, reason: 'no-folder' };
    const at = now();
    if (at - lastInterviewAt < INTERVIEW_GAP_MS) return { ok: false, reason: 'rate-limited' };

    const scaffold = pack.scaffoldPack(repo);
    if (!scaffold.ok) return { ok: false, reason: 'scaffold-failed' };
    // The id names a file: keep it to a safe slug whatever projects.json holds.
    const slug = project.id.replace(/[^A-Za-z0-9_-]/g, '_');
    const briefPath = path.join(briefDir(), `lunaswork-interview-${slug}.md`);
    if (!writeBrief(briefPath, pack.interviewBrief(repo))) return { ok: false, reason: 'brief-failed' };
    const session = createSession({ projectId: project.id, task: { briefPath } });
    if (!session) return { ok: false, reason: 'no-tab' };
    lastInterviewAt = at;
    return { ok: true, pack: pack.packCompleteness(repo) };
  }));

  if (queue) {
    registerQueueIpc({ ipcMain, queue, queueChanged, confirmQueueAdd, checkCommandFor, projectOf, repoOf, readSettings: read, guarded, now });
  }

  if (controller) {
    const isKnownProject = (id) => !!projectOf({ projectId: id });
    registerRunIpc({ ipcMain, controller, projectOf, isKnownProject, send, todos, runsRoot, openPath, playtestPass, now });
  }

  if (ask) registerAskIpc(ipcMain, ask);
}

/**
 * An "Ask Luna" request: exactly {question}, the question one line of
 * 1..MAX_QUESTION chars after trimming. Null when it is anything else.
 * @returns {{question:string}|null}
 */
function parseAskRequest(req) {
  if (!isObject(req)) return null;
  if (Object.keys(req).some((k) => k !== 'question')) return null;
  const question = cleanQuestion(req.question);
  return question ? { question } : null;
}

/**
 * LW 2.27: one question about the run, answered read-only by the ask service
 * (src/lunasworkAsk.js), which also holds the rate limit shared with the phone.
 */
function registerAskIpc(ipcMain, ask) {
  ipcMain.handle('lunaswork:ask', async (_event, req) => {
    try {
      const payload = parseAskRequest(req);
      if (!payload) return { ok: false, reason: 'bad-question' };
      const res = await ask.ask(payload.question, { from: 'hud' });
      if (!isObject(res)) return { ok: false, reason: 'failed' };
      if (res.ok) return { ok: true, item: res.item };
      return { ok: false, reason: typeof res.reason === 'string' ? res.reason : 'failed', ...(res.retryAt ? { retryAt: res.retryAt } : {}) };
    } catch (err) {
      console.error('[lunaswork] ask failed:', err && err.message);
      return { ok: false, reason: 'failed' };
    }
  });
}

/** start / stop / status / steer / evidence of a run (src/lunaswork.js), and its event push. */
function registerRunIpc({ ipcMain, controller, projectOf, isKnownProject, send, todos, runsRoot, openPath, playtestPass, now }) {
  // Whatever the controller answers, the renderer only sees the public status.
  const withPublicStatus = (res) =>
    isObject(res) && res.status !== undefined ? { ...res, status: publicStatus(res.status, isKnownProject) } : res;

  if (send && typeof controller.subscribe === 'function') {
    controller.subscribe((event) => {
      const out = publicEvent(event, isKnownProject);
      if (out) send('lunaswork:event', out);
    });
  }

  ipcMain.handle('lunaswork:start', async (_event, req) => {
    try {
      const project = projectOf(req);
      if (!project) return { ok: false, reason: 'bad-project' };
      let models;
      if (req.models !== undefined) {
        models = parseModels(req.models);
        if (!models) return { ok: false, reason: 'bad-models' };
      }
      return withPublicStatus(await controller.start({ projectId: project.id, ...(models ? { models } : {}) }));
    } catch (err) {
      console.error('[lunaswork] start failed:', err && err.message);
      return { ok: false, reason: 'failed' };
    }
  });

  // The kill switch takes no payload: there is one run at most.
  ipcMain.handle('lunaswork:stop', () => {
    try {
      return withPublicStatus(controller.stop());
    } catch (err) {
      console.error('[lunaswork] stop failed:', err && err.message);
      return { ok: false, reason: 'failed' };
    }
  });

  ipcMain.handle('lunaswork:status', () => {
    try {
      return { ok: true, status: publicStatus(controller.status(), isKnownProject) };
    } catch (err) {
      console.error('[lunaswork] status failed:', err && err.message);
      return { ok: false, reason: 'failed' };
    }
  });

  // "Hand me the wheel" (C11): pause after the iteration / hand back.
  for (const [channel, method] of [['lunaswork:handOver', 'handOver'], ['lunaswork:handBack', 'handBack']]) {
    if (typeof controller[method] !== 'function') continue;
    ipcMain.handle(channel, async (_event, req) => {
      try {
        const payload = parseWheelRequest(req);
        if (!payload) return { ok: false, reason: 'bad-run' };
        return withPublicStatus(await controller[method](payload));
      } catch (err) {
        console.error(`[lunaswork] ${method} failed:`, err && err.message);
        return { ok: false, reason: 'failed' };
      }
    });
  }

  if (todos) registerSteerIpc(ipcMain, projectOf, todos, now);

  if (runsRoot) registerDashboardIpc({ ipcMain, controller, isKnownProject, runsRoot });

  // Only the current run's evidence folder - or, asked for by name, the last
  // Playtester pass's - checked to sit in its own folder under the runs root.
  if (runsRoot && openPath) {
    const passEvidence = () => (playtestPass && typeof playtestPass.lastEvidence === 'function' ? playtestPass.lastEvidence() : null);
    ipcMain.handle('lunaswork:openEvidence', async (_event, req) => {
      try {
        const source = isObject(req) && req.what === 'playtestOnce' ? passEvidence() : controller.status();
        if (!isObject(source) || !isKnownProject(source.projectId)) return { ok: false, reason: 'no-evidence' };
        const dir = evidenceDirOf(source, runsRoot());
        if (!dir) return { ok: false, reason: 'no-evidence' };
        const error = await openPath(dir);
        return error ? { ok: false, reason: 'open-failed' } : { ok: true };
      } catch (err) {
        console.error('[lunaswork] openEvidence failed:', err && err.message);
        return { ok: false, reason: 'failed' };
      }
    });
  }
}

/**
 * The HUD dashboard (LW 2.17a): the run's view, and its screenshots one by
 * one. The renderer never names a path outside the run folder that gets read.
 */
function registerDashboardIpc({ ipcMain, controller, isKnownProject, runsRoot }) {
  const snapshot = () => (typeof controller.snapshot === 'function' ? controller.snapshot() : null);

  ipcMain.handle('lunaswork:dashboard', () => {
    try {
      // LW 2.22b: the time-to-SHIP estimate, when the runtime can make one.
      const shipEstimate = typeof controller.shipEstimate === 'function' ? controller.shipEstimate() : null;
      return { ok: true, dashboard: dashboardView(snapshot(), { runsRoot: runsRoot(), isKnownProject, shipEstimate }) };
    } catch (err) {
      console.error('[lunaswork] dashboard failed:', err && err.message);
      return { ok: false, reason: 'failed' };
    }
  });

  ipcMain.handle('lunaswork:screenshot', (_event, req) => {
    try {
      // Only the run the dashboard shows, of a registered project - never an older run's folder.
      const run = snapshot();
      const current = isObject(run) && isKnownProject(run.projectId) ? run.id : null;
      if (!current || !isObject(req) || req.runId !== current) return { ok: false, reason: 'bad-file' };
      const dataUrl = readScreenshot(req, runsRoot());
      return dataUrl ? { ok: true, dataUrl } : { ok: false, reason: 'bad-file' };
    } catch (err) {
      console.error('[lunaswork] screenshot failed:', err && err.message);
      return { ok: false, reason: 'failed' };
    }
  });
}

/**
 * The project queue (B16). Only main decides whether a project may join: the
 * renderer sends a project id, the folder, profile and pack are looked up here.
 */
function registerQueueIpc({ ipcMain, queue, queueChanged, confirmQueueAdd, checkCommandFor, projectOf, repoOf, readSettings, guarded, now }) {
  const isKnownProject = (id) => !!projectOf({ projectId: id });
  const listed = (q) => ({ ok: true, queue: queueStore.publicQueue(q, isKnownProject) });
  /** Writes an edit's result and tells the phone snapshot; the refusal reason otherwise. */
  const commit = ({ queue: next, reason }) => {
    if (reason) return { ok: false, reason };
    if (!queue.write(next)) return { ok: false, reason: 'write-failed' };
    if (typeof queueChanged === 'function') queueChanged();
    return listed(queue.read());
  };

  ipcMain.handle('lunaswork:queueList', guarded('queueList', () => listed(queue.read())));

  // One confirmation dialog at a time: a double click cannot stack another.
  let confirming = false;
  ipcMain.handle('lunaswork:queueAdd', async (_event, req) => {
    try {
      const parsed = parseQueueRequest(req);
      const project = parsed && projectOf(parsed);
      if (!project) return { ok: false, reason: 'bad-project' };
      const repoPath = repoOf(project);
      const profile = settingsStore.profileFor(readSettings(), project.id);
      const problem = queueStore.joinProblem({ project, repoPath, profile, pack: repoPath ? pack.packCompleteness(repoPath) : null });
      if (problem) return { ok: false, reason: problem };
      if (queue.read().entries.some((e) => e.projectId === project.id)) return { ok: false, reason: 'queued-already' };
      // The renderer can write a profile: only Mati's native yes pins it.
      if (typeof confirmQueueAdd !== 'function' || confirming) return { ok: false, reason: 'queue-busy' };
      const checkCommand = checkCommandFor(profile);
      confirming = true;
      let confirmed = false;
      try {
        confirmed = (await confirmQueueAdd({ projectId: project.id, repoPath, profile, checkCommand })) === true;
      } finally {
        confirming = false;
      }
      if (!confirmed) return { ok: false, reason: 'queue-declined' };
      return commit(queueStore.addEntry(queue.read(), { projectId: project.id, label: project.label, profile, checkCommand, addedAt: now() }));
    } catch (err) {
      console.error('[lunaswork] queueAdd failed:', err && err.message);
      return { ok: false, reason: 'failed' };
    }
  });

  ipcMain.handle('lunaswork:queueRemove', guarded('queueRemove', (req) => {
    const parsed = parseQueueRequest(req);
    if (!parsed) return { ok: false, reason: 'bad-project' };
    return commit(queueStore.removeEntry(queue.read(), parsed.projectId));
  }));

  ipcMain.handle('lunaswork:queueMove', guarded('queueMove', (req) => {
    const parsed = parseQueueRequest(req, { move: true });
    if (!parsed) return { ok: false, reason: 'bad-move' };
    return commit(queueStore.moveEntry(queue.read(), parsed.projectId, parsed.delta));
  }));
}

/**
 * Quick-adds Mati's `steer` card to a known project's to-do list. The text is
 * the only free input; the card's id, tags and state are set here.
 */
function registerSteerIpc(ipcMain, projectOf, todos, now) {
  ipcMain.handle('lunaswork:steer', (_event, req) => {
    try {
      const project = projectOf(req);
      if (!project) return { ok: false, reason: 'bad-project' };
      const text = parseSteerText(req.text);
      if (!text) return { ok: false, reason: 'bad-text' };
      const raw = todos.read(project.id);
      const list = Array.isArray(raw) ? raw : [];
      if (list.length >= MAX_TODO_ITEMS) return { ok: false, reason: 'list-full' };
      // `at` is the card id: never reuse one already on the list.
      const taken = new Set(list.map((c) => isObject(c) && c.at));
      let at = now();
      while (taken.has(at)) at += 1;
      if (!todos.write(project.id, [...list, { text, done: false, at, tags: [STEER_TAG] }])) {
        return { ok: false, reason: 'write-failed' };
      }
      todos.changed(project.id);
      return { ok: true };
    } catch (err) {
      console.error('[lunaswork] steer failed:', err && err.message);
      return { ok: false, reason: 'failed' };
    }
  });
}

module.exports = {
  registerLunasworkIpc,
  parseModels,
  parseProfile,
  parseSteerText,
  parseWheelRequest,
  parseAskRequest,
  parseQueueRequest,
  fieldOf,
  INTERVIEW_GAP_MS,
};
