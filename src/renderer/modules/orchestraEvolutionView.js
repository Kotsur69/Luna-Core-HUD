// ============================================================================
// LunaCore - God Mode board lines for the opt-in evolutions
// ----------------------------------------------------------------------------
// A package card's extra lines, from the view fields main adds only when a
// feature has something to show (src/orchestra.js evolutionViews):
//   ab       A/B builds (src/orchestraVariantRun.js): a group building /
//            under review / decided, or a variant of one
//   heal     self-healing workers (src/orchestraHeal.js): fix running / spent
//   context  context guard (src/orchestraContextGuard.js): /compact sent, or
//            the next resume gets a progress summary
// Pure: returns [{text, cls}] like orchestraHybridView.hybridLines.
// ============================================================================

'use strict';

import { t } from './util.js';

const HEAL_KINDS = ['deps', 'lock', 'permission'];
const DECIDED_BY = ['critic', 'only', 'fallback'];

const keyText = (key) => String(key || '').toUpperCase();
const healKindText = (kind) => (HEAL_KINDS.includes(kind) ? t(`orch.heal.kind.${kind}`) : String(kind || ''));

function labelOf(ab, key) {
  const v = Array.isArray(ab.variants) ? ab.variants.find((x) => x && x.key === key) : null;
  return v && typeof v.label === 'string' ? v.label : '';
}

/** A group's lines: building / under review, or the winner and the kept loser branch. */
function groupLines(ab) {
  if (!ab.winner) {
    if (ab.reviewing) return [{ text: t('orch.ab.reviewing'), cls: 'is-warn' }];
    return [{ text: t('orch.ab.building', { a: labelOf(ab, 'a'), b: labelOf(ab, 'b') }), cls: '' }];
  }
  const by = DECIDED_BY.includes(ab.by) ? t(`orch.ab.by.${ab.by}`) : '';
  const reasons = Array.isArray(ab.reasons) ? ab.reasons.slice(0, 2).join('; ') : '';
  const out = [{ text: t('orch.ab.won', { key: keyText(ab.winner), label: labelOf(ab, ab.winner), by }), cls: '' }];
  if (reasons) out.push({ text: reasons, cls: '' });
  const loser = Array.isArray(ab.losers) ? ab.losers[0] : null;
  if (loser) out.push({ text: t('orch.ab.lost', { key: keyText(loser.key), label: loser.label || labelOf(ab, loser.key), branch: loser.branch || '?' }), cls: '' });
  return out;
}

/**
 * @param {{ab?:object, heal?:{heals:string[], healing:string|null}, context?:{percent:number|null,
 *   etaMs:number|null, compacted:boolean, resumeMarked:boolean}}} pkg a package of the plan view
 * @returns {Array<{text:string, cls:string}>}
 */
export function evolutionLines(pkg) {
  const out = [];
  const ab = pkg && pkg.ab;
  if (ab && ab.role === 'group') out.push(...groupLines(ab));
  if (ab && ab.role === 'variant') {
    const key = ab.built ? 'orch.ab.variantBuilt' : 'orch.ab.variant';
    out.push({ text: t(key, { key: keyText(ab.key), label: ab.label || '', of: ab.of || '' }), cls: '' });
  }
  const heal = pkg && pkg.heal;
  if (heal && heal.healing) out.push({ text: t('orch.heal.running', { kind: healKindText(heal.healing) }), cls: 'is-warn' });
  else if (heal && Array.isArray(heal.heals) && heal.heals.length) {
    out.push({ text: t('orch.heal.spent', { kinds: heal.heals.map(healKindText).join(', ') }), cls: '' });
  }
  const context = pkg && pkg.context;
  if (context && context.resumeMarked) out.push({ text: t('orch.ctx.resume'), cls: 'is-warn' });
  else if (context && context.compacted) out.push({ text: t('orch.ctx.compacted', { percent: context.percent == null ? '?' : context.percent }), cls: '' });
  return out;
}

/** An A/B group that has not picked its winner: no Launch / Retry of its own (its variants have them). */
export const isUndecidedGroup = (pkg) => !!(pkg && pkg.ab && pkg.ab.role === 'group' && !pkg.ab.winner);
