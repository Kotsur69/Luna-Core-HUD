// ============================================================================
// LunaCore - usage-limit parsers for non-Claude providers (pure)
// ----------------------------------------------------------------------------
// Every provider reports its quota differently. Each parser below turns one
// provider's raw payload into the UsageLimit[] the usage panel already renders
// for Claude (src/usage-types.js), or null when the payload carries nothing
// usable. No IO here - src/providerusage.js does the reading and fetching -
// so every format is unit tested against fixtures (test/providerusage.test.js).
//
//   Codex      ~/.codex/sessions/**/rollout-*.jsonl `token_count` events, and
//              the ChatGPT backend's /backend-api/wham/usage (same windows)
//   GLM/Z.ai   /api/monitor/usage/quota/limit (Coding Plan: 5 h token window
//              + monthly tool-call quota)
//   Kimi Code  {base}/v1/usages (weekly quota + rolling windows)
//   Moonshot   /v1/users/me/balance (pay-as-you-go balance, no window)
//   Gemini     Code Assist v1internal:retrieveUserQuota (per-model daily
//              buckets, Google-account login only)
//   OpenRouter /api/v1/key (credit limit and usage of the key)
//
// A field a provider omits stays out; nothing is guessed. resetsAt is only
// ever an ISO time derived from the provider's own data.
// ============================================================================

'use strict';

const MINUTES_PER_HOUR = 60;
const MINUTES_PER_DAY = 24 * MINUTES_PER_HOUR;
const MINUTES_PER_WEEK = 7 * MINUTES_PER_DAY;

/** Clamps to a whole 0..100 percentage, or null when not a finite number. */
function clampPct(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, Math.round(n)));
}

/** A finite number from a number or numeric string, else null. */
function num(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Epoch seconds or milliseconds (or an ISO string) -> ISO string, else null. */
function toIso(value) {
  if (typeof value === 'string') {
    const asNum = num(value);
    if (asNum === null) {
      const ms = Date.parse(value);
      return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
    }
    return toIso(asNum);
  }
  const n = num(value);
  if (n === null || n <= 0) return null;
  // Anything below 1e12 is seconds (1e12 ms is 2001; 1e12 s is year 33658).
  return new Date(n < 1e12 ? n * 1000 : n).toISOString();
}

/** The panel's window id for a window length in minutes. */
function windowForMinutes(minutes) {
  if (minutes === 5 * MINUTES_PER_HOUR) return '5h';
  if (minutes === MINUTES_PER_DAY) return 'daily';
  if (minutes === MINUTES_PER_WEEK) return 'weekly';
  if (minutes >= 28 * MINUTES_PER_DAY && minutes <= 31 * MINUTES_PER_DAY) return 'monthly';
  return 'custom';
}

/** English fallback label (the renderer localizes known windows itself). */
function labelForMinutes(minutes) {
  const w = windowForMinutes(minutes);
  if (w === '5h') return '5-hour window';
  if (w === 'daily') return 'Daily limit';
  if (w === 'weekly') return 'Weekly limit';
  if (w === 'monthly') return 'Monthly limit';
  if (minutes % MINUTES_PER_DAY === 0) return `${minutes / MINUTES_PER_DAY}-day window`;
  if (minutes % MINUTES_PER_HOUR === 0) return `${minutes / MINUTES_PER_HOUR}-hour window`;
  return `${minutes}-minute window`;
}

/** One percentage-based limit in the shape the panel renders. */
function pctLimit({ window, label, percentUsed, resetsAt = null, source = 'account', unit = 'messages' }) {
  return { window, label, unit, used: percentUsed, limit: 100, percentUsed, resetsAt, source };
}

// --- Codex -------------------------------------------------------------------

/**
 * One Codex window. Accepts both spellings: the rollout log's
 * {used_percent, window_minutes, resets_in_seconds | resets_at} and the
 * backend's {used_percent, limit_window_seconds, reset_after_seconds | reset_at}.
 * @param {object} w
 * @param {number} baseMs when the reading was taken (for relative resets)
 */
function codexWindow(w, baseMs) {
  if (!w || typeof w !== 'object') return null;
  const percentUsed = clampPct(w.used_percent);
  if (percentUsed === null) return null;
  const minutes = num(w.window_minutes) !== null
    ? num(w.window_minutes)
    : (num(w.limit_window_seconds) !== null ? Math.round(num(w.limit_window_seconds) / 60) : null);
  const absolute = toIso(w.resets_at !== undefined ? w.resets_at : w.reset_at);
  const relative = num(w.resets_in_seconds) !== null ? num(w.resets_in_seconds) : num(w.reset_after_seconds);
  const resetsAt = absolute
    || (relative !== null && Number.isFinite(baseMs) ? new Date(baseMs + relative * 1000).toISOString() : null);
  return pctLimit({
    window: minutes ? windowForMinutes(minutes) : 'custom',
    label: minutes ? labelForMinutes(minutes) : 'Rate limit',
    percentUsed,
    resetsAt,
  });
}

/**
 * Codex rate limits -> UsageLimit[] (primary = short window, secondary =
 * weekly), or null when neither window parses.
 * @param {object} rl {primary, secondary} or {primary_window, secondary_window}
 * @param {number} baseMs
 */
function parseCodexRateLimits(rl, baseMs) {
  if (!rl || typeof rl !== 'object') return null;
  const limits = [rl.primary || rl.primary_window, rl.secondary || rl.secondary_window]
    .map((w) => codexWindow(w, baseMs))
    .filter(Boolean);
  return limits.length > 0 ? limits : null;
}

/** The ChatGPT backend usage payload -> UsageLimit[] or null. */
function parseCodexUsageResponse(json, nowMs) {
  if (!json || typeof json !== 'object') return null;
  return parseCodexRateLimits(json.rate_limit || json.rate_limits, nowMs);
}

/**
 * The newest `token_count` event with rate limits in one rollout JSONL file.
 * Lines are scanned from the end; broken lines are skipped.
 * @param {string} text
 * @returns {{limits:Array, at:number}|null}
 */
function latestCodexRateLimits(text) {
  const lines = String(text || '').split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim();
    if (!line || !line.includes('rate_limits')) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const payload = entry && (entry.payload || entry.msg || entry);
    if (!payload || payload.type !== 'token_count' || !payload.rate_limits) continue;
    const at = Date.parse(entry.timestamp);
    const limits = parseCodexRateLimits(payload.rate_limits, at);
    if (limits) return { limits, at: Number.isFinite(at) ? at : null };
  }
  return null;
}

