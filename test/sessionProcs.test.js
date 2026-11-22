// Tests for the per-session OS process snapshot (src/sessionProcs.js) and its
// subscription hub / IPC (src/sessionProcsIpc.js): a fake runner stands in for
// execFile, fake timers for setInterval. No real process is spawned.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
  MAX_PROCS_PER_SESSION, WINDOWS_COMMAND, POSIX_COMMAND,
  parseWindowsProcesses, parsePosixProcesses, descendantsOf, portsByPid, snapshotSessionProcs,
} = require('../src/sessionProcs');
const { SessionProcsHub, registerSessionProcsIpc, MAX_SUBSCRIPTIONS_PER_SENDER } = require('../src/sessionProcsIpc');

const TOKEN = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const flush = () => new Promise((resolve) => setImmediate(resolve));

/** Win32_Process rows as Get-CimInstance | ConvertTo-Json writes them. */
const WIN_ROWS = [
  { ProcessId: 100, ParentProcessId: 1, Name: 'powershell.exe', CommandLine: 'powershell.exe -NoLogo' },
  { ProcessId: 200, ParentProcessId: 100, Name: 'node.exe', CommandLine: `"C:\\nodejs\\node.exe" claude.js --token ${TOKEN}` },
  { ProcessId: 300, ParentProcessId: 200, Name: 'node.exe', CommandLine: 'node node_modules/vite/bin/vite.js --port 5173' },
  { ProcessId: 301, ParentProcessId: 200, Name: 'cmd.exe', CommandLine: `cmd /c "set API_KEY=${TOKEN} && npm test"` },
  { ProcessId: 400, ParentProcessId: 1, Name: 'other.exe', CommandLine: 'other.exe' },
];

/** A runner that records its calls and answers like the platform's process list. */
function fakeRunner(stdout) {
  const calls = [];
  const runner = async (cmd, args) => {
    calls.push({ cmd, args });
    return stdout;
  };
  return { runner, calls };
}

// ---- parsing ------------------------------------------------------------------

test('parseWindowsProcesses reads the array, a single object, and rejects junk', () => {
  assert.equal(parseWindowsProcesses(JSON.stringify(WIN_ROWS)).length, WIN_ROWS.length);
  assert.deepEqual(parseWindowsProcesses(JSON.stringify(WIN_ROWS[1])).map((r) => r.pid), [200]);
  assert.deepEqual(parseWindowsProcesses(''), []);
  assert.deepEqual(parseWindowsProcesses(JSON.stringify([{ ProcessId: 0 }, { ProcessId: 'x' }, null, 5])), []);
  assert.throws(() => parseWindowsProcesses('not json'), /not JSON/);
});

test('parsePosixProcesses reads ps lines', () => {
  const rows = parsePosixProcesses('  10     1 /bin/bash -l\n  20    10 node /usr/lib/node_modules/npm/bin/npm-cli.js test\ngarbage\n');
  assert.deepEqual(rows.map((r) => [r.pid, r.ppid, r.name]), [[10, 1, 'bash'], [20, 10, 'node']]);
});

test('descendantsOf walks the tree below the root only, and survives a pid loop', () => {
  const rows = parseWindowsProcesses(JSON.stringify(WIN_ROWS));
  assert.deepEqual(descendantsOf(rows, 100).map((r) => r.pid), [200, 300, 301]);
  assert.deepEqual(descendantsOf(rows, 999), []);
  // A reused pid can make the parent links a loop.
  const loop = [{ pid: 2, ppid: 3 }, { pid: 3, ppid: 2 }, { pid: 4, ppid: 4 }];
  assert.deepEqual(descendantsOf(loop, 2).map((r) => r.pid), [3]);
});

test('descendantsOf stops at MAX_PROCS_PER_SESSION', () => {
  const rows = Array.from({ length: MAX_PROCS_PER_SESSION + 40 }, (_, i) => ({ pid: 1000 + i, ppid: 1 }));
  assert.equal(descendantsOf(rows, 1).length, MAX_PROCS_PER_SESSION);
});

test('portsByPid groups listening ports by process, sorted, valid ones only', () => {
  const map = portsByPid([
    { port: 5173, procId: 300 }, { port: 3000, procId: 300 }, { port: 5173, procId: 300 },
    { port: 0, procId: 300 }, { port: 70000, procId: 300 }, { port: 80, procId: 0 }, null,
  ]);
  assert.deepEqual([...map], [[300, [3000, 5173]]]);
});

