// ============================================================================
// The optional ffmpeg audio post-process (src/lunasworkAudioNormalize.js):
// the two-pass loudness flow on a sub-second clip, the true-peak note, the
// absolute ffmpeg lookup, the import lock released while ffmpeg runs
// (src/lunasworkFreeAssets.js), and audioPost through the luna_asset_* tool
// layer (src/lunasworkAssetTools.js). ffmpeg is always a fake execFile.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const N = require('../src/lunasworkAudioNormalize.js');
const P = require('../src/lunasworkAssetPipeline.js');
const F = require('../src/lunasworkFreeAssets.js');
const T = require('../src/lunasworkAssetTools.js');

const OGG = Buffer.concat([Buffer.from('OggS', 'latin1'), Buffer.alloc(32, 7)]);
const PROCESSED_OGG = Buffer.concat([Buffer.from('OggS', 'latin1'), Buffer.alloc(2048, 5)]);
const EXE = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';

const tempDir = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), `lw-audio-${tag}-`));

/** An executable-looking empty file in its own temp folder; the fakes never run it. */
function fakeBinary(name = EXE) {
  const file = path.join(tempDir('bin'), name);
  fs.writeFileSync(file, '');
  return file;
}

/** loudnorm's print_format=json block as ffmpeg prints it on stderr. */
const measuredJson = ({ i, tp, lra = '0.00', thresh = '-40.00' }) => `[Parsed_loudnorm_1 @ 0x1] \n{\n\t"input_i" : "${i}",\n\t"input_tp" : "${tp}",\n\t"input_lra" : "${lra}",\n\t"input_thresh" : "${thresh}",\n\t"output_i" : "-14.00",\n\t"normalization_type" : "dynamic",\n\t"target_offset" : "0.00"\n}\n`;

/**
 * A fake execFile: the measuring pass (null muxer) answers `stderr`, the
 * writing pass writes `bytes` to its last token. `hold` (a promise) delays
 * the writing pass until it settles.
 */
function fakeFfmpeg({ stderr, bytes = PROCESSED_OGG, hold = null, onCall = () => {} }) {
  const calls = [];
  const fn = (cmd, args, opts, cb) => {
    calls.push({ cmd, args, opts });
    onCall(args);
    if (args.includes('null')) return setImmediate(() => cb(null, '', stderr));
    const write = () => {
      fs.writeFileSync(args[args.length - 1], bytes);
      cb(null, '', '');
    };
    if (hold) hold.then(write);
    else setImmediate(write);
    return undefined;
  };
  return { fn, calls };
}

/** A normalizer over a temp folder with a plain path guard. */
function normalizerIn(dir, ffmpeg, extra = {}) {
  const guard = (rel) => path.join(dir, ...rel.split('/'));
  return N.createAudioNormalizer({ execFile: ffmpeg.fn, fs, guard, ffmpegPath: fakeBinary(), ...extra });
}

const POST = { trim: true, loudnorm: true, targetBpm: null, bpm: null };

// ---- sub-second clips -----------------------------------------------------------------

