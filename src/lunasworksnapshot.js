// ============================================================================
// LunaCore - Luna's Work run snapshot for the phone (LW 2.17b, LUNAS_WORK_PLAN #12)
// ----------------------------------------------------------------------------
// A compact, versioned, size-capped picture of the current run. It rides in
// the PC's `godmode` cloud snapshot as `lunaswork` (src/snapshotputs.js), next
// to the decisions / feedback sections the phone already answers through.
//
//   buildSnapshot({status, run, eta, shots, now})  writer side (main): from
//       controller.status() + controller.snapshot(), the time-to-SHIP
//       estimate (lunasworkEta) and the newest screenshot thumbnails
//   cleanSnapshot(raw, now)   both sides: validated, scrubbed, capped
//   lunasworkFrom(rows, now)  reader side: the newest PC's section, with
//       `machine` and `stale`, or null
//   createSnapshotThrottle({publish, ...})  poke(build) on every phase
//       change: at once when the last put is MIN_MS old, else one trailing
//       put of the newest state; identical content is not put again
//
// Every string goes through godmodesnapshot.scrubPaths (the run's repo and
// evidence roots cut, any other absolute path down to its last segment) and
// is capped. A thumbnail survives only as a small base64 JPEG / PNG data URL.
// Over MAX_BYTES the thumbnails go first, then the feedback, then the scores.
// The phone bundles this file: no Node built-ins here.
// ============================================================================

'use strict';

const { scrubPaths } = require('./godmodesnapshot');

const VERSION = 1;
const MAX_BYTES = 96 * 1024;
const MAX_THUMB_CHARS = 24 * 1024;
const MAX_SHOTS = 3;
const MAX_MILESTONES = 6;
const MAX_SCORES = 8;
const MAX_ROLES = 8;
const MAX_DECISIONS = 10;
const MAX_FEEDBACK = 20;
const MAX_TEXT = 160;
const MAX_NAME = 80;
const MAX_COUNT = 1e9;
const MIN_MS = 30 * 1000;
// A PC publishes on every phase change; a run sits in one phase for up to an hour or so.
const STALE_MS = 3 * 60 * 60 * 1000;
const MACHINE_RE = /^[A-Za-z0-9-]{1,63}$/;
const RUN_ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const THUMB_RE = /^data:image\/(?:jpeg|png);base64,[A-Za-z0-9+/]+={0,2}$/;
const WORD_RE = /^[a-z][a-zA-Z]{0,23}$/;
const VERDICTS = ['ship', 'plateau', 'red', 'stop'];
const WHEELS = ['running', 'requested', 'handed'];

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const isTime = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0;
// eslint-disable-next-line no-control-regex
const text = (v, max, roots) => (typeof v === 'string' ? scrubPaths(v, roots).replace(/[\x00-\x1f\x7f]+/g, ' ').trim().slice(0, max) : '');
const count = (v) => (Number.isFinite(v) && v > 0 ? Math.min(MAX_COUNT, Math.floor(v)) : 0);
const money = (v) => (Number.isFinite(v) && v > 0 ? Math.round(v * 100) / 100 : 0);
const word = (v) => (typeof v === 'string' && WORD_RE.test(v) ? v : null);
const hours = (v) => (Number.isFinite(v) && v >= 0 ? Math.round(v * 10) / 10 : null);
const bytesOf = (v) => new TextEncoder().encode(JSON.stringify(v)).length;
const tokensOf = (u) => (isObj(u) ? count(u.inputTokens) + count(u.outputTokens) + count(u.cacheReadTokens) + count(u.cacheWriteTokens) : 0);

function cleanScores(raw, roots) {
  return (Array.isArray(raw) ? raw : [])
    .filter(isObj)
    .slice(-MAX_MILESTONES)
    .map((m) => ({
      milestone: text(m.milestone, MAX_NAME, roots),
      points: (Array.isArray(m.points) ? m.points : [])
        .filter((p) => isObj(p) && Number.isInteger(p.n) && Number.isFinite(p.score))
        .slice(-MAX_SCORES)
        .map((p) => ({ n: count(p.n), score: Math.max(0, Math.min(100, Math.round(p.score))) })),
    }))
    .filter((m) => m.points.length);
}

function cleanTokens(raw) {
  return (Array.isArray(raw) ? raw : [])
    .filter((r) => isObj(r) && word(r.role))
    .slice(0, MAX_ROLES)
    .map((r) => ({ role: r.role, tokens: count(r.tokens), costUsd: money(r.costUsd) }));
}

