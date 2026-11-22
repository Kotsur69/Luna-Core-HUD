// ============================================================================
// LunaCore - tails one Antigravity (`agy`) transcript file (read-only)
// ----------------------------------------------------------------------------
// The per-file half of src/agywatcher.js: reads what was appended to one
// transcript since the last poll and folds it into an AgyTranscriptState.
// The watcher keeps one for the tab's own conversation and one per subagent
// conversation it follows.
//
//   * Offsets are bytes, and a read only ever ends at a newline byte, so no
//     UTF-8 character is cut in two. At most `chunkBytes` is read per poll; a
//     long history is caught up over several.
//   * Bytes that were in the file when it was pinned (`historyUntil`) are
//     history: they count toward the context window but light no tool.
//   * A file that got shorter, or whose bytes before the read position
//     changed (agy rewrote it instead of appending), is read again from the
//     start. Calls lit at that point end there; the re-read reports only the
//     steps the state had not seen (AgyTranscriptState.restarted()).
//   * A symlink is never followed: every stat is an lstat and anything but a
//     regular file is left alone.
// Nothing is emitted from here: poll() returns the events, after the read
// position has moved, so a listener that throws cannot make the next poll
// fold the same lines again.
// ============================================================================

'use strict';

const fs = require('fs');
const { parseSteps } = require('./agytranscript');

const NEWLINE = 0x0a;
/** Bytes before the read position that must still be there on the next poll. */
const FINGERPRINT_BYTES = 64;

const errText = (err) => (err && (err.code || err.message)) || String(err);
const noEvents = () => ({ tools: [], mcp: [], children: [], turns: [] });
const EVENT_KINDS = Object.freeze(['tools', 'mcp', 'children', 'turns']);

/** Appends every event of `from` to `into`, list by list. */
function appendAll(into, from) {
  for (const key of EVENT_KINDS) {
    for (const item of from[key] || []) into[key].push(item);
  }
}

/** Reads up to `length` bytes at `offset`; the Buffer holds what was actually read. */
function readRange(file, offset, length) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(length);
    const read = fs.readSync(fd, buf, 0, length, offset);
    return read === length ? buf : buf.subarray(0, read);
  } finally {
    fs.closeSync(fd);
  }
}

/** The last `n` bytes of a then b, as a copy. */
function lastBytes(a, b, n) {
  if (b.length >= n) return Buffer.from(b.subarray(b.length - n));
  const joined = Buffer.concat([a, b]);
  return Buffer.from(joined.subarray(Math.max(0, joined.length - n)));
}

class AgyTail {
  /**
   * @param {{file: string, state: import('./agytranscript').AgyTranscriptState,
   *   historyUntil?: number, chunkBytes: number,
   *   warnOnce: (key: string, msg: string) => void, log: (msg: string) => void}} opts
   */
  constructor({ file, state, historyUntil = 0, chunkBytes, warnOnce, log }) {
    this.file = file;
    this.state = state;
    this.chunkBytes = chunkBytes;
    this.warnOnce = warnOnce;
    this.log = log;
    this.offset = 0;
    /** Bytes of the file that were already there when it was pinned: history. 0 = none (left). */
    this.historyUntil = historyUntil;
    /** Inside a line longer than chunkBytes, which is dropped up to its end. */
    this.skipping = false;
    this.lastSize = -1;
    this.lastMtime = 0;
    /** The bytes just before `offset`, to notice a rewritten file. */
    this.fingerprint = Buffer.alloc(0);
    /** How often the file was read again from the start. */
    this.restarts = 0;
    /** Bytes the file held at the last restart: re-read under the state's replay rule. 0 = none. */
    this.replayUntil = 0;
    /** Events gathered during one poll. */
    this.out = noEvents();
  }

