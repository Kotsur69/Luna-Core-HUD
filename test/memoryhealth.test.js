// ============================================================================
// LunaCore - memory sync health per PC (src/memoryhealth.js)
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { touch, createHealthProvider, summarize, HEARTBEAT_MS, SILENT_MS } = require('../src/memoryhealth.js');

function healthFile(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-health-'));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return path.join(dir, 'memory-health.local.json');
}

const T0 = 1_800_000_000_000;

test('writes the first heartbeat and then only when it is due', (t) => {
  const file = healthFile(t);

  assert.equal(touch(file, 'pc-a', { at: T0, count: 12 }), true);
  assert.equal(touch(file, 'pc-a', { at: T0 + HEARTBEAT_MS - 1, count: 12 }), false);
  assert.equal(touch(file, 'pc-a', { at: T0 + HEARTBEAT_MS, count: 12 }), true);
});

test('a changed memory count is news at once', (t) => {
  const file = healthFile(t);
  touch(file, 'pc-a', { at: T0, count: 12 });

  assert.equal(touch(file, 'pc-a', { at: T0 + 1000, count: 13 }), true);
  assert.deepEqual(summarize(file, 'pc-a', T0 + 2000), [{ machine: 'pc-a', at: T0 + 1000, count: 13, self: true, silent: false }]);
});

test('refuses a machine name or a beat that is not one', (t) => {
  const file = healthFile(t);

  assert.equal(touch(file, 'bad name!', { at: T0, count: 1 }), false);
  assert.equal(touch(file, 'pc-a', { at: -1, count: 1 }), false);
  assert.equal(touch(file, 'pc-a', { at: T0, count: 'many' }), false);
  assert.equal(fs.existsSync(file), false);
});

test('flags a PC that has been silent too long, this PC listed first', (t) => {
  const file = healthFile(t);
  const provider = createHealthProvider(file);
  provider.write([
    ['_health/home-pc', { at: T0 - SILENT_MS - 1, count: 3 }],
    ['_health/work-pc', { at: T0 - 1000, count: 12 }],
  ]);

  const lines = summarize(file, 'work-pc', T0);

  assert.deepEqual(
    lines.map((m) => [m.machine, m.self, m.silent]),
    [
      ['work-pc', true, false],
      ['home-pc', false, true],
    ],
  );
});

test('the provider publishes every known heartbeat and validates peers', (t) => {
  const file = healthFile(t);
  const provider = createHealthProvider(file);

  assert.deepEqual(provider.read(), { units: [], base: 0, fresh: true });
  touch(file, 'pc-a', { at: T0, count: 2 });

  assert.deepEqual(provider.read(), { units: [['_health/pc-a', { at: T0, count: 2 }]], base: 0, fresh: false });
  assert.equal(provider.owns('_health/pc-a'), true);
  assert.equal(provider.owns('_health/../x'), false);
  assert.equal(provider.owns('github.com/acme/demo/some-memory'), false);
  assert.deepEqual(provider.valid('_health/pc-a', { at: T0, count: 2, extra: 'x' }), { at: T0, count: 2 });
  assert.equal(provider.valid('_health/pc-a', { at: 'now', count: 2 }), null);
});

test('an unreadable health file gives an empty health line, not a crash', (t) => {
  const file = healthFile(t);
  fs.writeFileSync(file, '{ not json');

  assert.deepEqual(summarize(file, 'pc-a', T0), []);
});
