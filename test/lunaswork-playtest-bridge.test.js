// ============================================================================
// Luna's Work Playtester bridge (helpers/playtest-bridge): the tool argument
// checks, the token-guarded loopback control channel (a real server on
// 127.0.0.1), the in-process Electron driver on fake Electron objects, the
// Unity MCP HTTP client on a fake fetch, and the stdio MCP message handling.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const T = require('../helpers/playtest-bridge/tools.js');
const C = require('../helpers/playtest-bridge/control.js');
const W = require('../helpers/playtest-bridge/electron-wrapper.js');
const H = require('../helpers/playtest-bridge/mcp-http.js');
const B = require('../helpers/playtest-bridge/bridge.js');
const UN = require('../helpers/playtest-bridge/unity.js');
const P = require('../helpers/playtest-bridge/pipeline-http.js');

const tmpDir = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('fake image')]);

// ---- tool argument checks -----------------------------------------------------------

test('checkArgs accepts the narrow tool shapes and normalizes them', () => {
  assert.deepEqual(T.checkArgs('electron', 'screenshot', { name: 'home-wide' }), { ok: true, args: { name: 'home-wide.png' } });
  assert.equal(T.checkArgs('electron', 'click', { name: 'Save' }).ok, true);
  assert.equal(T.checkArgs('electron', 'press_key', { key: 'N', modifiers: ['cmdorctrl', 'shift'] }).ok, true);
  assert.equal(T.checkArgs('electron', 'resize_window', { width: 1024, height: 700 }).ok, true);
  assert.equal(T.checkArgs('electron', 'click_menu', { labels: ['File', 'New'] }).ok, true);
  assert.equal(T.checkArgs('unity', 'send_input', { steps: [{ type: 'axis', name: 'Horizontal', value: -1, holdMs: 200 }] }).ok, true);
});

test('checkArgs refuses unknown tools and out-of-range or unsafe arguments', () => {
  const bad = [
    ['electron', 'evaluate', { script: '1' }],
    ['electron', 'browser_navigate', { url: 'file:///C:/' }],
    ['electron', 'click', {}],
    ['electron', 'screenshot', { name: '../x' }],
    ['electron', 'screenshot', { name: 'a/b' }],
    ['electron', 'screenshot', { name: 'CON' }],
    ['electron', 'screenshot', { name: 'nul.png' }],
    ['unity', 'screenshot', { name: 'com1.final' }],
    ['electron', 'press_key', { key: 'N', modifiers: ['hyper'] }],
    ['electron', 'press_key', { key: 'rm -rf' }],
    ['electron', 'resize_window', { width: 50, height: 700 }],
    ['electron', 'resize_window', { width: 1024.5, height: 700 }],
    ['electron', 'wait_for_text', { text: 'x', timeoutMs: T.MAX_WAIT_MS + 1 }],
    ['electron', 'click_menu', { labels: [] }],
    ['electron', 'click_menu', { labels: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] }],
    ['unity', 'send_input', { steps: [] }],
    ['unity', 'send_input', { steps: Array.from({ length: 51 }, () => ({ type: 'wait', ms: 1 })) }],
    ['unity', 'send_input', { steps: [{ type: 'reflect', name: 'File.Delete' }] }],
    ['unity', 'wait', { ms: T.MAX_WAIT_MS + 1 }],
    ['unity', 'click', { name: 'x' }],
    ['ssh', 'screenshot', { name: 'x' }],
  ];
  for (const [backend, tool, args] of bad) {
    assert.equal(T.checkArgs(backend, tool, args).ok, false, `${backend} ${tool} ${JSON.stringify(args)}`);
  }
  // Prototype keys are not tools.
  assert.equal(T.checkArgs('electron', '__proto__', {}).ok, false);
  assert.equal(T.checkArgs('electron', 'constructor', {}).ok, false);
});

// ---- control channel ----------------------------------------------------------------

async function listening(handle, token = C.newToken()) {
  const server = C.createControlServer({ token, handle });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, token, port: server.address().port };
}

test('the control channel answers only with the per-run token', async () => {
  const calls = [];
  const { server, token, port } = await listening(async (tool, args) => {
    calls.push([tool, args]);
    if (tool === 'boom') throw new Error('window is gone');
    return { windows: [] };
  });
  try {
    assert.match(token, /^[a-f0-9]{64}$/);
    assert.deepEqual(await C.callControl({ port, token }, 'list_windows', { a: 1 }), { windows: [] });
    await assert.rejects(C.callControl({ port, token: C.newToken() }, 'list_windows'), /unauthorized/);
    await assert.rejects(C.callControl({ port, token: '' }, 'list_windows'), /unauthorized/);
    await assert.rejects(C.callControl({ port, token }, 'boom'), /window is gone/);
    await assert.rejects(C.callControl({ port, token }, 'x', { big: 'y'.repeat(C.MAX_BODY_BYTES) }), /too large|ECONNRESET|socket hang up|EPIPE/);
    await assert.rejects(C.callControl({ port: 0, token }, 'x'), /no control port/);
    assert.deepEqual(calls, [['list_windows', { a: 1 }], ['boom', {}]], 'refused calls never reach the app');
  } finally {
    server.close();
  }
});

test('the control server refuses to start without a proper token', () => {
  for (const token of [undefined, '', 'short', 'Z'.repeat(64)]) {
    assert.throws(() => C.createControlServer({ token, handle: () => null }), /hex token/);
  }
  assert.equal(C.tokenMatches('abc', 'abc'), false, 'a malformed token never matches');
});

