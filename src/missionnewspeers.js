// ============================================================================
// LunaCore - Mission Control: other PCs' news briefings (main)
// ----------------------------------------------------------------------------
// docs/CLOUD_SYNC_PLAN.md phase 2c. Every PC puts its last briefing as the
// `news` cloud snapshot (missionnews.js newsSnapshot); this reads the other
// machines' rows and turns each into a read-only report for "Ready reports".
//
// A row is written by another machine: untrusted. Version, language and time
// are checked, every string is capped, every link is re-validated with
// safeUrl(). Like a local scan, the renderer gets entry keys and never a URL;
// mission:news-open resolves a key here. Text is LLM output over fetched
// pages - the renderer shows it as text only.
// ============================================================================

'use strict';

const crypto = require('crypto');
const { safeUrl } = require('./missionnews');

const LANGS = ['pl', 'en'];
const MACHINE_RE = /^[A-Za-z0-9-]{1,63}$/;
const PLATFORM_RE = /^[a-z]{1,20}$/;
const MAX_BRIEFING = 10;
const MAX_BULLET = 600;
const MAX_SECTIONS = 30;
const MAX_ENTRIES = 25;
const MAX_LABEL = 120;
const MAX_SUMMARY = 2000;
const MAX_TITLE = 300;
const MAX_PUBLISHED = 40;
/**
 * Keys from recent lists that still open; the oldest fall out first. Above
 * one list's worst case (16 rows x 30 sections x 25 entries), so a list never
 * evicts keys it just handed out.
 */
const MAX_KEYS = 2 * 16 * MAX_SECTIONS * MAX_ENTRIES;

const clip = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

const PRIVATE_V4 = [/^127\./, /^10\./, /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./, /^169\.254\./, /^0\./];

/**
 * Whether a link points at the public internet. A peer's row must not be able
 * to steer a click at this PC or its network (router, NAS, a local dev
 * server): loopback, private and link-local addresses, single-label and
 * .local / .internal names are refused. Local scans keep plain safeUrl().
 */
function isPublicHost(url) {
  const host = new URL(url).hostname.toLowerCase();
  if (host.startsWith('[')) {
    const v6 = host.slice(1, -1);
    return !(v6 === '::1' || v6 === '::' || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6) || v6.startsWith('::ffff:'));
  }
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return !PRIVATE_V4.some((re) => re.test(host));
  if (!host.includes('.') || host === 'localhost' || /\.(localhost|local|internal|lan|home\.arpa)$/.test(host)) return false;
  return true;
}

/** One snapshot section -> a renderer section (its key -> url pairs go into `urls`), or null. */
function parseSection(raw, prefix, urls) {
  if (!isObject(raw) || typeof raw.platform !== 'string' || !PLATFORM_RE.test(raw.platform)) return null;
  const entries = [];
  const picks = [];
  for (const e of Array.isArray(raw.entries) ? raw.entries : []) {
    if (entries.length >= MAX_ENTRIES) break;
    const url = isObject(e) ? safeUrl(e.url) : null;
    if (!url || !isPublicHost(url)) continue;
    const key = `${prefix}-${entries.length}`;
    urls.set(key, url);
    entries.push({ key, title: clip(e.title, MAX_TITLE), published: clip(e.published, MAX_PUBLISHED) || null });
    if (e.pick === true) picks.push(key);
  }
  return {
    id: prefix,
    label: clip(raw.label, MAX_LABEL),
    platform: raw.platform,
    kind: raw.kind === 'topic' ? 'topic' : 'source',
    ok: true,
    error: null,
    summary: clip(raw.summary, MAX_SUMMARY),
    picks,
    entries,
  };
}

/**
 * A `news` row from cloudsnapshots.list() -> {report, urls} or null.
 * `listId` makes the entry keys unique across lists.
 */
function parseNewsPeer(row, now, listId) {
  if (!isObject(row) || typeof row.machine !== 'string' || !MACHINE_RE.test(row.machine)) return null;
  const d = row.data;
  if (!isObject(d) || d.v !== 1 || !LANGS.includes(d.lang) || !Array.isArray(d.sections)) return null;
  if (!Number.isFinite(d.at) || d.at <= 0) return null;
  const urls = new Map();
  const sections = [];
  for (const raw of d.sections.slice(0, MAX_SECTIONS)) {
    const s = parseSection(raw, `${listId}-${row.machine}-${sections.length}`, urls);
    if (s) sections.push(s);
  }
  const briefing = (Array.isArray(d.briefing) ? d.briefing : [])
    .filter((b) => typeof b === 'string' && b)
    .slice(0, MAX_BRIEFING)
    .map((b) => b.slice(0, MAX_BULLET));
  const report = {
    id: `peer-${row.machine}`,
    peer: true,
    machine: row.machine,
    // A far-future clock must not pin a report to the top.
    at: Math.min(d.at, now),
    names: [...new Set(sections.map((s) => s.label).filter(Boolean))].join(', '),
    briefing,
    sections,
  };
  return { report, urls };
}

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