// --- GLM / Z.ai ----------------------------------------------------------------

/** Z.ai quota units: 3 = hours, 5 = months, 6 = weeks, 1 = days (observed). */
const ZAI_UNIT_MINUTES = { 1: MINUTES_PER_DAY, 3: MINUTES_PER_HOUR, 5: 30 * MINUTES_PER_DAY, 6: MINUTES_PER_WEEK };

/** The Coding Plan quota payload -> UsageLimit[] or null. */
function parseZaiQuota(json) {
  const items = json && json.data && Array.isArray(json.data.limits) ? json.data.limits : null;
  if (!items) return null;
  const limits = items.map((item) => {
    if (!item || typeof item !== 'object') return null;
    const total = num(item.usage);
    const current = num(item.currentValue);
    const percentUsed = clampPct(num(item.percentage) !== null
      ? item.percentage
      : (total && current !== null ? (current / total) * 100 : null));
    if (percentUsed === null) return null;
    const unitMinutes = ZAI_UNIT_MINUTES[num(item.unit)];
    const minutes = unitMinutes && num(item.number) ? unitMinutes * num(item.number) : null;
    const isTools = item.type === 'TIME_LIMIT';
    return pctLimit({
      window: minutes ? windowForMinutes(minutes) : (isTools ? 'monthly' : 'custom'),
      label: isTools ? 'Tool calls (MCP)' : (minutes ? labelForMinutes(minutes) : 'Token limit'),
      percentUsed,
      resetsAt: toIso(item.nextResetTime),
      unit: isTools ? 'messages' : 'tokens',
    });
  }).filter(Boolean);
  return limits.length > 0 ? limits : null;
}

// --- Kimi Code -----------------------------------------------------------------

const KIMI_TIME_UNIT_MINUTES = {
  TIME_UNIT_MINUTE: 1,
  TIME_UNIT_HOUR: MINUTES_PER_HOUR,
  TIME_UNIT_DAY: MINUTES_PER_DAY,
  TIME_UNIT_WEEK: MINUTES_PER_WEEK,
};

