// Tests for the task-intake MCP server (src/intake.js): the pure tool logic,
// the JSON-RPC dispatcher, and one real loopback round trip per boundary
// (host, origin, token, method) against an in-memory store.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

const {
  applyAdd,
  applyUpdate,
  applyDone,
  listView,
  freshAts,
  handleRpc,
  bearerToken,
  mcpConfigFor,
  IntakeServer,
  MAX_TASKS_PER_CALL,
  PROTOCOL_VERSIONS,
  TOOLS,
} = require('../src/intake.js');
const { normalizeTodo, MAX_ITEMS } = require('../src/todo.js');
const { withIntakeMcp, intakeState } = require('../src/launch.js');

const NOW = 1_800_000_000_000;

function memoryStore(initial = []) {
  let list = initial;
  return {
    read: () => list,
    write: (next) => {
      list = next;
      return true;
    },
    now: () => NOW,
    get list() {
      return list;
    },
  };
}

// ---- todo.js card fields -----------------------------------------------------

test('normalizeTodo keeps valid card fields and drops invalid ones', () => {
  const card = normalizeTodo({
    text: 'Fix drag',
    details: '  do it  ',
    acceptance: ['works', '', 7],
    files: ['src/a.js'],
    verify: 'npm test',
    size: 'XL',
    model: 'opus',
    dependsOn: [1, '2', 1],
    junk: true,
  });
  assert.deepEqual(card, {
    text: 'Fix drag',
    done: false,
    at: 0,
    details: 'do it',
    acceptance: ['works'],
    files: ['src/a.js'],
    verify: 'npm test',
    model: 'opus',
    dependsOn: [1],
  });
});

test('normalizeTodo adds no keys to a plain item', () => {
  assert.deepEqual(Object.keys(normalizeTodo({ text: 'a', dependsOn: [] })), ['text', 'done', 'at']);
});

// ---- applyAdd ------------------------------------------------------------------

test('applyAdd appends cards with fresh, unique ats and never mutates', () => {
  const list = [{ text: 'old', done: false, at: NOW + 5 }];
  const out = applyAdd(list, [{ text: 'a' }, { text: 'b', size: 'S' }], NOW);
  assert.equal(out.ok, true);
  assert.equal(list.length, 1);
  assert.deepEqual(out.added.map((c) => c.at), [NOW + 6, NOW + 7]);
  assert.equal(out.list.length, 3);
  assert.equal(out.added[1].size, 'S');
});

test('applyAdd resolves batch-index and existing-at dependencies', () => {
  const list = [{ text: 'old', done: false, at: 42 }];
  const out = applyAdd(list, [{ text: 'a' }, { text: 'b', dependsOn: [0, 42] }], NOW);
  assert.equal(out.ok, true);
  assert.deepEqual(out.added[1].dependsOn, [out.added[0].at, 42]);
});

test('applyAdd rejects bad input with a message', () => {
  assert.equal(applyAdd([], [], NOW).ok, false);
  assert.equal(applyAdd([], 'x', NOW).ok, false);
  assert.match(applyAdd([], [{ text: ' ' }], NOW).error, /text/);
  assert.match(applyAdd([], [{ text: 'a', dependsOn: [0] }], NOW).error, /itself/);
  assert.match(applyAdd([], [{ text: 'a', dependsOn: [999] }], NOW).error, /no card/);
  const many = Array.from({ length: MAX_TASKS_PER_CALL + 1 }, () => ({ text: 'x' }));
  assert.match(applyAdd([], many, NOW).error, /at most/);
  const full = Array.from({ length: MAX_ITEMS }, (_v, i) => ({ text: 'x', done: false, at: i }));
  assert.match(applyAdd(full, [{ text: 'y' }], NOW).error, /at most/);
});

test('freshAts never goes below now', () => {
  assert.deepEqual(freshAts([], 2, 10), [10, 11]);
});

// ---- applyUpdate ---------------------------------------------------------------

