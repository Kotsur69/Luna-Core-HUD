// ============================================================================
// LunaCore - request pacing for the free-model gateway (Free God Mode v2, F2b)
// ----------------------------------------------------------------------------
// FreeLLMAPI guards its /v1 surface with a fixed 60 s window per client IP:
// 120 requests (X-RateLimit-Limit: 120), with X-RateLimit-Remaining /
// X-RateLimit-Reset (epoch seconds) on every answer and a 429 "Rate limit
// exceeded: more than 120 requests per minute. Retry in Ns." past it. Every
// free worker of every run shares that one window, so src/fallbackproxy.js
// sends each request through the gateway's pacer (one per gateway origin):
//
//   - its own sliding window keeps the count under the limit minus a reserve;
//   - the gateway's headers, when present, are trusted over that count;
//   - a key-level 429 blocks every request until its Retry-After;
//   - consecutive requests are spaced by a small minimum gap.
//
// Waiting is queued (first come, first served). Time and sleep are injected,
// so tests drive it with fake timers.
// ============================================================================

'use strict';

/** The gateway's default window (FreeLLMAPI PROXY_RATE_LIMIT_RPM). */
const GATEWAY_WINDOW_MS = 60 * 1000;
const GATEWAY_LIMIT = 120;
/** Requests kept free in every window for the CLI's own side calls and retries. */
const WINDOW_RESERVE = 10;
/** Minimum spacing between two requests to the gateway. */
const MIN_GAP_MS = 100;
/** No single wait is longer than one window (guards against a broken reset header). */
const MAX_WAIT_MS = GATEWAY_WINDOW_MS + 5 * 1000;

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A header value as a finite number, or null. */
function headerNumber(headers, name) {
  const raw = headers && headers[name];
  if (raw === undefined || raw === null || raw === '') return null;
  const n = Number(Array.isArray(raw) ? raw[0] : raw);
  return Number.isFinite(n) ? n : null;
}

/** X-RateLimit-Reset as epoch ms: epoch seconds, or seconds from now when small. */
function resetAtFrom(raw, now) {
  if (raw === null) return null;
  return raw > 1e9 ? raw * 1000 : now + raw * 1000;
}

class RequestPacer {
  /**
   * @param {{now?:() => number, sleep?:(ms:number) => Promise<void>, windowMs?:number,
   *          limit?:number, reserve?:number, minGapMs?:number}} [opts]
   */
  constructor({
    now = Date.now,
    sleep = defaultSleep,
    windowMs = GATEWAY_WINDOW_MS,
    limit = GATEWAY_LIMIT,
    reserve = WINDOW_RESERVE,
    minGapMs = MIN_GAP_MS,
  } = {}) {
    this.now = now;
    this.sleep = sleep;
    this.windowMs = windowMs;
    this.limit = limit;
    this.reserve = reserve;
    this.minGapMs = minGapMs;
    this.sent = [];
    this.remaining = null;
    this.resetAt = null;
    this.blockedUntil = 0;
    this.queue = Promise.resolve();
  }

  /** Requests the window allows LunaCore to send (limit minus the reserve). */
  budget() {
    return Math.max(1, this.limit - Math.min(this.reserve, Math.floor(this.limit / 2)));
  }

  /** How long the next request has to wait right now (0 = send now). */
  delayMs(now = this.now()) {
    this.prune(now);
    let wait = Math.max(0, this.blockedUntil - now);
    const budget = this.budget();
    if (this.sent.length >= budget) {
      wait = Math.max(wait, this.sent[this.sent.length - budget] + this.windowMs - now);
    }
    if (this.resetAt !== null && this.resetAt <= now) {
      this.remaining = null;
      this.resetAt = null;
    }
    if (this.remaining !== null && this.resetAt !== null && this.remaining <= Math.min(this.reserve, this.limit - 1)) {
      wait = Math.max(wait, this.resetAt - now);
    }
    const last = this.sent.length ? this.sent[this.sent.length - 1] : null;
    if (last !== null) wait = Math.max(wait, last + this.minGapMs - now);
    return Math.min(wait, MAX_WAIT_MS);
  }

  /** Drops the sends that left the window. */
  prune(now = this.now()) {
    this.sent = this.sent.filter((t) => t > now - this.windowMs);
  }

  /**
   * Waits for a free slot in the window, then counts the request as sent.
   * Callers are served in order; one whose client hung up meanwhile
   * (`isCancelled`) gives its slot back without counting.
   * @param {() => boolean} [isCancelled]
   * @returns {Promise<boolean>} false when cancelled
   */
  acquire(isCancelled = () => false) {
    const turn = this.queue.then(async () => {
      for (let d = this.delayMs(); d > 0 && !isCancelled(); d = this.delayMs()) await this.sleep(d);
      if (isCancelled()) return false;
      this.sent.push(this.now());
      return true;
    });
    // A failed sleep must not wedge every later caller.
    this.queue = turn.catch(() => {});
    return turn;
  }

  /** Counts a request that went out without waiting (pass-through calls). */
  note() {
    const now = this.now();
    this.prune(now);
    this.sent.push(now);
  }

  /** Reads the gateway's window headers from any answer. */
  observe(headers) {
    const now = this.now();
    const limit = headerNumber(headers, 'x-ratelimit-limit');
    if (limit !== null && limit > 0) this.limit = Math.floor(limit);
    const remaining = headerNumber(headers, 'x-ratelimit-remaining');
    const resetAt = resetAtFrom(headerNumber(headers, 'x-ratelimit-reset'), now);
    if (remaining !== null && resetAt !== null && resetAt > now) {
      this.remaining = Math.max(0, Math.floor(remaining));
      // A fixed window never resets later than one window from now.
      this.resetAt = Math.min(resetAt, now + this.windowMs);
    }
  }

  /** A key-level 429: nothing goes out for `ms` (one window at most). */
  block(ms) {
    const wait = Math.min(Math.max(0, ms), MAX_WAIT_MS);
    this.blockedUntil = Math.max(this.blockedUntil, this.now() + wait);
  }
}

module.exports = {
  RequestPacer,
  GATEWAY_WINDOW_MS,
  GATEWAY_LIMIT,
  WINDOW_RESERVE,
  MIN_GAP_MS,
  MAX_WAIT_MS,
};
