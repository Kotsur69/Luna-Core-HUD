// ============================================================================
// LunaCore - the Sleep Pass: weekly memory consolidation of one project (main)
// ----------------------------------------------------------------------------
// A project's memories grow past what its card (6,000 characters,
// memorycard.MAX_CARD_CHARS) can show. The Sleep Pass keeps them crisp:
//
//   1. clustering (here, no model): the project's confirmed, active memories
//      are grouped by `area` and by the cached Qwen3 cosine of their vectors
//      (>= CLUSTER_COSINE, memoryembed.cosine); without vectors by area plus
//      word overlap (memoryextract.jaccard >= CLUSTER_JACCARD).
//   2. ONE bounded Sonnet call through the memory check's path
//      (missionrunner.runJob, lean; read-only tools in the project's folder
//      only when the architecture map is refreshed, no tools otherwise). It holds the shared model-job
//      lock (memoryscan.createJobLock): the scan, the check and this never run
//      at once. The answer (src/memoryconsolidateanswer.js) may hold:
//        merges        2-4 overlapping memories of one cluster -> one canonical
//                      `observed` inbox entry with `supersedes: [...]`
//        expiry        a task-bound memory -> an `observed` copy that carries
//                      expires_after_days / expires_when and supersedes it
//        retire        a stale memory -> one `disputed` line of the memory log,
//                      by 'consolidate': it goes on the review list
//        architecture  when the architecture-map memory is older than a
//                      change of a top-level src/ file (memorychanges): an
//                      updated map as an `observed` entry superseding it
//   NOTHING CONFIRMED IS EVER EDITED OR DELETED HERE (decision 5): every
//   proposal waits in the inbox, and only Mati's approval makes `supersedes`
//   take effect (memoryreview.supersededKeys counts confirmed records only).
//   3. the weekly schedule: opt-in per project (default off, this PC's own
//      settings file, never synced), at most once per WEEK_MS per project.
//      main.js only starts and stops the timer.
// ============================================================================

'use strict';

const fs = require('fs');
const path = require('path');
const { validProject } = require('./memoryrecord');
const { scan } = require('./memorystore');
const { supersededKeys, checkedOn } = require('./memoryreview');
const { createJobLock } = require('./memoryscan');
const { folderOf } = require('./memorycheck');
const { cosine, sharedVectorStore, vectorLookup } = require('./memoryembed');
const { wordsOf, jaccard } = require('./memoryextract');
const { readChanges } = require('./memorychanges');
const { readDoc, writeAtomic } = require('./projectsync');
const { buildConsolidatePrompt, parseConsolidateAnswer, applyConsolidation, pendingSupersedes } = require('./memoryconsolidateanswer');

const CONSOLIDATE_MODEL = 'sonnet';
/** One call reading a few clusters, maybe a few source files for the architecture map. */
const CONSOLIDATE_TIMEOUT_MS = 8 * 60 * 1000;
/** Two memories of one area whose vectors are at least this close belong to one cluster. */
const CLUSTER_COSINE = 0.7;
/** Without vectors: the share of words two memories of one area must have in common. */
const CLUSTER_JACCARD = 0.3;
/** Bounds of what one call reads. */
const MAX_TARGETS = 400;
const MAX_CLUSTERS = 10;
const MAX_CLUSTER_SIZE = 6;
const MAX_SRC_FILES = 300;
/** A src/ file name that goes into the prompt as it is: no line breaks, no prompt markers, no leading dash. */
const SRC_NAME_RE = /^[\w@+][\w.@+-]*$/;
/** The memory the architecture refresh looks for first; any `area: architecture` memory otherwise. */
const ARCHITECTURE_ID = 'architecture-map';
const ARCHITECTURE_AREA = 'architecture';
const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;
/** How often the weekly timer looks, and how long after launch it looks first. */
const SCHEDULE_EVERY_MS = 60 * 60 * 1000;
const SCHEDULE_FIRST_MS = 10 * 60 * 1000;
const MAX_WEEKLY_PROJECTS = 200;
/** This job's name on the shared lock (memoryscan.createJobLock). */
const LOCK_NAME = 'consolidate';

