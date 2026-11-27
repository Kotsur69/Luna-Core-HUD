// ============================================================================
// LunaCore - luna-mail CLI tests (scripts/luna-mail.js)
// ----------------------------------------------------------------------------
// fetch, the browser, the loopback redirect and DPAPI are all fakes; config
// files live in temp dirs that are removed after the run. One real DPAPI
// round trip runs on Windows only.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  createLunaMail, main, parseArgs, validateRecipients, loadAttachments, isSensitivePath, buildMime,
  encodeHeader, filenameParams, resolveConfigDir, windowsVault, LunaMailError, SCOPE, TOKEN_FILE,
  MAX_TOTAL_ATTACH_BYTES, MAX_BODY_BYTES,
} = require('../scripts/luna-mail.js');

const CLIENT_ID = 'c.apps.googleusercontent.com';
const OWNER = 'owner@example.com';
const fakeVault = {
  available: () => true,
  protect: (text) => Buffer.from(`enc:${text}`).toString('base64'),
  unprotect: (enc) => Buffer.from(enc, 'base64').toString().replace(/^enc:/, ''),
};

const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const idToken = (claims) => `${b64u({ alg: 'RS256' })}.${b64u(claims)}.sig`;
const goodClaims = { iss: 'https://accounts.google.com', aud: CLIENT_ID, email: OWNER, email_verified: true };
const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
const decodeRaw = (raw) => Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
const decodeWords = (s) => s.replace(/\r\n /g, '').replace(/=\?UTF-8\?B\?([^?]*)\?=/g, (_, b) => Buffer.from(b, 'base64').toString('utf8'));

const tempDirs = [];
function tempDir(prefix = 'luna-mail-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}
test.after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function tempConfig({ client = true, grant = null } = {}) {
  const dir = tempDir();
  if (client) {
    fs.writeFileSync(path.join(dir, 'google-oauth.local.json'), JSON.stringify({ installed: { client_id: CLIENT_ID, client_secret: 's' } }));
  }
  if (grant) {
    fs.writeFileSync(path.join(dir, TOKEN_FILE), JSON.stringify({ v: 1, enc: fakeVault.protect(JSON.stringify(grant)) }));
  }
  return dir;
}

/** A file in its own temp dir (outside any config dir). */
function tempFile(name, content) {
  const p = path.join(tempDir('luna-mail-in-'), name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return p;
}

/** A fetch fake that answers by URL and records every call. */
function fakeFetch(routes) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    const route = Object.keys(routes).find((k) => url.startsWith(k));
    if (!route) throw new Error(`unexpected fetch ${url}`);
    return routes[route](init);
  };
  return { impl, calls };
}

const quiet = () => {};
const GRANT = { refreshToken: 'r1', email: OWNER };
const okToken = () => json({ access_token: 'AT' });
const tool = (opts) => createLunaMail({ vault: fakeVault, log: quiet, fetchImpl: fakeFetch({}).impl, ...opts });

// ----------------------------------------------------------------- parseArgs

test('parseArgs collects repeatable and single options', () => {
  const o = parseArgs(['--to', 'a@b.pl', '--to', 'c@d.com', '--cc', 'e@f.io', '--subject', 'Hi', '--body-file', 'x.txt', '--attach', 'p.pdf']);
  assert.deepEqual(o.to, ['a@b.pl', 'c@d.com']);
  assert.deepEqual(o.cc, ['e@f.io']);
  assert.deepEqual(o.attach, ['p.pdf']);
  assert.equal(o.subject, 'Hi');
  assert.equal(o.bodyFile, 'x.txt');
  assert.equal(o.body, null);
  assert.equal(o.revoke, false);
  assert.equal(parseArgs(['--revoke']).revoke, true);
});

test('parseArgs rejects unknown, inherited-key, duplicate and conflicting options', () => {
  assert.throws(() => parseArgs(['--bcc', 'a@b.pl']), /unknown option --bcc/);
  assert.throws(() => parseArgs(['--constructor', 'x']), /unknown option/);
  assert.throws(() => parseArgs(['--__proto__', 'x']), /unknown option/);
  assert.throws(() => parseArgs(['--to']), /bad argument/);
  assert.throws(() => parseArgs(['to', 'a@b.pl']), /bad argument/);
  assert.throws(() => parseArgs(['--subject', 'a', '--subject', 'b']), /given twice/);
  assert.throws(() => parseArgs(['--body', 'a', '--body-file', 'f']), /not both/);
});

