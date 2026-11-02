// ============================================================================
// LunaCore - early pty data buffer (pure, zero DOM)
// ----------------------------------------------------------------------------
// The main process starts the first session (s1) while the renderer is still
// booting, so 'pty:data' can arrive before the `terminal` widget has mounted
// its #terminal host. Writing that data straight away would make ensureTerm()
// append a pane to a host that does not exist yet. Instead sessions.js parks
// the chunks here, per session, and replays them once the host is mounted -
// the early output is shown, not lost.
//
// Bounded: each session keeps at most `maxCharsPerSession` characters (the
// newest ones win - the tail of a terminal stream is what the user needs),
// and at most `maxSessions` sessions are tracked (later ones are dropped).
// ============================================================================

'use strict';

export const DEFAULT_MAX_CHARS_PER_SESSION = 256 * 1024;
export const DEFAULT_MAX_SESSIONS = 32;

/**
 * Creates an empty per-session buffer.
 * @param {{ maxCharsPerSession?: number, maxSessions?: number }} [opts]
 */
export function createEarlyPtyBuffer(opts = {}) {
  const maxChars = opts.maxCharsPerSession > 0 ? opts.maxCharsPerSession : DEFAULT_MAX_CHARS_PER_SESSION;
  const maxSessions = opts.maxSessions > 0 ? opts.maxSessions : DEFAULT_MAX_SESSIONS;
  // sessionId -> { chunks: string[], size: number, exit: number | undefined }
  let entries = new Map();

  function entryFor(sessionId) {
    const existing = entries.get(sessionId);
    if (existing) return existing;
    if (entries.size >= maxSessions) return null;
    const created = { chunks: [], size: 0, exit: undefined };
    entries.set(sessionId, created);
    return created;
  }

  /** Drops the oldest characters until the entry fits under the cap. */
  function trim(entry) {
    while (entry.size > maxChars && entry.chunks.length) {
      const overflow = entry.size - maxChars;
      const head = entry.chunks[0];
      if (head.length <= overflow) {
        entry.chunks.shift();
        entry.size -= head.length;
      } else {
        entry.chunks[0] = head.slice(overflow);
        entry.size -= overflow;
      }
    }
  }

  return {
    /** Parks one chunk of terminal output. Returns false when it was dropped. */
    pushData(sessionId, data) {
      if (typeof data !== 'string' || data.length === 0) return false;
      const entry = entryFor(sessionId);
      if (!entry) return false;
      entry.chunks.push(data);
      entry.size += data.length;
      trim(entry);
      return true;
    },

    /** Parks a pty exit, replayed after that session's data. */
    pushExit(sessionId, code) {
      const entry = entryFor(sessionId);
      if (!entry) return false;
      entry.exit = code;
      return true;
    },

    /** Total characters currently held (all sessions). */
    size() {
      let total = 0;
      for (const entry of entries.values()) total += entry.size;
      return total;
    },

    /**
     * Empties the buffer and returns what it held, in arrival order of the
     * sessions: [{ sessionId, data, hasExit, exitCode }]. `data` is the joined
     * output ('' when only an exit was parked).
     */
    drain() {
      const out = [];
      for (const [sessionId, entry] of entries) {
        out.push({
          sessionId,
          data: entry.chunks.join(''),
          hasExit: entry.exit !== undefined,
          exitCode: entry.exit,
        });
      }
      entries = new Map();
      return out;
    },
  };
}
