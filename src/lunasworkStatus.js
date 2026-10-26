// ============================================================================
// LunaCore - Luna's Work: the status the renderer may see (HUD panel, 1.7)
// ----------------------------------------------------------------------------
// The run controller's status() (src/lunaswork.js) is rebuilt here field by
// field before it leaves main, on the lunaswork:status answer and on every
// lunaswork:event push:
//
//   - roles only from ROLES, models only from MODEL_CHOICES
//   - the project id only when it names a registered project
//   - phase / verdict / event type only from their known lists
//   - the evidence folder never leaves main: the panel gets `hasEvidence`
//     and asks main to open it (lunaswork:openEvidence)
//   - pending decisions: a count, plus the cleaned list (question, options,
//     default, deadline) when the controller sends one
//   - the wheel (C11): running / requested / handed, and since when
//
// evidenceDirOf() is the one check before that folder is opened: it has to
// sit inside <runsRoot>/lunaswork-<runId>/ of the current run.
// ============================================================================

'use strict';

const fs = require('fs');
const path = require('path');
const { ROLES, MODEL_CHOICES } = require('./lunasworkRules');
const { ALL_PHASES } = require('./lunasworkRun');
const { publicDecisions } = require('./lunasworkDecisions');
const { cleanWheel } = require('./lunasworkWheel');

const EVENT_TYPES = ['phase', 'wait', 'resume', 'stopping', 'decision', 'wheel'];
const VERDICTS = ['ship', 'plateau', 'red', 'stop'];
const MODEL_SOURCES = ['run', 'project', 'global'];
const RUN_ID_RE = /^[a-z0-9]{1,40}$/;
const MAX_TEXT = 200;
const MAX_MILESTONES = 20;
const MAX_SCORES = 10;
const MAX_PENDING = 10000;

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const time = (v) => (Number.isFinite(v) && v > 0 ? v : null);
const text = (v) => (typeof v === 'string' && v ? v.slice(0, MAX_TEXT) : null);
const oneOf = (list, v) => (list.includes(v) ? v : null);

/** A { role: value } map with known roles and allowed values only. */
function roleMap(raw, allowed) {
  const out = {};
  if (!isObj(raw)) return out;
  for (const role of ROLES) {
    if (allowed.includes(raw[role])) out[role] = raw[role];
  }
  return out;
}

/** { milestone: [{n, score}] } with finite numbers only, capped. */
function cleanScores(raw) {
  const out = {};
  if (!isObj(raw)) return out;
  for (const [key, list] of Object.entries(raw).slice(0, MAX_MILESTONES)) {
    if (!Array.isArray(list)) continue;
    const rows = list
      .filter((r) => isObj(r) && Number.isFinite(r.score))
      .map((r) => ({ n: Number.isInteger(r.n) ? r.n : null, score: r.score }))
      .slice(-MAX_SCORES);
    if (rows.length) out[key.slice(0, MAX_TEXT)] = rows;
  }
  return out;
}

/**
 * The renderer's copy of a controller status.
 * @param {unknown} raw controller.status()
 * @param {(projectId:string)=>boolean} isKnownProject
 * @returns {object}
 */
function publicStatus(raw, isKnownProject) {
  if (!isObj(raw) || !RUN_ID_RE.test(String(raw.runId || ''))) return { active: false, runId: null };
  const pending = raw.pendingDecisions;
  return {
    active: raw.active === true,
    runId: raw.runId,
    projectId: typeof raw.projectId === 'string' && isKnownProject(raw.projectId) ? raw.projectId : null,
    iteration: Number.isInteger(raw.iteration) && raw.iteration >= 0 ? raw.iteration : 0,
    phase: oneOf(ALL_PHASES, raw.phase),
    role: oneOf(ROLES, raw.role),
    models: roleMap(raw.models, MODEL_CHOICES),
    modelSources: roleMap(raw.modelSources, MODEL_SOURCES),
    milestone: text(raw.milestone),
    verdict: oneOf(VERDICTS, raw.verdict),
    stopRequested: raw.stopRequested === true,
    stopReason: text(raw.stopReason),
    startedAt: time(raw.startedAt),
    phaseStartedAt: time(raw.phaseStartedAt),
    waitUntil: time(raw.waitUntil),
    waitReason: text(raw.waitReason),
    freeUntil: time(raw.freeUntil),
    endedAt: time(raw.endedAt),
    scores: cleanScores(raw.scores),
    hasEvidence: typeof raw.evidenceDir === 'string' && raw.evidenceDir.length > 0,
    wheel: cleanWheel(raw.wheel),
    handedAt: time(raw.handedAt),
    // Only when the controller reports it; the panel hides the count otherwise.
    ...pendingOf(pending),
  };
}

/**
 * The decision queue for the panel: the count, and the list when the
 * controller sends one (re-cleaned field by field, lunasworkDecisions.publicDecisions).
 */
function pendingOf(pending) {
  if (Array.isArray(pending)) {
    const decisions = publicDecisions(pending);
    return { pendingDecisions: decisions.length, decisions };
  }
  return Number.isInteger(pending) && pending >= 0 ? { pendingDecisions: Math.min(pending, MAX_PENDING) } : {};
}

/** A pushed event, or null when its type is unknown. */
function publicEvent(raw, isKnownProject) {
  if (!isObj(raw) || !EVENT_TYPES.includes(raw.type)) return null;
  return { type: raw.type, status: publicStatus(raw.status, isKnownProject) };
}

/**
 * The current run's evidence folder when it is safe to open, else null:
 * inside <runsRoot>/lunaswork-<runId>/ and existing on disk.
 * @param {unknown} raw controller.status()
 * @param {string} runsRoot
 * @param {(p:string)=>boolean} [exists]
 */
function evidenceDirOf(raw, runsRoot, exists = fs.existsSync) {
  if (!isObj(raw) || typeof raw.evidenceDir !== 'string' || !RUN_ID_RE.test(String(raw.runId || ''))) return null;
  if (typeof runsRoot !== 'string' || !path.isAbsolute(runsRoot)) return null;
  const runDir = path.resolve(runsRoot, `lunaswork-${raw.runId}`);
  const dir = path.resolve(raw.evidenceDir);
  if (!dir.startsWith(runDir + path.sep)) return null;
  return exists(dir) ? dir : null;
}

module.exports = { EVENT_TYPES, publicStatus, publicEvent, evidenceDirOf };
