// ============================================================================
// LunaCore phone - Luna's Work mid-run feedback (pure, B17)
// ----------------------------------------------------------------------------
// The PC publishes its current run's feedback section in the `godmode`
// snapshot (src/lunasworkFeedback.js publicFeedback): the run id the form
// writes for, and each item with its status. New feedback goes back as one
// unit in the `todos` cloud scope under `lunaswork-feedback:<id>`, through
// the same outbox as every to-do write. The unit is built by the PC's own
// module, so the phone never sends feedback the PC would refuse.
// ============================================================================

import feedbackLib from '../../src/lunasworkFeedback.js';

const { feedbackUnit, FEEDBACK_LIST_KEY, MAX_TEXT } = feedbackLib;

export { feedbackUnit, MAX_TEXT };

/** Status ids with a localized label (i18n feedbackStatus*); `sent` is the phone's own. */
const STATUS_KEYS = {
  sent: 'feedbackStatusSent',
  new: 'feedbackStatusNew',
  waiting: 'feedbackStatusWaiting',
  planned: 'feedbackStatusPlanned',
  built: 'feedbackStatusBuilt',
  verified: 'feedbackStatusVerified',
  declined: 'feedbackStatusDeclined',
  noted: 'feedbackStatusNoted',
};

/** The i18n key of an item status. */
export const statusKey = (status) => (Object.hasOwn(STATUS_KEYS, status) ? STATUS_KEYS[status] : STATUS_KEYS.new);

/** The tag tone of an item status. */
export function statusTone(status) {
  if (status === 'verified') return 'tag is-good';
  if (status === 'declined') return 'tag is-bad';
  if (status === 'waiting') return 'tag is-warn';
  return 'tag';
}

/**
 * The items to show: what the PC published, plus what this phone sent for
 * the same run that the PC has not picked up yet (status `sent`), oldest first.
 * @param {{runId: string, items: object[]}|null} section godmodeFeedbackFrom output
 * @param {Record<string, {v: unknown, u: number, d: number|null}>} mirror the `todos` mirror with the outbox over it
 * @returns {object[]}
 */
export function itemsToShow(section, mirror) {
  if (!section) return [];
  const known = new Set(section.items.map((i) => i.id));
  const prefix = `${FEEDBACK_LIST_KEY}:`;
  const sent = Object.entries(mirror || {})
    .filter(([k, row]) => k.startsWith(prefix) && row && row.d === null && row.v && row.v.runId === section.runId && typeof row.v.text === 'string')
    .map(([k, row]) => ({ id: Number(k.slice(prefix.length)), author: 'mati', text: row.v.text.slice(0, MAX_TEXT), status: 'sent', cards: 0 }))
    .filter((i) => Number.isSafeInteger(i.id) && !known.has(i.id));
  return [...section.items, ...sent].sort((a, b) => a.id - b.id);
}
