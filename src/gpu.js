// ============================================================================
// LunaCore - GPU usage sampling (System tab, "just like CPU")
// ----------------------------------------------------------------------------
// Windows only, vendor-agnostic: reads the same DXGI "GPU Engine" performance
// counters Task Manager's own GPU column reads, via Get-Counter - no NVIDIA/AMD
// SDK, no native dependency. Summed across the *engtype_3D instances (one per
// process/adapter) and capped at 100, mirroring how Task Manager derives its
// single headline "GPU" percentage from the same counter family.
//
// Passive Observer: read-only, no write, no network, no token cost - same
// spirit as telemetry.js's os.* calls, just shelled out because Node has no
// built-in GPU counter API (see ports.js for the same execFile pattern).
//
// Kept OUT of telemetry.js on purpose: that module's whole contract is a pure,
// synchronous sample() fed by os.* calls (see its own header comment) so it
// stays trivially testable. Spawning powershell.exe is neither pure nor fast
// (100-300ms+), so it runs on its own slower timer here; main.js stamps the
// latest cached reading onto each telemetry tick's payload instead of this
// module ever touching IPC or the renderer.
// ============================================================================

'use strict';

const { execFile } = require('child_process');

const IS_WINDOWS = process.platform === 'win32';

/** Spawning a shell is heavy relative to os.*(); slower than telemetry.js's 2s. */
const SAMPLE_MS = 3000;

const PS_SCRIPT = `
$ErrorActionPreference='SilentlyContinue'
$c = Get-Counter '\\GPU Engine(*engtype_3D)\\Utilization Percentage' -ErrorAction SilentlyContinue
if ($c) {
  $sum = ($c.CounterSamples | Measure-Object -Property CookedValue -Sum).Sum
  [pscustomobject]@{ percent = [math]::Round([math]::Min(100,$sum)) } | ConvertTo-Json -Compress
}
`;

/** Runs a command and resolves with stdout; resolves '' on failure/timeout. */
function run(cmd, args) {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { windowsHide: true, maxBuffer: 1024 * 1024, timeout: 5000 },
      (err, stdout) => resolve(err ? '' : stdout)
    );
  });
}

/**
 * Parses the PowerShell script's stdout into { percent } or null.
 * Null covers every "nothing to show" case alike (no counter, RDP session
 * with no GPU exposed, malformed output) - same one-shape-for-unknown rule
 * telemetry.js uses for a machine that cannot report its CPU.
 * @param {string} stdout
 * @returns {{percent:number}|null}
 */
function parseGpu(stdout) {
  if (!stdout || !stdout.trim()) return null;
  let data;
  try {
    data = JSON.parse(stdout);
  } catch {
    return null;
  }
  const percent = data && typeof data.percent === 'number' && Number.isFinite(data.percent) ? data.percent : null;
  if (percent === null) return null;
  return { percent: Math.max(0, Math.min(100, Math.round(percent))) };
}

/** One-shot GPU sample. Resolves null off Windows or when the counter cannot be read. */
async function sampleGpu() {
  if (!IS_WINDOWS) return null;
  const out = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PS_SCRIPT]);
  return parseGpu(out);
}

/**
 * Samples the GPU on its own timer and keeps the latest reading cached.
 * `current()` is a plain getter - main.js reads it once per telemetry tick
 * (see startTelemetryWatcher) rather than this class pushing anything itself.
 */
class GpuSampler {
  constructor(intervalMs = SAMPLE_MS) {
    this.intervalMs = intervalMs;
    this.timer = null;
    this.latest = null;
    this.busy = false;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), this.intervalMs);
    if (this.timer.unref) this.timer.unref();
    this.tick(); // first reading immediately, do not wait a full interval
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick() {
    if (this.busy) return; // do not overlap shells if one is still spawning
    this.busy = true;
    try {
      this.latest = await sampleGpu();
    } finally {
      this.busy = false;
    }
  }

  /** Latest cached reading, or null before the first sample lands. */
  current() {
    return this.latest;
  }
}

// parseGpu is pure (string -> value|null) - exported for the tests. sampleGpu
// spawns a real process and GpuSampler wraps a real timer, so both are covered
// by the manual checklist instead, same as ports.js's scanPorts/PortWatcher.
module.exports = { sampleGpu, parseGpu, GpuSampler, IS_WINDOWS };