// ---- Electron driver (in-process wrapper) -------------------------------------------

function fakeWindow(id) {
  const wc = new EventEmitter();
  Object.assign(wc, {
    events: [],
    inserted: [],
    scripts: [],
    sendInputEvent: (e) => wc.events.push(e),
    insertText: (t) => wc.inserted.push(t),
    devToolsClosed: 0,
    closeDevTools: () => {
      wc.devToolsClosed += 1;
    },
    focus: () => {},
    invalidate: () => {},
    capturePage: async () => ({ isEmpty: () => false, getSize: () => ({ width: 800, height: 600 }), toPNG: () => PNG }),
    executeJavaScript: async (script) => {
      wc.scripts.push(script);
      return script.includes('getBoundingClientRect') ? { x: 10, y: 20, tag: 'button', label: 'save' } : { title: 'App', text: 'Hello Save' };
    },
  });
  const w = {
    id,
    webContents: wc,
    size: [800, 600],
    isDestroyed: () => false,
    getTitle: () => `Window ${id}`,
    getContentBounds: () => ({ x: 0, y: 0, width: w.size[0], height: w.size[1] }),
    isFocused: () => id === 1,
    isVisible: () => true,
    isMinimized: () => false,
    restore: () => {},
    isFullScreen: () => false,
    setFullScreen: () => {},
    isMaximized: () => false,
    unmaximize: () => {},
    setContentSize: (width, height) => {
      w.size = [width, height];
    },
  };
  return w;
}

function fakeElectron() {
  const windows = [fakeWindow(1), fakeWindow(2)];
  const clicked = [];
  const menu = {
    items: [
      {
        label: '&File',
        submenu: {
          items: [
            { label: 'New', accelerator: 'CmdOrCtrl+N', click: () => clicked.push('New') },
            { type: 'separator' },
            { label: 'Quit', accelerator: 'CmdOrCtrl+Q', enabled: false, click: () => clicked.push('Quit') },
          ],
        },
      },
      {
        label: 'View',
        submenu: {
          items: [
            { label: 'Reload', role: 'reload', accelerator: 'CmdOrCtrl+R', click: () => clicked.push('Reload') },
            { label: 'Toggle Developer Tools', role: 'toggleDevTools', accelerator: 'CmdOrCtrl+Shift+I', click: () => clicked.push('DevTools') },
            { label: 'Inspect Element', accelerator: 'F12', click: () => clicked.push('Inspect') },
          ],
        },
      },
    ],
  };
  const app = { quit: () => clicked.push('app.quit') };
  const driver = W.createDriver({
    app,
    BrowserWindow: { getAllWindows: () => windows, getFocusedWindow: () => windows[0] },
    Menu: { getApplicationMenu: () => menu },
    platform: 'win32',
    delay: async () => {},
    now: () => 0,
  });
  return { windows, clicked, driver };
}

test('driver: windows, real mouse clicks by accessible name, typing, resize', async () => {
  const { windows, driver } = fakeElectron();
  const listed = await driver.call('list_windows', {});
  assert.deepEqual(listed.windows.map((w) => [w.id, w.title, w.focused]), [[1, 'Window 1', true], [2, 'Window 2', false]]);

  const wc = windows[0].webContents;
  assert.deepEqual(await driver.call('click', { name: 'Save' }), { clicked: 'save', x: 10, y: 20 });
  assert.deepEqual(wc.events.map((e) => e.type), ['mouseMove', 'mouseDown', 'mouseUp']);

  wc.events.length = 0;
  await driver.call('type_text', { text: 'hello', submit: true });
  assert.deepEqual(wc.inserted, ['hello']);
  assert.deepEqual(wc.events.map((e) => `${e.type}:${e.keyCode}`), ['keyDown:Enter', 'keyUp:Enter']);

  await driver.call('resize_window', { width: 1024, height: 700, windowId: 2 });
  assert.deepEqual(windows[1].size, [1024, 700]);

  const shot = await driver.call('screenshot', { name: 'x', windowId: 2 });
  assert.equal(shot.png, PNG.toString('base64'));
  assert.equal(shot.windowId, 2);
});

test('driver: shortcuts fire the application menu, other keys go to the page', async () => {
  const { windows, clicked, driver } = fakeElectron();
  assert.deepEqual(await driver.call('press_key', { key: 'N', modifiers: ['control'] }), { menuItem: 'New' });
  assert.deepEqual(clicked, ['New']);
  assert.equal(windows[0].webContents.events.length, 0, 'a menu accelerator is not sent as raw keys');

  await driver.call('press_key', { key: 'a' });
  assert.deepEqual(windows[0].webContents.events.map((e) => e.type), ['keyDown', 'char', 'keyUp']);

  const menu = await driver.call('list_menu', {});
  assert.equal(menu.menu[0].label, 'File');
  assert.deepEqual(menu.menu[0].submenu.map((i) => [i.label, i.enabled]), [['New', true], ['Quit', false]]);
  await driver.call('click_menu', { labels: ['File', 'New'] });
  assert.deepEqual(clicked, ['New', 'New']);
  await assert.rejects(driver.call('click_menu', { labels: ['File', 'Quit'] }), /disabled/);
  await assert.rejects(driver.call('click_menu', { labels: ['Edit'] }), /no menu item/);
});

