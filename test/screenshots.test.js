// ============================================================================
// LunaCore - screenshot-paste tests
// ----------------------------------------------------------------------------
// src/screenshots.js keeps the interesting half pure - which MIME types are
// accepted, what a clip is named, which files fall off the end of the cap - so
// all of that is covered here without a clipboard, a PTY or Electron. The two
// I/O functions (saveClip / pruneClips) take their directory as a parameter
// for exactly this reason, and run against a throwaway mkdtemp dir.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  extForMime,
  clipName,
  excessClips,
  saveClip,
  pruneClips,
  clipsDir,
  MAX_CLIPS,
  MAX_BYTES,
} = require('../src/screenshots.js');

/** A fresh empty directory, removed when the test process exits. */
function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lunacore-cliptest-'));
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// ---- extForMime -------------------------------------------------------------

test('extForMime maps the image types a clipboard actually carries', () => {
  assert.equal(extForMime('image/png'), '.png');
  assert.equal(extForMime('image/jpeg'), '.jpg');
  assert.equal(extForMime('image/gif'), '.gif');
  assert.equal(extForMime('image/webp'), '.webp');
  assert.equal(extForMime('image/bmp'), '.bmp');
});

test('extForMime tolerates case and a trailing parameter', () => {
  assert.equal(extForMime('IMAGE/PNG'), '.png');
  assert.equal(extForMime('image/png; charset=binary'), '.png');
  assert.equal(extForMime('  image/jpeg  '), '.jpg');
});

test('extForMime rejects non-images and non-strings', () => {
  assert.equal(extForMime('text/plain'), null);
  assert.equal(extForMime('image/svg+xml'), null); // an image, but not a screenshot
  assert.equal(extForMime(''), null);
  assert.equal(extForMime(undefined), null);
  assert.equal(extForMime(42), null);
});

// ---- clipName ---------------------------------------------------------------

test('clipName stamps the local time and keeps the type extension', () => {
  const at = new Date(2026, 8, 11, 8, 19, 41, 7).getTime(); // 2026-09-11 08:19:41.007
  assert.equal(clipName('image/png', at), 'clip-20260911-081941-007.png');
  assert.equal(clipName('image/jpeg', at), 'clip-20260911-081941-007.jpg');
});

test('clipName sorts chronologically as plain text', () => {
  const early = clipName('image/png', new Date(2026, 8, 11, 8, 19, 41, 7).getTime());
  const later = clipName('image/png', new Date(2026, 8, 11, 8, 19, 41, 900).getTime());
  const tomorrow = clipName('image/png', new Date(2026, 8, 12, 0, 0, 0, 0).getTime());
  assert.deepEqual([tomorrow, later, early].sort(), [early, later, tomorrow]);
});

test('clipName refuses a type it has no extension for', () => {
  assert.equal(clipName('text/plain', Date.now()), null);
});

// ---- excessClips ------------------------------------------------------------

test('excessClips keeps everything while under the cap', () => {
  assert.deepEqual(excessClips(['clip-a.png', 'clip-b.png'], 5), []);
  assert.deepEqual(excessClips([], 5), []);
});

test('excessClips drops the OLDEST names once over the cap', () => {
  const names = ['clip-3.png', 'clip-1.png', 'clip-4.png', 'clip-2.png'];
  assert.deepEqual(excessClips(names, 2), ['clip-1.png', 'clip-2.png']);
});

test('excessClips never touches a file it did not write', () => {
  const names = ['secrets.txt', 'clip-1.png', 'clip-2.png', 'holiday.png'];
  assert.deepEqual(excessClips(names, 1), ['clip-1.png']);
});

test('excessClips survives a malformed listing', () => {
  assert.deepEqual(excessClips(null, 2), []);
  assert.deepEqual(excessClips([null, 7, 'clip-1.png'], 0), ['clip-1.png']);
});

// ---- saveClip ---------------------------------------------------------------

test('saveClip writes the bytes and returns the absolute path', () => {
  const dir = tempDir();
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  const at = new Date(2026, 8, 11, 8, 19, 41, 7).getTime();

  const file = saveClip(dir, bytes, 'image/png', at);

  assert.equal(file, path.join(dir, 'clip-20260911-081941-007.png'));
  assert.deepEqual(fs.readFileSync(file), bytes);
});

test('saveClip accepts the Uint8Array that arrives over IPC', () => {
  const dir = tempDir();
  const file = saveClip(dir, new Uint8Array([1, 2, 3]), 'image/png');
  assert.ok(file);
  assert.deepEqual(fs.readFileSync(file), Buffer.from([1, 2, 3]));
});

test('saveClip creates the directory on first use', () => {
  const dir = path.join(tempDir(), 'nested', 'clips');
  const file = saveClip(dir, Buffer.from([1]), 'image/png');
  assert.ok(file);
  assert.ok(fs.existsSync(file));
});

