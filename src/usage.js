// ============================================================================
// LunaCore - subscription usage meter
// ----------------------------------------------------------------------------
// Fetches usage of the rate-limit windows (5h + 7 days) from the private OAuth
// endpoint, the same one `claude` uses for `/status`:
//   GET https://api.anthropic.com/api/oauth/usage
//
// ZERO CLAUDE TOKENS: this is a plain read (GET), NOT a model call (/v1/messages
// is never touched). It eats neither the session nor the weekly limit.
//
// AUTH WITHOUT OUR OWN REFRESH: the token is read FRESH EVERY TIME from
// ~/.claude/.credentials.json. The `claude` CLI itself refreshes and rewrites
// that file, so we "ride its refresh" - we do not implement our own OAuth. When
// the token has expired and there is no way to refresh it (the CLI is not
// running) -> 401 -> 'reauth' state.
//
// NOTE: the endpoint is undocumented/private. The code degrades gracefully
// (states 'reauth' / 'unavailable') instead of showing a made-up number.
// ============================================================================

'use strict';

const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CRED_PATH = path.join(os.homedir(), '.claude', '.credentials.json');
const USAGE_HOST = 'api.anthropic.com';
const USAGE_PATH = '/api/oauth/usage';

/** Reads a fresh accessToken from the CLI's credentials file. null = file missing/bad. */
function readToken() {
  try {
    const cred = JSON.parse(fs.readFileSync(CRED_PATH, 'utf8'));
    const oauth = cred && cred.claudeAiOauth;
    if (oauth && typeof oauth.accessToken === 'string' && oauth.accessToken) {
      return oauth.accessToken;
    }
  } catch {
    /* missing file / invalid JSON - treated as no authorization */
  }
  return null;
}

/** GET JSON with Claude Code's OAuth headers. Always resolves ({status, body}). */
function httpsGetJson(host, pathname, token) {
  return new Promise((resolve) => {
    const req = https.request(
      {
        method: 'GET',
        host,
        path: pathname,
        headers: {
          Authorization: `Bearer ${token}`,
          'anthropic-beta': 'oauth-2025-04-20',
          'anthropic-version': '2023-06-01',
          'User-Agent': 'LunaCore/0.1 (usage-meter)',
          Accept: 'application/json',
        },
        timeout: 8000,
      },
      (res) => {
        let body = '';
        res.on('data', (d) => (body += d));
        res.on('end', () => resolve({ status: res.statusCode, body }));
      }
    );
    req.on('error', () => resolve({ status: 0, body: '' }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ status: 0, body: '' });
    });
    req.end();
  });
}

/** Normalizes a single rate-limit window ({utilization, resets_at}) -> {pct, resetsAt}. */
function pickWindow(w) {
  if (!w || typeof w.utilization !== 'number') return null;
  return {
    pct: Math.max(0, Math.min(100, Math.round(w.utilization))),
    resetsAt: typeof w.resets_at === 'string' ? w.resets_at : null,
  };
}

/**
 * One-shot usage read. Returns either a normalized state, or {error}:
 *   'reauth'      - missing/expired token (401/403, or file missing)
 *   'unavailable' - network/timeout/endpoint change (other status, bad JSON)
 */
async function fetchUsage() {
  const token = readToken();
  if (!token) return { error: 'reauth' };

  const { status, body } = await httpsGetJson(USAGE_HOST, USAGE_PATH, token);
  if (status === 401 || status === 403) return { error: 'reauth' };
  if (status !== 200) return { error: 'unavailable' };

  let data;
  try {
    data = JSON.parse(body);
  } catch {
    return { error: 'unavailable' };
  }

  return {
    fiveHour: pickWindow(data.five_hour),
    sevenDay: pickWindow(data.seven_day),
    sevenDayOpus: pickWindow(data.seven_day_opus),
    sevenDaySonnet: pickWindow(data.seven_day_sonnet),
    extraUsage: !!(data.extra_usage && data.extra_usage.is_enabled),
    fetchedAt: Date.now(),
  };
}