test('applyUpdate patches fields, removes nulls, keeps done and at', () => {
  const list = [
    { text: 'a', done: true, at: 1, details: 'x', size: 'S' },
    { text: 'b', done: false, at: 2 },
  ];
  const out = applyUpdate(list, 1, { text: 'A', details: null, verify: 'npm test', done: false, at: 9, dependsOn: [2] });
  assert.equal(out.ok, true);
  assert.deepEqual(out.card, { text: 'A', done: true, at: 1, verify: 'npm test', size: 'S', dependsOn: [2] });
  assert.equal(list[0].text, 'a');
});

test('applyUpdate rejects unknown cards and dangling dependencies', () => {
  const list = [{ text: 'a', done: false, at: 1 }];
  assert.equal(applyUpdate(list, 7, {}).ok, false);
  assert.equal(applyUpdate(list, 1, { dependsOn: [1] }).ok, false);
  assert.equal(applyUpdate(list, 1, { text: '' }).ok, false);
  assert.equal(applyUpdate(list, '1', {}).ok, false);
});

test('applyUpdate sets original once and never overwrites or removes it', () => {
  const list = [{ text: 'loose note', done: false, at: 1 }];
  const first = applyUpdate(list, 1, { text: 'Real title', details: 'd', original: 'loose note' });
  assert.equal(first.ok, true);
  assert.equal(first.card.original, 'loose note');

  const again = applyUpdate(first.list, 1, { original: 'something else' });
  assert.equal(again.ok, true);
  assert.equal(again.card.original, 'loose note');

  const cleared = applyUpdate(first.list, 1, { original: null });
  assert.equal(cleared.card.original, 'loose note');
});

test('luna_todo_update advertises the original field', () => {
  const update = TOOLS.find((tool) => tool.name === 'luna_todo_update');
  assert.ok(update.inputSchema.properties.patch.properties.original);
});

test('listView hides done items unless asked', () => {
  const list = [{ text: 'a', done: true, at: 1 }, { text: 'b', done: false, at: 2 }];
  assert.equal(listView(list).length, 1);
  assert.equal(listView(list, true).length, 2);
});

// ---- handleRpc -----------------------------------------------------------------

test('handleRpc initialize echoes a supported protocol version', () => {
  const r = handleRpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } }, memoryStore());
  assert.equal(r.result.protocolVersion, '2025-03-26');
  const r2 = handleRpc({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '1999' } }, memoryStore());
  assert.equal(r2.result.protocolVersion, PROTOCOL_VERSIONS[0]);
});

test('handleRpc ignores notifications and rejects junk', () => {
  assert.equal(handleRpc({ jsonrpc: '2.0', method: 'notifications/initialized' }, memoryStore()), null);
  assert.equal(handleRpc({ id: 1 }, memoryStore()).error.code, -32600);
  assert.equal(handleRpc({ jsonrpc: '2.0', id: 1, method: 'nope' }, memoryStore()).error.code, -32601);
  const unknownTool = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'rm_rf' } };
  assert.equal(handleRpc(unknownTool, memoryStore()).error.code, -32602);
});

test('handleRpc tools/call writes through the store', () => {
  const store = memoryStore();
  const call = (name, args) =>
    handleRpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, store).result;
  const added = call('luna_todo_add', { tasks: [{ text: 'card', files: ['a.js'] }] });
  assert.equal(added.isError, undefined);
  assert.equal(store.list.length, 1);
  const listed = JSON.parse(call('luna_todo_list', {}).content[0].text);
  assert.equal(listed[0].files[0], 'a.js');
  const bad = call('luna_todo_update', { at: 1, patch: {} });
  assert.equal(bad.isError, true);
});

test('bearerToken parses only a Bearer header', () => {
  assert.equal(bearerToken('Bearer abc'), 'abc');
  assert.equal(bearerToken('Basic abc'), null);
  assert.equal(bearerToken(undefined), null);
});

test('mcpConfigFor builds an http server entry with the token header', () => {
  const cfg = mcpConfigFor('http://127.0.0.1:1/mcp', 't');
  assert.deepEqual(cfg.mcpServers.lunacore, {
    type: 'http',
    url: 'http://127.0.0.1:1/mcp',
    headers: { Authorization: 'Bearer t' },
  });
});

// ---- withIntakeMcp -------------------------------------------------------------

