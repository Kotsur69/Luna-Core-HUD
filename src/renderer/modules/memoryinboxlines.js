// ============================================================================
// LunaCore - the memory window's status lines (renderer)
// ----------------------------------------------------------------------------
// The lines under the memory window's lists (memoryinbox.js): what capture
// proposed and what was approved, when capture last ran, and how
// memory_search answers on this PC. Split out of memoryinbox.js to keep that
// file under the size ceiling; it re-exports statsLine and searchLine.
// ============================================================================

'use strict';

import { t } from './util.js';

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
