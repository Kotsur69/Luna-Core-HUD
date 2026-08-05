// ============================================================================
// LunaCore - testy rozwiazywania sciezek konfiguracji (D1)
// ----------------------------------------------------------------------------
// resolveUserDir() jest czysta wlasnie po to, zeby dalo sie ja przetestowac bez
// Electrona: kazdy stan srodowiska (dev / portable / zainstalowany / awaryjny)
// to zwykly obiekt wejsciowy. Testy uruchamiaja sie pod golym node, gdzie
// require('electron') zawodzi - czyli dokladnie w galezi "klon dev".
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const paths = require('../src/paths');

const BUNDLED = '/app/resources/app.asar/config';

test('klon dev: nieopakowana aplikacja zawsze uzywa katalogu repo', () => {
  const dir = paths.resolveUserDir({
    isPackaged: false,
    userData: 'C:\\Users\\x\\AppData\\Roaming\\LunaCore',
    portableDir: 'D:\\LunaCore',
    bundledDir: BUNDLED,
  });
  // Kluczowe: ani userData, ani portableDir nie moga przejac kontroli w devie -
  // inaczej zabladzana zmienna srodowiskowa przeniosla by config pod stopami.
  assert.strictEqual(dir, BUNDLED);
});

test('wersja portable: config laduje obok .exe', () => {
  const dir = paths.resolveUserDir({
    isPackaged: true,
    userData: null,
    portableDir: 'D:\\LunaCore',
    bundledDir: BUNDLED,
  });
  assert.strictEqual(dir, path.join('D:\\LunaCore', paths.PORTABLE_DIRNAME));
});

test('wersja zainstalowana: config w userData', () => {
  const userData = 'C:\\Users\\x\\AppData\\Roaming\\LunaCore';
  const dir = paths.resolveUserDir({
    isPackaged: true,
    userData,
    portableDir: null,
    bundledDir: BUNDLED,
  });
  assert.strictEqual(dir, path.join(userData, 'config'));
});

test('portable wygrywa z userData, gdy oba sa znane', () => {
  const dir = paths.resolveUserDir({
    isPackaged: true,
    userData: 'C:\\Users\\x\\AppData\\Roaming\\LunaCore',
    portableDir: 'D:\\LunaCore',
    bundledDir: BUNDLED,
  });
  // Wersja portable ma z definicji byc samowystarczalna - jesli uzytkownik
  // odpalil ja z pendrive'a, ustawienia maja jechac razem z nia.
  assert.strictEqual(dir, path.join('D:\\LunaCore', paths.PORTABLE_DIRNAME));
});

test('awaryjnie: spakowana, ale bez zadnej informacji -> katalog bundled', () => {
  const dir = paths.resolveUserDir({
    isPackaged: true,
    userData: null,
    portableDir: null,
    bundledDir: BUNDLED,
  });
  assert.strictEqual(dir, BUNDLED);
});

test('pod golym node (testy) local() i bundled() wskazuja ten sam katalog', () => {
  // To jest gwarancja "nic sie nie zmienia w devie": ui.local.json zostaje
  // dokladnie tam, gdzie byl przed D1.
  assert.strictEqual(path.dirname(paths.local('ui.local.json')), paths.bundledDir());
  assert.strictEqual(path.dirname(paths.bundled('themes.json')), paths.bundledDir());
});

test('bundled() naprawde trafia w wysylane pliki konfiguracji', () => {
  // Straznik dryfu: gdyby ktos przeniosl config/ albo zmienil uklad repo,
  // paths.js musi sie przeniesc razem z nim. Bez tego testu blad ujawnilby sie
  // dopiero w zbudowanej aplikacji, gdzie kazdy motyw po cichu wraca do
  // wbudowanego fallbacku.
  for (const name of ['themes.json', 'layouts.json', 'profiles.json']) {
    assert.ok(fs.existsSync(paths.bundled(name)), `brak wysylanego pliku ${name}`);
  }
});

test('local() nie zwraca sciezki wewnatrz asar w zadnej galezi spakowanej', () => {
  // Sedno D1: w zbudowanej aplikacji katalog zapisywalny nigdy nie moze wskazywac
  // do wnetrza asar, bo kazdy zapis cicho przepada (ustawienia sie nie zapisuja).
  const packed = [
    { isPackaged: true, userData: 'C:\\Users\\x\\AppData\\Roaming\\LunaCore', portableDir: null },
    { isPackaged: true, userData: null, portableDir: 'D:\\LunaCore' },
  ];
  for (const env of packed) {
    const dir = paths.resolveUserDir({ ...env, bundledDir: BUNDLED });
    assert.ok(!dir.includes('.asar'), `katalog zapisywalny wpadl do asar: ${dir}`);
  }
});
