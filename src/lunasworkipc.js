// ============================================================================
// LunaCore - Luna's Work IPC (main process, docs/LUNAS_WORK_PLAN.md slice 1.2c)
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
// lunaswork:handOver       {runId?} -> {ok, status} | {ok:false, reason, message?}
// lunaswork:handBack       {runId?} -> {ok, status} | {ok:false, reason, message?}
//                          "Hand me the wheel" (C11); runId, when sent, must
//                          be the current run's - a stale panel is refused
// lunaswork:dashboard      (no payload) -> {ok, dashboard} | {ok:false, reason}
//                          the current run for the HUD dashboard (LW 2.17a,
//                          lunasworkDashboardView.dashboardView); null without a run
// lunaswork:screenshot     {runId, file} -> {ok, dataUrl} | {ok:false, reason}
//                          one image ONLY from config/runs/lunaswork-<runId>/ of
//                          the current (or last) run: file is relative to it;
//                          `..`, absolute paths, streams, symlinks and hardlinks
//                          are refused (lunasworkDashboardView.readScreenshot)
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
const { STEER_TAG, MAX_ITEMS: MAX_TODO_ITEMS, MAX_TEXT_CHARS: MAX_STEER_CHARS } = require('./todorows');
const { RUN_ID_RE } = require('./lunasworkWheel');
const { dashboardView, readScreenshot } = require('./lunasworkDashboardView');

const MAX_ID_CHARS = 200;
// Opening a tab is a side effect a double click must not repeat.
const INTERVIEW_GAP_MS = 3000;
const PROFILE_FIELDS = ['adapter', 'startCommand', 'url', 'readyTimeoutSec', 'checkCommand'];
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
  const m = /^(adapter|startCommand|url|readyTimeoutSec|checkCommand)\b/.exec(String(reason || ''));
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
    settingsFile,
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

  if (controller) {
    const isKnownProject = (id) => !!projectOf({ projectId: id });
    registerRunIpc({ ipcMain, controller, projectOf, isKnownProject, send, todos, runsRoot, openPath, now });
  }
}

/** start / stop / status / steer / evidence of a run (src/lunaswork.js), and its event push. */
function registerRunIpc({ ipcMain, controller, projectOf, isKnownProject, send, todos, runsRoot, openPath, now }) {
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

  // Only the current run's evidence folder, checked to sit in its runs folder.
  if (runsRoot && openPath) {
    ipcMain.handle('lunaswork:openEvidence', async () => {
      try {
        const status = controller.status();
        if (!isObject(status) || !isKnownProject(status.projectId)) return { ok: false, reason: 'no-evidence' };
        const dir = evidenceDirOf(status, runsRoot());
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
      return { ok: true, dashboard: dashboardView(snapshot(), { runsRoot: runsRoot(), isKnownProject }) };
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
  fieldOf,
  INTERVIEW_GAP_MS,
};
