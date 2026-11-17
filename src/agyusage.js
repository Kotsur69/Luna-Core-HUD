// ============================================================================
// LunaCore - usage limits of the Google account Antigravity (`agy`) runs on
// ----------------------------------------------------------------------------
// agy keeps its Google login in the OS keyring, not in a file: service
// "gemini", account "antigravity" (Windows Credential Manager shows it as the
// generic credential "gemini:antigravity"). The secret is JSON:
//   {token: {access_token, token_type, refresh_token, expiry, expires_in},
//    auth_method, id_token_email}
// Only access_token, expiry and id_token_email are used. The token is never
// refreshed here (that needs agy's own OAuth client): an expired one shows the
// last good reading as stale, or "run agy to refresh it" when there is none.
//
// The quota is the one agy shows itself: Code Assist
// v1internal:retrieveUserQuotaSummary on daily-cloudcode-pa.googleapis.com
// (the host agy.exe 1.5.9 calls). The server only answers it for the
// Antigravity client, recognized by its User-Agent, so the request sends
// agy's form of it. Verified live on Windows on 2026-11-17; the macOS
// (`security`) and Linux (`secret-tool`) keyring reads follow the same
// service/account but are untested.
//
// Every IO dep is injectable; nothing here throws or logs a token. A failure
// becomes {status: 'unsupported' | 'error', errorMessage: <reason>}.
// ============================================================================

'use strict';

const { execFile } = require('child_process');
const path = require('path');
const parse = require('./providerusageparse');

const AGY_KEYRING_SERVICE = 'gemini';
const AGY_KEYRING_ACCOUNT = 'antigravity';
const AGY_QUOTA_HOST = 'daily-cloudcode-pa.googleapis.com';
const AGY_QUOTA_PATH = '/v1internal:retrieveUserQuotaSummary';
/** The agy version whose User-Agent the quota endpoint was verified with. */
const AGY_CLIENT_VERSION = '1.5.9';
/** A keyring read (PowerShell start included) gets this long, then it is killed. */
const KEYRING_TIMEOUT_MS = 15000;
/** The secret is ~600 bytes; anything far larger is not agy's. */
const MAX_SECRET_BYTES = 64 * 1024;
const MAX_EMAIL_LENGTH = 254;
/** A token this close to its expiry is treated as expired (clock skew, request time). */
const EXPIRY_SKEW_MS = 60 * 1000;
/** macOS keychain CLI, by absolute path so a planted binary on PATH is never run. */
const MAC_SECURITY_BIN = '/usr/bin/security';
/** go-keyring's marker for a base64-stored macOS secret. */
const GO_KEYRING_BASE64 = 'go-keyring-base64:';

