// ============================================================================
// LunaCore - Live map, Luna's Work tab: the loop model (pure, no DOM)
// ----------------------------------------------------------------------------
// Folds what the renderer already gets about a Luna's Work run into the
// picture the loop view draws:
//
//   status     lunasworkStatus().status and every lunaswork:event's status
//              (src/lunasworkStatus.js publicStatus: runId, phase, role,
//              iteration, verdict, wheel, waitUntil, failures ...)
//   dashboard  lunasworkDashboard().dashboard (src/lunasworkDashboardView.js:
//              timeline rows with verdict / playtestOk / buildFailed ...,
//              cards {opened, closed})
//   queue      lunasworkQueueList().queue ([{projectId, label}])
//
// -> {runId, project, iteration, activeRole, roles:[{key, state, lastResult}],
//     verdict, cardsCreated, handedOver, queue, ...}
//
// The loop's stations and the real phase names (src/lunasworkRules.js
// PHASES, src/lunaswork.js PHASE_ROLE):
//   directing                 -> director
//   building                  -> build (the God Mode run)
//   launching, playtesting    -> playtester (the app launch is the Playtester's)
//   critiquing                -> critic (the reviews of lunasworkLoopHooks run
//                                inside it, after the Critic)
//   preprod / handed / done   -> outside the loop: no active station
//   anything else             -> 'other', never thrown on
// The second opinion (lunasworkSecondOpinion) runs inside `critiquing`, at a
// milestone gate, and only when Mati opted in. Neither the status nor the
// dashboard says when it ran today, so its station appears only when an
// input carries an explicit `secondOpinion` mark (a timeline row's, or the
// status'); until main sends one it stays hidden rather than guessed.
//
// Nothing here mutates its input; malformed input of any shape gives the
// empty / partial model, never an exception.
// ============================================================================

'use strict';

/** The loop's stations, in loop order (the view draws them clockwise). */
export const LOOP_ROLES = Object.freeze(['director', 'build', 'playtester', 'critic']);
export const SECOND_OPINION = 'secondOpinion';
/** Every state a station can be in. */
export const ROLE_STATES = Object.freeze(['active', 'waiting', 'retrying', 'done', 'pending', 'idle']);
/** Final run verdicts (lunasworkStatus VERDICTS) and the last Critic's call between them. */
export const FINAL_VERDICTS = Object.freeze(['ship', 'plateau', 'red', 'stop']);
export const MAX_QUEUE = 20;
const MAX_TEXT = 200;

const PHASE_ROLE = Object.freeze({
  directing: 'director',
  building: 'build',
  launching: 'playtester',
  playtesting: 'playtester',
  critiquing: 'critic',
});
const OUTSIDE_PHASES = new Set(['preprod', 'handed', 'done']);
// status.role (lunasworkRules ROLES) -> station; it wins over the phase when both are known.
const STATUS_ROLE = Object.freeze({ director: 'director', builder: 'build', playtester: 'playtester', critic: 'critic', reviewer: 'critic' });
const EVENT_TYPES = new Set(['phase', 'wait', 'resume', 'stopping', 'decision', 'wheel']);
const RUN_ID_RE = /^[a-z0-9]{1,40}$/;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = (v) => (typeof v === 'string' && v ? v.slice(0, MAX_TEXT) : null);
const count = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : null);
const time = (v) => (Number.isFinite(v) && v > 0 ? v : null);
const runIdOf = (v) => (typeof v === 'string' && RUN_ID_RE.test(v) ? v : null);
const own = (map, key) => typeof key === 'string' && Object.prototype.hasOwnProperty.call(map, key);

/**
 * Where a phase sits: in the loop (with its station), outside it, or unknown.
 * @param {unknown} phase
 * @returns {{stage:'loop'|'preprod'|'handed'|'done'|'other'|'none', role:string|null, phase:string|null}}
 *   phase: the known phase name, 'other' for an unknown one, null for none
 */
export function phaseInfo(phase) {
  if (phase === null || phase === undefined || phase === '') return { stage: 'none', role: null, phase: null };
  if (own(PHASE_ROLE, phase)) return { stage: 'loop', role: PHASE_ROLE[phase], phase };
  if (typeof phase === 'string' && OUTSIDE_PHASES.has(phase)) return { stage: phase, role: null, phase };
  return { stage: 'other', role: 'other', phase: 'other' };
}