const errText = (err) => (err && (err.code || err.message)) || 'error';
const isoDate = (ms) => new Date(ms).toISOString().slice(0, 10);
const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

// --- clustering (pure) ----------------------------------------------------------------

/** The memories a Sleep Pass of `project` reads: confirmed, not archived, not superseded. */
function consolidateTargets(records, project) {
  const gone = supersededKeys(records);
  return records
    .filter(([key, r]) => r.project === project && r.confidence === 'confirmed' && !r.archived && !gone.has(key))
    .map(([, r]) => r)
    .sort((a, b) => a.id.localeCompare(b.id))
    .slice(0, MAX_TARGETS);
}

/** A vector lookup that never throws: a failing store counts as "no vector". */
function safeLookup(vectorOf) {
  if (typeof vectorOf !== 'function') return () => null;
  return (record) => {
    try {
      return vectorOf(record) || null;
    } catch (err) {
      console.error('[memory] consolidate: vector lookup failed:', errText(err));
      return null;
    }
  };
}

/**
 * Clusters of related memories: same `area` (memories without one share the
 * empty area), and cosine >= CLUSTER_COSINE when both have a vector, word
 * overlap >= CLUSTER_JACCARD otherwise. Connected groups of 2 or more, the
 * biggest first, at most MAX_CLUSTERS of at most MAX_CLUSTER_SIZE members.
 * @param {object[]} targets consolidateTargets()
 * @param {((record: object) => ArrayLike<number>|undefined)|null} [vectorOf]
 * @returns {{area: string, members: object[]}[]}
 */
function clusterMemories(targets, vectorOf = null) {
  const vector = safeLookup(vectorOf);
  const words = new Map(targets.map((r) => [r, wordsOf(`${r.title} ${r.body}`)]));
  const vectors = new Map(targets.map((r) => [r, vector(r)]));
  const close = (a, b) => {
    const cos = cosine(vectors.get(a), vectors.get(b));
    return cos === null ? jaccard(words.get(a), words.get(b)) >= CLUSTER_JACCARD : cos >= CLUSTER_COSINE;
  };
  const parent = new Map(targets.map((r) => [r, r]));
  const root = (r) => {
    let x = r;
    while (parent.get(x) !== x) x = parent.get(x);
    return x;
  };
  const byArea = new Map();
  for (const r of targets) byArea.set(r.area || '', [...(byArea.get(r.area || '') || []), r]);
  for (const group of byArea.values()) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) if (close(group[i], group[j])) parent.set(root(group[j]), root(group[i]));
    }
  }
  const components = new Map();
  for (const r of targets) components.set(root(r), [...(components.get(root(r)) || []), r]);
  return [...components.values()]
    .filter((members) => members.length >= 2)
    .map((members) => ({ area: members[0].area || '', members: members.slice(0, MAX_CLUSTER_SIZE) }))
    .sort((a, b) => b.members.length - a.members.length || a.area.localeCompare(b.area) || a.members[0].id.localeCompare(b.members[0].id))
    .slice(0, MAX_CLUSTERS);
}

/** The project's architecture map: the `architecture-map` memory, else the freshest `area: architecture` one; or null. */
function architectureOf(targets) {
  const named = targets.find((r) => r.id === ARCHITECTURE_ID);
  if (named) return named;
  const tagged = targets.filter((r) => r.area === ARCHITECTURE_AREA).sort((a, b) => checkedOn(b).localeCompare(checkedOn(a)));
  return tagged[0] || null;
}

