// ============================================================================
// LunaCore - claude-code-router (CCR) IPC controller
// ----------------------------------------------------------------------------
// The ccr:* IPC handlers plus the one piece of state they share: whether THIS
// process started the gateway. Extracted from main.js (Phase 6 of
// reference/AI_PROVIDERS_RESUME.md) so the rules below are unit-tested rather
// than inline in a 2700-line file. src/ccr.js still owns every process and
// network call; this module only decides WHEN to make them.
//
// Trust boundary (unchanged from the inline version): the renderer only ever
// sends an intent or a profile id - never a token, URL or port. Main resolves
// anything sensitive from its own unredacted profile list. Beyond that:
//   - a gateway LunaCore did not start is never stopped (startedByUs);
//   - ccr:test-key only ever sends a CCR-routed profile's own client key to
//     that profile's own loopback gateway. A GLM/Kimi profile's real key is
//     refused before any network call, and so is a non-secret sentinel;
//   - no handler ever returns a token or the management UI's URL.
// ============================================================================

'use strict';

const ccr = require('./ccr');
const { DEFAULT_CCR_PORT, isCcrProfile } = require('./providers');
const { getProfile, NON_SECRET_AUTH_TOKENS } = require('./profiles');

/** Fixed docs address - never renderer-supplied. */
const CCR_DOCS_URL = 'https://ccrdesk.top/en/';

/**
 * @param {{
 *   send: (channel:string, payload:Object) => void,
 *   getProfiles: () => Array<Object>,   main's UNREDACTED in-memory profiles
 *   getProviders: () => Array<Object>,  loadProviders().providers
 *   openExternal: (url:string) => void,
 *   safeUrl: (url:string) => string|null,
 *   ccrApi?: typeof ccr,                injectable for tests
 * }} deps
 */
function createCcrControl({ send, getProfiles, getProviders, openExternal, safeUrl, ccrApi = ccr }) {
  // Whether THIS process started the CCR gateway (vs. finding one already
  // running) - only a gateway we started ourselves may ever be stopped by us
  // (see src/ccr.js's stopGateway header).
  let startedByUs = false;

  /**
   * Broadcasts the gateway's lifecycle state to the renderer. `extra`
   * typically carries the originating sessionId, so the renderer can show a
   * per-tab status line rather than only a global one.
   */
  function broadcastState(extra) {
    send('ccr:state', { startedByUs, ...extra });
  }

  async function status() {
    const detected = await ccrApi.detectCcr();
    if (!detected.ok) {
      return {
        installed: false,
        version: '',
        expectedPort: DEFAULT_CCR_PORT,
        startedByUs,
        ...ccrApi.describeState({ installed: false }),
      };
    }
    const found = await ccrApi.findGateway(DEFAULT_CCR_PORT);
    const state = ccrApi.describeState({
      installed: true,
      probe: found.ok ? found.classification : 'down',
      expectedPort: DEFAULT_CCR_PORT,
      foundPort: found.ok ? found.port : undefined,
      startedByUs,
    });
    return { installed: true, version: detected.version, expectedPort: DEFAULT_CCR_PORT, startedByUs, ...state };
  }

  async function start() {
    const result = await ccrApi.startGateway({ expectedPort: DEFAULT_CCR_PORT });
    if (result.ok) startedByUs = startedByUs || result.startedByUs;
    broadcastState({});
    return result;
  }

  async function stop() {
    const result = await ccrApi.stopGateway({ startedByUs });
    if (result.ok) startedByUs = false;
    broadcastState({});
    return result;
  }

  /**
   * Confirms a CCR-routed profile's client key authenticates against its own
   * gateway. `profileId` is the only renderer input; everything else is read
   * from main's own profile list. The result never carries the key.
   * @param {unknown} profileId
   * @returns {Promise<{ok:true, models:number}|{ok:false, reason:string}>}
   */
  async function testKey(profileId) {
    if (typeof profileId !== 'string' || !profileId) return { ok: false, reason: 'unknown-profile' };
    const profile = getProfile(getProfiles(), profileId);
    if (!profile) return { ok: false, reason: 'unknown-profile' };
    if (!isCcrProfile(profile, getProviders())) return { ok: false, reason: 'not-ccr' };
    const raw = profile.env && typeof profile.env.ANTHROPIC_AUTH_TOKEN === 'string' ? profile.env.ANTHROPIC_AUTH_TOKEN : '';
    const token = raw.trim();
    if (!token || NON_SECRET_AUTH_TOKENS.has(token)) return { ok: false, reason: 'no-key' };
    const port = ccrApi.gatewayPortFromEnv(profile.env);
    if (port === null) return { ok: false, reason: 'not-local' };
    return ccrApi.testClientKey(port, token);
  }

  /**
   * Lazily makes sure a gateway is available for a just-spawned CCR-routed
   * session, WITHOUT blocking the spawn - the caller fires and forgets. Every
   * src/ccr.js function this calls resolves a typed result and never rejects.
   * @param {{id:string}} session
   * @param {{env?:Object}} profile
   */
  async function ensureGatewayFor(session, profile) {
    const expectedPort = ccrApi.gatewayPortFromEnv(profile.env);
    const found = await ccrApi.findGateway(expectedPort);
    if (!found.ok) {
      const detected = await ccrApi.detectCcr();
      if (detected.ok) {
        const started = await ccrApi.startGateway({ expectedPort });
        if (started.ok) startedByUs = startedByUs || started.startedByUs;
      }
    }
    broadcastState({ sessionId: session.id });
  }

  /**
   * App quit: best-effort stop of a gateway this process started. Never
   * blocks shutdown; the flag is cleared first so a second call is a no-op.
   */
  function shutdown() {
    if (!startedByUs) return;
    startedByUs = false;
    Promise.resolve(ccrApi.stopGateway({ startedByUs: true })).catch(() => {});
  }

  /** Registers every ccr:* channel on an ipcMain-shaped object. */
  function registerIpc(ipcMain) {
    ipcMain.handle('ccr:status', () => status());
    ipcMain.handle('ccr:start', () => start());
    ipcMain.handle('ccr:stop', () => stop());
    // openManagementUi() never returns a URL, by construction (see
    // src/ccr.js) - the authenticated management address (and its token) can
    // never leak downstream through this handler even by accident.
    ipcMain.handle('ccr:open-ui', () => ccrApi.openManagementUi());
    // Hardcoded destination; still run through safeUrl() for defense in
    // depth. Any renderer payload is ignored.
    ipcMain.on('ccr:docs', () => {
      const url = safeUrl(CCR_DOCS_URL);
      if (url) openExternal(url);
    });
    // Drives the "Test connection" button on a CCR profile row (Settings >
    // AI providers). Only the id crosses IPC; see testKey().
    ipcMain.handle('ccr:test-key', (_event, profileId) => testKey(profileId));
  }

  return {
    registerIpc,
    ensureGatewayFor,
    shutdown,
    isStartedByUs: () => startedByUs,
  };
}

module.exports = { createCcrControl, CCR_DOCS_URL };
