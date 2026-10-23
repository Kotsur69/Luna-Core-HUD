// ============================================================================
// LunaCore - Luna's Work IPC (main process, docs/LUNAS_WORK_PLAN.md slice 1.2c)
// ----------------------------------------------------------------------------
// lunaswork:getSettings    {projectId} -> view
// lunaswork:saveSettings   {projectId, models?, freeFallback?, profile?} -> view
//                          | {ok:false, reason:'bad-profile', field, detail}
// lunaswork:scaffoldPack   {projectId} -> {ok, created, skipped, failed, pack}
// lunaswork:packStatus     {projectId} -> {ok, pack}
// lunaswork:startInterview {projectId} -> {ok, pack} | {ok:false, reason}
//
// view = {ok, projectId, roles, choices, models, freeFallback, profile}
// pack = {complete, missing, empty}
//
// The renderer only ever names a KNOWN project by id - never a folder, a
// file or a brief. Every payload is checked here: types, lengths, the role and
// model lists, and the profile through lunasworkSettings.validateProfile.
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

const MAX_ID_CHARS = 200;
// Opening a tab is a side effect a double click must not repeat.
const INTERVIEW_GAP_MS = 3000;
const PROFILE_FIELDS = ['adapter', 'startCommand', 'url', 'readyTimeoutSec', 'checkCommand'];
const MAX_PROFILE_STRING = settingsStore.MAX_COMMAND_CHARS;

const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

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
 *   briefDir:()=>string, settingsFile?:string, writeBrief?:Function, resolveDir?:Function,
 *   now?:()=>number}} deps  settingsFile / writeBrief / resolveDir / now: test seams
 */
function registerLunasworkIpc(deps) {
  const {
    ipcMain,
    projects,
    createSession,
    briefDir,
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
      freeFallback: settings.freeFallback,
      profile: settingsStore.profileFor(settings, projectId),
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
    if (req.freeFallback !== undefined) {
      if (typeof req.freeFallback !== 'boolean') return { ok: false, reason: 'bad-value' };
      next = { ...next, freeFallback: req.freeFallback };
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
}

module.exports = {
  registerLunasworkIpc,
  parseModels,
  parseProfile,
  fieldOf,
  INTERVIEW_GAP_MS,
};
