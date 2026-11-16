// Tests for the intake MCP server in Antigravity (agy) tabs (src/agyintake.js).
// agy reads MCP servers only from ~/.gemini/config/mcp_config.json, a file the
// user owns: what matters is that a tab's entry lands there in agy's format,
// carries exactly the tab's own (possibly scoped) token, authenticates against
// the real intake server, never disturbs the user's other entries, and leaves
// again with the tab. Every file here lives in a fresh temp folder.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const {
  AGY_SERVER_PREFIX,
  agyMcpConfigPath,
  agyServerName,
  intakeEntryFrom,
  readAgyConfig,
  addAgyServer,
  removeAgyServer,
  createAgyIntake,
} = require('../src/agyintake');
const { IntakeServer, writeSessionConfig } = require('../src/intake');
const { writeGodModeConfig } = require('../src/orchestraFollowupsLaunch');

const URL = 'http://127.0.0.1:41234/mcp';
// Fake intake tokens, assembled at runtime (32 bytes of hex, like issueToken's).
const tokenOf = (pair) => pair.repeat(32);
const TOKEN_A = tokenOf('0a');
const TOKEN_B = tokenOf('0b');
const entryOf = (token, url = URL) => ({ url, headers: { Authorization: `Bearer ${token}` } });

const USER_CONFIG = {
  mcpServers: {
    'sqlite-helper': { command: 'sqlite-mcp-server', args: ['/db.sqlite'], env: { DB_READONLY: 'true' } },
    remote: { url: 'https://mcp.example.com/mcp', headers: { 'X-Team': 'blue' }, disabled: true },
  },
  someOtherSetting: { keep: [1, 2, 3] },
};

/** A temp folder removed after the test, and agy's config path inside it. */
function tempConfig(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-agy-intake-'));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 5 }));
  return { dir, file: agyMcpConfigPath(dir) };
}

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const writeJson = (file, doc) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(doc), 'utf8');
};

// ---- names and paths ---------------------------------------------------------

test('agy config path and server names', () => {
  assert.equal(agyMcpConfigPath('/home/x'), path.join('/home/x', '.gemini', 'config', 'mcp_config.json'));
  assert.equal(AGY_SERVER_PREFIX, 'lunacore-');
  assert.equal(agyServerName('s3'), 'lunacore-s3');
  for (const bad of ['', 's 3', 's/3', '../x', 'a'.repeat(65), null, 3, undefined]) {
    assert.equal(agyServerName(bad), null, String(bad));
  }
});

// ---- the tab's entry ----------------------------------------------------------

test('intakeEntryFrom copies url + bearer header from a tab config, dropping claude-only keys', (t) => {
  const { dir } = tempConfig(t);
  const file = writeSessionConfig(dir, 's1', URL, TOKEN_A);
  assert.ok(file);
  assert.deepEqual(intakeEntryFrom(file), entryOf(TOKEN_A));
  assert.equal(intakeEntryFrom(null), null);
  assert.equal(intakeEntryFrom(''), null);
});

test('intakeEntryFrom refuses anything but a loopback intake server with an intake token', (t) => {
  const { dir } = tempConfig(t);
  const cases = {
    'not loopback': { type: 'http', url: 'http://evil.example/mcp', headers: { Authorization: `Bearer ${TOKEN_A}` } },
    'other path': { type: 'http', url: 'http://127.0.0.1:41234/other', headers: { Authorization: `Bearer ${TOKEN_A}` } },
    'https': { type: 'http', url: 'https://127.0.0.1:41234/mcp', headers: { Authorization: `Bearer ${TOKEN_A}` } },
    'no header': { type: 'http', url: URL },
    'short token': { type: 'http', url: URL, headers: { Authorization: 'Bearer abc' } },
    'header injection': { type: 'http', url: URL, headers: { Authorization: `Bearer ${TOKEN_A}\r\nX: y` } },
  };
  for (const [name, server] of Object.entries(cases)) {
    const file = path.join(dir, `${name.replace(/ /g, '-')}.json`);
    writeJson(file, { mcpServers: { lunacore: server } });
    assert.equal(intakeEntryFrom(file), null, name);
  }
  const other = path.join(dir, 'other.json');
  writeJson(other, { mcpServers: { playwright: { command: 'npx' } } });
  assert.equal(intakeEntryFrom(other), null, 'no lunacore server');
  assert.throws(() => intakeEntryFrom(path.join(dir, 'missing.json')), /ENOENT/);
});

// ---- add / remove ----------------------------------------------------------------

