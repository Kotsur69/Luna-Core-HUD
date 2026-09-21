// ============================================================================
// LunaCore - highlight extractor tests (src/highlights.js)
// ----------------------------------------------------------------------------
// Pure functions only - filterVideoFiles, buildTrimArgs, parseFfmpegVersionLine -
// same pure-vs-impure split test/lmstudio.test.js documents. detectFfmpeg,
// listVideoFiles and HighlightBatchJob touch the filesystem/spawn real
// processes and are deliberately left untested, same convention as that
// file's probeEndpoint/LocalModelWatcher.
//
// buildTrimArgs gets the most scrutiny: this file's header explains why the
// argv-array return is a security property (execFile with an array never
// invokes a shell), so the "returns an Array, not a string" assertion below
// is a regression guard against a future `shell:true` "simplification".
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { filterVideoFiles, buildTrimArgs, parseFfmpegVersionLine } = require('../src/highlights.js');

test('filterVideoFiles matches the default .mp4 extension case-insensitively', () => {
  const names = ['clip1.mp4', 'clip2.MP4', 'clip3.MOV', 'notes.txt'];
  assert.deepEqual(filterVideoFiles(names), ['clip1.mp4', 'clip2.MP4']);
});

test('filterVideoFiles accepts a custom extension list', () => {
  const names = ['clip1.mov', 'clip2.mkv', 'clip3.mp4'];
  assert.deepEqual(filterVideoFiles(names, ['.mov', '.mkv']), ['clip1.mov', 'clip2.mkv']);
});

test('filterVideoFiles falls back to .mp4 when extensions is missing or empty', () => {
  const names = ['a.mp4', 'b.mov'];
  assert.deepEqual(filterVideoFiles(names, []), ['a.mp4']);
  assert.deepEqual(filterVideoFiles(names, undefined), ['a.mp4']);
});

test('filterVideoFiles returns [] for empty input', () => {
  assert.deepEqual(filterVideoFiles([], ['.mp4']), []);
  assert.deepEqual(filterVideoFiles(undefined, ['.mp4']), []);
});

test('filterVideoFiles preserves input order with no matches', () => {
  assert.deepEqual(filterVideoFiles(['a.txt', 'b.jpg'], ['.mp4']), []);
});

test('buildTrimArgs returns an Array, not a shell string (regression guard)', () => {
  const args = buildTrimArgs({ inputPath: 'in.mp4', outputPath: 'out.mp4', seconds: 20 });
  assert.equal(Array.isArray(args), true);
  assert.equal(typeof args, 'object');
});

test('buildTrimArgs builds the exact expected argv shape', () => {
  const args = buildTrimArgs({ inputPath: 'C:/clips/in.mp4', outputPath: 'C:/out/in.mp4', seconds: 15 });
  assert.deepEqual(args, ['-y', '-sseof', '-15', '-i', 'C:/clips/in.mp4', '-c', 'copy', 'C:/out/in.mp4']);
});

test('buildTrimArgs never shell-concatenates paths containing spaces/special chars', () => {
  const args = buildTrimArgs({
    inputPath: 'C:/My Clips/weird & name.mp4',
    outputPath: 'C:/Out/weird & name.mp4',
    seconds: 30,
  });
  // Each path stays as ONE argv element - not split/escaped/concatenated.
  assert.equal(args.includes('C:/My Clips/weird & name.mp4'), true);
  assert.equal(args.includes('C:/Out/weird & name.mp4'), true);
  assert.equal(args.length, 8);
});

test('buildTrimArgs rejects zero seconds', () => {
  assert.equal(buildTrimArgs({ inputPath: 'in.mp4', outputPath: 'out.mp4', seconds: 0 }), null);
});

test('buildTrimArgs rejects negative seconds', () => {
  assert.equal(buildTrimArgs({ inputPath: 'in.mp4', outputPath: 'out.mp4', seconds: -5 }), null);
});

test('buildTrimArgs rejects NaN seconds', () => {
  assert.equal(buildTrimArgs({ inputPath: 'in.mp4', outputPath: 'out.mp4', seconds: NaN }), null);
});

test('buildTrimArgs rejects Infinity seconds', () => {
  assert.equal(buildTrimArgs({ inputPath: 'in.mp4', outputPath: 'out.mp4', seconds: Infinity }), null);
});

test('buildTrimArgs rejects non-numeric seconds', () => {
  assert.equal(buildTrimArgs({ inputPath: 'in.mp4', outputPath: 'out.mp4', seconds: '20' }), null);
  assert.equal(buildTrimArgs({ inputPath: 'in.mp4', outputPath: 'out.mp4', seconds: null }), null);
  assert.equal(buildTrimArgs({ inputPath: 'in.mp4', outputPath: 'out.mp4', seconds: undefined }), null);
});

test('parseFfmpegVersionLine extracts the token from a standard release build', () => {
  const stdout = 'ffmpeg version 6.1.1 Copyright (c) 2000-2023 the FFmpeg developers\nbuilt with gcc 12';
  assert.equal(parseFfmpegVersionLine(stdout), '6.1.1');
});

test('parseFfmpegVersionLine extracts the token from a git/nightly build', () => {
  const stdout = 'ffmpeg version n6.1.1-3-g61a5da4c2c Copyright (c) 2000-2024 the FFmpeg developers';
  assert.equal(parseFfmpegVersionLine(stdout), 'n6.1.1-3-g61a5da4c2c');
});

test('parseFfmpegVersionLine returns null for unparseable/garbage input', () => {
  assert.equal(parseFfmpegVersionLine('command not found'), null);
  assert.equal(parseFfmpegVersionLine(''), null);
  assert.equal(parseFfmpegVersionLine(null), null);
  assert.equal(parseFfmpegVersionLine(undefined), null);
});
