// ============================================================================
// LunaCore - Gmail sender tests (src/gmailsend.js)
// ----------------------------------------------------------------------------
// fetch, the browser, the loopback redirect and safeStorage are all fakes;
// files live in a temp dir.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createGmailSender, emailFromIdToken, buildMime, SCOPE } = require('../src/gmailsend.js');

const CLIENT_ID = 'c.apps.googleusercontent.com';
const fakeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (text) => Buffer.from(`enc:${text}`),
  decryptString: (buf) => buf.toString().replace(/^enc:/, ''),
};

const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const idToken = (claims) => `${b64u({ alg: 'RS256' })}.${b64u(claims)}.sig`;
const goodClaims = { iss: 'https://accounts.google.com', aud: CLIENT_ID, email: 'Mati@Example.com', email_verified: true };
const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });

function files() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gmail-test-'));
  const clientPath = path.join(dir, 'client.json');
  fs.writeFileSync(clientPath, JSON.stringify({ installed: { client_id: CLIENT_ID, client_secret: 'sec' } }));
  return { clientPath, tokenPath: path.join(dir, 'gmail-token.local.json') };
}

const fakeRedirect = async () => ({ redirectUri: 'http://127.0.0.1:1', code: Promise.resolve('the-code'), close: () => {} });

const decodeRaw = (raw) => Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');

test('emailFromIdToken needs email_verified, our aud and a Google issuer', () => {
  assert.equal(emailFromIdToken(idToken(goodClaims), CLIENT_ID), 'mati@example.com');
  assert.equal(emailFromIdToken(idToken({ ...goodClaims, email_verified: false }), CLIENT_ID), null);
  assert.equal(emailFromIdToken(idToken({ ...goodClaims, aud: 'other' }), CLIENT_ID), null);
  assert.equal(emailFromIdToken(idToken({ ...goodClaims, iss: 'https://evil.example' }), CLIENT_ID), null);
  assert.equal(emailFromIdToken(idToken({ ...goodClaims, email: 'a@b.c\r\nBcc: x@y.z' }), CLIENT_ID), null);
  assert.equal(emailFromIdToken('garbage', CLIENT_ID), null);
});

test('buildMime: same From and To, header injection stripped, UTF-8 subject encoded', () => {
  const mime = buildMime({ address: 'me@example.com', subject: 'Podsumowanie dnia ąę\r\nBcc: evil@x.com', text: 'line 1\nline 2' });
  const head = mime.split('\r\n\r\n')[0];
  assert.match(head, /^From: me@example.com\r\nTo: me@example.com\r\n/);
  assert.doesNotMatch(head, /^Bcc:/m);
  assert.match(head, /Subject: =\?UTF-8\?B\?/);
  const subject = Buffer.from(/=\?UTF-8\?B\?([^?]+)\?=/.exec(head)[1], 'base64').toString('utf8');
  assert.equal(subject, 'Podsumowanie dnia ąę Bcc: evil@x.com');
  const body = Buffer.from(mime.split('\r\n\r\n')[1].replace(/\r\n/g, ''), 'base64').toString('utf8');
  assert.equal(body, 'line 1\r\nline 2');
});

test('buildMime html part is the escaped text, never caller HTML', () => {
  const mime = buildMime({ address: 'me@example.com', subject: 's', text: '<script>x</script> & "y"', html: true, boundary: 'B' });
  assert.match(mime, /multipart\/alternative; boundary="B"/);
  const parts = mime.split('--B');
  const html = Buffer.from(parts[2].split('\r\n\r\n')[1].replace(/\r\n/g, ''), 'base64').toString('utf8');
  assert.match(html, /&lt;script&gt;x&lt;\/script&gt; &amp; &quot;y&quot;/);
  assert.doesNotMatch(html, /<script>/);
});

test('connect asks only for openid email gmail.send and stores the grant encrypted', async () => {
  const f = files();
  let authUrl = null;
  const fetchImpl = async (url, opts) => {
    assert.equal(url, 'https://oauth2.googleapis.com/token');
    const body = new URLSearchParams(opts.body);
    assert.equal(body.get('grant_type'), 'authorization_code');
    assert.equal(body.get('code'), 'the-code');
    return json({ access_token: 'at', refresh_token: 'rt', expires_in: 3600, scope: `openid ${SCOPE.split(' ')[2]} email`, id_token: idToken(goodClaims) });
  };
  const g = createGmailSender({ fetchImpl, safeStorage: fakeStorage, openExternal: async (u) => (authUrl = u), redirectServer: fakeRedirect, ...f });
  assert.deepEqual(await g.connect(), { email: 'mati@example.com' });
  assert.equal(new URL(authUrl).searchParams.get('scope'), 'openid email https://www.googleapis.com/auth/gmail.send');
  const stored = JSON.parse(fs.readFileSync(f.tokenPath, 'utf8'));
  assert.equal(stored.v, 1);
  assert.doesNotMatch(fs.readFileSync(f.tokenPath, 'utf8'), /rt|mati/);
  // A fresh instance reads it back.
  const again = createGmailSender({ fetchImpl, safeStorage: fakeStorage, ...f });
  assert.deepEqual(again.status(), { configured: true, connected: true, email: 'mati@example.com' });
});