/**
 * The top-level files of `src/` with a commit after `since` (memorychanges.readChanges).
 * Never rejects: no src folder, no git or a failed call is "nothing changed".
 * @param {{root: string, since: string, exec?: Function}} opts since = YYYY-MM-DD
 * @returns {Promise<string[]>} repository-relative paths, sorted
 */
async function srcChangesSince({ root, since, exec }) {
  let files;
  try {
    files = fs
      .readdirSync(path.join(root, 'src'), { withFileTypes: true })
      .filter((d) => d.isFile() && SRC_NAME_RE.test(d.name))
      .map((d) => `src/${d.name}`)
      .sort()
      .slice(0, MAX_SRC_FILES);
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('[memory] consolidate: src folder unreadable:', errText(err));
    return [];
  }
  if (!files.length) return [];
  const res = await readChanges({ root, since, paths: files }, exec ? { exec } : {});
  if (!res.ok) {
    console.error('[memory] consolidate: git log failed:', res.reason);
    return [];
  }
  // A commit on the day it was verified may predate the check: only later days count.
  return [...res.changes].filter(([, at]) => at.slice(0, 10) > since).map(([file]) => file).sort();
}

// --- settings: the weekly opt-in and the last runs (this PC only) ---------------------------

const NO_SETTINGS = Object.freeze({ weekly: [], lastRun: {} });

/** The settings file, rebuilt; a missing or broken file is "nothing opted in". */
function readSettings(file) {
  if (typeof file !== 'string' || !file) return NO_SETTINGS;
  let doc;
  try {
    doc = readDoc(file);
  } catch (err) {
    console.error('[memory] consolidate settings unreadable, weekly off:', errText(err));
    return NO_SETTINGS;
  }
  if (!isObject(doc)) return NO_SETTINGS;
  const weekly = [...new Set(Array.isArray(doc.weekly) ? doc.weekly.filter((p) => validProject(p)) : [])].slice(0, MAX_WEEKLY_PROJECTS);
  const lastRun = {};
  if (isObject(doc.lastRun)) {
    for (const [project, at] of Object.entries(doc.lastRun)) if (validProject(project) && Number.isFinite(at) && at > 0) lastRun[project] = at;
  }
  return { weekly, lastRun };
}

function writeSettings(file, settings) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeAtomic(file, `${JSON.stringify(settings)}\n`);
}

/** Whether a weekly pass is due: never run, run WEEK_MS ago or more, or a last run in the future (a bad clock). */
function weeklyDue(lastRun, nowMs) {
  if (!Number.isFinite(lastRun)) return true;
  return nowMs < lastRun || nowMs - lastRun >= WEEK_MS;
}

// --- the runner ----------------------------------------------------------------------------

const IDLE = Object.freeze({
  running: false,
  project: null,
  trigger: null,
  clusters: 0,
  merges: 0,
  expiries: 0,
  retirements: 0,
  architecture: false,
  skipped: 0,
  error: null,
  startedAt: null,
  finishedAt: null,
});

/**
 * @param {{dir: () => string, run: (job: {prompt: string, cwd: string|null}) => Promise<object>,
 *   roots?: () => object, log?: {add: Function, read: Function}|null, lock?: object, now?: () => number,
 *   vectors?: () => object|null, srcChanges?: (opts: {root: string, since: string}) => Promise<string[]>,
 *   settingsFile?: () => string|null, onProgress?: (status: object) => void, onWritten?: () => void}} deps
 *   run = the model call (missionrunner.runJob, lean; read-only tools in cwd when cwd is a folder);
 *   lock = memoryscan.createJobLock(), shared with the scan and the check; vectors = the vector store
 *   (memoryembed); settingsFile = memoryPaths().consolidate, null = the weekly switch is off and refused
 * @returns {object}
 */
