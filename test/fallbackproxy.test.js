// ============================================================================
// Free God Mode v2 F2a / F2b / F3 in the fallback proxy (src/fallbackproxy.js):
// the exhausted-chain usage-limit answer (src/freeLimit.js), the gateway's
// 120-request window (src/freePacer.js) and the X-Routed-Via substitution
// guard (src/freechains.js `expect`).
//
// Gateway bodies below are FreeLLMAPI's real wording (server/src/lib/
// fallback-loop.ts exhaustedRetryError, services/router.ts summarizeExhaustion,
// middleware/rateLimit.ts). The CLI entry is the one Claude Code 2.1.319
// wrote in the live check (docs/reference/FREE_PROVIDERS.md).
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('http');

const chains = require('../src/freechains');
const { FallbackProxy, onRoute, MODEL_HEADER, MAX_THROTTLE_RETRIES } = require('../src/fallbackproxy');
const { RequestPacer } = require('../src/freePacer');
const freeLimit = require('../src/freeLimit');
const { usageLimitFrom } = require('../src/observer');
const { SHIM_TOKEN_HEADER } = require('../src/sessionenv');
const { maxParallelFor, FREE_MAX_PARALLEL } = require('../src/orchestraFree');

const MIN = 60 * 1000;
// A local wall-clock moment: 2026-11-08 14:07:30 on the machine running the tests.
const NOW = new Date(2026, 10, 8, 14, 7, 30).getTime();

const RATE_LIMITED = (eta) => JSON.stringify({
  type: 'error',
  error: {
    type: 'rate_limit_error',
    message: `All models rate-limited after 3 attempts.${eta ? ` Soonest cooldown reset ${eta}.` : ''} Attempt trail: nvidia/nemotron-3-ultra=rate_limited. Last error: 429 Too Many Requests`,
  },
});
const EXHAUSTED = (eta) => JSON.stringify({
  type: 'error',
  error: {
    type: 'rate_limit_error',
    message: `All models exhausted: 3 routes checked (3 rate-limited or on cooldown). Add more API keys or wait for rate limits to reset.${eta ? ` Soonest reset ${eta}.` : ''}`,
  },
});
const KEY_WINDOW = (secs) => JSON.stringify({
  error: { message: `Rate limit exceeded: more than 120 requests per minute. Retry in ${secs}s.`, type: 'rate_limit_error' },
});

/** The API-error entry the CLI writes for a 429 (live check, claude 2.1.319). */
function cliLimitEntry(message) {
  return JSON.stringify({
    type: 'assistant',
    timestamp: new Date(NOW).toISOString(),
    message: {
      model: '<synthetic>',
      role: 'assistant',
      content: [{ type: 'text', text: `API Error: Server is temporarily limiting requests (not your usage limit) · ${message}` }],
    },
    apiErrorIsTransient: true,
    error: 'rate_limit',
    isApiErrorMessage: true,
    apiErrorStatus: 429,
  });
}

/** A fake clock whose sleeps pass instantly. */
function fakeClock(start = NOW) {
  const c = { t: start, slept: [] };
  c.now = () => c.t;
  c.sleep = async (ms) => {
    c.slept.push(ms);
    c.t += ms;
  };
  return c;
}

// --- F2a: the usage-limit answer ----------------------------------------------------

