// ============================================================================
// LunaCore - Luna's Work: "Hand me the wheel" (docs/LUNAS_WORK_PLAN.md C11)
// ----------------------------------------------------------------------------
// The pure half shared by the PC and the phone:
//
//   state     wheelState: running | requested (the run pauses at the end of
//             the current iteration) | handed (Mati works by hand)
//   phone     wheelUnit - the `todos` cloud unit the phone writes under
//             `lunaswork-wheel:<id>` ({runId, action: hand|back}), and
//             wheelFromTodoPeers - the PC's reader of those units
//
// The PC publishes the state in the snapshot's feedback section
// (lunasworkFeedback.publicFeedback); the controller (src/lunaswork.js)
// applies only the newest unit of its own run, once.
//
// No `fs` / `path`: the phone imports this module too.
// ============================================================================

'use strict';

const HANDED = 'handed';
const WHEEL_STATES = ['running', 'requested', HANDED];
const WHEEL_ACTIONS = ['hand', 'back'];
const WHEEL_LIST_KEY = 'lunaswork-wheel';
// Units read per pull: the phone writes one per tap.
const MAX_UNITS = 200;
// A unit id is the phone's clock: one this far ahead of the PC's is refused,
// or it would hold back every later tap of the run (wheelSeq).
const MAX_CLOCK_AHEAD_MS = 10 * 60 * 1000;

const RUN_ID_RE = /^[a-z0-9]{1,40}$/;
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const validId = (v) => Number.isSafeInteger(v) && v > 0;

/**
 * Who has the wheel of a run record.
 * @param {{phase?:string, handRequested?:boolean}|null} run
 * @returns {'running'|'requested'|'handed'}
 */
function wheelState(run) {
  if (!isObj(run) || run.phase === 'done') return 'running';
  if (run.phase === HANDED) return HANDED;
  return run.handRequested === true ? 'requested' : 'running';
}

/** A wheel state from untrusted data, 'running' when unknown. */
const cleanWheel = (v) => (WHEEL_STATES.includes(v) ? v : 'running');

/** The `todos` cloud key the phone writes a wheel action under. */
const wheelKey = (id) => `${WHEEL_LIST_KEY}:${id}`;

/**
 * A wheel action from the phone as a cloud unit for the `todos` scope, or
 * null when the PC would refuse it.
 * @param {string} runId the run in the snapshot's feedback section
 * @param {'hand'|'back'} action
 * @param {number} [now]
 * @returns {{k:string, v:{runId:string, action:string}, u:number, d:null}|null}
 */
function wheelUnit(runId, action, now = Date.now()) {
  const id = Math.floor(now);
  if (typeof runId !== 'string' || !RUN_ID_RE.test(runId) || !WHEEL_ACTIONS.includes(action) || !validId(id)) return null;
  return { k: wheelKey(id), v: { runId, action }, u: id, d: null };
}

/**
 * Wheel actions out of the cloud's `todos` peers (cloudrows.todoPeer output:
 * {<key>: {items:[{...v, at, u}]}}), oldest first. Untrusted: the controller
 * checks each against its own run.
 * @returns {{id:number, runId:string, action:'hand'|'back'}[]}
 */
function wheelFromTodoPeers(peers) {
  const out = [];
  for (const peer of Array.isArray(peers) ? peers : []) {
    const list = isObj(peer) && Object.hasOwn(peer, WHEEL_LIST_KEY) && isObj(peer[WHEEL_LIST_KEY]) ? peer[WHEEL_LIST_KEY].items : null;
    for (const item of Array.isArray(list) ? list.slice(-MAX_UNITS) : []) {
      if (!isObj(item) || !validId(item.at) || typeof item.runId !== 'string' || !RUN_ID_RE.test(item.runId)) continue;
      if (!WHEEL_ACTIONS.includes(item.action)) continue;
      out.push({ id: item.at, runId: item.runId, action: item.action });
    }
  }
  return out.sort((a, b) => a.id - b.id);
}

/**
 * The one wheel action of `list` the run should apply: the newest of its own
 * run past `seq` (the last one applied) and not from the future, or null.
 * Older ones are superseded.
 * @param {unknown[]} list wheelFromTodoPeers output (untrusted)
 * @param {{runId:string, seq:number, now:number}} ctx
 * @returns {{id:number, runId:string, action:'hand'|'back'}|null}
 */
function newestWheelAction(list, { runId, seq, now }) {
  const latest = now + MAX_CLOCK_AHEAD_MS;
  const mine = (Array.isArray(list) ? list : []).filter(
    (w) => isObj(w) && w.runId === runId && validId(w.id) && w.id > seq && w.id <= latest && WHEEL_ACTIONS.includes(w.action),
  );
  return mine.reduce((best, w) => (!best || w.id > best.id ? w : best), null);
}

module.exports = {
  HANDED,
  WHEEL_STATES,
  WHEEL_ACTIONS,
  WHEEL_LIST_KEY,
  MAX_CLOCK_AHEAD_MS,
  RUN_ID_RE,
  wheelState,
  cleanWheel,
  wheelKey,
  wheelUnit,
  wheelFromTodoPeers,
  newestWheelAction,
};