test('a 0.3 s SFX is measured padded with silence to 1 s, then gets one plain gain onto -14 LUFS within the tolerance', async () => {
  const dir = tempDir('short');
  fs.writeFileSync(path.join(dir, 'parry.ogg'), OGG);
  // Measured on the padded clip: -30.5 LUFS, true peak -20 dBTP -> +16.5 dB fits under -1.5 dBTP.
  const ffmpeg = fakeFfmpeg({ stderr: measuredJson({ i: '-30.50', tp: '-20.00' }) });
  const res = await normalizerIn(dir, ffmpeg).normalize('parry.ogg', POST);
  assert.deepEqual(res, { ok: true, rel: 'parry.ogg', steps: ['leading silence trimmed', '-14 LUFS'] });
  assert.equal(ffmpeg.calls.length, 2);

  const target = path.join(dir, 'parry.ogg');
  const silence = 'silenceremove=start_periods=1:start_duration=0:start_threshold=-50dB';
  assert.deepEqual(ffmpeg.calls[0].args, [
    '-hide_banner', '-nostats', '-loglevel', 'info', '-nostdin', '-protocol_whitelist', 'file', '-i', target, '-vn',
    '-af', `${silence},apad=whole_dur=${N.SHORT_CLIP_SECONDS},loudnorm=I=-14:TP=-1.5:LRA=11:print_format=json`, '-f', 'null', '-',
  ]);
  const write = ffmpeg.calls[1].args;
  assert.equal(write[write.indexOf('-af') + 1], `${silence},volume=16.5dB`, 'the padding is for the measurement only');
  assert.equal(write.includes('-n'), true);
  // The measured loudness plus the applied gain lands on target within the agreed tolerance.
  const gain = Number(/volume=([-\d.]+)dB/.exec(write[write.indexOf('-af') + 1])[1]);
  assert.ok(Math.abs(-30.5 + gain - N.TARGET_LUFS) <= N.LOUDNESS_TOLERANCE_LU);
  assert.equal(N.LOUDNESS_TOLERANCE_LU, 1);
  assert.deepEqual(fs.readFileSync(target), PROCESSED_OGG);
  assert.deepEqual(fs.readdirSync(dir), ['parry.ogg'], 'no temp file left');
});

test('a short clip whose true peak blocks the gain keeps the peak ceiling and the note says why and how far off it can end', async () => {
  const dir = tempDir('peak');
  fs.writeFileSync(path.join(dir, 'clang.ogg'), OGG);
  // -30 LUFS with a -3 dBTP transient: +16 dB would put the peak at +13 dBTP.
  const ffmpeg = fakeFfmpeg({ stderr: measuredJson({ i: '-30.00', tp: '-3.00' }) });
  const res = await normalizerIn(dir, ffmpeg).normalize('clang.ogg', POST);
  assert.equal(res.ok, true, JSON.stringify(res));
  const write = ffmpeg.calls[1].args;
  assert.match(write[write.indexOf('-af') + 1], /,loudnorm=I=-14:TP=-1\.5:LRA=11$/, 'falls back to loudnorm, which limits');
  assert.match(res.note, /^Loudness of clang\.ogg: measured -30\.0 LUFS with a true peak of -3\.0 dBTP/);
  assert.match(res.note, /past the -1\.5 dBTP ceiling/);
  assert.match(res.note, /can end near -28\.5 LUFS, more than 1 LU under target\.$/);
  // normalizeAll carries the note of a processed file too.
  fs.writeFileSync(path.join(dir, 'clang.ogg'), OGG);
  const all = await N.normalizeAll(normalizerIn(dir, fakeFfmpeg({ stderr: measuredJson({ i: '-30.00', tp: '-3.00' }) })), ['clang.ogg'], POST);
  assert.deepEqual(all.processed, ['clang.ogg']);
  assert.match(all.note, /applied to clang\.ogg\. Loudness of clang\.ogg: measured/);
});

test('loudnessPlan: plain gain when it fits, no note when the ceiling costs at most the tolerance', () => {
  assert.deepEqual(N.loudnessPlan({ i: -20, tp: -8 }), { gainDb: 6, note: null });
  // +0.5 dB would reach -1.3 dBTP; held at the ceiling the clip ends at -14.8, inside 1 LU.
  assert.deepEqual(N.loudnessPlan({ i: -14.5, tp: -1.8 }), { gainDb: null, note: null });
  const blocked = N.loudnessPlan({ i: -24, tp: -2 });
  assert.equal(blocked.gainDb, null);
  assert.match(blocked.note, /near -23\.5 LUFS/);
  // A negative gain (too loud) is a plain cut.
  assert.deepEqual(N.loudnessPlan({ i: -9, tp: -0.5 }), { gainDb: -5, note: null });
  // The plain gain keeps PEAK_HEADROOM_DB under the ceiling for the resample and the encode.
  assert.equal(N.PEAK_HEADROOM_DB, 0.5);
  assert.deepEqual(N.loudnessPlan({ i: -20, tp: -7.8 }), { gainDb: null, note: null }, '-1.8 dBTP after the gain is too close to -1.5');
});

