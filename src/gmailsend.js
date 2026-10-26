// ============================================================================
// LunaCore - Gmail sender (OAuth 2.0, gmail.send only)
// ----------------------------------------------------------------------------
// Sends LunaCore's own reports (the nightly summary, the God Mode run email)
// to Mati, from Mati, through the Gmail API. Nothing is read from the inbox.
//
// Auth reuses src/gcal.js's installed-app flow and the same Desktop OAuth
// client (google-oauth.local.json), but as a SEPARATE grant and token:
//   - scope 'openid email https://www.googleapis.com/auth/gmail.send' only -
//     no read, no modify, no labels; disconnecting Gmail never touches the
//     calendar grant and the other way round;
//   - the address comes from the id_token's `email` claim, accepted only with
//     email_verified true, aud = our client id and a Google issuer. The token
//     came straight from Google's token endpoint over TLS, which OpenID
//     Connect allows in place of a signature check;
//   - the refresh token and that address are stored together, encrypted with
//     Electron safeStorage, in gmail-token.local.json. No safeStorage -> memory
//     only, never written in clear (same rule as gcal).
//
// THE RECIPIENT IS ALWAYS THAT ADDRESS. send() takes no `to`: nothing synced,
// pulled from the cloud or sent by a renderer can turn this into a mailer to
// someone else. Subjects lose CR/LF and control characters (no header
// injection); bodies are plain text, with an optional HTML part that is only
// the same text escaped inside <pre> - never caller HTML. Attachments are
// text files, or PNG / JPEG screenshots (Buffers, size-capped) sent inline.
// ============================================================================

'use strict';

const fs = require('fs');
const crypto = require('crypto');
const paths = require('./paths');
const { parseClientFile, buildAuthUrl, startRedirectServer, base64url, readJson, CLIENT_FILE } = require('./gcal');

const SCOPE = 'openid email https://www.googleapis.com/auth/gmail.send';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SEND_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send';
const TOKEN_FILE = 'gmail-token.local.json';
const ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com']);

