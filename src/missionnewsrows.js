// ============================================================================
// LunaCore - news snapshot rows (pure, shared with the phone)
// ----------------------------------------------------------------------------
// docs/CLOUD_SYNC_PLAN.md phase 2c/4c. safeUrl() decides which links may leave
// a PC in the `news` snapshot (missionnews.js); parseNewsPeer() reads another
// machine's row back - on a PC (missionnewspeers.js) and on the phone
// (mobile/src/snapmodel.js). No fs, no crypto: the phone bundles this file.
// ============================================================================

'use strict';

/** Longest link the cloud snapshot carries (the phone opens it as-is). */
const MAX_SNAPSHOT_URL = 2048;
/** Query parameters that look like a private feed's secret: such a link stays on the PC. */
const SECRET_PARAM_RE = /token|key|auth|sig|session|secret|password|code/i;

/**
 * A link fit to leave the PC: http(s) only, no credentials, no secret-looking
 * query parameter, no quote or angle bracket; normalised, fragment dropped.
 * Anything else -> null.
 */
function safeUrl(raw) {
  if (typeof raw !== 'string' || raw.length > MAX_SNAPSHOT_URL || /["'<>\s]/.test(raw)) return null;
  let u;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (!['https:', 'http:'].includes(u.protocol) || !u.hostname || u.username || u.password) return null;
  if ([...u.searchParams.keys()].some((k) => SECRET_PARAM_RE.test(k))) return null;
  u.hash = '';
  return u.href.length <= MAX_SNAPSHOT_URL ? u.href : null;
}

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

const clip = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

const PRIVATE_V4 = [
  /^127\./,
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^169\.254\./,
  /^0\./,
  // CGNAT / Tailscale, IETF protocol, benchmarking, multicast + reserved.
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
  /^192\.0\.0\./,
  /^198\.1[89]\./,
  /^(22[4-9]|2[3-5]\d)\./,
];

/**
 * Whether a link points at the public internet. A peer's row must not be able
 * to steer a click at this PC or its network (router, NAS, a local dev
 * server): loopback, private and link-local addresses, single-label and
 * .local / .internal names are refused. Local scans keep plain safeUrl().
 * Known limit: a public name that resolves to a private address (nip.io)
 * can't be caught from the string.
 */
function isPublicHost(url) {
  // "localhost." and "nas.local." are the same hosts as without the dot.
  const host = new URL(url).hostname.toLowerCase().replace(/\.+$/, '');
  if (host.startsWith('[')) {
    const v6 = host.slice(1, -1);
    // "::" prefixed forms (::1, ::7f00:1, ::ffff:a.b.c.d) embed or are local addresses; 64:ff9b:: is NAT64.
    return !(v6.startsWith('::') || v6.startsWith('64:ff9b:') || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6));
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

module.exports = { safeUrl, isPublicHost, parseNewsPeer, MAX_SECTIONS, MAX_ENTRIES };
