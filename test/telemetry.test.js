// Tests for E1 - machine telemetry arithmetic (RAM / CPU / uptime). Pure
// functions fed a fake `os`, no I/O and no Electron.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');

const {
  cpuTotals,
  cpuPercent,
  memStats,
  sample,
  toPayload,
  hasLoadAverage,
  TelemetryWatcher,
  SAMPLE_MS,
} = require('../src/telemetry');

const GB = 1024 * 1024 * 1024;

/** A core with the given tick counters. */
function core(idle, busy, speed = 3400) {
  return { speed, times: { user: busy, nice: 0, sys: 0, idle, irq: 0 } };
}

/** A fake `os` - only what telemetry.js touches. */
function fakeOs(over = {}) {
  return {
    totalmem: () => 32 * GB,
    freemem: () => 12 * GB,
    cpus: () => [core(1000, 1000), core(1000, 1000)],
    uptime: () => 3600,
    loadavg: () => [1.5, 1.2, 0.9],
    platform: () => 'linux',
    ...over,
  };
}

// ---- cpuTotals: summing and empty cases --------------------------------

test('cpuTotals sums the counters of every core', () => {
  const r = cpuTotals([core(100, 300), core(200, 400)]);
  assert.equal(r.idle, 300);
  assert.equal(r.total, 1000);
});

test('cpuTotals returns null for no cores', () => {
  assert.equal(cpuTotals([]), null);
  assert.equal(cpuTotals(null), null);
  assert.equal(cpuTotals(undefined), null);
});

// A machine with no CPU reading is not a machine at 0% - null must propagate,
// because a line later we'd be dividing by zero.
test('cpuTotals distinguishes a missing reading from zero load', () => {
  assert.equal(cpuTotals([{ times: { user: 0, idle: 0 } }]), null);
});

test('cpuTotals skips a core with no times field instead of throwing', () => {
  const r = cpuTotals([core(100, 100), {}, null]);
  assert.equal(r.total, 200);
});

// ---- cpuPercent: this is a DELTA, not a reading ---------------------------------

test('cpuPercent computes busy time from the difference of two samples', () => {
  const prev = { idle: 1000, total: 2000 };
  const cur = { idle: 1100, total: 2200 }; // 200 ticks, of which 100 idle
  assert.equal(cpuPercent(prev, cur), 50);
});

test('cpuPercent without a previous sample returns null, not zero', () => {
  assert.equal(cpuPercent(null, { idle: 1, total: 2 }), null);
});

test('cpuPercent returns null when the counter did not move', () => {
  const same = { idle: 1000, total: 2000 };
  assert.equal(cpuPercent(same, same), null);
});

// After a machine sleeps, counters can go backward. That's "unknown",
// not "idle".
test('cpuPercent returns null when the counters went backward', () => {
  assert.equal(cpuPercent({ idle: 1000, total: 2000 }, { idle: 900, total: 1900 }), null);
});

test('cpuPercent stays within the 0-100 range', () => {
  const r = cpuPercent({ idle: 0, total: 0 }, { idle: 0, total: 1000 });
  assert.equal(r, 100);
});

// ---- memStats ---------------------------------------------------------------

test('memStats computes usage and percent', () => {
  const r = memStats(32 * GB, 12 * GB);
  assert.equal(r.used, 20 * GB);
  assert.equal(r.percent, 63);
});

test('memStats returns null for a nonsensical total', () => {
  assert.equal(memStats(0, 0), null);
  assert.equal(memStats(-1, 0), null);
  assert.equal(memStats(NaN, 0), null);
});

// A reading of "more free than total" must not produce negative usage or a bar
// running off the edge of the panel.
test('memStats clamps an absurd reading instead of propagating it', () => {
  const r = memStats(8 * GB, 99 * GB);
  assert.equal(r.used, 0);
  assert.equal(r.percent, 0);
  const r2 = memStats(8 * GB, -5);
  assert.equal(r2.percent, 100);
});

// ---- sample: each field can individually be unknown ---------------------------

test('sample assembles a full reading', () => {
  const s = sample(fakeOs(), { idle: 1000, total: 3000 });
  assert.equal(s.mem.percent, 63);
  assert.equal(s.cpu.cores, 2);
  assert.equal(s.cpu.speedMhz, 3400);
  assert.equal(s.uptime, 3600);
  assert.deepEqual(s.load, [1.5, 1.2, 0.9]);
});