function cleanEta(raw) {
  if (!isObj(raw) || !Number.isInteger(raw.iterations) || raw.iterations < 0) return null;
  return { iterations: Math.min(999, raw.iterations), hours: hours(raw.hours), low: hours(raw.low), high: hours(raw.high) };
}

function cleanShots(raw, roots) {
  return (Array.isArray(raw) ? raw : [])
    .filter((s) => isObj(s) && typeof s.src === 'string' && s.src.length <= MAX_THUMB_CHARS && THUMB_RE.test(s.src))
    .slice(0, MAX_SHOTS)
    .map((s) => ({ name: text(s.name, MAX_NAME, roots), n: count(s.n), src: s.src }));
}

/** Drops the heaviest optional parts until the snapshot fits MAX_BYTES. */
function capSize(snap) {
  let out = snap;
  while (out.shots.length && bytesOf(out) > MAX_BYTES) out = { ...out, shots: out.shots.slice(0, -1) };
  while (out.feedback.length && bytesOf(out) > MAX_BYTES) out = { ...out, feedback: out.feedback.slice(1) };
  while (out.scores.length && bytesOf(out) > MAX_BYTES) out = { ...out, scores: out.scores.slice(1) };
  return bytesOf(out) > MAX_BYTES ? { ...out, decisions: [] } : out;
}

/**
 * A snapshot, writer or reader side, or null. Never throws.
 * @param {unknown} raw
 * @param {number} [now]
 * @param {string[]} [roots] local roots to cut out (writer side)
 */
function cleanSnapshot(raw, now = Date.now(), roots = []) {
  try {
    if (!isObj(raw) || raw.v !== VERSION || typeof raw.runId !== 'string' || !RUN_ID_RE.test(raw.runId)) return null;
    const cards = isObj(raw.cards) ? raw.cards : {};
    const total = isObj(raw.total) ? raw.total : {};
    return capSize({
      v: VERSION,
      at: isTime(raw.at) ? Math.min(raw.at, now) : now,
      runId: raw.runId,
      repoName: text(raw.repoName, MAX_NAME, roots),
      active: raw.active === true,
      phase: word(raw.phase),
      role: word(raw.role),
      iteration: count(raw.iteration),
      milestone: text(raw.milestone, MAX_TEXT, roots),
      verdict: VERDICTS.includes(raw.verdict) ? raw.verdict : null,
      wheel: WHEELS.includes(raw.wheel) ? raw.wheel : 'running',
      startedAt: isTime(raw.startedAt) ? Math.min(raw.startedAt, now) : null,
      scores: cleanScores(raw.scores, roots),
      tokens: cleanTokens(raw.tokens),
      total: { tokens: count(total.tokens), costUsd: money(total.costUsd) },
      cards: { opened: count(cards.opened), closed: count(cards.closed) },
      decisions: (Array.isArray(raw.decisions) ? raw.decisions : [])
        .filter((d) => isObj(d) && Number.isSafeInteger(d.id))
        .slice(0, MAX_DECISIONS)
        .map((d) => ({ id: d.id, kind: word(d.kind) || 'other', question: text(d.question, MAX_TEXT, roots) }))
        .filter((d) => d.question),
      feedback: (Array.isArray(raw.feedback) ? raw.feedback : [])
        .filter((f) => isObj(f) && Number.isSafeInteger(f.id))
        .slice(-MAX_FEEDBACK)
        .map((f) => ({ id: f.id, text: text(f.text, MAX_NAME, roots), status: word(f.status) || 'new' }))
        .filter((f) => f.text),
      eta: cleanEta(raw.eta),
      shots: cleanShots(raw.shots, roots),
    });
  } catch {
    return null;
  }
}

/** Scores per milestone ({milestone: [{n, score}]}, status().scores) as a list. */
const scoreList = (byMilestone) =>
  Object.entries(isObj(byMilestone) ? byMilestone : {}).map(([milestone, points]) => ({ milestone, points }));

/** Tokens and cost per role from the run's usage ledger, biggest first. */
function tokenRows(ledger) {
  const byRole = isObj(ledger) && isObj(ledger.byRole) ? ledger.byRole : {};
  return Object.entries(byRole)
    .map(([role, u]) => ({ role, tokens: tokensOf(u), costUsd: isObj(u) ? u.costUsd : 0 }))
    .filter((r) => r.tokens || r.costUsd)
    .sort((a, b) => b.tokens - a.tokens);
}

