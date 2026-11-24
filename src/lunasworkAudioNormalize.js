// ============================================================================
// LunaCore - optional ffmpeg post-process for game audio (Luna's Work assets)
// ----------------------------------------------------------------------------
// Imported library audio (src/lunasworkFreeAssets.js) and ComfyUI audio drafts
// (src/lunasworkAssetPipeline.js) can opt in with
//   audioPost: { trim?, loudnorm?, targetBpm?, bpm? }
// and get, in this order:
//   1. leading silence stripped (silenceremove), so a hit-stop / parry SFX
//      fires on frame 0;
//   2. a time-stretch to targetBpm (atempo, chained when the ratio is outside
//      0.5..2.0), when both targetBpm and the source bpm are given;
//   3. integrated loudness normalized to TARGET_LUFS, in two passes. The
//      first pass measures (loudnorm print_format=json, the clip padded with
//      silence to SHORT_CLIP_SECONDS so a sub-second SFX still has the 400 ms
//      gating blocks BS.1770 needs); the second applies that measurement as
//      one plain gain (volume). Single-pass loudnorm cannot measure a clip
//      under 400 ms at all and guesses on clips under 3 s, which left short
//      SFX off target. When a plain gain to TARGET_LUFS would push the true
//      peak over TRUE_PEAK_DB (less PEAK_HEADROOM_DB, for the resample and
//      the encode), the second pass falls back to single-pass
//      loudnorm (which limits instead) and, when that can leave the clip more
//      than LOUDNESS_TOLERANCE_LU under target, the answer says so and why.
//
// The ffmpeg binary is always an absolute path: the caller's fixed path, else
// LUNACORE_FFMPEG_PATH when set (it must name an existing file), else the
// first ffmpeg(.exe) file found in an absolute folder of PATH outside the
// project repo. A bare "ffmpeg" is never handed to execFile, so the working
// folder cannot supply it.
//
// ffmpeg runs through execFile with plain argument tokens: no shell, no
// command line built from strings. The output goes to a random temp file
// next to the target and is renamed over it only when ffmpeg succeeded and
// produced a non-empty file of the same format. Any failure (ffmpeg missing,
// a non-zero exit, an empty or wrong output) keeps the original file as it was
// and comes back as an informational note: imported audio is never lost.
//
// Lock hold time: ffmpeg never runs under a caller's lock. A caller that
// serializes its repo writes passes `commitLock`, which is taken only around
// the final guard + rename of each file, so a large audio pack does not hold
// the lock for minutes of ffmpeg work.
// ============================================================================

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');

