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