test('freeLimit: each model cools for Retry-After, else the ~Xm hint, else its default; the reset is the first one back', () => {
  const chain = { id: 'free-coding', models: ['a', 'b', 'c'] };
  const ceilMin = (ms) => Math.ceil(ms / MIN) * MIN;
  // What the proxy does per failed model: retryMs = Retry-After ?? hint ?? null.
  const cool = (map, model, retryAfterMs, hintMs) => chains.withCooldown(map, model, 'limit', NOW, retryAfterMs ?? hintMs ?? null);
  let cd = cool(new Map(), 'a', 40 * MIN, 5 * MIN); // Retry-After wins over the hint
  assert.equal(cd.get('a'), NOW + 40 * MIN);
  cd = cool(cd, 'b', null, 15 * MIN); // no Retry-After: the hint
  assert.equal(cd.get('b'), NOW + 15 * MIN);
  cd = cool(cd, 'c', null, null); // nothing named: a daily cap, 30 min
  assert.equal(cd.get('c'), NOW + 30 * MIN);
  const at = (failures, cooldowns) => freeLimit.exhaustedResetAt({ failures, chain, cooldowns, now: NOW });
  // One long Retry-After never hides a model that is back sooner.
  assert.equal(at([], cd), ceilMin(NOW + 15 * MIN));
  // The gateway's request window (no model cooldown) counts too.
  assert.equal(at([{ kind: 'throttled', retryAfterMs: 2 * MIN }], cd), ceilMin(NOW + 2 * MIN));
  // Nothing known at all: +30 min.
  assert.equal(at([], new Map()), ceilMin(NOW + freeLimit.NO_RESET_WAIT_MS));
  // Whole minutes, never sooner than the lead (a pause must outlast the CLI's own retries) ...
  assert.equal(at([{ kind: 'throttled', retryAfterMs: 5000 }], new Map()), ceilMin(NOW + freeLimit.MIN_RESET_LEAD_MS));
  // ... and never further than the cap (then one model is re-probed).
  assert.equal(at([], new Map([['a', NOW + 30 * 60 * MIN]])), ceilMin(NOW + freeLimit.MAX_RESET_MS));
});

test('freeLimit: the answer is an Anthropic 429 whose text usageLimitFrom reads back to the same minute', () => {
  const chain = { id: 'free-coding', models: ['a'] };
  const resetAt = new Date(2026, 10, 8, 15, 40).getTime();
  const answer = freeLimit.usageLimitAnswer(chain, resetAt, NOW);
  assert.equal(answer.status, 429);
  assert.equal(answer.headers['retry-after'], String(Math.ceil((resetAt - NOW) / 1000)));
  assert.equal(answer.headers['x-should-retry'], 'false');
  const { error } = JSON.parse(answer.body);
  assert.equal(error.type, 'rate_limit_error');
  assert.equal(error.message, 'Free coding models: usage limit reached · resets Nov 8, 3:40pm');
  assert.deepEqual(usageLimitFrom(cliLimitEntry(error.message), NOW), { resetsAt: resetAt });
  // Read after the reset already passed (the CLI retried long): still today, not tomorrow.
  const late = usageLimitFrom(cliLimitEntry(error.message), resetAt + 5 * MIN).resetsAt;
  assert.equal(late, resetAt);
  // Midnight and noon print as 12.
  assert.equal(freeLimit.formatResetClock(new Date(2026, 0, 2, 0, 5).getTime()), 'Jan 2, 12:05am');
  assert.equal(freeLimit.formatResetClock(new Date(2026, 0, 2, 12, 0).getTime()), 'Jan 2, 12:00pm');
  assert.equal(freeLimit.chainLabel({ id: 'my-chain' }), 'Free models (my-chain)');
});

test('the gateway bodies themselves name no clock time - the proxy has to rewrite them', () => {
  for (const body of [RATE_LIMITED('~12m'), EXHAUSTED('~45m'), EXHAUSTED(null)]) {
    assert.deepEqual(usageLimitFrom(cliLimitEntry(JSON.parse(body).error.message), NOW), { resetsAt: null });
  }
  assert.equal(chains.resetHintMs(RATE_LIMITED('~12m')), 12 * MIN);
  assert.equal(chains.resetHintMs(EXHAUSTED('~45s')), 45 * 1000);
  assert.equal(chains.resetHintMs(EXHAUSTED('~2h')), 2 * 60 * MIN);
  assert.equal(chains.resetHintMs(EXHAUSTED(null)), null);
});

test('a limit without Retry-After cools for the ~Xm hint; with nothing at all for 30 min (daily cap)', () => {
  const hinted = chains.withCooldown(new Map(), 'm', 'limit', NOW, chains.resetHintMs(EXHAUSTED('~12m')));
  assert.equal(hinted.get('m'), NOW + 12 * MIN);
  assert.equal(chains.withCooldown(new Map(), 'm', 'limit', NOW, null).get('m'), NOW + 30 * MIN);
  assert.equal(chains.withCooldown(new Map(), 'm', 'substituted', NOW, 5000).get('m'), NOW + chains.COOLDOWN_MS.substituted);
});