// -------------------------------------------------------- validateRecipients

test('validateRecipients trims and accepts good addresses', () => {
  assert.deepEqual(validateRecipients([' a@b.pl '], ['c@d.com']), { to: ['a@b.pl'], cc: ['c@d.com'] });
});

test('validateRecipients requires a --to and rejects bad or injected addresses', () => {
  assert.throws(() => validateRecipients([], ['c@d.com']), /at least one --to/);
  assert.throws(() => validateRecipients(['not-an-address'], []), /invalid address/);
  assert.throws(() => validateRecipients(['a@b.pl\r\nBcc: evil@x.com'], []), /invalid address/);
  assert.throws(() => validateRecipients(['a@b.pl'], ['x@y.z, other@q.com']), /invalid address/);
});

test('validateRecipients caps the recipient count', () => {
  const many = Array.from({ length: 51 }, (_, i) => `u${i}@example.com`);
  assert.throws(() => validateRecipients(many, []), /too many recipients/);
});

// ----------------------------------------------------- headers and file names

test('encodeHeader keeps ASCII and splits non-ASCII into folded words of <= 75 chars', () => {
  assert.equal(encodeHeader('Plain subject'), 'Plain subject');
  const long = 'Zażółć gęślą jaźń 😀 '.repeat(12).trim();
  const encoded = encodeHeader(long);
  const words = encoded.split('\r\n ');
  assert.ok(words.length > 1);
  for (const w of words) assert.ok(w.length <= 75, `encoded-word too long: ${w.length}`);
  assert.equal(decodeWords(encoded), long);
});

test('filenameParams gives an ASCII fallback plus RFC 2231 filename* for non-ASCII names', () => {
  assert.deepEqual(filenameParams('plan.pdf'), { type: 'name="plan.pdf"', disposition: 'filename="plan.pdf"' });
  // Quotes are replaced in the ASCII fallback; filename* keeps the original name.
  const quoted = filenameParams('plan "x".pdf').disposition;
  assert.match(quoted, /^filename="plan _x_\.pdf"; filename\*=UTF-8''/);
  assert.equal(decodeURIComponent(quoted.split("UTF-8''")[1]), 'plan "x".pdf');
  const pl = filenameParams('zdjęcie (1).png');
  assert.equal(pl.type, 'name="zdjecie (1).png"');
  const star = pl.disposition.match(/filename\*=UTF-8''(.+)$/)[1];
  assert.doesNotMatch(star, /[()]/);
  assert.equal(decodeURIComponent(star), 'zdjęcie (1).png');
});

// ----------------------------------------------------------------- buildMime

test('buildMime without attachments is a single UTF-8 text part', () => {
  const mime = buildMime({ from: OWNER, to: ['a@b.pl'], subject: 'Hello', text: 'line1\nline2' });
  assert.match(mime, /^From: owner@example\.com\r\nTo: a@b\.pl\r\nSubject: Hello\r\nMIME-Version: 1\.0\r\n/);
  assert.match(mime, /Content-Type: text\/plain; charset=UTF-8/);
  assert.doesNotMatch(mime, /multipart/);
  const body = mime.split('\r\n\r\n')[1];
  assert.equal(Buffer.from(body, 'base64').toString('utf8'), 'line1\r\nline2');
});

test('buildMime encodes a Polish subject and strips CR/LF from it', () => {
  const mime = buildMime({ from: OWNER, to: ['a@b.pl'], subject: 'Zażółć\r\nBcc: evil@x.com', text: 't' });
  const lines = mime.split('\r\n');
  const start = lines.findIndex((l) => l.startsWith('Subject: '));
  const end = lines.findIndex((l, i) => i > start && !l.startsWith(' '));
  const subject = lines.slice(start, end).join('\r\n').slice('Subject: '.length);
  assert.equal(decodeWords(subject), 'Zażółć Bcc: evil@x.com');
  assert.ok(!lines.some((l) => l.startsWith('Bcc:')));
});

