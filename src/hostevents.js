// ============================================================================
// LunaCore - a host chat's event feed over the cloud (main + phone)
// ----------------------------------------------------------------------------
// docs/REMOTE_HOST_PLAN.md H2, table `host_events` {session_id, seq, host,
// kind, data, at}. The host (src/hostchat.js) writes what a phone-driven
// claude session does; the phone (mobile/src/views/host.js) reads it back.
//
//   text         {text}                assistant text, partial chunks batched
//                                       every ~300 ms into one row
//   prompt       {text}                what the phone sent
//   tool         {id, name, summary}   a tool call: command or file
//   tool_result  {id, text, isError, clipped}
//   permission   {requestId, tool, summary, preview}   an approval card
//   decision     {requestId, decision} allow | deny | always | timeout | cancelled
//   status       {status, reason?}     working | waiting | done | error
//   cost         {usd, turns}          after each turn (usd: the child's total)
//
// Big outputs are clipped to 4 KB with "full output on the host". Retention:
// events of sessions whose newest event is older than 14 days are deleted.
//
// The writer (createHostEvents) runs on the host; parseEvent / eventsFrom are
// pure and shared with the phone (mobile/vite.config.js SHARED): rows are
// untrusted there, so only known kinds and fields survive, strings capped.
// ============================================================================

'use strict';

const BATCH_MS = 300;
const CLIP_BYTES = 4096;
const CLIP_NOTE = '\n… (full output on the host)';
const RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
const PRUNE_SCAN = 1000;
const PRUNE_IDS = 50;
const MAX_TEXT = 16384;
const MAX_SHORT = 300;
const KINDS = ['text', 'prompt', 'tool', 'tool_result', 'permission', 'decision', 'status', 'cost'];
const STATUSES = ['working', 'waiting', 'done', 'error'];
const DECISIONS = ['allow', 'deny', 'always', 'timeout', 'cancelled'];
const SESSION_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const REQUEST_RE = /^[A-Za-z0-9_-]{1,80}$/;

