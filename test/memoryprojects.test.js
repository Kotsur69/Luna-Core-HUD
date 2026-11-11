// ============================================================================
// LunaCore - the per-project memory switch (src/memoryprojects.js)
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { readEnabled, setEnabled, createMemoryProjectsProvider } = require('../src/memoryprojects.js');

function projectsFile(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-memproj-'));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return path.join(dir, 'memory-projects.local.json');
}

const A = 'github.com/acme/demo';
const B = 'github.com/acme/quote';

test('no project has memory until one is switched on', (t) => {
  const file = projectsFile(t);

  assert.deepEqual(readEnabled(file), []);
  assert.deepEqual(setEnabled(file, B, true), [B]);
  assert.deepEqual(setEnabled(file, `git:${A}`, true), [A, B]);
  assert.deepEqual(setEnabled(file, A, true), [A, B]);
  assert.deepEqual(readEnabled(file), [A, B]);
});

test('switching off removes only that project', (t) => {
  const file = projectsFile(t);
  setEnabled(file, A, true);
  setEnabled(file, B, true);

  assert.deepEqual(setEnabled(file, A, false), [B]);
});

test('refuses something that is not a project key', (t) => {
  const file = projectsFile(t);

  assert.throws(() => setEnabled(file, 'global', true), /bad-project/);
  assert.throws(() => setEnabled(file, '../../etc', true), /bad-project/);
});

test('an unreadable file means nothing is switched on', (t) => {
  const file = projectsFile(t);
  fs.writeFileSync(file, '{ not json');

  assert.deepEqual(readEnabled(file), []);
  assert.throws(() => setEnabled(file, A, true));
});

test('the provider carries the switch to another PC and back', (t) => {
  const here = projectsFile(t);
  const there = projectsFile(t);
  setEnabled(here, A, true);
  const from = createMemoryProjectsProvider(here);
  const to = createMemoryProjectsProvider(there);

  assert.equal(to.read(Date.now()).fresh, true);
  const { units, fresh } = from.read(Date.now());
  to.write(units.map(([k, v]) => [k, to.valid(k, v)]));

  assert.equal(fresh, false);
  assert.deepEqual(units, [[`memory-on:${A}`, { on: true }]]);
  assert.deepEqual(readEnabled(there), [A]);
});

test('the provider owns only its own keys and accepts only "on"', (t) => {
  const provider = createMemoryProjectsProvider(projectsFile(t));

  assert.equal(provider.owns(`memory-on:${A}`), true);
  assert.equal(provider.owns('memory-on:not-a-project'), false);
  assert.equal(provider.owns(`memory-on:git:${A}`), false);
  assert.equal(provider.valid(`memory-on:git:${A}`, { on: true }), null);
  assert.equal(provider.owns('host:default'), false);
  assert.equal(provider.valid(`memory-on:${A}`, { on: false }), null);
  assert.deepEqual(provider.valid(`memory-on:${A}`, { on: true, extra: 1 }), { on: true });
});