function createConsolidator({
  dir,
  run,
  roots = () => ({}),
  log = null,
  lock = createJobLock(),
  now = Date.now,
  vectors = sharedVectorStore,
  srcChanges = srcChangesSince,
  settingsFile = () => null,
  onProgress = () => {},
  onWritten = () => {},
}) {
  let state = { ...IDLE };
  let current = null;
  const status = () => ({ ...state });
  const notify = (fn, ...args) => {
    try {
      fn(...args);
    } catch (err) {
      console.error('[memory] consolidate listener failed:', errText(err));
    }
  };
  const update = (patch) => {
    state = { ...state, ...patch };
    notify(onProgress, status());
  };
  const file = () => {
    try {
      return settingsFile() || null;
    } catch (err) {
      console.error('[memory] consolidate settings path unavailable:', errText(err));
      return null;
    }
  };
  const settings = () => readSettings(file());
  const vectorOf = () => {
    try {
      return vectorLookup(vectors());
    } catch (err) {
      console.error('[memory] consolidate: vector store unavailable:', errText(err));
      return null;
    }
  };

  function noteRun(project, at) {
    const target = file();
    if (!target) return;
    try {
      const s = settings();
      writeSettings(target, { ...s, lastRun: { ...s.lastRun, [project]: at } });
    } catch (err) {
      console.error('[memory] consolidate: last run not saved:', errText(err));
    }
  }

  async function runOnce(project) {
    const records = scan(dir()).records;
    // A memory a waiting proposal already supersedes is Mati's to decide: asking again costs a call for nothing.
    const waiting = pendingSupersedes(records, project);
    const targets = consolidateTargets(records, project).filter((r) => !waiting.has(r.id));
    if (!targets.length) return { ok: true, merges: 0, expiries: 0, retirements: 0, architecture: false, skipped: 0 };
    const folder = folderOf(roots, project);
    const arch = architectureOf(targets);
    // The map is refreshed on its own, never merged into another memory.
    const clusters = clusterMemories(targets.filter((r) => r !== arch), vectorOf());
    const changed = arch && folder ? await srcChanges({ root: folder, since: checkedOn(arch) }) : [];
    const architecture = arch && changed.length ? { record: arch, changed } : null;
    update({ clusters: clusters.length });
    const today = isoDate(now());
    const prompt = buildConsolidatePrompt({ project, today, targets, clusters, architecture });
    // Read tools only for the architecture refresh, the one part that needs the code: merges,
    // expiry and retirement work from the memories alone, with no access to the project's files.
    const res = await run({ prompt: prompt.text, cwd: architecture ? folder : null });
    if (!res || !res.ok) return { ok: false, reason: `model-${(res && res.reason) || 'failed'}` };
    const parsed = parseConsolidateAnswer(res.answer, prompt.ids);
    if (!parsed.ok) return parsed;
    return applyConsolidation({ dir: dir(), project, today, parsed, log, architectureId: architecture ? arch.id : null });
  }

  /**
   * @param {string} project
   * @param {{trigger?: 'manual'|'weekly'}} [opts]
   * @returns {{ok: true}|{ok: false, reason: 'busy'|'bad-project'|'empty'}}
   */
  function start(project, { trigger = 'manual' } = {}) {
    if (state.running) return { ok: false, reason: 'busy' };
    if (!validProject(project)) return { ok: false, reason: 'bad-project' };
    if (!consolidateTargets(scan(dir()).records, project).length) return { ok: false, reason: 'empty' };
    // The usefulness scan or the memory check may hold the model: one job at a time.
    if (!lock.take(LOCK_NAME)) return { ok: false, reason: 'busy' };
    const at = now();
    noteRun(project, at);
    update({ ...IDLE, running: true, project, trigger: trigger === 'weekly' ? 'weekly' : 'manual', startedAt: at });
    current = runOnce(project)
      .catch((err) => {
        console.error('[memory] consolidate failed:', errText(err));
        return { ok: false, reason: 'failed' };
      })
      .then((res) => {
        if (!res.ok) {
          console.error('[memory] consolidate ended without proposals:', res.reason);
          update({ error: res.reason });
          return;
        }
        update({ merges: res.merges, expiries: res.expiries, retirements: res.retirements, architecture: res.architecture, skipped: res.skipped });
        if (res.merges || res.expiries || res.retirements || res.architecture) notify(onWritten);
      })
      .catch((err) => console.error('[memory] consolidate status failed:', errText(err)))
      .finally(() => {
        current = null;
        lock.release(LOCK_NAME);
        update({ running: false, finishedAt: now() });
      });
    return { ok: true };
  }

  /** @returns {{ok: true, weekly: boolean}|{ok: false, reason: 'bad-request'|'failed'}} */
  function setWeekly(project, on) {
    if (!validProject(project) || typeof on !== 'boolean') return { ok: false, reason: 'bad-request' };
    const target = file();
    if (!target) return { ok: false, reason: 'failed' };
    const s = settings();
    const weekly = on ? [...new Set([...s.weekly, project])].slice(0, MAX_WEEKLY_PROJECTS) : s.weekly.filter((p) => p !== project);
    writeSettings(target, { ...s, weekly });
    return { ok: true, weekly: weekly.includes(project) };
  }

  function lastRunOf(project) {
    const { lastRun } = settings();
    return Object.hasOwn(lastRun, project) ? lastRun[project] : null;
  }

  return {
    start,
    status,
    setWeekly,
    lastRunOf,
    /** Whether any model job on the memory (this, the scan or the check) holds the shared lock. */
    busy: () => lock.holder() !== null,
    weeklyOf: (project) => settings().weekly.includes(project),
    weeklyProjects: () => settings().weekly,
    whenIdle: () => current || Promise.resolve(),
  };
}