// Reads one generic credential through advapi32 CredRead and prints its blob
// as base64 (so stdout is plain ASCII whatever the encoding). Run with
// -EncodedCommand, which sidesteps every quoting rule of a Windows command line.
const WINDOWS_READ_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class LunaAgyCred {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct CREDENTIAL { public int Flags; public int Type; public string TargetName; public string Comment; public long LastWritten; public int CredentialBlobSize; public IntPtr CredentialBlob; public int Persist; public int AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName; }
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CredRead(string target, int type, int flags, out IntPtr cred);
  [DllImport("advapi32.dll")] static extern void CredFree(IntPtr cred);
  public static string Get(string target) {
    IntPtr p;
    if (!CredRead(target, 1, 0, out p)) return "";
    try {
      var c = (CREDENTIAL)Marshal.PtrToStructure(p, typeof(CREDENTIAL));
      var b = new byte[c.CredentialBlobSize];
      Marshal.Copy(c.CredentialBlob, b, 0, b.Length);
      return Convert.ToBase64String(b);
    } finally { CredFree(p); }
  }
}
'@
[Console]::Out.Write([LunaAgyCred]::Get('${AGY_KEYRING_SERVICE}:${AGY_KEYRING_ACCOUNT}'))
`;

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/** execFile as a promise that never rejects: {ok, stdout} or {ok: false, reason}. */
function runFile(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: KEYRING_TIMEOUT_MS, windowsHide: true, maxBuffer: MAX_SECRET_BYTES * 2 }, (err, stdout) => {
      if (err) {
        // The reason names the command and the failure only - never output,
        // which could hold the secret.
        const why = err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ? 'printed too much'
          : err.code === 'ENOENT' ? 'not installed'
            : err.killed ? 'timed out'
              : `exit ${err.code}`;
        resolve({ ok: false, reason: `${path.basename(cmd)} ${why}` });
        return;
      }
      resolve({ ok: true, stdout: String(stdout || '') });
    });
  });
}

/**
 * Windows PowerShell by absolute path (a bare name is looked up in the
 * working directory first). Without SystemRoot - never on a real Windows
 * session - the bare name is the only option left.
 */
function windowsPowerShell(env) {
  const root = env && typeof env.SystemRoot === 'string' && env.SystemRoot ? env.SystemRoot : '';
  return root ? path.win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : 'powershell.exe';
}

/** Keyring bytes -> text: UTF-8, or UTF-16LE when the blob has NUL bytes. */
function decodeSecret(buf) {
  if (!Buffer.isBuffer(buf) || buf.length === 0 || buf.length > MAX_SECRET_BYTES) return '';
  return buf.includes(0) ? buf.toString('utf16le') : buf.toString('utf8');
}

/**
 * The raw keyring secret for the current platform.
 * @param {{platform?: string, run?: typeof runFile}} [opts]
 * @returns {Promise<{ok: true, text: string} | {ok: false, reason: string}>}
 */
async function readAgyKeyring({ platform = process.platform, run = runFile, env = process.env } = {}) {
  if (platform === 'win32') {
    const encoded = Buffer.from(WINDOWS_READ_SCRIPT, 'utf16le').toString('base64');
    const res = await run(windowsPowerShell(env), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded]);
    if (!res.ok) return res;
    const b64 = res.stdout.trim();
    if (!b64) return { ok: false, reason: 'No agy login in Windows Credential Manager' };
    if (!/^[A-Za-z0-9+/=]+$/.test(b64)) return { ok: false, reason: 'Unreadable agy login entry' };
    const text = decodeSecret(Buffer.from(b64, 'base64'));
    return text ? { ok: true, text } : { ok: false, reason: 'Unreadable agy login entry' };
  }
  if (platform === 'darwin') {
    const res = await run(MAC_SECURITY_BIN, ['find-generic-password', '-s', AGY_KEYRING_SERVICE, '-a', AGY_KEYRING_ACCOUNT, '-w']);
    if (!res.ok) return { ok: false, reason: 'No agy login in the macOS keychain' };
    const raw = res.stdout.trim();
    const text = raw.startsWith(GO_KEYRING_BASE64)
      ? decodeSecret(Buffer.from(raw.slice(GO_KEYRING_BASE64.length), 'base64'))
      : raw;
    return text ? { ok: true, text } : { ok: false, reason: 'Unreadable agy login entry' };
  }
  const res = await run('secret-tool', ['lookup', 'service', AGY_KEYRING_SERVICE, 'username', AGY_KEYRING_ACCOUNT]);
  if (!res.ok) return { ok: false, reason: 'No agy login in the keyring (secret-tool)' };
  const text = res.stdout.trim();
  return text ? { ok: true, text } : { ok: false, reason: 'No agy login in the keyring (secret-tool)' };
}

/**
 * The keyring secret -> what the quota call needs. Untrusted input: every
 * field is type-checked and the token must look like one bearer value.
 * @param {string} text
 * @param {number} nowMs
 * @returns {{ok: true, accessToken: string, email: string|null} | {ok: false, reason: string}}
 */
function parseAgyCredential(text, nowMs) {
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'Unreadable agy login entry' };
  }
  const token = isObj(json) && isObj(json.token) ? json.token : null;
  const accessToken = token && typeof token.access_token === 'string' ? token.access_token.trim() : '';
  if (!accessToken || /\s/.test(accessToken) || accessToken.length > 4096) {
    return { ok: false, reason: 'No Google token in the agy login - run agy and sign in' };
  }
  const rawEmail = typeof json.id_token_email === 'string' ? json.id_token_email.trim() : '';
  const email = rawEmail && rawEmail.length <= MAX_EMAIL_LENGTH && /^[^\s@]+@[^\s@]+$/.test(rawEmail) ? rawEmail : null;
  const expiry = typeof token.expiry === 'string' ? Date.parse(token.expiry) : NaN;
  if (Number.isFinite(expiry) && expiry - EXPIRY_SKEW_MS <= nowMs) {
    return { ok: false, expired: true, email, reason: 'Google login expired - run agy once to refresh it' };
  }
  return { ok: true, accessToken, email };
}

/**
 * The last good reading, aged: a window whose reset time has passed reads 0%
 * with no reset (it refilled, and only agy - which keeps its token fresh
 * while it runs - can spend it again). Pure.
 * @param {Array<object>} limits
 * @param {number} nowMs
 */
function ageLimits(limits, nowMs) {
  return limits.map((l) => {
    const reset = typeof l.resetsAt === 'string' ? Date.parse(l.resetsAt) : NaN;
    return Number.isFinite(reset) && reset <= nowMs ? { ...l, used: 0, percentUsed: 0, resetsAt: null } : l;
  });
}

/**
 * Module-level memory of the last OK reading per account. agy's access token
 * lives an hour and only a running agy refreshes it, so between agy sessions
 * the tile keeps the last reading (marked stale) instead of going blank.
 * Memory only: nothing about the account is written to disk.
 */
const lastGoodByAccount = new Map();

/** agy's own User-Agent form: "antigravity/<version> <os>/<arch>". */
function agyUserAgent(platform = process.platform, arch = process.arch) {
  const osName = platform === 'win32' ? 'windows' : platform;
  const cpu = arch === 'x64' ? 'amd64' : arch;
  return `antigravity/${AGY_CLIENT_VERSION} ${osName}/${cpu}`;
}

/**
 * Reads the agy login and its quota summary. `result(status, limits, reason,
 * extra)` builds the provider entry (src/providerusage.js owns its shape).
 * An expired login, a rejected token or a failed request, with an earlier good
 * reading of the same account, returns that reading as status 'ok', detail
 * 'stale', updatedAt = when it was taken, errorMessage = why.
 * @param {object} deps {request, now, readAgyCredential?, platform?, arch?,
 *   agyMemory?: Map} - agyMemory replaces the module-level memory (tests)
 * @param {Function} result
 */
async function fetchAgyUsage(deps, result) {
  const now = deps.now();
  const memory = deps.agyMemory instanceof Map ? deps.agyMemory : lastGoodByAccount;
  const readCredential = deps.readAgyCredential || (() => readAgyKeyring({ platform: deps.platform }));
  const secret = await readCredential();
  if (!secret || !secret.ok) return result('unsupported', [], (secret && secret.reason) || 'No agy login found', { now });
  const cred = parseAgyCredential(secret.text, now);
  const account = cred.email || null;
  const memoryKey = account || '';
  // A failed read keeps showing the last good one of this account, marked stale.
  const fallback = (status, reason) => {
    const last = memory.get(memoryKey);
    if (last) return result('ok', ageLimits(last.limits, now), reason, { now: last.at, account, detail: 'stale' });
    return result(status, [], reason, { now, account });
  };
  if (!cred.ok) return cred.expired ? fallback('unsupported', cred.reason) : result('unsupported', [], cred.reason, { now, account });
  const res = await deps.request({
    method: 'POST',
    host: AGY_QUOTA_HOST,
    pathname: AGY_QUOTA_PATH,
    headers: { Authorization: `Bearer ${cred.accessToken}`, 'User-Agent': agyUserAgent(deps.platform, deps.arch) },
    body: '{}',
  });
  const status = res && typeof res.status === 'number' ? res.status : 0;
  if (status === 0) return fallback('error', 'Google quota request failed (timeout or network)');
  if (status === 401 || status === 403) {
    return fallback('unsupported', `Google login rejected (HTTP ${status}) - run agy and sign in again`);
  }
  if (status !== 200) return fallback('error', `Google quota unavailable (HTTP ${status})`);
  let body = null;
  try {
    body = JSON.parse(res.body);
  } catch {
    return fallback('error', 'Google quota answer was not JSON');
  }
  const limits = parse.parseAgyQuotaSummary(body);
  if (!limits) return result('unsupported', [], 'The Google account reported no quota buckets', { now, account });
  memory.set(memoryKey, { limits, at: now });
  return result('ok', limits, null, { now, account, detail: 'antigravity' });
}

module.exports = {
  AGY_QUOTA_HOST,
  AGY_QUOTA_PATH,
  readAgyKeyring,
  parseAgyCredential,
  ageLimits,
  agyUserAgent,
  fetchAgyUsage,
};
