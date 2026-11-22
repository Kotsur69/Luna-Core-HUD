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
//   3. integrated loudness normalized to TARGET_LUFS (loudnorm).
//
// ffmpeg runs through execFile with plain argument tokens: no shell, no
// command line built from strings. The output goes to a random temp file
// next to the target and is renamed over it only when ffmpeg succeeded and
// produced a non-empty file of the same format. Any failure (ffmpeg missing,
// a non-zero exit, an empty or wrong output) keeps the original file as it was
// and comes back as an informational note: imported audio is never lost.
// ============================================================================

'use strict';

const crypto = require('crypto');
const path = require('path');
const childProcess = require('child_process');

// Streaming platforms and most game mixes sit at -14 LUFS integrated.
const TARGET_LUFS = -14;
const TRUE_PEAK_DB = -1.5;
const LOUDNESS_RANGE = 11;
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
const isBpm = (v) => typeof v === 'number' && Number.isFinite(v) && v >= MIN_BPM && v <= MAX_BPM;

// The first bytes each audio format starts with; the output must keep its format.
const AUDIO_MAGIC = Object.freeze({
  wav: (b) => b.length >= 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WAVE',
  ogg: (b) => b.length >= 4 && b.toString('latin1', 0, 4) === 'OggS',
  mp3: (b) => (b.length >= 3 && b.toString('latin1', 0, 3) === 'ID3') || (b.length >= 2 && b[0] === 0xff && (b[1] & 0xe0) === 0xe0),
});

/**
 * The validated audioPost option. Undefined -> no post-process. trim and
 * loudnorm default to true once audioPost is given; targetBpm and bpm go
 * together, each a finite number within MIN_BPM..MAX_BPM.
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
  if (hasTarget && (!isBpm(raw.targetBpm) || !isBpm(raw.bpm))) return bad(`audioPost.targetBpm and bpm must be numbers from ${MIN_BPM} to ${MAX_BPM}`);
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

/** The -af filter graph of a cleaned post: trim -> tempo -> loudness (loudness last, after the stretch). */
function audioFilter(post) {
  const filters = [];
  if (post.trim) filters.push(`silenceremove=start_periods=1:start_duration=0:start_threshold=${SILENCE_THRESHOLD_DB}dB`);
  if (stretches(post)) for (const f of atempoChain(post.targetBpm / post.bpm)) filters.push(`atempo=${num(f)}`);
  if (post.loudnorm) filters.push(`loudnorm=I=${TARGET_LUFS}:TP=${TRUE_PEAK_DB}:LRA=${LOUDNESS_RANGE}`);
  return filters.join(',');
}

/**
 * The ffmpeg argument tokens: errors only on stderr, never overwrite (-n), no
 * stdin, local files only (an input that declares a playlist cannot fetch
 * URLs), audio only, the output format from the output's extension.
 */
function ffmpegArgs(input, output, post) {
  return ['-hide_banner', '-loglevel', 'error', '-nostdin', '-n', '-protocol_whitelist', 'file', '-i', input, '-vn', '-af', audioFilter(post), '-ar', String(OUTPUT_SAMPLE_RATE), output];
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

/**
 * @param {{execFile?:Function, fs:object, guard:(rel:string)=>string, timeoutMs?:number}} deps
 *   guard = the repo path guard: rel -> absolute path, throws outside the repo
 * @returns {{normalize:(rel:string, post:object)=>Promise<{ok:boolean, rel:string, steps?:string[], note?:string}>}}
 */
function createAudioNormalizer(deps) {
  const execFile = typeof deps.execFile === 'function' ? deps.execFile : childProcess.execFile;
  const fsx = deps.fs;
  const timeoutMs = Number.isInteger(deps.timeoutMs) && deps.timeoutMs > 0 ? deps.timeoutMs : FFMPEG_TIMEOUT_MS;

  /** execFile as a promise: {ok} or {ok:false, err, stderr}. No shell option is ever passed. */
  function run(args) {
    return new Promise((resolve) => {
      try {
        execFile('ffmpeg', args, { timeout: timeoutMs, windowsHide: true, maxBuffer: FFMPEG_MAX_BUFFER }, (err, _stdout, stderr) => {
          resolve(err ? { ok: false, err, stderr: String(stderr || '') } : { ok: true });
        });
      } catch (err) {
        resolve({ ok: false, err, stderr: '' });
      }
    });
  }

  /** Why ffmpeg did not produce an output, as a short reason without the machine's folders in it. */
  function failReason(res, dir) {
    if (res.err && res.err.code === 'ENOENT') return 'ffmpeg was not found on PATH';
    const lastLine = res.stderr.trim().split(/\r?\n/).pop() || errText(res.err);
    return `ffmpeg failed (${oneLine(lastLine.split(dir).join('.'), 120)})`;
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
   */
  async function normalize(rel, post) {
    try {
      return await normalizeOne(rel, post);
    } catch (err) {
      return kept(rel, `unexpected error (${oneLine(errText(err), 120)})`);
    }
  }

  async function normalizeOne(rel, post) {
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
    const res = await run(ffmpegArgs(target, tmp, post));
    if (!res.ok) return kept(rel, failReason(res, path.dirname(target)) + dropTmp(tmp, tmpRel));
    const out = outputHead(tmp);
    if (!out || out.size < MIN_OUTPUT_BYTES) return kept(rel, `ffmpeg produced an empty file (${out ? out.size : 0} bytes; all silence?)${dropTmp(tmp, tmpRel)}`);
    if (!AUDIO_MAGIC[ext](out.head)) return kept(rel, `ffmpeg output is not a .${ext} file${dropTmp(tmp, tmpRel)}`);
    try {
      // Again right before the rename: a link planted while ffmpeg ran is refused.
      deps.guard(tmpRel);
      deps.guard(rel);
      fsx.renameSync(tmp, target);
    } catch (err) {
      return kept(rel, `the processed file could not replace it (${oneLine(errText(err), 80)})${dropTmp(tmp, tmpRel)}`);
    }
    return { ok: true, rel, steps: appliedSteps(post) };
  }

  return { normalize };
}

/**
 * Runs `normalize` over the audio files among `rels`, one after the other.
 * @returns {Promise<{processed:string[], note:string|null}>}
 */
async function normalizeAll(normalizer, rels, post) {
  const processed = [];
  const notes = [];
  for (const rel of rels) {
    if (!AUDIO_EXTS.includes(extOf(rel))) continue;
    const res = await normalizer.normalize(rel, post);
    if (res.ok) processed.push(rel);
    else notes.push(res.note);
  }
  const done = processed.length ? `Audio post-process (${appliedSteps(post).join(', ')}) applied to ${processed.join(', ')}.` : null;
  return { processed, note: [done, ...notes].filter(Boolean).join(' ') || null };
}

module.exports = {
  TARGET_LUFS,
  MIN_BPM,
  MAX_BPM,
  AUDIO_EXTS,
  cleanAudioPost,
  atempoChain,
  audioFilter,
  ffmpegArgs,
  createAudioNormalizer,
  normalizeAll,
};