test('driver: console errors from both console-message signatures, crashes and failed loads', async () => {
  const { windows, driver } = fakeElectron();
  const wc = windows[0].webContents;
  driver.attach(wc);
  wc.emit('console-message', { level: 'error', message: 'new boom', sourceId: 'app.js', lineNumber: 3 });
  wc.emit('console-message', {}, 3, 'old boom', 7, 'old.js');
  wc.emit('console-message', { level: 'info', message: 'not an error' });
  wc.emit('render-process-gone', {}, { reason: 'crashed' });
  wc.emit('did-fail-load', {}, -6, 'ERR_FILE_NOT_FOUND', 'file:///x', true);

  const { errors } = await driver.call('console_errors', { clear: true });
  assert.deepEqual(errors.map((e) => e.source), ['console', 'console', 'crash', 'load']);
  assert.match(errors[0].message, /new boom \(app\.js:3\)/);
  assert.match(errors[1].message, /old boom \(old\.js:7\)/);
  assert.deepEqual((await driver.call('console_errors', {})).errors, []);
});

test('driver: no tool runs caller code, and quit is the only extra call', async () => {
  const { windows, clicked, driver } = fakeElectron();
  for (const tool of ['executeJavaScript', 'eval', 'require', 'readFile', 'openExternal', 'loadURL']) {
    await assert.rejects(driver.call(tool, { code: 'process.exit()' }), /unknown tool/, tool);
  }
  // A hostile selector stays a string literal inside the fixed script.
  const hostile = "a'); require('child_process').exec('calc'); ('";
  await driver.call('click', { selector: hostile });
  const script = windows[0].webContents.scripts.at(-1);
  assert.ok(script.includes(JSON.stringify(hostile)));
  assert.doesNotThrow(() => new Function(`return ${script}`));

  await driver.call('quit', {});
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(clicked, ['app.quit']);
});

test('driver: developer tools are off limits - hidden, refused, and closed if the app opens them', async () => {
  const { windows, clicked, driver } = fakeElectron();
  const view = (await driver.call('list_menu', {})).menu.find((m) => m.label === 'View');
  assert.deepEqual(view.submenu.map((i) => i.label), ['Reload'], 'devtools items are not even listed');

  await assert.rejects(driver.call('click_menu', { labels: ['View', 'Toggle Developer Tools'] }), /no menu item/);
  await assert.rejects(driver.call('click_menu', { labels: ['View', 'Inspect Element'] }), /no menu item/);
  await assert.rejects(driver.call('press_key', { key: 'I', modifiers: ['control', 'shift'] }), /off limits/);
  await assert.rejects(driver.call('press_key', { key: 'F12' }), /off limits/);
  await driver.call('click_menu', { labels: ['View', 'Reload'] });
  assert.deepEqual(clicked, ['Reload']);

  const wc = windows[0].webContents;
  driver.attach(wc);
  wc.emit('devtools-opened');
  assert.equal(wc.devToolsClosed, 1);
  assert.deepEqual((await driver.call('console_errors', {})).errors.map((e) => e.source), ['guard']);
});

test('comboKey normalizes accelerators per platform', () => {
  assert.equal(W.comboKey('CmdOrCtrl+Shift+N', 'win32'), 'control+shift|n');
  assert.equal(W.comboKey('CmdOrCtrl+Shift+N', 'darwin'), 'meta+shift|n');
  assert.equal(W.comboKey('Ctrl++', 'win32'), 'control|+');
  assert.equal(W.comboKey('Alt+Return', 'linux'), 'alt|enter');
  assert.equal(W.comboKey('', 'win32'), null);
});

test('install serves the driver on loopback after the first window loads, and hides the token', async () => {
  const { windows } = fakeElectron();
  for (const w of windows) Object.assign(w.webContents, { isLoading: () => false, getURL: () => 'file:///app/index.html' });
  const app = new EventEmitter();
  app.whenReady = async () => {};
  app.quit = () => {};
  const token = C.newToken();
  const env = { [C.TOKEN_ENV]: token };
  const lines = [];
  const server = await W.install(
    { app, BrowserWindow: { getAllWindows: () => windows, getFocusedWindow: () => windows[0] }, Menu: { getApplicationMenu: () => null } },
    { env, out: { write: (l) => lines.push(l) } },
  );
  try {
    await new Promise((resolve) => (server.listening ? resolve() : server.once('listening', resolve)));
    assert.equal(C.TOKEN_ENV in env, false, "the app's child processes do not inherit the token");
    assert.equal(server.address().address, '127.0.0.1');
    assert.ok(lines[0].startsWith(C.READY_PREFIX));
    const info = JSON.parse(lines[0].slice(C.READY_PREFIX.length));
    assert.deepEqual(info, { port: server.address().port, windows: 2 });
    const res = await C.callControl({ port: info.port, token }, 'list_windows', {});
    assert.equal(res.windows.length, 2);
  } finally {
    server.close();
  }
});

// ---- Unity MCP over HTTP --------------------------------------------------------------

