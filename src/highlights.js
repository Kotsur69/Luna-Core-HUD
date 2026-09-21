// ============================================================================
// LunaCore - highlight extractor: batch tail-trim via system ffmpeg
// ----------------------------------------------------------------------------
// v1 scope: trim the last N seconds off every clip in a folder. ffmpeg is NOT
// bundled (would add 50-100MB+ to the app) - the user installs it separately,
// this module only detects it on PATH and shells out to it. Stream-copy
// (-c copy -sseof) for speed; this can land on a non-keyframe and clip the
// first fraction of a second of the trimmed output - a known v1 limitation,
// always surfaced in the UI, never silently promised as frame-accurate.
//
// SECURITY: buildTrimArgs() returns an argv ARRAY, never a shell string.
// execFile with an array never invokes a shell, so a path containing spaces,
// quotes or other shell-special characters cannot break out of its argument.
// Do not "simplify" this to a shell:true call with a concatenated string.
//
// Sequential, not parallel: the work is I/O-bound, and sequential keeps
// cancellation and per-file progress semantics trivial (one child process in
// flight at a time, one thing to kill).
// ============================================================================

'use strict';

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

const DEFAULT_EXTENSIONS = ['.mp4'];
const MAX_FILES = 300;
const FFMPEG_VERSION_TIMEOUT_MS = 5000;

/**
 * Extracts the version token from ffmpeg's `-version` first line, e.g.
 * "ffmpeg version 6.1.1 Copyright (c) 2000-2023 ..." -> "6.1.1", or a git
 * build's "ffmpeg version n6.1.1-3-g61a5da4c2c ..." -> "n6.1.1-3-g61a5da4c2c".
 * Tolerant of format drift across builds/distros - only the "version" keyword
 * position is relied on. Pure, so it's testable without spawning a process.
 * @param {string} stdout
 * @returns {string|null}
 */
function parseFfmpegVersionLine(stdout) {
  if (typeof stdout !== 'string' || !stdout) return null;
  const firstLine = stdout.split(/\r?\n/, 1)[0] || '';
  const match = firstLine.match(/version\s+(\S+)/i);
  return match ? match[1] : null;
}

/**
 * Detects a system ffmpeg on PATH. Never rejects/throws - ENOENT (not
 * installed) and any other spawn failure both resolve to {ok:false}.
 * @returns {Promise<{ok:boolean, version:string|null}>}
 */
function detectFfmpeg() {
  return new Promise((resolve) => {
    try {
      execFile('ffmpeg', ['-version'], { timeout: FFMPEG_VERSION_TIMEOUT_MS }, (err, stdout) => {
        if (err) {
          resolve({ ok: false, version: null });
          return;
        }
        resolve({ ok: true, version: parseFfmpegVersionLine(stdout) });
      });
    } catch {
      resolve({ ok: false, version: null });
    }
  });
}

/**
 * Case-insensitive extension filter, pure, order-preserving. Defaults to
 * ['.mp4'] when `extensions` is missing or empty.
 * @param {string[]} fileNames
 * @param {string[]} [extensions]
 * @returns {string[]}
 */
function filterVideoFiles(fileNames, extensions) {
  const names = Array.isArray(fileNames) ? fileNames : [];
  const exts = Array.isArray(extensions) && extensions.length ? extensions : DEFAULT_EXTENSIONS;
  const lowerExts = exts.map((ext) => String(ext).toLowerCase());
  return names.filter((name) => {
    const lower = String(name).toLowerCase();
    return lowerExts.some((ext) => lower.endsWith(ext));
  });
}

/**
 * Builds the ffmpeg argv for a tail-trim of one clip. Returns an ARRAY - see
 * this file's header for why that is a security property, not a style
 * choice. Returns null (never a coerced value) when `seconds` isn't a finite
 * number > 0; the caller must check for null and refuse to spawn.
 * @param {{inputPath:string, outputPath:string, seconds:number}} opts
 * @returns {string[]|null}
 */
function buildTrimArgs({ inputPath, outputPath, seconds } = {}) {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return null;
  return ['-y', '-sseof', '-' + String(seconds), '-i', inputPath, '-c', 'copy', outputPath];
}