test('connect refuses a grant without gmail.send or without a verified email', async () => {
  for (const reply of [
    { refresh_token: 'rt', scope: 'openid email', id_token: idToken(goodClaims) },
    { refresh_token: 'rt', scope: SCOPE, id_token: idToken({ ...goodClaims, email_verified: false }) },
  ]) {
    const f = files();
    const g = createGmailSender({ fetchImpl: async () => json(reply), safeStorage: fakeStorage, openExternal: async () => {}, redirectServer: fakeRedirect, ...f });
    await assert.rejects(g.connect(), (err) => ['gmail-scope', 'gmail-no-email'].includes(err.reason));
    assert.equal(g.status().connected, false);
    assert.equal(fs.existsSync(f.tokenPath), false);
  }
});

test('send refreshes the token and mails the connected address only', async () => {
  const f = files();
  fs.writeFileSync(f.tokenPath, JSON.stringify({ v: 1, enc: Buffer.from(`enc:${JSON.stringify({ refreshToken: 'rt', email: 'me@example.com' })}`).toString('base64') }));
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, opts });
    if (url.includes('oauth2')) return json({ access_token: 'at2', expires_in: 3600 });
    return json({ id: 'msg1', threadId: 'thr1' });
  };
  const g = createGmailSender({ fetchImpl, safeStorage: fakeStorage, ...f });
  // A `to` field is simply ignored: there is no way to name a recipient.
  assert.deepEqual(await g.send({ subject: 'Hi', text: 'Body', to: 'evil@x.com' }), { id: 'msg1', threadId: 'thr1' });
  const sendCall = calls.find((c) => c.url.includes('messages/send'));
  assert.equal(sendCall.opts.headers.Authorization, 'Bearer at2');
  const mime = decodeRaw(JSON.parse(sendCall.opts.body).raw);
  assert.match(mime, /^From: me@example.com\r\nTo: me@example.com\r\n/);
  assert.doesNotMatch(mime, /evil/);
});

test('send without a grant fails typed; a revoked refresh token forgets the grant', async () => {
  const f = files();
  const g = createGmailSender({ fetchImpl: async () => json({}), safeStorage: fakeStorage, ...f });
  await assert.rejects(g.send({ subject: 's', text: 't' }), (err) => err.reason === 'gmail-not-connected');

  fs.writeFileSync(f.tokenPath, JSON.stringify({ v: 1, enc: Buffer.from(`enc:${JSON.stringify({ refreshToken: 'rt', email: 'me@example.com' })}`).toString('base64') }));
  const revoked = createGmailSender({ fetchImpl: async () => json({ error: 'invalid_grant' }, 400), safeStorage: fakeStorage, ...f });
  await assert.rejects(revoked.send({ subject: 's', text: 't' }), (err) => err.reason === 'gmail-auth');
  assert.equal(revoked.status().connected, false);
  assert.equal(fs.existsSync(f.tokenPath), false);
});

test('buildMime attachments: multipart/mixed, base64 file part, filename sanitized', () => {
  const mime = buildMime({
    address: 'me@example.com',
    subject: 's',
    text: 'body',
    boundary: 'B',
    attachments: [{ filename: 'run "x"\r\n../evil.html', mimeType: 'text/html', content: '<h1>hi</h1>' }],
  });
  assert.match(mime, /Content-Type: multipart\/mixed; boundary="B"/);
  const parts = mime.split('--B');
  const body = Buffer.from(parts[1].split('\r\n\r\n')[1].replace(/\r\n/g, ''), 'base64').toString('utf8');
  assert.equal(body, 'body');
  const [head, data] = parts[2].split('\r\n\r\n');
  assert.match(head, /Content-Type: text\/html; charset=UTF-8; name="run_x_.._evil.html"/);
  assert.match(head, /Content-Disposition: attachment; filename="run_x_.._evil.html"/);
  assert.equal(Buffer.from(data.replace(/\r\n/g, ''), 'base64').toString('utf8'), '<h1>hi</h1>');
  assert.match(mime, /--B--\r\n$/);
});

test('buildMime attachments: an unknown type falls back, an empty list keeps the plain message', () => {
  const plain = buildMime({ address: 'me@example.com', subject: 's', text: 'body', attachments: [] });
  assert.doesNotMatch(plain, /multipart/);
  const mime = buildMime({ address: 'me@example.com', subject: 's', text: 'b', boundary: 'B', attachments: [{ filename: 'a.bin', mimeType: 'evil/"x"', content: 'x' }] });
  assert.match(mime, /Content-Type: application\/octet-stream; name="a.bin"/);
});

