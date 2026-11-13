// ============================================================================
// LunaCore - memory window IPC: all memories, the scan, conflicts, the archive (main)
// ----------------------------------------------------------------------------
// The memory window's third list and the conflict entries of its inbox
// (renderer memorybrain.js):
//
//   memory:list     (project)        -> {ok, projects, project, items, total, scan}
//                                       one project's memories with their usefulness;
//                                       an unknown or empty project picks the first one
//   memory:scan     (project)        -> {ok, total} | {ok:false, reason: 'busy'|'bad-project'|'empty'}
//                                       starts the usefulness scan (src/memoryscan.js)
//   memory:conflict ({a, b, keep})   -> {ok, kept, superseded?} | {ok:false, reason}
//                                       settles a listed conflict (src/memoryconflict.js)
//   memory:restore  (key)            -> {ok, key} | {ok:false, reason}
//                                       brings an archived memory back (src/memorydecay.js)
//
// The renderer is untrusted: every payload is checked here, keys by
// splitKey() (never a path), a project by validProject(). A conflict can be
// settled only while it is listed, and only an archived memory can be restored.
// ============================================================================

'use strict';

const { validProject, splitKey, scoreOf } = require('./memoryrecord');
const { scan } = require('./memorystore');
const { supersededKeys } = require('./memoryreview');
const { resolveConflict, KEEP } = require('./memoryconflict');
const { restore } = require('./memorydecay');

const MAX_KEY_CHARS = 200;
const MAX_PROJECT_CHARS = 110;
/** Memories one listing returns; the total says how many the project has. */
const MAX_LIST_ITEMS = 300;
/** Characters of a body the list carries; the window shows a preview anyway. */
const LIST_BODY_CHARS = 600;

const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const errText = (err) => (err && (err.code || err.message)) || 'error';
const isoDate = (ms) => new Date(ms).toISOString().slice(0, 10);
const keyArg = (v) => (typeof v === 'string' && v.length <= MAX_KEY_CHARS && splitKey(v) ? v : null);
const projectArg = (v) => (typeof v === 'string' && v.length <= MAX_PROJECT_CHARS && validProject(v) ? v : null);

/** Active first, the most useful first (never scanned last), then the archive. */
function byUse(a, b) {
  if (Boolean(a.archived) !== Boolean(b.archived)) return a.archived ? 1 : -1;
  const ua = a.usefulness === null ? -1 : a.usefulness;
  const ub = b.usefulness === null ? -1 : b.usefulness;
  return ub - ua || a.title.localeCompare(b.title);
}

/**
 * One project's memories for the window. Superseded ones are history and stay out.
 * @param {[string, object][]} records
 * @param {string} project
 * @param {Set<string>} gone superseded keys
 */
function listItems(records, project, gone) {
  return records
    .filter(([key, r]) => r.project === project && !gone.has(key))
    .map(([key, r]) => ({
      key,
      id: r.id,
      type: r.type,
      title: r.title,
      body: r.body.length > LIST_BODY_CHARS ? `${r.body.slice(0, LIST_BODY_CHARS).trimEnd()} ...` : r.body,
      confidence: r.confidence,
      created: r.created,
      last_used: r.last_used || null,
      archived: r.archived || null,
      ...scoreOf(r),
    }))
    .sort(byUse);
}

/**
 * The projects that have memories here, those with memory switched on first.
 * @returns {{project: string, count: number, enabled: boolean}[]}
 */
function projectsOf(records, gone, enabled) {
  const counts = new Map();
  for (const [key, r] of records) if (!gone.has(key)) counts.set(r.project, (counts.get(r.project) || 0) + 1);
  return [...counts.entries()]
    .map(([project, count]) => ({ project, count, enabled: enabled.includes(project) }))
    .sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.project.localeCompare(b.project));
}

/**
 * @param {{ipcMain: object, dir: () => string, scanner: {start: Function, status: Function},
 *   enabled?: () => string[], onChanged?: () => void, now?: () => number, log?: {add: Function}|null}} deps
 *   scanner = memoryscan.createScanner(); enabled = projects with memory switched on;
 *   onChanged fires after a write (sync soon, repaint)
 */
function registerMemoryBrainIpc({ ipcMain, dir, scanner, enabled = () => [], onChanged = () => {}, now = Date.now, log = null }) {
  const guarded = (label, fn) => {
    try {
      const res = fn();
      if (res.ok) onChanged();
      return res;
    } catch (err) {
      console.error(`[memory] ${label} failed:`, errText(err));
      return { ok: false, reason: 'failed' };
    }
  };
  const enabledNow = () => {
    try {
      return enabled() || [];
    } catch (err) {
      console.error('[memory] enabled projects unavailable:', errText(err));
      return [];
    }
  };

  ipcMain.handle('memory:list', (_event, rawProject) => {
    try {
      const { records } = scan(dir());
      const gone = supersededKeys(records);
      const projects = projectsOf(records, gone, enabledNow());
      const wanted = projectArg(rawProject);
      const project = wanted && projects.some((p) => p.project === wanted) ? wanted : projects.length ? projects[0].project : null;
      const items = project ? listItems(records, project, gone) : [];
      return { ok: true, projects, project, items: items.slice(0, MAX_LIST_ITEMS), total: items.length, scan: scanner.status() };
    } catch (err) {
      console.error('[memory] list failed:', errText(err));
      return { ok: false, reason: 'failed' };
    }
  });

  ipcMain.handle('memory:scan', (_event, rawProject) => {
    const project = projectArg(rawProject);
    if (!project) return { ok: false, reason: 'bad-project' };
    try {
      return scanner.start(project);
    } catch (err) {
      console.error('[memory] scan failed to start:', errText(err));
      return { ok: false, reason: 'failed' };
    }
  });

  ipcMain.handle('memory:conflict', (_event, req) => {
    if (!isObject(req)) return { ok: false, reason: 'bad-request' };
    const a = keyArg(req.a);
    const b = keyArg(req.b);
    if (!a || !b) return { ok: false, reason: 'bad-key' };
    if (!KEEP.includes(req.keep)) return { ok: false, reason: 'bad-keep' };
    return guarded('conflict', () => resolveConflict(dir(), { a, b, keep: req.keep }, isoDate(now()), { log }));
  });

  ipcMain.handle('memory:restore', (_event, rawKey) => {
    const key = keyArg(rawKey);
    if (!key) return { ok: false, reason: 'bad-key' };
    return guarded('restore', () => restore(dir(), key, isoDate(now())));
  });
}

module.exports = { registerMemoryBrainIpc, listItems, MAX_LIST_ITEMS };