  /**
   * One poll: stats the file and folds whatever complete lines were appended
   * (at most one chunk).
   * @returns {{status: 'error'|'same'|'read', moved: boolean,
   *   tools: object[], mcp: object[], children: string[], turns: object[]}}
   *   moved: the read position advanced, or the file was read again;
   *   turns: live turn start/end notifications (AgyTranscriptState.takeTurns)
   */
  poll() {
    this.out = noEvents();
    const result = (status, moved) => ({ status, moved, ...this.out });
    let st;
    try {
      st = fs.lstatSync(this.file);
    } catch (err) {
      this.warnOnce(`stat:${this.file}:${errText(err)}`, `cannot stat ${this.file}: ${errText(err)}`);
      return result('error', false);
    }
    if (!st.isFile()) {
      this.warnOnce(`not-file:${this.file}`, `${this.file} is no longer a regular file; not reading it`);
      return result('error', false);
    }
    if (st.size === this.lastSize && st.mtimeMs === this.lastMtime) return result('same', false);
    const before = this.offset;
    const restartsBefore = this.restarts;
    // Unless there is more to read right away, wait for the file to change.
    if (this.accumulate(st.size) !== 'more') {
      this.lastSize = st.size;
      this.lastMtime = st.mtimeMs;
    }
    return result('read', this.offset !== before || this.restarts !== restartsBefore);
  }

  /** Whether the bytes before the read position are still the ones that were read. */
  unchangedBefore() {
    if (this.offset === 0 || this.fingerprint.length === 0) return true;
    const start = this.offset - this.fingerprint.length;
    return readRange(this.file, start, this.fingerprint.length).equals(this.fingerprint);
  }

  /** Moves the read position over `bytes` (just read from the file). */
  advance(bytes) {
    this.offset += bytes.length;
    this.fingerprint = lastBytes(this.fingerprint, bytes, FINGERPRINT_BYTES);
  }

  /** The file shrank or was rewritten: count again from the start. */
  restart(size, why) {
    this.warnOnce(`restart:${this.file}`, `${this.file} ${why}; reading it again from the start`);
    // Calls lit live end here (history lit none), or they would stay lit.
    const ended = this.state.endOpen(Date.now());
    const live = this.historyUntil === 0;
    this.state = this.state.restarted();
    this.offset = 0;
    this.fingerprint = Buffer.alloc(0);
    this.skipping = false;
    this.restarts++;
    if (!live) {
      // Still inside the history it was pinned with: all of it stays history.
      this.historyUntil = size;
      return;
    }
    this.emit(ended);
    // What the file holds now is re-read under the state's replay rule;
    // whatever is appended after it is new.
    this.replayUntil = size;
    if (size === 0) this.state.endReplay();
  }

  /**
   * Enters a line longer than a read, dropped up to its end. Which step it
   * held is unknown, so the open batch ends here: a result on that line
   * would otherwise shift every later result onto the wrong call.
   */
  skipLongLine() {
    this.skipping = true;
    this.warnOnce(`long-line:${this.file}`, `skipping a line of ${this.file} longer than ${this.chunkBytes} bytes; tool calls open at that point end without a result`);
    const ended = this.state.endOpen(Date.now());
    if (this.historyUntil === 0) this.emit(ended);
  }

  /** Adds events to this poll's output (loops: a long list must not overflow the call stack). */
  emit(events) {
    appendAll(this.out, events);
  }