// ---- snapshot -------------------------------------------------------------------

test('snapshotSessionProcs runs the fixed process list once and correlates ports by procId', async () => {
  const { runner, calls } = fakeRunner(JSON.stringify(WIN_ROWS));
  const scanPorts = async () => [{ port: 5173, procId: 300, name: 'node' }, { port: 8080, procId: 400, name: 'other' }];
  const snap = await snapshotSessionProcs([{ sessionId: 's1', pid: 100 }, { sessionId: 's2', pid: 400 }], { runner, platform: 'win32', scanPorts });
  assert.deepEqual(calls, [{ cmd: WINDOWS_COMMAND.cmd, args: [...WINDOWS_COMMAND.args] }], 'one fixed command, nothing from a session in it');
  assert.deepEqual(Object.keys(snap), ['s1', 's2']);
  assert.deepEqual(snap.s1.map((p) => [p.pid, p.ppid, p.name, p.ports]), [
    [200, 100, 'node.exe', []], [300, 200, 'node.exe', [5173]], [301, 200, 'cmd.exe', []],
  ]);
  assert.equal(snap.s1[1].label, 'node node_modules/vite/bin/vite.js --port', 'a flag\'s value is never shown');
  assert.deepEqual(snap.s2, [], 'a session with no children has an empty list');
});

test('snapshot labels are sanitized: no token, no env value, no raw command line', async () => {
  const { runner } = fakeRunner(JSON.stringify(WIN_ROWS));
  const snap = await snapshotSessionProcs([{ sessionId: 's1', pid: 100 }], { runner, platform: 'win32', scanPorts: async () => [] });
  const json = JSON.stringify(snap);
  assert.doesNotMatch(json, /ghp_|API_KEY|CommandLine|"cmd":/);
  assert.equal(snap.s1[0].label, 'node claude.js');
  for (const proc of snap.s1) {
    assert.deepEqual(Object.keys(proc).sort(), ['label', 'name', 'pid', 'ports', 'ppid']);
    assert.ok(proc.label.length <= 80);
  }
});

test('snapshotSessionProcs on POSIX runs ps', async () => {
  const { runner, calls } = fakeRunner('  10     1 /bin/bash\n  20    10 npm run dev\n');
  const snap = await snapshotSessionProcs([{ sessionId: 's1', pid: 10 }], { runner, platform: 'linux', scanPorts: async () => [] });
  assert.deepEqual(calls, [{ cmd: POSIX_COMMAND.cmd, args: [...POSIX_COMMAND.args] }]);
  assert.deepEqual(snap.s1.map((p) => p.label), ['npm run dev']);
});

test('snapshotSessionProcs spawns nothing without a valid live session', async () => {
  const { runner, calls } = fakeRunner('[]');
  const bad = [null, { sessionId: 's1', pid: 0 }, { sessionId: 's1', pid: '12' }, { sessionId: 'a b', pid: 5 }, { sessionId: 7, pid: 5 }];
  assert.deepEqual(await snapshotSessionProcs(bad, { runner, platform: 'win32', scanPorts: async () => [] }), {});
  assert.deepEqual(await snapshotSessionProcs(undefined, { runner }), {});
  assert.equal(calls.length, 0);
});

test('a process list that cannot be read rejects with the reason', async () => {
  const runner = async () => {
    throw new Error('powershell timed out');
  };
  await assert.rejects(snapshotSessionProcs([{ sessionId: 's1', pid: 5 }], { runner, platform: 'win32', scanPorts: async () => [] }), /timed out/);
});

test('the process lists run by absolute path, never a PATH lookup', () => {
  assert.ok(path.win32.isAbsolute(WINDOWS_COMMAND.cmd) && /WindowsPowerShell[\\/]v1\.0[\\/]powershell\.exe$/i.test(WINDOWS_COMMAND.cmd), WINDOWS_COMMAND.cmd);
  assert.equal(POSIX_COMMAND.cmd, '/bin/ps');
});

