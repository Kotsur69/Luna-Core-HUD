// Supabase Edge Function `lunaswork-feedback` (supabase/functions/lunaswork-feedback/core.mjs,
// LW 3.28b): the client widget's endpoint. Only a known, live token of the
// same run and staging origin gets in; content type, sizes and the rate
// limit (per token, per IP, rows waiting) are checked before any write; the
// text is stored as text and the page URL loses its query.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  handle,
  parseSubmission,
  isImage,
  tokenAllows,
  rateVerdict,
  clientIp,
  readCapped,
  tokenHash,
  createDb,
  MAX_TEXT,
  MAX_URL,
  MAX_SHOT_CHARS,
  MAX_PER_TOKEN,
  MAX_PER_IP,
  MAX_PENDING,
  MAX_BODY_BYTES,
  TOKEN_RE,
} from '../supabase/functions/lunaswork-feedback/core.mjs';

const require = createRequire(import.meta.url);
const W = require('../src/lunasworkWidget.js');

const NOW = 1_800_000_000_000;
const ORIGIN = 'https://staging.example.test';
const RUN_ID = 'lwwidget1';
const TOKEN = W.newToken(() => Buffer.alloc(32, 7));
const ROW = {
  id: '11111111-2222-4333-8444-555555555555',
  user_id: '99999999-2222-4333-8444-555555555555',
  run_id: RUN_ID,
  origin: ORIGIN,
  expires_at: new Date(NOW + 60_000).toISOString(),
  revoked_at: null,
};
const JPEG = `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff, 0xe0]).toString('base64')}`;

function fakeDb({ row = ROW, counts = { token: 0, ip: 0, pending: 0 } } = {}) {
  const d = { hashes: [], hits: [], rows: [], countArgs: [] };
  d.tokenByHash = async (hash) => {
    d.hashes.push(hash);
    return hash === W.hashToken(TOKEN) ? row : null;
  };
  d.counts = async (...args) => {
    d.countArgs.push(args);
    return counts;
  };
  d.recordHit = async (tokenId, ipHash) => d.hits.push({ tokenId, ipHash });
  d.insertFeedback = async (r) => d.rows.push(r);
  d.pruneHits = async () => {};
  return d;
}

const body = (fields = {}) => ({ token: TOKEN, runId: RUN_ID, text: 'the header is too big', url: `${ORIGIN}/settings?session=abc#x`, ...fields });
const req = (payload, { headers = {}, method = 'POST' } = {}) =>
  new Request('https://ref.supabase.co/functions/v1/lunaswork-feedback', {
    method,
    headers: { 'content-type': 'application/json', origin: ORIGIN, 'x-forwarded-for': '203.0.113.9, 10.0.0.1', ...headers },
    body: method === 'POST' ? (typeof payload === 'string' ? payload : JSON.stringify(payload)) : undefined,
  });
const call = async (r, d = fakeDb()) => {
  const res = await handle(r, { env: { WIDGET_IP_SALT: 'salt' }, db: () => d, now: () => NOW });
  return { res, d, json: res.status === 204 ? null : await res.json() };
};

test('caps and patterns match the LunaCore side (src/lunasworkWidget.js)', async () => {
  assert.equal(MAX_TEXT, W.MAX_TEXT);
  assert.equal(MAX_URL, W.MAX_URL);
  assert.equal(MAX_SHOT_CHARS, W.MAX_SHOT_CHARS);
  assert.equal(TOKEN_RE.source, W.TOKEN_RE.source);
  assert.ok(MAX_BODY_BYTES > MAX_SHOT_CHARS + MAX_TEXT * 4 + MAX_URL * 4);
  // Same hash on both sides: LunaCore registers what the function looks up.
  assert.equal(await tokenHash(TOKEN), W.hashToken(TOKEN));
});

test('a good submission is stored once: text as text, page URL without query / hash, IP only hashed', async () => {
  const { res, d, json } = await call(req(body({ text: '  <img src=x onerror=alert(1)>\r\nheader\u0007 too big  ', screenshot: JPEG })));
  assert.equal(res.status, 201);
  assert.deepEqual(json, { ok: true });
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
  assert.deepEqual(d.rows, [{
    user_id: ROW.user_id,
    token_id: ROW.id,
    run_id: RUN_ID,
    // Stored verbatim as text (shown as text everywhere); control characters out.
    text: '<img src=x onerror=alert(1)>\nheader too big',
    page_url: `${ORIGIN}/settings`,
    screenshot: JPEG,
  }]);
  assert.equal(d.hits.length, 1);
  assert.match(d.hits[0].ipHash, /^[0-9a-f]{64}$/);
  assert.ok(!JSON.stringify(d).includes('203.0.113.9'), 'the IP is never stored');
  assert.ok(!JSON.stringify(d.rows).includes(TOKEN), 'the token is never stored');
  assert.deepEqual(d.hashes, [W.hashToken(TOKEN)]);
});