test('withIntakeMcp appends the flag to plain claude launches only', () => {
  assert.equal(withIntakeMcp('claude --model opus', 'C:\\x\\a.json'), "claude --model opus --mcp-config 'C:\\x\\a.json'");
  assert.equal(withIntakeMcp('claude.exe', '/a.json'), "claude.exe --mcp-config '/a.json'");
  assert.equal(withIntakeMcp('codex', '/a.json'), 'codex');
  assert.equal(withIntakeMcp('claude --strict-mcp-config --mcp-config x', '/a.json'), 'claude --strict-mcp-config --mcp-config x');
  assert.equal(withIntakeMcp('claude', "/it's.json"), 'claude');
  assert.equal(withIntakeMcp('claude', null), 'claude');
  assert.equal(withIntakeMcp('', '/a.json'), '');
});

// ---- IntakeServer over a real loopback socket ---------------------------------

function post(port, { path = '/mcp', headers = {}, body, method = 'POST' }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode, json: text ? JSON.parse(text) : null });
      });
    });
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

test('IntakeServer enforces token, host, origin and method; serves tools', async () => {
  const store = memoryStore();
  const server = new IntakeServer({ storeFor: (id) => (id === 's1' ? store : null), version: '1.0.0' });
  const started = await server.start();
  assert.equal(started.ok, true);
  const { port } = server;
  try {
    const token = server.issueToken('s1');
    const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    const listMsg = { jsonrpc: '2.0', id: 1, method: 'tools/list' };

    assert.equal((await post(port, { headers: {}, body: listMsg })).status, 401);
    assert.equal((await post(port, { headers: { authorization: 'Bearer nope' }, body: listMsg })).status, 401);
    assert.equal((await post(port, { headers: { ...auth, origin: 'http://evil' }, body: listMsg })).status, 403);
    assert.equal((await post(port, { headers: { ...auth, host: 'evil:1' }, body: listMsg })).status, 403);
    assert.equal((await post(port, { path: '/other', headers: auth, body: listMsg })).status, 403);
    assert.equal((await post(port, { method: 'GET', headers: auth })).status, 405);

    const listed = await post(port, { headers: auth, body: listMsg });
    assert.equal(listed.status, 200);
    assert.deepEqual(listed.json.result.tools.map((t) => t.name), ['luna_todo_add', 'luna_todo_list', 'luna_todo_update', 'luna_todo_done']);

    const note = await post(port, { headers: auth, body: { jsonrpc: '2.0', method: 'notifications/initialized' } });
    assert.equal(note.status, 202);

    const add = { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'luna_todo_add', arguments: { tasks: [{ text: 'x' }] } } };
    assert.equal((await post(port, { headers: auth, body: add })).status, 200);
    assert.equal(store.list.length, 1);

    // A restarted tab gets a new token; the old one stops working.
    server.issueToken('s1');
    assert.equal((await post(port, { headers: auth, body: listMsg })).status, 401);
  } finally {
    await server.stop();
  }
});

test('IntakeServer waits for an asynchronous memory search, alone and in a batch', async () => {
  const memory = { project: null, get: () => null, search: () => new Promise((resolve) => setTimeout(() => resolve([]), 20)) };
  const store = { ...memoryStore(), memory };
  const server = new IntakeServer({ storeFor: () => store, version: '1.0.0' });
  await server.start();
  try {
    const auth = { authorization: `Bearer ${server.issueToken('s1')}`, 'content-type': 'application/json' };
    const search = { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'memory_search', arguments: { query: 'anything' } } };

    const single = await post(server.port, { headers: auth, body: search });
    const batch = await post(server.port, { headers: auth, body: [{ jsonrpc: '2.0', id: 4, method: 'ping' }, search] });

    assert.equal(single.status, 200);
    assert.deepEqual(JSON.parse(single.json.result.content[0].text).results, []);
    assert.deepEqual(
      batch.json.map((r) => r.id),
      [4, 5],
    );

    const flood = await post(server.port, { headers: auth, body: Array.from({ length: 51 }, () => search) });
    assert.equal(flood.status, 400);
  } finally {
    await server.stop();
  }
});

// ---- scoped tokens (God Mode follow-up channel, src/orchestraFollowups.js) ----------

const { createFollowupChannel, createFollowupLedger } = require('../src/orchestraFollowups.js');