// Streaming platforms and most game mixes sit at -14 LUFS integrated.
const TARGET_LUFS = -14;
const TRUE_PEAK_DB = -1.5;
const LOUDNESS_RANGE = 11;
// The agreed loudness tolerance: a normalized clip lands within this many LU
// of TARGET_LUFS, measured the way the first pass measures (BS.1770 integrated
// loudness, the clip padded with silence to SHORT_CLIP_SECONDS). The plain-gain
// path is exact up to rounding (about 0.01 LU); only a clip whose true peak
// blocks the gain can miss it, and then the answer carries a note.
const LOUDNESS_TOLERANCE_LU = 1;
// A plain gain has no limiter, and the 48 kHz resample and a lossy encode can
// lift the true peak a little: the gain is used only when it keeps the
// measured peak this far under TRUE_PEAK_DB.
const PEAK_HEADROOM_DB = 0.5;
// Clips shorter than this are padded with silence for the measurement only.
const SHORT_CLIP_SECONDS = 1;
// The ranges loudnorm reports its measurement in; anything else (e.g. "-inf"
// for a silent clip) is not a usable measurement.
const MEASURE_RANGES = Object.freeze({ i: [-99, 0], tp: [-99, 99], lra: [0, 99], thresh: [-99, 0] });
// Set by the user to pin the ffmpeg binary, like LUNACORE_MPV_PATH for mpv.
const FFMPEG_PATH_ENV = 'LUNACORE_FFMPEG_PATH';
// Anything quieter than this at the start counts as silence.
const SILENCE_THRESHOLD_DB = -50;
const MIN_BPM = 40;
const MAX_BPM = 300;
// The range one atempo filter accepts.
const ATEMPO_MIN = 0.5;
const ATEMPO_MAX = 2.0;
const OUTPUT_SAMPLE_RATE = 48000;
const FFMPEG_TIMEOUT_MS = 120000;
const FFMPEG_MAX_BUFFER = 4 * 1024 * 1024;
const MAX_REASON_CHARS = 200;
const AUDIO_EXTS = Object.freeze(['wav', 'ogg', 'mp3']);
const HEAD_BYTES = 16;
// Below this the output is a bare header (e.g. a file that was all silence and got trimmed to nothing).
const MIN_OUTPUT_BYTES = 1024;
const POST_FIELDS = Object.freeze(['trim', 'loudnorm', 'targetBpm', 'bpm']);

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
// eslint-disable-next-line no-control-regex
const oneLine = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f\s]+/g, ' ').trim().slice(0, max);
const errText = (err) => (err instanceof Error ? err.message : String(err));
const extOf = (rel) => path.posix.extname(rel).slice(1).toLowerCase();
// Whole BPM only, as the luna_asset_* schemas say (src/lunasworkAssetTools.js).
const isBpm = (v) => Number.isInteger(v) && v >= MIN_BPM && v <= MAX_BPM;
const unquote = (v) => v.trim().replace(/^"(.*)"$/, '$1');

// The first bytes each audio format starts with; the output must keep its format.
const AUDIO_MAGIC = Object.freeze({
  wav: (b) => b.length >= 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WAVE',
  ogg: (b) => b.length >= 4 && b.toString('latin1', 0, 4) === 'OggS',
  mp3: (b) => (b.length >= 3 && b.toString('latin1', 0, 3) === 'ID3') || (b.length >= 2 && b[0] === 0xff && (b[1] & 0xe0) === 0xe0),
});

/**
 * The validated audioPost option. Undefined -> no post-process. trim and
 * loudnorm default to true once audioPost is given; targetBpm and bpm go
 * together, each an integer within MIN_BPM..MAX_BPM.
 * @returns {{ok:true, post:null|{trim:boolean, loudnorm:boolean, targetBpm:number|null, bpm:number|null}}|{ok:false, error:string, detail:string}}
 */
function cleanAudioPost(raw) {
  if (raw === undefined || raw === null) return { ok: true, post: null };
  const bad = (detail) => ({ ok: false, error: 'badAudioPost', detail });
  if (!isObj(raw)) return bad(`audioPost must be an object {${POST_FIELDS.join(', ')}}`);
  const extra = Object.keys(raw).find((k) => !POST_FIELDS.includes(k));
  if (extra) return bad(`audioPost has an unknown field ${oneLine(extra, 40)}; use ${POST_FIELDS.join(', ')}`);
  for (const k of ['trim', 'loudnorm']) {
    if (raw[k] !== undefined && typeof raw[k] !== 'boolean') return bad(`audioPost.${k} must be true or false`);
  }
  const hasTarget = raw.targetBpm !== undefined;
  const hasSource = raw.bpm !== undefined;
  if (hasTarget !== hasSource) return bad('audioPost.targetBpm needs the source bpm (and bpm needs targetBpm)');
  if (hasTarget && (!isBpm(raw.targetBpm) || !isBpm(raw.bpm))) return bad(`audioPost.targetBpm and bpm must be integers from ${MIN_BPM} to ${MAX_BPM}`);
  const post = {
    trim: raw.trim !== false,
    loudnorm: raw.loudnorm !== false,
    targetBpm: hasTarget ? raw.targetBpm : null,
    bpm: hasSource ? raw.bpm : null,
  };
  return { ok: true, post: post.trim || post.loudnorm || stretches(post) ? post : null };
}