test('parseMeasurement reads the block holding "input_i" and rejects empty values', () => {
  const trailing = `${measuredJson({ i: '-18.00', tp: '-9.00' })}[out#0/null @ 0x2] video:0kB audio:{unknown} muxing overhead\n`;
  assert.deepEqual(N.parseMeasurement(trailing), { i: -18, tp: -9, lra: 0, thresh: -40 });
  assert.equal(N.parseMeasurement(measuredJson({ i: '', tp: '-9.00' })), null);
  assert.equal(N.parseMeasurement(measuredJson({ i: ' ', tp: '-9.00' })), null);
  assert.equal(N.parseMeasurement('{"other": 1}'), null);
});

test('a silent or unmeasurable clip keeps the original and runs no writing pass', async () => {
  for (const stderr of [measuredJson({ i: '-inf', tp: '-inf', thresh: '-inf' }), 'no json here', '{ broken', measuredJson({ i: '-20.00', tp: '-8.00', lra: '-1' })]) {
    const dir = tempDir('silent');
    fs.writeFileSync(path.join(dir, 'blank.ogg'), OGG);
    const ffmpeg = fakeFfmpeg({ stderr });
    const res = await normalizerIn(dir, ffmpeg).normalize('blank.ogg', POST);
    assert.equal(res.ok, false, stderr);
    assert.match(res.note, /loudness could not be measured.*the original audio was kept\.$/);
    assert.equal(ffmpeg.calls.length, 1, stderr);
    assert.deepEqual(fs.readFileSync(path.join(dir, 'blank.ogg')), OGG);
  }
  assert.deepEqual(N.parseMeasurement(measuredJson({ i: '-23.54', tp: '-6.20', lra: '4.10', thresh: '-34.00' })), { i: -23.54, tp: -6.2, lra: 4.1, thresh: -34 });
});

test('loudnorm off: one pass, no measurement', async () => {
  const dir = tempDir('trim');
  fs.writeFileSync(path.join(dir, 'tick.ogg'), OGG);
  const ffmpeg = fakeFfmpeg({ stderr: '' });
  const res = await normalizerIn(dir, ffmpeg).normalize('tick.ogg', { ...POST, loudnorm: false });
  assert.equal(res.ok, true);
  assert.equal(ffmpeg.calls.length, 1);
  assert.equal(ffmpeg.calls[0].args.includes('null'), false);
});

// ---- the ffmpeg binary ----------------------------------------------------------------