test('token check: unknown, revoked, expired, another run or another origin -> one generic 401, nothing written', async () => {
  const cases = [
    [req(body({ token: W.newToken() })), fakeDb()],
    [req(body({ token: 'short' })), fakeDb()],
    [req(body()), fakeDb({ row: { ...ROW, revoked_at: new Date(NOW - 1).toISOString() } })],
    [req(body()), fakeDb({ row: { ...ROW, expires_at: new Date(NOW).toISOString() } })],
    [req(body({ runId: 'lwother' })), fakeDb()],
    [req(body(), { headers: { origin: 'https://evil.example' } }), fakeDb()],
    [req(body(), { headers: { origin: '' } }), fakeDb()],
  ];
  for (const [r, d] of cases) {
    const { res, json } = await call(r, d);
    assert.equal(res.status, 401);
    assert.deepEqual(json, { error: 'not-allowed' });
    assert.deepEqual(d.rows, []);
    assert.deepEqual(d.hits, []);
  }
  assert.equal(tokenAllows(null, { runId: RUN_ID, origin: ORIGIN, now: NOW }), false);
  assert.equal(tokenAllows({ ...ROW, id: 'not-a-uuid' }, { runId: RUN_ID, origin: ORIGIN, now: NOW }), false);
  assert.equal(tokenAllows(ROW, { runId: RUN_ID, origin: ORIGIN, now: NOW }), true);
});

test('caps: text, page URL and screenshot sizes and shapes are checked before the token is looked up', () => {
  assert.equal(parseSubmission(body({ text: 'x'.repeat(MAX_TEXT) })).ok, true);
  assert.equal(parseSubmission(body({ text: 'x'.repeat(MAX_TEXT + 1) })).error, 'too-long');
  assert.equal(parseSubmission(body({ text: 'x'.repeat(MAX_TEXT * 3) })).error, 'too-long');
  assert.equal(parseSubmission(body({ text: ' \n\t ' })).error, 'empty');
  assert.equal(parseSubmission(body({ text: 42 })).error, 'too-long');
  assert.equal(parseSubmission(body({ url: 'javascript:alert(1)' })).error, 'bad-url');
  assert.equal(parseSubmission(body({ url: `${ORIGIN}/${'a'.repeat(MAX_URL)}` })).error, 'bad-url');
  assert.equal(parseSubmission(body({ url: null })).pageUrl, null);
  assert.equal(parseSubmission(body({ screenshot: 'data:image/svg+xml;base64,PHN2Zz4=' })).error, 'bad-screenshot');
  assert.equal(parseSubmission(body({ screenshot: 'data:text/html;base64,PGI+' })).error, 'bad-screenshot');
  // An image type on bytes that are no image, or broken base64, is refused too.
  const fakePng = `data:image/png;base64,${Buffer.from('<script>alert(1)</script>').toString('base64')}`;
  assert.equal(parseSubmission(body({ screenshot: fakePng })).error, 'bad-screenshot');
  assert.equal(parseSubmission(body({ screenshot: `${JPEG}A` })).error, 'bad-screenshot');
  assert.equal(isImage(JPEG), true);
  assert.equal(isImage(`data:image/png;base64,${Buffer.from([0x89, 0x50, 0x4e, 0x47, 13, 10]).toString('base64')}`), true);
  assert.equal(parseSubmission(body({ screenshot: `data:image/png;base64,${'A'.repeat(MAX_SHOT_CHARS)}` })).error, 'too-large');
  assert.equal(parseSubmission(body({ runId: 'Bad Run' })).error, 'bad-request');
  assert.equal(parseSubmission([]).error, 'bad-request');
  // Unknown keys never reach the row.
  const p = parseSubmission(body({ user_id: 'x', token_id: 'y', html: '<b>' }));
  assert.deepEqual(Object.keys(p).sort(), ['ok', 'pageUrl', 'runId', 'screenshot', 'text', 'token']);
});

test('content type, method, size and JSON are refused before anything else', async () => {
  const d = fakeDb();
  assert.equal((await call(req(body(), { headers: { 'content-type': 'text/plain' } }), d)).res.status, 415);
  assert.equal((await call(req(body(), { headers: { 'content-type': 'application/x-www-form-urlencoded' } }), d)).res.status, 415);
  assert.equal((await call(req(body(), { method: 'GET' }), d)).res.status, 405);
  assert.equal((await call(req('{not json'), d)).res.status, 400);
  assert.equal((await call(req(body({ text: '' })), d)).json.error, 'empty');
  const huge = JSON.stringify(body({ text: 'x'.repeat(MAX_BODY_BYTES) }));
  assert.equal((await call(req(huge), d)).res.status, 413);
  assert.deepEqual(d.hashes, [], 'no lookup for a refused request');
  // CORS preflight: no body, no db.
  const pre = await call(req(null, { method: 'OPTIONS' }), d);
  assert.equal(pre.res.status, 204);
  assert.match(pre.res.headers.get('access-control-allow-methods'), /POST/);
  // Not configured.
  const res = await handle(req(body()), { env: {}, db: () => null, now: () => NOW });
  assert.equal(res.status, 503);
});