const stretches = (post) => post.targetBpm !== null && post.bpm !== null && post.targetBpm !== post.bpm;

/** A number as a short filter token: "1.25", "0.5", never exponent notation. */
const num = (v) => String(Number(v.toFixed(6)));

/**
 * The atempo factors whose product is `ratio`, each within ATEMPO_MIN..ATEMPO_MAX.
 * @param {number} ratio target / source tempo, > 0
 * @returns {number[]}
 */
function atempoChain(ratio) {
  if (!(typeof ratio === 'number' && Number.isFinite(ratio) && ratio > 0)) throw new Error('the tempo ratio must be a positive number');
  const out = [];
  let rest = ratio;
  while (rest > ATEMPO_MAX) {
    out.push(ATEMPO_MAX);
    rest /= ATEMPO_MAX;
  }
  while (rest < ATEMPO_MIN) {
    out.push(ATEMPO_MIN);
    rest /= ATEMPO_MIN;
  }
  out.push(rest);
  return out;
}

const LOUDNORM = `loudnorm=I=${TARGET_LUFS}:TP=${TRUE_PEAK_DB}:LRA=${LOUDNESS_RANGE}`;

/** The filters before the loudness step: trim -> tempo. */
function shapeFilters(post) {
  const filters = [];
  if (post.trim) filters.push(`silenceremove=start_periods=1:start_duration=0:start_threshold=${SILENCE_THRESHOLD_DB}dB`);
  if (stretches(post)) for (const f of atempoChain(post.targetBpm / post.bpm)) filters.push(`atempo=${num(f)}`);
  return filters;
}

/**
 * The -af filter graph of a cleaned post: trim -> tempo -> loudness (loudness
 * last, after the stretch). With a `gainDb` from the measuring pass the
 * loudness step is that plain gain; without one it is single-pass loudnorm.
 * @param {object} post a cleaned post
 * @param {number} [gainDb]
 */
function audioFilter(post, gainDb) {
  const filters = shapeFilters(post);
  if (post.loudnorm) filters.push(typeof gainDb === 'number' && Number.isFinite(gainDb) ? `volume=${num(gainDb)}dB` : LOUDNORM);
  return filters.join(',');
}

/** The measuring pass's graph: the same shaping, silence padding for short clips, loudnorm printing its JSON. */
function measureFilter(post) {
  return [...shapeFilters(post), `apad=whole_dur=${SHORT_CLIP_SECONDS}`, `${LOUDNORM}:print_format=json`].join(',');
}

/**
 * The ffmpeg argument tokens: errors only on stderr, never overwrite (-n), no
 * stdin, local files only (an input that declares a playlist cannot fetch
 * URLs), audio only, the output format from the output's extension.
 */
function ffmpegArgs(input, output, post, gainDb) {
  return ['-hide_banner', '-loglevel', 'error', '-nostdin', '-n', '-protocol_whitelist', 'file', '-i', input, '-vn', '-af', audioFilter(post, gainDb), '-ar', String(OUTPUT_SAMPLE_RATE), output];
}

/**
 * The measuring pass's tokens: info level, because loudnorm prints its JSON
 * there; no output file (the null muxer).
 */
function measureArgs(input, post) {
  return ['-hide_banner', '-nostats', '-loglevel', 'info', '-nostdin', '-protocol_whitelist', 'file', '-i', input, '-vn', '-af', measureFilter(post), '-f', 'null', '-'];
}

/**
 * loudnorm's measurement from the measuring pass's stderr (the JSON object
 * holding the last "input_i"), or null when it is missing or not usable (a
 * silent clip reports "-inf").
 * @returns {{i:number, tp:number, lra:number, thresh:number}|null}
 */
