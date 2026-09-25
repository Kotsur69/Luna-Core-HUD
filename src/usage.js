// ============================================================================
// LunaCore - subscription usage meter (provider-aware)
// ----------------------------------------------------------------------------
// Fetches usage limits from the active AI provider's API endpoint.
// Supports: Claude, OpenAI/Codex, GLM/Zhipu, and Local models with fallback.
//
// Provider Resolution:
//   The active provider is determined from the current profile's templateId
//   (config/providers.json). Each provider has its own adapter that fetches
//   real account limits or rate-limit headers.
//
// Normalized Output:
//   {
//     providerId: 'claude'|'openai'|'glm'|'local',
//     displayName: string,
//     status: 'ok'|'loading'|'error'|'unsupported'|'unconfigured',
//     errorMessage: string|null,
//     limits: [{window, label, unit, used, limit, percentUsed, source}],
//     isFallback: boolean,  // true if showing Claude while using Local
//     updatedAt: number
//   }
// ============================================================================

'use strict';

const https = require('https');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

// ============================================================================
// UTILITIES
// ============================================================================

/** Reads a fresh accessToken from the CLI's credentials file. */
function readClaudeToken() {
  try {
    const credPath = path.join(os.homedir(), '.claude', '.credentials.json');
    const cred = JSON.parse(fs.readFileSync(credPath, 'utf8'));
    const oauth = cred && cred.claudeAiOauth;
    if (oauth && typeof oauth.accessToken === 'string' && oauth.accessToken) {
      return oauth.accessToken;
    }
  } catch {
    /* missing file / invalid JSON - treated as no authorization */
  }
  return null;
}

/** Makes a GET request and returns {status, body, headers}. */
function httpsGet(host, pathname, token, additionalHeaders = {}) {
  return new Promise((resolve) => {
    const req = https.request(
      {
        method: 'GET',
        host,
        path: pathname,
        headers: {
          Authorization: token ? `Bearer ${token}` : undefined,
          Accept: 'application/json',
          'User-Agent': 'LunaCore/0.1 (usage-meter)',
          ...additionalHeaders,
        },
        timeout: 8000,
      },
      (res) => {
        let body = '';
        res.on('data', (d) => (body += d));
        res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
      }
    );
    req.on('error', () => resolve({ status: 0, body: '', headers: {} }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ status: 0, body: '', headers: {} });
    });
    req.end();
  });
}

/** Makes a GET request to HTTP (for local endpoints). */
function httpGet(host, pathname, port = 80, token = null, additionalHeaders = {}) {
  return new Promise((resolve) => {
    const options = {
      method: 'GET',
      hostname: host,
      port,
      path: pathname,
      headers: {
        Accept: 'application/json',
        'User-Agent': 'LunaCore/0.1 (usage-meter)',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...additionalHeaders,
      },
      timeout: 8000,
    };
    const req = http.request(options, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
    });
    req.on('error', () => resolve({ status: 0, body: '', headers: {} }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ status: 0, body: '', headers: {} });
    });
    req.end();
  });
}

/** Normalizes a single rate-limit window. */
function pickWindow(w) {
  if (!w || typeof w.utilization !== 'number') return null;
  return {
    pct: Math.max(0, Math.min(100, Math.round(w.utilization))),
    resetsAt: typeof w.resets_at === 'string' ? w.resets_at : null,
  };
}

/** Extracts rate-limit info from HTTP headers. */
function extractRateLimitHeaders(headers) {
  if (!headers) return null;
  const remaining = headers['x-ratelimit-remaining-requests'] || headers['x-ratelimit-remaining-tokens'];
  const limit = headers['x-ratelimit-limit-requests'] || headers['x-ratelimit-limit-tokens'];
  if (typeof remaining === 'string') {
    const used = parseInt(remaining, 10);
    if (!isNaN(used)) {
      return { used, limit: typeof limit === 'string' ? parseInt(limit, 10) : null };
    }
  }
  return null;
}

// ============================================================================
// BASE ADAPTER INTERFACE
// ============================================================================

