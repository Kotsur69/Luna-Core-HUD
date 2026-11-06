// ============================================================================
// LunaCore phone - one signed host command with the UI locked (Host + Chat)
// ----------------------------------------------------------------------------
// A refusal or failure becomes a toast and null; a host's own "refused: ..."
// / "failed: ..." verdict inside a done row counts as a refusal too.
// ============================================================================

import { t, tf } from '../i18n.js';
import { sendHostCommand } from '../hostsend.js';

/**
 * @param {{cloud: object, toast: (m: string, bad?: boolean) => void, onBusy: (busy: boolean) => void}} deps
 * @returns {(host: string, kind: string, payload: object) => Promise<object|null>}
 */
export function createRunner({ cloud, toast, onBusy }) {
  let busy = false;
  return async function run(host, kind, payload) {
    if (busy) return null;
    busy = true;
    onBusy(true);
    try {
      const { status, result } = await sendHostCommand(cloud, host, kind, payload);
      const verdict = typeof result.status === 'string' ? result.status : status;
      if (status !== 'done' || /^(refused|failed)/.test(verdict)) {
        toast(tf('hostRefused', { why: typeof result.error === 'string' ? result.error : verdict }), true);
        return null;
      }
      return result;
    } catch (err) {
      toast(t(err && err.name === 'NotAllowedError' ? 'pairCancelled' : 'hostSendFailed'), true);
      return null;
    } finally {
      busy = false;
      onBusy(false);
    }
  };
}
