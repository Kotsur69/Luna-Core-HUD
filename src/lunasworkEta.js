// ============================================================================
// LunaCore - Luna's Work time-to-SHIP inputs (LW 2.22b, docs/LUNAS_WORK_PLAN.md)
// ----------------------------------------------------------------------------
// Gathers what lunasworkRules.timeToShip needs from a run record and the
// project's files, and words the result for the milestone email:
//
//   openCardCount(cards, runId)   the run's open cards (built counts as open)
//                                 plus Mati's open steer cards
//   roadmapLeft(md)               epics not ticked in ROADMAP.md (parseRoadmap)
//   shipInputs(run)               cards closed and minutes per finished iteration
//   shipEstimate(run, {cards, roadmapMd})  timeToShip(...) or null
//   etaLine(estimate)             "about 4.5 h (3-7 h), ~6 iterations" or ''
//
// Pure: the caller reads the to-do store and ROADMAP.md.
// ============================================================================

'use strict';

const { timeToShip } = require('./lunasworkRules');
const { parseRoadmap } = require('./lunasworkPack');
const { cleanLedger } = require('./lunasworkUsage');
const { runTag, STEER_TAG } = require('./todorows');

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const hasTag = (card, tag) => Array.isArray(card.tags) && card.tags.includes(tag);

/** Open cards of run `runId` and open steer cards. */
function openCardCount(cards, runId) {
  const tag = runTag(runId);
  return (Array.isArray(cards) ? cards : []).filter((c) => isObj(c) && !c.done && ((tag && hasTag(c, tag)) || hasTag(c, STEER_TAG))).length;
}

/** Epics still open over every milestone of ROADMAP.md; 0 without a roadmap. */
function roadmapLeft(md) {
  const roadmap = parseRoadmap(md);
  if (!roadmap) return 0;
  return roadmap.milestones.reduce((sum, m) => sum + (m.epics || []).filter((e) => !e.done).length, 0);
}

/** Per finished iteration (the laps, oldest first): cards closed and wall minutes. */
function shipInputs(run) {
  const laps = (isObj(run) && Array.isArray(run.laps) ? run.laps : []).filter((l) => isObj(l) && Number.isInteger(l.n));
  const phasesOf = new Map(cleanLedger(isObj(run) ? run.usage : null).iterations.map((it) => [it.n, it.phases]));
  return {
    closedPerIteration: laps.map((l) => (Array.isArray(l.cardsClosed) ? l.cardsClosed.length : 0)),
    iterationMinutes: laps.map((l) => Object.values(phasesOf.get(l.n) || {}).reduce((s, ms) => s + ms, 0) / 60000),
  };
}

/**
 * @param {object|null} run the run record (controller.snapshot())
 * @param {{cards?:object[], roadmapMd?:string|null}} ctx
 * @returns {ReturnType<typeof timeToShip>}
 */
function shipEstimate(run, { cards = [], roadmapMd = null } = {}) {
  if (!isObj(run)) return null;
  return timeToShip({ ...shipInputs(run), openCards: openCardCount(cards, run.id), roadmapLeft: roadmapLeft(roadmapMd) });
}

/** The estimate in one English line (the milestone email), '' without one. */
function etaLine(est) {
  if (!isObj(est) || !Number.isInteger(est.iterations)) return '';
  const iters = `~${est.iterations} iteration${est.iterations === 1 ? '' : 's'}`;
  if (!Number.isFinite(est.hours)) return iters;
  const range = Number.isFinite(est.low) ? ` (${est.low}-${Number.isFinite(est.high) ? `${est.high} h` : '? h'})` : '';
  return `about ${est.hours} h${range}, ${iters}`;
}

module.exports = { openCardCount, roadmapLeft, shipInputs, shipEstimate, etaLine };