const WORKER_SCOPE = { scope: 'worker', runId: 'pabc123', packageId: 'auth-flow' };
const rpcCall = (id, name, args) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
const toolBody = (reply) => reply.json.result;

async function scopedServer(store, scopeOpts = WORKER_SCOPE) {
  const ledger = createFollowupLedger();
  const server = new IntakeServer({ storeFor: () => store, version: '1.0.0', channel: createFollowupChannel({ ledger }) });
  await server.start();
  const auth = { authorization: `Bearer ${server.issueToken('s7', scopeOpts)}`, 'content-type': 'application/json' };
  return { server, auth, ledger };
}

test('a worker-scoped token lists only luna_todo_add and luna_todo_list', async () => {
  const { server, auth } = await scopedServer(memoryStore());
  try {
    const listed = await post(server.port, { headers: auth, body: { jsonrpc: '2.0', id: 1, method: 'tools/list' } });
    assert.deepEqual(listed.json.result.tools.map((t) => t.name), ['luna_todo_add', 'luna_todo_list']);
    const add = listed.json.result.tools[0];
    assert.deepEqual(add.inputSchema.properties.tasks.items.required, ['text', 'kind']);
    assert.equal('tags' in add.inputSchema.properties.tasks.items.properties, false, 'tags are the server\'s call');
  } finally {
    await server.stop();
  }
});

test('a worker-scoped token is refused update, done, memory and asset tools with a clear error', async () => {
  const card = normalizeTodo({ text: 'existing', done: false, at: 5 });
  const store = memoryStore([card]);
  const { server, auth } = await scopedServer(store);
  try {
    for (const [name, args] of [
      ['luna_todo_update', { at: 5, patch: { text: 'hijacked' } }],
      ['luna_todo_done', { at: 5 }],
      ['memory_search', { query: 'x' }],
      ['memory_get', { key: 'x' }],
      ['luna_asset_search', { query: 'x' }],
    ]) {
      const reply = await post(server.port, { headers: auth, body: rpcCall(2, name, args) });
      assert.equal(reply.status, 200);
      assert.equal(toolBody(reply).isError, true, name);
      assert.match(toolBody(reply).content[0].text, /not available to God Mode sessions/, name);
    }
    assert.deepEqual(store.list, [card], 'nothing changed');
  } finally {
    await server.stop();
  }
});

test('a scoped token keeps exactly the memory tools its session store grants', async () => {
  const memory = { project: null, get: () => null, search: () => [] };
  const { server, auth } = await scopedServer({ ...memoryStore(), memory });
  try {
    const listed = await post(server.port, { headers: auth, body: { jsonrpc: '2.0', id: 1, method: 'tools/list' } });
    const names = listed.json.result.tools.map((t) => t.name);
    assert.deepEqual(names.slice(0, 2), ['luna_todo_add', 'luna_todo_list']);
    assert.ok(names.includes('memory_search'));
    assert.ok(!names.includes('luna_todo_update') && !names.includes('luna_todo_done'));
  } finally {
    await server.stop();
  }
});

test('a godmode-scoped token (followups off) has no to-do tool at all', async () => {
  const store = memoryStore();
  const { server, auth } = await scopedServer(store, { ...WORKER_SCOPE, scope: 'godmode' });
  try {
    const listed = await post(server.port, { headers: auth, body: { jsonrpc: '2.0', id: 1, method: 'tools/list' } });
    assert.deepEqual(listed.json.result.tools, []);
    const add = await post(server.port, { headers: auth, body: rpcCall(2, 'luna_todo_add', { tasks: [{ text: 'x', kind: 'bug' }] }) });
    assert.equal(toolBody(add).isError, true);
    assert.equal(store.list.length, 0);
  } finally {
    await server.stop();
  }
});

test('a scoped token without a channel fails closed', async () => {
  const store = memoryStore();
  const server = new IntakeServer({ storeFor: () => store });
  await server.start();
  try {
    const auth = { authorization: `Bearer ${server.issueToken('s1', WORKER_SCOPE)}`, 'content-type': 'application/json' };
    const listed = await post(server.port, { headers: auth, body: { jsonrpc: '2.0', id: 1, method: 'tools/list' } });
    assert.deepEqual(listed.json.result.tools, []);
    const add = await post(server.port, { headers: auth, body: rpcCall(2, 'luna_todo_add', { tasks: [{ text: 'x', kind: 'bug' }] }) });
    assert.equal(toolBody(add).isError, true);
    assert.equal(store.list.length, 0);
  } finally {
    await server.stop();
  }
});

