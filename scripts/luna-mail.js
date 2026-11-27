#!/usr/bin/env node
// ============================================================================
// LunaCore - luna-mail: send email from the owner's Gmail, from the command line
// ----------------------------------------------------------------------------
// Lets an agent (or the owner) send a message with attachments through the
// Gmail API, for when webmail attachment uploads are blocked on a machine.
//
//   node scripts/luna-mail.js connect      one-time browser consent per machine
//   node scripts/luna-mail.js status       checks the stored grant still refreshes
//   node scripts/luna-mail.js disconnect [--revoke]
//        deletes the local token; --revoke also revokes it at Google, which
//        may end every grant of this OAuth client (LunaCore Calendar/Gmail too)
//   node scripts/luna-mail.js send --to a@b.c [--to ...] [--cc x@y.z]
//        --subject "..." (--body "..." | --body-file path) [--attach path ...]
//
// Auth reuses the Desktop OAuth client in google-oauth.local.json and the
// installed-app PKCE flow from src/gcal.js, as a SEPARATE grant with scope
// 'openid email gmail.send' only - it cannot read the inbox. Unlike
// src/gmailsend.js (reports to the owner only), the recipient is free: this
// is a tool the owner runs or explicitly asks an agent to run. Attachments
// are guarded instead: files that look like secrets (config dir, *.local.json,
// .env, SSH/cloud credentials) are refused, so a prompt-injected agent cannot
// mail them out.
//
// Config dir: $LUNA_MAIL_CONFIG_DIR, else the first of
// %APPDATA%/LunaCore/config (installed build) and ./config (dev clone) that
// holds google-oauth.local.json. The refresh token is stored next to it in
// luna-mail-token.local.json, encrypted with Windows DPAPI (CurrentUser):
// it only decrypts for the same Windows user on the same machine, so every
// machine runs `connect` once and gets its own grant.
// Windows only for now (DPAPI); elsewhere `connect` refuses before consent.
//
// The OAuth app must be "In production": a "Testing" app's refresh tokens
// expire after 7 days.
// ============================================================================

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync, spawn } = require('child_process');
const { parseClientFile, buildAuthUrl, startRedirectServer, base64url, CLIENT_FILE } = require('../src/gcal');
const { emailFromIdToken, EMAIL_RE } = require('../src/gmailsend');

const SEND_SCOPE = 'https://www.googleapis.com/auth/gmail.send';
const SCOPE = `openid email ${SEND_SCOPE}`;
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const SEND_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send';
const TOKEN_FILE = 'luna-mail-token.local.json';

const FETCH_TIMEOUT_MS = 60000;
const DPAPI_TIMEOUT_MS = 30000;
// Gmail caps a whole message at 25 MB; base64 plus line breaks add ~37%.
const MAX_TOTAL_ATTACH_BYTES = 15 * 1024 * 1024;
const MAX_BODY_BYTES = 200 * 1024;
const MAX_SUBJECT_CHARS = 200;
const MAX_FILENAME_CHARS = 150;
const MAX_RECIPIENTS = 50;
// RFC 2047: an encoded-word is at most 75 chars; 45 bytes of UTF-8 -> 60 base64 chars + 12 framing.
const ENCODED_WORD_BYTES = 45;

