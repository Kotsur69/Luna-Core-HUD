// ============================================================================
// LunaCore - God Mode run list (pure half of the board's project switcher,
// docs/tbc_docs/MULTI_GODMODE_PLAN.md A4)
// ----------------------------------------------------------------------------
// One God Mode run per project. main's orchestra:list gives a summary per run
// (orchestraIpc.runSummary); orchestra:changed gives a full view for one
// project. This turns either into the switcher's chips and picks which
// project the board shows. No DOM, no imports: node --test reads it directly.
// ============================================================================

'use strict';

/** @typedef {'running'|'paused'|'scheduled'|'settled'|'needsYou'|'planned'} RunState */

/**
 * @typedef {{
 *   projectId: string|null, label: string|null, planId: string|null,
 *   state: RunState, pausedUntil: number|null, scheduledAt: number|null,
 *   tally: Object<string, number>,
 * }} RunChip
 */

// Package states that are finished for good.
const DONE_STATES = new Set(['pushed']);
// Package states that wait on Mati.
const ATTENTION_STATES = new Set(['stalled', 'failed', 'closed', 'killed']);
// States the board defaults to before a settled one.
const LIVE_STATES = new Set(['running', 'paused', 'scheduled']);

/** The registry key for a project id: a string, or null for a tab with no project. */
export const runKey = (projectId) => (typeof projectId === 'string' && projectId ? projectId : null);

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const finiteOrNull = (v) => (Number.isFinite(v) ? v : null);

function cleanTally(tally) {
  const out = {};
  if (!isObj(tally)) return out;
  for (const [k, v] of Object.entries(tally)) if (Number.isFinite(v) && v > 0) out[k] = v;
  return out;
}

const countIn = (tally, set) => Object.entries(tally).reduce((n, [k, v]) => (set.has(k) ? n + v : n), 0);

/**
 * One run's state for its chip.
 * @param {{started?:boolean, killed?:boolean, settled?:boolean, pausedUntil?:number|null,
 *   scheduledAt?:number|null, integration?:string|null}} e
 * @param {Object<string, number>} tally
 * @returns {RunState}
 */
export function runState(e, tally) {
  if (!e.started) return finiteOrNull(e.scheduledAt) ? 'scheduled' : 'planned';
  if (e.killed) return 'needsYou';
  if (e.settled) {
    const total = Object.values(tally).reduce((n, v) => n + v, 0);
    const allDone = countIn(tally, DONE_STATES) === total;
    return allDone && e.integration !== 'failed' ? 'settled' : 'needsYou';
  }
  if (finiteOrNull(e.pausedUntil)) return 'paused';
  return countIn(tally, ATTENTION_STATES) > 0 ? 'needsYou' : 'running';
}

/**
 * orchestra:list entries -> switcher chips (same order, bad entries dropped).
 * @param {unknown} list
 * @returns {RunChip[]}
 */
export function summarize(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  const seen = new Set();
  for (const e of list) {
    if (!isObj(e)) continue;
    const projectId = runKey(e.projectId);
    if (seen.has(projectId)) continue;
    seen.add(projectId);
    const tally = cleanTally(e.tally);
    out.push({
      projectId,
      label: typeof e.label === 'string' && e.label ? e.label : null,
      planId: typeof e.planId === 'string' ? e.planId : null,
      state: runState(e, tally),
      pausedUntil: finiteOrNull(e.pausedUntil),
      scheduledAt: finiteOrNull(e.scheduledAt),
      tally,
    });
  }
  return out;
}

/**
 * A full run view (orchestra:changed / orchestra:get) as an orchestra:list
 * entry, so a live update re-derives its chip without another round trip.
 * @param {string|null} projectId
 * @param {object|null} view
 * @param {string|null} label
 * @returns {object|null} null when the project has no run any more
 */
export function entryFromView(projectId, view, label) {
  if (!isObj(view)) return null;
  const integ = isObj(view.integration) ? view.integration : {};
  return {
    projectId: runKey(projectId),
    label: label || null,
    planId: typeof view.id === 'string' ? view.id : null,
    started: view.started === true,
    killed: view.killed === true,
    settled: view.settled === true,
    pausedUntil: view.pausedUntil,
    scheduledAt: view.scheduledAt,
    tally: view.tally,
    integration: typeof integ.state === 'string' ? integ.state : null,
  };
}

/**
 * The list with one project's entry replaced in place, added at the end, or
 * removed.
 * @param {object[]} list orchestra:list entries
 * @param {string|null} projectId
 * @param {object|null} entry null removes it
 * @returns {object[]} a new array
 */
export function upsertEntry(list, projectId, entry) {
  const key = runKey(projectId);
  const src = (Array.isArray(list) ? list : []).filter(isObj);
  const at = src.findIndex((e) => runKey(e.projectId) === key);
  if (!entry) return at < 0 ? src : [...src.slice(0, at), ...src.slice(at + 1)];
  if (at < 0) return [...src, entry];
  return [...src.slice(0, at), entry, ...src.slice(at + 1)];
}

/**
 * Which project the board opens on: the active tab's project when it has a
 * run, else the first live run, else the first run needing Mati, else the
 * first run - and with no runs at all, the active tab's project (planning).
 * @param {RunChip[]} runs
 * @param {string|null|undefined} activeTabProjectId
 * @returns {string|null}
 */
export function defaultBoardProject(runs, activeTabProjectId) {
  const active = runKey(activeTabProjectId);
  const list = Array.isArray(runs) ? runs : [];
  if (list.some((r) => r.projectId === active)) return active;
  const pick = list.find((r) => LIVE_STATES.has(r.state)) || list.find((r) => r.state === 'needsYou') || list[0];
  return pick ? pick.projectId : active;
}

/**
 * The board's project after the run list changed: the current one while it
 * still has a run (or is the active tab's, about to be planned), else the
 * default.
 * @param {RunChip[]} runs
 * @param {string|null|undefined} current undefined = not chosen yet
 * @param {string|null|undefined} activeTabProjectId
 * @returns {string|null}
 */
export function keepBoardProject(runs, current, activeTabProjectId) {
  if (current !== undefined) {
    const key = runKey(current);
    if ((Array.isArray(runs) ? runs : []).some((r) => r.projectId === key)) return key;
    if (key === runKey(activeTabProjectId)) return key;
  }
  return defaultBoardProject(runs, activeTabProjectId);
}
