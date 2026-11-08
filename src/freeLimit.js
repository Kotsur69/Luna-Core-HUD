// ============================================================================
// LunaCore - "free models used up" answer (Free God Mode v2, slice F2a)
// ----------------------------------------------------------------------------
// When every model of a free chain is limited, src/fallbackproxy.js answers
// the CLI with HTTP 429 and a body the transcript observer already reads as
// the usage-limit wall (src/observer.js usageLimitFrom / LIMIT_TEXT /
// parseResetAt):
//
//   Free coding models: usage limit reached · resets Nov 8, 3:40pm
//
// The CLI writes that into the transcript as an API-error entry (apiErrorStatus
// 429), the observer hands the parsed reset to main.js onUsageLimit, and the
// God Mode run pauses and resumes on its own (orchestra.js pauseUntil /
// RESUME_TEXT) - the same path as a Claude account limit, no new machinery.
//
// The reset is printed as LOCAL clock time WITH the date: parseResetAt reads a
// bare "3:40pm" that is already past as tomorrow, and the CLI may write the
// entry a little after the reset when its own retries ran long. With a date a
// late read stays today (the run then waits its default pause, not a day).
//
// Pure: time comes in as arguments.
// ============================================================================

'use strict';

const { soonestCooldown } = require('./freechains');

/** No reset known at all (daily cap, silent gateway): wait this long, then re-probe. */
const NO_RESET_WAIT_MS = 30 * 60 * 1000;
/** A reset closer than this is pushed out, so the pause outlasts the CLI's own retries. */
const MIN_RESET_LEAD_MS = 60 * 1000;
/** A reset further out is cut short: the run then re-probes one model instead of idling. */
const MAX_RESET_MS = 6 * 60 * 60 * 1000;
/** The SDK sleeps on Retry-After up to this itself; past it the CLI should stop retrying. */
const CLIENT_RETRY_MAX_MS = 60 * 1000;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MINUTE_MS = 60 * 1000;

/** "Free coding models" for chain id free-coding; else "Free models (<id>)". */
function chainLabel(chain) {
  const id = String((chain && chain.id) || '');
  const m = /^free-(.+)$/.exec(id);
  return m ? `Free ${m[1].replace(/-/g, ' ')} models` : `Free models (${id || 'chain'})`;
}

/**
 * "Nov 8, 3:40pm" in the machine's local time zone - the form parseResetAt
 * (src/observer.js) reads back to the same minute.
 * @param {number} at epoch ms (whole minutes)
 * @returns {string}
 */
function formatResetClock(at) {
  const d = new Date(at);
  const hours = d.getHours();
  const h12 = hours % 12 === 0 ? 12 : hours % 12;
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${h12}:${mm}${hours < 12 ? 'am' : 'pm'}`;
}

const minFinite = (values) => {
  const list = values.filter((v) => Number.isFinite(v));
  return list.length ? Math.min(...list) : null;
};

/**
 * When the chain is worth trying again: the first moment ANY model of it is
 * free. Each model's cooldown was set from the gateway's Retry-After, else its
 * "Soonest cooldown reset ~Xm" hint, else the default for the failure
 * (src/freechains.js withCooldown) - so that order holds per model, and one
 * long Retry-After never hides a model that is back sooner. The gateway's
 * own request window (`throttled` failures, no model cooldown) counts too.
 * Nothing known at all -> now + 30 min. Rounded UP to a whole minute (the
 * message has minute precision - resuming a few seconds early would only hit
 * the wall again), never closer than MIN_RESET_LEAD_MS nor further than
 * MAX_RESET_MS.
 * @param {{failures:{kind?:string, retryAfterMs?:number|null}[],
 *          chain:{models:string[]}, cooldowns:Map<string, number>, now:number}} input
 * @returns {number} epoch ms
 */
function exhaustedResetAt({ failures, chain, cooldowns, now }) {
  const list = Array.isArray(failures) ? failures : [];
  const windowWait = minFinite(list.filter((f) => f && f.kind === 'throttled').map((f) => f.retryAfterMs));
  const own = soonestCooldown(chain, cooldowns, now);
  const candidates = [own, windowWait === null ? null : now + windowWait].filter((v) => v !== null);
  const at = candidates.length ? Math.min(...candidates) : now + NO_RESET_WAIT_MS;
  const bounded = Math.min(Math.max(at, now + MIN_RESET_LEAD_MS), now + MAX_RESET_MS);
  return Math.ceil(bounded / MINUTE_MS) * MINUTE_MS;
}

/** The limit text: "Free coding models: usage limit reached · resets Nov 8, 3:40pm". */
function usageLimitMessage(chain, resetAt) {
  return `${chainLabel(chain)}: usage limit reached · resets ${formatResetClock(resetAt)}`;
}

/**
 * Headers + Anthropic-shaped body of the exhausted-chain answer.
 * @param {{id:string}} chain
 * @param {number} resetAt epoch ms
 * @param {number} now epoch ms
 * @returns {{status:number, headers:Object<string,string>, body:string}}
 */
function usageLimitAnswer(chain, resetAt, now) {
  const waitMs = Math.max(0, resetAt - now);
  const body = JSON.stringify({
    type: 'error',
    error: { type: 'rate_limit_error', message: usageLimitMessage(chain, resetAt) },
  });
  const headers = {
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(body)),
    'retry-after': String(Math.ceil(waitMs / 1000)),
  };
  // A wait the SDK would not sleep through itself: tell it not to burn its
  // retries on the proxy, so the limit reaches the transcript right away.
  if (waitMs > CLIENT_RETRY_MAX_MS) headers['x-should-retry'] = 'false';
  return { status: 429, headers, body };
}

module.exports = {
  NO_RESET_WAIT_MS,
  MIN_RESET_LEAD_MS,
  MAX_RESET_MS,
  chainLabel,
  formatResetClock,
  exhaustedResetAt,
  usageLimitMessage,
  usageLimitAnswer,
};