test('sample without previous ticks yields cpu.percent = null', () => {
  const s = sample(fakeOs(), null);
  assert.equal(s.cpu.percent, null);
  assert.notEqual(s.mem, null, 'a missing CPU reading must not take the RAM reading with it');
});

test('sample survives an os that throws', () => {
  const s = sample(
    fakeOs({
      cpus: () => {
        throw new Error('no access');
      },
    }),
    null
  );
  assert.equal(s.cpu.cores, 0);
  assert.notEqual(s.mem, null);
});

test('sample is resilient to a negative uptime', () => {
  assert.equal(sample(fakeOs({ uptime: () => -1 }), null).uptime, null);
  assert.equal(sample(fakeOs({ uptime: () => NaN }), null).uptime, null);
});

// THIS IS THE IMPORTANT ONE. os.loadavg() on Windows returns [0,0,0] by
// definition, and this is an app written for Windows. Showing "0.00 0.00 0.00"
// would be a made-up reading pretending to be a real measurement.
test('load average is null on Windows, not three zeros', () => {
  const s = sample(fakeOs({ platform: () => 'win32', loadavg: () => [0, 0, 0] }), null);
  assert.equal(s.load, null);
  assert.equal(hasLoadAverage('win32'), false);
  assert.equal(hasLoadAverage('linux'), true);
  assert.equal(hasLoadAverage('darwin'), true);
});

test('sample rejects an incomplete loadavg', () => {
  assert.equal(sample(fakeOs({ loadavg: () => [1.0] }), null).load, null);
  assert.equal(sample(fakeOs({ loadavg: () => 'lots' }), null).load, null);
});

// ---- toPayload: counters do not cross the IPC boundary --------------------------

test('toPayload strips the raw tick counters', () => {
  const s = sample(fakeOs(), null);
  assert.notEqual(s.ticks, undefined, 'sample() keeps ticks for the watcher to use');
  assert.equal(toPayload(s).ticks, undefined, 'but the renderer never gets them');
  assert.notEqual(toPayload(s).mem, undefined);
});

test('toPayload returns null for empty input', () => {
  assert.equal(toPayload(null), null);
});

// ---- TelemetryWatcher -------------------------------------------------------

test('the watcher emits a sample on every tick, even an unchanged one', () => {
  const seen = [];
  const w = new TelemetryWatcher((p) => seen.push(p), fakeOs());
  w.start();
  w.tick();
  w.tick();
  w.stop();

  assert.equal(seen.length, 2, 'time series: an identical reading is still a data point');
  assert.equal(seen[0].ticks, undefined);
});

// The first CPU reading would always be null - the watcher grabs a baseline in
// start() so the chart doesn't open with an empty column.
test('the watcher grabs a baseline in start(), so the first tick already knows CPU', () => {
  let n = 0;
  const osLike = fakeOs({
    // Each call advances the counters, just like on a live machine.
    cpus: () => {
      n += 1;
      return [core(1000 * n, 1000 * n)];
    },
  });

  const seen = [];
  const w = new TelemetryWatcher((p) => seen.push(p), osLike);
  w.start();
  w.tick();
  w.stop();

  assert.notEqual(seen[0].cpu.percent, null, 'the baseline from start() must already work');
});

test('the watcher does not start two timers', () => {
  const w = new TelemetryWatcher(() => {}, fakeOs());
  w.start();
  const first = w.timer;
  w.start();
  assert.equal(w.timer, first);
  w.stop();
  assert.equal(w.timer, null);
});

// ---- Data test: the fake must match the real `os` ------------------
//
// A suite built entirely on fakes can be green while the shape of the real API
// is different. This is the same pattern that caught the missing Opus 5 in rates.json.

test('the real os.cpus() has the shape cpuTotals expects', () => {
  const r = cpuTotals(os.cpus());
  assert.notEqual(r, null, 'this machine reported not a single core');
  assert.ok(r.total > 0);
  assert.ok(r.idle >= 0 && r.idle <= r.total);
});

test('the real os yields a complete sample', () => {
  const s = sample(os, null);
  assert.notEqual(s.mem, null);
  assert.ok(s.mem.total > 0);
  assert.ok(s.cpu.cores > 0);
  assert.equal(typeof s.uptime, 'number');
});

test('the sampling interval is sensible', () => {
  assert.ok(SAMPLE_MS >= 1000, 'more often than once a second is already a cost, not a measurement');
  assert.ok(SAMPLE_MS <= 10000, 'less often than every 10s and the chart stops feeling "live"');
});
