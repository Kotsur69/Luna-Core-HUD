// ============================================================================
// LunaCore - report email IPC (main process)
// ----------------------------------------------------------------------------
// mail:status      -> {ok, gmail:{configured, connected, email}, prefs, godmodeOn}
// mail:connect     -> browser consent for gmail.send (src/gmailsend.js)
// mail:disconnect  -> forgets the Gmail grant
// mail:set {patch} -> validated by mailprefs.savePrefs (known keys only)
// mail:test        -> sends the nightly summary now, marked [test]
//
// The renderer never names a recipient, a subject or a body: it can only
// toggle settings and ask for the fixed reports. Lives outside main.js (past
// the file-size guideline); main.js only calls registerMailIpc() once.
// ============================================================================

'use strict';

const { godmodeEmailOn } = require('./mailprefs');

const REASONS = new Set([
  'busy', 'rate-limited', 'gmail-no-client', 'gmail-not-connected', 'gmail-auth', 'gmail-scope', 'gmail-denied',
  'gmail-timeout', 'gmail-network', 'gmail-no-email', 'gmail-failed', 'bad-time', 'bad-value',
]);
/** "Send test now" runs a Haiku call and sends a mail: no bursts. */
const TEST_GAP_MS = 30 * 1000;

const reasonOf = (err) => {
  const r = err && (err.reason || (err.message === 'bad time' ? 'bad-time' : err.message === 'bad value' ? 'bad-value' : null));
  return REASONS.has(r) ? r : 'failed';
};

/**
 * @param {{ipcMain:object, sender:object, prefs:object, nightly:{sendNow:Function}, now?:()=>number}} deps
 */
function registerMailIpc({ ipcMain, sender, prefs, nightly, now = Date.now }) {
  let connecting = false;
  let lastTestAt = -Infinity;

  const status = () => {
    const gmail = sender.status();
    const p = prefs.loadPrefs();
    return { ok: true, gmail, prefs: p, godmodeOn: godmodeEmailOn(p, gmail.connected) };
  };

  ipcMain.handle('mail:status', () => status());

  ipcMain.handle('mail:connect', async () => {
    if (connecting) return { ok: false, reason: 'busy' };
    connecting = true;
    try {
      await sender.connect();
      return status();
    } catch (err) {
      console.error('[mail] gmail connect failed:', err && err.reason, err && err.message);
      return { ok: false, reason: reasonOf(err) };
    } finally {
      connecting = false;
    }
  });

  ipcMain.handle('mail:disconnect', () => {
    sender.disconnect();
    return status();
  });

  ipcMain.handle('mail:set', (_event, patch) => {
    try {
      prefs.savePrefs(patch);
      return status();
    } catch (err) {
      return { ok: false, reason: reasonOf(err) };
    }
  });

  ipcMain.handle('mail:test', async () => {
    const at = now();
    if (at - lastTestAt < TEST_GAP_MS) return { ok: false, reason: 'rate-limited' };
    lastTestAt = at;
    const res = await nightly.sendNow({ test: true });
    return res.ok ? { ok: true } : { ok: false, reason: REASONS.has(res.reason) ? res.reason : 'failed' };
  });
}

module.exports = { registerMailIpc };