  /**
   * Reads what was appended since the last poll, at most chunkBytes, and
   * folds its complete lines into the state.
   * @returns {'eof'|'more'|'partial'} 'more': read again now; 'partial': a
   *   line is still being written, wait for the file to grow
   */
  accumulate(size) {
    if (size < this.offset) this.restart(size, 'got shorter');
    else if (!this.unchangedBefore()) this.restart(size, 'was rewritten');
    const want = Math.min(size - this.offset, this.chunkBytes);
    if (want <= 0) return 'eof';
    const buf = readRange(this.file, this.offset, want);
    if (buf.length === 0) return 'eof';
    let start = 0;
    if (this.skipping) {
      const nl = buf.indexOf(NEWLINE);
      if (nl < 0) {
        this.advance(buf);
        return this.offset >= size ? 'partial' : 'more';
      }
      start = nl + 1;
      this.skipping = false;
    }
    const lastNl = buf.lastIndexOf(NEWLINE);
    if (lastNl < start) {
      // A whole chunk with no line end, and the file goes on past it: the
      // line is longer than a read, not a step anyone can use.
      if (start === 0 && buf.length >= this.chunkBytes && this.offset + buf.length < size) {
        this.advance(buf);
        this.skipLongLine();
        return 'more';
      }
      this.advance(buf.subarray(0, start));
      return this.offset + (buf.length - start) >= size ? 'partial' : 'more';
    }
    const folded = this.safeFold(buf, start, lastNl + 1);
    // The place moves on before anyone hears of it.
    this.advance(buf.subarray(0, lastNl + 1));
    this.emit(folded);
    return this.offset >= size ? 'eof' : 'more';
  }

  /**
   * foldLines(), and a chunk it cannot fold is skipped (logged once) rather
   * than read again every poll: what it left open ends here.
   */
  safeFold(buf, start, end) {
    try {
      return this.foldLines(buf, start, end);
    } catch (err) {
      this.warnOnce(`fold:${this.file}`, `cannot read lines of ${this.file} (${errText(err)}); skipping them`);
      const ended = this.state.endOpen(Date.now());
      return this.historyUntil === 0 ? { ...ended, children: [] } : noEvents();
    }
  }

  /**
   * Folds the complete lines buf[start, end) and returns their live events.
   * Lines that were in the file when it was pinned are history: they count
   * toward the context window but light no tool, and what they left open is
   * dropped where history ends.
   */
  foldLines(buf, start, end) {
    let from = start;
    if (this.historyUntil > 0) {
      const lastHistoryNl = this.lastNewlineWithin(buf, from, end, this.historyUntil);
      if (lastHistoryNl >= from) {
        this.applyLines(buf.toString('utf8', from, lastHistoryNl + 1));
        from = lastHistoryNl + 1;
      }
      if (this.offset + end < this.historyUntil) return noEvents();
      // A call the past left open (a killed session) must not light anything now.
      this.state.forgetPending();
      this.state.endReplay();
      this.historyUntil = 0;
    }
    const events = noEvents();
    const take = (folded) => appendAll(events, folded);
    if (this.replayUntil > 0) {
      const lastReplayNl = this.lastNewlineWithin(buf, from, end, this.replayUntil);
      if (lastReplayNl >= from) {
        take(this.applyLines(buf.toString('utf8', from, lastReplayNl + 1)));
        from = lastReplayNl + 1;
      }
      if (this.offset + end >= this.replayUntil) {
        this.state.endReplay();
        this.replayUntil = 0;
      }
    }
    if (from < end) take(this.applyLines(buf.toString('utf8', from, end)));
    return events;
  }

  /** The newline closing the last line of buf[from, end) that ends before file byte `limit`, or -1. */
  lastNewlineWithin(buf, from, end, limit) {
    const boundary = limit - this.offset;
    return boundary > from ? buf.lastIndexOf(NEWLINE, Math.min(boundary, end) - 1) : -1;
  }

  /** Parses whole lines, logs the ones it cannot use, returns their events and the turns they ended. */
  applyLines(text) {
    const { steps, skipped } = parseSteps(text);
    if (skipped.length > 0) {
      this.log(`skipped ${skipped.length} unreadable line(s) of ${this.file}; first: ${skipped[0].reason}`);
    }
    const folded = this.state.fold(steps);
    // Drained every time: history's turns are dropped with its events.
    return { ...folded, turns: this.state.takeTurns() };
  }

  /** Whether an agent / subagent / workflow call of this conversation is still running. */
  hasOpenTask() {
    return this.state.pending.some((call) => call.live && call.tile === 'Task');
  }
}

module.exports = { AgyTail, FINGERPRINT_BYTES };
