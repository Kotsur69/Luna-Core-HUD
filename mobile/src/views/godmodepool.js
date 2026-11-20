// ============================================================================
// LunaCore phone - God Mode: a pool run's per-model summary
// ----------------------------------------------------------------------------
// A "Workers" pool run (2+ ticked models) carries `poolModels` on its live
// entry and its finished-run entry (src/orchestraPoolSummary.js, cleaned by
// src/godmodesnapshot.js): one row per ticked model, plus "Opus (emergency)"
// when Opus took packages over without being ticked. Each row reads as one
// line: planned / landed / stalled / escalated / taken by emergency Opus /
// limit moves / wall time - only the counts that are not zero.
// Every string goes in as text.
// ============================================================================

import { h } from '../dom.js';
import { t, tf } from '../i18n.js';

/** The emergency row's key (src/orchestraPoolSummary.js EMERGENCY_ROW). */
const EMERGENCY_ROW = 'opus-emergency';
const MINUTE = 60 * 1000;
/** Count fields in line order, with their i18n keys. */
const PARTS = [
  ['planned', 'godmodePoolPlanned'],
  ['landed', 'godmodePoolLanded'],
  ['stalled', 'godmodePoolStalled'],
  ['escalated', 'godmodePoolEscalated'],
  ['emergency', 'godmodePoolEmergencyTaken'],
  ['limitMoves', 'godmodePoolLimitMoves'],
];

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * One row as text: 'Argon (agy): 3 planned · 2 landed · 1 to emergency Opus · 12 min'.
 * @param {object} row a cleaned poolModels row
 * @param {(key:string, params?:object) => string} tfn tf()
 * @param {(key:string) => string} tn t()
 * @returns {string}
 */
export function poolRowText(row, tfn = tf, tn = t) {
  if (!isObj(row)) return '';
  const name = row.key === EMERGENCY_ROW ? tn('godmodePoolEmergency') : String(row.name || row.key || '');
  const parts = PARTS.filter(([k]) => Number.isFinite(row[k]) && row[k] > 0).map(([k, key]) => tfn(key, { n: row[k] }));
  const min = Number.isFinite(row.wallMs) && row.wallMs > 0 ? Math.max(1, Math.round(row.wallMs / MINUTE)) : 0;
  if (min) parts.push(tfn('godmodePoolWall', { min }));
  return `${name}: ${parts.length ? parts.join(' · ') : tn('godmodePoolNone')}`;
}

/**
 * The per-model block of a run, or null for a run without a pool.
 * @param {{poolModels?:unknown}} run a live entry or a finished-run entry
 * @returns {HTMLElement|null}
 */
export function poolModelsBlock(run) {
  const rows = isObj(run) && Array.isArray(run.poolModels) ? run.poolModels.filter(isObj) : [];
  if (!rows.length) return null;
  return h(
    'div',
    { class: 'stack-sm gm-pool-models' },
    h('h3', { class: 'hint' }, t('godmodePoolModels')),
    h('ul', { class: 'list' }, ...rows.map((r) => h('li', { class: 'hint' }, poolRowText(r)))),
  );
}
