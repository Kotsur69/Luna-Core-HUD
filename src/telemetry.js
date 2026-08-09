// ============================================================================
// LunaCore - E1: machine telemetry (RAM / CPU / uptime)
// ----------------------------------------------------------------------------
// PASSIVE OBSERVER in the strictest sense available: four calls into node's own
// `os` module, no shell-out, no native dependency, no network. Nothing here can
// cost a token, and nothing here can write.
//
// The A3 convention again (see paths.js, update.js): the arithmetic is pure and
// takes an os-LIKE object rather than requiring `os` itself, so `node --test`
// can hand it a 2-core machine with 32 GB of RAM and assert on the numbers.
// Only TelemetryWatcher touches the real thing.
//
// Two things about this data that are easy to get wrong:
//
//   * CPU PERCENT IS A DELTA, NOT A READING. `os.cpus()` reports cumulative tick
//     counters since boot. Sampling once and dividing gives you the average load
//     since the machine started - a number that is both wrong and almost
//     perfectly stable, which is the worst combination because it looks like it
//     works. Percent therefore needs TWO samples and is null until it has them.
//   * `os.loadavg()` IS A LIE ON WINDOWS. It is documented to return [0,0,0]
//     there, and this is a Windows-first app. Rendering "0.00 0.00 0.00" would
//     be a fabricated reading dressed as a measurement, so the payload carries
//     null and the widget says nothing rather than something false. Same rule as
//     D3's honest degradation and B4's costing: no estimate beats a wrong one.
// ============================================================================

'use strict';

/** How often the machine is sampled. Fast enough to feel live, slow enough to be free. */
const SAMPLE_MS = 2000;

/** Platforms where os.loadavg() reports real numbers rather than zeros. */
function hasLoadAverage(platform) {
  return platform !== 'win32';
}

/**
 * Sums the per-core tick counters into one idle/total pair.
 *
 * Returns null for an absent or empty core list: a machine that reports no CPUs
 * is not a machine at 0%, and the difference matters one call later where a
 * zero total would divide.
 *
 * @param {Array<{times:{user:number,nice:number,sys:number,idle:number,irq:number}}>} cpus
 * @returns {{idle:number, total:number}|null}
 */
function cpuTotals(cpus) {
  if (!Array.isArray(cpus) || !cpus.length) return null;

  let idle = 0;
  let total = 0;
  for (const cpu of cpus) {
    const times = cpu && cpu.times;
    if (!times) continue;
    for (const key of Object.keys(times)) {
      const v = times[key];
      if (typeof v === 'number' && Number.isFinite(v)) total += v;
    }
    if (typeof times.idle === 'number' && Number.isFinite(times.idle)) idle += times.idle;
  }

  if (total <= 0) return null;
  return { idle, total };
}

/**
 * Busy percent between two tick snapshots, or null when it cannot be known.
 *
 * Null happens legitimately on the first tick (no previous sample) and after a
 * suspend/resume where the counters can appear to go backwards. Both are
 * "unknown", not "idle".
 *
 * @param {{idle:number,total:number}|null} prev
 * @param {{idle:number,total:number}|null} cur
 * @returns {number|null} 0-100, whole
 */
function cpuPercent(prev, cur) {
  if (!prev || !cur) return null;

  const totalDelta = cur.total - prev.total;
  const idleDelta = cur.idle - prev.idle;
  if (!(totalDelta > 0) || idleDelta < 0) return null;

  const busy = ((totalDelta - idleDelta) / totalDelta) * 100;
  if (!Number.isFinite(busy)) return null;
  return Math.max(0, Math.min(100, Math.round(busy)));
}

/**
 * Memory in bytes plus the share in use.
 *
 * `free` is clamped into [0, total] before anything is derived from it, so a
 * bogus reading cannot produce a negative "used" or a bar past 100%.
 *
 * @returns {{total:number, free:number, used:number, percent:number}|null}
 */
function memStats(total, free) {
  if (typeof total !== 'number' || !Number.isFinite(total) || total <= 0) return null;
  if (typeof free !== 'number' || !Number.isFinite(free)) return null;

  const freeClamped = Math.max(0, Math.min(total, free));
  const used = total - freeClamped;

  return {
    total,
    free: freeClamped,
    used,
    percent: Math.max(0, Math.min(100, Math.round((used / total) * 100))),
  };
}

