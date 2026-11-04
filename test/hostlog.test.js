// ============================================================================
// LunaCore - the host log file (src/hostlog.js)
// ----------------------------------------------------------------------------
// J-M (docs/REMOTE_HOST_PLAN.md "Security review"): host.log rotated only at
// start. Now it rotates whenever it passes the cap, one .old generation, and a
// failing write never throws into console.log.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createHostLog } = require('../src/hostlog');

function tmpLog(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-hostlog-'));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 5 }));
  return path.join(dir, 'logs', 'host.log');
}

test('J-M10: the log rotates while running once it passes the cap, keeping one .old', (t) => {
  const file = tmpLog(t);
  const log = createHostLog(file, { maxBytes: 100 });
  for (let i = 0; i < 4; i++) log.append(`first ${i} ${'x'.repeat(20)}`); // ~112 bytes: rotates once
  assert.ok(fs.existsSync(`${file}.old`), 'rotated without a restart');
  assert.match(fs.readFileSync(`${file}.old`, 'utf8'), /first 3/);
  assert.equal(log.size(), 0);
  log.append('second');
  assert.equal(fs.readFileSync(file, 'utf8'), 'second\n');
  for (let i = 0; i < 5; i++) log.append(`third ${i} ${'y'.repeat(20)}`);
  assert.doesNotMatch(fs.readFileSync(`${file}.old`, 'utf8'), /first/, 'only one old generation');
});

test('J-M10: an oversized log from the last run is rotated at start; a small one is appended to', (t) => {
  const file = tmpLog(t);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'z'.repeat(200));
  const log = createHostLog(file, { maxBytes: 100 });
  assert.equal(fs.existsSync(file), false);
  assert.equal(fs.readFileSync(`${file}.old`, 'utf8').length, 200);
  log.append('fresh');
  const again = createHostLog(file, { maxBytes: 100 });
  again.append('more');
  assert.equal(fs.readFileSync(file, 'utf8'), 'fresh\nmore\n');
  assert.equal(again.size(), 11);
});

test('a failing write never throws into the caller', () => {
  const broken = {
    mkdirSync: () => {},
    existsSync: () => false,
    statSync: () => ({ size: 0 }),
    appendFileSync: () => {
      throw Object.assign(new Error('locked'), { code: 'EBUSY' });
    },
    renameSync: () => {},
  };
  const log = createHostLog('/x/host.log', { fs: broken });
  assert.doesNotThrow(() => log.append('line'));
  assert.equal(log.size(), 0);
});