function fakeFetch({ sse = true } = {}) {
  const requests = [];
  const fetch = async (url, init) => {
    const body = init.body ? JSON.parse(init.body) : null;
    requests.push({ url, method: init.method, headers: init.headers, body });
    const headers = new Map([['mcp-session-id', 'sess-1'], ['content-type', sse ? 'text/event-stream' : 'application/json']]);
    const res = (status, text) => ({ ok: status < 300, status, headers: { get: (k) => headers.get(k.toLowerCase()) || null }, text: async () => text });
    if (init.method === 'DELETE' || !body || body.id === undefined) return res(202, '');
    const result = body.method === 'initialize'
      ? { protocolVersion: H.PROTOCOL_VERSION, capabilities: {}, serverInfo: { name: 'unity' } }
      : { content: [{ type: 'text', text: JSON.stringify({ success: true, data: { isPlaying: true } }) }] };
    const msg = JSON.stringify({ jsonrpc: '2.0', id: body.id, result });
    return res(200, sse ? `event: message\ndata: ${msg}\n\n` : msg);
  };
  return { fetch, requests };
}

test('the Unity MCP client: lazy handshake, SSE or JSON replies, session header, DELETE on close', async () => {
  for (const sse of [true, false]) {
    const { fetch, requests } = fakeFetch({ sse });
    const client = H.createMcpHttpClient({ url: 'http://127.0.0.1:8080/mcp', fetch });
    assert.equal(requests.length, 0, 'no connection until the first call');

    const state = await UN.unityCall(client, UN.UNITY_MCP.state());
    assert.deepEqual(state, { isPlaying: true });
    assert.equal(UN.isPlaying(state), true);
    assert.deepEqual(requests.map((r) => r.body && r.body.method), ['initialize', 'notifications/initialized', 'tools/call']);
    assert.deepEqual(requests[2].body.params, { name: 'manage_editor', arguments: { action: 'get_state' } });
    assert.equal(requests[2].headers['mcp-session-id'], 'sess-1');

    await client.close();
    assert.deepEqual([requests.at(-1).method, requests.at(-1).headers['mcp-session-id']], ['DELETE', 'sess-1']);
  }
});

test('the Unity MCP client only talks to this machine and reports Unity errors', async () => {
  for (const url of ['http://10.0.0.2:8080/mcp', 'https://127.0.0.1/mcp', 'http://user:pw@localhost/mcp', 'not a url']) {
    assert.throws(() => H.createMcpHttpClient({ url, fetch: async () => {} }), /127\.0\.0\.1/, url);
  }
  const down = H.createMcpHttpClient({ url: 'http://localhost:8080/mcp', fetch: async () => { throw new Error('ECONNREFUSED'); } });
  await assert.rejects(down.callTool('manage_editor', {}), /not reachable .* is the editor open/);

  assert.throws(() => UN.unwrap({ content: [{ type: 'text', text: '{"success":false,"message":"Not in play mode"}' }] }), /Not in play mode/);
  assert.throws(() => UN.unwrap({ isError: true, content: [{ type: 'text', text: 'Unknown tool' }] }), /Unknown tool/);
  assert.deepEqual(H.parseSse('data: {"id":1}\n\n: keep-alive\n\ndata: {"id"'), [{ id: 1 }]);
  assert.equal(UN.isPlaying({ editor: { is_playing: true } }), true);
  assert.equal(UN.isPlaying({}), false);
});

// ---- Unity Pipeline over HTTP (official Unity MCP) ------------------------------------

// A fake bearer token, built at runtime (never a secret-shaped literal).
const PIPE_TOKEN = Buffer.from(`lunacore-test-${'q'.repeat(24)}`).toString('base64');
const PIPE_DIR = path.join(os.tmpdir(), 'lw-unity-game');
const PIPE_NOW = Date.UTC(2026, 10, 14, 12, 0, 0);
const PIPE_DESCRIPTOR = path.join(PIPE_DIR, 'Library', 'Pipeline', '.unity-pipeline-port');
const EDITOR_STATUS = { status: 'ready', compiling: false, domainReloadInProgress: false, playMode: 'playing', playerLoopTicking: true, runInBackground: true };

const jsonReply = (status, json) => ({ status, text: JSON.stringify(json) });
const okReply = (result) => jsonReply(200, { success: true, result });

/**
 * The editor's HTTP API on an injected fetch / readFile. `reply(body)` answers
 * one /api/exec request; `descriptor` is the port file (object, raw string, or
 * null = missing).
 */
function fakePipeline({ reply = () => okReply(EDITOR_STATUS), descriptor, heartbeatAgeMs = 1000, fetchError = null } = {}) {
  const requests = [];
  const reads = [];
  const desc = descriptor !== undefined ? descriptor : {
    pid: 4321, port: 7801, evalToken: PIPE_TOKEN, lastHeartbeat: new Date(PIPE_NOW - heartbeatAgeMs).toISOString(), projectPath: PIPE_DIR, endpoints: {},
  };
  const readFile = async (file) => {
    reads.push(file);
    if (desc === null) throw Object.assign(new Error(`ENOENT: no such file or directory, open '${file}'`), { code: 'ENOENT' });
    return typeof desc === 'string' ? desc : JSON.stringify(desc);
  };
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    requests.push({ url, init, body });
    if (fetchError) throw fetchError;
    const r = reply(body);
    return { ok: r.status >= 200 && r.status < 300, status: r.status, text: async () => r.text };
  };
  const client = P.createPipelineClient({ projectDir: PIPE_DIR, fetch, readFile, now: () => PIPE_NOW });
  return { client, requests, reads };
}

const leaksToken = (err) => String(err && err.message).includes(PIPE_TOKEN) || String(err && err.stack).includes(PIPE_TOKEN);