function parseMeasurement(stderr) {
  const text = String(stderr || '');
  const key = text.lastIndexOf('"input_i"');
  const start = key < 0 ? -1 : text.lastIndexOf('{', key);
  const end = start < 0 ? -1 : text.indexOf('}', key);
  if (end < 0) return null;
  let raw;
  try {
    raw = JSON.parse(text.slice(start, end + 1));
  } catch {
    // Not loudnorm's JSON: the caller reports the clip as not measurable.
    return null;
  }
  if (!isObj(raw)) return null;
  const m = {};
  for (const [k, [lo, hi]] of Object.entries(MEASURE_RANGES)) {
    const given = raw[`input_${k}`];
    // Number('') is 0: an empty value must not read as a measurement.
    const v = (typeof given === 'string' && given.trim()) || typeof given === 'number' ? Number(given) : NaN;
    if (!Number.isFinite(v) || v < lo || v > hi) return null;
    m[k] = v;
  }
  return m;
}

/**
 * How a measured clip gets to TARGET_LUFS. `gainDb` = the plain gain when it
 * fits under the true-peak ceiling, else null (single-pass loudnorm limits
 * instead); `note` = why the clip can end more than LOUDNESS_TOLERANCE_LU
 * under target, or null.
 * @param {{i:number, tp:number}} m the measurement
 * @returns {{gainDb:number|null, note:string|null}}
 */
function loudnessPlan(m) {
  const gainDb = TARGET_LUFS - m.i;
  if (m.tp + gainDb <= TRUE_PEAK_DB - PEAK_HEADROOM_DB) return { gainDb, note: null };
  const reachable = m.i + (TRUE_PEAK_DB - m.tp);
  if (TARGET_LUFS - reachable <= LOUDNESS_TOLERANCE_LU) return { gainDb: null, note: null };
  const r1 = (v) => (Math.round(v * 10) / 10).toFixed(1);
  return {
    gainDb: null,
    note: `measured ${r1(m.i)} LUFS with a true peak of ${r1(m.tp)} dBTP, so a plain gain to ${TARGET_LUFS} LUFS would push the peak past the ${TRUE_PEAK_DB} dBTP ceiling. loudnorm limited it instead: that reaches ${TARGET_LUFS} LUFS on clips of 3 s or more, but a shorter clip is held at the ceiling and can end near ${r1(reachable)} LUFS, more than ${LOUDNESS_TOLERANCE_LU} LU under target`,
  };
}

// On Windows "\foo" counts as absolute but resolves against the current drive: a drive or UNC root is required.
const WIN_ROOTED_RE = /^(?:[a-zA-Z]:[\\/]|\\\\[^\\/])/;
const isFullPath = (pathApi, p) => pathApi.isAbsolute(p) && (pathApi !== path.win32 || WIN_ROOTED_RE.test(p));

/** True when `p` is a full path to an existing regular file. */
function isFileAt(fsx, pathApi, p) {
  if (typeof p !== 'string' || !p || !isFullPath(pathApi, p)) return false;
  try {
    return fsx.statSync(p).isFile();
  } catch {
    // A missing or unreadable path is simply not a candidate.
    return false;
  }
}

/** An environment variable, matched case-insensitively on Windows (Path vs PATH). */
function envValue(env, name, platform) {
  if (!isObj(env)) return undefined;
  if (platform !== 'win32') return env[name];
  const key = Object.keys(env).find((k) => k.toUpperCase() === name);
  return key === undefined ? undefined : env[key];
}

/**
 * The absolute ffmpeg binary: LUNACORE_FFMPEG_PATH when set, else the first
 * ffmpeg file in an absolute PATH folder. Relative PATH entries (".") are
 * skipped, so a file planted in the working folder is never run, and so is a
 * PATH folder inside `untrustedRoot` (the project repo a worker writes to).
 * @param {{fs?:object, env?:object, platform?:string, untrustedRoot?:string}} [opts]
 * @returns {{ok:true, path:string}|{ok:false, why:string}}
 */
