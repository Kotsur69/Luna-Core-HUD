// D5 tests - the "can this build update itself" decision + normalization of
// data from the network. Pure functions, no I/O and no Electron.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  supportsUpdates,
  normalizeUpdateInfo,
  releaseUrl,
  releasesUrl,
  progressPercent,
  REASON,
  REPO_OWNER,
  REPO_NAME,
} = require('../src/update');

// ---- supportsUpdates: three worlds, three behaviors --------------------------

test('a dev clone does not update itself', () => {
  const r = supportsUpdates({ isPackaged: false, portableDir: null });
  assert.equal(r.supported, false);
  assert.equal(r.reason, REASON.DEV);
});

// This case matters more than it looks: latest.yml contains ONLY the NSIS
// installer, so "updating" the portable version would install a SECOND copy
// of the app alongside the first. Refusing is the correct behavior here.
test('the portable version refuses to update (no installation to replace)', () => {
  const r = supportsUpdates({ isPackaged: true, portableDir: 'D:\\LunaCore' });
  assert.equal(r.supported, false);
  assert.equal(r.reason, REASON.PORTABLE);
});

test('an NSIS installation can update itself', () => {
  const r = supportsUpdates({ isPackaged: true, portableDir: null });
  assert.equal(r.supported, true);
  assert.equal(r.reason, REASON.OK);
});

// Order matters: portable IS packaged, so if isPackaged were checked after
// portableDir, a dev with the env var set would masquerade as an install.
// paths.js has this exact same ordering and for the same reason.
test('dev wins over portable when PORTABLE_EXECUTABLE_DIR leaks into the shell', () => {
  const r = supportsUpdates({ isPackaged: false, portableDir: 'D:\\LunaCore' });
  assert.equal(r.reason, REASON.DEV);
});

test('a missing argument does not throw, it just refuses', () => {
  assert.equal(supportsUpdates(undefined).supported, false);
  assert.equal(supportsUpdates(null).reason, REASON.DEV);
});

// ---- normalizeUpdateInfo: data from the network is untrusted ---------------------

test('normalizeUpdateInfo returns version, date and link', () => {
  const info = normalizeUpdateInfo({
    version: '0.9.1',
    releaseDate: '2026-08-09T10:00:00.000Z',
    files: [{ url: 'LunaCore-Setup-0.9.1.exe' }],
  });
  assert.equal(info.version, '0.9.1');
  assert.equal(info.releaseDate, '2026-08-09T10:00:00.000Z');
  assert.match(info.url, /releases\/tag\/v0\.9\.1$/);
});

// The same rule as with cost (B4): missing data gives NO result, never a
// confident-looking nonsense value like "Update to undefined".
test('a missing version gives null instead of an "undefined" pill', () => {
  assert.equal(normalizeUpdateInfo({ releaseDate: '2026-08-09T10:00:00.000Z' }), null);
  assert.equal(normalizeUpdateInfo({ version: '   ' }), null);
  assert.equal(normalizeUpdateInfo({ version: 42 }), null);
});

test('normalizeUpdateInfo tolerates garbage input', () => {
  assert.equal(normalizeUpdateInfo(null), null);
  assert.equal(normalizeUpdateInfo(undefined), null);
  assert.equal(normalizeUpdateInfo('0.9.1'), null);
});

test('a missing release date is null, not an empty string', () => {
  assert.equal(normalizeUpdateInfo({ version: '0.9.1' }).releaseDate, null);
});

// ---- addresses -----------------------------------------------------------------

test('releaseUrl without a version points at the latest release', () => {
  assert.match(releaseUrl(''), /releases\/latest$/);
  assert.match(releaseUrl(undefined), /releases\/latest$/);
});

test('releasesUrl points at the release index', () => {
  assert.equal(releasesUrl(), `https://github.com/${REPO_OWNER}/${REPO_NAME}/releases`);
});

// ---- progressPercent: NaN must never reach the bar ---------------------
// The reason is historical: a broken ETA stuck at 85% survived three
// refactors precisely because NaN doesn't throw, it silently picks the wrong branch.

test('progressPercent rounds down to whole percent', () => {
  assert.equal(progressPercent({ percent: 42.7 }), 42);
  assert.equal(progressPercent({ percent: 0 }), 0);
  assert.equal(progressPercent({ percent: 100 }), 100);
});

test('progressPercent clamps the range to 0-100', () => {
  assert.equal(progressPercent({ percent: -5 }), 0);
  assert.equal(progressPercent({ percent: 140 }), 100);
});

test('progressPercent never returns NaN', () => {
  for (const bad of [null, undefined, {}, { percent: 'half' }, { percent: NaN }, 'x']) {
    const v = progressPercent(bad);
    assert.ok(Number.isFinite(v), `progressPercent(${JSON.stringify(bad)}) gave ${v}`);
    assert.equal(v, 0);
  }
});

// ---- coverage of the PUBLISHED config -------------------------------------
// Tests of DATA, not logic - the exact same mechanism that caught the
// missing Opus 5 entry in rates.json. Update logic can be all green while the
// app still polls a nonexistent repository, because `publish` in package.json
// drifted from the constants in update.js. No mock would ever catch this.

const pkg = require('../package.json');

test('package.json has a GitHub publish config', () => {
  const publish = pkg.build && pkg.build.publish;
  assert.ok(publish, 'no build.publish - electron-updater has no idea where to look');

  const entries = [].concat(publish);
  const github = entries.find((e) => e && e.provider === 'github');
  assert.ok(github, 'no github provider in build.publish');
});

test('package.json\'s publish matches the addresses in update.js', () => {
  const entries = [].concat(pkg.build.publish);
  const github = entries.find((e) => e && e.provider === 'github');

  assert.equal(github.owner, REPO_OWNER, 'owner drifted from update.js');
  assert.equal(github.repo, REPO_NAME, 'repo drifted from update.js');
});

// electron-updater compares the version from latest.yml against the one in
// package.json. If it were missing or not semver, the app would either never
// see an update, or see one immediately after installing.
test('package.json has a semver-format version', () => {
  assert.match(pkg.version, /^\d+\.\d+\.\d+/, `version "${pkg.version}" is not semver`);
});

test('electron-updater is a production dependency, not a dev one', () => {
  assert.ok(
    pkg.dependencies && pkg.dependencies['electron-updater'],
    'electron-updater in devDependencies would not ship in the packaged app'
  );
  assert.ok(
    !(pkg.devDependencies && pkg.devDependencies['electron-updater']),
    'electron-updater cannot also be in devDependencies'
  );
});