test('locateFfmpeg: LUNACORE_FFMPEG_PATH first, else the first ffmpeg in an absolute PATH folder; relative folders are skipped', () => {
  const pinned = fakeBinary();
  assert.deepEqual(N.locateFfmpeg({ env: { [N.FFMPEG_PATH_ENV]: pinned, PATH: '' } }), { ok: true, path: path.normalize(pinned) });
  assert.deepEqual(N.locateFfmpeg({ env: { [N.FFMPEG_PATH_ENV]: `"${pinned}"` } }).ok, true, 'quotes around the path are fine');

  // A pinned path that is wrong is reported, never silently replaced by PATH.
  const onPath = fakeBinary();
  const env = { PATH: path.dirname(onPath) };
  const wrong = N.locateFfmpeg({ env: { ...env, [N.FFMPEG_PATH_ENV]: path.join(path.dirname(pinned), 'nope.exe') } });
  assert.equal(wrong.ok, false);
  assert.match(wrong.why, /LUNACORE_FFMPEG_PATH is set but is not the absolute path of an existing file/);
  assert.equal(N.locateFfmpeg({ env: { [N.FFMPEG_PATH_ENV]: 'ffmpeg' } }).ok, false, 'a bare name is not a path');

  // PATH: a relative entry holding ffmpeg is skipped; a folder without it too; the absolute hit wins.
  const cwdLike = path.relative(process.cwd(), path.dirname(fakeBinary())) || '.';
  const empty = tempDir('empty');
  const sep = process.platform === 'win32' ? ';' : ':';
  const found = N.locateFfmpeg({ env: { PATH: [cwdLike, '', empty, path.dirname(onPath)].join(sep) } });
  assert.deepEqual(found, { ok: true, path: onPath });
  assert.equal(path.isAbsolute(found.path), true);

  // A PATH folder inside the project repo (which a worker can write to) is never trusted.
  const repo = tempDir('repo');
  const planted = path.join(repo, 'tools', EXE);
  fs.mkdirSync(path.dirname(planted));
  fs.writeFileSync(planted, '');
  assert.deepEqual(N.locateFfmpeg({ env: { PATH: [path.dirname(planted), path.dirname(onPath)].join(sep) }, untrustedRoot: repo }), { ok: true, path: onPath });
  assert.equal(N.locateFfmpeg({ env: { PATH: repo + sep + path.dirname(planted) }, untrustedRoot: repo }).ok, false);

  const missing = N.locateFfmpeg({ env: { PATH: empty } });
  assert.equal(missing.ok, false);
  assert.match(missing.why, /ffmpeg was not found on PATH \(install ffmpeg, or set LUNACORE_FFMPEG_PATH to the full path of ffmpeg/);
});

test('locateFfmpeg on Windows reads Path case-insensitively and looks for ffmpeg.exe', { skip: process.platform !== 'win32' }, () => {
  const bin = fakeBinary('ffmpeg.exe');
  assert.deepEqual(N.locateFfmpeg({ env: { Path: path.dirname(bin) }, platform: 'win32' }), { ok: true, path: bin });
  assert.deepEqual(N.locateFfmpeg({ env: { lunacore_ffmpeg_path: bin }, platform: 'win32' }), { ok: true, path: bin });
  // "\folder" has no drive: it would resolve against whatever drive is current.
  const driveless = bin.slice(2);
  assert.equal(N.locateFfmpeg({ env: { LUNACORE_FFMPEG_PATH: driveless }, platform: 'win32' }).ok, false);
  assert.equal(N.locateFfmpeg({ env: { Path: path.dirname(driveless) }, platform: 'win32' }).ok, false);
});

test('no ffmpeg anywhere: a clear note, the original audio kept, execFile never called with a bare name', async () => {
  const dir = tempDir('nobin');
  fs.writeFileSync(path.join(dir, 'hit.ogg'), OGG);
  const ffmpeg = fakeFfmpeg({ stderr: '' });
  const guard = (rel) => path.join(dir, ...rel.split('/'));
  const normalizer = N.createAudioNormalizer({ execFile: ffmpeg.fn, fs, guard, env: { PATH: tempDir('empty') } });
  const res = await normalizer.normalize('hit.ogg', POST);
  assert.equal(res.ok, false);
  assert.match(res.note, /^Audio post-process skipped for hit\.ogg: ffmpeg was not found on PATH \(install ffmpeg, or set LUNACORE_FFMPEG_PATH .*\); the original audio was kept\.$/);
  assert.equal(ffmpeg.calls.length, 0);
  assert.deepEqual(fs.readFileSync(path.join(dir, 'hit.ogg')), OGG);

  // A configured path that is not a file says so too.
  const configured = N.createAudioNormalizer({ execFile: ffmpeg.fn, fs, guard, ffmpegPath: path.join(dir, 'missing.exe') });
  assert.match((await configured.normalize('hit.ogg', POST)).note, /the configured ffmpeg path is not the absolute path of an existing file/);
  assert.equal(ffmpeg.calls.length, 0);
});

test('a binary gone since the lookup is looked up again: the next call says it is not on PATH', async () => {
  const dir = tempDir('gone');
  fs.writeFileSync(path.join(dir, 'hit.ogg'), OGG);
  const bin = fakeBinary();
  const calls = [];
  const execFile = (cmd, args, opts, cb) => {
    calls.push(cmd);
    setImmediate(() => cb(Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }), '', ''));
  };
  const guard = (rel) => path.join(dir, ...rel.split('/'));
  const normalizer = N.createAudioNormalizer({ execFile, fs, guard, env: { PATH: path.dirname(bin) } });
  assert.match((await normalizer.normalize('hit.ogg', POST)).note, /ffmpeg was not found \(its resolved binary could not be started\)/);
  assert.deepEqual(calls, [bin]);
  fs.unlinkSync(bin);
  assert.match((await normalizer.normalize('hit.ogg', POST)).note, /ffmpeg was not found on PATH/);
  assert.equal(calls.length, 1, 'no second run of a vanished binary');
});

