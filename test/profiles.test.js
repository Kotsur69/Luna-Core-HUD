// Testy walidacji profilu uruchomieniowego. normalizeProfile to granica
// zaufania: config moze byc recznie edytowany, wiec smieci nie moga wejsc dalej.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeProfile, getProfile } = require('../src/profiles');

test('normalizeProfile przepuszcza poprawny profil', () => {
  assert.deepEqual(
    normalizeProfile({
      id: 'lm-studio',
      label: 'LM Studio',
      command: 'claude',
      args: ['--continue'],
      env: { ANTHROPIC_BASE_URL: 'http://localhost:1234' },
    }),
    {
      id: 'lm-studio',
      label: 'LM Studio',
      command: 'claude',
      args: ['--continue'],
      env: { ANTHROPIC_BASE_URL: 'http://localhost:1234' },
    }
  );
});

test('normalizeProfile odrzuca wpisy bez id lub label', () => {
  assert.equal(normalizeProfile({ label: 'Bez id' }), null);
  assert.equal(normalizeProfile({ id: 'bez-label' }), null);
  assert.equal(normalizeProfile({ id: '', label: 'Puste id' }), null);
  assert.equal(normalizeProfile({ id: 'x', label: '' }), null);
});

test('normalizeProfile odrzuca nie-obiekty', () => {
  assert.equal(normalizeProfile(null), null);
  assert.equal(normalizeProfile(undefined), null);
  assert.equal(normalizeProfile('claude'), null);
  assert.equal(normalizeProfile(42), null);
});

test('normalizeProfile dopuszcza pusta komende (sama powloka)', () => {
  const p = normalizeProfile({ id: 'shell', label: 'Shell', command: '' });
  assert.equal(p.command, '');
});

test('normalizeProfile zamienia niepoprawna komende na pusty string', () => {
  assert.equal(normalizeProfile({ id: 'x', label: 'X', command: 123 }).command, '');
  assert.equal(normalizeProfile({ id: 'x', label: 'X' }).command, '');
});

test('normalizeProfile odfiltrowuje nie-stringi z args', () => {
  const p = normalizeProfile({ id: 'x', label: 'X', args: ['--a', 5, null, '--b'] });
  assert.deepEqual(p.args, ['--a', '--b']);
});

test('normalizeProfile zamienia args nie-tablice na pusta tablice', () => {
  assert.deepEqual(normalizeProfile({ id: 'x', label: 'X', args: 'nope' }).args, []);
  assert.deepEqual(normalizeProfile({ id: 'x', label: 'X' }).args, []);
});

test('normalizeProfile przepuszcza tylko stringowe wartosci env', () => {
  // Wazne: env leci prosto do pty.spawn - liczba lub obiekt moga wywrocic spawn.
  const p = normalizeProfile({
    id: 'x',
    label: 'X',
    env: { OK: 'tak', LICZBA: 8080, ZAGNIEZDZONY: { a: 1 }, NIC: null },
  });
  assert.deepEqual(p.env, { OK: 'tak' });
});

test('normalizeProfile zamienia env nie-obiekt (w tym tablice) na pusty obiekt', () => {
  assert.deepEqual(normalizeProfile({ id: 'x', label: 'X', env: ['A=1'] }).env, {});
  assert.deepEqual(normalizeProfile({ id: 'x', label: 'X', env: 'A=1' }).env, {});
});

test('normalizeProfile nie przenosi dalej nieznanych pol', () => {
  const p = normalizeProfile({ id: 'x', label: 'X', cokolwiek: 'smiec' });
  assert.deepEqual(Object.keys(p).sort(), ['args', 'command', 'env', 'id', 'label']);
});

test('getProfile znajduje po id, inaczej null', () => {
  const list = [
    { id: 'a', label: 'A' },
    { id: 'b', label: 'B' },
  ];
  assert.equal(getProfile(list, 'b').label, 'B');
  assert.equal(getProfile(list, 'nie-ma'), null);
  assert.equal(getProfile([], 'a'), null);
});