test('buildMime attachments: a PNG / JPEG Buffer goes inline, any other Buffer or an oversized image is dropped', () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Array.from({ length: 120 }, (_, i) => i)]);
  const mime = buildMime({
    address: 'me@example.com',
    subject: 's',
    text: 'b',
    boundary: 'B',
    attachments: [
      { filename: 'home.png', mimeType: 'image/png', content: png },
      { filename: 'secret.html', mimeType: 'text/html', content: Buffer.from('<b>raw bytes</b>') },
      { filename: 'huge.jpg', mimeType: 'image/jpeg', content: Buffer.alloc(1024 * 1024 + 1) },
    ],
  });
  const parts = mime.split('--B');
  assert.equal(parts.length, 4, 'body, one image, the closing boundary');
  const [head, data] = parts[2].split('\r\n\r\n');
  assert.match(head, /Content-Type: image\/png; name="home.png"/);
  assert.match(head, /Content-Disposition: inline; filename="home.png"/);
  assert.match(head, /Content-ID: <home.png@lunacore>/);
  assert.ok(Buffer.from(data.replace(/\r\n/g, ''), 'base64').equals(png), 'the image bytes, unchanged');
  assert.ok(!mime.includes('secret.html') && !mime.includes('huge.jpg'));
});

// --- readable HTML alternative (src/mailHtml.js) ------------------------------

const htmlPartOf = (mime) => Buffer.from(mime.split('--B')[2].split('\r\n\r\n')[1].replace(/\r\n/g, ''), 'base64').toString('utf8');
const textPartOf = (mime) => Buffer.from(mime.split('--B')[1].split('\r\n\r\n')[1].replace(/\r\n/g, ''), 'base64').toString('utf8');

test('buildMime html part: headings, bullets, numbered items and code from the text, all escaped', () => {
  const text = [
    'Weekly review - 2026-W43',
    '',
    'A <b>fun</b> week & more.',
    '',
    'FUN',
    '- LunaCore <img src=x onerror=alert(1)>',
    '* second bullet',
    '',
    'Needs you:',
    '1. Merge `luna/<x>`',
    '2. See https://example.com/run?a=1&b=2.',
    '',
    '## Merged / pushed',
    '```',
    'npm test <script>',
    '```',
  ].join('\n');
  const mime = buildMime({ address: 'me@example.com', subject: 's', text, html: true, boundary: 'B' });
  const html = htmlPartOf(mime);
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /max-width:680px/);
  assert.match(html, /sans-serif/);
  assert.match(html, /<h1 [^>]*>Weekly review - 2026-W43<\/h1>/);
  assert.match(html, /<h3 [^>]*>FUN<\/h3>/);
  assert.match(html, /<h3 [^>]*>Needs you<\/h3>/);
  assert.match(html, /<h2 [^>]*>Merged \/ pushed<\/h2>/);
  assert.match(html, /<ul [^>]*><li [^>]*>LunaCore &lt;img src=x onerror=alert\(1\)&gt;<\/li><li [^>]*>second bullet<\/li><\/ul>/);
  assert.match(html, /<ol [^>]*><li [^>]*>Merge <code [^>]*>luna\/&lt;x&gt;<\/code><\/li>/);
  assert.match(html, /<a href="https:\/\/example\.com\/run\?a=1&amp;b=2" [^>]*>https:\/\/example\.com\/run\?a=1&amp;b=2<\/a>\./);
  assert.match(html, /<pre [^>]*monospace[^>]*>npm test &lt;script&gt;<\/pre>/);
  assert.match(html, /A &lt;b&gt;fun&lt;\/b&gt; week &amp; more\./);
  // Only the code-like lines are monospace; the body font is sans-serif.
  assert.match(html, /<body style="[^"]*sans-serif/);
  for (const raw of ['<img', '<script', '<b>']) assert.ok(!html.includes(raw), `raw ${raw} must not reach the html part`);
  assert.ok(!/<style|<link|<script/.test(html), 'inline styles only, no external assets');
  // The plain-text alternative stays exactly the text.
  assert.equal(textPartOf(mime), text.replace(/\n/g, '\r\n'));
});

test('buildMime html part: a javascript: URL never becomes a link', () => {
  const html = htmlPartOf(buildMime({ address: 'me@example.com', subject: 's', text: 'go javascript:alert(1) now', html: true, boundary: 'B' }));
  assert.ok(!html.includes('href='));
  assert.match(html, /go javascript:alert\(1\) now/);
});

test('buildMime html part: indented to-dos stay in their list, markdown tables are monospace', () => {
  const text = 'WORK\n- Client: two open\n    [ ] Fix login\n\n| Package | State |\n| a | pushed |';
  const html = htmlPartOf(buildMime({ address: 'me@example.com', subject: 's', text, html: true, boundary: 'B' }));
  assert.match(html, /<li [^>]*>Client: two open<\/li><li [^>]*><span [^>]*>\[ \]<\/span> Fix login<\/li>/);
  assert.match(html, /<pre [^>]*>\| Package \| State \|\n\| a \| pushed \|<\/pre>/);
});
