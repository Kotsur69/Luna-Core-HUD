// ============================================================================
// LunaCore - "Don't sleep" toggle tests (src/keepawake.js)
// ----------------------------------------------------------------------------
// spawn/execFile/fs are all fakes: no cmd.exe, no taskkill, no real script.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');

const { createKeepAwake, resolveScript } = require('../src/keepawake');

const SCRIPT = 'C:\\tools\\dont sleep\\Keep Awake.bat';

function harness({ platform = 'win32', config = { script: SCRIPT }, exists = () => true } = {}) {
  const spawned = [];
  const killed = [];
  const changes = [];
  const keepAwake = createKeepAwake({
    platform,
    readConfig: () => config,
    exists,
    spawn: (cmd, args, opts) => {
      const proc = new EventEmitter();
      proc.pid = 4242 + spawned.length;
      spawned.push({ cmd, args, opts, proc });
      return proc;
    },
    execFile: (cmd, args) => killed.push({ cmd, args }),
    execFileSync: (cmd, args) => killed.push({ cmd, args, sync: true }),
    onChange: (s) => changes.push(s),
  });
  return { keepAwake, spawned, killed, changes };
}

test('resolveScript accepts an absolute .bat path that exists', () => {
  assert.deepStrictEqual(resolveScript({ script: SCRIPT }, () => true), { ok: true, script: SCRIPT });
});

test('resolveScript rejects missing config, relative paths, non-scripts and cmd metacharacters', () => {
  assert.strictEqual(resolveScript(null, () => true).reason, 'not-configured');
  assert.strictEqual(resolveScript({ script: '' }, () => true).reason, 'not-configured');
  assert.strictEqual(resolveScript({ script: 'Keep Awake.bat' }, () => true).reason, 'invalid-path');
  assert.strictEqual(resolveScript({ script: 'C:\\x\\evil.exe' }, () => true).reason, 'invalid-path');
  assert.strictEqual(resolveScript({ script: 'C:\\x\\a.bat & calc' }, () => true).reason, 'invalid-path');
  assert.strictEqual(resolveScript({ script: 'C:\\x\\"a".bat' }, () => true).reason, 'invalid-path');
  assert.strictEqual(resolveScript({ script: SCRIPT }, () => false).reason, 'missing');
});

test('set(true) spawns the script hidden through cmd.exe with the path quoted', () => {
  const { keepAwake, spawned } = harness();
  const status = keepAwake.set(true);
  assert.strictEqual(status.on, true);
  assert.strictEqual(spawned.length, 1);
  assert.strictEqual(spawned[0].cmd, 'cmd.exe');
  assert.deepStrictEqual(spawned[0].args, ['/d', '/s', '/c', `""${SCRIPT}""`]);
  assert.strictEqual(spawned[0].opts.windowsHide, true);
  assert.strictEqual(spawned[0].opts.windowsVerbatimArguments, true);
});

test('set(true) twice does not start a second process', () => {
  const { keepAwake, spawned } = harness();
  keepAwake.set(true);
  keepAwake.set(true);
  assert.strictEqual(spawned.length, 1);
});

test('set(false) kills the whole process tree', () => {
  const { keepAwake, spawned, killed } = harness();
  keepAwake.set(true);
  const status = keepAwake.set(false);
  assert.strictEqual(status.on, false);
  assert.deepStrictEqual(killed, [
    { cmd: 'taskkill', args: ['/pid', String(spawned[0].proc.pid), '/T', '/F'] },
  ]);
});

test('stopSync() kills the tree synchronously and is a no-op when off', () => {
  const { keepAwake, spawned, killed } = harness();
  keepAwake.stopSync();
  assert.strictEqual(killed.length, 0);
  keepAwake.set(true);
  keepAwake.stopSync();
  assert.deepStrictEqual(killed, [
    { cmd: 'taskkill', args: ['/pid', String(spawned[0].proc.pid), '/T', '/F'], sync: true },
  ]);
  assert.strictEqual(keepAwake.status().on, false);
});

test('set(false) while off is a no-op', () => {
  const { keepAwake, killed } = harness();
  assert.strictEqual(keepAwake.set(false).on, false);
  assert.strictEqual(killed.length, 0);
});

test('the script exiting on its own flips the toggle off and notifies', () => {
  const { keepAwake, spawned, changes } = harness();
  keepAwake.set(true);
  spawned[0].proc.emit('exit', 0);
  assert.strictEqual(keepAwake.status().on, false);
  assert.strictEqual(changes.length, 1);
  assert.strictEqual(changes[0].on, false);
});

test('an exit from an already-stopped process does not notify', () => {
  const { keepAwake, spawned, changes } = harness();
  keepAwake.set(true);
  keepAwake.set(false);
  spawned[0].proc.emit('exit', 1);
  assert.strictEqual(changes.length, 0);
});

test('a spawn error reports spawn-failed and turns off', () => {
  const { keepAwake, spawned } = harness();
  keepAwake.set(true);
  spawned[0].proc.emit('error', new Error('ENOENT'));
  const status = keepAwake.status();
  assert.strictEqual(status.on, false);
  assert.strictEqual(status.error, 'spawn-failed');
});

test('unconfigured: unavailable, and set(true) spawns nothing', () => {
  const { keepAwake, spawned } = harness({ config: null });
  const status = keepAwake.set(true);
  assert.strictEqual(status.available, false);
  assert.strictEqual(status.on, false);
  assert.strictEqual(status.reason, 'not-configured');
  assert.strictEqual(spawned.length, 0);
});

test('non-Windows reports unsupported', () => {
  const { keepAwake } = harness({ platform: 'linux' });
  assert.strictEqual(keepAwake.status().reason, 'unsupported');
});

test('a config read that throws degrades to not-configured', () => {
  const keepAwake = createKeepAwake({
    platform: 'win32',
    readConfig: () => { throw new Error('bad json'); },
    exists: () => true,
    spawn: () => { throw new Error('should not spawn'); },
    execFile: () => {},
  });
  assert.strictEqual(keepAwake.status().reason, 'not-configured');
});
