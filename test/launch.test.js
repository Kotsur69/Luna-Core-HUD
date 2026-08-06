// Testy budowania komendy startowej (src/launch.js).
//
// Why this file matters: withSessionId is the switch that decides whether a tab
// can be pinned to its transcript. A wrong `null` here does not fail loudly - it
// quietly restores the old timestamp guessing, and every other test stays green.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { withSessionId, findExecutable } = require('../src/launch');

const UUID = '00000000-0000-0000-0000-000000000000';

// ---- findExecutable (D3) ----------------------------------------------------
// Drives the "Claude Code not found" notice. A false negative nags someone whose
// install is fine; a false positive leaves a newcomer with no explanation at all.

/** Fake filesystem: only the listed paths exist. */
const fsWith = (...present) => {
  const set = new Set(present.map((p) => p.toLowerCase()));
  return (p) => set.has(String(p).toLowerCase());
};

test('findExecutable znajduje claude.cmd na Windows (instalacja przez npm)', () => {
  const PATH = 'C:\\Windows;C:\\Users\\x\\AppData\\Roaming\\npm';
  const hit = 'C:\\Users\\x\\AppData\\Roaming\\npm\\claude.cmd';
  assert.equal(findExecutable('claude', PATH, true, fsWith(hit)), hit);
});

test('findExecutable znajduje bezrozszerzeniowy plik na POSIX', () => {
  const hit = '/home/x/.local/bin/claude';
  assert.equal(findExecutable('claude', '/usr/bin:/home/x/.local/bin', false, fsWith(hit)), hit);
});

test('findExecutable zwraca null, gdy binarki nigdzie nie ma', () => {
  assert.equal(findExecutable('claude', 'C:\\Windows;C:\\Temp', true, fsWith()), null);
});

test('findExecutable przezywa pusty i uszkodzony PATH', () => {
  // Puste segmenty i cudzyslowy wokol katalogow to normalny widok w PATH na
  // Windows - nie moga przerwac szukania.
  const hit = 'C:\\bin\\claude.exe';
  assert.equal(findExecutable('claude', ';;"C:\\bin";', true, fsWith(hit)), hit);
  assert.equal(findExecutable('claude', '', true, fsWith(hit)), null);
  assert.equal(findExecutable('claude', undefined, true, fsWith(hit)), null);
});

test('findExecutable nie przewraca sie na wpisie, ktory rzuca wyjatkiem', () => {
  // Jeden nieczytelny katalog nie moze sprawic, ze obecna binarka wyglada na
  // nieobecna - inaczej pokazalibysmy ostrzezenie komus, kto ma wszystko dobrze.
  const hit = 'C:\\good\\claude.exe';
  const exists = (p) => {
    if (String(p).startsWith('C:\\bad')) throw new Error('EACCES');
    return p === hit;
  };
  assert.equal(findExecutable('claude', 'C:\\bad;C:\\good', true, exists), hit);
});

test('findExecutable woli .exe/.cmd od wariantu bez rozszerzenia', () => {
  const dir = 'C:\\bin';
  const both = fsWith('C:\\bin\\claude.exe', 'C:\\bin\\claude');
  assert.equal(findExecutable('claude', dir, true, both), 'C:\\bin\\claude.exe');
});

test('withSessionId pins a plain claude launch', () => {
  // The default profile (config/profiles.json -> "claude-cloud") is exactly this
  // string. If this case ever returns null, pinning is dead app-wide.
  assert.equal(withSessionId('claude', UUID), `claude --session-id ${UUID}`);
});

test('withSessionId keeps the existing arguments', () => {
  assert.equal(
    withSessionId('claude --model opus', UUID),
    `claude --model opus --session-id ${UUID}`,
  );
});

test('withSessionId accepts a path or .exe/.cmd form of the binary', () => {
  for (const cmd of ['claude.exe', 'claude.cmd', 'C:\\Users\\x\\.local\\bin\\claude.exe']) {
    assert.ok(
      String(withSessionId(cmd, UUID)).includes(`--session-id ${UUID}`),
      `expected ${cmd} to be pinnable`,
    );
  }
});

test('withSessionId refuses an empty command (bare shell profile)', () => {
  assert.equal(withSessionId('', UUID), null);
  assert.equal(withSessionId('   ', UUID), null);
  assert.equal(withSessionId(undefined, UUID), null);
});

test('withSessionId refuses a program that is not claude', () => {
  // A profile may start anything; labelling a foreign process would be a lie.
  assert.equal(withSessionId('pwsh', UUID), null);
  assert.equal(withSessionId('npm start', UUID), null);
  assert.equal(withSessionId('claude-code-proxy', UUID), null);
});

test('withSessionId refuses when the session id is already decided', () => {
  // Resuming picks its own id; forcing ours would conflict or hijack it.
  for (const cmd of [
    'claude -c',
    'claude --continue',
    'claude -r abc',
    'claude --resume abc',
    'claude --fork-session',
    `claude --session-id ${UUID}`,
  ]) {
    assert.equal(withSessionId(cmd, UUID), null, `expected ${cmd} to be left alone`);
  }
});

test('withSessionId does not confuse a flag that merely contains a resume word', () => {
  // Substring matching here would wrongly disable pinning.
  assert.ok(String(withSessionId('claude --continue-on-error', UUID)).includes('--session-id'));
  assert.ok(String(withSessionId('claude --resumable', UUID)).includes('--session-id'));
});

test('withSessionId refuses without a uuid', () => {
  assert.equal(withSessionId('claude', ''), null);
  assert.equal(withSessionId('claude', undefined), null);
});
