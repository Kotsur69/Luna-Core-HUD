// ============================================================================
// LunaCore - report email IPC (main process)
// ----------------------------------------------------------------------------
// mail:status      -> {ok, gmail:{configured, connected, email}, prefs, godmodeOn, weeklyOn,
//                      replies:{on, connected, clients, projects}}
// mail:connect     -> browser consent for gmail.send (src/gmailsend.js)
// mail:disconnect  -> forgets the Gmail grant (and the reply-read grant with it)
// mail:set {patch} -> validated by mailprefs.savePrefs (known keys only)
// mail:test        -> sends the nightly summary now, marked [test]
// mail:replies {on}                     -> "Read replies to Luna's Work emails":
//                      on = a fresh gmail.readonly consent (src/gmailread.js), for the
//                      same address as the send grant; off = revoke it at Google
// mail:reply-clients {projectId, emails} -> a project's allow-listed client addresses
//
// The renderer never names a recipient, a subject or a body: it can only
// toggle settings and ask for the fixed reports. Every payload is checked
// here, in main, before it reaches a store. Lives outside main.js (past
// the file-size guideline); main.js only calls registerMailIpc() once.
// ============================================================================

'use strict';

const { godmodeEmailOn, weeklyEmailOn } = require('./mailprefs');

const REASONS = new Set([
  'busy', 'rate-limited', 'gmail-no-client', 'gmail-not-connected', 'gmail-auth', 'gmail-scope', 'gmail-denied',
  'gmail-timeout', 'gmail-network', 'gmail-no-email', 'gmail-failed', 'bad-time', 'bad-value',
  'gmail-other-account', 'unknown-project',
]);
/** "Send test now" runs a Haiku call and sends a mail: no bursts. */
const TEST_GAP_MS = 30 * 1000;

const MAX_EMAIL_CHARS = 254;

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

const reasonOf = (err) => {
  const r = err && (err.reason || (err.message === 'bad time' ? 'bad-time' : err.message === 'bad value' ? 'bad-value' : null));
  return REASONS.has(r) ? r : 'failed';
};

/**
 * @param {{ipcMain:object, sender:object, prefs:object, nightly:{sendNow:Function}, now?:()=>number,
 *   reader?:{status:Function, connect:Function, disconnect:Function},
 *   replies?:{refresh:()=>Promise<number>},
 *   projects?:()=>Array<{id:string, label:unknown}>}} deps
 *   reader / replies / projects: the opt-in email replies (B17); without them
 *   the reply channels answer `failed` and the status has replies: null
 */
function registerMailIpc({ ipcMain, sender, prefs, nightly, reader, replies, projects = () => [], now = Date.now }) {
  let connecting = false;
  let lastTestAt = -Infinity;

  const knownProjects = () => (Array.isArray(projects()) ? projects() : []).filter((p) => isObj(p) && typeof p.id === 'string');

  function repliesStatus(p, gmail) {
    if (!reader) return null;
    const r = reader.status();
    return {
      on: p.replyRead === true && r.connected && gmail.connected && r.email === gmail.email,
      connected: r.connected,
      clients: p.replyClients,
      projects: knownProjects().map((x) => ({ id: x.id, label: x.label })),
    };
  }

  const status = () => {
    const gmail = sender.status();
    const p = prefs.loadPrefs();
    return {
      ok: true,
      gmail,
      prefs: p,
      godmodeOn: godmodeEmailOn(p, gmail.connected),
      weeklyOn: weeklyEmailOn(p, gmail.connected),
      replies: repliesStatus(p, gmail),
    };
  };

  /** The poll follows the setting; a failure there never fails the IPC answer. */
  const refreshReplies = () => {
    if (!replies) return;
    Promise.resolve()
      .then(() => replies.refresh())
      .catch((err) => console.error('[mail] reply poll failed:', err && err.message));
  };

  /** Turns reply reading off: the setting first, then the grant revoked at Google. */
  async function repliesOff() {
    prefs.setReplyRead(false);
    await reader.disconnect();
    refreshReplies();
  }

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

  ipcMain.handle('mail:disconnect', async () => {
    sender.disconnect();
    // No send grant, no replies to read: the read grant goes with it.
    if (reader && (reader.status().connected || prefs.loadPrefs().replyRead)) {
      try {
        await repliesOff();
      } catch (err) {
        console.error('[mail] reply grant not removed:', err && err.message);
      }
    }
    return status();
  });

  ipcMain.handle('mail:replies', async (_event, payload) => {
    const on = isObj(payload) ? payload.on : undefined;
    if (typeof on !== 'boolean') return { ok: false, reason: 'bad-value' };
    if (!reader) return { ok: false, reason: 'failed' };
    if (connecting) return { ok: false, reason: 'busy' };
    connecting = true;
    try {
      if (!on) {
        await repliesOff();
        return status();
      }
      const gmail = sender.status();
      if (!gmail.connected) return { ok: false, reason: 'gmail-not-connected' };
      // Always a fresh consent: the read scope is never added silently.
      const { email } = await reader.connect();
      if (email !== gmail.email) {
        await reader.disconnect();
        return { ok: false, reason: 'gmail-other-account' };
      }
      prefs.setReplyRead(true);
      refreshReplies();
      return status();
    } catch (err) {
      console.error('[mail] reply read consent failed:', err && err.reason, err && err.message);
      return { ok: false, reason: reasonOf(err) };
    } finally {
      connecting = false;
    }
  });

  ipcMain.handle('mail:reply-clients', (_event, payload) => {
    if (!isObj(payload) || typeof payload.projectId !== 'string' || !Array.isArray(payload.emails)) return { ok: false, reason: 'bad-value' };
    if (!knownProjects().some((p) => p.id === payload.projectId)) return { ok: false, reason: 'unknown-project' };
    if (!payload.emails.every((e) => typeof e === 'string' && e.length <= MAX_EMAIL_CHARS)) return { ok: false, reason: 'bad-value' };
    try {
      const next = prefs.setReplyClients(payload.projectId, payload.emails);
      // The allow-list decides who may write client feedback: every change is on record.
      const list = (next && next.replyClients && next.replyClients[payload.projectId]) || [];
      console.info(`[mail] reply allow-list for ${payload.projectId}: ${list.length ? list.join(', ') : '(empty)'}`);
      return status();
    } catch (err) {
      return { ok: false, reason: reasonOf(err) };
    }
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
