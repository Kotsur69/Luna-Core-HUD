// Testy loadera dzwiekow (sounds.json). pickSoundEntry to czysta funkcja, bez
// I/O - reszta testow sprawdza WYSYLANY config/sounds.json + placeholdery w
// helpers/sounds/ (na wzor testow "danych" w rates.test.js).

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { loadSoundConfig, resolveSoundFile, pickSoundEntry } = require('../src/sounds');

// ---- pickSoundEntry (pure) --------------------------------------------------

const CFG = {
  sfx: {
    keystroke: {
      volume: 35,
      enabled: true,
      variants: [
        { id: 'mechanical', label: 'Mechanical', file: 'sfx/keystroke-mechanical.wav' },
        { id: 'soft', label: 'Soft', file: 'sfx/keystroke-soft.wav' },
      ],
    },
    navClick: { file: 'sfx/nav-click.wav', volume: 55 },
    disabledSfx: { file: 'sfx/nope.wav', volume: 50, enabled: false },
  },
  voice: {
    done: { file: 'voice/done.mp3', volume: 80 },
  },
};

test('pickSoundEntry zwraca file+volume dla prostego wpisu', () => {
  assert.deepEqual(pickSoundEntry(CFG, 'sfx.navClick'), { file: 'sfx/nav-click.wav', volume: 55 });
  assert.deepEqual(pickSoundEntry(CFG, 'voice.done'), { file: 'voice/done.mp3', volume: 80 });
});

test('pickSoundEntry wybiera wariant po id', () => {
  assert.deepEqual(pickSoundEntry(CFG, 'sfx.keystroke', { variant: 'soft' }), {
    file: 'sfx/keystroke-soft.wav',
    volume: 35,
  });
});

test('pickSoundEntry pada na variants[0] gdy brak/niepoprawne id wariantu', () => {
  assert.deepEqual(pickSoundEntry(CFG, 'sfx.keystroke'), {
    file: 'sfx/keystroke-mechanical.wav',
    volume: 35,
  });
  assert.deepEqual(pickSoundEntry(CFG, 'sfx.keystroke', { variant: 'nonexistent' }), {
    file: 'sfx/keystroke-mechanical.wav',
    volume: 35,
  });
});

test('pickSoundEntry zwraca null dla enabled:false', () => {
  assert.equal(pickSoundEntry(CFG, 'sfx.disabledSfx'), null);
});

test('pickSoundEntry zwraca null dla nieznanego klucza/grupy', () => {
  assert.equal(pickSoundEntry(CFG, 'sfx.doesNotExist'), null);
  assert.equal(pickSoundEntry(CFG, 'notAGroup.x'), null);
  assert.equal(pickSoundEntry(null, 'sfx.navClick'), null);
});

test('pickSoundEntry domyslna glosnosc to 70 gdy brak volume w configu', () => {
  const cfg = { sfx: { x: { file: 'sfx/x.wav' } }, voice: {} };
  assert.equal(pickSoundEntry(cfg, 'sfx.x').volume, 70);
});

// ---- pokrycie WYSYLANEGO config/sounds.json + helpers/sounds/ -------------
// Ponizsze testy sprawdzaja config i placeholdery na dysku, nie samą logike -
// pilnuja, zeby resolveSoundFile() naprawde znajdowalo pliki, ktore
// config/sounds.json obiecuje (patrz rates.test.js dla tej samej konwencji).

test('config/sounds.json ma wszystkie 4 warianty keystroke', () => {
  const { sfx } = loadSoundConfig();
  assert.equal(sfx.keystroke.variants.length, 4);
  const ids = sfx.keystroke.variants.map((v) => v.id).sort();
  assert.deepEqual(ids, ['mechanical', 'scifi', 'soft', 'typewriter']);
});

test('resolveSoundFile znajduje kazdy sfx klucz (poza keystroke)', () => {
  for (const key of ['sfx.navClick', 'sfx.modeToggle', 'sfx.terminalNew', 'sfx.terminalClose']) {
    const r = resolveSoundFile(key);
    assert.ok(r, `${key} powinno sie rozwiazac`);
    assert.ok(r.path.endsWith('.wav'));
  }
});

test('resolveSoundFile znajduje kazdy z 5 linii glosowych', () => {
  for (const key of ['voice.welcome', 'voice.needYou', 'voice.done', 'voice.usage50', 'voice.usage80']) {
    const r = resolveSoundFile(key);
    assert.ok(r, `${key} powinno sie rozwiazac`);
    assert.ok(r.path.endsWith('.mp3'));
  }
});

test('resolveSoundFile znajduje kazdy wariant keystroke po id', () => {
  for (const id of ['mechanical', 'soft', 'scifi', 'typewriter']) {
    const r = resolveSoundFile('sfx.keystroke', { variant: id });
    assert.ok(r, `wariant ${id} powinien sie rozwiazac`);
    assert.ok(r.path.includes(`keystroke-${id}.wav`));
  }
});

test('resolveSoundFile zwraca null dla brakujacego pliku', () => {
  assert.equal(resolveSoundFile('sfx.thisKeyDoesNotExistAnywhere'), null);
});