test('issueToken refuses invalid scope options and issues nothing', () => {
  const server = new IntakeServer({ storeFor: () => null });
  assert.throws(() => server.issueToken('s1', { scope: 'admin', runId: 'p1', packageId: 'a' }), TypeError);
  assert.throws(() => server.issueToken('s1', { scope: 'worker', runId: '../x', packageId: 'a' }), TypeError);
  assert.throws(() => server.issueToken('s1', { scope: 'worker', runId: 'p1', packageId: '' }), TypeError);
  assert.equal(server.tokens.size, 0);
});

test('revokeScoped drops only the matching run + package token; revokeRun drops a whole run', () => {
  const server = new IntakeServer({ storeFor: () => null });
  server.issueToken('s1', WORKER_SCOPE);
  server.issueToken('s2', { ...WORKER_SCOPE, packageId: 'data-model' });
  server.issueToken('s3');
  server.issueToken('s4', { ...WORKER_SCOPE, runId: 'pother' });
  assert.equal(server.revokeScoped('s1', { runId: 'pabc123', packageId: 'data-model' }), 0, 'another package of the run');
  assert.equal(server.revokeScoped('s3', { runId: 'pabc123', packageId: 'auth-flow' }), 0, 'a full-scope tab is never touched');
  assert.equal(server.revokeScoped('s1', { runId: 'pabc123', packageId: 'auth-flow' }), 1);
  assert.equal(server.revokeRun('pabc123'), 1);
  assert.deepEqual([...server.tokens.values()].map((e) => e.sessionId).sort(), ['s3', 's4']);
});

test('intakeState tells a tools-attached claude from a bare one and from a shell', () => {
  const cmd = 'claude --model opus';
  assert.equal(intakeState(cmd, withIntakeMcp(cmd, 'C:/cfg.json')), 'ready');
  assert.equal(intakeState(cmd, withIntakeMcp(cmd, null)), 'off');
  const strict = 'claude --strict-mcp-config';
  assert.equal(intakeState(strict, withIntakeMcp(strict, 'C:/cfg.json')), 'off');
  assert.equal(intakeState('pwsh', withIntakeMcp('pwsh', 'C:/cfg.json')), 'none');
});

// ---- tags --------------------------------------------------------------------------

const callList = (store, args) =>
  JSON.parse(handleRpc({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'luna_todo_list', arguments: args } }, store).result.content[0].text);

test('luna_todo_add accepts tags and returns them normalized', () => {
  const out = applyAdd([], [{ text: 'a', tags: ['Steer', 'run:r1', 'bad tag', 'steer'] }], NOW);
  assert.equal(out.ok, true);
  assert.deepEqual(out.added[0].tags, ['steer', 'run:r1']);
});

test('luna_todo_update replaces tags, and null removes them', () => {
  const list = applyAdd([], [{ text: 'a', tags: ['x'] }], NOW).list;
  const at = list[0].at;
  const set = applyUpdate(list, at, { tags: ['steer'] });
  assert.deepEqual(set.card.tags, ['steer']);
  const cleared = applyUpdate(set.list, at, { tags: null });
  assert.equal('tags' in cleared.card, false);
});

test('luna_todo_list filters by tag (open only unless includeDone)', () => {
  const list = [
    { text: 'steer open', done: false, at: 1, tags: ['steer'] },
    { text: 'steer done', done: true, at: 2, tags: ['steer'] },
    { text: 'run card', done: false, at: 3, tags: ['run:r1'] },
    { text: 'plain', done: false, at: 4 },
  ];
  assert.deepEqual(listView(list, false, 'steer').map((x) => x.text), ['steer open']);
  assert.deepEqual(listView(list, true, 'STEER').map((x) => x.text), ['steer open', 'steer done']);
  assert.deepEqual(listView(list, false, '').map((x) => x.text), ['steer open', 'run card', 'plain']);
  assert.deepEqual(callList(memoryStore(list), { tag: 'run:r1' }).map((x) => x.at), [3]);
});