test('the repo guard runs again before the writing pass: a link planted during the measurement is refused', async () => {
  const dir = tempDir('reguard');
  fs.writeFileSync(path.join(dir, 'hit.ogg'), OGG);
  let measured = false;
  const ffmpeg = fakeFfmpeg({ stderr: measuredJson({ i: '-20.00', tp: '-8.00' }), onCall: (args) => { if (args.includes('null')) measured = true; } });
  const guard = (rel) => {
    if (measured) throw new Error(`refused: ${rel} is a link`);
    return path.join(dir, ...rel.split('/'));
  };
  const res = await N.createAudioNormalizer({ execFile: ffmpeg.fn, fs, guard, ffmpegPath: fakeBinary() }).normalize('hit.ogg', POST);
  assert.equal(res.ok, false);
  assert.match(res.note, /refused: hit\.ogg is a link; the original audio was kept\.$/);
  assert.equal(ffmpeg.calls.length, 1, 'no writing pass');
});

// ---- lock hold time --------------------------------------------------------------------

test('normalizeAll: ffmpeg runs outside the caller lock; the lock is taken once per file, around the rename only', async () => {
  const dir = tempDir('lock');
  const rels = ['a.ogg', 'b.ogg', 'c.ogg'];
  for (const rel of rels) fs.writeFileSync(path.join(dir, rel), OGG);
  let inLock = false;
  const lockRuns = [];
  const commitLock = async (fn) => {
    inLock = true;
    try {
      const before = fs.readdirSync(dir).filter((n) => !n.startsWith('.')).map((n) => fs.readFileSync(path.join(dir, n)).length);
      fn();
      lockRuns.push(before);
    } finally {
      inLock = false;
    }
  };
  const ffmpeg = fakeFfmpeg({ stderr: measuredJson({ i: '-20.00', tp: '-8.00' }), onCall: () => assert.equal(inLock, false, 'ffmpeg ran under the lock') });
  const res = await N.normalizeAll(normalizerIn(dir, ffmpeg), rels, POST, { commitLock });
  assert.deepEqual(res.processed, rels);
  assert.equal(ffmpeg.calls.length, 6, 'two passes per file');
  assert.equal(lockRuns.length, 3, 'one short hold per file');
  for (const rel of rels) assert.deepEqual(fs.readFileSync(path.join(dir, rel)), PROCESSED_OGG);
  // A lock that fails keeps the original and removes the temp file.
  fs.writeFileSync(path.join(dir, 'a.ogg'), OGG);
  const refused = await N.normalizeAll(normalizerIn(dir, fakeFfmpeg({ stderr: measuredJson({ i: '-20.00', tp: '-8.00' }) })), ['a.ogg'], POST, { commitLock: async () => { throw new Error('lock gone'); } });
  assert.match(refused.note, /could not replace it \(lock gone\)/);
  assert.deepEqual(fs.readFileSync(path.join(dir, 'a.ogg')), OGG);
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.includes('.tmp')), []);
});

// Generous for a loaded machine; the second import needs a few milliseconds.
const LOCK_WAIT_MS = 10000;

/** A one-library free-asset importer over the real pipeline; sound ids map to fake items. */
function importer(dir, ffmpeg) {
  const unity = { calls: [], exec: async (command, parameters) => { unity.calls.push(parameters.path); return { ok: true }; } };
  const pipe = P.createAssetPipeline({ repoPath: dir, artRoot: 'Assets/Game/Art', unity, recordSpend: () => ({ ok: true }), logAsset: () => {}, now: () => 1, execFile: ffmpeg.fn, ffmpegPath: fakeBinary() });
  const item = (id) => ({ id, name: `Sound ${id}`, author: 'foley', license: 'CC0', type: 'audio', sourceUrl: `https://freesound.org/s/${id}/`, tags: ['sfx'] });
  const client = {
    id: 'freesound',
    label: 'Freesound',
    info: async (id) => item(id),
    files: async (it) => ({ files: [{ name: `${it.id}.ogg`, url: `https://cdn.freesound.org/${it.id}.ogg`, main: true }] }),
  };
  const lib = F.createFreeAssets({ shared: pipe.shared, artRoot: pipe.artRoot, sources: { freesound: client }, download: async () => OGG });
  return { lib, unity };
}