/**
 * Pure decision behind the heartbeat: normal cadence when the last read was
 * healthy, a faster retry cadence right after an error so a network blip
 * (or a HUD that just regained connectivity) recovers in ~15 s instead of
 * waiting out the full 90 s window.
 * @param {{error?: string}} usage
 * @param {number} intervalMs
 * @param {number} heartbeatMs
 */
function nextPollDelay(usage, intervalMs, heartbeatMs) {
  return usage && usage.error ? heartbeatMs : intervalMs;
}

/**
 * Periodically fetches usage and emits when it changes (like PortWatcher).
 * The renderer computes the countdown to reset from resetsAt, so we compare
 * state WITHOUT the derived field (fetchedAt) - otherwise it would emit every
 * tick with no real change.
 *
 * Heartbeat: after a failed read the next tick arrives after heartbeatMs
 * (default 15 s) instead of the full intervalMs (90 s), until a read succeeds
 * again - then it returns to the normal, slower cadence. These are plain GETs
 * that cost no Claude tokens, so retrying every 15 s with no attempt limit is cheap.
 */
class UsageWatcher {
  /** @param {(usage: object) => void} onUpdate */
  constructor(onUpdate, intervalMs = 90000, heartbeatMs = 15000) {
    this.onUpdate = onUpdate;
    this.intervalMs = intervalMs;
    this.heartbeatMs = heartbeatMs;
    this.timer = null;
    this.lastJson = '';
    this.busy = false;
    this.running = false;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.tick(); // first read immediately
  }

  stop() {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  async tick() {
    if (this.busy) return; // do not overlap requests
    this.busy = true;
    let usage;
    try {
      usage = await fetchUsage();
      const cmp = JSON.stringify({ ...usage, fetchedAt: 0 });
      if (cmp !== this.lastJson) {
        this.lastJson = cmp;
        this.onUpdate(usage);
      }
    } finally {
      this.busy = false;
      if (this.running) {
        this.timer = setTimeout(() => this.tick(), nextPollDelay(usage, this.intervalMs, this.heartbeatMs));
      }
    }
  }

  /** Forces an immediate read + emit (the refresh button in the UI). */
  refresh() {
    this.lastJson = ''; // force an emit on the next read
    if (this.timer) {
      clearTimeout(this.timer); // avoid duplicating the already-scheduled next tick
      this.timer = null;
    }
    return this.tick();
  }
}

/**
 * Pure decision for the 50%/80% voice announcements: given the current
 * fiveHour pct and the previous announce state, says whether a threshold was
 * just crossed. No I/O here - main.js's checkUsageThresholds() does the
 * actual soundManager.play() with whatever this returns as `fire`.
 *
 * Re-arms at 40 (not 50) so hovering exactly at the 50% line across two polls
 * can't flip announced/un-announced and spam the sound.
 * @param {number|null} pct
 * @param {{at50: boolean, at80: boolean}} announced
 * @returns {{next: {at50: boolean, at80: boolean}, fire: 'usage50'|'usage80'|null}}
 */
function nextUsageAnnounced(pct, announced) {
  if (typeof pct !== 'number') return { next: announced, fire: null };
  if (pct >= 80 && !announced.at80) {
    // Crossing 80 necessarily crossed 50 too - mark both so a later poll
    // can't fire the (now redundant, and out-of-order) usage50 afterwards.
    return { next: { at50: true, at80: true }, fire: 'usage80' };
  }
  if (pct >= 50 && !announced.at50) {
    return { next: { ...announced, at50: true }, fire: 'usage50' };
  }
  if (pct < 40 && (announced.at50 || announced.at80)) {
    return { next: { at50: false, at80: false }, fire: null };
  }
  return { next: announced, fire: null };
}

module.exports = { fetchUsage, UsageWatcher, nextUsageAnnounced, nextPollDelay };
