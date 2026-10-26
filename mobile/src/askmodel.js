// ============================================================================
// LunaCore phone - "Ask Luna about the run" (pure, LW 2.27)
// ----------------------------------------------------------------------------
// A question goes to the PC as one unit in the `todos` cloud scope under
// `lunaswork-ask:<id>`, through the same outbox as every to-do write; the
// unit is built by the PC's own module (src/lunasworkAskModel.js), so the
// phone never sends a question the PC would refuse. The PC checks it again,
// caps it and rate-limits it (10 an hour), then publishes its answers as the
// `asks` section of its `godmode` snapshot.
// ============================================================================

import askLib from '../../src/lunasworkAskModel.js';

const { askUnit, asksFrom, ASK_LIST_KEY, MAX_QUESTION, MAX_ITEMS, cleanQuestion } = askLib;

export { askUnit, MAX_QUESTION };

// The PC never asks a phone question older than a day (lunasworkAsk MAX_PHONE_AGE_MS).
const SENT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Status ids with a localized label (i18n askStatus*); `sent` is the phone's own. */
const STATUS_KEYS = {
  sent: 'askStatusSent',
  answering: 'askStatusAnswering',
  answered: 'askStatusAnswered',
  limited: 'askStatusLimited',
  failed: 'askStatusFailed',
};

/** The i18n key of an item status. */
export const askStatusKey = (status) => (Object.hasOwn(STATUS_KEYS, status) ? STATUS_KEYS[status] : STATUS_KEYS.sent);

/** The tag tone of an item status. */
export function askStatusTone(status) {
  if (status === 'answered') return 'tag is-good';
  if (status === 'failed') return 'tag is-bad';
  if (status === 'limited') return 'tag is-warn';
  return 'tag';
}

/** i18n key of each source name the PC may cite. */
const SOURCE_KEYS = {
  'run-state': 'askSrcState',
  'run-report': 'askSrcReport',
  'PLAYTEST_LOG.md': 'askSrcPlaytest',
  'DECISIONS.md': 'askSrcDecisions',
  rollbacks: 'askSrcRollbacks',
};

/**
 * The cited sources as {key, iteration} for the view to localize.
 * @param {{file:string, iteration?:number}[]} sources
 * @returns {{key:string, iteration:number|null}[]}
 */
export function sourceLabels(sources) {
  return (Array.isArray(sources) ? sources : [])
    .filter((s) => s && Object.hasOwn(SOURCE_KEYS, s.file))
    .map((s) => ({ key: SOURCE_KEYS[s.file], iteration: Number.isInteger(s.iteration) ? s.iteration : null }));
}

/**
 * What to show: the newest PC's answered questions, plus the ones this phone
 * sent in the last day that the PC has not picked up yet (status `sent`),
 * newest first.
 * @param {object[]} rows parsed `godmode` rows
 * @param {Record<string, {v: unknown, u: number, d: number|null}>} mirror the `todos` mirror with the outbox over it
 * @param {number} now
 * @returns {{machine:string|null, items:object[]}}
 */
export function asksToShow(rows, mirror, now) {
  const section = asksFrom(rows);
  const items = section ? section.items : [];
  const known = new Set(items.map((i) => i.id));
  const prefix = `${ASK_LIST_KEY}:`;
  const sent = Object.entries(mirror || {})
    .filter(([k, row]) => k.startsWith(prefix) && row && row.d === null && row.v && typeof row.v.text === 'string')
    .map(([k, row]) => ({ id: Number(k.slice(prefix.length)), question: cleanQuestion(row.v.text), status: 'sent', answer: '', sources: [] }))
    .filter((i) => Number.isSafeInteger(i.id) && i.question && !known.has(i.id) && now - i.id < SENT_MAX_AGE_MS);
  return { machine: section ? section.machine : null, items: [...items, ...sent].sort((a, b) => b.id - a.id).slice(0, MAX_ITEMS) };
}
