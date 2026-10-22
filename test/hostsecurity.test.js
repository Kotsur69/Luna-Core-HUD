// ============================================================================
// LunaCore - host security M1 + M2 (docs/REMOTE_HOST_PLAN.md "Security review")
// ----------------------------------------------------------------------------
// M1: every secret shape is masked (src/hostscrub.js) before host_events /
// host_commands writes, tool results are capped at 1 KB, a finished chat.*
// command loses its payload. M2: a phone chat only runs in a folder under the
// repos root or the host-local allow-list, with symlinks / junctions resolved
// (src/hostrepos.js chatDirOf), and the refusal reaches the phone.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');

const { scrub, scrubDeep, MASK } = require('../src/hostscrub');
const { createHostEvents, storedData, cleanCard, parseEvent, RESULT_BYTES } = require('../src/hostevents');
const { createHostCommands } = require('../src/hostcommands');
const { createHostRepos, readChatDirs, isInside } = require('../src/hostrepos');
const { createHostChat, toolPreview } = require('../src/hostchat');

const SID = '11111111-2222-4333-8444-555555555555';

// ---- M1: the scrubber ------------------------------------------------------

test('scrub masks an sk- API key', () => {
  const out = scrub('key is sk-ant-api03-AbCdEfGhIjKlMnOpQrSt_uv here');
  assert.equal(out, `key is sk-${MASK} here`);
});

test('scrub masks GitHub classic and fine-grained tokens', () => {
  assert.equal(scrub('ghp_abcdefghijklmnopqrstuvwxyz0123456789'), `ghp_${MASK}`);
  assert.equal(scrub('gho_abcdefghijklmnopqrstuvwxyz0123'), `gho_${MASK}`);
  assert.equal(scrub('github_pat_11ABCDEFG0123456789_abcdefghijklmnop'), `github_pat_${MASK}`);
});

test('scrub masks AWS access key ids', () => {
  assert.equal(scrub('aws AKIAIOSFODNN7EXAMPLE end'), `aws AKIA${MASK} end`);
});

test('scrub masks a whole PEM key block, and one cut off before its END line', () => {
  const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA\nabc==\n-----END RSA PRIVATE KEY-----';
  assert.equal(scrub(`before\n${pem}\nafter`), 'before\n[redacted private key]\nafter');
  const cut = scrub('x\n-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXkt');
  assert.equal(cut, 'x\n[redacted private key]');
});

test('scrub masks NAME=value lines with KEY / TOKEN / SECRET / PASSWORD names, any case', () => {
  const env = ['OPENAI_API_KEY=abc123', 'github_token = "t0ken value"', 'AWS_SECRET_ACCESS_KEY=xyz', 'export DB_Password=hunter2', "SECRET='s3'"].join('\n');
  assert.equal(
    scrub(env),
    [`OPENAI_API_KEY=${MASK}`, `github_token = ${MASK}`, `AWS_SECRET_ACCESS_KEY=${MASK}`, `export DB_Password=${MASK}`, `SECRET=${MASK}`].join('\n'),
  );
});

test('scrub leaves non-secret text untouched', () => {
  const plain = [
    'npm test passed: 184 files',
    'monkey=banana',
    'const key = map.get(id);',
    'NODE_ENV=production',
    'task-runner sk-short',
    'see https://github.com/Kotsur69/Luna-Core-HUD',
  ].join('\n');
  assert.equal(scrub(plain), plain);
  assert.equal(scrub(''), '');
  assert.equal(scrub(null), null);
});

test('scrub is idempotent, even on a mask cut by a clip', () => {
  const once = scrub('API_KEY=abc sk-AAAAAAAAAAAAAAAAAAAA');
  assert.equal(scrub(once), once);
  assert.equal(scrub('API_KEY=[reda'), 'API_KEY=[reda');
});

test('scrubDeep masks strings in nested objects and arrays without touching the input', () => {
  const input = { a: 'TOKEN=x', b: [{ c: 'ghp_abcdefghijklmnopqrstuvwxyz0123' }], n: 3 };
  const out = scrubDeep(input);
  assert.deepEqual(out, { a: `TOKEN=${MASK}`, b: [{ c: `ghp_${MASK}` }], n: 3 });
  assert.equal(input.a, 'TOKEN=x');
});

// ---- M1: host_events writes --------------------------------------------------

function fakeEventsClient() {
  const rows = [];
  return { rows, from: () => ({ insert: async (row) => (rows.push(row), { error: null }) }) };
}

