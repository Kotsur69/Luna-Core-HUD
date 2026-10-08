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
    assert.deepEqual(listed.json.result.tools.map((t) => t.name), ['luna_todo_add', 'luna_todo_list', 'luna_todo_update']);

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

test('intakeState tells a tools-attached claude from a bare one and from a shell', () => {
  const cmd = 'claude --model opus';
  assert.equal(intakeState(cmd, withIntakeMcp(cmd, 'C:/cfg.json')), 'ready');
  assert.equal(intakeState(cmd, withIntakeMcp(cmd, null)), 'off');
  const strict = 'claude --strict-mcp-config';
  assert.equal(intakeState(strict, withIntakeMcp(strict, 'C:/cfg.json')), 'off');
  assert.equal(intakeState('pwsh', withIntakeMcp('pwsh', 'C:/cfg.json')), 'none');
});