const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
// eslint-disable-next-line no-control-regex
const cleanShort = (v, max = MAX_SHORT) => (typeof v === 'string' ? v.replace(/[\x00-\x1f\x7f]+/g, ' ').trim().slice(0, max).trimEnd() : '');
/** Multi-line text keeps \n and \t; other control characters go. */
// eslint-disable-next-line no-control-regex
const cleanText = (v, max = MAX_TEXT) => (typeof v === 'string' ? v.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').slice(0, max) : '');
const isSessionId = (v) => typeof v === 'string' && SESSION_RE.test(v);

/** UTF-8 byte length without Buffer (the phone has none). */
function byteLength(text) {
  return new TextEncoder().encode(text).length;
}

/**
 * Text over `max` UTF-8 bytes -> cut on a character boundary + the note.
 * @returns {{text: string, clipped: boolean}}
 */
function clip(text, max = CLIP_BYTES) {
  const s = typeof text === 'string' ? text : '';
  if (byteLength(s) <= max) return { text: s, clipped: false };
  let out = '';
  let bytes = 0;
  for (const ch of s) {
    const n = byteLength(ch);
    if (bytes + n > max) break;
    out += ch;
    bytes += n;
  }
  return { text: out + CLIP_NOTE, clipped: true };
}

/** One kind's data -> its clean copy, or null when malformed. */
function cleanData(kind, d) {
  if (!isObject(d)) return null;
  switch (kind) {
    case 'text':
    case 'prompt':
      return typeof d.text === 'string' ? { text: cleanText(d.text) } : null;
    case 'tool':
      return { id: cleanShort(d.id, 80), name: cleanShort(d.name, 100), summary: cleanShort(d.summary) };
    case 'tool_result':
      return { id: cleanShort(d.id, 80), text: cleanText(d.text, CLIP_BYTES + CLIP_NOTE.length), isError: d.isError === true, clipped: d.clipped === true };
    case 'permission':
      if (typeof d.requestId !== 'string' || !REQUEST_RE.test(d.requestId)) return null;
      return { requestId: d.requestId, tool: cleanShort(d.tool, 100), summary: cleanShort(d.summary), preview: cleanText(d.preview, CLIP_BYTES + CLIP_NOTE.length) };
    case 'decision':
      if (typeof d.requestId !== 'string' || !REQUEST_RE.test(d.requestId) || !DECISIONS.includes(d.decision)) return null;
      return { requestId: d.requestId, decision: d.decision };
    case 'status':
      if (!STATUSES.includes(d.status)) return null;
      return d.reason ? { status: d.status, reason: cleanShort(d.reason, 120) } : { status: d.status };
    case 'cost': {
      const usd = Number.isFinite(d.usd) && d.usd >= 0 ? Math.round(d.usd * 10000) / 10000 : null;
      const turns = Number.isInteger(d.turns) && d.turns >= 0 ? d.turns : null;
      return { usd, turns };
    }
    default:
      return null;
  }
}

/**
 * An approval card exactly as the phone will read it back (parseEvent): the
 * host keeps this copy and only accepts a chat.approve naming the same one.
 */
const cleanCard = (d) => cleanData('permission', d);

/**
 * A raw `host_events` row -> {sessionId, seq, host, kind, data, at}, or null.
 * Never throws.
 */
function parseEvent(row) {
  try {
    if (!isObject(row) || !isSessionId(row.session_id) || !KINDS.includes(row.kind)) return null;
    if (!Number.isInteger(row.seq) || row.seq < 0) return null;
    const at = Date.parse(row.at);
    const data = cleanData(row.kind, row.data);
    if (!data || !Number.isFinite(at)) return null;
    return { sessionId: row.session_id, seq: row.seq, host: cleanShort(row.host, 63), kind: row.kind, data, at };
  } catch {
    return null;
  }
}

/** Raw rows -> parsed events of one session in seq order, duplicates dropped. */
function eventsFrom(rows) {
  const bySeq = new Map();
  for (const r of Array.isArray(rows) ? rows : []) {
    const e = parseEvent(r);
    if (e && !bySeq.has(e.seq)) bySeq.set(e.seq, e);
  }
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

/**
 * Retention: session ids to delete. `old` = rows (session_id) with an event
 * before the cutoff, `recent` = rows of those sessions at or after it.
 */
function sessionsToDrop(old, recent) {
  const live = new Set((Array.isArray(recent) ? recent : []).map((r) => r && r.session_id));
  const ids = new Set((Array.isArray(old) ? old : []).map((r) => r && r.session_id).filter(isSessionId));
  return [...ids].filter((id) => !live.has(id));
}

/**
 * The host's writer. Rows go out one at a time in emit order, so `seq` order
 * is insert order. A failed insert is logged and dropped: the chat goes on.
 * @param {{client: object, host: string, now?: () => number,
 *   setTimer?: Function, clearTimer?: Function, log?: (line: string) => void,
 *   batchMs?: number}} deps
 */
function createHostEvents({ client, host, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, log = (l) => console.error(l), batchMs = BATCH_MS }) {
  const seqs = new Map(); // sessionId -> next seq
  const buffers = new Map(); // sessionId -> {text, timer}
  let chain = Promise.resolve();

  function nextSeq(sessionId) {
    const n = seqs.get(sessionId) || 0;
    seqs.set(sessionId, n + 1);
    return n;
  }

  function insert(sessionId, kind, data) {
    const clean = cleanData(kind, data);
    if (!clean || !isSessionId(sessionId)) {
      log(`[hostevents] dropped a malformed ${kind} event`);
      return chain;
    }
    const row = { session_id: sessionId, seq: nextSeq(sessionId), host, kind, data: clean, at: new Date(now()).toISOString() };
    chain = chain.then(async () => {
      try {
        const { error } = await client.from('host_events').insert(row);
        if (error) log(`[hostevents] insert ${kind} failed: ${error.code || 'error'}`);
      } catch (err) {
        log(`[hostevents] insert ${kind} crashed: ${err && err.message}`);
      }
    });
    return chain;
  }

  /** Writes the session's buffered text now (no-op when empty). */
  function flush(sessionId) {
    const b = buffers.get(sessionId);
    if (!b) return chain;
    buffers.delete(sessionId);
    clearTimer(b.timer);
    return b.text ? insert(sessionId, 'text', { text: b.text }) : chain;
  }

  return {
    /** A partial text chunk: batched for `batchMs`, then one `text` row. */
    text(sessionId, chunk) {
      if (typeof chunk !== 'string' || !chunk) return;
      const b = buffers.get(sessionId);
      if (b) {
        b.text += chunk;
        if (b.text.length >= MAX_TEXT) flush(sessionId);
        return;
      }
      buffers.set(sessionId, { text: chunk, timer: setTimer(() => flush(sessionId), batchMs) });
    },
    /** Any other kind; buffered text of the session goes out first, so order holds. */
    emit(sessionId, kind, data) {
      flush(sessionId);
      return insert(sessionId, kind, data);
    },
    flush,
    /** Resolves once every row emitted so far was written (or failed). */
    idle: () => chain,
    /**
     * Before a resumed session writes again: its next seq comes after the
     * highest one already stored. A failed read leaves the counter as it is
     * (inserts may then collide and be logged, never thrown).
     */
    async continueSession(sessionId) {
      if (!isSessionId(sessionId)) return;
      try {
        const { data, error } = await client
          .from('host_events')
          .select('seq')
          .eq('session_id', sessionId)
          .order('seq', { ascending: false })
          .limit(1);
        if (error || !Array.isArray(data)) {
          log(`[hostevents] seq read failed: ${(error && error.code) || 'error'}`);
          return;
        }
        const top = data[0] && Number.isInteger(data[0].seq) ? data[0].seq : -1;
        if (top + 1 > (seqs.get(sessionId) || 0)) seqs.set(sessionId, top + 1);
      } catch (err) {
        log(`[hostevents] seq read crashed: ${err && err.message}`);
      }
    },
    /** Forgets a session's counters once it ended (its rows stay). */
    forget(sessionId) {
      flush(sessionId);
      seqs.delete(sessionId);
    },
    /** Deletes this host's events of sessions idle for 14 days. @returns {Promise<number>} sessions dropped */
    async prune() {
      const cutoff = new Date(now() - RETENTION_MS).toISOString();
      const { data: old, error } = await client.from('host_events').select('session_id').eq('host', host).lt('at', cutoff).limit(PRUNE_SCAN);
      if (error || !Array.isArray(old)) {
        log(`[hostevents] prune read failed: ${(error && error.code) || 'error'}`);
        return 0;
      }
      // A few sessions per round keep the `in (...)` filter short; the next prune takes the rest.
      const candidates = [...new Set(old.map((r) => r && r.session_id).filter(isSessionId))].slice(0, PRUNE_IDS);
      if (!candidates.length) return 0;
      const { data: recent, error: err2 } = await client.from('host_events').select('session_id').eq('host', host).in('session_id', candidates).gte('at', cutoff);
      if (err2 || !Array.isArray(recent)) {
        log(`[hostevents] prune read failed: ${(err2 && err2.code) || 'error'}`);
        return 0;
      }
      const drop = sessionsToDrop(old, recent);
      if (!drop.length) return 0;
      const { error: err3 } = await client.from('host_events').delete().eq('host', host).in('session_id', drop);
      if (err3) {
        log(`[hostevents] prune delete failed: ${err3.code || 'error'}`);
        return 0;
      }
      return drop.length;
    },
  };
}

module.exports = {
  createHostEvents,
  parseEvent,
  eventsFrom,
  sessionsToDrop,
  cleanCard,
  clip,
  byteLength,
  KINDS,
  STATUSES,
  DECISIONS,
  BATCH_MS,
  CLIP_BYTES,
  RETENTION_MS,
};
