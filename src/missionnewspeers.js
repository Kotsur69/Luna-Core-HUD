// ============================================================================
// LunaCore - Mission Control: other PCs' news briefings (main)
// ----------------------------------------------------------------------------
// docs/CLOUD_SYNC_PLAN.md phase 2c. Every PC puts its last briefing as the
// `news` cloud snapshot (missionnews.js newsSnapshot); this reads the other
// machines' rows and turns each into a read-only report for "Ready reports".
//
// A row is written by another machine: untrusted. Version, language and time
// are checked, every string is capped, every link is re-validated with
// safeUrl() (missionnewsrows.js, shared with the phone). Like a local scan, the renderer gets entry keys and never a URL;
// mission:news-open resolves a key here. Text is LLM output over fetched
// pages - the renderer shows it as text only.
// ============================================================================

'use strict';

const crypto = require('crypto');
const { parseNewsPeer, MAX_SECTIONS, MAX_ENTRIES } = require('./missionnewsrows');

/**
 * Keys from recent lists that still open; the oldest fall out first. Above
 * one list's worst case (16 rows x 30 sections x 25 entries), so a list never
 * evicts keys it just handed out.
 */
const MAX_KEYS = 2 * 16 * MAX_SECTIONS * MAX_ENTRIES;

/**
 * @param {{cloud: () => ({list: Function}|null), now?: () => number}} deps
 *   cloud = cloudsnapshots.js getter; null while the cloud is off.
 */
function createNewsPeers({ cloud, now = Date.now }) {
  const known = new Map(); // key -> url, insertion order = age

  return {
    /** Other PCs' last briefings, newest first; a failing cloud is none. */
    async list() {
      let rows = [];
      try {
        const live = cloud();
        rows = live ? await live.list('news') : [];
      } catch (err) {
        console.error('[mission] news from other PCs unreadable:', err && err.message);
      }
      const listId = crypto.randomBytes(4).toString('hex');
      const at = now();
      const reports = [];
      for (const r of Array.isArray(rows) ? rows : []) {
        const parsed = parseNewsPeer(r, at, listId);
        if (!parsed) continue;
        for (const [k, u] of parsed.urls) known.set(k, u);
        reports.push(parsed.report);
      }
      for (const key of known.keys()) {
        if (known.size <= MAX_KEYS) break;
        known.delete(key);
      }
      return reports.sort((a, b) => b.at - a.at);
    },

    urlFor: (key) => (typeof key === 'string' && known.get(key)) || null,
  };
}

module.exports = { parseNewsPeer, createNewsPeers };