test('the Pipeline client: exec reads the port file on every request and POSTs to 127.0.0.1 with the bearer token', async () => {
  const { client, requests, reads } = fakePipeline();
  assert.equal(reads.length, 0, 'nothing is read until the first call');

  const status = await client.exec('editor status');
  assert.deepEqual(status, EDITOR_STATUS);
  assert.equal(UN.isPlaying(status), true);
  assert.equal(requests.length, 1);
  const [{ url, init, body }] = requests;
  assert.equal(url, 'http://127.0.0.1:7801/api/exec');
  assert.equal(init.method, 'POST');
  assert.equal(init.headers.authorization, `Bearer ${PIPE_TOKEN}`);
  assert.equal(init.headers['content-type'], 'application/json');
  assert.ok(!Object.keys(init.headers).some((h) => h.toLowerCase() === 'origin'), 'never an Origin header');
  assert.equal(init.redirect, 'error', 'a redirect never carries the token elsewhere');
  assert.ok(init.signal, 'every request has a timeout');
  assert.deepEqual(body, { command: 'editor status', parameters: {} });

  await UN.pipelineCall(client, UN.UNITY_PIPELINE.openScene('Assets/Scenes/Main.unity'));
  assert.deepEqual(requests[1].body, { command: 'scene open', parameters: { path: 'Assets/Scenes/Main.unity' } });
  assert.deepEqual(reads, [PIPE_DESCRIPTOR, PIPE_DESCRIPTOR], 're-read on every request: a domain reload rewrites it');
  await client.close();
});

test('the Pipeline client: a missing port file means the editor is not open (transient, nothing is sent)', async () => {
  const { client, requests } = fakePipeline({ descriptor: null });
  await assert.rejects(client.exec('editor status'), (err) => {
    assert.match(err.message, /^Unity editor not open on .*lw-unity-game, or com\.unity\.pipeline not installed$/);
    assert.equal(err.code, P.PIPELINE_ERROR.notOpen);
    assert.equal(P.isTransientPipelineError(err), true);
    return true;
  });
  assert.equal(requests.length, 0);
});

test('the Pipeline client: a heartbeat older than 60 s means the editor is gone', async () => {
  const stale = fakePipeline({ heartbeatAgeMs: P.HEARTBEAT_MAX_AGE_MS + 1000 });
  await assert.rejects(stale.client.exec('editor status'), (err) => {
    assert.match(err.message, /stopped answering: its last heartbeat is 61 s old/);
    assert.equal(err.code, P.PIPELINE_ERROR.stale);
    return true;
  });
  assert.equal(stale.requests.length, 0);
  const fresh = fakePipeline({ heartbeatAgeMs: P.HEARTBEAT_MAX_AGE_MS - 1000 });
  assert.deepEqual(await fresh.client.exec('editor status'), EDITOR_STATUS);
});

test('the Pipeline client: a broken port file is refused before anything is sent', async () => {
  const beat = new Date(PIPE_NOW).toISOString();
  const base = { pid: 1, port: 7801, evalToken: PIPE_TOKEN, lastHeartbeat: beat };
  for (const [descriptor, why] of [
    [{ ...base, port: 0 }, /no valid port/],
    [{ ...base, port: 65536 }, /no valid port/],
    [{ ...base, port: '7801' }, /no valid port/],
    [{ ...base, port: 7801.5 }, /no valid port/],
    [{ ...base, evalToken: '' }, /no valid evalToken/],
    [{ ...base, evalToken: 42 }, /no valid evalToken/],
    [{ ...base, evalToken: `${PIPE_TOKEN}\r\nX-Evil: 1` }, /no valid evalToken/],
    [{ ...base, lastHeartbeat: 'yesterday' }, /no valid lastHeartbeat/],
    [{ ...base, lastHeartbeat: undefined }, /no valid lastHeartbeat/],
    [[base], /not a JSON object/],
    [`{"evalToken":"${PIPE_TOKEN}", "port": 78`, /not valid JSON/],
  ]) {
    const { client, requests } = fakePipeline({ descriptor });
    await assert.rejects(client.exec('editor status'), (err) => {
      assert.match(err.message, why, JSON.stringify(descriptor));
      assert.equal(err.code, P.PIPELINE_ERROR.badDescriptor);
      assert.equal(leaksToken(err), false, 'the token never appears in an error');
      return true;
    });
    assert.equal(requests.length, 0);
  }
});

test('the Pipeline client: 400 Command Not Found throws error + errorDetails, capped at 500 chars', async () => {
  const notFound = fakePipeline({ reply: () => jsonReply(400, { success: false, error: 'Command Not Found', errorDetails: "No command 'playtest state'" }) });
  await assert.rejects(notFound.client.exec('playtest state'), (err) => {
    assert.equal(err.message, "Unity command 'playtest state' failed: Command Not Found - No command 'playtest state'");
    assert.equal(err.code, P.PIPELINE_ERROR.failed);
    assert.equal(err.status, 400);
    assert.equal(err.retryable, undefined);
    assert.equal(P.isTransientPipelineError(err), false, 'a missing command is not worth a retry');
    return true;
  });

  const long = fakePipeline({ reply: () => jsonReply(200, { success: false, error: 'Boom', errorDetails: { trace: 'x'.repeat(2000) } }) });
  await assert.rejects(long.client.exec('editor status'), (err) => {
    const prefix = "Unity command 'editor status' failed: ";
    assert.ok(err.message.startsWith(`${prefix}Boom - {"trace":"xxx`));
    assert.equal(err.message.length, prefix.length + 500);
    return true;
  });
});

