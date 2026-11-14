// ============================================================================
// LunaCore - memory window IPC: all memories, the scan, conflicts, the archive (main)
// ----------------------------------------------------------------------------
// The memory window's third list and the conflict entries of its inbox
// (renderer memorybrain.js):
//
//   memory:list     (project)        -> {ok, projects, project, items, total, scan, health}
//                                       one project's memories with their usefulness and
//                                       final score (memoryrecord.finalScore), highest first;
//                                       health = projectHealth() of that project, or null;
//                                       an unknown or empty project picks the first one
//   memory:scan     (project)        -> {ok, total} | {ok:false, reason: 'busy'|'bad-project'|'empty'}
//                                       starts the usefulness scan (src/memoryscan.js)
//   memory:conflict ({a, b, keep})   -> {ok, kept, superseded?} | {ok:false, reason}
//                                       settles a listed conflict (src/memoryconflict.js)
//   memory:restore  (key)            -> {ok, key} | {ok:false, reason}
//                                       brings an archived memory back (src/memorydecay.js)
//   memory:merge    ({a, b, title, body}) -> {ok, key, superseded} | {ok:false, reason}
//                                       merges a listed pair into one new confirmed memory
//                                       (src/memoryconflict.js mergePair)
//   memory:provenance (key)          -> {ok, ...} | {ok:false, reason}   read only: the History
//                                       expander (src/memoryprovenance.js); the timeline is this PC's log
//
// The renderer is untrusted: every payload is checked here, keys by
// splitKey() (never a path), a project by validProject(). A conflict or a
// merge suggestion can be settled only while it is listed, and only an
// archived memory can be restored.
// ============================================================================

'use strict';

const { validProject, splitKey, scoreOf, finalScore, byFinalScore, DATE_RE, MAX_TITLE, MAX_BODY } = require('./memoryrecord');
const { scan } = require('./memorystore');
const { supersededKeys, reviewList } = require('./memoryreview');
const { resolveConflict, findConflicts, mergePair, KEEP } = require('./memoryconflict');
const { provenance } = require('./memoryprovenance');
const { restore } = require('./memorydecay');
const { recentUsage } = require('./memoryuse');

const MAX_KEY_CHARS = 200;
/** Merge text longer than this is refused before it is read; checkRecord applies the real limits. */
const MERGE_LIMITS = Object.freeze({ title: MAX_TITLE * 2, body: MAX_BODY * 2 });
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

/** Active first; the highest final score first (unrated last), then the most useful, then the newest; the archive last. */
function byUse(a, b) {
  if (Boolean(a.archived) !== Boolean(b.archived)) return a.archived ? 1 : -1;
  return byFinalScore(a, b) || b.created.localeCompare(a.created) || a.title.localeCompare(b.title);
}

const NO_USAGE = Object.freeze({ reads: new Map(), today: null });

/**
 * One project's memories for the window. Superseded ones are history and stay out.
 * @param {[string, object][]} records
 * @param {string} project
 * @param {Set<string>} gone superseded keys
 * @param {{reads: Map<string, number>, today: string|null}} [usage] memoryuse.recentUsage(): the reads the final score counts
 */
function listItems(records, project, gone, usage = NO_USAGE) {
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
      // Computed, never stored: {score: 0-100|null, parts: {usefulness, confidence, usage}}.
      final: finalScore(r, { reads: usage.reads.get(key) || 0, today: usage.today }),
    }))
    .sort(byUse);
}

// --- memory health of one project -------------------------------------------------
// Not src/memoryhealth.js: that one says whether every PC still syncs. This
// says how well kept one project's memories are.

/** Weights of the health parts, in percent; they add up to 100. */
const HEALTH_WEIGHT_PCT = Object.freeze({ scored: 25, quality: 30, conflicts: 15, review: 15, backlog: 10, archived: 5 });
/** An inbox entry that has waited longer than this is backlog. */
const BACKLOG_DAYS = 7;
/** The review flags that count against health; "never opened" is only a hint (memoryreview.js LOW_FLAGS). */
const HEALTH_REVIEW_FLAGS = Object.freeze(['stale', 'anchor', 'disputed']);
const DAY_MS = 24 * 60 * 60 * 1000;

const isDay = (v) => typeof v === 'string' && DATE_RE.test(v);
const daysBetween = (from, to) => Math.floor((Date.parse(to) - Date.parse(from)) / DAY_MS);
/** 100 when nothing is wrong, 0 when `bad` covers every memory counted. */
const cleanShare = (bad, of) => 100 * (1 - Math.min(1, bad / Math.max(1, of)));

/**
 * How well kept one project's memories are. Pure.
 * @param {object[]} items the project's memories as listItems() lists them (with `final`)
 * @param {{flags: {kind: string}[]}[]} review the project's entries of the review list (memoryreview.reviewList items)
 * @param {{a: string, b: string}[]} conflicts the project's open conflicts (memoryconflict.findConflicts)
 * @param {{today?: string|null}} [opts] today = YYYY-MM-DD, for the inbox backlog; none = no backlog counted
 * @returns {{score: number|null, parts: object|null}} null for a project without memories. parts =
 *   {total, unscored, average, conflicts, review, backlog, backlogDays, archived}: counts, and the
 *   average final score of the rated memories (null when none is rated)
 */