test('addAgyServer creates the folder and file when agy has none yet', (t) => {
  const { file } = tempConfig(t);
  assert.deepEqual(addAgyServer({ file, sessionId: 's1', entry: entryOf(TOKEN_A) }), { ok: true, name: 'lunacore-s1' });
  assert.deepEqual(readJson(file), { mcpServers: { 'lunacore-s1': entryOf(TOKEN_A) } });
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['mcp_config.json'], 'no temp file left behind');
});

test("addAgyServer keeps every other server and setting of the user's file", (t) => {
  const { file } = tempConfig(t);
  writeJson(file, USER_CONFIG);
  assert.equal(addAgyServer({ file, sessionId: 's1', entry: entryOf(TOKEN_A) }).ok, true);
  assert.equal(addAgyServer({ file, sessionId: 's2', entry: entryOf(TOKEN_B) }).ok, true);
  const doc = readJson(file);
  assert.deepEqual(doc.someOtherSetting, USER_CONFIG.someOtherSetting);
  assert.deepEqual(doc.mcpServers['sqlite-helper'], USER_CONFIG.mcpServers['sqlite-helper']);
  assert.deepEqual(doc.mcpServers.remote, USER_CONFIG.mcpServers.remote);
  assert.deepEqual(doc.mcpServers['lunacore-s1'], entryOf(TOKEN_A));
  assert.deepEqual(doc.mcpServers['lunacore-s2'], entryOf(TOKEN_B));
});

test('addAgyServer never rewrites a file that is not plain JSON or not the expected shape', (t) => {
  const { file } = tempConfig(t);
  const cases = {
    notPlainJson: '{\n  // my servers\n  "mcpServers": { "x": { "command": "y" }, },\n}\n',
    unexpectedShape: '{ "mcpServers": [] }',
  };
  for (const [error, text] of Object.entries(cases)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text, 'utf8');
    assert.deepEqual(addAgyServer({ file, sessionId: 's1', entry: entryOf(TOKEN_A) }), { ok: false, error });
    assert.equal(fs.readFileSync(file, 'utf8'), text, `${error}: the file is untouched`);
  }
  for (const text of ['[]', 'null', '"x"']) {
    fs.writeFileSync(file, text, 'utf8');
    assert.equal(addAgyServer({ file, sessionId: 's1', entry: entryOf(TOKEN_A) }).ok, false, text);
    assert.equal(fs.readFileSync(file, 'utf8'), text);
  }
});

test('an empty agy config counts as no servers yet', (t) => {
  const { file } = tempConfig(t);
  writeJson(file, {});
  fs.writeFileSync(file, '  \n', 'utf8');
  assert.deepEqual(readAgyConfig(file), { ok: true, doc: {} });
  assert.equal(addAgyServer({ file, sessionId: 's1', entry: entryOf(TOKEN_A) }).ok, true);
});

test('addAgyServer refuses a session id that is not LunaCore shaped', (t) => {
  const { file } = tempConfig(t);
  assert.deepEqual(addAgyServer({ file, sessionId: '../x', entry: entryOf(TOKEN_A) }), { ok: false, error: 'badSessionId' });
  assert.equal(fs.existsSync(file), false);
});

test('a failed rename leaves the original file and no temp file', (t) => {
  const { file } = tempConfig(t);
  writeJson(file, USER_CONFIG);
  const before = fs.readFileSync(file, 'utf8');
  const fsImpl = { ...fs, renameSync: () => { throw Object.assign(new Error('busy'), { code: 'EBUSY' }); } };
  const res = addAgyServer({ file, sessionId: 's1', entry: entryOf(TOKEN_A), fsImpl });
  assert.equal(res.ok, false);
  assert.match(res.error, /^notWritten \(EBUSY\)/);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['mcp_config.json']);
});

test('removeAgyServer removes the entry only while it still carries our token', (t) => {
  const { file } = tempConfig(t);
  writeJson(file, USER_CONFIG);
  addAgyServer({ file, sessionId: 's1', entry: entryOf(TOKEN_B) });
  // An older launch (token A) exits after a newer one (token B) took the name.
  assert.deepEqual(removeAgyServer({ file, sessionId: 's1', entry: entryOf(TOKEN_A) }), { ok: true, removed: false });
  assert.deepEqual(readJson(file).mcpServers['lunacore-s1'], entryOf(TOKEN_B));
  assert.deepEqual(removeAgyServer({ file, sessionId: 's1', entry: entryOf(TOKEN_B) }), { ok: true, removed: true });
  assert.deepEqual(readJson(file), USER_CONFIG, "back to exactly the user's file");
  assert.deepEqual(removeAgyServer({ file, sessionId: 's1', entry: entryOf(TOKEN_B) }), { ok: true, removed: false });
});

