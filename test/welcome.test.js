'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { decideWelcome, isMajorBump, compareVersions, hasLocalConfig, GUIDE_VERSION } = require('../src/welcome');
const { decideWelcomeOnce } = require('../src/setupipc');

const base = { appVersion: '0.17.0', guideVersion: '0.17.0', seen: null, checked: false, hasLocalConfig: false };

test('clean profile: the guide shows', () => {
  assert.equal(decideWelcome(base), 'show');
});

test('existing user (local config at the first start of this version) counts as seen', () => {
  assert.equal(decideWelcome({ ...base, hasLocalConfig: true }), 'mark-seen');
});

test('dismissed with "Don\'t show this again": skipped on the same and later minor versions', () => {
  assert.equal(decideWelcome({ ...base, seen: '0.17.0', checked: true }), 'skip');
  assert.equal(decideWelcome({ ...base, appVersion: '0.17.4', seen: '0.17.0', checked: true }), 'skip');
});

test('closed without the checkbox: shows again next start, even with local config by then', () => {
  assert.equal(decideWelcome({ ...base, checked: true, hasLocalConfig: true }), 'show');
});

test('major bump with a changed guide shows again; without a guide change it does not', () => {
  const seen = { ...base, seen: '0.17.2', checked: true };
  assert.equal(decideWelcome({ ...seen, appVersion: '0.18.0', guideVersion: '0.18.0' }), 'show');
  assert.equal(decideWelcome({ ...seen, appVersion: '0.18.0', guideVersion: '0.17.0' }), 'skip');
  assert.equal(decideWelcome({ ...seen, appVersion: '1.0.0', guideVersion: '0.19.0' }), 'show');
  // A changed guide alone (no major bump) never re-opens it.
  assert.equal(decideWelcome({ ...seen, appVersion: '0.17.9', guideVersion: '0.17.5' }), 'skip');
});

test('a garbled seen value is treated as not seen', () => {
  assert.equal(decideWelcome({ ...base, seen: 'banana', checked: true }), 'show');
});

test('version helpers', () => {
  assert.equal(isMajorBump('0.18.0', '0.17.9'), true);
  assert.equal(isMajorBump('0.17.9', '0.17.0'), false);
  assert.equal(isMajorBump('2.0.0', '1.9.9'), true);
  assert.equal(isMajorBump('1.9.0', '1.0.0'), false);
  assert.equal(isMajorBump('x', '1.0.0'), false);
  assert.equal(compareVersions('0.17.10', '0.17.9'), 1);
  assert.equal(compareVersions('1.0.0', '1.0.0'), 0);
  assert.match(GUIDE_VERSION, /^\d+\.\d+\.\d+$/);
});

test('hasLocalConfig looks for *.local.json only', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-welcome-'));
  try {
    assert.equal(hasLocalConfig(dir), false);
    fs.writeFileSync(path.join(dir, 'themes.json'), '{}');
    assert.equal(hasLocalConfig(dir), false);
    fs.writeFileSync(path.join(dir, 'ui.local.json'), '{}');
    assert.equal(hasLocalConfig(dir), true);
    assert.equal(hasLocalConfig(path.join(dir, 'missing')), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('decideWelcomeOnce records the decision so the next start never re-asks', () => {
  let prefs = { welcomeSeen: null, welcomeChecked: false };
  const io = {
    readPrefs: () => prefs,
    writePrefs: (p) => {
      prefs = { ...prefs, ...p };
      return prefs;
    },
  };

  // Existing user: skipped and marked seen.
  assert.equal(decideWelcomeOnce({ appVersion: '0.17.0', hadLocalConfig: true, ...io }), false);
  assert.deepEqual(prefs, { welcomeSeen: '0.17.0', welcomeChecked: true });
  assert.equal(decideWelcomeOnce({ appVersion: '0.17.0', hadLocalConfig: true, ...io }), false);

  // Clean profile: shown, and checked from then on.
  prefs = { welcomeSeen: null, welcomeChecked: false };
  assert.equal(decideWelcomeOnce({ appVersion: '0.17.0', hadLocalConfig: false, ...io }), true);
  assert.equal(prefs.welcomeChecked, true);
  // Next start, not dismissed with the checkbox, config present by now: still shows.
  assert.equal(decideWelcomeOnce({ appVersion: '0.17.0', hadLocalConfig: true, ...io }), true);
});