test('the Pipeline client: 503 busy is retryable', async () => {
  const { client } = fakePipeline({ reply: () => jsonReply(503, { success: false, status: 'busy', busyReason: 'settling', retryable: true }) });
  await assert.rejects(client.exec('editor.playmode start'), (err) => {
    assert.match(err.message, /busy \(settling\); 'editor\.playmode start' did not run/);
    assert.equal(err.retryable, true);
    assert.equal(err.busyReason, 'settling');
    assert.equal(err.code, P.PIPELINE_ERROR.busy);
    assert.equal(P.isTransientPipelineError(err), true);
    return true;
  });
  const dialog = fakePipeline({ reply: () => jsonReply(503, { success: false, status: 'busy', busyReason: 'blocked_by_dialog', retryable: false }) });
  await assert.rejects(dialog.client.exec('editor status'), (err) => err.retryable === false && /blocked_by_dialog/.test(err.message));
});

test('the Pipeline client: a reply that is not JSON gets its own error', async () => {
  for (const text of ['<html><body>502 Bad Gateway</body></html>', '', '"just a string"', 'null']) {
    const { client } = fakePipeline({ reply: () => ({ status: 200, text }) });
    await assert.rejects(client.exec('editor status'), (err) => {
      assert.match(err.message, /^Unity Pipeline answered 'editor status' with HTTP 200 and a reply that is not a JSON object: /, text);
      assert.equal(err.code, P.PIPELINE_ERROR.notJson);
      assert.equal(P.isTransientPipelineError(err), false);
      return true;
    });
  }
});

test('the Pipeline client: a refused port is transient and names the port', async () => {
  const refused = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
  const { client } = fakePipeline({ fetchError: refused });
  await assert.rejects(client.exec('editor status'), (err) => {
    assert.match(err.message, /not reachable on port 7801 \(fetch failed: ECONNREFUSED\)/);
    assert.equal(err.code, P.PIPELINE_ERROR.unreachable);
    assert.equal(P.isTransientPipelineError(err), true);
    return true;
  });
  // redirect: 'error' - undici's cause has a message but no code.
  const redirected = fakePipeline({ fetchError: new TypeError('fetch failed', { cause: new Error('unexpected redirect') }) });
  await assert.rejects(redirected.client.exec('editor status'), /\(fetch failed: unexpected redirect\)/);
  const timeout = fakePipeline({ fetchError: Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }) });
  await assert.rejects(timeout.client.exec('editor status'), (err) => err.code === P.PIPELINE_ERROR.timeout && /did not answer 'editor status'/.test(err.message));
});

test('the Pipeline client: which failures certainly did not run the command (safe to send again)', async () => {
  const errorOf = async (opts) => fakePipeline(opts).client.exec('editor.playmode start').then(() => null, (err) => err);
  const refused = await errorOf({ fetchError: new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } }) });
  const dropped = await errorOf({ fetchError: new TypeError('fetch failed', { cause: { code: 'UND_ERR_SOCKET' } }) });
  const timedOut = await errorOf({ fetchError: Object.assign(new Error('aborted'), { name: 'TimeoutError' }) });
  const busy = await errorOf({ reply: () => jsonReply(503, { success: false, status: 'busy', busyReason: 'settling', retryable: true }) });
  const missing = await errorOf({ descriptor: null });
  const failed = await errorOf({ reply: () => jsonReply(400, { success: false, error: 'Command Not Found' }) });

  assert.deepEqual([refused, missing, busy].map(P.pipelineCommandDidNotRun), [true, true, true]);
  assert.deepEqual([dropped, timedOut, failed].map(P.pipelineCommandDidNotRun), [false, false, false], 'may have run, or ran and failed');
  assert.deepEqual([dropped, timedOut].map(P.isTransientPipelineError), [true, true], 'still worth waiting out in a poll');
});

test('the Pipeline client: a heartbeat far in the future is a forged port file', async () => {
  const forged = fakePipeline({ heartbeatAgeMs: -(365 * 24 * 3600 * 1000) });
  await assert.rejects(forged.client.exec('editor status'), (err) => err.code === P.PIPELINE_ERROR.badDescriptor && /lastHeartbeat in the future/.test(err.message));
  assert.equal(forged.requests.length, 0, 'nothing is sent to a port a stale file names');
  const skewed = fakePipeline({ heartbeatAgeMs: -30 * 1000 });
  assert.deepEqual(await skewed.client.exec('editor status'), EDITOR_STATUS, 'a small clock skew is fine');
});

test('the Pipeline client: the token never appears in an error, whatever the editor echoes back', async () => {
  const echoes = [
    () => jsonReply(401, { success: false, error: `bad token ${PIPE_TOKEN}`, errorDetails: { got: `Bearer ${PIPE_TOKEN}` } }),
    () => ({ status: 500, text: `<pre>Authorization: Bearer ${PIPE_TOKEN}</pre>` }),
    () => jsonReply(503, { success: false, status: 'busy', busyReason: PIPE_TOKEN, retryable: true }),
    // The token straddles the 500-char cap: no half of it may survive the cut.
    () => jsonReply(400, { success: false, error: 'E', errorDetails: `${'x'.repeat(480)}${PIPE_TOKEN}` }),
    () => ({ status: 502, text: `${'y'.repeat(100)}${PIPE_TOKEN}` }),
  ];
  const tokenHead = PIPE_TOKEN.slice(0, 12);
  for (const reply of echoes) {
    const { client } = fakePipeline({ reply });
    await assert.rejects(client.exec('editor status'), (err) => {
      assert.equal(leaksToken(err), false, err.message);
      assert.equal(err.message.includes(tokenHead), false, `no part of the token: ${err.message}`);
      return true;
    });
  }
  const thrower = fakePipeline({ fetchError: new Error(`socket hang up (Bearer ${PIPE_TOKEN})`) });
  await assert.rejects(thrower.client.exec('editor status'), (err) => {
    assert.equal(leaksToken(err), false, err.message);
    assert.match(err.message, /\[token\]/);
    return true;
  });
});