// ---- luna_todo_done ----------------------------------------------------------------

test('applyDone ticks with doneAt, reopens without it, never mutates', () => {
  const list = [{ text: 'a', done: false, at: 1 }, { text: 'b', done: false, at: 2 }];
  const ticked = applyDone(list, 1, undefined, NOW);
  assert.equal(ticked.ok, true);
  assert.deepEqual(ticked.card, { text: 'a', done: true, at: 1, doneAt: NOW });
  assert.equal(list[0].done, false);
  assert.equal(ticked.list[1], list[1]);
  const reopened = applyDone(ticked.list, 1, false, NOW + 1);
  assert.deepEqual(reopened.card, { text: 'a', done: false, at: 1 });
});

test('applyDone rejects bad input', () => {
  const list = [{ text: 'a', done: false, at: 1 }];
  assert.equal(applyDone(list, '1', true, NOW).ok, false);
  assert.equal(applyDone(list, 1, 'yes', NOW).ok, false);
  assert.match(applyDone(list, 9, true, NOW).error, /no card/);
});

test('luna_todo_done needs canMarkDone (God Mode workers are refused)', () => {
  const call = (store, args) =>
    handleRpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'luna_todo_done', arguments: args } }, store).result;
  const worker = memoryStore([{ text: 'a', done: false, at: 1 }]);
  const refused = call(worker, { at: 1 });
  assert.equal(refused.isError, true);
  assert.equal(worker.list[0].done, false);

  const own = { ...memoryStore([{ text: 'a', done: false, at: 1 }]), canMarkDone: true };
  let saved = null;
  own.write = (next) => {
    saved = next;
    return true;
  };
  const ok = call(own, { at: 1 });
  assert.equal(ok.isError, undefined);
  assert.equal(JSON.parse(ok.content[0].text).ticked.done, true);
  assert.equal(saved[0].doneAt, NOW);
});

test('tool schemas advertise tags and the list tag filter', () => {
  const byName = Object.fromEntries(TOOLS.map((tool) => [tool.name, tool]));
  assert.ok(byName.luna_todo_add.inputSchema.properties.tasks.items.properties.tags);
  assert.ok(byName.luna_todo_update.inputSchema.properties.patch.properties.tags);
  assert.equal(byName.luna_todo_list.inputSchema.properties.tag.type, 'string');
});

// ---- POST /recall (auto-recall's UserPromptSubmit hook, src/memoryrecall.js) --------

const { recallRequestOf, recallReply, RECALL_HOOK_EVENT, MAX_RECALL_CONTEXT_CHARS } = require('../src/intake.js');

const HOOK_INPUT = { session_id: 'abc', transcript_path: '/t.jsonl', cwd: '/repo', hook_event_name: 'UserPromptSubmit', prompt: 'Why does the install hang?' };

/** A server whose tab s1 recalls through `recall` (absent = recall off for the tab). */
async function recallServer(recall) {
  const asked = [];
  const store = { ...memoryStore() };
  if (recall) {
    store.recall = (prompt) => {
      asked.push(prompt);
      return recall(prompt);
    };
  }
  const server = new IntakeServer({ storeFor: (id) => (id === 's1' ? store : null), version: '1.0.0', channel: createFollowupChannel({ ledger: createFollowupLedger() }) });
  await server.start();
  const auth = { authorization: `Bearer ${server.issueToken('s1')}`, 'content-type': 'application/json' };
  return { server, auth, asked };
}

test('recallRequestOf takes the prompt of a UserPromptSubmit hook input and refuses anything else', () => {
  assert.deepEqual(recallRequestOf(HOOK_INPUT), { ok: true, prompt: HOOK_INPUT.prompt });
  assert.deepEqual(recallRequestOf({ prompt: 'no event name is fine' }), { ok: true, prompt: 'no event name is fine' });
  assert.equal(recallRequestOf({ prompt: 'x'.repeat(20000) }).prompt.length, 8000);
  for (const bad of [null, [], 'text', { ...HOOK_INPUT, hook_event_name: 'Stop' }, { ...HOOK_INPUT, prompt: 42 }, { hook_event_name: RECALL_HOOK_EVENT }]) {
    assert.equal(recallRequestOf(bad).ok, false, JSON.stringify(bad));
  }
});

