// ============================================================================
// LunaCore phone - Host page model (pure; test/mobilehostmodel.test.mjs)
// ----------------------------------------------------------------------------
// docs/REMOTE_HOST_PLAN.md H2/H3. Everything the Host page shows comes from
// rows another machine wrote: `host` snapshots (src/hostsnapshot.js parses
// them) and `host_events` (src/hostevents.js parses them). This file turns
// the parsed values into what the view renders; it never builds HTML.
// ============================================================================

import hostSnap from '../../src/hostsnapshot.js';
import hostEvents from '../../src/hostevents.js';

const { hostsFrom } = hostSnap;
const { eventsFrom, parseEvent } = hostEvents;

export const MODELS = ['sonnet', 'opus'];
export const MODES = ['default', 'acceptEdits', 'plan'];
/** "Deny after N min" choices; 0 = wait forever (the default). */
export const TIMEOUTS = [0, 5, 15, 60];
const GITHUB_KEY_RE = /^git:github\.com\/([a-z0-9._-]+)\/([a-z0-9._-]+)$/;

/** Raw `host` rows -> parsed hosts (online first). */
export const hostList = (rows, now) => hostsFrom(rows, now);

/**
 * The host to show: the current pick while it still exists, else the
 * default host, else the first online one, else the first.
 */
export function pickHost(hosts, current) {
  if (!hosts.length) return null;
  return hosts.find((h) => h.machine === current) || hosts.find((h) => h.default) || hosts.find((h) => h.online) || hosts[0];
}

/** A repo key of a GitHub repo -> the URL repo.clone takes, else null. */
export function cloneUrl(key) {
  const m = typeof key === 'string' ? GITHUB_KEY_RE.exec(key) : null;
  return m ? `https://github.com/${m[1]}/${m[2]}` : null;
}

/** "/name " inserted at the cursor, with a space before it when needed. */
export function insertName(text, cursor, name) {
  const at = Number.isInteger(cursor) && cursor >= 0 && cursor <= text.length ? cursor : text.length;
  const before = text.slice(0, at);
  const pad = before && !/\s$/.test(before) ? ' ' : '';
  const ins = `${pad}/${name} `;
  return { text: before + ins + text.slice(at), cursor: at + ins.length };
}

/** Skills and slash commands of a host, for the picker: unique names, sorted. */
export function pickerNames(host) {
  if (!host) return [];
  return [...new Set([...(host.commands || []), ...(host.skills || [])])].sort((a, b) => a.localeCompare(b));
}

/**
 * Parsed events of one session -> chat items:
 *   {type: 'prompt'|'text', text} (consecutive text chunks joined)
 *   {type: 'tool', name, summary, result?: {text, isError, clipped}}
 *   {type: 'approval', requestId, tool, summary, preview, decision|null}
 *   {type: 'status', status, reason} / {type: 'cost', usd}
 * plus the session's latest status and whether an approval is open.
 */
export function chatModel(rows) {
  const events = eventsFrom(rows);
  const items = [];
  const tools = new Map();
  const approvals = new Map();
  let status = null;
  for (const e of events) {
    const d = e.data;
    const last = items[items.length - 1];
    if (e.kind === 'text') {
      if (last && last.type === 'text') last.text += d.text;
      else items.push({ type: 'text', text: d.text });
    } else if (e.kind === 'prompt') items.push({ type: 'prompt', text: d.text });
    else if (e.kind === 'tool') {
      const item = { type: 'tool', name: d.name, summary: d.summary, result: null };
      tools.set(d.id, item);
      items.push(item);
    } else if (e.kind === 'tool_result') {
      const item = tools.get(d.id);
      if (item) item.result = { text: d.text, isError: d.isError, clipped: d.clipped };
    } else if (e.kind === 'permission') {
      const item = { type: 'approval', requestId: d.requestId, tool: d.tool, summary: d.summary, preview: d.preview, decision: null };
      approvals.set(d.requestId, item);
      items.push(item);
    } else if (e.kind === 'decision') {
      const item = approvals.get(d.requestId);
      if (item) item.decision = d.decision;
    } else if (e.kind === 'status') {
      status = d.status;
      if (d.status === 'done' || d.status === 'error') items.push({ type: 'status', status: d.status, reason: d.reason || '' });
    } else if (e.kind === 'cost' && d.usd !== null) items.push({ type: 'cost', usd: d.usd });
  }
  const open = [...approvals.values()].some((a) => !a.decision);
  return { items, status, open, lastSeq: events.length ? events[events.length - 1].seq : -1 };
}

/**
 * Status rows of every session (newest first, raw) + parsed hosts ->
 * [{sessionId, host, status, at, live}], newest first. `live` = the host's
 * heartbeat lists the session.
 */
export function sessionList(rows, hosts) {
  const liveIds = new Set(hosts.flatMap((h) => (h.online ? h.sessions.map((s) => s.id) : [])));
  const bySession = new Map();
  for (const r of Array.isArray(rows) ? rows : []) {
    const e = parseEvent(r);
    if (!e || e.kind !== 'status') continue;
    const prev = bySession.get(e.sessionId);
    if (prev && (prev.at > e.at || (prev.at === e.at && prev.seq > e.seq))) continue;
    bySession.set(e.sessionId, { sessionId: e.sessionId, host: e.host, status: e.data.status, at: e.at, seq: e.seq, live: liveIds.has(e.sessionId) });
  }
  return [...bySession.values()].sort((a, b) => b.at - a.at).map(({ seq, ...s }) => s);
}

/** The repo a live session runs in, from its host's heartbeat (or null). */
export function sessionRepo(hosts, sessionId) {
  for (const h of hosts) {
    const s = h.sessions.find((x) => x.id === sessionId);
    if (s) return h.repos.find((r) => r.id === s.repoId) || null;
  }
  return null;
}
