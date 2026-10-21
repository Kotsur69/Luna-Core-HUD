// ============================================================================
// LunaCore - per-tab status light (pure, no Electron)
// ----------------------------------------------------------------------------
// Every terminal tab - God Mode worker or a plain one - gets one light saying
// what it is doing: 'working', 'done' (finished a turn you have not looked at
// yet), 'idle', 'approval' (a permission prompt is waiting on you), 'limit'
// (usage-limit wall, with its reset time) or 'dead' (process exited).
//
// Main feeds raw events in (stdout, transcript turns, input, activation) and
// the board pushes a change out only when a session's COMMITTED state moves.
// Commits are debounced: a TUI redraw or a one-second gap between chunks must
// not make the light flicker between working and idle. 'dead' alone commits
// at once - nothing that follows it can be a false alarm.
// ============================================================================

'use strict';

/** Stdout/transcript activity this recent counts as "working". */
const ACTIVITY_MS = 5000;
/** A raw state must hold this long before the light follows it. */
const DEBOUNCE_MS = 1000;
/** Output this soon after input is the terminal echoing keystrokes, not work. */
const ECHO_MS = 300;
/**
 * A turn whose end never arrived (Esc-interrupted, crashed CLI) stops counting
 * as "in progress" after this much silence - the TUI's spinner prints every
 * second while a turn really runs, so a long quiet stretch means it is over.
 */
const TURN_STALE_MS = 2 * 60 * 1000;

const STATES = Object.freeze(['working', 'done', 'idle', 'approval', 'limit', 'dead']);

/**
 * The raw (undebounced) state of one session's facts, by priority:
 * dead > approval > limit > working > done > idle.
 * @param {object} f facts - see createSessionStatus
 * @param {number} now
 * @returns {string}
 */
function rawState(f, now) {
  if (f.dead) return 'dead';
  if (f.approval) return 'approval';
  if (f.limit && !(Number.isFinite(f.resetsAt) && now >= f.resetsAt)) return 'limit';
  const quietFor = now - f.lastActivity;
  if (quietFor < ACTIVITY_MS) return 'working';
  if (f.turnInProgress && quietFor < TURN_STALE_MS) return 'working';
  if (f.done) return 'done';
  return 'idle';
}

/**
 * One session's state machine.
 * @param {{ now?: () => number, debounceMs?: number }} [opts]
 */
function createSessionStatus({ now = Date.now, debounceMs = DEBOUNCE_MS } = {}) {
  const start = now();
  let facts = {
    dead: false,
    approval: false,
    limit: false,
    resetsAt: null,
    turnInProgress: false,
    done: false,
    lastActivity: -Infinity,
    lastInput: -Infinity,
  };
  let committed = { state: 'idle', since: start, resetsAt: null };
  let pending = null; // { state, at }

  const set = (patch) => {
    facts = { ...facts, ...patch };
  };

  return {
    /** Stdout or transcript activity. */
    activity() {
      const t = now();
      if (t - facts.lastInput < ECHO_MS) return;
      set({ lastActivity: t });
    },
    /** Any input from the user: answers a showing approval prompt. */
    input() {
      set({ approval: false, lastInput: now() });
    },
    approval() {
      set({ approval: true });
    },
    /** @param {number|null} resetsAt epoch ms, or null when unknown */
    limit(resetsAt) {
      set({ limit: true, resetsAt: Number.isFinite(resetsAt) ? resetsAt : null });
    },
    turnStart() {
      // A new turn means the limit has lifted, and the old "done" is stale.
      set({ turnInProgress: true, done: false, limit: false, resetsAt: null, lastActivity: now() });
    },
    /** @param {boolean} viewed whether the user is looking at this tab right now */
    turnEnd(viewed) {
      set({ turnInProgress: false, done: !viewed, lastActivity: -Infinity });
    },
    /** The tab was activated (or the window focused on it): done -> idle. */
    viewed() {
      set({ done: false });
    },
    exited() {
      set({ dead: true });
    },
    /** A (re)spawned process: every fact about the old one is void. */
    revive() {
      set({
        dead: false,
        approval: false,
        limit: false,
        resetsAt: null,
        turnInProgress: false,
        done: false,
        lastActivity: -Infinity,
      });
    },
    /**
     * Advances the debounce. Returns the new committed status when it changed,
     * otherwise null.
     * @returns {{ state: string, since: number, resetsAt: number|null } | null}
     */
    tick() {
      const t = now();
      const raw = rawState(facts, t);
      const resetsAt = raw === 'limit' ? facts.resetsAt : null;
      if (raw === committed.state) {
        pending = null;
        if (resetsAt === committed.resetsAt) return null;
        committed = { ...committed, resetsAt };
        return committed;
      }
      if (!pending || pending.state !== raw) pending = { state: raw, at: t };
      if (raw !== 'dead' && t - pending.at < debounceMs) return null;
      committed = { state: raw, since: t, resetsAt };
      pending = null;
      return committed;
    },
    /** @returns {{ state: string, since: number, resetsAt: number|null }} */
    current() {
      return committed;
    },
  };
}

/**
 * All sessions' lights. Events go in by sessionId; `onChange` fires with
 * (sessionId, status) for every committed change, from the event itself or
 * from the periodic tick() that lets debounces and activity windows lapse.
 * @param {{ now?: () => number, debounceMs?: number,
 *           onChange?: (sessionId: string, status: object) => void }} [opts]
 */
function createStatusBoard({ now = Date.now, debounceMs = DEBOUNCE_MS, onChange = () => {} } = {}) {
  const machines = new Map();

  const machine = (id) => {
    let m = machines.get(id);
    if (!m) {
      m = createSessionStatus({ now, debounceMs });
      machines.set(id, m);
    }
    return m;
  };
  const step = (id) => {
    const m = machines.get(id);
    const changed = m && m.tick();
    if (changed) onChange(id, changed);
  };
  const on = (method) => (id, arg) => {
    machine(id)[method](arg);
    step(id);
  };

  return {
    activity: on('activity'),
    input: on('input'),
    approval: on('approval'),
    limit: on('limit'),
    turnStart: on('turnStart'),
    turnEnd: on('turnEnd'),
    viewed: on('viewed'),
    exited: on('exited'),
    revive: on('revive'),
    tick() {
      for (const id of machines.keys()) step(id);
    },
    remove(id) {
      machines.delete(id);
    },
    /** @returns {{ state: string, since: number, resetsAt: number|null } | null} */
    current(id) {
      const m = machines.get(id);
      return m ? m.current() : null;
    },
    /** How many sessions currently show `state`. */
    count(state) {
      let n = 0;
      for (const m of machines.values()) if (m.current().state === state) n += 1;
      return n;
    },
  };
}

module.exports = {
  STATES,
  ACTIVITY_MS,
  DEBOUNCE_MS,
  ECHO_MS,
  TURN_STALE_MS,
  rawState,
  createSessionStatus,
  createStatusBoard,
};