/** Cards opened / closed over the run's laps. */
function cardTotals(laps) {
  const list = (Array.isArray(laps) ? laps : []).filter(isObj);
  return {
    opened: list.reduce((s, l) => s + count(l.cardsOpened), 0),
    closed: list.reduce((s, l) => s + (Array.isArray(l.cardsClosed) ? l.cardsClosed.length : count(l.cardsClosed)), 0),
  };
}

/**
 * The phone snapshot of the current run, or null without one.
 * @param {{status?:object, run?:object|null, eta?:object|null, shots?:{name:string, n:number, src:string}[], now?:number}} ctx
 *   status = controller.status(); run = controller.snapshot(); shots = newest first
 */
function buildSnapshot({ status, run, eta = null, shots = [], now = Date.now() } = {}) {
  if (!isObj(status) || !status.runId || !isObj(run)) return null;
  const ledger = isObj(run.usage) ? run.usage : {};
  const feedback = isObj(status.feedback) && Array.isArray(status.feedback.items) ? status.feedback.items : [];
  const roots = [run.repoPath, run.evidenceDir, status.evidenceDir].filter((r) => typeof r === 'string');
  return cleanSnapshot(
    {
      v: VERSION,
      at: now,
      runId: status.runId,
      repoName: typeof run.repoPath === 'string' ? run.repoPath.split(/[\\/]+/).filter(Boolean).pop() : '',
      active: status.active === true,
      phase: status.phase,
      role: status.role,
      iteration: status.iteration,
      milestone: status.milestone,
      verdict: status.verdict,
      wheel: status.wheel,
      startedAt: status.startedAt,
      scores: scoreList(status.scores),
      tokens: tokenRows(ledger),
      total: { tokens: tokensOf(ledger.total), costUsd: isObj(ledger.total) ? ledger.total.costUsd : 0 },
      cards: cardTotals(run.laps),
      decisions: Array.isArray(status.pendingDecisions) ? status.pendingDecisions : [],
      feedback,
      eta,
      shots,
    },
    now,
    roots,
  );
}

/** The newest PC's Luna's Work section from `godmode` rows ({machine, data}), or null. */
function lunasworkFrom(rows, now = Date.now()) {
  const found = (Array.isArray(rows) ? rows : [])
    .filter((r) => isObj(r) && typeof r.machine === 'string' && MACHINE_RE.test(r.machine) && isObj(r.data))
    .map((r) => ({ machine: r.machine, snap: cleanSnapshot(r.data.lunaswork, now) }))
    .filter((r) => r.snap)
    .sort((a, b) => b.snap.at - a.snap.at);
  const top = found[0];
  return top ? { ...top.snap, machine: top.machine, stale: top.snap.active && now - top.snap.at > STALE_MS } : null;
}

/**
 * Throttled publishing: poke(build) on every phase change. `build` runs only
 * when a put is due, so the thumbnails are made at most once per minMs.
 * @param {{publish:(snap:object|null)=>unknown, minMs?:number, now?:()=>number,
 *   setTimer?:Function, clearTimer?:Function, log?:(line:string)=>void}} deps
 * @returns {{poke:(build:()=>object|null)=>void, flush:()=>void}}
 */
function createSnapshotThrottle({ publish, minMs = MIN_MS, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, log = () => {} }) {
  let lastAt = -Infinity;
  let lastKey = null;
  let pending = null;
  let timer = null;

  function send() {
    if (timer) clearTimer(timer);
    timer = null;
    const build = pending;
    pending = null;
    if (!build) return;
    lastAt = now();
    try {
      const snap = build();
      // `at` alone moving is not a change.
      const key = JSON.stringify(snap ? { ...snap, at: 0 } : null);
      if (key === lastKey) return;
      lastKey = key;
      Promise.resolve(publish(snap)).catch((err) => log(`[lunaswork] phone snapshot failed: ${err && err.message}`));
    } catch (err) {
      log(`[lunaswork] phone snapshot failed: ${err && err.message}`);
    }
  }

  function poke(build) {
    if (typeof build !== 'function') return;
    pending = build;
    const wait = lastAt + minMs - now();
    if (wait <= 0) {
      send();
      return;
    }
    if (!timer) {
      timer = setTimer(send, wait);
      if (timer && typeof timer.unref === 'function') timer.unref();
    }
  }

  return { poke, flush: send };
}

module.exports = {
  VERSION,
  MAX_BYTES,
  MAX_SHOTS,
  MIN_MS,
  STALE_MS,
  buildSnapshot,
  cleanSnapshot,
  lunasworkFrom,
  createSnapshotThrottle,
};