/** The station of a status' `role` field, or null. */
export function stationOfRole(role) {
  return own(STATUS_ROLE, role) ? STATUS_ROLE[role] : null;
}

/** A second-opinion mark: true / {ran} / {agrees} -> {agrees: boolean|null}, else null. */
function secondOpinionOf(raw) {
  if (raw === true) return { agrees: null };
  if (isObj(raw) && (raw.ran === true || typeof raw.agrees === 'boolean')) return { agrees: typeof raw.agrees === 'boolean' ? raw.agrees : null };
  return null;
}

/** The last finished iteration's row of the dashboard timeline, or null. */
function lastRow(timeline) {
  const rows = Array.isArray(timeline) ? timeline.filter((r) => isObj(r) && Number.isSafeInteger(r.n)) : [];
  if (!rows.length) return null;
  return rows.reduce((a, b) => (b.n >= a.n ? b : a));
}

function buildResult(row) {
  if (row.buildFailed === true) return { key: 'buildFailed', tone: 'bad' };
  if (row.rolledBack === true) return { key: 'rolledBack', tone: 'bad' };
  if (row.selfCheck === 'red') return { key: 'red', tone: 'bad' };
  if (row.skipped === true) return { key: 'skipped', tone: 'dim' };
  const closed = count(row.cardsClosed);
  return closed === null ? null : { key: 'closed', tone: 'good', n: closed };
}

function criticResult(row) {
  const score = Number.isFinite(row.score) ? row.score : null;
  if (row.verdict === 'ship') {
    return row.shipAgrees === false ? { key: 'shipRefused', tone: 'warn', score } : { key: 'ship', tone: 'good', score };
  }
  if (row.verdict === 'continue') return { key: 'continue', tone: 'dim', score };
  return score === null ? null : { key: 'score', tone: 'dim', score };
}

/**
 * What a station did in the last finished iteration (a dashboard timeline
 * row), as {key, tone, n?, score?} for the view to translate.
 * @param {string} role
 * @param {unknown} row
 * @returns {{key:string, tone:'good'|'bad'|'warn'|'dim', n?:number, score?:number|null}|null}
 */
export function lastResultOf(role, row) {
  if (!isObj(row)) return null;
  if (role === 'director') {
    const opened = count(row.cardsOpened);
    return opened === null ? null : { key: 'cards', tone: 'dim', n: opened };
  }
  if (role === 'build') return buildResult(row);
  if (role === 'playtester') {
    if (row.playtestOk === true) return { key: 'passed', tone: 'good' };
    if (row.playtestOk === false) return { key: 'playtestFailed', tone: 'bad' };
    return null;
  }
  if (role === 'critic') return criticResult(row);
  if (role === SECOND_OPINION) {
    const mark = secondOpinionOf(row.secondOpinion);
    if (!mark || mark.agrees === null) return null;
    return mark.agrees ? { key: 'agrees', tone: 'good' } : { key: 'disagrees', tone: 'warn' };
  }
  return null;
}

/** The state of each station this iteration, from the active one's position. */
function roleStates(keys, active, flags) {
  const at = active ? keys.indexOf(active) : -1;
  let here = 'active';
  if (flags.waiting) here = 'waiting';
  else if (flags.retrying) here = 'retrying';
  return keys.map((key, i) => {
    if (at < 0) return 'idle';
    if (i < at) return 'done';
    return i === at ? here : 'pending';
  });
}

/** The run's verdict: the final one when the run has it, else the last Critic's call. */
function verdictOf(status, dash, row) {
  for (const v of [status.verdict, dash && dash.verdict]) {
    if (FINAL_VERDICTS.includes(v)) return { key: v, final: true };
  }
  if (!row) return null;
  if (row.verdict === 'ship') return { key: row.shipAgrees === false ? 'shipRefused' : 'shipProposed', final: false };
  if (row.verdict === 'continue') return { key: 'continue', final: false };
  return null;
}

