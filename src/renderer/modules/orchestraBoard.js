// ============================================================================
// LunaCore - God Mode board state: every project's run (A4)
// ----------------------------------------------------------------------------
// Holds the orchestra:list entries, the full view per project (runs Map) and
// boardProjectId - the project the board shows and every board action is
// about. orchestra.js reads the board's view from here; planning still goes
// by the active tab, whose project this also tracks (sessions:list).
// The chip / default rules are pure (orchestraRuns.js).
//
// refresh() awaits several IPC calls. An orchestra:changed (apply) or a chip
// click (select) that lands meanwhile is newer than what the fetch returns,
// so it wins over it.
// ============================================================================

'use strict';

import { summarize, entryFromView, upsertEntry, keepBoardProject, runKey } from './orchestraRuns.js';

/** orchestra:list entries, in main's order. */
let entries = [];
/** projectId (string|null) -> full run view. */
let runs = new Map();
/** The board's project; undefined until the first refresh. */
let boardProjectId;
/** The active tab's project (registry key). */
let activeProjectId = null;
/** projectId -> label, for the active project's chip before it has a run. */
const labels = new Map();
/** Projects applied while a refresh was in flight (their fetched view is older). */
let appliedDuring = null;
/** Bumped by select(): a refresh in flight then leaves the board's project alone. */
let selectSeq = 0;

const api = () => window.lunacore;

async function readActiveProject() {
  try {
    const res = await api().getSessions();
    const list = res && Array.isArray(res.sessions) ? res.sessions : [];
    const active = list.find((s) => s && s.id === res.activeSessionId);
    return active ? runKey(active.projectId) : null;
  } catch {
    return activeProjectId;
  }
}

async function readLabels() {
  try {
    const res = await api().getProjects();
    for (const p of res && Array.isArray(res.projects) ? res.projects : []) {
      if (p && typeof p.id === 'string') labels.set(p.id, typeof p.label === 'string' && p.label ? p.label : p.id);
    }
  } catch {
    // Labels are cosmetic: the chip falls back to the project id.
  }
}

async function readView(projectId) {
  try {
    return await api().getOrchestra(projectId);
  } catch {
    return null;
  }
}

async function readList() {
  try {
    const res = await api().listOrchestra();
    return Array.isArray(res) ? res : [];
  } catch {
    return [];
  }
}

const labelOf = (key) => {
  const known = entries.find((e) => runKey(e.projectId) === key);
  return (known && known.label) || labels.get(key) || null;
};

/** The fetched runs, with what apply() changed meanwhile kept over them. */
function mergeFetched(list, listed, views, touched) {
  const next = new Map();
  listed.forEach((c, i) => {
    if (views[i] && !touched.has(c.projectId)) next.set(c.projectId, views[i]);
  });
  for (const key of touched) if (runs.has(key)) next.set(key, runs.get(key));
  // main's order; a touched run's entry is rebuilt from its newer view.
  const fresh = (key) => entryFromView(key, next.get(key), labelOf(key));
  let nextEntries = list
    .filter((e) => e && next.has(runKey(e.projectId)))
    .map((e) => (touched.has(runKey(e.projectId)) ? fresh(runKey(e.projectId)) : e));
  for (const key of touched) {
    if (next.has(key) && !nextEntries.some((e) => runKey(e.projectId) === key)) nextEntries = upsertEntry(nextEntries, key, fresh(key));
  }
  return { next, nextEntries };
}

/** Re-reads only the active tab's project (planning goes by it). */
export async function refreshActive() {
  activeProjectId = await readActiveProject();
  return activeProjectId;
}

/**
 * Refetches every run (orchestra:list + orchestra:get per project).
 * @param {{reset?: boolean, project?: string|null}} [opts] reset: back to the
 *   default project (the board opened from a tab); project: show this one
 */
export async function refresh(opts = {}) {
  const touched = new Set();
  appliedDuring = touched;
  const seq = selectSeq;
  try {
    activeProjectId = await readActiveProject();
    const list = await readList();
    if (!labels.size) await readLabels();
    const listed = summarize(list);
    const views = await Promise.all(listed.map((c) => readView(c.projectId)));
    const { next, nextEntries } = mergeFetched(list, listed, views, touched);
    runs = next;
    entries = nextEntries;
  } finally {
    if (appliedDuring === touched) appliedDuring = null;
  }
  // A chip clicked meanwhile is the newer choice.
  if (seq !== selectSeq) return;
  if (opts.project !== undefined) boardProjectId = runKey(opts.project);
  else boardProjectId = keepBoardProject(summarize(entries), opts.reset ? undefined : boardProjectId, activeProjectId);
}

/** The board's project: what every board action passes as its projectId. */
export const project = () => (boardProjectId === undefined ? activeProjectId : boardProjectId);
/** The board's run view, or null (nothing planned for the board's project). */
export const view = () => runs.get(project()) || null;
/** Any project's run view, or null: the live map shows a run without moving the board. */
export const viewOf = (projectId) => runs.get(runKey(projectId)) || null;
/** The active tab's project (planning goes by it). */
export const activeProject = () => activeProjectId;
/** Whether the board shows the active tab's project. */
export const onActiveProject = () => project() === activeProjectId;

/** Shows another project's run. */
export function select(projectId) {
  selectSeq += 1;
  boardProjectId = runKey(projectId);
}

/**
 * A run changed (orchestra:changed, or an action's answer). A null view means
 * the project has no run any more.
 * @param {object|null} next
 * @param {string|null|undefined} projectId undefined = the view's own projectId
 */
export function apply(next, projectId) {
  const key = runKey(projectId !== undefined ? projectId : next && next.projectId);
  if (appliedDuring) appliedDuring.add(key);
  if (next && typeof next === 'object') runs.set(key, next);
  else runs.delete(key);
  entries = upsertEntry(entries, key, runs.has(key) ? entryFromView(key, next, labelOf(key)) : null);
  if (boardProjectId !== undefined) boardProjectId = keepBoardProject(summarize(entries), boardProjectId, activeProjectId);
}

/**
 * The switcher's chips: every run, plus the active tab's project with no run
 * yet (state 'none' - selecting it opens the to-do picker).
 * @returns {Array<{projectId:string|null, label:string|null, state:string, pausedUntil:number|null, scheduledAt:number|null}>}
 */
export function chips() {
  const list = summarize(entries);
  if (list.length && !list.some((c) => c.projectId === activeProjectId)) {
    const label = labels.get(activeProjectId) || null;
    list.push({ projectId: activeProjectId, label, planId: null, state: 'none', pausedUntil: null, scheduledAt: null, tally: {} });
  }
  return list;
}
