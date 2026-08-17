// ============================================================================
// LunaCore - config path resolution tests (D1)
// ----------------------------------------------------------------------------
// resolveUserDir() is pure precisely so it can be tested without Electron:
// every environment state (dev / portable / installed / fallback) is just a
// plain input object. Tests run under bare node, where require('electron')
// fails - i.e. exactly in the "dev clone" branch.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const paths = require('../src/paths');

const BUNDLED = '/app/resources/app.asar/config';

test('dev clone: an unpackaged app always uses the repo directory', () => {
  const dir = paths.resolveUserDir({
    isPackaged: false,
    userData: 'C:\\Users\\x\\AppData\\Roaming\\LunaCore',
    portableDir: 'D:\\LunaCore',
    bundledDir: BUNDLED,
  });
  // Key: neither userData nor portableDir may take over control in dev -
  // otherwise a stray environment variable would move the config out from under us.
  assert.strictEqual(dir, BUNDLED);
});

test('portable version: config lives next to the .exe', () => {
  const dir = paths.resolveUserDir({
    isPackaged: true,
    userData: null,
    portableDir: 'D:\\LunaCore',
    bundledDir: BUNDLED,
  });
  assert.strictEqual(dir, path.join('D:\\LunaCore', paths.PORTABLE_DIRNAME));
});

test('installed version: config in userData', () => {
  const userData = 'C:\\Users\\x\\AppData\\Roaming\\LunaCore';
  const dir = paths.resolveUserDir({
    isPackaged: true,
    userData,
    portableDir: null,
    bundledDir: BUNDLED,
  });
  assert.strictEqual(dir, path.join(userData, 'config'));
});

test('portable wins over userData when both are known', () => {
  const dir = paths.resolveUserDir({
    isPackaged: true,
    userData: 'C:\\Users\\x\\AppData\\Roaming\\LunaCore',
    portableDir: 'D:\\LunaCore',
    bundledDir: BUNDLED,
  });
  // The portable version is by definition meant to be self-contained - if the
  // user ran it from a USB drive, settings must travel along with it.
  assert.strictEqual(dir, path.join('D:\\LunaCore', paths.PORTABLE_DIRNAME));
});

test('emergency case: packaged but with no information at all -> the bundled dir', () => {
  const dir = paths.resolveUserDir({
    isPackaged: true,
    userData: null,
    portableDir: null,
    bundledDir: BUNDLED,
  });
  assert.strictEqual(dir, BUNDLED);
});

test('under plain node (tests) local() and bundled() point at the same directory', () => {
  // This is the guarantee that "nothing changes in dev": ui.local.json stays
  // exactly where it was before D1.
  assert.strictEqual(path.dirname(paths.local('ui.local.json')), paths.bundledDir());
  assert.strictEqual(path.dirname(paths.bundled('themes.json')), paths.bundledDir());
});

test('bundled() genuinely resolves to the shipped config files', () => {
  // Drift guard: if someone moves config/ or reshuffles the repo layout,
  // paths.js must move along with it. Without this test the bug would only
  // surface in the built app, where every theme would silently fall back to
  // the bundled default.
  for (const name of ['themes.json', 'layouts.json', 'profiles.json']) {
    assert.ok(fs.existsSync(paths.bundled(name)), `missing shipped file ${name}`);
  }
});

test('local() never returns a path inside the asar on any packaged branch', () => {
  // The crux of D1: in the built app, the writable directory must never point
  // inside the asar, because every write silently vanishes (settings don't save).
  const packed = [
    { isPackaged: true, userData: 'C:\\Users\\x\\AppData\\Roaming\\LunaCore', portableDir: null },
    { isPackaged: true, userData: null, portableDir: 'D:\\LunaCore' },
  ];
  for (const env of packed) {
    const dir = paths.resolveUserDir({ ...env, bundledDir: BUNDLED });
    assert.ok(!dir.includes('.asar'), `writable directory landed in asar: ${dir}`);
  }
});
