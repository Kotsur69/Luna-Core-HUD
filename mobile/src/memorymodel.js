// ============================================================================
// LunaCore phone - the memory inbox page model (pure; test/mobilememorymodel.test.mjs)
// ----------------------------------------------------------------------------
// Luna Core Memory, post-phase-4 item 5. The Memory page lists what waits in
// a PC's memory inbox and sends Approve / Reject as signed commands
// (src/hostmemory.js). Which PCs take them: their `host` heartbeat says
// memory: true (HUD host mode). The list arrives as a memory.inbox answer,
// written by another machine: untrusted, so only known fields survive, each
// checked and capped. This file never builds HTML.
// ============================================================================

/** src/memoryrecord.js ID_RE. */
const ID_RE = /^[a-z0-9][a-z0-9-]{0,79}$/;
/** `global` or a normalised remote (memoryrecord.validProject); the PC checks it again. */
const PROJECT_RE = /^(global|[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*){1,7})$/;
const TYPE_RE = /^[a-z][a-z-]{0,19}$/;
const AREA_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_PROJECT = 110;
const MAX_TITLE = 200;
const MAX_BODY = 5000;
const MAX_SOURCE = 300;
/** More than the PC ever sends (src/hostmemory.js MAX_PHONE_ITEMS). */
export const MAX_ITEMS = 50;
const MAX_REFS = 5;
const MAX_COUNT = 9999;

const sameMachine = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const text = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
const count = (v) => (Number.isSafeInteger(v) && v >= 0 ? Math.min(v, MAX_COUNT) : 0);
const isProject = (p) => typeof p === 'string' && p.length <= MAX_PROJECT && PROJECT_RE.test(p) && !p.split('/').some((s) => s.endsWith('.'));

/** Parsed hosts (hostmodel.hostList) -> the ones whose memory inbox is reachable, order kept (online first). */
export function memoryHosts(hosts) {
  return (Array.isArray(hosts) ? hosts : []).filter((x) => x && x.memory === true && typeof x.machine === 'string');
}

/** The host to preselect: the current pick while it can, else the default host, else an online one, else the first. */
export function pickMemoryHost(hosts, current) {
  const list = memoryHosts(hosts);
  if (!list.length) return null;
  return list.find((x) => sameMachine(x.machine, current)) || list.find((x) => x.default) || list.find((x) => x.online) || list[0];
}

/** One untrusted entry -> a clean copy, or null. */
function cleanItem(raw) {
  if (!isObject(raw) || !isProject(raw.project) || typeof raw.id !== 'string' || !ID_RE.test(raw.id)) return null;
  const title = text(raw.title, MAX_TITLE).trim();
  if (!title) return null;
  const usefulness = Number.isInteger(raw.usefulness) && raw.usefulness >= 0 && raw.usefulness <= 100 ? raw.usefulness : null;
  return {
    key: `${raw.project}/${raw.id}`,
    project: raw.project,
    id: raw.id,
    type: typeof raw.type === 'string' && TYPE_RE.test(raw.type) ? raw.type : '',
    area: typeof raw.area === 'string' && AREA_RE.test(raw.area) ? raw.area : '',
    title,
    body: text(raw.body, MAX_BODY),
    clipped: raw.clipped === true,
    created: typeof raw.created === 'string' && DATE_RE.test(raw.created) ? raw.created : '',
    source: text(raw.source, MAX_SOURCE),
    usefulness,
    suggestedGlobal: raw.suggestedGlobal === true,
    outside: count(raw.outside),
    duplicates: count(raw.duplicates),
    supersedes: (Array.isArray(raw.supersedes) ? raw.supersedes : [])
      .filter((s) => typeof s === 'string' && s.trim())
      .slice(0, MAX_REFS)
      .map((s) => s.slice(0, MAX_TITLE)),
    similar: typeof raw.similar === 'string' && raw.similar.trim() ? raw.similar.slice(0, MAX_TITLE) : null,
  };
}

/**
 * A memory.inbox answer -> {items, total}. A malformed entry is dropped, a
 * repeated key kept once; total never reads below what is listed.
 */
export function inboxFrom(result) {
  const items = [];
  const seen = new Set();
  const raw = isObject(result) && Array.isArray(result.items) ? result.items.slice(0, MAX_ITEMS * 2) : [];
  for (const entry of raw) {
    const item = cleanItem(entry);
    if (!item || seen.has(item.key)) continue;
    seen.add(item.key);
    items.push(item);
    if (items.length >= MAX_ITEMS) break;
  }
  const total = isObject(result) && Number.isSafeInteger(result.total) ? Math.max(result.total, items.length) : items.length;
  return { items, total };
}

/** The memory.approve / memory.reject payload for an item, or null. */
export function decisionPayload(item) {
  if (!isObject(item) || !isProject(item.project) || typeof item.id !== 'string' || !ID_RE.test(item.id)) return null;
  return { project: item.project, id: item.id };
}

/** The inbox without the entry `key` (decided, or found gone): a new object. */
export function withoutItem(inbox, key) {
  const items = inbox.items.filter((i) => i.key !== key);
  const removed = inbox.items.length - items.length;
  return { items, total: Math.max(items.length, inbox.total - removed) };
}

/** An unknown refusal code from the PC is shown as it came, but never longer than this. */
const MAX_CODE = 80;

/**
 * A finished command (hostsend.js {status, result}) -> {ok: true, result} or
 * {ok: false, code}. A host's own "refused"/"failed" verdict inside a done
 * row counts as a refusal; a phone-side timeout is the code 'timeout'.
 */
export function outcomeOf(status, result) {
  const res = isObject(result) ? result : {};
  if (status === 'timeout') return { ok: false, code: 'timeout' };
  const verdict = typeof res.status === 'string' ? res.status : String(status || '');
  if (status !== 'done' || /^(refused|failed)/.test(verdict)) {
    const code = typeof res.error === 'string' && res.error ? res.error : verdict || 'failed';
    return { ok: false, code: code.slice(0, MAX_CODE) };
  }
  return { ok: true, result: res };
}

/** Refusals after which the entry is not in the PC's inbox any more: it leaves the list. */
const GONE = new Set(['notWaiting', 'notFound']);
export const isGone = (code) => GONE.has(code);

/** Host refusal codes with their own phone text (i18n key `memErr_<code>`). */
const KNOWN_ERRORS = new Set(['needsHud', 'notWaiting', 'notFound', 'unknownProject', 'badId', 'badProject', 'badPayload', 'failed', 'unknown-kind', 'timeout']);

/** A host refusal code -> its i18n key, or null (the code is shown as it came). */
export function refusalKey(code) {
  if (typeof code !== 'string' || !KNOWN_ERRORS.has(code)) return null;
  return `memErr_${code === 'unknown-kind' ? 'unknownKind' : code}`;
}