const SYSTEM32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
// Absolute paths: a bare name would be resolved against the current directory first on Windows.
const POWERSHELL_EXE = path.join(SYSTEM32, 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const RUNDLL32_EXE = path.join(SYSTEM32, 'rundll32.exe');

const MIME_BY_EXT = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.md': 'text/markdown',
  '.zip': 'application/zip',
  '.mp4': 'video/mp4',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

// File names and directories that hold secrets; never sent as attachments or bodies.
const SENSITIVE_NAME_RE = /(\.local\.(json|jsonl|md)$|^\.env(\..*)?$|^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$|\.(pem|key|p12|pfx|kdbx)$|^credentials(\.json)?$|^\.git-credentials$|^\.npmrc$|^\.netrc$)/i;
const SENSITIVE_DIRS = ['.ssh', '.aws', '.gnupg', '.azure', '.kube', '.docker'];

class LunaMailError extends Error {}

// ------------------------------------------------------------ pure helpers ---

/** Base64 in 76-char lines (RFC 2045), no trailing line break. */
const wrap76 = (b64) => (b64 ? b64.match(/.{1,76}/g).join('\r\n') : '');
/** Cut by code point, so a surrogate pair is never split. */
const cutChars = (s, max) => Array.from(s).slice(0, max).join('');
// eslint-disable-next-line no-control-regex
const oneLine = (v, max) => cutChars(String(v == null ? '' : v).replace(/[\x00-\x1f\x7f\u2028\u2029]+/g, ' ').trim(), max);

/** RFC 2047 header text: ASCII as is, otherwise encoded-words of <= 75 chars, folded. */
function encodeHeader(s) {
  if (/^[\x20-\x7e]*$/.test(s)) return s;
  const words = [];
  let chunk = '';
  for (const ch of s) {
    if (Buffer.byteLength(chunk + ch, 'utf8') > ENCODED_WORD_BYTES) {
      words.push(chunk);
      chunk = '';
    }
    chunk += ch;
  }
  if (chunk) words.push(chunk);
  return words.map((w) => `=?UTF-8?B?${Buffer.from(w, 'utf8').toString('base64')}?=`).join('\r\n ');
}

/**
 * Content-Type name / Content-Disposition filename parameters: an ASCII
 * fallback, plus RFC 2231 filename* for non-ASCII names.
 */
function filenameParams(name) {
  const clean = oneLine(name, MAX_FILENAME_CHARS) || 'attachment';
  const ascii = clean.normalize('NFKD').replace(/[^\x20-\x7e]/g, '').replace(/["\\]/g, '_').trim() || 'attachment';
  if (clean === ascii) return { type: `name="${ascii}"`, disposition: `filename="${ascii}"` };
  const star = encodeURIComponent(clean).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return { type: `name="${ascii}"`, disposition: `filename="${ascii}"; filename*=UTF-8''${star}` };
}

/** argv after the command -> { to, cc, attach, subject, body, bodyFile, revoke }. Throws on anything unknown. */
function parseArgs(argv) {
  const out = { to: [], cc: [], attach: [], subject: null, body: null, bodyFile: null, revoke: false };
  const repeatable = new Set(['to', 'cc', 'attach']);
  const single = new Map([['subject', 'subject'], ['body', 'body'], ['body-file', 'bodyFile']]);
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    if (key === '--revoke') {
      out.revoke = true;
      i -= 1; // a flag, no value
      continue;
    }
    const val = argv[i + 1];
    if (typeof key !== 'string' || !key.startsWith('--') || val === undefined) {
      throw new LunaMailError(`bad argument near "${key}"`);
    }
    const name = key.slice(2);
    if (repeatable.has(name)) out[name].push(val);
    else if (single.has(name)) {
      const field = single.get(name);
      if (out[field] !== null) throw new LunaMailError(`${key} given twice`);
      out[field] = val;
    } else throw new LunaMailError(`unknown option ${key}`);
  }
  if (out.body !== null && out.bodyFile !== null) throw new LunaMailError('use --body or --body-file, not both');
  return out;
}

/** Trimmed, validated recipient lists. EMAIL_RE rejects whitespace, so no header injection. */
function validateRecipients(to, cc) {
  const clean = (list) => list.map((a) => String(a).trim());
  const result = { to: clean(to), cc: clean(cc) };
  if (!result.to.length) throw new LunaMailError('at least one --to is required');
  const all = [...result.to, ...result.cc];
  if (all.length > MAX_RECIPIENTS) throw new LunaMailError(`too many recipients (max ${MAX_RECIPIENTS})`);
  const bad = all.filter((a) => !EMAIL_RE.test(a));
  if (bad.length) throw new LunaMailError(`invalid address: ${bad.join(', ')}`);
  return result;
}

/** True when `p` (already resolved) is a secret-looking file or sits inside `protectedDir`. */
function isSensitivePath(p, protectedDir) {
  const rel = protectedDir ? path.relative(protectedDir, p) : '..';
  if (!rel.startsWith('..') && !path.isAbsolute(rel)) return true;
  const parts = p.split(/[\\/]+/).map((s) => s.toLowerCase());
  if (parts.some((s) => SENSITIVE_DIRS.includes(s))) return true;
  return SENSITIVE_NAME_RE.test(path.basename(p));
}

/**
 * Stats, guards and reads one input file (attachment or body).
 * @returns {{real:string, data:Buffer}}
 */
function readGuardedFile(p, { maxBytes, protectedDir, what }) {
  let real;
  let stat;
  try {
    real = fs.realpathSync(p);
    stat = fs.statSync(real);
  } catch (err) {
    throw new LunaMailError(`${what} not readable: ${p} (${err.code || err.message})`);
  }
  if (!stat.isFile()) throw new LunaMailError(`${what} is not a regular file: ${p}`);
  if (isSensitivePath(real, protectedDir)) throw new LunaMailError(`${what} refused, it looks like a secret or config file: ${p}`);
  if (stat.size > maxBytes) throw new LunaMailError(`${what} too large: ${p} is ${stat.size} bytes, limit ${maxBytes}`);
  return { real, data: fs.readFileSync(real) };
}

/** Reads attachments after the guard, enforcing the total size cap before reading. */
function loadAttachments(paths, { protectedDir } = {}) {
  const files = [];
  let total = 0;
  for (const p of paths) {
    const { real, data } = readGuardedFile(p, { maxBytes: MAX_TOTAL_ATTACH_BYTES - total, protectedDir, what: 'attachment' });
    total += data.length;
    files.push({ name: path.basename(real), type: MIME_BY_EXT[path.extname(real).toLowerCase()] || 'application/octet-stream', data });
  }
  return files;
}

/**
 * The RFC 5322 message: a plain-text UTF-8 body, plus multipart/mixed when
 * there are attachments.
 * @param {{from:string, to:string[], cc?:string[], subject:string, text:string,
 *   files?:Array<{name:string, type:string, data:Buffer}>, boundary?:string}} m
 */
function buildMime({ from, to, cc = [], subject, text, files = [], boundary }) {
  const head = [`From: ${from}`, `To: ${to.join(', ')}`];
  if (cc.length) head.push(`Cc: ${cc.join(', ')}`);
  head.push(`Subject: ${encodeHeader(oneLine(subject, MAX_SUBJECT_CHARS))}`, 'MIME-Version: 1.0');
  const body = String(text).replace(/\r?\n/g, '\r\n');
  const textPart = [
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    wrap76(Buffer.from(body, 'utf8').toString('base64')),
  ];
  if (!files.length) return [...head, ...textPart].join('\r\n');
  const b = boundary || `lunamail-${crypto.randomBytes(12).toString('hex')}`;
  const parts = files.flatMap((f) => {
    const params = filenameParams(f.name);
    return [
      `--${b}`,
      `Content-Type: ${f.type}; ${params.type}`,
      'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; ${params.disposition}`,
      '',
      wrap76(f.data.toString('base64')),
    ];
  });
  return [...head, `Content-Type: multipart/mixed; boundary="${b}"`, '', `--${b}`, ...textPart, ...parts, `--${b}--`, ''].join('\r\n');
}

/** The config dir: env override, else the first candidate holding the OAuth client file. */
function resolveConfigDir({ env = process.env, exists = fs.existsSync } = {}) {
  if (env.LUNA_MAIL_CONFIG_DIR) return env.LUNA_MAIL_CONFIG_DIR;
  const candidates = [
    env.APPDATA ? path.join(env.APPDATA, 'LunaCore', 'config') : null,
    path.join(__dirname, '..', 'config'),
  ].filter(Boolean);
  const found = candidates.find((dir) => exists(path.join(dir, CLIENT_FILE)));
  if (!found) throw new LunaMailError(`no ${CLIENT_FILE} in: ${candidates.join(' | ')}`);
  return found;
}

/** JSON from disk: null when the file is missing, an error when it exists but is unreadable. */
function readJsonStrict(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw new LunaMailError(`cannot read ${file}: ${err.message}`);
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new LunaMailError(`corrupt JSON in ${file}: ${err.message}`);
  }
}

/** A network error with its cause (fetch hides it behind "fetch failed"). */
const networkError = (what, err) => new LunaMailError(`${what}: ${err.message}${err.cause && err.cause.message ? ` (${err.cause.message})` : ''}`);

// ------------------------------------------------------------------ DPAPI ---

/** Windows DPAPI (CurrentUser) through PowerShell; the data goes over stdin, never argv. */
function dpapi(op, b64) {
  const ps = [
    'Add-Type -AssemblyName System.Security',
    '$b=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())',
    `$r=[Security.Cryptography.ProtectedData]::${op}($b,$null,'CurrentUser')`,
    '[Console]::Out.Write([Convert]::ToBase64String($r))',
  ].join(';');
  return execFileSync(POWERSHELL_EXE, ['-NoProfile', '-NonInteractive', '-Command', ps], {
    input: b64,
    encoding: 'utf8',
    timeout: DPAPI_TIMEOUT_MS,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

const windowsVault = {
  available: () => process.platform === 'win32',
  protect: (text) => dpapi('Protect', Buffer.from(text, 'utf8').toString('base64')),
  unprotect: (enc) => Buffer.from(dpapi('Unprotect', enc), 'base64').toString('utf8'),
};

function openInBrowser(url) {
  // rundll32 takes the URL as one argument; `start` would split it on '&'.
  const child = process.platform === 'win32'
    ? spawn(RUNDLL32_EXE, ['url.dll,FileProtocolHandler', url], { detached: true, stdio: 'ignore', windowsHide: true })
    : spawn(process.platform === 'darwin' ? '/usr/bin/open' : 'xdg-open', [url], { detached: true, stdio: 'ignore' });
  child.on('error', () => {}); // the URL is printed as well, so a missing opener is not fatal
  child.unref();
}

// --------------------------------------------------------------- the tool ---

/**
 * @param {{configDir:string, fetchImpl?:Function, vault?:{available:Function, protect:Function, unprotect:Function},
 *   redirectServer?:Function, openBrowser?:Function, log?:Function}} deps
 *   Injectable so tests never touch the network, a browser or DPAPI.
 */
function createLunaMail(deps) {
  const doFetch = deps.fetchImpl || ((...a) => fetch(...a));
  const vault = deps.vault || windowsVault;
  const redirectServer = deps.redirectServer || startRedirectServer;
  const openBrowser = deps.openBrowser || openInBrowser;
  const log = deps.log || ((line) => console.log(line));
  const clientPath = path.join(deps.configDir, CLIENT_FILE);
  const tokenPath = path.join(deps.configDir, TOKEN_FILE);

  function loadClient() {
    const client = parseClientFile(readJsonStrict(clientPath));
    if (!client) throw new LunaMailError(`no valid OAuth client in ${clientPath}`);
    return client;
  }

  function saveGrant(grant) {
    const enc = vault.protect(JSON.stringify(grant));
    const tmp = tokenPath.replace(/\.local\.json$/, '.tmp.local.json');
    fs.writeFileSync(tmp, JSON.stringify({ v: 1, enc }), { mode: 0o600 });
    fs.renameSync(tmp, tokenPath);
  }

  function loadGrant() {
    const raw = readJsonStrict(tokenPath);
    if (!raw) return null;
    if (raw.v !== 1 || typeof raw.enc !== 'string') throw new LunaMailError(`unrecognised token file ${tokenPath}`);
    let grant;
    try {
      grant = JSON.parse(vault.unprotect(raw.enc));
    } catch (err) {
      throw new LunaMailError(`cannot decrypt ${tokenPath} (made on another machine or user?): ${err.message}`);
    }
    if (!grant || typeof grant.refreshToken !== 'string' || !EMAIL_RE.test(grant.email || '')) {
      throw new LunaMailError(`token file content is invalid: ${tokenPath}`);
    }
    return grant;
  }

  async function postForm(url, params) {
    let res;
    try {
      res = await doFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(params).toString(),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch (err) {
      throw networkError(url, err);
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new LunaMailError(`${url} -> HTTP ${res.status} ${body.error || ''}`.trim());
      err.oauthError = body.error;
      throw err;
    }
    return body;
  }

  async function accessToken(client, grant) {
    let body;
    try {
      body = await postForm(TOKEN_URL, {
        client_id: client.clientId,
        client_secret: client.clientSecret,
        refresh_token: grant.refreshToken,
        grant_type: 'refresh_token',
      });
    } catch (err) {
      if (err.oauthError === 'invalid_grant') {
        throw new LunaMailError('the stored grant expired or was revoked - run "connect" again (a "Testing" OAuth app expires tokens after 7 days)');
      }
      throw err;
    }
    if (typeof body.access_token !== 'string') throw new LunaMailError('Google returned no access token');
    return body.access_token;
  }

  async function connect() {
    // Checked before consent: failing after it would leave a live grant at Google with nothing stored.
    if (!vault.available()) throw new LunaMailError('token storage needs Windows DPAPI; this platform is not supported yet');
    const client = loadClient();
    const verifier = base64url(crypto.randomBytes(48));
    const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
    const state = base64url(crypto.randomBytes(24));
    const { redirectUri, code, close } = await redirectServer(state);
    let body;
    try {
      const url = buildAuthUrl({ clientId: client.clientId, redirectUri, state, challenge, scope: SCOPE });
      log('Opening Google consent in the browser. If it does not open, use this link:');
      log(url);
      openBrowser(url);
      let authCode;
      try {
        authCode = await code;
      } catch (err) {
        throw new LunaMailError(`consent not completed: ${err.reason || err.message}`);
      }
      body = await postForm(TOKEN_URL, {
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
    if (typeof body.refresh_token !== 'string') throw new LunaMailError('Google returned no refresh token');
    if (!String(body.scope || '').split(' ').includes(SEND_SCOPE)) throw new LunaMailError('the gmail.send scope was not granted');
    const email = emailFromIdToken(body.id_token, client.clientId);
    if (!email) throw new LunaMailError('Google returned no verified email address');
    try {
      saveGrant({ refreshToken: body.refresh_token, email });
    } catch (err) {
      throw new LunaMailError(`consent succeeded but the token could not be stored (${err.message}); remove the grant at myaccount.google.com/permissions if you will not retry`);
    }
    log(`CONNECTED as ${email}. Token stored (encrypted) in ${tokenPath}`);
    return { email };
  }

  async function send(argv) {
    const opts = parseArgs(argv);
    if (opts.revoke) throw new LunaMailError('--revoke belongs to "disconnect"');
    const { to, cc } = validateRecipients(opts.to, opts.cc);
    const subject = oneLine(opts.subject, MAX_SUBJECT_CHARS);
    if (!subject) throw new LunaMailError('--subject is required');
    const text = opts.bodyFile !== null
      ? readGuardedFile(opts.bodyFile, { maxBytes: MAX_BODY_BYTES, protectedDir: deps.configDir, what: 'body file' }).data.toString('utf8')
      : opts.body;
    if (!text || !text.trim()) throw new LunaMailError('--body or --body-file is required');
    if (Buffer.byteLength(text, 'utf8') > MAX_BODY_BYTES) throw new LunaMailError(`body too large (limit ${MAX_BODY_BYTES} bytes)`);
    const files = loadAttachments(opts.attach, { protectedDir: deps.configDir });

    const client = loadClient();
    const grant = loadGrant();
    if (!grant) throw new LunaMailError('not connected - run "connect" first');
    const token = await accessToken(client, grant);
    const mime = buildMime({ from: grant.email, to, cc, subject, text, files });
    let res;
    try {
      res = await doFetch(SEND_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ raw: base64url(Buffer.from(mime, 'utf8')) }),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch (err) {
      throw networkError('Gmail send failed - the message MAY have been sent, check Sent before retrying', err);
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const detail = body.error && body.error.message ? ` ${body.error.message}` : '';
      throw new LunaMailError(`Gmail send -> HTTP ${res.status}${detail}`);
    }
    log(`SENT from ${grant.email} to ${[...to, ...cc].join(', ')} - message id ${body.id}`);
    return { id: body.id, threadId: body.threadId };
  }

  async function status() {
    const grant = loadGrant();
    if (!grant) {
      log('NOT CONNECTED');
      return { connected: false };
    }
    await accessToken(loadClient(), grant);
    log(`CONNECTED as ${grant.email} (refresh verified just now)`);
    return { connected: true, email: grant.email };
  }

  /**
   * Deletes the local token. With --revoke it is first revoked at Google;
   * Google may then end every grant of this OAuth client for the account.
   */
  async function disconnect(argv = []) {
    const { revoke } = parseArgs(argv);
    if (revoke) {
      let grant = null;
      try {
        grant = loadGrant();
      } catch (err) {
        log(`warning: ${err.message} - not revoked; remove it at myaccount.google.com/permissions`);
      }
      if (grant) {
        log('warning: revoking at Google may also disconnect LunaCore Calendar/Gmail (same OAuth client)');
        try {
          await postForm(REVOKE_URL, { token: grant.refreshToken });
        } catch (err) {
          log(`warning: revoke at Google failed (${err.message}) - remove it at myaccount.google.com/permissions`);
        }
      }
    }
    fs.rmSync(tokenPath, { force: true });
    log(revoke ? 'DISCONNECTED (revoked)' : 'DISCONNECTED (local token deleted; grant still listed at myaccount.google.com/permissions)');
  }

  return { connect, send, status, disconnect };
}

const USAGE = 'usage: luna-mail.js connect | status | disconnect [--revoke] | send --to a@b --subject s (--body t | --body-file f) [--cc x] [--attach p]';
const COMMANDS = ['connect', 'send', 'status', 'disconnect'];

/** CLI entry; returns the exit code. */
async function main(argv, { makeTool = (dir) => createLunaMail({ configDir: dir }), configDir = resolveConfigDir } = {}) {
  const [cmd, ...rest] = argv;
  if (!COMMANDS.includes(cmd)) {
    console.error(USAGE);
    return 2;
  }
  try {
    const tool = makeTool(configDir());
    await tool[cmd](rest);
    return 0;
  } catch (err) {
    console.error(`FAILED: ${err && err.message}`);
    return 1;
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}

module.exports = {
  createLunaMail,
  main,
  parseArgs,
  validateRecipients,
  loadAttachments,
  isSensitivePath,
  buildMime,
  encodeHeader,
  filenameParams,
  resolveConfigDir,
  windowsVault,
  LunaMailError,
  SCOPE,
  TOKEN_FILE,
  MAX_TOTAL_ATTACH_BYTES,
  MAX_BODY_BYTES,
};
