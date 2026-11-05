// ============================================================================
// src/procTree.js: killing a child with everything it started, and the
// process scope a timed-out step kills.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');

const { killTree, createProcessScope } = require('../src/procTree.js');

test('killTree on Windows runs taskkill for the whole tree', async () => {
  const calls = [];
  const execFileImpl = (bin, args, opts, cb) => {
    calls.push([bin, args, opts.windowsHide]);
    setImmediate(() => cb(null, '', ''));
  };
  assert.deepEqual(await killTree(1234, { platform: 'win32', execFileImpl }), { ok: true });
  assert.deepEqual(calls, [['taskkill', ['/PID', '1234', '/T', '/F'], true]]);
  const failing = (bin, args, opts, cb) => setImmediate(() => cb(Object.assign(new Error('x'), { code: 128 }), '', 'ERROR: not found\r\n'));
  assert.deepEqual(await killTree(1234, { platform: 'win32', execFileImpl: failing }), { ok: false, reason: 'ERROR: not found' });
  assert.deepEqual(await killTree(0, { platform: 'win32', execFileImpl }), { ok: false, reason: 'badPid' });
  assert.deepEqual(await killTree('7', { platform: 'win32', execFileImpl }), { ok: false, reason: 'badPid' });
});

test('killTree elsewhere: the whole tree via pgrep, grandchildren included, then the pid and each descendant', async () => {
  // 55 -> 56 -> 57 (npm -> node -> worker), 55 -> 58
  const tree = { 55: '56\n58\n', 56: '57\n', 57: '', 58: '' };
  const asked = [];
  const execFileImpl = (bin, args, opts, cb) => {
    asked.push([bin, ...args]);
    const out = tree[args[1]];
    setImmediate(() => (out ? cb(null, out, '') : cb(Object.assign(new Error('none'), { code: 1 }), '', '')));
  };
  const killed = [];
  const notLeader = (target, signal) => {
    if (target < 0) throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
    killed.push([target, signal]);
  };
  assert.deepEqual(await killTree(55, { platform: 'linux', execFileImpl, killImpl: notLeader }), { ok: true });
  assert.deepEqual(asked.map((a) => a.join(' ')), ['pgrep -P 55', 'pgrep -P 56', 'pgrep -P 58', 'pgrep -P 57']);
  assert.deepEqual(killed, [[55, 'SIGKILL'], [56, 'SIGKILL'], [58, 'SIGKILL'], [57, 'SIGKILL']]);

  const leader = [];
  await killTree(55, { platform: 'linux', execFileImpl: (b, a, o, cb) => setImmediate(() => cb(null, '', '')), killImpl: (t) => leader.push(t) });
  assert.deepEqual(leader, [-55], 'a group leader is killed by its group');

  const gone = () => {
    throw new Error('ESRCH');
  };
  const noPgrep = () => {
    throw new Error('ENOENT');
  };
  assert.deepEqual(await killTree(55, { platform: 'linux', execFileImpl: noPgrep, killImpl: gone }), { ok: false, reason: 'notFound' });
});

function fakeChild(pid) {
  const c = new EventEmitter();
  c.pid = pid;
  return c;
}

test('a process scope tracks live children, kills them all and then starts nothing', async () => {
  const kills = [];
  let next = 100;
  const spawned = [];
  const impl = (...args) => {
    const c = fakeChild(next++);
    spawned.push({ c, args });
    return c;
  };
  const scope = createProcessScope({ kill: async (pid) => (kills.push(pid), { ok: pid !== 101 }), execFileImpl: impl, execImpl: impl });
  scope.execFile('git', ['status'], {}, () => {});
  scope.exec('npm test', {}, () => {});
  scope.execFile('git', ['fetch'], {}, () => {});
  assert.equal(scope.size(), 3);
  spawned[2].c.emit('exit', 0);
  assert.equal(scope.size(), 2, 'an exited child is forgotten');

  assert.deepEqual(await scope.killAll(), { killed: 1, failed: 1 });
  assert.deepEqual(kills, [100, 101]);
  assert.equal(scope.isClosed(), true);

  let called = null;
  const child = scope.execFile('git', ['push'], {}, (err, stdout) => (called = [err.code, err.killed, stdout]));
  assert.equal(child, null);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(called, ['ABORTED', true, '']);
  assert.equal(spawned.length, 3, 'nothing new spawned after the kill');
});

test('a scope-wrapped real execFile kills a hanging child', { timeout: 20_000 }, async () => {
  const scope = createProcessScope();
  let result = null;
  scope.execFile(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { windowsHide: true }, (err) => {
    result = err ? 'ended' : 'ok';
  });
  assert.equal(scope.size(), 1);
  const res = await scope.killAll();
  assert.equal(res.killed, 1);
  for (let i = 0; i < 100 && result === null; i += 1) await new Promise((r) => setTimeout(r, 50));
  assert.equal(result, 'ended');
});