test('saveClip rejects empty, oversized, unsupported and malformed input', () => {
  const dir = tempDir();
  assert.equal(saveClip(dir, Buffer.alloc(0), 'image/png'), null);
  assert.equal(saveClip(dir, Buffer.alloc(MAX_BYTES + 1), 'image/png'), null);
  assert.equal(saveClip(dir, Buffer.from([1]), 'text/plain'), null);
  assert.equal(saveClip(dir, 'not bytes', 'image/png'), null);
  assert.equal(saveClip(dir, null, 'image/png'), null);
  // Nothing above should have left a file behind.
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('saveClip returns null instead of throwing when the write fails', () => {
  const dir = tempDir();
  // A FILE where the directory should be: mkdir cannot succeed here.
  const blocked = path.join(dir, 'blocked');
  fs.writeFileSync(blocked, 'in the way');
  assert.equal(saveClip(blocked, Buffer.from([1]), 'image/png'), null);
});

// ---- pruneClips -------------------------------------------------------------

test('pruneClips trims the oldest clips down to the cap', () => {
  const dir = tempDir();
  const names = ['clip-1.png', 'clip-2.png', 'clip-3.png'];
  for (const name of names) fs.writeFileSync(path.join(dir, name), 'x');

  pruneClips(dir, 2);

  assert.deepEqual(fs.readdirSync(dir).sort(), ['clip-2.png', 'clip-3.png']);
});

test('pruneClips leaves foreign files alone', () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'clip-1.png'), 'x');
  fs.writeFileSync(path.join(dir, 'notes.md'), 'x');

  pruneClips(dir, 0);

  assert.deepEqual(fs.readdirSync(dir), ['notes.md']);
});

test('pruneClips on a missing directory is a no-op, not a throw', () => {
  assert.doesNotThrow(() => pruneClips(path.join(tempDir(), 'never-created'), 5));
});

// ---- clipsDir ---------------------------------------------------------------

test('clipsDir is a temp-directory folder of our own', () => {
  assert.equal(clipsDir(), path.join(os.tmpdir(), 'lunacore-clips'));
});

test('the cap is a sane, finite number', () => {
  assert.ok(Number.isInteger(MAX_CLIPS) && MAX_CLIPS > 0);
});

// ---- wiring drift guards ----------------------------------------------------
// The pure half above was always correct - the feature still did nothing,
// because the paste event it relies on was never dispatched: xterm.js turns
// Ctrl+V into \x16 (SYN) and calls preventDefault(), so Chromium's native
// paste never runs. Nothing in a unit test can observe that, so these read the
// source and fail if the load-bearing lines are renamed away, the same drift
// guard test/shortcuts.test.js uses for chord markers.

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

test('terminals.js still claims Ctrl+V away from xterm', () => {
  const src = read('src/renderer/modules/terminals.js');
  assert.match(src, /isPasteChord/, 'the Ctrl+V branch is gone - xterm will swallow the paste as \x16');
  assert.match(src, /if \(isPasteChord\) return false;/, 'the branch must return false, not true');
});

test('the Ctrl+V claim excludes Shift, which Chromium maps to paste-as-plain-text', () => {
  const src = read('src/renderer/modules/terminals.js');
  const branch = src.slice(src.indexOf('const isPasteChord'), src.indexOf('if (isPasteChord)'));
  assert.match(branch, /!event\.shiftKey/);
  assert.match(branch, /!event\.altKey/);
});

test('the image branch is gated on the Settings switch', () => {
  const src = read('src/renderer/modules/terminals.js');
  assert.match(src, /if \(!screenshotPasteEnabled\) return;/);
  assert.match(src, /export function setScreenshotPasteEnabled/);
});

test('screenshotPasteEnabled defaults to ON and survives a round trip', () => {
  const { clampTermPrefs } = require('../src/uiprefs.js');
  const src = read('src/uiprefs.js');
  // Not clampTermPrefs' business (it owns term* only) - assert the three
  // touchpoints a boolean pref needs, the shape notificationsEnabled has.
  assert.ok(typeof clampTermPrefs === 'function');
  assert.match(src, /screenshotPasteEnabled: true,/, 'default must be ON');
  assert.match(src, /typeof obj\.screenshotPasteEnabled === 'boolean'/, 'missing read validation');
  assert.match(src, /typeof partial\.screenshotPasteEnabled === 'boolean'/, 'missing write merge');
});

test('the Settings toggle exists in the markup the module queries', () => {
  const html = read('src/renderer/index.html');
  for (const id of ['shotpaste-toggle', 'shotpaste-status', 'shotpaste-field']) {
    assert.ok(html.includes(`id="${id}"`), `#${id} is missing from index.html`);
  }
  const js = read('src/renderer/modules/termcustom.js');
  for (const id of ['shotpaste-toggle', 'shotpaste-status', 'shotpaste-field']) {
    assert.ok(js.includes(`'${id}'`), `termcustom.js no longer queries #${id}`);
  }
});

test('every shotpaste.* string is defined in BOTH languages', () => {
  const i18n = read('src/renderer/i18n.js');
  for (const key of ['shotpaste.label', 'shotpaste.hint', 'shotpaste.on', 'shotpaste.off']) {
    const hits = i18n.split(`'${key}':`).length - 1;
    assert.equal(hits, 2, `${key} must appear once in pl and once in en (found ${hits})`);
  }
});
