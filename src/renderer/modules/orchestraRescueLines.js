// ============================================================================
// LunaCore - a pool package's rescue lines on the God Mode board
// ----------------------------------------------------------------------------
// main keeps each move of a pool package on pkg.rescues (src/orchestraRescue.js):
// escalations up the ticked models, limit moves, hand-overs of a free package,
// and whether Opus took it as an emergency. One card line per move:
//
//   escalated: Sonnet -> Argon (agy)
//   Argon (agy) limit -> Opus (emergency, xhigh)
//   handed over: free -> Opus (emergency, high)
//   guard: Hydrogen (agy) -> Argon (agy)     (the weak-model guard)
//
// Pure (the translator is passed in), so node tests import it without a DOM.
// ============================================================================

'use strict';

import { poolModelName } from '../../workerPool.js';

const KINDS = Object.freeze({
  escalate: 'orch.rescue.escalate',
  limit: 'orch.rescue.limit',
  handOver: 'orch.rescue.handOver',
  guard: 'orch.rescue.guard',
});
/** Lines a card shows at most (the newest). */
const MAX_LINES = 4;
const LEVEL_RE = /^(medium|high|xhigh|max)$/;

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/** A pool key's name: 'Argon (agy)', the free label, else the key itself. */
function nameOf(key, t) {
  if (key === 'free') return t('orch.pkgModel.free');
  return poolModelName(key) || String(key || '?');
}

/** The target's name, with "emergency" and the effort Opus runs at. */
function targetOf(entry, t) {
  const name = nameOf(entry.to, t);
  if (entry.emergency !== true) return name;
  const effort = typeof entry.effort === 'string' && LEVEL_RE.test(entry.effort) ? entry.effort : null;
  return effort ? t('orch.rescue.emergencyEffort', { name, effort }) : t('orch.rescue.emergency', { name });
}

/**
 * Why the weak-model guard (src/orchestraWeakGuard.js) moved a package off the
 * easiest agy tier; null when it did not. Reasons use the hybrid guard's texts.
 * @param {{weakGuard?:unknown}|null} pkg a plan view package
 * @param {(key:string, params?:object) => string} t
 * @returns {string|null}
 */
export function weakGuardLine(pkg, t) {
  const g = isObj(pkg) && isObj(pkg.weakGuard) ? pkg.weakGuard : null;
  if (!g || !Array.isArray(g.reasons) || !g.reasons.length) return null;
  const reasons = g.reasons.filter(isObj).map((r) => t(`orch.hybrid.r.${r.code}`, { n: r.n, kind: r.kind, file: r.file }));
  return t('orch.weakGuard.moved', { from: nameOf(g.from, t), reasons: reasons.join('; ') });
}

/**
 * The board lines of a package's rescues, oldest first; [] for none.
 * @param {{rescues?:unknown}|null} pkg a plan view package
 * @param {(key:string, params?:object) => string} t
 * @returns {string[]}
 */
export function rescueLines(pkg, t) {
  const list = isObj(pkg) && Array.isArray(pkg.rescues) ? pkg.rescues : [];
  return list
    .filter((e) => isObj(e) && Object.prototype.hasOwnProperty.call(KINDS, e.kind))
    .slice(-MAX_LINES)
    .map((e) => t(KINDS[e.kind], { from: nameOf(e.from, t), to: targetOf(e, t) }));
}