function locateFfmpeg(opts = {}) {
  const fsx = opts.fs || fs;
  const env = opts.env || process.env;
  const platform = opts.platform || process.platform;
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const exe = platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  const pinned = envValue(env, FFMPEG_PATH_ENV, platform);
  if (typeof pinned === 'string' && pinned.trim()) {
    const p = unquote(pinned);
    if (isFileAt(fsx, pathApi, p)) return { ok: true, path: pathApi.normalize(p) };
    return { ok: false, why: `ffmpeg was not found: ${FFMPEG_PATH_ENV} is set but is not the absolute path of an existing file (fix it, or unset it to use ${exe} from PATH)` };
  }
  const dirs = String(envValue(env, 'PATH', platform) || '').split(platform === 'win32' ? ';' : ':');
  const inUntrusted = (dir) => {
    if (typeof opts.untrustedRoot !== 'string' || !opts.untrustedRoot) return false;
    const rel = pathApi.relative(pathApi.resolve(opts.untrustedRoot), pathApi.resolve(dir));
    return rel === '' || (!rel.startsWith('..') && !pathApi.isAbsolute(rel));
  };
  for (const raw of dirs) {
    const dir = unquote(raw);
    if (!dir || !isFullPath(pathApi, dir) || inUntrusted(dir)) continue;
    const candidate = pathApi.join(dir, exe);
    if (isFileAt(fsx, pathApi, candidate)) return { ok: true, path: candidate };
  }
  return { ok: false, why: `ffmpeg was not found on PATH (install ffmpeg, or set ${FFMPEG_PATH_ENV} to the full path of ${exe})` };
}

/**
 * The temp output next to `rel`: dot-prefixed, so a running Unity editor
 * ignores it, and ending in the extension, so ffmpeg picks the format from it.
 */
function tempRelOf(rel, ext) {
  const dir = path.posix.dirname(rel);
  const name = `.${path.posix.basename(rel)}.${crypto.randomBytes(6).toString('hex')}.tmp.${ext}`;
  return dir === '.' ? name : `${dir}/${name}`;
}

/** The steps a post applies, for the answer. */
function appliedSteps(post) {
  const steps = [];
  if (post.trim) steps.push('leading silence trimmed');
  if (stretches(post)) steps.push(`tempo ${post.bpm} -> ${post.targetBpm} BPM`);
  if (post.loudnorm) steps.push(`${TARGET_LUFS} LUFS`);
  return steps;
}

const runUnlocked = async (fn) => fn();

/**
 * @param {{execFile?:Function, fs:object, guard:(rel:string)=>string, timeoutMs?:number,
 *   ffmpegPath?:string, env?:object, platform?:string, repoPath?:string}} deps
 *   guard = the repo path guard: rel -> absolute path, throws outside the repo;
 *   ffmpegPath = a fixed absolute ffmpeg binary (else LUNACORE_FFMPEG_PATH / PATH, looked up once);
 *   repoPath = the repo the worker writes to: an ffmpeg on PATH inside it is never used
 * @returns {{normalize:(rel:string, post:object, opts?:{commitLock?:(fn:Function)=>Promise<unknown>})=>Promise<{ok:boolean, rel:string, steps?:string[], note?:string}>}}
 */