test('buildMime adds Cc and well-formed multipart attachments', () => {
  const data57 = Buffer.alloc(57, 7); // base64 length exactly 76
  const mime = buildMime({
    from: OWNER, to: ['a@b.pl', 'c@d.com'], cc: ['e@f.io'], subject: 's', text: 't', boundary: 'BND',
    files: [{ name: 'a.pdf', type: 'application/pdf', data: Buffer.from('%PDF-1.7') }, { name: 'b.bin', type: 'application/octet-stream', data: data57 }],
  });
  assert.match(mime, /To: a@b\.pl, c@d\.com\r\nCc: e@f\.io\r\n/);
  assert.match(mime, /Content-Type: multipart\/mixed; boundary="BND"/);
  assert.match(mime, /\r\n--BND--\r\n$/);
  // The blank line after the top headers is required; none may follow inside the parts.
  const afterFirstBoundary = mime.slice(mime.indexOf('--BND') + 1);
  assert.doesNotMatch(afterFirstBoundary, /\r\n\r\n--BND/, 'no blank line before an inner boundary');
  for (const line of mime.split('\r\n')) assert.ok(line.length <= 998);
  const parts = mime.split('--BND').slice(1, -1);
  assert.equal(parts.length, 3);
  const lastBody = parts[2].split('\r\n\r\n')[1].trim();
  assert.deepEqual(Buffer.from(lastBody, 'base64'), data57);
});

// ---------------------------------------------------- attachments and guard

test('loadAttachments infers MIME types and enforces the size cap without reading', () => {
  const pdf = tempFile('a.PDF', '%PDF');
  const odd = tempFile('b.weird', 'x');
  const files = loadAttachments([pdf, odd]);
  assert.deepEqual(files.map((f) => [f.name, f.type]), [['a.PDF', 'application/pdf'], ['b.weird', 'application/octet-stream']]);

  const big = tempFile('big.bin', '');
  fs.truncateSync(big, MAX_TOTAL_ATTACH_BYTES + 1);
  assert.throws(() => loadAttachments([big]), /too large/);
});

test('loadAttachments refuses secrets, the config dir, directories and missing files', () => {
  const configDir = tempConfig();
  for (const p of [
    tempFile('.env', 'K=V'),
    tempFile('.env.production', 'K=V'),
    tempFile('id_ed25519', 'key'),
    tempFile('server.pem', 'key'),
    tempFile('cloud-session.local.json', '{}'),
    tempFile(path.join('.ssh', 'config'), 'Host x'),
    path.join(configDir, 'google-oauth.local.json'),
  ]) {
    assert.throws(() => loadAttachments([p], { protectedDir: configDir }), /refused/, p);
  }
  const notesInConfig = path.join(configDir, 'notes.txt');
  fs.writeFileSync(notesInConfig, 'x');
  assert.throws(() => loadAttachments([notesInConfig], { protectedDir: configDir }), /refused/);
  assert.throws(() => loadAttachments([tempDir()]), /not a regular file/);
  assert.throws(() => loadAttachments([path.join(tempDir(), 'missing.pdf')]), /not readable.*ENOENT/);
});

test('isSensitivePath leaves ordinary documents alone', () => {
  assert.equal(isSensitivePath(path.join(os.tmpdir(), 'plan_podrozy.pdf'), null), false);
  assert.equal(isSensitivePath(path.join(os.tmpdir(), 'raport.docx'), path.join(os.tmpdir(), 'cfg')), false);
});

// ---------------------------------------------------------- resolveConfigDir

test('resolveConfigDir honours the env override, then the first dir with a client file', () => {
  assert.equal(resolveConfigDir({ env: { LUNA_MAIL_CONFIG_DIR: 'X:/cfg' } }), 'X:/cfg');
  const appdata = path.join('C:', 'AppData');
  const expected = path.join(appdata, 'LunaCore', 'config');
  assert.equal(resolveConfigDir({ env: { APPDATA: appdata }, exists: (p) => p.startsWith(expected) }), expected);
  assert.throws(() => resolveConfigDir({ env: {}, exists: () => false }), LunaMailError);
});

// --------------------------------------------------------------------- send

