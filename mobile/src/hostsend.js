// ============================================================================
// LunaCore phone - send one signed command to a host and wait for its answer
// ----------------------------------------------------------------------------
// docs/REMOTE_HOST_PLAN.md H1/H2. Every command is signed with the session
// key (hostkey.js; Face ID once per session and host, with the passkey paired
// with that host) and written to host_commands; the host claims it, runs it
// and writes status + result. A host that refuses the grant (it restarted,
// or the phone was forgotten) drops it here, so the next try asks Face ID.
// ============================================================================

import * as hostkey from './hostkey.js';
import { pairedCredential } from './hostpair.js';

const POLL_MS = 1000;
/** hostcommands.js MAX_TTL_MS: past this the host refuses the row anyway. */
const GIVE_UP_MS = 2 * 60 * 1000;
const DONE = new Set(['done', 'refused', 'failed']);

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {object} cloud cloud.js
 * @param {string} host machine name
 * @param {string} kind e.g. 'chat.start'
 * @param {object} payload
 * @returns {Promise<{status: 'done'|'refused'|'failed'|'timeout', result: object}>}
 *   result = the handler's answer; its `status` string is the host's verdict
 */
export async function sendHostCommand(cloud, host, kind, payload) {
  const credentialId = await pairedCredential(host);
  const signed = await hostkey.signCommand(host, kind, payload, { credentialId });
  const id = await cloud.hostCommand(signed);
  const until = Date.now() + GIVE_UP_MS;
  while (Date.now() < until) {
    await wait(POLL_MS);
    const row = await cloud.hostCommandRead(id).catch(() => null);
    if (!row || !DONE.has(row.status)) continue;
    const result = row.result && typeof row.result === 'object' && !Array.isArray(row.result) ? row.result : {};
    if (row.status === 'refused' && typeof result.error === 'string' && /grant|session|passkey/i.test(result.error)) await hostkey.dropGrant(host);
    return { status: row.status, result };
  }
  return { status: 'timeout', result: {} };
}