function cardsOf(dash) {
  if (!dash) return { created: 0, closed: 0 };
  const cards = isObj(dash.cards) ? dash.cards : {};
  const rows = Array.isArray(dash.timeline) ? dash.timeline.filter(isObj) : [];
  const sum = (key) => rows.reduce((s, r) => s + (count(r[key]) || 0), 0);
  return {
    created: count(cards.opened) !== null ? cards.opened : sum('cardsOpened'),
    closed: count(cards.closed) !== null ? cards.closed : sum('cardsClosed'),
  };
}

/** Queued projects: [{projectId, label}], valid ones only, capped. */
export function queueOf(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const out = [];
  for (const q of list) {
    if (out.length >= MAX_QUEUE) break;
    if (!isObj(q) || !text(q.projectId)) continue;
    out.push({ projectId: text(q.projectId), label: text(q.label) || text(q.projectId) });
  }
  return out;
}

function handedOf(status, stage) {
  if (status.wheel === 'handed' || stage === 'handed') return 'handed';
  if (status.wheel === 'requested') return 'requested';
  return 'no';
}

/** The station at work: only in a running run; the status' own role wins over the phase. */
function activeRoleOf(active, info, status) {
  if (!active) return null;
  if (info.stage === 'loop') return stationOfRole(status.role) || info.role;
  return info.stage === 'other' ? 'other' : null;
}

/**
 * The loop model of the current run.
 * @param {{status?: unknown, dashboard?: unknown, queue?: unknown}} [input]
 * @returns {object} see the header; `empty: true` when there is no run
 */
export function buildLoopModel(input) {
  const src = isObj(input) ? input : {};
  const status = isObj(src.status) ? src.status : {};
  let dash = isObj(src.dashboard) ? src.dashboard : null;
  const statusRun = runIdOf(status.runId);
  // A dashboard of another run (an older answer) says nothing about this one.
  if (dash && statusRun && runIdOf(dash.runId) !== statusRun) dash = null;
  const runId = statusRun || (dash ? runIdOf(dash.runId) : null);
  // Fields come from the live status when it names the run, else from the dashboard.
  const live = statusRun ? status : dash || {};
  const info = phaseInfo(live.phase);
  const active = live.active === true;
  const row = dash ? lastRow(dash.timeline) : null;

  const second = secondOpinionOf(status.secondOpinion) || (row ? secondOpinionOf(row.secondOpinion) : null);
  const keys = second ? [...LOOP_ROLES, SECOND_OPINION] : [...LOOP_ROLES];
  const activeRole = activeRoleOf(active, info, status);
  const failures = isObj(status.stepFailures) && count(status.stepFailures.count) ? status.stepFailures : null;
  const waitUntil = time(status.waitUntil);
  const states = roleStates(keys, activeRole, { waiting: !!waitUntil, retrying: !!failures });
  const cards = cardsOf(dash);

  return {
    empty: runId === null,
    runId,
    project: text(live.projectId),
    active,
    stage: runId === null ? 'none' : info.stage,
    phase: info.phase,
    iteration: count(live.iteration) || 0,
    milestone: text(live.milestone) || (dash ? text(dash.milestone) : null),
    activeRole,
    roles: keys.map((key, i) => ({ key, state: states[i], lastResult: lastResultOf(key, row) })),
    lastIteration: row ? row.n : null,
    verdict: runId === null ? null : verdictOf(status, dash, row),
    cardsCreated: cards.created,
    cardsClosed: cards.closed,
    handedOver: runId === null ? 'no' : handedOf(status, info.stage),
    queue: queueOf(src.queue),
    phaseStartedAt: time(status.phaseStartedAt),
    waiting: waitUntil ? { until: waitUntil, reason: text(status.waitReason) } : null,
    retrying: failures ? { count: failures.count, max: count(failures.max) || failures.count } : null,
    stopRequested: status.stopRequested === true,
  };
}

/**
 * Folds a lunaswork:event into the model's input: a run event's status
 * replaces the old one; anything else (a one-off Playtester pass, junk) is
 * ignored and the SAME input comes back.
 * @param {{status?:unknown, dashboard?:unknown, queue?:unknown}} input
 * @param {unknown} event {type, status}
 */
export function applyLunasworkEvent(input, event) {
  if (!isObj(event) || !EVENT_TYPES.has(event.type) || !isObj(event.status)) return input;
  return { ...(isObj(input) ? input : {}), status: event.status };
}