// ---- createAgyIntake: a tab's lifecycle -----------------------------------------------

test('createAgyIntake registers a tab, replaces it on restart and removes it on exit', (t) => {
  const { dir, file } = tempConfig(t);
  writeJson(file, USER_CONFIG);
  const lines = [];
  const agy = createAgyIntake({ file, log: (line) => lines.push(line) });

  const first = writeSessionConfig(dir, 's1', URL, TOKEN_A);
  assert.equal(agy.register('s1', first), 'lunacore-s1');
  assert.equal(agy.has('s1'), true);
  assert.deepEqual(readJson(file).mcpServers['lunacore-s1'], entryOf(TOKEN_A));

  // A restarted tab gets a new token: the entry follows it.
  const second = writeSessionConfig(dir, 's1', URL, TOKEN_B);
  assert.equal(agy.register('s1', second), 'lunacore-s1');
  assert.deepEqual(readJson(file).mcpServers['lunacore-s1'], entryOf(TOKEN_B));

  agy.unregister('s1');
  assert.equal(agy.has('s1'), false);
  assert.deepEqual(readJson(file), USER_CONFIG);
  agy.unregister('s1'); // a second exit is a no-op
  agy.unregister('never-registered');
  assert.deepEqual(lines, []);
});

test('createAgyIntake: no config, a bad config or an unwritable agy file means no tools, logged without the token', (t) => {
  const { dir, file } = tempConfig(t);
  const lines = [];
  const agy = createAgyIntake({ file, log: (line) => lines.push(line) });
  assert.equal(agy.register('s1', null), null, 'tools off: nothing to copy');
  assert.equal(agy.register('s1', path.join(dir, 'missing.json')), null);
  const foreign = path.join(dir, 'foreign.json');
  writeJson(foreign, { mcpServers: { lunacore: { url: 'http://evil.example/mcp', headers: { Authorization: `Bearer ${TOKEN_A}` } } } });
  assert.equal(agy.register('s1', foreign), null);

  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{ /* mine */ }', 'utf8');
  assert.equal(agy.register('s1', writeSessionConfig(dir, 's1', URL, TOKEN_A)), null);
  assert.equal(fs.readFileSync(file, 'utf8'), '{ /* mine */ }');
  assert.equal(agy.has('s1'), false);

  assert.equal(lines.length, 3);
  assert.match(lines[2], /notPlainJson/);
  for (const line of lines) assert.equal(line.includes(TOKEN_A), false, 'a log line never carries the token');
});

test('a removal that fails is retried by the next unregister and by unregisterAll', (t) => {
  const { dir, file } = tempConfig(t);
  writeJson(file, USER_CONFIG);
  const lines = [];
  // agy holding its file: every rename fails while `busy`.
  let busy = false;
  const fsImpl = {
    ...fs,
    renameSync: (from, to) => {
      if (busy) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
      return fs.renameSync(from, to);
    },
  };
  const agy = createAgyIntake({ file, fsImpl, log: (line) => lines.push(line) });
  assert.equal(agy.register('s1', writeSessionConfig(dir, 's1', URL, TOKEN_A)), 'lunacore-s1');

  busy = true;
  agy.unregister('s1');
  assert.equal(agy.has('s1'), true, 'kept after a failed removal');
  assert.deepEqual(readJson(file).mcpServers['lunacore-s1'], entryOf(TOKEN_A));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /entry not removed .*EBUSY/);

  busy = false;
  agy.unregisterAll();
  assert.equal(agy.has('s1'), false);
  assert.deepEqual(readJson(file), USER_CONFIG, 'removed on the retry');
  for (const line of lines) assert.equal(line.includes(TOKEN_A), false, 'a log line never carries the token');
});

test('a corrupt tab config is logged by error class only, never with its text', (t) => {
  const { dir, file } = tempConfig(t);
  const lines = [];
  const agy = createAgyIntake({ file, log: (line) => lines.push(line) });
  const corrupt = path.join(dir, 'corrupt.json');
  fs.writeFileSync(corrupt, `{"mcpServers":{"lunacore":{"headers":{"Authorization":"Bearer ${TOKEN_A}"`, 'utf8');
  assert.equal(agy.register('s1', corrupt), null);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /unreadable \(SyntaxError\)/);
  assert.equal(lines[0].includes(TOKEN_A), false);
});