test('an audio import does not hold the per-repo import lock while ffmpeg runs: another import finishes meanwhile', async () => {
  const dir = tempDir('import');
  let release;
  const hold = new Promise((resolve) => { release = resolve; });
  let writingStarted;
  const started = new Promise((resolve) => { writingStarted = resolve; });
  const ffmpeg = fakeFfmpeg({ stderr: measuredJson({ i: '-20.00', tp: '-8.00' }), hold, onCall: (args) => { if (!args.includes('null')) writingStarted(); } });
  const { lib, unity } = importer(dir, ffmpeg);

  let slowDone = false;
  const slow = lib.importAsset({ source: 'freesound', id: '1', kind: 'audio', audioPost: {} }).then((r) => { slowDone = true; return r; });
  await started;
  // ffmpeg of import 1 is still running: import 2 must get the lock and finish (fails fast, not a hang).
  let timer;
  const blocked = new Promise((resolve) => { timer = setTimeout(() => resolve({ ok: false, error: 'import 2 waited on the lock held through ffmpeg' }), LOCK_WAIT_MS); });
  const quick = await Promise.race([lib.importAsset({ source: 'freesound', id: '2', kind: 'audio' }), blocked]);
  clearTimeout(timer);
  assert.equal(quick.ok, true, JSON.stringify(quick));
  assert.equal(slowDone, false, 'import 1 is still in its ffmpeg pass');
  // A library import ends in one asset refresh (the Assets/Refresh menu item), not a per-file import.
  assert.deepEqual(unity.calls, ['Assets/Refresh']);

  release();
  const res = await slow;
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.main, 'Assets/Game/Art/Audio/sound-1.ogg');
  assert.deepEqual(fs.readFileSync(path.join(dir, ...res.main.split('/'))), PROCESSED_OGG, 'processed before its Unity import');
  assert.deepEqual(unity.calls, ['Assets/Refresh', 'Assets/Refresh']);
  assert.match(res.note, /Audio post-process \(leading silence trimmed, -14 LUFS\) applied to Assets\/Game\/Art\/Audio\/sound-1\.ogg\./);
  assert.deepEqual(fs.readFileSync(path.join(dir, 'Assets', 'Game', 'Art', 'Audio', 'sound-2.ogg')), OGG, 'import 2 had no audioPost');
});

// ---- audioPost in the luna_asset_* tool schemas ---------------------------------------

