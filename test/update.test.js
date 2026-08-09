// Testy D5 - decyzja "czy ta kompilacja moze sie zaktualizowac" + normalizacja
// danych z sieci. Czyste funkcje, bez I/O i bez Electrona.

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

// ---- supportsUpdates: trzy swiaty, trzy zachowania --------------------------

test('klon deweloperski nie aktualizuje sie sam', () => {
  const r = supportsUpdates({ isPackaged: false, portableDir: null });
  assert.equal(r.supported, false);
  assert.equal(r.reason, REASON.DEV);
});

// Ten przypadek jest wazniejszy, niz wyglada: latest.yml zawiera WYLACZNIE
// instalator NSIS, wiec "aktualizacja" wersji portable zainstalowalaby DRUGA
// kopie aplikacji obok pierwszej. Odmowa jest tu poprawnym zachowaniem.
test('wersja portable odmawia aktualizacji (brak instalacji do podmiany)', () => {
  const r = supportsUpdates({ isPackaged: true, portableDir: 'D:\\LunaCore' });
  assert.equal(r.supported, false);
  assert.equal(r.reason, REASON.PORTABLE);
});

test('instalacja NSIS moze sie aktualizowac', () => {
  const r = supportsUpdates({ isPackaged: true, portableDir: null });
  assert.equal(r.supported, true);
  assert.equal(r.reason, REASON.OK);
});

// Kolejnosc ma znaczenie: portable JEST spakowany, wiec gdyby isPackaged
// sprawdzac po portableDir, dev z ustawiona zmienna srodowiskowa udawalby
// instalacje. paths.js ma dokladnie ten sam porzadek i z tego samego powodu.
test('dev wygrywa nad portable, gdy PORTABLE_EXECUTABLE_DIR wycieknie do shella', () => {
  const r = supportsUpdates({ isPackaged: false, portableDir: 'D:\\LunaCore' });
  assert.equal(r.reason, REASON.DEV);
});

test('brak argumentu nie wywala sie, tylko odmawia', () => {
  assert.equal(supportsUpdates(undefined).supported, false);
  assert.equal(supportsUpdates(null).reason, REASON.DEV);
});

// ---- normalizeUpdateInfo: dane z sieci sa nieufne ---------------------------

test('normalizeUpdateInfo zwraca wersje, date i link', () => {
  const info = normalizeUpdateInfo({
    version: '0.9.1',
    releaseDate: '2026-08-09T10:00:00.000Z',
    files: [{ url: 'LunaCore-Setup-0.9.1.exe' }],
  });
  assert.equal(info.version, '0.9.1');
  assert.equal(info.releaseDate, '2026-08-09T10:00:00.000Z');
  assert.match(info.url, /releases\/tag\/v0\.9\.1$/);
});

// Ta sama zasada co przy koszcie (B4): brak danych daje BRAK wyniku, nigdy
// pewnie wygladajaca bzdure w rodzaju "Aktualizacja do undefined".
test('brak wersji daje null zamiast pilki "undefined"', () => {
  assert.equal(normalizeUpdateInfo({ releaseDate: '2026-08-09T10:00:00.000Z' }), null);
  assert.equal(normalizeUpdateInfo({ version: '   ' }), null);
  assert.equal(normalizeUpdateInfo({ version: 42 }), null);
});

test('normalizeUpdateInfo znosi smieci na wejsciu', () => {
  assert.equal(normalizeUpdateInfo(null), null);
  assert.equal(normalizeUpdateInfo(undefined), null);
  assert.equal(normalizeUpdateInfo('0.9.1'), null);
});

test('brak daty wydania to null, a nie pusty string', () => {
  assert.equal(normalizeUpdateInfo({ version: '0.9.1' }).releaseDate, null);
});

// ---- adresy -----------------------------------------------------------------

test('releaseUrl bez wersji wskazuje na najnowsze wydanie', () => {
  assert.match(releaseUrl(''), /releases\/latest$/);
  assert.match(releaseUrl(undefined), /releases\/latest$/);
});

test('releasesUrl wskazuje na indeks wydan', () => {
  assert.equal(releasesUrl(), `https://github.com/${REPO_OWNER}/${REPO_NAME}/releases`);
});

// ---- progressPercent: NaN nigdy nie moze dojsc do paska ---------------------
// Powod jest historyczny: zepsute ETA do 85% przezylo trzy refaktory wlasnie
// dlatego, ze NaN nie rzuca wyjatkiem, tylko po cichu wybiera zla galaz.

test('progressPercent zaokragla w dol do calych procent', () => {
  assert.equal(progressPercent({ percent: 42.7 }), 42);
  assert.equal(progressPercent({ percent: 0 }), 0);
  assert.equal(progressPercent({ percent: 100 }), 100);
});

test('progressPercent przycina zakres do 0-100', () => {
  assert.equal(progressPercent({ percent: -5 }), 0);
  assert.equal(progressPercent({ percent: 140 }), 100);
});

test('progressPercent nigdy nie zwraca NaN', () => {
  for (const bad of [null, undefined, {}, { percent: 'polowa' }, { percent: NaN }, 'x']) {
    const v = progressPercent(bad);
    assert.ok(Number.isFinite(v), `progressPercent(${JSON.stringify(bad)}) dalo ${v}`);
    assert.equal(v, 0);
  }
});

// ---- pokrycie WYSYLANEGO configu -------------------------------------------
// Testy DANYCH, nie logiki - dokladnie ten sam mechanizm, ktory zlapal brak
// Opus 5 w rates.json. Logika aktualizacji moze byc zielona, a mimo to aplikacja
// bedzie odpytywac nieistniejace repozytorium, bo publish w package.json
// rozjechal sie ze stalymi w update.js. Tego zadna atrapa nie wykryje.

const pkg = require('../package.json');

test('package.json ma konfiguracje publish dla GitHuba', () => {
  const publish = pkg.build && pkg.build.publish;
  assert.ok(publish, 'brak build.publish - electron-updater nie wie, gdzie szukac');

  const entries = [].concat(publish);
  const github = entries.find((e) => e && e.provider === 'github');
  assert.ok(github, 'brak dostawcy github w build.publish');
});

test('publish w package.json zgadza sie z adresami w update.js', () => {
  const entries = [].concat(pkg.build.publish);
  const github = entries.find((e) => e && e.provider === 'github');

  assert.equal(github.owner, REPO_OWNER, 'owner rozjechal sie z update.js');
  assert.equal(github.repo, REPO_NAME, 'repo rozjechalo sie z update.js');
});

// electron-updater porownuje wersje z latest.yml z ta z package.json. Gdyby
// zabraklo jej lub byla nie-semver, aplikacja albo nigdy nie zobaczy
// aktualizacji, albo zobaczy ja natychmiast po instalacji.
test('package.json ma wersje w formacie semver', () => {
  assert.match(pkg.version, /^\d+\.\d+\.\d+/, `wersja "${pkg.version}" nie jest semver`);
});

test('electron-updater jest zaleznoscia produkcyjna, nie deweloperska', () => {
  assert.ok(
    pkg.dependencies && pkg.dependencies['electron-updater'],
    'electron-updater w devDependencies nie trafi do spakowanej aplikacji'
  );
  assert.ok(
    !(pkg.devDependencies && pkg.devDependencies['electron-updater']),
    'electron-updater nie moze byc jednoczesnie w devDependencies'
  );
});