// --- fake gateway + client -------------------------------------------------------------

function startGateway(answer) {
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
      seen.push({ url: req.url, model: body && body.model });
      answer(body && body.model, res, seen.length);
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, seen })));
}

function post(port, token, model = 'claude-opus') {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, method: 'POST', path: '/v1/messages',
      headers: { 'content-type': 'application/json', [SHIM_TOKEN_HEADER]: token },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.end(JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }] }));
  });
}

async function withProxy(chain, answer, run, extra = {}) {
  const clock = fakeClock();
  const { server, seen } = await startGateway(answer);
  const warnings = [];
  const proxy = new FallbackProxy({
    upstream: `http://127.0.0.1:${server.address().port}`,
    chain,
    now: clock.now,
    pacer: new RequestPacer({ now: clock.now, sleep: clock.sleep, minGapMs: 0 }),
    warn: (m) => warnings.push(m),
    ...extra,
  });
  const { port, token } = await proxy.start();
  try {
    await run({ send: (model) => post(port, token, model), seen, clock, proxy, warnings });
  } finally {
    await proxy.stop();
    server.close();
  }
}

const ok = (res, model, headers = {}) => {
  res.writeHead(200, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify({ ok: true, model }));
};
const fail = (res, status, body, headers = {}) => {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(body);
};

test('proxy F2a: an exhausted chain answers the usage-limit 429, then waits, then re-probes ONE model', async () => {
  const chain = { id: 'free-coding', models: ['a', 'b', 'c'] };
  let open = false;
  await withProxy(chain, (model, res) => {
    if (open && model === 'a') return ok(res, model);
    if (model === 'a') return fail(res, 429, RATE_LIMITED('~12m'), { 'retry-after': '720' });
    if (model === 'b') return fail(res, 429, EXHAUSTED('~20m'));
    return fail(res, 429, EXHAUSTED(null));
  }, async ({ send, seen, clock }) => {
    const first = await send();
    assert.equal(first.status, 429);
    assert.deepEqual(seen.map((s) => s.model), ['a', 'b', 'c']);
    const message = JSON.parse(first.body).error.message;
    // Gateway Retry-After (12 min) wins; rounded up to the minute.
    const expected = Math.ceil((NOW + 12 * MIN) / MIN) * MIN;
    assert.equal(usageLimitFrom(cliLimitEntry(message), clock.now()).resetsAt, expected);
    assert.equal(first.headers['x-should-retry'], 'false');
    // The CLI asking again before the reset: answered at once, nothing sent upstream.
    seen.length = 0;
    assert.equal((await send()).status, 429);
    assert.equal(seen.length, 0);
    // a cooled 12 min, b 20 min (its ~20m hint), c 30 min (no reset named = daily cap).
    clock.t = NOW + 13 * MIN;
    assert.equal((await send()).status, 429);
    assert.deepEqual(seen.map((s) => s.model), ['a'], 'one model re-probed');
    clock.t = NOW + 40 * MIN;
    seen.length = 0;
    open = true;
    const back = await send();
    assert.equal(back.status, 200);
    assert.deepEqual(seen.map((s) => s.model), ['a']);
    // The chain is open again: a later failure walks the whole chain once more.
    open = false;
    clock.t = NOW + 41 * MIN;
    seen.length = 0;
    await send();
    assert.deepEqual(seen.map((s) => s.model), ['a', 'b', 'c']);
  });
});

test('proxy F2a: outages only still pass the last upstream answer through', async () => {
  await withProxy({ id: 'free-coding', models: ['a', 'b'] }, (model, res) => fail(res, 503, `{"error":"down ${model}"}`), async ({ send }) => {
    const res = await send();
    assert.equal(res.status, 503);
    assert.match(res.body, /down b/);
  });
});

// --- F2b: the gateway's request window ---------------------------------------------------