function createAudioNormalizer(deps) {
  const execFile = typeof deps.execFile === 'function' ? deps.execFile : childProcess.execFile;
  const fsx = deps.fs;
  const timeoutMs = Number.isInteger(deps.timeoutMs) && deps.timeoutMs > 0 ? deps.timeoutMs : FFMPEG_TIMEOUT_MS;
  // Only a found binary is remembered: one installed while LunaCore runs is picked up on the next call.
  let found = null;

  function ffmpegBinary() {
    if (found) return found;
    let res;
    if (deps.ffmpegPath !== undefined) {
      res = isFileAt(fsx, path, deps.ffmpegPath) ? { ok: true, path: deps.ffmpegPath } : { ok: false, why: 'ffmpeg was not found: the configured ffmpeg path is not the absolute path of an existing file' };
    } else {
      res = locateFfmpeg({ fs: fsx, env: deps.env, platform: deps.platform, untrustedRoot: deps.repoPath });
    }
    if (res.ok) found = res;
    return res;
  }

  /** execFile on the found binary; a binary gone since the lookup is looked up again next time. */
  async function runFfmpeg(bin, args) {
    const res = await run(bin, args);
    if (!res.ok && res.err && res.err.code === 'ENOENT') found = null;
    return res;
  }

  /** execFile as a promise: {ok, stderr} or {ok:false, err, stderr}. No shell option is ever passed. */
  function run(bin, args) {
    return new Promise((resolve) => {
      try {
        execFile(bin, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: FFMPEG_MAX_BUFFER }, (err, _stdout, stderr) => {
          resolve(err ? { ok: false, err, stderr: String(stderr || '') } : { ok: true, stderr: String(stderr || '') });
        });
      } catch (err) {
        resolve({ ok: false, err, stderr: '' });
      }
    });
  }

  /** Why ffmpeg did not produce an output, as a short reason without the machine's folders in it. */
  function failReason(res, dir) {
    if (res.err && res.err.code === 'ENOENT') return 'ffmpeg was not found (its resolved binary could not be started)';
    const lastLine = res.stderr.trim().split(/\r?\n/).pop() || errText(res.err);
    // ffmpeg may print the folder with either slash.
    const local = [dir, dir.replace(/\\/g, '/')].reduce((line, d) => line.split(d).join('.'), lastLine);
    return `ffmpeg failed (${oneLine(local, 120)})`;
  }

  /** Removes our temp file; a failure to remove it becomes part of the note. */
  function dropTmp(tmp, tmpRel) {
    try {
      fsx.unlinkSync(tmp);
      return '';
    } catch (err) {
      return err && err.code === 'ENOENT' ? '' : ` (${tmpRel} could not be removed: ${oneLine(errText(err), 80)})`;
    }
  }

  /** The output's size and first bytes, or null when it is not there. */
  function outputHead(tmp) {
    let fd;
    try {
      fd = fsx.openSync(tmp, 'r');
      const size = fsx.fstatSync(fd).size;
      const buf = Buffer.alloc(HEAD_BYTES);
      return { size, head: buf.subarray(0, fsx.readSync(fd, buf, 0, HEAD_BYTES, 0)) };
    } catch {
      // A missing or unreadable output counts as no output; the caller keeps the original.
      return null;
    } finally {
      closeQuietly(fd);
    }
  }

  /** A failed close of a read-only handle loses nothing; it must not make normalize throw. */
  function closeQuietly(fd) {
    if (fd === undefined) return;
    try {
      fsx.closeSync(fd);
    } catch {
      // Read-only descriptor: nothing to flush, the OS reclaims it.
    }
  }

  const kept = (rel, why) => ({ ok: false, rel, note: `Audio post-process skipped for ${rel}: ${oneLine(why, MAX_REASON_CHARS)}; the original audio was kept.` });

  /**
   * Post-processes one written repo audio file in place. Never throws: on any
   * failure the original file stays untouched and the answer carries a note.
   * opts.commitLock wraps only the final guard + rename (never the ffmpeg runs).
   */
  async function normalize(rel, post, opts) {
    const commitLock = isObj(opts) && typeof opts.commitLock === 'function' ? opts.commitLock : runUnlocked;
    try {
      return await normalizeOne(rel, post, commitLock);
    } catch (err) {
      return kept(rel, `unexpected error (${oneLine(errText(err), 120)})`);
    }
  }

  /** The measuring pass and the loudness plan; {plan} or {why} when the clip cannot be normalized. */
  async function measure(bin, target, post) {
    if (!post.loudnorm) return { plan: { gainDb: null, note: null } };
    const res = await runFfmpeg(bin, measureArgs(target, post));
    if (!res.ok) return { why: failReason(res, path.dirname(target)) };
    const m = parseMeasurement(res.stderr);
    if (!m) return { why: 'its loudness could not be measured (a silent clip, or no loudnorm measurement in the ffmpeg output)' };
    return { plan: loudnessPlan(m) };
  }

  async function normalizeOne(rel, post, commitLock) {
    const ext = extOf(rel);
    if (!AUDIO_EXTS.includes(ext)) return kept(rel, `.${ext} is not ${AUDIO_EXTS.join(' / ')}`);
    const tmpRel = tempRelOf(rel, ext);
    let target;
    let tmp;
    try {
      target = deps.guard(rel);
      tmp = deps.guard(tmpRel);
    } catch (err) {
      return kept(rel, errText(err));
    }
    const bin = ffmpegBinary();
    if (!bin.ok) return kept(rel, bin.why);
    const measured = await measure(bin.path, target, post);
    if (!measured.plan) return kept(rel, measured.why);
    const { plan } = measured;
    try {
      // Again before the writing pass: a link planted while the measuring pass ran is refused.
      deps.guard(rel);
      deps.guard(tmpRel);
    } catch (err) {
      return kept(rel, errText(err));
    }
    const res = await runFfmpeg(bin.path, ffmpegArgs(target, tmp, post, plan.gainDb === null ? undefined : plan.gainDb));
    if (!res.ok) return kept(rel, failReason(res, path.dirname(target)) + dropTmp(tmp, tmpRel));
    const out = outputHead(tmp);
    if (!out || out.size < MIN_OUTPUT_BYTES) return kept(rel, `ffmpeg produced an empty file (${out ? out.size : 0} bytes; all silence?)${dropTmp(tmp, tmpRel)}`);
    if (!AUDIO_MAGIC[ext](out.head)) return kept(rel, `ffmpeg output is not a .${ext} file${dropTmp(tmp, tmpRel)}`);
    try {
      await commitLock(() => {
        // Again right before the rename: a link planted while ffmpeg ran is refused.
        deps.guard(tmpRel);
        deps.guard(rel);
        fsx.renameSync(tmp, target);
      });
    } catch (err) {
      return kept(rel, `the processed file could not replace it (${oneLine(errText(err), 80)})${dropTmp(tmp, tmpRel)}`);
    }
    const done = { ok: true, rel, steps: appliedSteps(post) };
    return plan.note ? { ...done, note: `Loudness of ${rel}: ${plan.note}.` } : done;
  }

  return { normalize };
}

