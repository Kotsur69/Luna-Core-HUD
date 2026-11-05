// ============================================================================
// LunaCore - why a package was left out of the merge (src/orchestraDiagnose.js
// SKIP + the run report's rendering of it).
// ----------------------------------------------------------------------------
// Run pmvqhos4s: game-assets was skipped as 'depSkipped' and the report fell
// back to the merge text ("Git refused to merge the branch") with the
// dependency id quoted as git's message. A red verify was labelled
// "Git said" too. Each stage now has its own words and its own label.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { diagnoseSkip, skipDetailLabel } = require('../src/orchestraDiagnose.js');
const { buildReport, needsYouLines } = require('../src/orchestraReport.js');

test('diagnoseSkip: depSkipped has its own text naming the dependency', () => {
  const d = diagnoseSkip('depSkipped', 'tester-adapters');
  assert.equal(d.what, 'Not merged because a package it depends on was left out.');
  assert.equal(d.why, 'It needs tester-adapters first.');
  assert.equal(d.fix, 'Get tester-adapters merged first, then Retry this one.');
  assert.doesNotMatch(JSON.stringify(d), /Git refused/);
});

test('diagnoseSkip: a depSkipped detail that is not a package id is not quoted', () => {
  const d = diagnoseSkip('depSkipped', 'rm -rf / `x`');
  assert.equal(d.why, 'It needs the package it depends on first.');
  assert.equal(diagnoseSkip('depSkipped').fix, 'Get the package it depends on merged first, then Retry this one.');
});

test('diagnoseSkip: other stages keep their text; an unknown stage still falls back to merge', () => {
  assert.match(diagnoseSkip('verify', 'failing: x').what, /tests went red/);
  assert.match(diagnoseSkip('conflict').what, /conflicts/);
  assert.equal(diagnoseSkip('whatever').what, diagnoseSkip('merge').what);
});

test("skipDetailLabel: 'Git said' only for merge and conflict", () => {
  assert.equal(skipDetailLabel('merge'), 'Git said');
  assert.equal(skipDetailLabel('conflict'), 'Git said');
  assert.equal(skipDetailLabel('verify'), 'Tests said');
  assert.equal(skipDetailLabel('depSkipped'), 'Depends on');
  assert.equal(skipDetailLabel('nope'), 'Detail');
});

const view = () => ({
  id: 'pmvqhos4s',
  repoPath: '/repo',
  baseBranch: 'main',
  workerModel: 'opus',
  permissionMode: 'bypassPermissions',
  integrationMode: 'merge',
  integration: {
    state: 'done',
    partial: true,
    skipped: [
      { id: 'tester-adapters', stage: 'verify', detail: 'failing: adds numbers (test/a.test.js); AssertionError: x', files: [] },
      { id: 'game-assets', stage: 'depSkipped', detail: 'tester-adapters', files: [] },
      { id: 'ui-shell', stage: 'conflict', detail: 'src/x.js', files: ['src/x.js'] },
    ],
  },
  overlaps: [],
  packages: [
    { id: 'core', title: 'Core', state: 'pushed', branch: 'luna/core', merged: true },
    { id: 'tester-adapters', title: 'Adapters', state: 'pushed', branch: 'luna/tester-adapters' },
    { id: 'game-assets', title: 'Assets', state: 'pushed', branch: 'luna/game-assets', dependsOn: ['tester-adapters'] },
    { id: 'ui-shell', title: 'Shell', state: 'pushed', branch: 'luna/ui-shell' },
  ],
});

test('report: depSkipped renders its own diagnosis and "Depends on", never "Git said"', () => {
  const md = buildReport(view(), { now: 0, suggestions: [] });
  const block = md.slice(md.indexOf('### `game-assets`'), md.indexOf('### `ui-shell`'));
  assert.match(block, /What happened: Not merged because a package it depends on was left out\./);
  assert.match(block, /Why: It needs tester-adapters first\./);
  assert.match(block, /How to fix: Get tester-adapters merged first, then Retry this one\./);
  assert.match(block, /- Depends on: `tester-adapters`/);
  assert.doesNotMatch(block, /Git (said|refused)/);
  const needs = needsYouLines(view()).find((l) => l.includes('game-assets'));
  assert.match(needs, /skipped at depSkipped \(depends on: tester-adapters\)/);
});

test('report: a red verify is "Tests said", a conflict stays "Git said"', () => {
  const md = buildReport(view(), { now: 0, suggestions: [] });
  assert.match(md, /- Tests said: `failing: adds numbers \(test\/a\.test\.js\); AssertionError: x`/);
  assert.match(md, /- Git said: `src\/x\.js`/);
  assert.doesNotMatch(md, /Git said: `failing/);
  assert.doesNotMatch(md, /Git said: `tester-adapters`/);
});