test('pacer: never more than the window budget in 60 s, with the minimum gap between requests', async () => {
  const clock = fakeClock();
  const pacer = new RequestPacer({ now: clock.now, sleep: clock.sleep, limit: 120, reserve: 10, minGapMs: 100 });
  const sentAt = [];
  await Promise.all(Array.from({ length: 250 }, () => pacer.acquire().then(() => sentAt.push(clock.now()))));
  assert.equal(sentAt.length, 250);
  for (let i = 0; i < sentAt.length; i += 1) {
    const inWindow = sentAt.filter((t) => t > sentAt[i] - 60_000 && t <= sentAt[i]).length;
    assert.ok(inWindow <= 110, `request ${i}: ${inWindow} in one window`);
    if (i) assert.ok(sentAt[i] - sentAt[i - 1] >= 100, 'spaced');
  }
});

test('pacer: the gateway headers win, and a key-level 429 blocks every request until its Retry-After', async () => {
  const clock = fakeClock();
  const pacer = new RequestPacer({ now: clock.now, sleep: clock.sleep, minGapMs: 0 });
  pacer.observe({ 'x-ratelimit-limit': '120', 'x-ratelimit-remaining': '3', 'x-ratelimit-reset': String(Math.ceil((NOW + 20_000) / 1000)) });
  await pacer.acquire();
  assert.ok(clock.now() >= NOW + 20_000, 'waited for the gateway window to reset');
  const before = clock.now();
  pacer.block(7000);
  await pacer.acquire();
  assert.equal(clock.now(), before + 7000);
  // Unknown or broken headers change nothing.
  pacer.observe({ 'x-ratelimit-remaining': 'x' });
  assert.equal(pacer.delayMs(), 0);
});

test('proxy F2b: a key-level 429 is a short wait and the SAME model again, no cooldown', async () => {
  await withProxy({ id: 'free-coding', models: ['a', 'b'] }, (model, res, n) => (
    n === 1 ? fail(res, 429, KEY_WINDOW(7), { 'retry-after': '7' }) : ok(res, model)
  ), async ({ send, seen, clock, proxy }) => {
    const res = await send();
    assert.equal(res.status, 200);
    assert.deepEqual(seen.map((s) => s.model), ['a', 'a']);
    assert.ok(clock.slept.includes(7000), 'waited the Retry-After');
    assert.equal(proxy.cooldowns.size, 0);
  });
});

test('proxy F2b: a key window that stays shut ends in the usage-limit 429, one model only', async () => {
  await withProxy({ id: 'free-coding', models: ['a', 'b'] }, (model, res) => fail(res, 429, KEY_WINDOW(30), { 'retry-after': '30' }), async ({ send, seen }) => {
    const res = await send();
    assert.equal(res.status, 429);
    assert.match(JSON.parse(res.body).error.message, /usage limit reached · resets /);
    assert.deepEqual(seen.map((s) => s.model), Array(MAX_THROTTLE_RETRIES + 1).fill('a'));
  });
});

test('a free run caps its parallel workers (configurable), other runs keep the run maximum', () => {
  assert.equal(maxParallelFor({ freeMode: false }, 3, {}), 3);
  assert.equal(maxParallelFor({ freeMode: true }, 3, {}), Math.min(3, FREE_MAX_PARALLEL));
  assert.equal(maxParallelFor({ freeMode: true }, 3, { LUNACORE_FREE_MAX_PARALLEL: '1' }), 1);
  assert.equal(maxParallelFor({ freeMode: true }, 3, { LUNACORE_FREE_MAX_PARALLEL: '9' }), 3);
  assert.equal(maxParallelFor({ freeMode: true }, 3, { LUNACORE_FREE_MAX_PARALLEL: 'x' }), Math.min(3, FREE_MAX_PARALLEL));
});

test('the board names a free-limit pause in both languages', () => {
  const i18n = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'i18n.js'), 'utf8');
  assert.match(i18n, /'orch\.free\.paused': 'Free coding models limited - retrying at \{time\}'/);
  assert.match(i18n, /'orch\.free\.paused': 'Darmowe modele kodowania ograniczone - ponowna proba o \{time\}'/);
  const board = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'modules', 'orchestra.js'), 'utf8');
  assert.match(board, /plan\.freeMode \? 'orch\.free\.paused'/);
});

