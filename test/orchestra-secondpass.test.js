'use strict';

// God Mode merge integration: the second pass over skipped packages
// (src/orchestraSecondPass.js). tryPackage is faked; the real one lives in
// orchestraIntegrate.js and is covered in orchestra-integrate.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const { secondPass, skippedDependency, skipEntry } = require('../src/orchestraSecondPass.js');

/** A tryPackage that answers per id from `answers` (default: goes in) and logs each call. */
function fakeTry(answers = {}) {
  const calls = [];
  const tryPackage = async (pkg, opts) => {
    calls.push([pkg.id, opts.retry]);
    const a = answers[pkg.id];
    return typeof a === 'function' ? a() : a || { ok: true };
  };
  return { tryPackage, calls };
}

const pkgs = (...specs) => specs.map(([id, dependsOn = []]) => ({ id, branch: `luna/${id}`, dependsOn }));
const conflict = (id) => ({ id, stage: 'conflict', detail: 'src/x.js', files: ['src/x.js'] });
const depSkipped = (id, on) => ({ id, stage: 'depSkipped', detail: on, files: [] });
const never = () => false;

test('secondPass: a skipped package that now goes in frees its whole chain, in dependency order', async () => {
  const t = fakeTry();
  const res = await secondPass({
    packages: pkgs(['b'], ['x'], ['c', ['b']], ['d', ['c']]),
    skipped: [conflict('b'), depSkipped('c', 'b'), depSkipped('d', 'c')],
    tryPackage: t.tryPackage,
    stopped: never,
  });
  assert.deepEqual(res.merged, ['b', 'c', 'd']);
  assert.deepEqual(res.skipped, []);
  assert.deepEqual(t.calls, [['b', true], ['c', false], ['d', false]], 'retry = stronger resolver only for the one that failed');
  assert.equal(res.fatal, undefined);
});

test('secondPass: a dependent that fails keeps its own stage; what waits on it now names it', async () => {
  const t = fakeTry({ c: { ok: false, stage: 'verify', detail: 'failing: x', files: [], fixup: 'failed' } });
  const res = await secondPass({
    packages: pkgs(['b'], ['c', ['b']], ['d', ['c']]),
    skipped: [conflict('b'), depSkipped('c', 'b'), depSkipped('d', 'b')],
    tryPackage: t.tryPackage,
    stopped: never,
  });
  assert.deepEqual(res.merged, ['b']);
  assert.deepEqual(res.skipped, [
    { id: 'c', stage: 'verify', detail: 'failing: x', files: [], fixup: 'failed' },
    { id: 'd', stage: 'depSkipped', detail: 'c', files: [] },
  ]);
  assert.deepEqual(t.calls, [['b', true], ['c', false]], 'd is not tried while c is out');
});

test('secondPass: a package waiting on two skipped ones is tried once both are in; one pass, no loops', async () => {
  let bTries = 0;
  const t = fakeTry({ b: () => ((bTries += 1), { ok: false, stage: 'conflict', detail: 'src/y.js', files: ['src/y.js'] }) });
  const res = await secondPass({
    packages: pkgs(['a'], ['b'], ['e', ['a', 'b']]),
    skipped: [conflict('a'), conflict('b'), depSkipped('e', 'a')],
    tryPackage: t.tryPackage,
    stopped: never,
  });
  assert.deepEqual(res.merged, ['a']);
  assert.equal(bTries, 1, 'one second pass only');
  assert.deepEqual(res.skipped, [
    { id: 'b', stage: 'conflict', detail: 'src/y.js', files: ['src/y.js'] },
    { id: 'e', stage: 'depSkipped', detail: 'b', files: [] },
  ]);
  assert.deepEqual(t.calls, [['a', true], ['b', true]]);
});

test('secondPass: only conflict / merge / verify are tried again; a stopped run tries nothing', async () => {
  const t = fakeTry();
  const res = await secondPass({
    packages: pkgs(['a'], ['b']),
    skipped: [{ id: 'a', stage: 'reset', detail: 'x', files: [] }, depSkipped('b', 'zz')],
    tryPackage: t.tryPackage,
    stopped: never,
  });
  assert.deepEqual(t.calls, [], 'a reset failure is not retried, and with nothing new in no dependent is tried');
  assert.deepEqual(res.merged, []);
  assert.deepEqual(res.skipped[1], depSkipped('b', 'zz'), 'a blocker it cannot name now keeps the old detail');

  const stoppedRun = fakeTry();
  const out = await secondPass({ packages: pkgs(['a']), skipped: [conflict('a')], tryPackage: stoppedRun.tryPackage, stopped: () => true });
  assert.deepEqual(stoppedRun.calls, []);
  assert.deepEqual(out.skipped, [conflict('a')]);
});

test('secondPass: a reset that fails stops the pass and names the package', async () => {
  const t = fakeTry({ b: { ok: false, stage: 'verify', detail: 'red', files: [], fatal: 'fatal: index.lock exists' } });
  const res = await secondPass({
    packages: pkgs(['b'], ['c']),
    skipped: [conflict('b'), conflict('c')],
    tryPackage: t.tryPackage,
    stopped: never,
  });
  assert.deepEqual(res.fatal, { detail: 'fatal: index.lock exists', failedId: 'b' });
  assert.deepEqual(t.calls, [['b', true]], 'nothing after a failed reset');
  assert.equal(res.skipped[0].stage, 'verify');
});

test('secondPass: packages kept in by a fix-up are reported as such', async () => {
  const t = fakeTry({ b: { ok: true, fixedUp: true } });
  const res = await secondPass({ packages: pkgs(['b']), skipped: [conflict('b')], tryPackage: t.tryPackage, stopped: never });
  assert.deepEqual(res.fixedUp, ['b']);
});

test('skippedDependency / skipEntry: transitive blocker; bounded entry, fixup only when tried', () => {
  const dependsOf = new Map([
    ['c', ['b']],
    ['b', ['a']],
  ]);
  assert.equal(skippedDependency({ dependsOn: ['c'] }, dependsOf, new Set(['a'])), 'c');
  assert.equal(skippedDependency({ dependsOn: ['c'] }, dependsOf, new Set()), null);
  const long = skipEntry('a', { stage: 'verify', detail: 'x'.repeat(400), files: Array.from({ length: 12 }, (_, i) => `f${i}`) });
  assert.equal(long.detail.length, 300);
  assert.equal(long.files.length, 10);
  assert.equal('fixup' in long, false);
  assert.equal(skipEntry('a', { stage: 'verify', fixup: 'failed' }).fixup, 'failed');
});