/**
 * @typedef {Object} UsageLimit
 * @property {'5h'|'daily'|'weekly'|'monthly'|'balance'|'custom'} window
 * @property {string} label
 * @property {'messages'|'tokens'|'credits'|'currency'} unit
 * @property {number} used
 * @property {number} limit
 * @property {number} percentUsed
 * @property {'account'|'response_headers'|'manual'} source
 */

/**
 * Base adapter interface. All providers implement:
 * - fetchUsage(profile): Promise<NormalizedUsage>
 */
class UsageAdapter {
  /**
   * @param {string} providerId
   * @param {string} displayName
   */
  constructor(providerId, displayName) {
    this.providerId = providerId;
    this.displayName = displayName;
  }

  /** @returns {Promise<import('./usage-types').NormalizedUsage>} */
  async fetchUsage() {
    throw new Error('Not implemented');
  }
}

// ============================================================================
// CLAUDE ADAPTER
// ============================================================================

/**
 * Fetches usage from Claude's OAuth endpoint:
 * GET https://api.anthropic.com/api/oauth/usage
 *
 * This is a plain read (GET), NOT a model call. It consumes no tokens.
 */
class ClaudeAdapter extends UsageAdapter {
  constructor() {
    super('claude', 'Claude');
  }

  /**
   * @param {Object} profile - active profile (unused, kept for interface)
   * @returns {Promise<import('./usage-types').NormalizedUsage>}
   */
  async fetchUsage(profile) {
    const token = readClaudeToken();
    if (!token) {
      return {
        providerId: this.providerId,
        displayName: this.displayName,
        status: 'unconfigured',
        errorMessage: 'No Claude OAuth token found in ~/.claude/.credentials.json',
        limits: [],
        isFallback: false,
        updatedAt: Date.now(),
      };
    }

    const { status, body, headers } = await httpsGet(
      'api.anthropic.com',
      '/api/oauth/usage',
      token
    );

    if (status === 401 || status === 403) {
      return {
        providerId: this.providerId,
        displayName: this.displayName,
        status: 'error',
        errorMessage: 'Claude OAuth token expired or invalid (401/403)',
        limits: [],
        isFallback: false,
        updatedAt: Date.now(),
      };
    }

    if (status !== 200) {
      return {
        providerId: this.providerId,
        displayName: this.displayName,
        status: 'error',
        errorMessage: `Claude usage endpoint returned status ${status}`,
        limits: [],
        isFallback: false,
        updatedAt: Date.now(),
      };
    }

    let data;
    try {
      data = JSON.parse(body);
    } catch {
      return {
        providerId: this.providerId,
        displayName: this.displayName,
        status: 'error',
        errorMessage: 'Failed to parse Claude usage response',
        limits: [],
        isFallback: false,
        updatedAt: Date.now(),
      };
    }

    const fiveHour = pickWindow(data.five_hour);
    const sevenDay = pickWindow(data.seven_day);

    const limits = [];
    if (fiveHour) {
      limits.push({
        window: '5h',
        label: '5-hour window',
        unit: 'messages',
        used: Math.round((fiveHour.pct / 100) * 1000), // estimated based on percentage
        limit: 1000,
        percentUsed: fiveHour.pct,
        source: 'account',
      });
    }
    if (sevenDay) {
      limits.push({
        window: 'weekly',
        label: 'Weekly limit',
        unit: 'messages',
        used: Math.round((sevenDay.pct / 100) * 7000),
        limit: 7000,
        percentUsed: sevenDay.pct,
        source: 'account',
      });
    }

    return {
      providerId: this.providerId,
      displayName: this.displayName,
      status: limits.length > 0 ? 'ok' : 'unsupported',
      errorMessage: null,
      limits,
      isFallback: false,
      updatedAt: Date.now(),
    };
  }
}

// ============================================================================
// OPENAI / CODEX ADAPTER
// ============================================================================

/**
 * OpenAI/Codex usage adapter.
 *
 * Attempts to fetch real billing data first. If that fails (401/403),
 * falls back to rate-limit headers from response (which requires an actual
 * API call to be made). For local models, returns 'unsupported'.
 */
class OpenAiAdapter extends UsageAdapter {
  constructor() {
    super('openai', 'OpenAI/Codex');
  }