/**
 * Runs `normalize` over the audio files among `rels`, one after the other.
 * opts.commitLock is passed on: it is taken per file, around the rename only.
 * @returns {Promise<{processed:string[], note:string|null}>}
 */
async function normalizeAll(normalizer, rels, post, opts) {
  const processed = [];
  const notes = [];
  for (const rel of rels) {
    if (!AUDIO_EXTS.includes(extOf(rel))) continue;
    const res = await normalizer.normalize(rel, post, opts);
    if (res.ok) processed.push(rel);
    if (res.note) notes.push(res.note);
  }
  const done = processed.length ? `Audio post-process (${appliedSteps(post).join(', ')}) applied to ${processed.join(', ')}.` : null;
  return { processed, note: [done, ...notes].filter(Boolean).join(' ') || null };
}

module.exports = {
  TARGET_LUFS,
  TRUE_PEAK_DB,
  LOUDNESS_TOLERANCE_LU,
  PEAK_HEADROOM_DB,
  SHORT_CLIP_SECONDS,
  FFMPEG_PATH_ENV,
  MIN_BPM,
  MAX_BPM,
  AUDIO_EXTS,
  POST_FIELDS,
  cleanAudioPost,
  atempoChain,
  audioFilter,
  measureFilter,
  ffmpegArgs,
  measureArgs,
  parseMeasurement,
  loudnessPlan,
  locateFfmpeg,
  createAudioNormalizer,
  normalizeAll,
};