test('every host_events insert is scrubbed: prompt, text, tool, tool_result, permission', async () => {
  const client = fakeEventsClient();
  const ev = createHostEvents({ client, host: 'PC', log: () => {}, setTimer: () => 0, clearTimer: () => {} });
  ev.emit(SID, 'prompt', { text: 'use sk-AAAAAAAAAAAAAAAAAAAAAA' });
  ev.emit(SID, 'tool', { id: 't1', name: 'Bash', summary: 'GH_TOKEN=abc gh pr list' });
  ev.emit(SID, 'tool_result', { id: 't1', text: 'DB_PASSWORD=hunter2', isError: false, clipped: false });
  ev.emit(SID, 'permission', { requestId: 'r1', tool: 'Write', summary: '.env', preview: '+ SECRET=s3' });
  ev.text(SID, 'here: AKIAIOSFODNN7EXAMPLE');
  await ev.flush(SID);
  await ev.idle();
  const all = JSON.stringify(client.rows);
  for (const leak of ['sk-AAAA', 'abc gh', 'hunter2', 's3', 'IOSFODNN7']) assert.ok(!all.includes(leak), leak);
  assert.equal(client.rows.length, 5);
});

test('a stored tool result is capped at about 1 KB', () => {
  const d = storedData('tool_result', { id: 't', text: 'x'.repeat(4000), isError: false, clipped: false });
  assert.ok(Buffer.byteLength(d.text) <= RESULT_BYTES + 64);
  assert.equal(d.clipped, true);
  const small = storedData('tool_result', { id: 't', text: 'ok', isError: false, clipped: false });
  assert.deepEqual(small, { id: 't', text: 'ok', isError: false, clipped: false });
});

test('the host card equals the scrubbed row the phone reads back', () => {
  const raw = { requestId: 'r1', tool: 'Write', summary: '.env', preview: toolPreview('Write', { content: 'API_KEY=abc\n'.repeat(500) }) };
  const card = cleanCard(raw);
  assert.ok(!card.preview.includes('abc'));
  const row = { session_id: SID, seq: 0, host: 'PC', kind: 'permission', data: storedData('permission', card), at: new Date().toISOString() };
  const back = parseEvent(row).data;
  for (const k of ['tool', 'summary', 'preview']) assert.equal(back[k], card[k], k);
});

// ---- M1: host_commands writes ---------------------------------------------

const NOW = 1_800_000_000_000;

function commandsClient(rows) {
  const table = rows.map((r) => ({ ...r }));
  function query() {
    const q = { op: 'select', patch: null, returning: false, filters: [] };
    const run = () => {
      const hits = table.filter((r) => q.filters.every(([c, v]) => r[c] === v));
      if (q.op === 'update') {
        hits.forEach((r) => Object.assign(r, q.patch));
        return { data: q.returning ? hits.map((r) => ({ id: r.id })) : null, error: null };
      }
      return { data: hits.map((r) => ({ ...r })), error: null };
    };
    const api = {
      select() {
        if (q.op === 'update') q.returning = true;
        return api;
      },
      update(patch) {
        q.op = 'update';
        q.patch = patch;
        return api;
      },
      eq(c, v) {
        q.filters.push([c, v]);
        return api;
      },
      lt: () => api,
      order: () => api,
      limit: () => api,
      then: (res, rej) => Promise.resolve().then(run).then(res, rej),
    };
    return api;
  }
  return { table, from: () => query(), channel: () => ({ on() { return this; }, subscribe() { return this; } }), removeChannel() {} };
}

function commandRow(kind, payload) {
  return {
    id: `c-${kind}`,
    host: 'PC',
    kind,
    payload,
    nonce: 'nonce-123456',
    expires_at: new Date(NOW + 60000).toISOString(),
    sig: 'sig',
    status: 'new',
    result: null,
    created_at: new Date(NOW).toISOString(),
  };
}

async function runCommands(rows, handlers) {
  const client = commandsClient(rows);
  const loop = createHostCommands({ client, host: 'PC', verify: async () => ({ ok: true }), handlers, now: () => NOW, setTimer: () => 0, clearTimer: () => {}, log: () => {} });
  loop.start();
  await loop.read();
  loop.stop();
  return client.table;
}

test('a finished chat.* command loses its payload; other kinds keep theirs', async () => {
  const table = await runCommands(
    [commandRow('chat.start', { repoId: 'luna', prompt: 'my password is hunter2' }), commandRow('git.fetchAll', { all: true })],
    { 'chat.start': async () => ({ status: 'started' }), 'git.fetchAll': async () => ({ fetched: 1 }) },
  );
  const chat = table.find((r) => r.kind === 'chat.start');
  assert.equal(chat.status, 'done');
  assert.deepEqual(chat.payload, {});
  assert.deepEqual(table.find((r) => r.kind === 'git.fetchAll').payload, { all: true });
});