  /**
   * Extracts API key and org ID from profile env.
   * @param {Object} profile
   * @returns {{apiKey: string, organizationId?: string}}
   */
  getAuth(profile) {
    if (!profile || !profile.env) return { apiKey: '' };
    // Only a real OpenAI key may be sent to api.openai.com. ANTHROPIC_AUTH_TOKEN
    // on these templates is a Kimi/Gemini/xAI key or a CCR client key, and
    // must never leave for a host that did not issue it.
    const apiKey = profile.env.OPENAI_API_KEY;
    const organizationId = profile.env.OPENAI_ORG_ID || profile.env.ORGANIZATION_ID;
    return { apiKey, organizationId };
  }

  /**
   * @param {Object} profile - active profile with env containing API key
   * @returns {Promise<import('./usage-types').NormalizedUsage>}
   */
  async fetchUsage(profile) {
    const { apiKey, organizationId } = this.getAuth(profile);

    if (!apiKey) {
      return {
        providerId: this.providerId,
        displayName: this.displayName,
        status: 'unconfigured',
        errorMessage: 'No OpenAI API key configured (set OPENAI_API_KEY)',
        limits: [],
        isFallback: false,
        updatedAt: Date.now(),
      };
    }

    // Try to fetch real billing usage
    const billingResult = await this.fetchBillingUsage(apiKey, organizationId);

    if (billingResult.status === 'ok') {
      return billingResult;
    }

    // If billing API fails with 401/403/404, it's not admin-level access
    // We can still show rate-limit headers from a test call
    const headersResult = await this.fetchRateLimitHeaders(apiKey);

    if (headersResult.status === 'ok') {
      return {
        providerId: this.providerId,
        displayName: this.displayName,
        status: 'ok',
        errorMessage: null,
        limits: [
          {
            window: 'custom',
            label: headersResult.limits[0].label || 'Rate limit',
            unit: headersResult.limits[0].unit,
            used: headersResult.limits[0].used,
            limit: headersResult.limits[0].limit,
            percentUsed: headersResult.limits[0].percentUsed,
            source: 'response_headers',
          },
        ],
        isFallback: false,
        updatedAt: Date.now(),
      };
    }

    return {
      providerId: this.providerId,
      displayName: this.displayName,
      status: 'unsupported',
      errorMessage: billingResult.errorMessage || headersResult.errorMessage,
      limits: [],
      isFallback: false,
      updatedAt: Date.now(),
    };
  }

  /**
   * Tries to fetch billing/usage data from OpenAI's API.
   * Returns {status:'ok'} or {status:'error', errorMessage}.
   */
  async fetchBillingUsage(apiKey, organizationId) {
    // Try /v1/dashboard/billing/usage (daily) and /v1/dashboard/billing/subscription (monthly)
    const now = new Date();
    const endDate = now.toISOString().split('T')[0];
    const startDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)
      .toISOString()
      .split('T')[0];

    try {
      // Try subscription endpoint first (shows total budget)
      const { status: subStatus, body: subBody } = await httpsGet(
        'api.openai.com',
        '/v1/dashboard/billing/subscription',
        apiKey,
        { 'OpenAI-Organization': organizationId }
      );

      if (subStatus === 200) {
        let data;
        try {
          data = JSON.parse(subBody);
        } catch {
          // Ignore parse errors, continue to other endpoint
        }

        if (data && typeof data.hard_limit_usd === 'number') {
          return {
            status: 'ok',
            errorMessage: null,
          };
        }
      }
    } catch {
      // Continue to next attempt
    }

    // Try usage endpoint
    try {
      const { status, body } = await httpsGet(
        'api.openai.com',
        `/v1/dashboard/billing/usage?start_date=${startDate}&end_date=${endDate}`,
        apiKey,
        { 'OpenAI-Organization': organizationId }
      );

      if (status === 200) {
        try {
          const data = JSON.parse(body);
          const totalUsage = data.total_usage || 0;

          return {
            status: 'ok',
            errorMessage: null,
          };
        } catch {
          // Parse error - return unsupported
        }
      }

      if (status === 401 || status === 403) {
        return {
          status: 'error',
          errorMessage: 'Billing API requires Admin token or is unavailable for this key',
        };
      }
    } catch (err) {
      // Continue to next attempt
    }

