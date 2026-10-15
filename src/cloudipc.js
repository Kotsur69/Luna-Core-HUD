// ============================================================================
// LunaCore - cloud sync IPC (main process)
// ----------------------------------------------------------------------------
// cloud:status  -> {ok, configured, loggedIn, user, lastSync, pending, error}
// cloud:login   -> {ok} | {ok:false, reason}   GitHub in the system browser
// cloud:logout  -> {ok}
// cloud:syncNow -> {ok} | {ok:false, reason}
//
// The renderer is untrusted: no channel takes a payload, and answers are
// rebuilt from a whitelist - no token, no raw error text ever crosses over.
// Login and sync now are rate-limited so a looping renderer cannot open
// browser tabs or hammer Supabase. Lives outside main.js (past the file-size
// guideline); main.js only calls registerCloudIpc() once.
// ============================================================================

'use strict';

const MIN_LOGIN_GAP_MS = 3000;
const MIN_SYNC_GAP_MS = 5000;
const MAX_USER_LEN = 100;
const REASONS = new Set([
  'not-configured',
  'logged-out',
  'no-encryption',
  'timeout',
  'denied',
  'pull-failed',
  'push-failed',
  'rate-limited',
  'failed',
]);

const reason = (r) => (REASONS.has(r) ? r : 'failed');
const answer = (res) => (res && res.ok === true ? { ok: true } : { ok: false, reason: reason(res && res.reason) });

function cleanStatus(s) {
  const st = s && typeof s === 'object' ? s : {};
  return {
    ok: true,
    configured: st.configured === true,
    loggedIn: st.loggedIn === true,
    user: typeof st.user === 'string' && st.user ? st.user.slice(0, MAX_USER_LEN) : null,
    lastSync: Number.isSafeInteger(st.lastSync) && st.lastSync > 0 ? st.lastSync : null,
    pending: Number.isSafeInteger(st.pending) && st.pending > 0 ? st.pending : 0,
    error: st.error == null ? null : reason(st.error),
  };
}

/**
 * @param {{ipcMain: {handle: Function}, cloud: object, now?: () => number}} deps
 *   cloud = startCloud() from src/cloudsync.js (or a fake in tests).
 */
function registerCloudIpc({ ipcMain, cloud, now = Date.now }) {
  let lastLoginAt = -Infinity;
  let lastSyncAt = -Infinity;
  let lastLogoutAt = -Infinity;

  const guarded = async (fn) => {
    try {
      return answer(await fn());
    } catch (err) {
      console.error('[cloud] ipc failed:', (err && (err.code || err.name)) || 'error');
      return { ok: false, reason: 'failed' };
    }
  };

  ipcMain.handle('cloud:status', () => cleanStatus(cloud.status()));

  ipcMain.handle('cloud:login', () => {
    const at = now();
    if (at - lastLoginAt < MIN_LOGIN_GAP_MS) return { ok: false, reason: 'rate-limited' };
    lastLoginAt = at;
    return guarded(() => cloud.login());
  });

  ipcMain.handle('cloud:logout', () => {
    const at = now();
    if (at - lastLogoutAt < MIN_LOGIN_GAP_MS) return { ok: false, reason: 'rate-limited' };
    lastLogoutAt = at;
    return guarded(async () => (await cloud.logout(), { ok: true }));
  });

  ipcMain.handle('cloud:syncNow', () => {
    const at = now();
    if (at - lastSyncAt < MIN_SYNC_GAP_MS) return { ok: false, reason: 'rate-limited' };
    lastSyncAt = at;
    return guarded(() => cloud.syncNow());
  });
}

module.exports = { registerCloudIpc };