// --- F3: the substitution guard -------------------------------------------------------

test('expect lists: validated at the config boundary, a broken one is ignored with a warning', () => {
  const warnings = [];
  const warn = (m) => warnings.push(m);
  const good = chains.normalizeChain({ id: 'x', models: ['glm-4.6'], expect: [' nemotron-3-ultra ', 'gpt-oss-120b', 'gpt-oss-120b'] }, { warn });
  assert.deepEqual(good.expect, ['nemotron-3-ultra', 'gpt-oss-120b']);
  assert.equal(chains.normalizeChain({ id: 'x', models: ['glm-4.6'] }, { warn }).expect, undefined);
  for (const bad of ['nemotron', [], [7], ['bad\nvalue'], ['x'.repeat(61)], Array(17).fill('a')]) {
    const chain = chains.normalizeChain({ id: 'x', models: ['glm-4.6'], expect: bad }, { warn });
    assert.deepEqual(chain.models, ['glm-4.6'], 'the chain itself survives');
    assert.equal(chain.expect, undefined);
  }
  assert.equal(warnings.length, 6);
  assert.equal(chains.routedMatches('NVIDIA/Nemotron-3-Ultra-253B', ['nemotron-3-ultra']), true);
  assert.equal(chains.routedMatches('groq/llama-3.3-70b', ['nemotron-3-ultra']), false);
});

const guarded = { id: 'free-coding', models: ['a', 'b'], expect: ['nemotron-3-ultra', 'gpt-oss-120b'] };

test('proxy F3: a matching X-Routed-Via passes, with the real model in x-lunacore-model', async () => {
  await withProxy(guarded, (model, res) => ok(res, model, { 'x-routed-via': 'nvidia/nemotron-3-ultra' }), async ({ send, seen }) => {
    const res = await send();
    assert.equal(res.status, 200);
    assert.equal(res.headers[MODEL_HEADER], 'nvidia/nemotron-3-ultra');
    assert.equal(seen.length, 1);
  });
});

test('proxy F3: a substituted answer is refused, cooled, and the next model answers', async () => {
  const events = [];
  const off = onRoute((e) => events.push(e));
  try {
    await withProxy(guarded, (model, res) => (
      model === 'a'
        ? ok(res, `LEAKED-${model}`, { 'x-routed-via': 'groq/llama-3.3-70b' })
        : ok(res, model, { 'x-routed-via': 'openrouter/gpt-oss-120b' })
    ), async ({ send, seen, proxy, clock }) => {
      const res = await send();
      assert.equal(res.status, 200);
      assert.doesNotMatch(res.body, /LEAKED/);
      assert.equal(res.headers[MODEL_HEADER], 'openrouter/gpt-oss-120b');
      assert.deepEqual(seen.map((s) => s.model), ['a', 'b']);
      assert.equal(proxy.cooldowns.get('a'), clock.now() + chains.COOLDOWN_MS.substituted);
      // The next request starts on b: a is cooling.
      seen.length = 0;
      await send();
      assert.deepEqual(seen.map((s) => s.model), ['b']);
    });
  } finally {
    off();
  }
  assert.deepEqual(events.slice(0, 2).map((e) => [e.model, e.routedVia, e.substituted]), [
    ['a', 'groq/llama-3.3-70b', true],
    ['b', 'openrouter/gpt-oss-120b', false],
  ]);
});

test('proxy F3: a stream is judged on its headers - no body byte of a substitute reaches the client', async () => {
  let releaseA = null;
  await withProxy(guarded, (model, res) => {
    if (model === 'a') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'x-routed-via': 'groq/llama-3.3-70b' });
      res.flushHeaders();
      // The body only comes once b was asked: the decision cannot have waited for it.
      releaseA = () => res.end('event: message_start\ndata: {"LEAKED":true}\n\n');
      return undefined;
    }
    if (releaseA) releaseA();
    res.writeHead(200, { 'content-type': 'text/event-stream', 'x-routed-via': 'nvidia/nemotron-3-ultra' });
    return res.end('event: message_start\ndata: {"from":"b"}\n\n');
  }, async ({ send, seen }) => {
    const res = await send();
    assert.equal(res.status, 200);
    assert.match(res.body, /"from":"b"/);
    assert.doesNotMatch(res.body, /LEAKED/);
    assert.deepEqual(seen.map((s) => s.model), ['a', 'b']);
  });
});