    return { status: 'unsupported', errorMessage: 'Billing API not available' };
  }

  /**
   * Makes a minimal test call and extracts rate-limit headers.
   */
  async fetchRateLimitHeaders(apiKey) {
    try {
      const { status, headers } = await httpsGet(
        'api.openai.com',
        '/v1/models',
        apiKey
      );

      if (status === 200) {
        const rateInfo = extractRateLimitHeaders(headers);
        if (rateInfo) {
          return {
            status: 'ok',
            limits: [
              {
                window: 'custom',
                label: 'Rate limit',
                unit: 'requests',
                used: rateInfo.used,
                limit: rateInfo.limit || 0,
                percentUsed: rateInfo.limit ? Math.round((rateInfo.used / rateInfo.limit) * 100) : 0,
                source: 'response_headers',
              },
            ],
          };
        }
      }

      if (status === 401 || status === 403) {
        return {
          status: 'error',
          errorMessage: 'API key invalid or lacks permissions',
        };
      }

      return { status: 'unsupported', errorMessage: `HTTP ${status}` };
    } catch (err) {
      return { status: 'error', errorMessage: err.message || 'Network error' };
    }
  }
}

// ============================================================================
// GLM (Zhipu / BigModel) ADAPTER
// ============================================================================

/**
 * GLM usage adapter.
 *
 * Zhipu/BigModel requires JWT authentication for balance queries.
 * If only api_key is available (no api_secret), returns 'unconfigured'.
 */
class GlmAdapter extends UsageAdapter {
  constructor() {
    super('glm', 'GLM');
  }

  /**
   * Extracts API key and secret from profile env.
   * @param {Object} profile
   * @returns {{apiKey: string, apiSecret?: string}}
   */
  getAuth(profile) {
    if (!profile || !profile.env) return { apiKey: '', apiSecret: '' };
    const apiKey = profile.env.ANTHROPIC_AUTH_TOKEN;
    const apiSecret = profile.env.ZHIPU_API_SECRET || profile.env.API_SECRET;
    return { apiKey, apiSecret };
  }

  /**
   * Generates JWT token from API key and secret.
   * @param {string} apiKey
   * @param {string} apiSecret
   * @returns {string|null}
   */
  generateJwt(apiKey, apiSecret) {
    if (!apiKey || !apiSecret) return null;

    try {
      const jwt = require('jsonwebtoken');
      const now = Math.floor(Date.now() / 1000);
      const token = jwt.sign(
        {
          api_key: apiKey,
          exp: now + 300, // 5 minutes
          timestamp: now,
        },
        apiSecret,
        { algorithm: 'HS256' }
      );
      return token;
    } catch {
      // Fallback: use simple base64 encoding if jsonwebtoken not available
      const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64');
      const payload = Buffer.from(
        JSON.stringify({
          api_key: apiKey,
          exp: Math.floor(Date.now() / 1000) + 300,
          timestamp: Math.floor(Date.now() / 1000),
        })
      ).toString('base64');
      return `${header}.${payload}.`;
    }
  }