test('the real runner uses execFile without a shell', () => {
  const src = read('src/sessionProcs.js');
  assert.match(src, /const \{ execFile \} = require\('child_process'\);/, 'execFile is the only child_process import');
  assert.match(src, /execFile\(cmd, args, \{[^}]*shell: false/);
  assert.doesNotMatch(src, /execSync|spawnSync|\bspawn\(|shell:\s*true/);
});

// ---- the hub: polls only while watched ----------------------------------------------

/** Fake setTimeout/clearTimeout that run only when the test says so; `delays` records the waits. */
function fakeTimers() {
  const timers = new Map();
  const delays = [];
  let seq = 0;
  return {
    timers,
    delays,
    setTimeout: (fn, ms) => {
      timers.set(++seq, fn);
      delays.push(ms);
      return seq;
    },
    clearTimeout: (id) => timers.delete(id),
    fire: () => {
      const due = [...timers.entries()];
      timers.clear();
      for (const [, fn] of due) fn();
    },
  };
}

function makeHub(sessions = { s1: [] }, { now = () => 42 } = {}) {
  const clock = fakeTimers();
  const snapshots = [];
  const logs = [];
  const hub = new SessionProcsHub({
    snapshot: async (roots) => {
      snapshots.push(roots);
      return typeof sessions === 'function' ? sessions() : sessions;
    },
    listRoots: () => [{ sessionId: 's1', pid: 100 }],
    now,
    log: (msg) => logs.push(msg),
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
  });
  return { hub, clock, snapshots, logs };
}

test('with no subscriber there is no timer and no poll at all', async () => {
  const { hub, clock, snapshots } = makeHub();
  clock.fire();
  await hub.poll();
  await flush();
  assert.equal(clock.timers.size, 0);
  assert.equal(hub.polls, 0);
  assert.equal(snapshots.length, 0);
});

test('the first subscriber starts polling at once; the last one leaving stops it', async () => {
  const { hub, clock, snapshots } = makeHub();
  const got = [];
  assert.deepEqual(hub.subscribe(7, (p) => got.push(p)), { ok: true, isNew: true });
  await flush();
  assert.equal(clock.timers.size, 1);
  assert.deepEqual(got, [{ at: 42, sessions: { s1: [] } }]);
  clock.fire();
  await flush();
  assert.equal(snapshots.length, 2);
  assert.equal(got.length, 1, 'an unchanged snapshot is not sent again');
  hub.unsubscribe(7);
  assert.equal(clock.timers.size, 0);
  assert.equal(hub.latest, null, 'no stale snapshot (pids get reused) for the next subscriber');
  await hub.poll();
  assert.equal(snapshots.length, 2, 'no poll after the last unsubscribe');
});

test('subscriptions are counted per subscriber and capped', async () => {
  const { hub, clock } = makeHub();
  hub.subscribe(7, () => {});
  await flush();
  assert.equal(hub.subscribe(7, () => {}).isNew, false);
  hub.unsubscribe(7);
  assert.deepEqual([hub.running, clock.timers.size], [true, 1], 'one view still watching');
  hub.unsubscribe(7);
  assert.deepEqual([hub.running, clock.timers.size], [false, 0]);
  for (let i = 0; i < MAX_SUBSCRIPTIONS_PER_SENDER; i++) hub.subscribe(8, () => {});
  assert.deepEqual(hub.subscribe(8, () => {}), { ok: false, isNew: false });
  await flush();
  hub.drop(8);
  assert.deepEqual([hub.running, clock.timers.size], [false, 0], 'a window that went away takes all its subscriptions with it');
});

test('a slow snapshot makes the next one wait longer: never back to back', async () => {
  let t = 0;
  const { hub, clock } = makeHub(() => {
    t += 6000; // this snapshot "took" 6 s
    return { s1: [] };
  }, { now: () => t });
  hub.subscribe(1, () => {});
  await flush();
  assert.deepEqual(clock.delays, [12000], 'twice as long as it took');
  clock.fire();
  await flush();
  assert.deepEqual(clock.delays, [12000, 12000]);
  hub.drop(1);
  const quick = makeHub();
  quick.hub.subscribe(1, () => {});
  await flush();
  assert.deepEqual(quick.clock.delays, [5000], 'a quick one still waits the base interval');
  quick.hub.drop(1);
});

test('a failing snapshot is logged once per reason and never thrown', async () => {
  const { hub, logs } = makeHub(() => {
    throw new Error('powershell missing');
  });
  hub.subscribe(1, () => assert.fail('nothing to deliver'));
  await flush();
  await hub.poll();
  await hub.poll();
  assert.deepEqual(logs, ['process snapshot failed: powershell missing']);
  hub.drop(1);
});

// ---- IPC ----------------------------------------------------------------------------

/** A fake ipcMain + webContents pair. */
function fakeIpc() {
  const handlers = new Map();
  const ipcMain = { handle: (channel, fn) => handlers.set(channel, fn) };
  const makeSender = (id) => {
    const sent = [];
    const onceHandlers = new Map();
    return {
      id, sent, onceHandlers,
      send: (channel, payload) => sent.push([channel, payload]),
      isDestroyed: () => false,
      once: (name, fn) => onceHandlers.set(name, fn),
    };
  };
  return { handlers, ipcMain, makeSender };
}

test('IPC: only the trusted window may subscribe, read or unsubscribe', async () => {
  const { hub } = makeHub();
  const { handlers, ipcMain, makeSender } = fakeIpc();
  const trustedSender = makeSender(1);
  const stranger = makeSender(2);
  registerSessionProcsIpc({ ipcMain, hub, isTrustedSender: (event) => event.sender === trustedSender });
  assert.deepEqual([...handlers.keys()].sort(), ['sessionprocs:get', 'sessionprocs:subscribe', 'sessionprocs:unsubscribe']);

  for (const channel of handlers.keys()) {
    assert.deepEqual(handlers.get(channel)({ sender: stranger }), { ok: false, reason: 'untrusted' }, channel);
  }
  assert.equal(hub.polls, 0, 'an untrusted subscribe starts nothing');

  const res = handlers.get('sessionprocs:subscribe')({ sender: trustedSender }, { evil: 'payload ignored' });
  assert.equal(res.ok, true);
  await flush();
  assert.deepEqual(trustedSender.sent, [['sessionprocs:update', { at: 42, sessions: { s1: [] } }]]);
  assert.ok(trustedSender.onceHandlers.has('destroyed'));
  assert.deepEqual(handlers.get('sessionprocs:get')({ sender: trustedSender }), { ok: true, snapshot: { at: 42, sessions: { s1: [] } } });
  // The window goes away: its subscription goes with it.
  trustedSender.onceHandlers.get('destroyed')();
  assert.equal(hub.timer, null);
});

test('IPC: a window that shows and hides its view many times gets one destroyed listener', async () => {
  const { hub } = makeHub();
  const { handlers, ipcMain, makeSender } = fakeIpc();
  const sender = makeSender(1);
  let listeners = 0;
  sender.once = () => {
    listeners++;
  };
  registerSessionProcsIpc({ ipcMain, hub, isTrustedSender: () => true });
  for (let i = 0; i < 20; i++) {
    handlers.get('sessionprocs:subscribe')({ sender });
    await flush();
    handlers.get('sessionprocs:unsubscribe')({ sender });
  }
  assert.equal(listeners, 1);
  assert.equal(hub.timer, null);
});

test('IPC: an unset trust check refuses everything', () => {
  const { hub } = makeHub();
  const { handlers, ipcMain, makeSender } = fakeIpc();
  registerSessionProcsIpc({ ipcMain, hub });
  assert.deepEqual(handlers.get('sessionprocs:subscribe')({ sender: makeSender(1) }), { ok: false, reason: 'untrusted' });
});

test('preload: read-only snapshot and a subscription that hands back only the payload', () => {
  const preload = read('src/preload.js');
  assert.match(preload, /getSessionProcs: \(\) => ipcRenderer\.invoke\('sessionprocs:get'\)/);
  const block = preload.slice(preload.indexOf('subscribeSessionProcs:'), preload.indexOf('subscribeSessionProcs:') + 1200);
  assert.match(block, /ipcRenderer\.invoke\('sessionprocs:subscribe'\)/);
  assert.match(block, /ipcRenderer\.invoke\('sessionprocs:unsubscribe'\)/);
  assert.match(block, /ipcRenderer\.removeListener\('sessionprocs:update', listener\)/);
  assert.match(block, /const listener = \(_event, payload\) =>/, 'the IPC event never reaches the page');
  assert.doesNotMatch(block, /ipcRenderer\.send\(/);
});

test('main: the hub is wired with a main-window sender check, and agy MCP events reach metrics:mcp', () => {
  const main = read('src/main.js');
  assert.match(main, /registerSessionProcsIpc\(\{[\s\S]{0,600}isTrustedSender: \(event\) => Boolean\(mainWindow && !mainWindow\.isDestroyed\(\) && event && event\.sender === mainWindow\.webContents\)/);
  const agy = main.slice(main.indexOf('new AgyTranscriptWatcher('), main.indexOf('new AgyTranscriptWatcher(') + 900);
  assert.match(agy, /onMcp: \(events\) => send\('metrics:mcp', \{ sessionId: session\.id, events \}\)/);
});
