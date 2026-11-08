// ============================================================================
// LunaCore phone - signed host command runners (Host + Chat, Phone God Mode B-D)
// ----------------------------------------------------------------------------
// Commands go through hostsend.js (Face ID once per session and host,
// hostkey.js). A runner runs one command at a time; a refusal, a timeout or a
// failed send becomes a toast with the host's reason, and the caller gets
// null. A host's own "refused: ..." / "failed: ..." verdict inside a done row
// counts as a refusal too.
//  - createRunner: any host per call, with the UI locked via onBusy (Host, Chat)
//  - createRunners: one runner per host for the God Mode controls
// ============================================================================

import { t, tf } from '../i18n.js';
import { sendHostCommand } from '../hostsend.js';
import { refusalKey } from '../godmodestart.js';

/** A refusal code -> the text in the toast: the phone's own words when it knows the code. */
export function refusalText(code) {
  const key = refusalKey(code);
  return key ? t(key) : String(code || t('gmErr_unknown'));
}

/** One signed command: the result, or null after a toast. */
async function sendOnce({ cloud, toast }, host, kind, payload) {
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
  }
}

/**
 * @param {{cloud: object, toast: (m: string, bad?: boolean) => void, onBusy?: (busy: boolean) => void}} deps
 * @returns {(host: string, kind: string, payload: object) => Promise<object|null>}
 */
export function createRunner(deps) {
  const onBusy = typeof deps.onBusy === 'function' ? deps.onBusy : () => {};
  let busy = false;
  return async function run(host, kind, payload) {
    if (busy) return null;
    busy = true;
    onBusy(true);
    try {
      return await sendOnce(deps, host, kind, payload);
    } finally {
      busy = false;
      onBusy(false);
    }
  };
}

/**
 * @param {{cloud: object, toast: (m: string, bad?: boolean) => void}} deps
 * @param {string} host machine name
 * @returns {{host: string, busy: () => boolean, run: (kind: string, payload: object) => Promise<object|null>}}
 */
export function createHostRunner(deps, host) {
  let busy = false;

  async function run(kind, payload) {
    if (busy) return null;
    busy = true;
    try {
      return await sendOnce(deps, host, kind, payload);
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
    if (!byHost.has(id)) byHost.set(id, createHostRunner(deps, host));
    return byHost.get(id);
  };
}