test('send refreshes the token and posts the message from the connected address', async () => {
  const configDir = tempConfig({ grant: GRANT });
  const bodyFile = tempFile('body.txt', 'Cześć!\nLuna');
  const attach = tempFile('plan.pdf', '%PDF-1.7');
  const f = fakeFetch({
    'https://oauth2.googleapis.com/token': okToken,
    'https://gmail.googleapis.com/': () => json({ id: 'm1', threadId: 't1' }),
  });
  const out = await tool({ configDir, fetchImpl: f.impl }).send(['--to', 'friend@example.org', '--subject', 'Plan', '--body-file', bodyFile, '--attach', attach]);

  assert.deepEqual(out, { id: 'm1', threadId: 't1' });
  assert.match(f.calls[0].init.body, /grant_type=refresh_token/);
  assert.match(f.calls[0].init.body, /refresh_token=r1/);
  assert.equal(f.calls[1].init.headers.Authorization, 'Bearer AT');
  const mime = decodeRaw(JSON.parse(f.calls[1].init.body).raw);
  assert.match(mime, /^From: owner@example\.com\r\nTo: friend@example\.org\r\n/);
  assert.match(mime, /Content-Disposition: attachment; filename="plan\.pdf"/);
});

test('send validates input before touching the network', async () => {
  const f = fakeFetch({});
  const t = tool({ configDir: tempConfig({ grant: GRANT }), fetchImpl: f.impl });
  await assert.rejects(t.send(['--to', 'bad', '--subject', 's', '--body', 'b']), /invalid address/);
  await assert.rejects(t.send(['--to', 'a@b.pl', '--body', 'b']), /--subject is required/);
  await assert.rejects(t.send(['--to', 'a@b.pl', '--subject', '\r\n', '--body', 'b']), /--subject is required/);
  await assert.rejects(t.send(['--to', 'a@b.pl', '--subject', 's']), /--body or --body-file/);
  await assert.rejects(t.send(['--to', 'a@b.pl', '--subject', 's', '--body', '   ']), /--body or --body-file/);
  await assert.rejects(t.send(['--to', 'a@b.pl', '--subject', 's', '--body', 'b', '--revoke']), /belongs to "disconnect"/);
  const bigBody = tempFile('big.txt', '');
  fs.truncateSync(bigBody, MAX_BODY_BYTES + 1);
  await assert.rejects(t.send(['--to', 'a@b.pl', '--subject', 's', '--body-file', bigBody]), /body file too large/);
  await assert.rejects(t.send(['--to', 'a@b.pl', '--subject', 's', '--body-file', tempFile('.env', 'K=V')]), /refused/);
  assert.equal(f.calls.length, 0);
});

test('send without a stored grant says to connect', async () => {
  await assert.rejects(tool({ configDir: tempConfig() }).send(['--to', 'a@b.pl', '--subject', 's', '--body', 'b']), /not connected/);
});

test('send turns invalid_grant into a reconnect hint', async () => {
  const f = fakeFetch({ 'https://oauth2.googleapis.com/token': () => json({ error: 'invalid_grant' }, 400) });
  const t = tool({ configDir: tempConfig({ grant: GRANT }), fetchImpl: f.impl });
  await assert.rejects(t.send(['--to', 'a@b.pl', '--subject', 's', '--body', 'b']), /run "connect" again/);
  await assert.rejects(t.status(), /run "connect" again/);
});

test('send reports a Gmail API error with its status', async () => {
  const f = fakeFetch({
    'https://oauth2.googleapis.com/token': okToken,
    'https://gmail.googleapis.com/': () => json({ error: { message: 'Quota exceeded' } }, 429),
  });
  await assert.rejects(tool({ configDir: tempConfig({ grant: GRANT }), fetchImpl: f.impl }).send(['--to', 'a@b.pl', '--subject', 's', '--body', 'b']), /HTTP 429 Quota exceeded/);
});

test('a network failure on send says the message may have been sent, with the cause', async () => {
  const f = fakeFetch({
    'https://oauth2.googleapis.com/token': okToken,
    'https://gmail.googleapis.com/': () => { throw new TypeError('fetch failed', { cause: new Error('ECONNRESET') }); },
  });
  await assert.rejects(
    tool({ configDir: tempConfig({ grant: GRANT }), fetchImpl: f.impl }).send(['--to', 'a@b.pl', '--subject', 's', '--body', 'b']),
    /MAY have been sent.*fetch failed \(ECONNRESET\)/,
  );
});

