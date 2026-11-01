// ============================================================================
// LunaCore - Gmail reply reader (OAuth 2.0, gmail.readonly, opt-in)
// ----------------------------------------------------------------------------
// Reads replies to Luna's Work emails (src/lunasworkMailReplies.js) - only
// when Mati turned "Read replies to Luna's Work emails" on, which runs its
// own fresh consent. A SEPARATE grant from the send one (src/gmailsend.js):
//   - scope 'openid email https://www.googleapis.com/auth/gmail.readonly' -
//     the narrowest read scope; no modify, no labels, no send. What was
//     already imported is kept in LunaCore's own state, not as a Gmail label;
//   - its own encrypted token file, gmail-read-token.local.json; turning the
//     setting off revokes the refresh token at Google and deletes the file;
//   - thread() is the only API call: one thread by the id Gmail gave our
//     own email when it was sent. No search, no listing of the inbox, and
//     attachments are never fetched (format=full carries their ids only).
// ============================================================================

'use strict';

const { createGmailGrant, GmailError, gmailId, FETCH_TIMEOUT_MS } = require('./gmailsend');

const READ_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
const SCOPE = `openid email ${READ_SCOPE}`;
const TOKEN_FILE = 'gmail-read-token.local.json';
const THREAD_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/threads/';
// A reply thread is short; anything past this is not looked at.
const MAX_MESSAGES = 50;

/**
 * @param {{fetchImpl?:Function, openExternal?:Function, safeStorage?:object,
 *   clientPath?:string, tokenPath?:string, redirectServer?:Function}} [deps]
 */
function createGmailReader(deps = {}) {
  const grant = createGmailGrant({ scope: SCOPE, requiredScope: READ_SCOPE, tokenName: TOKEN_FILE }, deps);

  /**
   * The messages of one thread (untrusted Gmail API objects), oldest first,
   * or null when the thread is gone.
   * @param {string} threadId
   * @returns {Promise<object[]|null>}
   */
  async function thread(threadId) {
    const id = gmailId(threadId);
    if (!id) throw new GmailError('gmail-failed', 'bad thread id');
    const token = await grant.accessToken();
    const url = `${THREAD_URL}${encodeURIComponent(id)}?format=full`;
    let res;
    try {
      res = await grant.fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    } catch (err) {
      throw new GmailError('gmail-network', err && err.message);
    }
    if (res.status === 404) return null;
    if (res.status === 401) {
      grant.invalidate();
      throw new GmailError('gmail-auth', 'HTTP 401');
    }
    if (res.status === 403) throw new GmailError('gmail-scope', 'HTTP 403');
    if (!res.ok) throw new GmailError('gmail-failed', `HTTP ${res.status}`);
    const body = await res.json().catch(() => ({}));
    return Array.isArray(body && body.messages) ? body.messages.slice(0, MAX_MESSAGES) : [];
  }

  return { status: grant.status, connect: grant.connect, email: grant.email, disconnect: grant.revoke, thread };
}

module.exports = { createGmailReader, SCOPE, READ_SCOPE, TOKEN_FILE };