test('a refused or failed chat.* command loses its payload too', async () => {
  const table = await runCommands(
    [commandRow('chat.send', { text: 'x' }), commandRow('chat.end', { sessionId: SID })],
    { 'chat.end': async () => { throw new Error('boom'); } },
  );
  assert.equal(table[0].status, 'refused');
  assert.deepEqual(table[0].payload, {});
  assert.equal(table[1].status, 'failed');
  assert.deepEqual(table[1].payload, {});
});

test('a command result is scrubbed before it is written', async () => {
  const table = await runCommands([commandRow('git.fetchAll', {})], { 'git.fetchAll': async () => ({ log: 'remote: GITHUB_TOKEN=abc123' }) });
  assert.deepEqual(table[0].result, { log: `remote: GITHUB_TOKEN=${MASK}` });
});

// ---- M2: repo ids resolve only under the repos root ---------------------------

function tmpTree() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-hostsec-'));
  const root = path.join(base, 'repos');
  const outside = path.join(base, 'elsewhere');
  fs.mkdirSync(path.join(root, 'luna'), { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  return { base, root, outside, done: () => fs.rmSync(base, { recursive: true, force: true }) };
}

const reposFor = (root, chatDirs = () => []) => createHostRepos({ execFile: () => {}, reposRoot: root, chatDirs, log: () => {} });

test('a normal repo under the root is accepted', (t) => {
  const tree = tmpTree();
  t.after(tree.done);
  const r = reposFor(tree.root).chatDirOf({ id: 'luna', path: path.join(tree.root, 'luna') });
  assert.equal(r.dir, fs.realpathSync(path.join(tree.root, 'luna')));
});

test('a synced path outside the root is refused', (t) => {
  const tree = tmpTree();
  t.after(tree.done);
  const repos = reposFor(tree.root);
  assert.deepEqual(repos.chatDirOf({ id: 'x', path: tree.outside }), { error: 'refused: repo outside the repos root' });
  assert.deepEqual(repos.chatDirOf({ id: 'x', path: path.join(tree.root, '..', 'elsewhere') }), { error: 'refused: repo outside the repos root' });
  assert.deepEqual(repos.chatDirOf({ id: 'x', path: tree.root }), { error: 'refused: repo outside the repos root' }, 'the root itself is no repo');
});

test('a symlink / junction under the root pointing outside is refused', (t) => {
  const tree = tmpTree();
  t.after(tree.done);
  const link = path.join(tree.root, 'sneaky');
  fs.symlinkSync(tree.outside, link, process.platform === 'win32' ? 'junction' : 'dir');
  assert.deepEqual(reposFor(tree.root).chatDirOf({ id: 's', path: link }), { error: 'refused: repo outside the repos root' });
});

test('a folder on the host-local allow-list is accepted', (t) => {
  const tree = tmpTree();
  t.after(tree.done);
  const r = reposFor(tree.root, () => [tree.outside]).chatDirOf({ id: 'x', path: tree.outside });
  assert.equal(r.dir, fs.realpathSync(tree.outside));
});

test('a missing project folder is an unknown repo', () => {
  const r = reposFor(path.join(os.tmpdir(), 'no-such-root')).chatDirOf({ id: 'x', path: path.join(os.tmpdir(), 'no-such-dir-lc') });
  assert.deepEqual(r, { error: 'refused: unknown repo' });
});

test('readChatDirs keeps only absolute strings; isInside rejects .. escapes', () => {
  const abs = path.resolve('/a/b');
  assert.deepEqual(readChatDirs({ chatDirs: [abs, 'rel/dir', 3] }), [abs]);
  assert.deepEqual(readChatDirs(null), []);
  assert.equal(isInside(path.resolve('/r'), path.resolve('/r/x'), false), true);
  assert.equal(isInside(path.resolve('/r'), path.resolve('/rx'), false), false);
  assert.equal(isInside(path.resolve('/r'), path.resolve('/r'), false), false);
});

test('chat.start on a repo outside the root is refused with the reason, nothing spawned', async () => {
  const spawns = [];
  const host = createHostChat({
    spawn: (...a) => {
      spawns.push(a);
      const c = new EventEmitter();
      c.stdout = new PassThrough();
      return c;
    },
    repoDir: () => ({ error: 'refused: repo outside the repos root' }),
    claudePath: () => 'claude',
    env: () => ({}),
    events: { text() {}, emit() {}, forget() {} },
    randomUUID: () => SID,
    log: () => {},
  });
  const res = await host.handlers['chat.start']({ repoId: 'luna', prompt: 'go' });
  assert.deepEqual(res, { status: 'refused: repo outside the repos root' });
  assert.equal(spawns.length, 0);
});
