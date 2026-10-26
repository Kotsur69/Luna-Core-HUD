// ============================================================================
// LunaCore phone - Luna's Work decision answers (pure)
// ----------------------------------------------------------------------------
// The PC publishes the decisions waiting for Mati in its `godmode` snapshot
// (src/lunasworkDecisions.js publicDecision). An answer goes back as one unit
// in the `todos` cloud scope under `lunaswork-answer:<id>`, through the same
// outbox as every to-do write. The unit is built by the PC's own module, so
// the phone never sends an answer the PC would refuse.
// ============================================================================

import decisionsLib from '../../src/lunasworkDecisions.js';

const { answerUnit, answerKey } = decisionsLib;

export { answerUnit };

/** Option ids with a localized label (i18n decisionOption*). */
const KNOWN_OPTIONS = { approve: 'decisionOptionApprove', reject: 'decisionOptionReject', yes: 'decisionOptionYes', no: 'decisionOptionNo' };
const KNOWN_KINDS = {
  dependency: 'decisionKindDependency',
  migration: 'decisionKindMigration',
  featureDelete: 'decisionKindFeatureDelete',
  designChange: 'decisionKindDesignChange',
  stuckCard: 'decisionKindStuckCard',
  outOfScope: 'decisionKindOutOfScope',
  feedbackScope: 'decisionKindFeedbackScope',
  clientScope: 'decisionKindClientScope',
};

/** The i18n key of a known option, or null (the option is shown as sent). */
export const optionKey = (option) => (Object.hasOwn(KNOWN_OPTIONS, option) ? KNOWN_OPTIONS[option] : null);

/** The i18n key of a decision kind. */
export const kindKey = (kind) => (Object.hasOwn(KNOWN_KINDS, kind) ? KNOWN_KINDS[kind] : 'decisionKindOther');

/**
 * What this phone already sent for `decision`, or null: the `todos` mirror
 * (with the outbox laid over it) holds the answer unit for this run.
 * @param {Record<string, {v: unknown, u: number, d: number|null}>} mirror
 * @param {{id: number, runId: string|null}} decision
 * @returns {string|null}
 */
export function sentAnswer(mirror, decision) {
  const key = answerKey(decision.id);
  const row = mirror && Object.hasOwn(mirror, key) ? mirror[key] : null;
  const v = row && row.d === null ? row.v : null;
  return v && typeof v === 'object' && v.runId === decision.runId && typeof v.answer === 'string' ? v.answer : null;
}