test('proxy F3: a missing X-Routed-Via is accepted with one warning', async () => {
  await withProxy(guarded, (model, res) => ok(res, model), async ({ send, warnings }) => {
    assert.equal((await send()).status, 200);
    assert.equal((await send()).status, 200);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /no x-routed-via header/);
  });
});

test('proxy F3: every model substituted -> the F2a usage-limit answer', async () => {
  await withProxy(guarded, (model, res) => ok(res, model, { 'x-routed-via': 'groq/llama-3.3-70b' }), async ({ send, seen }) => {
    const res = await send();
    assert.equal(res.status, 429);
    assert.match(JSON.parse(res.body).error.message, /^Free coding models: usage limit reached · resets /);
    assert.deepEqual(seen.map((s) => s.model), ['a', 'b']);
  });
});

test('proxy F3: plan runs (auto:* models) accept any member of the chain', async () => {
  await withProxy(guarded, (model, res) => ok(res, model, { 'x-routed-via': 'groq/llama-3.3-70b' }), async ({ send, seen }) => {
    const res = await send('auto:easy');
    assert.equal(res.status, 200);
    assert.equal(res.headers[MODEL_HEADER], 'groq/llama-3.3-70b');
    assert.equal(seen.length, 1);
  });
});

// --- review follow-ups ------------------------------------------------------------------

test('proxy: a chain resting after outages answers 529, not a usage limit', async () => {
  await withProxy({ id: 'free-coding', models: ['a', 'b'] }, (model, res) => fail(res, 503, '{"error":"down"}'), async ({ send, seen }) => {
    assert.equal((await send()).status, 503);
    seen.length = 0;
    const res = await send();
    assert.equal(res.status, 529);
    assert.equal(JSON.parse(res.body).error.type, 'overloaded_error');
    assert.equal(seen.length, 0);
  });
});

test('proxy: a key-level 429 with a wait past one window is a model limit, not a retry loop', async () => {
  await withProxy({ id: 'free-coding', models: ['a', 'b'] }, (model, res) => (
    model === 'a' ? fail(res, 429, '{"error":{"message":"daily quota"}}', { 'retry-after': '3600' }) : ok(res, model)
  ), async ({ send, seen, proxy, clock }) => {
    assert.equal((await send()).status, 200);
    assert.deepEqual(seen.map((s) => s.model), ['a', 'b']);
    assert.equal(proxy.cooldowns.get('a'), clock.now() + 60 * MIN);
  });
});

test('proxy: requests arriving during a re-probe wait for it instead of probing too', async () => {
  const chain = { id: 'free-coding', models: ['a', 'b'] };
  let open = false;
  await withProxy(chain, (model, res) => (open ? ok(res, model) : fail(res, 429, EXHAUSTED(null))), async ({ send, seen, clock }) => {
    assert.equal((await send()).status, 429);
    clock.t = NOW + 31 * MIN;
    open = true;
    seen.length = 0;
    const answers = await Promise.all([send(), send(), send()]);
    assert.deepEqual(answers.map((r) => r.status), [200, 200, 200]);
    assert.equal(seen.filter((s) => s.model === 'a').length, 3, 'one probe, then the open chain');
    assert.equal(seen.length, 3);
  });
});

test('pacer: a client that hung up while queued gives its slot back', async () => {
  const clock = fakeClock();
  const pacer = new RequestPacer({ now: clock.now, sleep: clock.sleep, minGapMs: 1000 });
  assert.equal(await pacer.acquire(), true);
  assert.equal(await pacer.acquire(() => true), false);
  assert.equal(pacer.sent.length, 1);
  // A reset header far in the future is held to one window.
  pacer.observe({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.ceil((NOW + 86_400_000) / 1000)) });
  assert.ok(pacer.delayMs() <= 60_000);
});
