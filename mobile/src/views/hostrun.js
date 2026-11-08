// ============================================================================
// LunaCore phone - one host's signed-command runner (Phone God Mode B-D)
// ----------------------------------------------------------------------------
// The God Mode controls send signed godmode.* commands through hostsend.js
// (Face ID once per session and host, hostkey.js). A runner belongs to one
// host and runs one command at a time; a refusal, a timeout or a failed send
// becomes a toast with the host's reason, and the caller gets null.
// ============================================================================

import { t, tf } from '../i18n.js';
import { sendHostCommand } from '../hostsend.js';
import { refusalKey } from '../godmodestart.js';

/** A refusal code -> the text in the toast: the phone's own words when it knows the code. */
export function refusalText(code) {
  const key = refusalKey(code);
  return key ? t(key) : String(code || t('gmErr_unknown'));
}

/**
 * @param {{cloud: object, toast: (m: string, bad?: boolean) => void}} deps
 * @param {string} host machine name
 * @returns {{host: string, busy: () => boolean, run: (kind: string, payload: object) => Promise<object|null>}}
 */
export function createRunner({ cloud, toast }, host) {
  let busy = false;

  async function run(kind, payload) {
    if (busy) return null;
    busy = true;
    try {
      const { status, result } = await sendHostCommand(cloud, host, kind, payload);
      const verdict = typeof result.status === 'string' ? result.status : status;
      if (status !== 'done' || /^(refused|failed)/.test(verdict)) {
        toast(tf('hostRefused', { why: refusalText(typeof result.error === 'string' ? result.error : verdict) }), true);
        return null;
      }
      return result;
    } catch (err) {
      toast(t(err && err.name === 'NotAllowedError' ? 'pairCancelled' : 'hostSendFailed'), true);
      return null;
    } finally {
      busy = false;
    }
  }

  return { host, busy: () => busy, run };
}

/** One runner per host, made on first use: its busy flag spans every card of that host. */
export function createRunners(deps) {
  const byHost = new Map();
  return (host) => {
    const id = String(host).toLowerCase();
    if (!byHost.has(id)) byHost.set(id, createRunner(deps, host));
    return byHost.get(id);
  };
}