/**
 * Lists the video files directly inside a folder (non-recursive), capped at
 * MAX_FILES entries. `folder` must resolve to a real, readable directory -
 * any failure (missing, a file, no access) yields {ok:false, reason:'bad-folder'}
 * rather than throwing.
 * @param {string} folder
 * @param {string[]} [extensions]
 * @returns {{ok:true, files:Array<{name:string,size:number}>, tooMany:boolean} | {ok:false, reason:'bad-folder'}}
 */
function listVideoFiles(folder, extensions) {
  try {
    if (typeof folder !== 'string' || !folder || !fs.statSync(folder).isDirectory()) {
      return { ok: false, reason: 'bad-folder' };
    }
  } catch {
    return { ok: false, reason: 'bad-folder' };
  }

  let names;
  try {
    names = fs.readdirSync(folder);
  } catch {
    return { ok: false, reason: 'bad-folder' };
  }

  const matched = filterVideoFiles(names, extensions);
  const tooMany = matched.length > MAX_FILES;
  const files = matched
    .slice(0, MAX_FILES)
    .map((name) => {
      try {
        return { name, size: fs.statSync(path.join(folder, name)).size };
      } catch {
        // Deleted/renamed between readdir and stat - drop it rather than crash.
        return null;
      }
    })
    .filter(Boolean);

  return { ok: true, files, tooMany };
}

/**
 * Batch orchestrator: trims every file in its list, sequentially, via
 * system ffmpeg. Never throws synchronously; every exec/fs call that touches
 * the outside world goes through a try/catch or a callback-error-first path.
 */
class HighlightBatchJob {
  /**
   * @param {Array<{name:string,size:number}>|string[]} files
   * @param {{sourceFolder:string, outputFolder:string, seconds:number, onProgress?:(payload:object)=>void}} opts
   */
  constructor(files, { sourceFolder, outputFolder, seconds, onProgress } = {}) {
    this.id = randomUUID();
    this.files = Array.isArray(files) ? files : [];
    this.sourceFolder = sourceFolder;
    this.outputFolder = outputFolder;
    this.seconds = seconds;
    this.onProgress = typeof onProgress === 'function' ? onProgress : () => {};
    this.cancelled = false;
    this.currentChild = null;
  }

  /** @param {object} payload */
  emit(payload) {
    try {
      this.onProgress({ jobId: this.id, ...payload });
    } catch {
      /* a bad listener must not take down the batch */
    }
  }

  /** Best-effort removal of a partial output left by a failed/killed ffmpeg run. */
  cleanupPartial(outputPath) {
    try {
      if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
    } catch {
      /* cleanup failure must not crash the batch */
    }
  }

  /** Runs one file's trim; resolves once that file is settled (done, error, or killed). */
  runOne(name, index, total) {
    return new Promise((resolve) => {
      const inputPath = path.join(this.sourceFolder, name);
      const outputPath = path.join(this.outputFolder, name);
      const args = buildTrimArgs({ inputPath, outputPath, seconds: this.seconds });
      if (!args) {
        this.emit({ event: 'file-error', file: name, index, total, reason: 'bad-seconds' });
        resolve();
        return;
      }

      this.emit({ event: 'file-start', file: name, index, total });

      this.currentChild = execFile('ffmpeg', args, (err) => {
        this.currentChild = null;
        if (err) {
          // Covers a genuine ffmpeg failure AND a kill() from cancel() - both
          // land here, and both must leave no partial file behind.
          this.cleanupPartial(outputPath);
          this.emit({ event: 'file-error', file: name, index, total, reason: 'ffmpeg-failed' });
          resolve();
          return;
        }
        this.emit({ event: 'file-done', file: name, index, total });
        resolve();
      });
    });
  }

  /** Runs the whole batch sequentially. Always settles (see class header). */
  async start() {
    const total = this.files.length;
    for (let index = 0; index < total; index++) {
      const raw = this.files[index];
      const name = typeof raw === 'string' ? raw : raw.name;
      if (this.cancelled) {
        this.emit({ event: 'file-cancelled', file: name, index, total });
        continue;
      }
      await this.runOne(name, index, total);
    }
    this.emit({ event: this.cancelled ? 'batch-cancelled' : 'batch-done', total });
  }

  /** Stops the batch: kills the in-flight file (if any) and marks the rest cancelled. */
  cancel() {
    this.cancelled = true;
    if (this.currentChild) this.currentChild.kill();
  }
}

module.exports = {
  detectFfmpeg,
  parseFfmpegVersionLine,
  filterVideoFiles,
  buildTrimArgs,
  listVideoFiles,
  HighlightBatchJob,
};