/** {limit, used, remaining, resetTime} -> percentage limit or null. */
function kimiDetail(detail, window, label) {
  if (!detail || typeof detail !== 'object') return null;
  const limit = num(detail.limit);
  const used = num(detail.used) !== null
    ? num(detail.used)
    : (limit !== null && num(detail.remaining) !== null ? limit - num(detail.remaining) : null);
  if (!limit || used === null) return null;
  return pctLimit({ window, label, percentUsed: clampPct((used / limit) * 100), resetsAt: toIso(detail.resetTime || detail.reset_time) });
}

/** The Kimi Code /usages payload -> UsageLimit[] or null. */
function parseKimiCodeUsages(json) {
  if (!json || typeof json !== 'object') return null;
  const windows = (Array.isArray(json.limits) ? json.limits : []).map((entry) => {
    const w = entry && entry.window;
    const minutes = w && num(w.duration) !== null && KIMI_TIME_UNIT_MINUTES[w.timeUnit]
      ? num(w.duration) * KIMI_TIME_UNIT_MINUTES[w.timeUnit]
      : null;
    return kimiDetail(entry && (entry.detail || entry),
      minutes ? windowForMinutes(minutes) : 'custom',
      minutes ? labelForMinutes(minutes) : 'Rate limit');
  });
  const summary = kimiDetail(json.usage, 'weekly', 'Weekly limit');
  const limits = [...windows, summary].filter(Boolean);
  return limits.length > 0 ? limits : null;
}

// --- Moonshot (Kimi API) ---------------------------------------------------------

/**
 * The Moonshot balance payload -> one balance row (no percentage: a prepaid
 * balance has no ceiling) or null.
 * @param {object} json
 * @param {string} currency 'USD' (api.moonshot.ai) or 'CNY' (api.moonshot.cn)
 */
function parseMoonshotBalance(json, currency = 'USD') {
  const data = json && json.data;
  const balance = data ? num(data.available_balance) : null;
  if (balance === null) return null;
  return [{
    window: 'balance',
    label: 'Balance',
    unit: 'currency',
    used: null,
    limit: null,
    percentUsed: null,
    valueText: `${balance.toFixed(2)} ${currency}`,
    resetsAt: null,
    source: 'account',
  }];
}

// --- Gemini (Google account) -----------------------------------------------------

/**
 * Code Assist quota buckets -> one daily row per model, or null. Buckets for
 * the same model (input/output token types) collapse to the most-used one.
 */
function parseGeminiQuota(json) {
  const buckets = json && Array.isArray(json.buckets) ? json.buckets : null;
  if (!buckets) return null;
  const byModel = new Map();
  for (const b of buckets) {
    const fraction = b ? num(b.remainingFraction) : null;
    if (fraction === null || !b.modelId) continue;
    const percentUsed = clampPct((1 - fraction) * 100);
    const prev = byModel.get(b.modelId);
    if (!prev || percentUsed > prev.percentUsed) {
      byModel.set(b.modelId, pctLimit({
        window: 'daily',
        label: String(b.modelId),
        percentUsed,
        resetsAt: toIso(b.resetTime),
        unit: 'messages',
      }));
    }
  }
  const limits = [...byModel.values()];
  return limits.length > 0 ? limits : null;
}

// --- OpenRouter -------------------------------------------------------------------

/** The OpenRouter /key payload -> credit row (percentage when capped) or null. */
function parseOpenRouterKey(json) {
  const data = json && json.data;
  if (!data || typeof data !== 'object') return null;
  const usage = num(data.usage);
  const cap = num(data.limit);
  if (usage === null) return null;
  if (cap && cap > 0) {
    return [{ ...pctLimit({ window: 'custom', label: 'Credit limit', percentUsed: clampPct((usage / cap) * 100), unit: 'credits' }), used: usage, limit: cap }];
  }
  return [{
    window: 'balance',
    label: data.is_free_tier ? 'Free tier (credits used)' : 'Credits used',
    unit: 'credits',
    used: usage,
    limit: null,
    percentUsed: null,
    valueText: `${usage.toFixed(2)} USD`,
    resetsAt: null,
    source: 'account',
  }];
}

module.exports = {
  clampPct,
  toIso,
  windowForMinutes,
  labelForMinutes,
  parseCodexRateLimits,
  parseCodexUsageResponse,
  latestCodexRateLimits,
  parseZaiQuota,
  parseKimiCodeUsages,
  parseMoonshotBalance,
  parseGeminiQuota,
  parseOpenRouterKey,
};