test('audioPost is in the luna_asset_comfy and luna_asset_import schemas with the BPM pairing rule and cleanAudioPost limits', () => {
  for (const name of [T.COMFY_TOOL, T.IMPORT_TOOL]) {
    const prop = T.ASSET_TOOLS.find((t) => t.name === name).inputSchema.properties.audioPost;
    assert.ok(prop, name);
    assert.equal(prop.type, 'object');
    assert.equal(prop.additionalProperties, false);
    assert.deepEqual(Object.keys(prop.properties).sort(), [...N.POST_FIELDS].sort(), 'the fields cleanAudioPost accepts');
    for (const k of ['targetBpm', 'bpm']) {
      assert.deepEqual([prop.properties[k].type, prop.properties[k].minimum, prop.properties[k].maximum], ['integer', N.MIN_BPM, N.MAX_BPM]);
      assert.match(prop.properties[k].description, /targetBpm and bpm go together/);
    }
    assert.equal(prop.dependentRequired, undefined, 'the pairing rule lives in the descriptions (wide client support)');
    assert.match(prop.description, /targetBpm and bpm are a pair: give both \(each an integer from 40 to 300\) or neither/);
    assert.match(prop.description, /kind "audio" only/);
    assert.match(prop.properties.loudnorm.description, /-14 LUFS \(within 1 LU/);
  }
  // The executor takes the same integers the schema advertises.
  assert.equal(N.cleanAudioPost({ targetBpm: 128.5, bpm: 120 }).error, 'badAudioPost');
  assert.match(N.cleanAudioPost({ targetBpm: 120, bpm: 39 }).detail, /integers from 40 to 300/);
  assert.equal(N.cleanAudioPost({ targetBpm: 300, bpm: 40 }).ok, true);
  for (const name of [T.BLENDER_TOOL, T.HIGGSFIELD_TOOL, T.SEARCH_TOOL]) {
    assert.equal(T.ASSET_TOOLS.find((t) => t.name === name).inputSchema.properties.audioPost, undefined, name);
  }
});

test('luna_asset_import with audioPost through the tool layer reaches the normalizer with its values intact', async () => {
  const dir = tempDir('tools');
  const FS = 'https://freesound.org/apiv2';
  const FIELDS = 'id,name,username,license,url,tags,previews,duration';
  const sound = { id: 301, name: 'Hit Stop', username: 'foley_kat', license: 'http://creativecommons.org/publicdomain/zero/1.0/', url: 'https://freesound.org/people/foley_kat/sounds/301/', tags: ['hit'], previews: { 'preview-hq-ogg': 'https://cdn.freesound.org/previews/301-hq.ogg' } };
  const reply = (body) => {
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
    return { status: 200, ok: true, headers: { get: () => null }, body: null, arrayBuffer: async () => buf };
  };
  const routes = { [`${FS}/sounds/301/?fields=${FIELDS}`]: sound, 'https://cdn.freesound.org/previews/301-hq.ogg': OGG };
  const fetch = async (url) => (routes[url] === undefined ? { status: 404, ok: false, headers: { get: () => null }, body: null, arrayBuffer: async () => Buffer.from('{}') } : reply(routes[url]));
  // Fake key assembled at runtime: no key-shaped literal in the source.
  const key = `fs${'k'.repeat(28)}`;
  const ffmpeg = fakeFfmpeg({ stderr: measuredJson({ i: '-20.00', tp: '-8.00' }) });
  const assetsFor = T.createAssetToolsFor({
    assetTools: () => ({ comfyuiPort: 8188, blenderPort: 9876, higgsfieldUsdPerCredit: 0.1, artRoot: 'Assets/Game/Art' }),
    keys: { get: (s) => (s === 'freesound' ? key : null), secrets: () => [key] },
    fetch,
    lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    execFile: ffmpeg.fn,
    ffmpegPath: fakeBinary(),
  });
  const tools = assetsFor({ repoPath: dir, recordSpend: () => ({ ok: true }), recordAsset: () => true, cappedTools: () => [] });
  const audioPost = { trim: false, loudnorm: true, targetBpm: 120, bpm: 100 };
  const res = await T.callAssetTool(T.IMPORT_TOOL, { source: 'freesound', id: '301', kind: 'audio', audioPost }, tools);
  assert.equal(res.ok, true, JSON.stringify(res));
  // trim:false -> no silenceremove; the BPM pair -> atempo 1.2; loudnorm -> measure + gain.
  assert.equal(ffmpeg.calls.length, 2);
  assert.match(ffmpeg.calls[0].args[ffmpeg.calls[0].args.indexOf('-af') + 1], /^atempo=1\.2,apad=whole_dur=1,loudnorm=/);
  assert.equal(ffmpeg.calls[1].args[ffmpeg.calls[1].args.indexOf('-af') + 1], 'atempo=1.2,volume=6dB');
  assert.match(res.payload.note, /Audio post-process \(tempo 100 -> 120 BPM, -14 LUFS\) applied to Assets\/Game\/Art\/Audio\/hit-stop\.ogg\./);
  assert.deepEqual(fs.readFileSync(path.join(dir, ...res.payload.main.split('/'))), PROCESSED_OGG);
  // A bad audioPost is refused before anything is fetched or run.
  const bad = await T.callAssetTool(T.IMPORT_TOOL, { source: 'freesound', id: '301', kind: 'audio', audioPost: { targetBpm: 120 } }, tools);
  assert.equal(bad.ok, false);
  assert.equal(bad.error.error, 'badAudioPost');
  assert.equal(ffmpeg.calls.length, 2);
});