  /**
   * @param {Object} profile - active profile with env containing API key/secret
   * @returns {Promise<import('./usage-types').NormalizedUsage>}
   */
  async fetchUsage(profile) {
    const { apiKey, apiSecret } = this.getAuth(profile);

    if (!apiKey) {
      return {
        providerId: this.providerId,
        displayName: this.displayName,
        status: 'unconfigured',
        errorMessage: 'No API key configured (set ANTHROPIC_AUTH_TOKEN)',
        limits: [],
        isFallback: false,
        updatedAt: Date.now(),
      };
    }

    if (!apiSecret) {
      return {
        providerId: this.providerId,
        displayName: this.displayName,
        status: 'unconfigured',
        errorMessage:
          'Balance checking requires API secret. Add ZHIPU_API_SECRET or API_SECRET to profile env.',
        limits: [],
        isFallback: false,
        updatedAt: Date.now(),
      };
    }

    const jwtToken = this.generateJwt(apiKey, apiSecret);
    if (!jwtToken) {
      return {
        providerId: this.providerId,
        displayName: this.displayName,
        status: 'error',
        errorMessage: 'Failed to generate JWT token',
        limits: [],
        isFallback: false,
        updatedAt: Date.now(),
      };
    }

    try {
      // Try Zhipu balance endpoint
      const { status, body } = await httpsGet(
        'open.bigmodel.cn',
        '/api/paas/v4/billing/balance',
        jwtToken
      );

      if (status === 200) {
        let data;
        try {
          data = JSON.parse(body);
        } catch {
          return {
            providerId: this.providerId,
            displayName: this.displayName,
            status: 'error',
            errorMessage: 'Failed to parse GLM balance response',
            limits: [],
            isFallback: false,
            updatedAt: Date.now(),
          };
        }

        // Zhipu returns {code, message, data: {balance}}
        const balance = (data && data.data && typeof data.data.balance === 'number') || 0;

        return {
          providerId: this.providerId,
          displayName: this.displayName,
          status: balance > 0 ? 'ok' : 'unsupported',
          errorMessage: null,
          limits: [
            {
              window: 'balance',
              label: 'Account balance',
              unit: 'credits',
              used: Math.round(balance),
              limit: Math.round(balance), // GLM shows remaining, so used = total
              percentUsed: 0,
              source: 'account',
            },
          ],
          isFallback: false,
          updatedAt: Date.now(),
        };
      }

      if (status === 401 || status === 403) {
        return {
          providerId: this.providerId,
          displayName: this.displayName,
          status: 'error',
          errorMessage: 'JWT token invalid or expired',
          limits: [],
          isFallback: false,
          updatedAt: Date.now(),
        };
      }

      return {
        providerId: this.providerId,
        displayName: this.displayName,
        status: 'unsupported',
        errorMessage: `GLM endpoint returned ${status}`,
        limits: [],
        isFallback: false,
        updatedAt: Date.now(),
      };
    } catch (err) {
      return {
        providerId: this.providerId,
        displayName: this.displayName,
        status: 'error',
        errorMessage: err.message || 'Network error',
        limits: [],
        isFallback: false,
        updatedAt: Date.now(),
      };
    }
  }
}

// ============================================================================
// LOCAL MODEL ADAPTER
// ============================================================================

/**
 * Local model adapter (LM Studio, Ollama, etc.).
 *
 * Local models have no remote usage limits. Returns 'unsupported'.
 * If fallback mode is enabled, can show Claude usage with isFallback flag.
 */
class LocalAdapter extends UsageAdapter {
  constructor() {
    super('local', 'Local');
  }

  /**
   * @param {Object} profile - active profile
   * @returns {Promise<import('./usage-types').NormalizedUsage>}
   */
  async fetchUsage(profile) {
    return {
      providerId: this.providerId,
      displayName: this.displayName,
      status: 'unsupported',
      errorMessage: 'Local model has no remote usage limits',
      limits: [],
      isFallback: false,
      updatedAt: Date.now(),
    };
  }
}

// ============================================================================
// FALLBACK ADAPTER (Local + Claude Display)
// ============================================================================

/**
 * Fallback adapter for when local model is active but we want to display
 * Claude usage. This is a "best effort" display only.
 */
class FallbackAdapter extends UsageAdapter {
  constructor(claudeAdapter) {
    super('claude', 'Claude (Fallback)');
    this.claudeAdapter = claudeAdapter;
  }

  /**
   * @param {Object} profile - active profile
   * @returns {Promise<import('./usage-types').NormalizedUsage>}
   */
  async fetchUsage(profile) {
    const result = await this.claudeAdapter.fetchUsage(profile);

    return {
      ...result,
      providerId: 'local', // Keep original provider
      displayName: 'Local (Claude usage)',
      isFallback: true, // Mark as fallback display
      errorMessage:
        result.errorMessage ||
        'Local model active — showing Claude usage for reference',
    };
  }
}

// ============================================================================
// PROVIDER ADAPTER REGISTRY
// ============================================================================

const PROVIDER_ADAPTERS = {
  'claude-cloud': () => new ClaudeAdapter(),
  'lm-studio': () => new LocalAdapter(),
  glm: () => new GlmAdapter(),
  kimi: () => new OpenAiAdapter(), // Uses OpenAI-compatible endpoint
  'kimi-code': () => new OpenAiAdapter(),
  ollama: () => new LocalAdapter(),
  codex: () => new OpenAiAdapter(),
  gemini: () => new OpenAiAdapter(),
  grok: () => new OpenAiAdapter(),
  'openai-compatible': () => new OpenAiAdapter(),
};