test('token file problems fail loudly instead of looking disconnected', async () => {
  const corrupt = tempConfig();
  fs.writeFileSync(path.join(corrupt, TOKEN_FILE), '{not json');
  await assert.rejects(tool({ configDir: corrupt }).status(), /corrupt JSON/);

  const wrongVersion = tempConfig();
  fs.writeFileSync(path.join(wrongVersion, TOKEN_FILE), JSON.stringify({ v: 2, enc: 'x' }));
  await assert.rejects(tool({ configDir: wrongVersion }).status(), /unrecognised token file/);

  const undecryptable = tempConfig();
  fs.writeFileSync(path.join(undecryptable, TOKEN_FILE), JSON.stringify({ v: 1, enc: 'xx' }));
  const vault = { ...fakeVault, unprotect: () => { throw new Error('DPAPI: key not valid'); } };
  await assert.rejects(tool({ configDir: undecryptable, vault }).status(), /cannot decrypt .*another machine/);

  const badContent = tempConfig();
  fs.writeFileSync(path.join(badContent, TOKEN_FILE), JSON.stringify({ v: 1, enc: fakeVault.protect('{"email":"x"}') }));
  await assert.rejects(tool({ configDir: badContent }).status(), /content is invalid/);
});

// ------------------------------------------------------------------ connect

function fakeRedirect(code = Promise.resolve('CODE')) {
  let closed = false;
  let called = false;
  code.catch(() => {});
  const server = async () => {
    called = true;
    return { redirectUri: 'http://127.0.0.1:5555', code, close: () => { closed = true; } };
  };
  return { server, wasClosed: () => closed, wasCalled: () => called };
}

test('connect asks for gmail.send only and stores the encrypted grant', async () => {
  const configDir = tempConfig();
  const r = fakeRedirect();
  let opened = null;
  const f = fakeFetch({
    'https://oauth2.googleapis.com/token': () => json({ refresh_token: 'R', access_token: 'A', scope: SCOPE, id_token: idToken(goodClaims) }),
  });
  const t = tool({ configDir, fetchImpl: f.impl, redirectServer: r.server, openBrowser: (u) => { opened = u; } });
  assert.deepEqual(await t.connect(), { email: OWNER });

  assert.equal(new URL(opened).searchParams.get('scope'), 'openid email https://www.googleapis.com/auth/gmail.send');
  assert.match(f.calls[0].init.body, /code=CODE/);
  assert.match(f.calls[0].init.body, /code_verifier=/);
  assert.ok(r.wasClosed());
  const stored = JSON.parse(fs.readFileSync(path.join(configDir, TOKEN_FILE), 'utf8'));
  assert.equal(stored.v, 1);
  assert.ok(!JSON.stringify(stored).includes('"R"'), 'refresh token must not be stored in clear');
  assert.deepEqual(JSON.parse(fakeVault.unprotect(stored.enc)), { refreshToken: 'R', email: OWNER });
  assert.ok(!fs.existsSync(path.join(configDir, 'luna-mail-token.tmp.local.json')));
});

test('connect refuses a grant without the send scope, a verified email or a refresh token', async () => {
  for (const reply of [
    { refresh_token: 'R', scope: 'openid email', id_token: idToken(goodClaims) },
    { refresh_token: 'R', scope: SCOPE, id_token: idToken({ ...goodClaims, email_verified: false }) },
    { refresh_token: 'R', scope: SCOPE, id_token: idToken({ ...goodClaims, aud: 'other' }) },
    { scope: SCOPE, id_token: idToken(goodClaims) },
  ]) {
    const configDir = tempConfig();
    const f = fakeFetch({ 'https://oauth2.googleapis.com/token': () => json(reply) });
    await assert.rejects(tool({ configDir, fetchImpl: f.impl, redirectServer: fakeRedirect().server, openBrowser: quiet }).connect(), LunaMailError);
    assert.ok(!fs.existsSync(path.join(configDir, TOKEN_FILE)));
  }
});

test('connect refuses before consent when the vault is unavailable', async () => {
  const r = fakeRedirect();
  const vault = { ...fakeVault, available: () => false };
  await assert.rejects(tool({ configDir: tempConfig(), vault, redirectServer: r.server, openBrowser: quiet }).connect(), /DPAPI/);
  assert.equal(r.wasCalled(), false);
});