test('the Pipeline client: only fixed-shape commands and object parameters; an absolute project dir', async () => {
  const { client, reads } = fakePipeline();
  for (const command of ['status', 'rm -rf', '', 'editor  status', 'editor status\nx', 42]) {
    await assert.rejects(client.exec(command), /bad Unity Pipeline command/, String(command));
  }
  await assert.rejects(client.exec('editor status', ['x']), /parameters must be an object/);
  assert.equal(reads.length, 0);
  assert.throws(() => P.createPipelineClient({ projectDir: 'relative/game', fetch: async () => {} }), /absolute/);
  assert.throws(() => P.createPipelineClient({ projectDir: PIPE_DIR, fetch: async () => {}, timeoutMs: 0 }), /timeoutMs/);
});

test('the Pipeline table maps every Luna call to a fixed command', () => {
  const PL = UN.UNITY_PIPELINE;
  assert.deepEqual(PL.play(), ['editor.playmode start', {}]);
  assert.deepEqual(PL.stop(), ['editor.playmode stop', {}]);
  assert.deepEqual(PL.state(), ['editor status', {}]);
  assert.deepEqual(PL.openScene('Assets/Scenes/Main.unity'), ['scene open', { path: 'Assets/Scenes/Main.unity' }]);
  assert.deepEqual(PL.console(), ['console get', { tail: 100, level: 'warning' }]);
  assert.deepEqual(PL.driver('state'), ['playtest state', {}]);
  assert.deepEqual(PL.driver('screenshot'), ['playtest screenshot', {}]);
  const steps = [{ type: 'key', key: 'Space', holdMs: 100 }];
  assert.deepEqual(PL.driver('input', { steps }), ['playtest input', { steps: JSON.stringify(steps) }]);
  assert.throws(() => PL.driver('exec'), /unknown PlaytestDriver action/);
  assert.throws(() => PL.driver('input', {}), /steps array/);
  assert.deepEqual(Object.keys(UN.UNITY_TRANSPORTS).sort(), ['mcp', 'pipeline']);

  assert.equal(UN.isPlaying({ playMode: 'playing' }), true);
  assert.equal(UN.isPlaying({ playMode: 'stopped' }), false);
  assert.equal(UN.isPlaying({ isPlaying: true }), true, 'MCP for Unity still reads');
});

test('pipelineCall parses a result the editor sent back as JSON text', async () => {
  const replies = [{ scene: 'Level1' }, JSON.stringify({ scene: 'Level1' }), 'plain text', '7'];
  const client = { exec: async () => replies.shift() };
  assert.deepEqual(await UN.pipelineCall(client, UN.UNITY_PIPELINE.driver('state')), { scene: 'Level1' });
  assert.deepEqual(await UN.pipelineCall(client, UN.UNITY_PIPELINE.driver('state')), { scene: 'Level1' });
  assert.equal(await UN.pipelineCall(client, UN.UNITY_PIPELINE.driver('state')), 'plain text');
  assert.equal(await UN.pipelineCall(client, UN.UNITY_PIPELINE.driver('state')), '7');
});

test('the bridge with --unity-project: every Playtester tool is one mapped Pipeline command', async () => {
  const shot = PNG.toString('base64');
  const answers = {
    'playtest screenshot': () => okReply({ png: shot, width: 1920, height: 1080 }),
    'playtest state': () => okReply({ scene: 'Level1', score: 3 }),
    'playtest input': (p) => okReply({ done: JSON.parse(p.steps).length }),
    'console get': () => okReply({ entries: [{ level: 'error', logType: 'Exception', message: 'NullReferenceException in Enemy.Update', stackTrace: '' }], counts: { error: 1, warn: 0, log: 0 }, groundTruth: { compilationFailed: false, consoleErrors: 1 } }),
  };
  const { client, requests } = fakePipeline({ reply: (body) => answers[body.command](body.parameters) });
  let closed = 0;
  const evidenceDir = tmpDir('lw-bridge-pipe-');
  const slept = [];
  const invoke = B.unityBackend({
    transport: 'pipeline',
    connect: () => ({ exec: client.exec, close: async () => { closed += 1; } }),
    sleep: async (ms) => slept.push(ms),
  });
  const bridge = B.createBridge({ backend: 'unity', evidenceDir, invoke });

  const res = await bridge.callTool('screenshot', { name: 'f1-menu' });
  assert.equal(res.isError, undefined);
  assert.deepEqual(res.content[1], { type: 'image', data: shot, mimeType: 'image/png' });
  assert.deepEqual(fs.readdirSync(evidenceDir), ['f1-menu.png']);

  assert.deepEqual(JSON.parse((await bridge.callTool('game_state', {})).content[0].text), { scene: 'Level1', score: 3 });
  const steps = [{ type: 'key', key: 'Space', holdMs: 100 }, { type: 'ui', name: 'PlayButton' }];
  assert.deepEqual(JSON.parse((await bridge.callTool('send_input', { steps })).content[0].text), { done: 2 });
  assert.match((await bridge.callTool('console_errors', {})).content[0].text, /NullReferenceException/);
  await bridge.callTool('wait', { ms: 250 });

  assert.deepEqual(requests.map((r) => r.body.command), ['playtest screenshot', 'playtest state', 'playtest input', 'console get']);
  assert.deepEqual(requests[2].body.parameters, { steps: JSON.stringify(steps) });
  assert.deepEqual(requests[3].body.parameters, { tail: 100, level: 'warning' });
  assert.deepEqual(slept, [250]);
  assert.equal(closed, 4, 'one short-lived client per call');

  const missing = B.createBridge({ backend: 'unity', evidenceDir, invoke: B.unityBackend({ transport: 'pipeline', connect: () => fakePipeline({ descriptor: null }).client }) });
  const down = await missing.callTool('game_state', {});
  assert.equal(down.isError, true);
  assert.match(down.content[0].text, /Unity editor not open on/);
});