const FETCH_TIMEOUT_MS = 20000;
const DEFAULT_TTL_MS = 3600000;
const EXPIRY_SLACK_MS = 60000;
const MAX_SUBJECT = 200;
/** Gmail's own cap is 25 MB; a report is a few KB. */
const MAX_BODY = 200 * 1024;
const MAX_ATTACHMENT = 2 * 1024 * 1024;
const MAX_ATTACHMENTS = 5;
const MAX_FILENAME = 100;
const ATTACHMENT_TYPES = new Set(['text/html', 'text/plain', 'text/markdown']);
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg']);
const MAX_IMAGE = 1024 * 1024;
const EMAIL_RE = /^[^\s@<>()",;:\\[\]]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;

class GmailError extends Error {
  constructor(reason, detail) {
    super(detail || reason);
    this.reason = reason;
  }
}

/** The verified address from an id_token, or null. */
function emailFromIdToken(idToken, clientId) {
  if (typeof idToken !== 'string') return null;
  const parts = idToken.split('.');
  if (parts.length !== 3) return null;
  let claims;
  try {
    claims = JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
  } catch {
    return null;
  }
  if (!claims || typeof claims !== 'object') return null;
  if (claims.email_verified !== true && claims.email_verified !== 'true') return null;
  if (claims.aud !== clientId || !ISSUERS.has(claims.iss)) return null;
  return typeof claims.email === 'string' && EMAIL_RE.test(claims.email) ? claims.email.toLowerCase() : null;
}

// eslint-disable-next-line no-control-regex
const oneLine = (v, max) => String(v == null ? '' : v).replace(/[\x00-\x1f\x7f\u2028\u2029]+/g, ' ').trim().slice(0, max);

/** Plain text with CR/LF line ends; other control characters dropped (tabs kept). */
// eslint-disable-next-line no-control-regex
const plainBody = (v) => String(v == null ? '' : v).slice(0, MAX_BODY).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').replace(/\r?\n/g, '\r\n');

const escapeHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** RFC 2047 encoded-word, so a Polish subject survives any mail client. */
const encodeHeader = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`);

/** Base64 body wrapped at 76 characters (RFC 2045). */
const b64Lines = (s) => Buffer.from(s, 'utf8').toString('base64').replace(/.{76}/g, '$&\r\n');

/** A filename safe inside a quoted MIME parameter. */
const safeFilename = (v) => oneLine(v, MAX_FILENAME).replace(/[^A-Za-z0-9._-]+/g, '_') || 'attachment';

/** LW 2.18: a screenshot shown inline - PNG or JPEG bytes in a Buffer, within MAX_IMAGE. */
const isInlineImage = (a) => IMAGE_TYPES.has(a.mimeType) && Buffer.isBuffer(a.content) && a.content.length > 0 && a.content.length <= MAX_IMAGE;
// A Buffer that is not such an image is dropped: it never goes out as text.
const sendable = (a) => !!a && typeof a === 'object' && (!Buffer.isBuffer(a.content) || isInlineImage(a));

/** One base64 attachment part; an unknown type goes out as octet-stream, an image inline. */
function attachmentPart(a) {
  const name = safeFilename(a.filename);
  if (isInlineImage(a)) {
    return [
      `Content-Type: ${a.mimeType}; name="${name}"`, 'Content-Transfer-Encoding: base64', `Content-Disposition: inline; filename="${name}"`,
      `Content-ID: <${name}@lunacore>`, '', a.content.toString('base64').replace(/.{76}/g, '$&\r\n'),
    ];
  }
  const type = ATTACHMENT_TYPES.has(a.mimeType) ? `${a.mimeType}; charset=UTF-8` : 'application/octet-stream';
  return [`Content-Type: ${type}; name="${name}"`, 'Content-Transfer-Encoding: base64', `Content-Disposition: attachment; filename="${name}"`, '', b64Lines(String(a.content || '').slice(0, MAX_ATTACHMENT))];
}

/**
 * The RFC 5322 message. `address` is both From and To. With attachments the
 * body (plain, or plain+html alternative) is wrapped in multipart/mixed.
 * @param {{address:string, subject:string, text:string, html?:boolean, boundary?:string,
 *   attachments?:Array<{filename:string, mimeType:string, content:string|Buffer}>}} m
 *   content: text, or (image/png, image/jpeg) the image bytes - sent inline
 */
function buildMime({ address, subject, text, html = false, boundary, attachments: given = [] }) {
  const attachments = (Array.isArray(given) ? given : []).filter(sendable);
  const body = plainBody(text);
  const head = [`From: ${address}`, `To: ${address}`, `Subject: ${encodeHeader(oneLine(subject, MAX_SUBJECT))}`, 'MIME-Version: 1.0'];
  const part = (type, content) => [`Content-Type: ${type}; charset=UTF-8`, 'Content-Transfer-Encoding: base64', '', b64Lines(content)];
  const b = boundary || `lunacore-${crypto.randomBytes(12).toString('hex')}`;
  let content = part('text/plain', body);
  if (html) {
    const alt = attachments.length ? `${b}-alt` : b;
    const htmlBody = `<!doctype html><meta charset="utf-8"><pre style="font:13px/1.45 ui-monospace,Consolas,monospace;white-space:pre-wrap">${escapeHtml(body)}</pre>`;
    content = [
      `Content-Type: multipart/alternative; boundary="${alt}"`,
      '',
      `--${alt}`,
      ...part('text/plain', body),
      `--${alt}`,
      ...part('text/html', htmlBody),
      `--${alt}--`,
      '',
    ];
  }
  const files = attachments.slice(0, MAX_ATTACHMENTS);
  if (!files.length) return [...head, ...content].join('\r\n');
  return [
    ...head,
    `Content-Type: multipart/mixed; boundary="${b}"`,
    '',
    `--${b}`,
    ...content,
    ...files.flatMap((a) => [`--${b}`, ...attachmentPart(a)]),
    `--${b}--`,
    '',
  ].join('\r\n');
}

const tokenTtl = (body) => (Number.isFinite(body.expires_in) ? body.expires_in * 1000 : DEFAULT_TTL_MS);

/**
 * @param {{fetchImpl?:Function, openExternal?:Function, safeStorage?:object,
 *   clientPath?:string, tokenPath?:string, redirectServer?:Function}} [deps]
 *   Injectable so tests never touch the network, a browser or the keychain.
 */
function createGmailSender(deps = {}) {
  const doFetch = deps.fetchImpl || ((...a) => fetch(...a));
  const openExternal = deps.openExternal || ((url) => require('electron').shell.openExternal(url));
  const redirectServer = deps.redirectServer || startRedirectServer;
  const storage = () => deps.safeStorage || require('electron').safeStorage;
  const tokenFile = () => deps.tokenPath || paths.local(TOKEN_FILE);
  const loadClient = () => parseClientFile(readJson(deps.clientPath || paths.local(CLIENT_FILE)));

  let grant = null; // { refreshToken, email }
  let access = null; // { token, expiresAt }
  let loaded = false;

  function load() {
    if (loaded) return grant;
    loaded = true;
    const raw = readJson(tokenFile());
    if (!raw || raw.v !== 1 || typeof raw.enc !== 'string') return null;
    try {
      const ss = storage();
      if (!ss.isEncryptionAvailable()) return null;
      const inner = JSON.parse(ss.decryptString(Buffer.from(raw.enc, 'base64')));
      if (inner && typeof inner.refreshToken === 'string' && typeof inner.email === 'string' && EMAIL_RE.test(inner.email)) {
        grant = { refreshToken: inner.refreshToken, email: inner.email };
      }
    } catch (err) {
      console.error('[gmail] stored token unreadable:', err && err.message);
    }
    return grant;
  }

  function save(next) {
    grant = next;
    loaded = true;
    try {
      const ss = storage();
      if (!ss.isEncryptionAvailable()) return; // memory only, by design
      if (!deps.tokenPath) paths.ensureUserDir();
      const enc = ss.encryptString(JSON.stringify(next)).toString('base64');
      const tmp = tokenFile().replace(/(\.local)?\.json$/, '.tmp.local.json');
      fs.writeFileSync(tmp, JSON.stringify({ v: 1, enc }), { mode: 0o600 });
      fs.renameSync(tmp, tokenFile());
    } catch (err) {
      console.error('[gmail] could not store token:', err && err.message);
    }
  }

  function disconnect() {
    grant = null;
    access = null;
    loaded = true;
    try {
      fs.rmSync(tokenFile(), { force: true });
    } catch (err) {
      console.error('[gmail] could not remove token:', err && err.message);
    }
  }

  async function postToken(params) {
    let res;
    try {
      res = await doFetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(params).toString(),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch (err) {
      throw new GmailError('gmail-network', err && err.message);
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new GmailError(body.error === 'invalid_grant' ? 'gmail-auth' : 'gmail-failed', String(body.error));
    return body;
  }

  async function accessToken() {
    if (access && access.expiresAt > Date.now()) return access.token;
    const client = loadClient();
    if (!client) throw new GmailError('gmail-no-client');
    if (!load()) throw new GmailError('gmail-not-connected');
    let body;
    try {
      body = await postToken({
        client_id: client.clientId,
        client_secret: client.clientSecret,
        refresh_token: grant.refreshToken,
        grant_type: 'refresh_token',
      });
    } catch (err) {
      if (err.reason === 'gmail-auth') disconnect();
      throw err;
    }
    if (typeof body.access_token !== 'string') throw new GmailError('gmail-failed', 'no access_token');
    access = { token: body.access_token, expiresAt: Date.now() + tokenTtl(body) - EXPIRY_SLACK_MS };
    return access.token;
  }

  async function connect() {
    const client = loadClient();
    if (!client) throw new GmailError('gmail-no-client');
    const verifier = base64url(crypto.randomBytes(48));
    const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
    const state = base64url(crypto.randomBytes(24));
    const { redirectUri, code, close } = await redirectServer(state);
    let body;
    try {
      try {
        await openExternal(buildAuthUrl({ clientId: client.clientId, redirectUri, state, challenge, scope: SCOPE }));
      } catch (err) {
        throw new GmailError('gmail-failed', `could not open the browser: ${err && err.message}`);
      }
      let authCode;
      try {
        authCode = await code;
      } catch (err) {
        throw new GmailError(err && err.reason === 'gcal-timeout' ? 'gmail-timeout' : 'gmail-denied', err && err.message);
      }
      body = await postToken({
        client_id: client.clientId,
        client_secret: client.clientSecret,
        code: authCode,
        code_verifier: verifier,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      });
    } finally {
      close();
    }
    if (typeof body.refresh_token !== 'string') throw new GmailError('gmail-failed', 'no refresh_token');
    const scopes = typeof body.scope === 'string' ? body.scope.split(' ') : [];
    if (!scopes.includes('https://www.googleapis.com/auth/gmail.send')) throw new GmailError('gmail-scope');
    const email = emailFromIdToken(body.id_token, client.clientId);
    if (!email) throw new GmailError('gmail-no-email');
    save({ refreshToken: body.refresh_token, email });
    if (typeof body.access_token === 'string') {
      access = { token: body.access_token, expiresAt: Date.now() + tokenTtl(body) - EXPIRY_SLACK_MS };
    }
    return { email };
  }

  /**
   * Sends one message to the connected address.
   * @param {{subject:string, text:string, html?:boolean, attachments?:Array<{filename:string, mimeType:string, content:string}>}} msg
   * @returns {Promise<{id:string|null}>}
   */
  async function send({ subject, text, html = false, attachments = [] }) {
    const token = await accessToken();
    const raw = base64url(Buffer.from(buildMime({ address: grant.email, subject, text, html, attachments }), 'utf8'));
    let res;
    try {
      res = await doFetch(SEND_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ raw }),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch (err) {
      throw new GmailError('gmail-network', err && err.message);
    }
    const body = await res.json().catch(() => ({}));
    if (res.status === 401) {
      access = null;
      throw new GmailError('gmail-auth', 'HTTP 401');
    }
    if (res.status === 403) throw new GmailError('gmail-scope', 'HTTP 403');
    if (!res.ok) throw new GmailError('gmail-failed', `HTTP ${res.status}`);
    return { id: typeof body.id === 'string' ? body.id.slice(0, 64) : null };
  }

  const status = () => {
    const g = load();
    return { configured: !!loadClient(), connected: !!g, email: g ? g.email : null };
  };

  return { status, connect, disconnect, send };
}

module.exports = { createGmailSender, GmailError, emailFromIdToken, buildMime, SCOPE, TOKEN_FILE };