test('connect reports a denied or timed-out consent and closes the redirect server', async () => {
  const denied = Object.assign(new Error('denied'), { reason: 'gcal-denied' });
  const r = fakeRedirect(Promise.reject(denied));
  const f = fakeFetch({});
  await assert.rejects(tool({ configDir: tempConfig(), fetchImpl: f.impl, redirectServer: r.server, openBrowser: quiet }).connect(), /consent not completed: gcal-denied/);
  assert.ok(r.wasClosed());
  assert.equal(f.calls.length, 0);
});

test('connect closes the redirect server when the token exchange fails', async () => {
  const r = fakeRedirect();
  const f = fakeFetch({ 'https://oauth2.googleapis.com/token': () => json({ error: 'invalid_request' }, 400) });
  await assert.rejects(tool({ configDir: tempConfig(), fetchImpl: f.impl, redirectServer: r.server, openBrowser: quiet }).connect(), /HTTP 400/);
  assert.ok(r.wasClosed());
});

test('connect explains a token that could not be stored after consent', async () => {
  const f = fakeFetch({ 'https://oauth2.googleapis.com/token': () => json({ refresh_token: 'R', scope: SCOPE, id_token: idToken(goodClaims) }) });
  const vault = { ...fakeVault, protect: () => { throw new Error('powershell missing'); } };
  await assert.rejects(
    tool({ configDir: tempConfig(), vault, fetchImpl: f.impl, redirectServer: fakeRedirect().server, openBrowser: quiet }).connect(),
    /could not be stored \(powershell missing\).*myaccount\.google\.com/,
  );
});

// ------------------------------------------------------- status / disconnect

test('status reports the connected address after a successful refresh', async () => {
  const f = fakeFetch({ 'https://oauth2.googleapis.com/token': okToken });
  assert.deepEqual(await tool({ configDir: tempConfig({ grant: GRANT }), fetchImpl: f.impl }).status(), { connected: true, email: OWNER });
  assert.deepEqual(await tool({ configDir: tempConfig(), fetchImpl: f.impl }).status(), { connected: false });
});

test('disconnect deletes only the local token unless --revoke is given', async () => {
  const configDir = tempConfig({ grant: GRANT });
  const f = fakeFetch({});
  await tool({ configDir, fetchImpl: f.impl }).disconnect([]);
  assert.equal(f.calls.length, 0);
  assert.ok(!fs.existsSync(path.join(configDir, TOKEN_FILE)));
});

test('disconnect --revoke revokes at Google and deletes the token, even if the revoke fails', async () => {
  for (const revoke of [() => json({}), () => json({ error: 'server' }, 503)]) {
    const configDir = tempConfig({ grant: GRANT });
    const f = fakeFetch({ 'https://oauth2.googleapis.com/revoke': revoke });
    const lines = [];
    await tool({ configDir, fetchImpl: f.impl, log: (l) => lines.push(l) }).disconnect(['--revoke']);
    assert.match(f.calls[0].init.body, /token=r1/);
    assert.ok(!fs.existsSync(path.join(configDir, TOKEN_FILE)));
    assert.ok(lines.some((l) => /may also disconnect LunaCore/.test(l)));
    assert.equal(lines.at(-1), 'DISCONNECTED (revoked)');
  }
});

// --------------------------------------------------------------------- main

test('main returns 2 on usage errors, 1 on failures and 0 on success', async (t) => {
  t.mock.method(console, 'error', () => {});
  assert.equal(await main([]), 2);
  assert.equal(await main(['bogus']), 2);
  assert.equal(await main(['status'], { configDir: () => { throw new LunaMailError('no config'); } }), 1);
  const ok = { status: async () => ({}) };
  assert.equal(await main(['status'], { configDir: () => 'X', makeTool: () => ok }), 0);
});

// -------------------------------------------------------------------- DPAPI

test('windowsVault round-trips through real DPAPI', { skip: process.platform !== 'win32' }, () => {
  const secret = JSON.stringify({ refreshToken: 'zażółć-1', email: OWNER });
  const enc = windowsVault.protect(secret);
  assert.notEqual(enc, Buffer.from(secret).toString('base64'));
  assert.equal(windowsVault.unprotect(enc), secret);
});