test('bridge flags: --unity-project must be absolute, --unity-url stays for legacy, never both', () => {
  assert.equal(typeof B.invokerFor({ backend: 'unity', 'unity-project': PIPE_DIR }), 'function');
  assert.equal(typeof B.invokerFor({ backend: 'unity', 'unity-url': 'http://127.0.0.1:8080/mcp' }), 'function');
  assert.throws(() => B.invokerFor({ backend: 'unity', 'unity-project': 'relative/game' }), /--unity-project must be an absolute directory/);
  assert.throws(() => B.invokerFor({ backend: 'unity', 'unity-project': '' }), /--unity-project must be an absolute directory/);
  assert.throws(() => B.invokerFor({ backend: 'unity', 'unity-project': PIPE_DIR, 'unity-url': 'http://127.0.0.1:8080/mcp' }), /not both/);
  assert.throws(() => B.invokerFor({ backend: 'unity' }), /--unity-url must be http/);
  assert.throws(() => B.unityBackend({ transport: 'carrier-pigeon', connect: () => ({}) }), /unknown Unity transport/);
  assert.deepEqual(B.parseArgv(['--backend', 'unity', '--unity-project', PIPE_DIR]), { backend: 'unity', 'unity-project': PIPE_DIR });
});

// ---- stdio MCP bridge ---------------------------------------------------------------

test('the bridge speaks MCP: initialize, ping, tools/list, unknown methods, notifications', async () => {
  const bridge = B.createBridge({ backend: 'electron', evidenceDir: tmpDir('lw-bridge-'), invoke: async () => ({ ok: 1 }) });
  const init = await bridge.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } });
  assert.equal(init.result.protocolVersion, '2025-03-26');
  assert.deepEqual(init.result.capabilities, { tools: { listChanged: false } });
  assert.deepEqual((await bridge.handle({ jsonrpc: '2.0', id: 2, method: 'ping' })).result, {});
  assert.equal(await bridge.handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  assert.equal((await bridge.handle({ jsonrpc: '2.0', id: 3, method: 'resources/list' })).error.code, -32601);
  assert.equal((await bridge.handle({ id: 4, method: 'ping' })).error.code, -32600);
  const call = await bridge.handle({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'list_windows', arguments: {} } });
  assert.deepEqual(JSON.parse(call.result.content[0].text), { ok: 1 });

  assert.throws(() => B.createBridge({ backend: 'shell', evidenceDir: tmpDir('lw-bridge-'), invoke: async () => {} }), /unknown backend/);
  assert.throws(() => B.createBridge({ backend: 'unity', evidenceDir: 'relative', invoke: async () => {} }), /absolute/);
});

test('the electron backend reads the control file the adapter wrote, on every call', async () => {
  const dir = tmpDir('lw-bridge-ctl-');
  const file = path.join(dir, '.playtest-control.json');
  const seen = [];
  const invoke = B.electronBackend({ controlFile: file, call: async (control, tool, args) => seen.push([control, tool, args]) });
  fs.writeFileSync(file, JSON.stringify({ port: 5000, token: 'f'.repeat(64) }));
  await invoke('list_windows', {});
  assert.deepEqual(seen, [[{ port: 5000, token: 'f'.repeat(64) }, 'list_windows', {}]]);
  fs.rmSync(file);
  await assert.rejects(invoke('list_windows', {}), /ENOENT/, 'the app is stopped: no control file, no call');
});

test('a screenshot that is not a PNG is refused and nothing is written', async () => {
  const dir = tmpDir('lw-bridge-png-');
  const bridge = B.createBridge({ backend: 'unity', evidenceDir: dir, invoke: async () => ({ png: Buffer.from('<svg/>').toString('base64') }) });
  const res = await bridge.callTool('screenshot', { name: 'x' });
  assert.equal(res.isError, true);
  assert.deepEqual(fs.readdirSync(dir), []);
  assert.deepEqual(B.parseArgv(['--backend', 'unity', '--unity-url', 'http://127.0.0.1:8080/mcp', '--flag']), {
    backend: 'unity',
    'unity-url': 'http://127.0.0.1:8080/mcp',
    flag: '',
  });
});
