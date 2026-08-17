// Tests for E1 (renderer side) - the sample buffer and reading formatting.
//
// Deliberately split from test/telemetry.test.js: that file guards the
// ARITHMETIC in the main process, this one guards what the user actually
// reads. A formatting bug doesn't crash anything, it just calmly shows the
// wrong number - exactly the class of bug that survived three sparkline refactors.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  pushTelemetry,
  telemetryHistory,
  barLevel,
  formatBytes,
  formatUptime,
  formatLoad,
  TELEM_MAX,
  TELEM_WARN,
  TELEM_CRIT,
} = require('../src/renderer/modules/telemetry.js');

const GIB = 1024 * 1024 * 1024;

// ---- Sample buffer ------------------------------------------------------------

test('pushTelemetry trims the series to TELEM_MAX', () => {
  for (let i = 0; i < TELEM_MAX + 15; i += 1) pushTelemetry({ at: i, mem: null, cpu: {} });
  const h = telemetryHistory();
  assert.equal(h.length, TELEM_MAX);
  // The NEWEST samples remain, not the oldest.
  assert.equal(h[h.length - 1].at, TELEM_MAX + 14);
});

test('pushTelemetry ignores garbage instead of letting it into the chart', () => {
  const before = telemetryHistory().length;
  pushTelemetry(null);
  pushTelemetry(undefined);
  pushTelemetry('42%');
  assert.equal(telemetryHistory().length, before);
});

// ---- Thresholds ------------------------------------------------------------

test('barLevel splits the range into three bands', () => {
  assert.equal(barLevel(0), 'ok');
  assert.equal(barLevel(TELEM_WARN - 1), 'ok');
  assert.equal(barLevel(TELEM_WARN), 'warn');
  assert.equal(barLevel(TELEM_CRIT - 1), 'warn');
  assert.equal(barLevel(TELEM_CRIT), 'crit');
  assert.equal(barLevel(100), 'crit');
});

// "Unknown" is not the same as "0%". A zero bar would lie about the reading.
test('barLevel separates a missing reading from zero', () => {
  assert.equal(barLevel(null), 'unknown');
  assert.equal(barLevel(undefined), 'unknown');
  assert.equal(barLevel(NaN), 'unknown');
  assert.equal(barLevel(0), 'ok');
});

// Machine thresholds must NOT be the same as context window thresholds - context
// at 60% is heading toward compact, a machine at 60% RAM is just working normally.
test('machine thresholds are higher than context window thresholds', () => {
  const { CTX_WARN_MID, CTX_WARN_HIGH } = require('../src/renderer/modules/thresholds.js');
  assert.ok(TELEM_WARN / 100 > CTX_WARN_MID);
  assert.ok(TELEM_CRIT / 100 > CTX_WARN_HIGH);
});

// ---- Formatting -----------------------------------------------------------

test('formatBytes computes in GiB, the way the system does', () => {
  assert.equal(formatBytes(32 * GIB), '32.0 GB');
  assert.equal(formatBytes(19.84 * GIB), '19.8 GB');
  assert.equal(formatBytes(0), '0.0 GB');
});

test('formatBytes returns null for a non-number', () => {
  assert.equal(formatBytes(null), null);
  assert.equal(formatBytes(-1), null);
  assert.equal(formatBytes(NaN), null);
  assert.equal(formatBytes('8GB'), null);
});

test('formatUptime shows days only once there are any', () => {
  assert.equal(formatUptime(0), '00:00');
  assert.equal(formatUptime(3600 + 17 * 60), '01:17');
  assert.equal(formatUptime(4 * 86400 + 2 * 3600 + 17 * 60), '4d 02:17');
});

// The line width must not jump every minute - hence padStart.
test('formatUptime keeps a fixed width for hours and minutes', () => {
  assert.equal(formatUptime(60), '00:01');
  assert.equal(formatUptime(9 * 3600 + 5 * 60), '09:05');
});

test('formatUptime returns null for nonsensical input', () => {
  assert.equal(formatUptime(-1), null);
  assert.equal(formatUptime(NaN), null);
  assert.equal(formatUptime(null), null);
});

test('formatLoad joins three numbers to two decimal places', () => {
  assert.equal(formatLoad([1.5, 1.25, 0.9]), '1.50  1.25  0.90');
});

// This is the important one on the UI side: on Windows the payload carries
// null, and the widget must then NOT write anything - instead of three zeros pretending to be a reading.
test('formatLoad returns null when there is no measurement', () => {
  assert.equal(formatLoad(null), null);
  assert.equal(formatLoad([]), null);
  assert.equal(formatLoad([1.0, 2.0]), null);
  assert.equal(formatLoad(['1.0', '2.0', '3.0']), null);
});

// ---- Both halves together ------------------------------------------------------
//
// Same pattern as spark.test.js: fields that one side writes and the other
// reads must be checked in a single pass - otherwise a typo in a field name
// slips through both suites.

test('a sample from src/telemetry.js flows through the buffer and formatters', () => {
  const os = require('node:os');
  const { sample, toPayload } = require('../src/telemetry.js');

  const payload = toPayload(sample(os, null));
  pushTelemetry(payload);
  const last = telemetryHistory()[telemetryHistory().length - 1];

  assert.equal(last, payload);
  assert.notEqual(formatBytes(last.mem.used), null, 'mem.used must exist under this name');
  assert.notEqual(formatBytes(last.mem.total), null, 'mem.total must exist under this name');
  assert.notEqual(formatUptime(last.uptime), null, 'uptime must exist under this name');
  assert.equal(typeof last.cpu.cores, 'number', 'cpu.cores must exist under this name');
  assert.notEqual(barLevel(last.mem.percent), 'unknown', 'mem.percent must be a number');
});