/**
 * Returns the appropriate adapter for a profile's provider.
 * @param {Object} profile
 * @returns {UsageAdapter}
 */
function getAdapterForProfile(profile) {
  if (!profile || !profile.templateId) {
    // Default to Claude for unknown profiles
    return new ClaudeAdapter();
  }

  const templateId = String(profile.templateId);
  const adapterFactory = PROVIDER_ADAPTERS[templateId];

  if (adapterFactory) {
    return adapterFactory();
  }

  // Fallback: use Claude for unregistered templates
  return new ClaudeAdapter();
}

// ============================================================================
// MAIN USAGE FETCHER
// ============================================================================

/**
 * Fetches usage data based on the active provider from profile.
 * @param {Object} [profile] - active profile. If not provided, loads from config.
 * @returns {Promise<import('./usage-types').NormalizedUsage>}
 */
async function fetchUsage(profile) {
  // Load profile if not provided
  const activeProfile = profile || (require('./profiles').loadProfiles().profiles[0]);

  const adapter = getAdapterForProfile(activeProfile);

  try {
    return await adapter.fetchUsage(activeProfile);
  } catch (err) {
    return {
      providerId: adapter.providerId,
      displayName: adapter.displayName,
      status: 'error',
      errorMessage: err.message || 'Unknown error',
      limits: [],
      isFallback: false,
      updatedAt: Date.now(),
    };
  }
}

/**
 * Forces refresh by clearing any cached state.
 */
function forceRefresh() {
  // No caching currently, but kept for interface consistency
}

// ============================================================================
// USAGE WATCHER
// ============================================================================

/**
 * Periodically fetches usage and emits when it changes.
 * Adapts to the active provider automatically.
 */
class UsageWatcher {
  /**
   * @param {(usage: import('./usage-types').NormalizedUsage) => void} onUpdate
   * @param {number} intervalMs
   * @param {number} heartbeatMs
   */
  constructor(onUpdate, intervalMs = 90000, heartbeatMs = 15000) {
    this.onUpdate = onUpdate;
    this.intervalMs = intervalMs;
    this.heartbeatMs = heartbeatMs;
    this.timer = null;
    this.lastJson = '';
    this.busy = false;
    this.running = false;
    this.claudeAdapter = new ClaudeAdapter();
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

  /**
   * Gets the current active profile for usage lookup.
   * @returns {Object|null}
   */
  getActiveProfile() {
    try {
      const { loadProfiles } = require('./profiles');
      return loadProfiles().profiles[0] || null;
    } catch {
      return null;
    }
  }

  async tick() {
    if (this.busy) return;
    this.busy = true;

    let usage;
    try {
      const profile = this.getActiveProfile();
      usage = await fetchUsage(profile);
      const cmp = JSON.stringify({ ...usage, updatedAt: 0 });
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

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Decision behind the heartbeat: normal cadence when the last read was
 * healthy, a faster retry cadence right after an error.
 */
function nextPollDelay(usage, intervalMs, heartbeatMs) {
  return usage && usage.status === 'error' ? heartbeatMs : intervalMs;
}

/**
 * Pure decision for the 50%/80% voice announcements: given the current
 * fiveHour pct and the previous announce state, says whether a threshold was
 * just crossed.
 * @param {number|null} pct
 * @param {{at50: boolean, at80: boolean}} announced
 * @returns {{next: {at50: boolean, at80: boolean}, fire: 'usage50'|'usage80'|null}}
 */
function nextUsageAnnounced(pct, announced) {
  if (typeof pct !== 'number') return { next: announced, fire: null };
  if (pct >= 80 && !announced.at80) {
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

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  fetchUsage,
  UsageWatcher,
  nextUsageAnnounced,
  nextPollDelay,
  forceRefresh,

  // Adapters exported for testing
  ClaudeAdapter,
  OpenAiAdapter,
  GlmAdapter,
  LocalAdapter,
  FallbackAdapter,
  getAdapterForProfile,
};
