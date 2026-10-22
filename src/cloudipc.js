// ============================================================================
// LunaCore - cloud sync IPC (main process)
// ----------------------------------------------------------------------------
// cloud:status  -> {ok, configured, loggedIn, user, lastSync, pending, error}
// cloud:login   -> {ok} | {ok:false, reason}   GitHub in the system browser
// cloud:logout  -> {ok}
// cloud:syncNow -> {ok} | {ok:false, reason}
// cloud:machines -> {ok, machines:[{machine, label, updatedAt, self}]} | {ok:false, reason}
// cloud:forget(machine) -> {ok, removed} | {ok:false, reason}
//                  deletes a retired PC's snapshot rows; never this PC's
//
// The renderer is untrusted: only cloud:forget takes a payload (a machine
// name, checked here and again in cloudsnapshots.js), and answers are
// rebuilt from a whitelist - no token, no raw error text ever crosses over.
// Login and sync now are rate-limited so a looping renderer cannot open
// browser tabs or hammer Supabase. Lives outside main.js (past the file-size
// guideline); main.js only calls registerCloudIpc() once.
// ============================================================================

'use strict';

const { MACHINE_RE } = require('./cloudsnapshots');
const { machineLabel } = require('./missionledgersync');

const MIN_LOGIN_GAP_MS = 3000;
const MIN_SYNC_GAP_MS = 5000;
const MIN_FORGET_GAP_MS = 3000;
/** cloud:machines answers from this cache, so a looping renderer cannot hammer Supabase. */
const MACHINES_TTL_MS = 3000;
const MAX_USER_LEN = 100;
const MAX_MACHINES = 64;
const REASONS = new Set([
  'not-configured',
  'logged-out',
  'no-encryption',
  'timeout',
  'denied',
  'pull-failed',
  'push-failed',
  'rate-limited',
  'bad-machine',
  'own-machine',
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

function cleanMachines(list) {
  if (!Array.isArray(list)) return { ok: false, reason: 'failed' };
  const machines = list
    .filter((m) => m && typeof m.machine === 'string' && MACHINE_RE.test(m.machine))
    .slice(0, MAX_MACHINES)
    .map((m) => ({
      machine: m.machine,
      label: machineLabel(m.machine),
      updatedAt: Number.isSafeInteger(m.updatedAt) && m.updatedAt > 0 ? m.updatedAt : null,
      self: m.self === true,
    }));
  return { ok: true, machines };
}

/**
 * @param {{ipcMain: {handle: Function}, cloud: object, now?: () => number}} deps
 *   cloud = startCloud() from src/cloudsync.js (or a fake in tests).
 */
function registerCloudIpc({ ipcMain, cloud, now = Date.now }) {
  let lastLoginAt = -Infinity;
  let lastSyncAt = -Infinity;
  let lastLogoutAt = -Infinity;
  let lastForgetAt = -Infinity;
  let machinesHit = null; // {at, answer}

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

  ipcMain.handle('cloud:machines', async () => {
    if (!cloud.status().loggedIn) return { ok: false, reason: 'logged-out' };
    const at = now();
    if (machinesHit && at - machinesHit.at < MACHINES_TTL_MS) return machinesHit.answer;
    try {
      const res = cleanMachines(await cloud.snapshots.machines());
      machinesHit = res.ok ? { at, answer: res } : null;
      return res;
    } catch (err) {
      console.error('[cloud] machines failed:', (err && (err.code || err.name)) || 'error');
      return { ok: false, reason: 'failed' };
    }
  });

  ipcMain.handle('cloud:forget', async (_e, machine) => {
    if (typeof machine !== 'string' || !MACHINE_RE.test(machine)) return { ok: false, reason: 'bad-machine' };
    const at = now();
    if (at - lastForgetAt < MIN_FORGET_GAP_MS) return { ok: false, reason: 'rate-limited' };
    lastForgetAt = at;
    try {
      const res = await cloud.snapshots.forget(machine);
      machinesHit = null;
      if (res && res.ok === true) return { ok: true, removed: Number.isSafeInteger(res.removed) ? res.removed : 0 };
      return { ok: false, reason: reason(res && res.reason) };
    } catch (err) {
      console.error('[cloud] forget failed:', (err && (err.code || err.name)) || 'error');
      return { ok: false, reason: 'failed' };
    }
  });
}

module.exports = { registerCloudIpc };
