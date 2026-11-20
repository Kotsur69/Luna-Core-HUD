// ============================================================================
// LunaCore - per-model summary of a God Mode "Workers" pool run (pure)
// ----------------------------------------------------------------------------
// One row per ticked model (strongest first), plus "Opus (emergency)" when
// Opus took packages over without being ticked (src/orchestraRescue.js):
//
//   planned     packages the planner put on the model
//   landed      packages that ended on it pushed
//   stalled     packages that ended on it stalled or failed
//   escalated   escalations away from it
//   emergency   its packages emergency Opus took over (the emergency row:
//               every package it took)
//   limitMoves  not-started packages moved off it because it was out
//   wallMs      wall time of the packages that ended on it (start of their
//               last attempt to finish, or to `now` while running)
//
// The morning report (src/orchestraReport.js) prints it with every move,
// the phone (src/godmodesnapshot.js) shows the rows. Null for a run without
// a pool. Pure, no I/O.
// ============================================================================

'use strict';

const { normalizePool, poolKeys } = require('./workerPool');
const { OPUS, keyLabel, rescueText, isPoolPlan } = require('./orchestraRescue');

/** The emergency row's key: Opus on Claude, not ticked. */
const EMERGENCY_ROW = 'opus-emergency';
const STALLED_STATES = new Set(['stalled', 'failed']);
const MAX_MOVE_LINES = 60;

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const list = (v) => (Array.isArray(v) ? v.filter(isObj) : []);

/** The row a package ends on: the emergency row, its last rescue's key, else its planned key. */
function finalRow(p) {
  if (p.emergency === true && p.rescueKey === OPUS) return EMERGENCY_ROW;
  return typeof p.rescueKey === 'string' && p.rescueKey ? p.rescueKey : p.poolModel;
}

/** Wall time of a package's last attempt: to finishedAt, to `now` while running, else 0. */
function wallOf(p, now) {
  if (!Number.isFinite(p.startedAt)) return 0;
  const running = p.state === 'launched' || p.state === 'finishing';
  const end = Number.isFinite(p.finishedAt) ? p.finishedAt : running && Number.isFinite(now) ? now : null;
  return end !== null && end > p.startedAt ? end - p.startedAt : 0;
}

const emptyRow = (key, name) => ({ key, name, planned: 0, landed: 0, stalled: 0, escalated: 0, emergency: 0, limitMoves: 0, wallMs: 0 });

/**
 * The per-model rows of a pool run, else null.
 * @param {{modelPool?:unknown, packages?:unknown}} view orchestra view()
 * @param {number} [now] epoch ms, for packages still running
 * @returns {{key:string, name:string, planned:number, landed:number, stalled:number,
 *   escalated:number, emergency:number, limitMoves:number, wallMs:number}[]|null}
 */
function poolModelSummary(view, now = Date.now()) {
  // A pool run proper (worker model 'plan'): a plan run keeps its own pool and gets no rows.
  if (!isPoolPlan(view)) return null;
  const pool = normalizePool(view.modelPool);
  const rows = new Map(poolKeys(pool).map((k) => [k, emptyRow(k, keyLabel(k))]));
  const packages = list(view.packages);
  const rowOf = (key) => {
    if (key === EMERGENCY_ROW && !rows.has(key)) rows.set(key, emptyRow(key, `${keyLabel(OPUS)} (emergency)`));
    return rows.get(key) || null;
  };
  for (const p of packages) {
    const planned = rows.get(p.poolModel);
    if (planned) planned.planned += 1;
    for (const r of list(p.rescues)) {
      const from = rows.get(r.from);
      if (!from) continue;
      if (r.kind === 'escalate') from.escalated += 1;
      if (r.kind === 'limit') from.limitMoves += 1;
    }
    const end = rowOf(finalRow(p));
    if (!end) continue;
    if (p.state === 'pushed') end.landed += 1;
    else if (STALLED_STATES.has(p.state) || p.terminal === true) end.stalled += 1;
    end.wallMs += wallOf(p, now);
    if (end.key === EMERGENCY_ROW) {
      end.emergency += 1;
      if (planned) planned.emergency += 1;
    }
  }
  return [...rows.values()];
}

/** Every rescue move of a pool run, oldest first: [{id, text, at}]. */
function poolMoves(view) {
  if (!isObj(view)) return [];
  const moves = [];
  for (const p of list(view.packages)) {
    for (const r of list(p.rescues)) moves.push({ id: String(p.id || ''), text: rescueText(r), at: Number.isFinite(r.at) ? r.at : 0 });
  }
  return moves.sort((a, b) => a.at - b.at).slice(0, MAX_MOVE_LINES);
}

/** Minutes, rounded, as the report reads them ('12 min', '-' for none). */
function minutes(ms) {
  return ms > 0 ? `${Math.max(1, Math.round(ms / 60000))} min` : '-';
}

/** One table cell: one line, no pipe breaking the row. */
const cell = (v) => String(v == null ? '' : v).replace(/[\r\n]+/g, ' ').replace(/\|/g, '\\|');

/**
 * The morning report's per-model section of a pool run; [] otherwise.
 * @param {object} view
 * @param {number} [now]
 * @returns {string[]} markdown lines
 */
function poolSummaryLines(view, now = Date.now()) {
  const rows = poolModelSummary(view, now);
  if (!rows) return [];
  const moves = poolMoves(view);
  return [
    '',
    '## Per model (pool run)',
    '',
    '| Model | Planned | Landed | Stalled | Escalated | Emergency Opus | Limit moves | Wall time |',
    '|---|---|---|---|---|---|---|---|',
    ...rows.map((r) => `| ${cell(r.name)} | ${r.planned} | ${r.landed} | ${r.stalled} | ${r.escalated} | ${r.emergency} | ${r.limitMoves} | ${minutes(r.wallMs)} |`),
    ...(moves.length ? ['', '### Model moves', '', ...moves.map((m) => `- \`${cell(m.id).replace(/`/g, "'")}\`: ${cell(m.text)}`)] : []),
  ];
}

module.exports = { EMERGENCY_ROW, poolModelSummary, poolMoves, poolSummaryLines };