test('recallReply is the hook output with the text as additionalContext, or nothing', () => {
  assert.deepEqual(recallReply({ text: 'memory' }), { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'memory' } });
  assert.equal(recallReply({ text: 'x'.repeat(10000) }).hookSpecificOutput.additionalContext.length, MAX_RECALL_CONTEXT_CHARS);
  for (const none of [null, {}, { text: null }, { text: '' }, { keys: [] }]) assert.deepEqual(recallReply(none), {});
});

test('/recall needs the tab token, the local host, no origin and POST; a scoped token is refused', async () => {
  const { server, auth } = await recallServer(async () => ({ text: 'memory' }));
  try {
    const port = server.port;
    assert.equal(server.recallUrl(), `http://127.0.0.1:${port}/recall`);
    const send = (headers) => post(port, { path: '/recall', headers, body: HOOK_INPUT });

    const none = await send({ 'content-type': 'application/json' });
    assert.equal(none.status, 401);
    assert.deepEqual(none.json, { error: 'Unauthorized' });
    assert.equal((await send({ authorization: 'Bearer nope' })).status, 401);
    assert.equal((await send({ ...auth, origin: 'http://evil' })).status, 403);
    assert.equal((await send({ ...auth, host: 'evil:1' })).status, 403);
    assert.equal((await post(port, { path: '/recall', method: 'GET', headers: auth })).status, 405);
    assert.equal((await post(port, { path: '/recall/x', headers: auth, body: HOOK_INPUT })).status, 403);

    const scoped = { authorization: `Bearer ${server.issueToken('s1', WORKER_SCOPE)}`, 'content-type': 'application/json' };
    assert.equal((await send(scoped)).status, 403);
  } finally {
    await server.stop();
  }
});

test('/recall validates its body: bad JSON, a wrong shape and a body past the cap are refused', async () => {
  const { server, auth, asked } = await recallServer(async () => ({ text: 'memory' }));
  try {
    const port = server.port;
    const raw = (text) =>
      new Promise((resolve) => {
        const req = http.request({ host: '127.0.0.1', port, path: '/recall', method: 'POST', headers: auth }, (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode));
        });
        // The server may close the socket on an oversized body before it is all sent.
        req.on('error', () => resolve('closed'));
        req.end(text);
      });

    assert.equal(await raw('{not json'), 400);
    assert.equal((await post(port, { path: '/recall', headers: auth, body: { ...HOOK_INPUT, hook_event_name: 'PreToolUse' } })).status, 400);
    assert.equal((await post(port, { path: '/recall', headers: auth, body: { prompt: 1 } })).status, 400);
    assert.ok([413, 'closed'].includes(await raw(JSON.stringify({ prompt: 'x'.repeat(300 * 1024) }))));
    assert.deepEqual(asked, []);
  } finally {
    await server.stop();
  }
});

test('/recall answers the hook output, {} without memories, and {} when recall is off or fails', async (t) => {
  const hit = await recallServer(async () => ({ keys: ['github.com/acme/hud/a'], text: '## Luna Core Memory\n- a memory' }));
  try {
    const res = await post(hit.server.port, { path: '/recall', headers: hit.auth, body: HOOK_INPUT });
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: '## Luna Core Memory\n- a memory' } });
    assert.deepEqual(hit.asked, [HOOK_INPUT.prompt]);
  } finally {
    await hit.server.stop();
  }

  for (const recall of [async () => null, async () => ({ keys: [], text: null }), undefined]) {
    const s = await recallServer(recall);
    try {
      const res = await post(s.server.port, { path: '/recall', headers: s.auth, body: HOOK_INPUT });
      assert.equal(res.status, 200);
      assert.deepEqual(res.json, {});
    } finally {
      await s.server.stop();
    }
  }

  const quiet = t.mock.method(console, 'error', () => {});
  const failing = await recallServer(async () => {
    throw new Error('vector store gone');
  });
  try {
    const res = await post(failing.server.port, { path: '/recall', headers: failing.auth, body: HOOK_INPUT });
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, {});
    assert.equal(quiet.mock.callCount(), 1);
  } finally {
    await failing.server.stop();
  }
});