/**
 * One complete sample, built from an os-like object.
 *
 * Every field is independently nullable. A machine that cannot report its CPU
 * can still report its RAM, and the widget renders what it was given - the same
 * per-field honesty the usage gauge uses when a limit is unknown.
 *
 * @param {{totalmem:Function, freemem:Function, cpus:Function, uptime:Function,
 *          loadavg:Function, platform:Function}} osLike
 * @param {{idle:number,total:number}|null} prevTicks previous cpuTotals(), if any
 * @returns {{at:number, mem:object|null, cpu:object, uptime:number|null,
 *            load:number[]|null, ticks:object|null}}
 */
function sample(osLike, prevTicks) {
  const cpus = safe(osLike, 'cpus', []);
  const ticks = cpuTotals(cpus);
  const platform = safe(osLike, 'platform', '');

  const uptimeRaw = safe(osLike, 'uptime', null);
  const uptime =
    typeof uptimeRaw === 'number' && Number.isFinite(uptimeRaw) && uptimeRaw >= 0
      ? Math.floor(uptimeRaw)
      : null;

  return {
    at: Date.now(),
    mem: memStats(safe(osLike, 'totalmem', 0), safe(osLike, 'freemem', 0)),
    cpu: {
      percent: cpuPercent(prevTicks, ticks),
      cores: Array.isArray(cpus) ? cpus.length : 0,
      // Reported per core; they are identical in practice and the first is what
      // every system monitor shows. null means "not reported", not "0 MHz".
      speedMhz:
        Array.isArray(cpus) && cpus[0] && typeof cpus[0].speed === 'number'
          ? cpus[0].speed
          : null,
    },
    uptime,
    load: loadAverage(osLike, platform),
    // Carried so the watcher can feed it back in as prevTicks next tick. Stripped
    // before the payload crosses IPC - the renderer has no use for raw counters.
    ticks,
  };
}

/** os.loadavg() where it means something, null where it is hardcoded zeros. */
function loadAverage(osLike, platform) {
  if (!hasLoadAverage(platform)) return null;
  const load = safe(osLike, 'loadavg', null);
  if (!Array.isArray(load) || load.length < 3) return null;
  if (!load.every((n) => typeof n === 'number' && Number.isFinite(n))) return null;
  return load.slice(0, 3);
}

/** Calls osLike[name]() and falls back rather than throwing an unusable HUD. */
function safe(osLike, name, fallback) {
  try {
    const fn = osLike && osLike[name];
    if (typeof fn !== 'function') return fallback;
    const value = fn.call(osLike);
    return value === undefined || value === null ? fallback : value;
  } catch {
    return fallback;
  }
}

/** Drops the internal tick counters before the sample crosses IPC. */
function toPayload(s) {
  if (!s) return null;
  const { ticks: _ticks, ...payload } = s;
  return payload;
}

/**
 * Samples the machine on a timer and hands each reading to a callback.
 *
 * Deliberately UNLIKE PortWatcher, which only emits when the scan changed: this
 * is a time series, so an identical reading is still a data point. Suppressing
 * repeats would leave gaps in the sparkline that read as "flat" when they
 * actually mean "no sample", and the chart would silently lie about its own
 * time axis.
 */
class TelemetryWatcher {
  /** @param {(payload: object) => void} onUpdate */
  constructor(onUpdate, osLike = require('os'), intervalMs = SAMPLE_MS) {
    this.onUpdate = onUpdate;
    this.os = osLike;
    this.intervalMs = intervalMs;
    this.timer = null;
    this.prevTicks = null;
  }

  start() {
    if (this.timer) return;

    // Prime the tick counters WITHOUT emitting. The first sample can only ever
    // report cpu.percent = null, and a chart that opens with a null column looks
    // broken; one interval later everything is real.
    this.prevTicks = cpuTotals(safe(this.os, 'cpus', []));

    this.timer = setInterval(() => this.tick(), this.intervalMs);
    if (this.timer.unref) this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  tick() {
    const s = sample(this.os, this.prevTicks);
    this.prevTicks = s.ticks || this.prevTicks;
    this.onUpdate(toPayload(s));
  }
}

module.exports = {
  cpuTotals,
  cpuPercent,
  memStats,
  sample,
  toPayload,
  hasLoadAverage,
  TelemetryWatcher,
  SAMPLE_MS,
};
