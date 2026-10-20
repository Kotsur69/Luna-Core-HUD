// ============================================================================
// LunaCore - one-time Google token for the `google` server function (phase 5)
// ----------------------------------------------------------------------------
// The phone reads calendar and mail through the Supabase Edge Function
// `google`, which needs its own refresh token (the PC's stays encrypted in
// gcal-token.local.json). Run by hand, once, on a PC that already has the
// Desktop OAuth client in config/google-oauth.local.json:
//
//   node scripts/google-server-token.js [path\to\google-oauth.local.json]
//
// It prints a Google consent URL (calendar + gmail.metadata), catches the
// redirect on 127.0.0.1 with PKCE, the same flow as src/gcal.js, and writes
// the three secrets to config/google-server.local.json (gitignored). The
// token itself is never printed. Paste the values into Supabase -> Edge
// Functions -> Secrets, then delete the file.
//
// Before running: the OAuth app must be "In production" (a "Testing" app's
// refresh tokens die after 7 days) and the Gmail API enabled in its project.
// ============================================================================

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { parseClientFile, buildAuthUrl, startRedirectServer } = require('../src/gcal');

const CONFIG_DIR = path.join(__dirname, '..', 'config');
const CLIENT = process.argv[2] || path.join(CONFIG_DIR, 'google-oauth.local.json');
const OUT = path.join(CONFIG_DIR, 'google-server.local.json');
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

const base64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function main() {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(CLIENT, 'utf8'));
  } catch (err) {
    throw new Error(`cannot read the OAuth client at ${CLIENT}: ${err.message}`);
  }
  const client = parseClientFile(raw);
  if (!client) throw new Error(`${CLIENT} is not a Google Desktop OAuth client file`);
  // A leftover file means the last run's secrets were never cleaned up: say so, don't overwrite.
  if (fs.existsSync(OUT)) throw new Error(`${OUT} already exists - paste or delete it first`);

  const { SCOPES } = await import('../supabase/functions/google/core.mjs');
  const verifier = base64url(crypto.randomBytes(48));
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
  const state = base64url(crypto.randomBytes(24));
  const { redirectUri, code } = await startRedirectServer(state);
  const url = buildAuthUrl({ clientId: client.clientId, redirectUri, state, challenge, scope: SCOPES.join(' ') });

  console.log('Open this URL in the browser logged in to your personal Google account:\n');
  console.log(url);
  console.log('\nWaiting for Google (3 minutes)...');

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: client.clientId,
      client_secret: client.clientSecret,
      code: await code,
      code_verifier: verifier,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
    }).toString(),
    signal: AbortSignal.timeout(15000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`token exchange failed: ${String(body.error)}`);
  if (typeof body.refresh_token !== 'string') throw new Error('Google sent no refresh token (consent was not forced?)');
  const granted = String(body.scope || '').split(' ');
  const missing = SCOPES.filter((s) => !granted.includes(s));
  if (missing.length) console.warn(`Warning: not granted: ${missing.join(', ')} (leave every box ticked on the consent screen)`);

  const secrets = {
    GOOGLE_CLIENT_ID: client.clientId,
    GOOGLE_CLIENT_SECRET: client.clientSecret,
    GOOGLE_REFRESH_TOKEN: body.refresh_token,
  };
  // flag 'wx': never replaces a file; mode 0o600 is ignored on Windows, hence "delete it".
  fs.writeFileSync(OUT, `${JSON.stringify(secrets, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  console.log(`\nSaved to ${OUT}`);
  console.log('Paste the three values into Supabase -> Edge Functions -> Secrets, then delete that file.');
}

main().catch((err) => {
  console.error(`google-server-token: ${err.message}`);
  process.exit(1);
});