function projectHealth(items, review, conflicts, { today = null } = {}) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return { score: null, parts: null };
  const active = list.filter((i) => !i.archived);
  const rated = active.filter((i) => Number.isInteger(i.usefulness));
  const finals = active.map((i) => i.final && i.final.score).filter(Number.isInteger);
  const average = finals.length ? Math.round(finals.reduce((sum, n) => sum + n, 0) / finals.length) : null;
  const pairs = Array.isArray(conflicts) ? conflicts : [];
  const inConflict = new Set(pairs.flatMap((p) => [p.a, p.b])).size;
  const flagged = (Array.isArray(review) ? review : []).filter((r) => Array.isArray(r.flags) && r.flags.some((f) => HEALTH_REVIEW_FLAGS.includes(f.kind))).length;
  const backlog = isDay(today) ? active.filter((i) => i.confidence !== 'confirmed' && isDay(i.created) && daysBetween(i.created, today) > BACKLOG_DAYS).length : 0;
  const archived = list.length - active.length;
  const points = {
    scored: active.length ? (100 * rated.length) / active.length : 0,
    quality: average === null ? 0 : average,
    conflicts: cleanShare(inConflict, active.length),
    review: cleanShare(flagged, active.length),
    backlog: cleanShare(backlog, active.length),
    archived: cleanShare(archived, list.length),
  };
  const weighted = Object.entries(HEALTH_WEIGHT_PCT).reduce((sum, [part, weight]) => sum + weight * points[part], 0) / 100;
  return {
    score: Math.min(100, Math.max(0, Math.round(weighted))),
    parts: { total: list.length, unscored: active.length - rated.length, average, conflicts: pairs.length, review: flagged, backlog, backlogDays: BACKLOG_DAYS, archived },
  };
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
 *   enabled?: () => string[], onChanged?: () => void, now?: () => number,
 *   log?: {add: Function, read?: Function}|null, roots?: () => object}} deps
 *   scanner = memoryscan.createScanner(); enabled = projects with memory switched on;
 *   onChanged fires after a write (sync soon, repaint); log.read = this PC's memory log
 *   (reads for the final score, disputes for the health line); roots = {<project>: its
 *   folder on this PC}, for the anchor check of the health line
 */
function registerMemoryBrainIpc({ ipcMain, dir, scanner, enabled = () => [], onChanged = () => {}, now = Date.now, log = null, roots = () => ({}) }) {
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

  /** This PC's memory log; without one, or when it fails, no reads and no disputes count. */
  const events = () => {
    if (!log || typeof log.read !== 'function') return [];
    try {
      return log.read() || [];
    } catch (err) {
      console.error('[memory] memory log unavailable:', errText(err));
      return [];
    }
  };
  const knownRoots = () => {
    try {
      return roots() || {};
    } catch (err) {
      console.error('[memory] project folders unavailable:', errText(err));
      return {};
    }
  };
  /** One project's health line (projectHealth); null when it cannot be worked out: it never hides the list. */
  const healthOf = (records, project, items, evs) => {
    try {
      const today = isoDate(now());
      const own = records.filter(([, r]) => r.project === project);
      const review = reviewList({ records: own, today, events: evs, roots: knownRoots() }).items;
      const pairs = findConflicts(records).filter((p) => (splitKey(p.a) || {}).project === project);
      return projectHealth(items, review, pairs, { today });
    } catch (err) {
      console.error('[memory] health failed:', errText(err));
      return null;
    }
  };

  ipcMain.handle('memory:list', (_event, rawProject) => {
    try {
      const { records } = scan(dir());
      const gone = supersededKeys(records);
      const projects = projectsOf(records, gone, enabledNow());
      const wanted = projectArg(rawProject);
      const project = wanted && projects.some((p) => p.project === wanted) ? wanted : projects.length ? projects[0].project : null;
      const evs = events();
      const items = project ? listItems(records, project, gone, recentUsage(evs, now())) : [];
      const health = project ? healthOf(records, project, items, evs) : null;
      return { ok: true, projects, project, items: items.slice(0, MAX_LIST_ITEMS), total: items.length, scan: scanner.status(), health };
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

  ipcMain.handle('memory:merge', (_event, req) => {
    if (!isObject(req)) return { ok: false, reason: 'bad-request' };
    const a = keyArg(req.a);
    const b = keyArg(req.b);
    if (!a || !b) return { ok: false, reason: 'bad-key' };
    const text = (field) => (typeof req[field] === 'string' && req[field].length <= MERGE_LIMITS[field] ? req[field] : null);
    const title = text('title');
    const body = text('body');
    if (title === null || body === null) return { ok: false, reason: 'bad-edits' };
    return guarded('merge', () => mergePair(dir(), { a, b, title, body }, isoDate(now()), { log }));
  });

  // Read only: no onChanged, nothing is written.
  ipcMain.handle('memory:provenance', (_event, rawKey) => {
    const key = keyArg(rawKey);
    if (!key) return { ok: false, reason: 'bad-key' };
    try {
      return provenance(scan(dir()).records, events(), key);
    } catch (err) {
      console.error('[memory] provenance failed:', errText(err));
      return { ok: false, reason: 'failed' };
    }
  });
}

module.exports = { registerMemoryBrainIpc, listItems, projectHealth, HEALTH_WEIGHT_PCT, BACKLOG_DAYS, MAX_LIST_ITEMS };