test('readCapped stops at the cap even when Content-Length lies', async () => {
  const big = 'x'.repeat(2000);
  const stream = new ReadableStream({
    start(c) {
      for (let i = 0; i < 10; i += 1) c.enqueue(new TextEncoder().encode(big));
      c.close();
    },
  });
  const r = new Request('https://x.test', { method: 'POST', body: stream, duplex: 'half', headers: { 'content-length': '10' } });
  assert.equal(await readCapped(r, 5000), null);
  assert.equal(await readCapped(new Request('https://x.test', { method: 'POST', body: 'hello' }), 5000), 'hello');
  assert.equal(await readCapped(new Request('https://x.test', { method: 'POST', body: new Uint8Array([0xff, 0xfe]) }), 5000), null, 'bad UTF-8');
});

test('rate limit: per token, per IP and rows waiting -> 429 with Retry-After, nothing written', async () => {
  for (const counts of [
    { token: MAX_PER_TOKEN, ip: 0, pending: 0 },
    { token: 0, ip: MAX_PER_IP, pending: 0 },
    { token: 0, ip: 0, pending: MAX_PENDING },
  ]) {
    const d = fakeDb({ counts });
    const { res, json } = await call(req(body()), d);
    assert.equal(res.status, 429);
    assert.deepEqual(json, { error: 'rate-limited' });
    assert.ok(Number(res.headers.get('retry-after')) > 0);
    assert.deepEqual(d.rows, []);
    assert.deepEqual(d.hits, []);
  }
  assert.deepEqual(rateVerdict({ token: MAX_PER_TOKEN - 1, ip: MAX_PER_IP - 1, pending: MAX_PENDING - 1 }), { ok: true });
  assert.equal(rateVerdict({}).ok, false, 'unknown counts never let a request through');
  // The window and the IP the counts were asked for.
  const d = fakeDb();
  await call(req(body()), d);
  const [tokenId, ipHash, since] = d.countArgs[0];
  assert.equal(tokenId, ROW.id);
  assert.equal(ipHash, d.hits[0].ipHash);
  assert.equal(since, NOW - 60 * 60 * 1000);
});

test('clientIp: the platform header first, junk ignored', () => {
  const h = (o) => new Headers(o);
  assert.equal(clientIp(h({ 'cf-connecting-ip': '198.51.100.1', 'x-forwarded-for': '1.1.1.1' })), '198.51.100.1');
  assert.equal(clientIp(h({ 'x-forwarded-for': '203.0.113.9, 10.0.0.1' })), '203.0.113.9');
  assert.equal(clientIp(h({ 'x-forwarded-for': '<script>' })), 'unknown');
  assert.equal(clientIp(h({})), 'unknown');
});

test('createDb: service-role PostgREST calls, every value encoded, counts capped', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, json: async () => (url.includes('widget_tokens') ? [ROW] : [{ id: 1 }, { id: 2 }]) };
  };
  const db = createDb({ url: 'https://ref.supabase.co', serviceKey: 'service', fetchImpl });
  assert.equal(await db.tokenByHash('not-hex'), null);
  assert.equal(calls.length, 0, 'a malformed hash is never sent');
  assert.deepEqual(await db.tokenByHash(W.hashToken(TOKEN)), ROW);
  assert.match(calls[0].url, /token_hash=eq\.[0-9a-f]{64}&limit=1$/);
  assert.equal(calls[0].init.headers.Authorization, 'Bearer service');
  assert.deepEqual(await db.counts(ROW.id, 'a'.repeat(64), NOW), { token: 2, ip: 2, pending: 2 });
  assert.ok(calls.slice(1).every((c) => /&select=id&limit=\d+$/.test(c.url)));
  await db.insertFeedback({ text: 'x' });
  assert.equal(calls[calls.length - 1].init.method, 'POST');
});

test('a store failure is a 502 and is logged without the request body', async () => {
  const d = fakeDb();
  d.insertFeedback = async () => {
    throw new Error('feedback 500');
  };
  const lines = [];
  const res = await handle(req(body({ text: 'secret words' })), { env: {}, db: () => d, now: () => NOW, log: (l) => lines.push(l) });
  assert.equal(res.status, 502);
  assert.equal(lines.length, 1);
  assert.doesNotMatch(lines[0], /secret words/);
});