/**
 * The weekly timer: every SCHEDULE_EVERY_MS it starts the pass of the first
 * opted-in project that is due (weeklyDue). One at a time: a busy model lock
 * waits for the next tick. Nothing runs for a project that did not opt in.
 * @param {{consolidator: object, now?: () => number, everyMs?: number, firstMs?: number}} deps
 * @returns {{start: () => void, stop: () => void, tick: () => {started: string|null, reason?: string}}}
 */
function createConsolidationSchedule({ consolidator, now = Date.now, everyMs = SCHEDULE_EVERY_MS, firstMs = SCHEDULE_FIRST_MS }) {
  let first = null;
  let timer = null;

  function tick() {
    try {
      const due = consolidator.weeklyProjects().filter((p) => weeklyDue(consolidator.lastRunOf(p), now()));
      if (!due.length) return { started: null };
      if (consolidator.busy()) return { started: null, reason: 'busy' };
      for (const project of due) {
        const res = consolidator.start(project, { trigger: 'weekly' });
        if (res.ok) return { started: project };
        if (res.reason === 'busy') return { started: null, reason: 'busy' };
      }
      return { started: null };
    } catch (err) {
      console.error('[memory] weekly consolidation failed:', errText(err));
      return { started: null, reason: 'failed' };
    }
  }

  return {
    start() {
      if (first || timer) return;
      first = setTimeout(() => {
        first = null;
        tick();
        timer = setInterval(tick, everyMs);
        if (timer.unref) timer.unref();
      }, firstMs);
      if (first.unref) first.unref();
    },
    stop() {
      if (first) clearTimeout(first);
      if (timer) clearInterval(timer);
      first = null;
      timer = null;
    },
    tick,
  };
}

module.exports = {
  createConsolidator,
  createConsolidationSchedule,
  consolidateTargets,
  clusterMemories,
  architectureOf,
  srcChangesSince,
  readSettings,
  weeklyDue,
  CONSOLIDATE_MODEL,
  CONSOLIDATE_TIMEOUT_MS,
  CLUSTER_COSINE,
  CLUSTER_JACCARD,
  MAX_CLUSTERS,
  MAX_CLUSTER_SIZE,
  ARCHITECTURE_ID,
  WEEK_MS,
};
