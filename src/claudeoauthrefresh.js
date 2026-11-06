// ============================================================================
// LunaCore - OAuth refresh for a usage-only Claude login (~/.claude-usage-<id>)
// ----------------------------------------------------------------------------
// `claude auth status` only reports the login state; it never refreshes the
// access token, so a usage login died ~8 h after connecting. This performs the
// same refresh_token grant the Claude CLI does for its own login and writes
// the new tokens back into <dir>/.credentials.json atomically, keeping every
// other field.
//
// Values taken from the installed CLI (Claude Code 2.1.319, its prod OAuth
// config object and its refresh function), not guessed:
//   POST https://platform.claude.com/v1/oauth/token   (JSON body)
//   {grant_type:'refresh_token', refresh_token, client_id, scope}
//   -> {access_token, refresh_token? (rotates; falls back to the old one),
//       expires_in (s), refresh_token_expires_in? (s)}
//
// A rotated refresh token revokes the old one, so a grant whose write failed
// is held in `pending` (main-process memory only) and the next attempt only
// retries the write - it never calls the token endpoint again, which would
// send the now-dead refresh token. Before every write the file is re-read: if
// its refresh token is no longer the one that was sent (a reconnect landed
// meanwhile), the grant is dropped instead of clobbering the new login.
//
// Never for the main ~/.claude login - the CLI owns that file. A token is
// read, sent to the token endpoint and written to the file only: it is never
// logged, returned or thrown. Every process-bound dep is injected.
// ============================================================================

'use strict';

const fs = require('fs');
const https = require('https');
const path = require('path');
const crypto = require('crypto');

const TOKEN_HOST = 'platform.claude.com';
const TOKEN_PATH = '/v1/oauth/token';
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
/** The CLI's default scopes, used only when the file stores none. */
const DEFAULT_SCOPES = Object.freeze([
  'user:profile', 'user:inference', 'user:sessions:claude_code', 'user:mcp_servers', 'user:file_upload',
]);
const USAGE_DIR_PREFIX = '.claude-usage-';
const POST_TIMEOUT_MS = 30 * 1000;
const MAX_BODY_BYTES = 64 * 1024;
const MAX_TOKEN_CHARS = 8 * 1024;
/** No sane access token lives longer; a bigger expires_in is rejected. */
const MAX_EXPIRES_IN_S = 30 * 24 * 3600;
/** Printable ASCII, no whitespace or control characters. */
const TOKEN_RE = /^[\x21-\x7e]+$/;
const RENAME_TRIES = 5;
const RENAME_RETRY_MS = 50;
/** Windows rename errors caused by a briefly open target (AV, indexer, CLI). */
const RENAME_BUSY = new Set(['EPERM', 'EBUSY', 'EACCES']);
const CREDENTIALS_FILE = '.credentials.json';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * POST a JSON body over https -> {status, body}. Never rejects; a network
 * failure, timeout or an oversized answer is status 0.
 * @param {string} host
 * @param {string} pathname
 * @param {object} payload
 * @returns {Promise<{status:number, body:string}>}
 */
function postJson(host, pathname, payload) {
  return new Promise((resolve) => {
    const data = JSON.stringify(payload);
    let settled = false;
    const done = (res) => {
      if (!settled) {
        settled = true;
        resolve(res);
      }
    };
    const req = https.request(
      {
        method: 'POST',
        host,
        path: pathname,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
          Accept: 'application/json',
          'User-Agent': 'LunaCore/0.1 (usage-meter)',
        },
        timeout: POST_TIMEOUT_MS,
      },
      (res) => {
        const chunks = [];
        let size = 0;
        res.on('data', (d) => {
          size += d.length;
          if (size > MAX_BODY_BYTES) {
            done({ status: 0, body: '' });
            req.destroy();
            return;
          }
          chunks.push(d);
        });
        // Decoded once at the end, so a character split across chunks survives.
        res.on('end', () => done({ status: res.statusCode || 0, body: Buffer.concat(chunks).toString('utf8') }));
        res.on('error', () => done({ status: 0, body: '' }));
      },
    );
    req.on('error', () => done({ status: 0, body: '' }));
    req.on('timeout', () => {
      req.destroy();
      done({ status: 0, body: '' });
    });
    req.end(data);
  });
}

/** Writes `text` to `file` and flushes it to disk before returning. */
function writeAndSync(file, text) {
  const fd = fs.openSync(file, 'w', 0o600);
  try {
    fs.writeSync(fd, text, 0, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Write `text` to `file` atomically: a flushed temp file next to it
 * (owner-only mode on POSIX), then rename over the target. A rename blocked
 * by a briefly open target is retried; the temp file is removed on failure.
 * @param {string} file
 * @param {string} text
 * @returns {Promise<void>}
 */
async function writeFileAtomic(file, text) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    writeAndSync(tmp, text);
    for (let attempt = 1; ; attempt += 1) {
      try {
        fs.renameSync(tmp, file);
        return;
      } catch (err) {
        if (attempt >= RENAME_TRIES || !RENAME_BUSY.has(err && err.code)) throw err;
        await delay(RENAME_RETRY_MS * attempt);
      }
    }
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* the temp file was never created, or is already gone */
    }
    throw err;
  }
}

