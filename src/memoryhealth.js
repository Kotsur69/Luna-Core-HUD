// ============================================================================
// LunaCore - memory sync health: is every PC still syncing? (main + CLI)
// ----------------------------------------------------------------------------
// docs/untouched_docs/rag-stylememory.md, decision 15. A PC that stopped
// syncing would work from stale memory without any sign of it. So every PC
// publishes a heartbeat unit in the `memory` scope:
//
//   _health/<machine> = {at: <its last successful memory sync, ms>, count: <memories it holds>}
//
// and keeps everyone's in memory-health.local.json = {machines: {<machine>: {at, count}}}.
// summarize() turns that into the health line: a machine silent for longer
// than SILENT_MS is flagged.
//
// The heartbeat is coarse on purpose: it is rewritten at most every
// HEARTBEAT_MS (or when the memory count changes), because every write is a
// row the other PCs pull.
// ============================================================================

'use strict';

const fs = require('fs');
const path = require('path');
const { readDoc, writeAtomic } = require('./projectsync');
const { MACHINE_RE } = require('./missionledgersync');

const PREFIX = '_health/';
const HOUR_MS = 60 * 60 * 1000;
const HEARTBEAT_MS = 6 * HOUR_MS;
const SILENT_MS = 3 * 24 * HOUR_MS;
const MAX_COUNT = 1e6;

const isPlainObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const validBeat = (v) =>
  isPlainObject(v) && Number.isSafeInteger(v.at) && v.at >= 0 && Number.isSafeInteger(v.count) && v.count >= 0 && v.count <= MAX_COUNT
    ? { at: v.at, count: v.count }
    : null;
const machineOf = (k) => (typeof k === 'string' && k.startsWith(PREFIX) && MACHINE_RE.test(k.slice(PREFIX.length)) ? k.slice(PREFIX.length) : null);

/** {<machine>: {at, count}}; throws when the file exists but is unreadable. */
function readMachines(file) {
  const doc = readDoc(file);
  const out = {};
  for (const [name, beat] of Object.entries(isPlainObject(doc && doc.machines) ? doc.machines : {})) {
    const clean = validBeat(beat);
    if (MACHINE_RE.test(name) && clean) out[name] = clean;
  }
  return out;
}

function writeMachines(file, machines) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeAtomic(file, JSON.stringify({ machines }) + '\n');
}

/**
 * Records this PC's heartbeat when it is due.
 * @param {string} file memory-health.local.json
 * @param {string} machine
 * @param {{at: number, count: number}} beat at = the last successful memory sync
 * @returns {boolean} whether the file was written
 */
function touch(file, machine, beat) {
  const next = validBeat(beat);
  if (!MACHINE_RE.test(machine) || !next) return false;
  const machines = readMachines(file);
  const cur = machines[machine];
  if (cur && cur.count === next.count && next.at - cur.at < HEARTBEAT_MS) return false;
  writeMachines(file, { ...machines, [machine]: next });
  return true;
}

/** The heartbeats as a configsync.js provider (scope `memory`). */
function createHealthProvider(file) {
  return {
    name: 'memory-health',
    owns: (k) => machineOf(k) !== null,
    valid: (k, v) => (machineOf(k) ? validBeat(v) : null),
    read() {
      const machines = readMachines(file);
      // base 0: after a lost sync state the cloud's copies win until the next beat.
      return { units: Object.entries(machines).map(([name, beat]) => [PREFIX + name, beat]), base: 0, fresh: !fs.existsSync(file) };
    },
    write(units) {
      writeMachines(file, Object.fromEntries(units.map(([k, v]) => [machineOf(k), v])));
    },
  };
}

/**
 * The health line's data, this PC first.
 * @returns {{machine: string, at: number, count: number, self: boolean, silent: boolean}[]}
 */
function summarize(file, self, now = Date.now()) {
  let machines = {};
  try {
    machines = readMachines(file);
  } catch {
    machines = {};
  }
  return Object.entries(machines)
    .map(([machine, beat]) => ({ machine, ...beat, self: machine === self, silent: now - beat.at > SILENT_MS }))
    .sort((a, b) => Number(b.self) - Number(a.self) || a.machine.localeCompare(b.machine));
}

module.exports = { touch, createHealthProvider, summarize, HEARTBEAT_MS, SILENT_MS, PREFIX };