test("writes land in the config's resolved path (fs.realpathSync), never over the link itself", (t) => {
  const { dir, file } = tempConfig(t);
  const target = path.join(dir, 'dotfiles', 'mcp_config.json');
  // Stands in for a symlink where creating one needs Developer Mode.
  writeJson(file, USER_CONFIG);
  writeJson(target, USER_CONFIG);
  const linkText = fs.readFileSync(file, 'utf8');
  const fsImpl = { ...fs, realpathSync: (p) => (p === file ? target : fs.realpathSync(p)) };
  assert.equal(addAgyServer({ file, sessionId: 's1', entry: entryOf(TOKEN_A), fsImpl }).ok, true);
  assert.equal(fs.readFileSync(file, 'utf8'), linkText, 'the link path is not replaced');
  assert.deepEqual(readJson(target).mcpServers['lunacore-s1'], entryOf(TOKEN_A));
  assert.deepEqual(fs.readdirSync(path.dirname(target)), ['mcp_config.json'], 'no temp file left behind');
});

test('a symlinked agy config is written through to its target; the link survives', (t) => {
  const { dir, file } = tempConfig(t);
  const target = path.join(dir, 'dotfiles', 'mcp_config.json');
  writeJson(target, USER_CONFIG);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    fs.symlinkSync(target, file, 'file');
  } catch (err) {
    // Windows without Developer Mode cannot create symlinks.
    t.skip(`symlinks unavailable here (${err.code})`);
    return;
  }
  assert.equal(addAgyServer({ file, sessionId: 's1', entry: entryOf(TOKEN_A) }).ok, true);
  assert.equal(fs.lstatSync(file).isSymbolicLink(), true, 'still a link');
  assert.deepEqual(readJson(target).mcpServers['lunacore-s1'], entryOf(TOKEN_A));
  assert.equal(removeAgyServer({ file, sessionId: 's1', entry: entryOf(TOKEN_A) }).removed, true);
  assert.equal(fs.lstatSync(file).isSymbolicLink(), true);
  assert.deepEqual(readJson(target), USER_CONFIG);
});

test('createAgyIntake.unregisterAll removes every entry it wrote and nothing else', (t) => {
  const { dir, file } = tempConfig(t);
  writeJson(file, USER_CONFIG);
  const agy = createAgyIntake({ file });
  agy.register('s1', writeSessionConfig(dir, 's1', URL, TOKEN_A));
  agy.register('s2', writeSessionConfig(dir, 's2', URL, TOKEN_B));
  assert.equal(Object.keys(readJson(file).mcpServers).length, 4);
  agy.unregisterAll();
  assert.deepEqual(readJson(file), USER_CONFIG);
});

// ---- real intake server: the entry as agy will use it --------------------------------

function post(url, headers, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null') }));
    });
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

const listTools = { jsonrpc: '2.0', id: 1, method: 'tools/list' };

test("the agy entry authenticates against the real intake server with the tab's own token", async (t) => {
  const { dir, file } = tempConfig(t);
  const store = { read: () => [], write: () => true };
  const server = new IntakeServer({ storeFor: (id) => (id === 's1' ? store : null) });
  const started = await server.start();
  assert.equal(started.ok, true);
  t.after(() => server.stop());

  const agy = createAgyIntake({ file });
  const name = agy.register('s1', writeSessionConfig(dir, 's1', server.url(), server.issueToken('s1')));
  const entry = readJson(file).mcpServers[name];
  const listed = await post(entry.url, entry.headers, listTools);
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.json.result.tools.map((tool) => tool.name), ['luna_todo_add', 'luna_todo_list', 'luna_todo_update', 'luna_todo_done']);

  // The tab closes: main revokes the token and the entry leaves agy's config.
  server.revoke('s1');
  agy.unregister('s1');
  assert.equal(readJson(file).mcpServers[name], undefined);
  assert.equal((await post(entry.url, entry.headers, listTools)).status, 401, 'a copied entry outlives nothing');
});

test("a God Mode agy worker's entry carries its scoped token, not a full one", async (t) => {
  const { dir, file } = tempConfig(t);
  const store = { read: () => [], write: () => true };
  const server = new IntakeServer({ storeFor: () => store });
  await server.start();
  t.after(() => server.stop());

  const task = { briefPath: 'C:/t/b.md', godMode: { runId: 'run1', packageId: 'pkg-a', followups: false } };
  const config = writeGodModeConfig({ dir, sessionId: 's7', url: server.url(), server, task });
  assert.ok(config, 'God Mode config written');
  const agy = createAgyIntake({ file });
  const name = agy.register('s7', config);
  assert.equal(name, 'lunacore-s7');
  const entry = readJson(file).mcpServers[name];
  const listed = await post(entry.url, entry.headers, listTools);
  assert.equal(listed.status, 200);
  // Scope 'godmode' (follow-ups off): no to-do tool at all, exactly as for a Claude worker.
  assert.deepEqual(listed.json.result.tools, []);
});