/** True only for a ~/.claude-usage-<id> folder (defense in depth vs ~/.claude). */
const isUsageLoginDir = (dir) => typeof dir === 'string' && path.basename(dir).startsWith(USAGE_DIR_PREFIX);

const isNonEmptyString = (v) => typeof v === 'string' && v.length > 0;
const isToken = (v) => typeof v === 'string' && v.length <= MAX_TOKEN_CHARS && TOKEN_RE.test(v);
const isSeconds = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= MAX_EXPIRES_IN_S;

/** The stored scopes when they are a clean string list, else the CLI default. */
function scopesOf(oauth) {
  const list = Array.isArray(oauth.scopes) ? oauth.scopes.filter(isNonEmptyString) : [];
  return list.length > 0 ? list : [...DEFAULT_SCOPES];
}

/** {raw, oauth} from the credentials file when it holds a refresh token, else null. */
function readStored(readFile, file) {
  let raw;
  try {
    raw = JSON.parse(readFile(file));
  } catch {
    return null;
  }
  const oauth = raw && typeof raw === 'object' && raw.claudeAiOauth && typeof raw.claudeAiOauth === 'object'
    ? raw.claudeAiOauth : null;
  return oauth && isNonEmptyString(oauth.refreshToken) ? { raw, oauth } : null;
}

/** Token endpoint body -> the validated new oauth fields (at time `t`), or null. */
function parseGrant(body, t) {
  let j;
  try {
    j = JSON.parse(body);
  } catch {
    return null;
  }
  if (!j || typeof j !== 'object' || !isToken(j.access_token) || !isSeconds(j.expires_in)) return null;
  if (j.refresh_token !== undefined && j.refresh_token !== null && !isToken(j.refresh_token)) return null;
  return {
    accessToken: j.access_token,
    ...(j.refresh_token ? { refreshToken: j.refresh_token } : {}),
    expiresAt: t + j.expires_in * 1000,
    ...(isSeconds(j.refresh_token_expires_in) ? { refreshTokenExpiresAt: t + j.refresh_token_expires_in * 1000 } : {}),
  };
}

/** POST the refresh grant -> {fields} or {error}. */
async function requestGrant(post, oauth, now) {
  let res;
  try {
    res = await post(TOKEN_HOST, TOKEN_PATH, {
      grant_type: 'refresh_token',
      refresh_token: oauth.refreshToken,
      client_id: CLIENT_ID,
      scope: scopesOf(oauth).join(' '),
    });
  } catch {
    res = { status: 0, body: '' };
  }
  const status = res && res.status;
  if (status === 400 || status === 401) return { error: 'rejected' };
  if (status !== 200) return { error: 'http' };
  const fields = parseGrant(res.body, now());
  return fields ? { fields } : { error: 'badResponse' };
}

/**
 * Refreshes the usage login in `dir` and writes the result back.
 *
 * error: 'mainDir' (refused), 'noRefreshToken', 'rejected' (400/401 - the
 * refresh token is dead, the user must reconnect), 'http' (network, 5xx,
 * 429...), 'badResponse', 'changed' (the file got a new login meanwhile),
 * 'writeFailed' (the grant is kept in `pending` for the next attempt).
 * Never carries a token.
 *
 * @param {{
 *   dir: string,
 *   readFile: (file:string) => string,
 *   writeFile?: (file:string, text:string) => (void|Promise<void>),
 *   post?: (host:string, pathname:string, payload:object) => Promise<{status:number, body:string}>,
 *   now?: () => number,
 *   pending?: Map<string, {sent:string, fields:object}>,
 * }} opts
 * @returns {Promise<{ok:true}|{ok:false, error:string}>}
 */
async function refreshUsageLogin({
  dir, readFile, writeFile = writeFileAtomic, post = postJson, now = Date.now, pending = new Map(),
}) {
  if (!isUsageLoginDir(dir)) return { ok: false, error: 'mainDir' };
  const file = path.join(dir, CREDENTIALS_FILE);
  const stored = readStored(readFile, file);
  if (!stored) {
    pending.delete(dir);
    return { ok: false, error: 'noRefreshToken' };
  }

  let grant = pending.get(dir);
  if (grant && grant.sent !== stored.oauth.refreshToken) grant = null; // a reconnect replaced the login
  if (!grant) {
    const got = await requestGrant(post, stored.oauth, now);
    if (got.error) return { ok: false, error: got.error };
    grant = { sent: stored.oauth.refreshToken, fields: got.fields };
  }

  // Re-read right before writing: the POST may have taken up to 30 s.
  const latest = readStored(readFile, file);
  if (!latest || latest.oauth.refreshToken !== grant.sent) {
    pending.delete(dir);
    return { ok: false, error: 'changed' };
  }
  const next = { ...latest.raw, claudeAiOauth: { ...latest.oauth, ...grant.fields } };
  try {
    await writeFile(file, JSON.stringify(next));
  } catch {
    pending.set(dir, grant);
    return { ok: false, error: 'writeFailed' };
  }
  pending.delete(dir);
  return { ok: true };
}

module.exports = {
  refreshUsageLogin,
  writeFileAtomic,
  postJson,
  TOKEN_HOST,
  TOKEN_PATH,
  CLIENT_ID,
};
