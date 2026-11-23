// ============================================================================
// LunaCore - the memory window's status lines (renderer)
// ----------------------------------------------------------------------------
// The lines under the memory window's lists (memoryinbox.js): what capture
// proposed and what was approved, when capture last ran, and how
// memory_search answers on this PC, why a memory is on the review list and why
// a graveyard entry was dropped. Split out of memoryinbox.js to keep that file
// under the size ceiling; it re-exports statsLine, searchLine, flagLine and graveLine.
// ============================================================================

'use strict';

import { t } from './util.js';

/** Why a confirmed memory is on the review list, in words (never by colour alone). */
export function flagLine(flag) {
  if (flag.kind === 'disputed' && flag.run) {
    // The note repeats "God Mode run <id>: " after an optional PR prefix; the line names the run itself.
    const note = String(flag.note || '').replace(`God Mode run ${flag.run}: `, '');
    return t('mem.inbox.review.disputedRun', { run: flag.run, note: note || '-' });
  }
  if (flag.kind === 'disputed') return t('mem.inbox.review.disputed', { note: flag.note || '-' });
  if (flag.kind === 'anchor') return t('mem.inbox.review.anchor', { files: (flag.missing || []).join(', ') });
  if (flag.kind === 'changed') return t('mem.inbox.review.changed', { files: (flag.files || []).join(', '), date: flag.last || '-' });
  if (flag.kind === 'unopened') return t('mem.inbox.review.unopened', { days: flag.days });
  // flag.when is model-written text: it only ever reaches the page through textContent.
  if (flag.kind === 'expired' && flag.when) return t('mem.inbox.review.expiredWhen', { date: flag.on || '-', when: flag.when });
  if (flag.kind === 'expired') return t('mem.inbox.review.expiredOn', { date: flag.on || '-' });
  return t('mem.inbox.review.stale', { since: flag.since });
}

/** Why a graveyard entry was dropped, in words: the usefulness floor with its score, or main's reason. */
export function graveLine(item) {
  if (item.reason === 'low usefulness') return t('mem.grave.low', { score: Number.isInteger(item.usefulness) ? item.usefulness : '?' });
  if (item.reason === 'moved to to-do') return t('mem.grave.moved');
  return t('mem.grave.reason', { reason: String(item.reason || '') });
}

/** What capture proposed in the last week and what became of it, or '' when there is nothing to say. */
export function statsLine(stats) {
  if (!stats || !(stats.proposed || stats.approved || stats.rejected)) return '';
  if (typeof stats.rate !== 'number') return t('mem.inbox.statsNone', { days: stats.days, proposed: stats.proposed });
  return t('mem.inbox.stats', { days: stats.days, proposed: stats.proposed, approved: stats.approved, rejected: stats.rejected, rate: Math.round(stats.rate * 100) });
}

/** When session capture last ran and what it saved, in words. */
export function captureLine(capture) {
  if (!capture || !capture.last) return t('mem.inbox.captureNever');
  const when = new Date(capture.last.at).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  return t('mem.inbox.captureLast', { when, saved: capture.last.saved });
}

const SEARCH_REASON_KEYS = {
  checking: 'mem.inbox.search.checking',
  building: 'mem.inbox.search.building',
  'no-server': 'mem.inbox.search.noServer',
  'no-model': 'mem.inbox.search.noModel',
  'not-local': 'mem.inbox.search.notLocal',
  failed: 'mem.inbox.search.failed',
};

/** How memory search answers on this PC: by meaning (which model) or by keywords only (why). '' when main did not say. */
export function searchLine(search) {
  if (!search) return '';
  if (search.mode === 'meaning') return t('mem.inbox.search.meaning', { model: search.model, embedded: search.embedded, total: search.total });
  return t(SEARCH_REASON_KEYS[search.reason] || SEARCH_REASON_KEYS.failed);
}
