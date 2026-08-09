// Testy E1 (strona renderera) - bufor serii i formatowanie odczytow.
//
// Rozdzielone od test/telemetry.test.js celowo: tamten plik pilnuje ARYTMETYKI
// w procesie glownym, ten - tego, co uzytkownik faktycznie czyta. Blad w
// formatowaniu nie wywala niczego, tylko pokazuje spokojnie zla liczbe, czyli
// dokladnie ta klase bledu, ktora przezyla trzy refaktory w sparkline.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  pushTelemetry,
  telemetryHistory,
  barLevel,
  formatBytes,
  formatUptime,
  formatLoad,
  TELEM_MAX,
  TELEM_WARN,
  TELEM_CRIT,
} = require('../src/renderer/modules/telemetry.js');

const GIB = 1024 * 1024 * 1024;

// ---- Bufor serii ------------------------------------------------------------

test('pushTelemetry przycina serie do TELEM_MAX', () => {
  for (let i = 0; i < TELEM_MAX + 15; i += 1) pushTelemetry({ at: i, mem: null, cpu: {} });
  const h = telemetryHistory();
  assert.equal(h.length, TELEM_MAX);
  // Zostaja NAJNOWSZE probki, nie najstarsze.
  assert.equal(h[h.length - 1].at, TELEM_MAX + 14);
});

test('pushTelemetry ignoruje smieci zamiast wpuszczac je do wykresu', () => {
  const before = telemetryHistory().length;
  pushTelemetry(null);
  pushTelemetry(undefined);
  pushTelemetry('42%');
  assert.equal(telemetryHistory().length, before);
});

// ---- Progi ------------------------------------------------------------------

test('barLevel dzieli zakres na trzy pasma', () => {
  assert.equal(barLevel(0), 'ok');
  assert.equal(barLevel(TELEM_WARN - 1), 'ok');
  assert.equal(barLevel(TELEM_WARN), 'warn');
  assert.equal(barLevel(TELEM_CRIT - 1), 'warn');
  assert.equal(barLevel(TELEM_CRIT), 'crit');
  assert.equal(barLevel(100), 'crit');
});

// "Nie wiem" to nie to samo, co "0%". Zerowy slupek klamalby o odczycie.
test('barLevel oddziela brak odczytu od zera', () => {
  assert.equal(barLevel(null), 'unknown');
  assert.equal(barLevel(undefined), 'unknown');
  assert.equal(barLevel(NaN), 'unknown');
  assert.equal(barLevel(0), 'ok');
});

// Progi maszyny NIE moga byc progami okna kontekstu - kontekst na 60% zmierza do
// compacta, maszyna na 60% RAM po prostu pracuje.
test('progi maszyny sa wyzsze niz progi okna kontekstu', () => {
  const { CTX_WARN_MID, CTX_WARN_HIGH } = require('../src/renderer/modules/thresholds.js');
  assert.ok(TELEM_WARN / 100 > CTX_WARN_MID);
  assert.ok(TELEM_CRIT / 100 > CTX_WARN_HIGH);
});

// ---- Formatowanie -----------------------------------------------------------

test('formatBytes liczy w GiB, tak jak robi to system', () => {
  assert.equal(formatBytes(32 * GIB), '32.0 GB');
  assert.equal(formatBytes(19.84 * GIB), '19.8 GB');
  assert.equal(formatBytes(0), '0.0 GB');
});

test('formatBytes zwraca null dla nie-liczby', () => {
  assert.equal(formatBytes(null), null);
  assert.equal(formatBytes(-1), null);
  assert.equal(formatBytes(NaN), null);
  assert.equal(formatBytes('8GB'), null);
});

test('formatUptime pokazuje dni dopiero gdy sa', () => {
  assert.equal(formatUptime(0), '00:00');
  assert.equal(formatUptime(3600 + 17 * 60), '01:17');
  assert.equal(formatUptime(4 * 86400 + 2 * 3600 + 17 * 60), '4d 02:17');
});

// Szerokosc linii nie moze skakac co minute - stad padStart.
test('formatUptime trzyma stala szerokosc godzin i minut', () => {
  assert.equal(formatUptime(60), '00:01');
  assert.equal(formatUptime(9 * 3600 + 5 * 60), '09:05');
});

test('formatUptime zwraca null dla bezsensownego wejscia', () => {
  assert.equal(formatUptime(-1), null);
  assert.equal(formatUptime(NaN), null);
  assert.equal(formatUptime(null), null);
});

test('formatLoad sklada trzy liczby po dwa miejsca', () => {
  assert.equal(formatLoad([1.5, 1.25, 0.9]), '1.50  1.25  0.90');
});

// To jest ten wazny po stronie UI: na Windows payload niesie null, a widget ma
// wtedy NIE pisac nic - zamiast trzech zer udajacych pomiar.
test('formatLoad zwraca null dla braku pomiaru', () => {
  assert.equal(formatLoad(null), null);
  assert.equal(formatLoad([]), null);
  assert.equal(formatLoad([1.0, 2.0]), null);
  assert.equal(formatLoad(['1.0', '2.0', '3.0']), null);
});

// ---- Obie polowy razem ------------------------------------------------------
//
// Wzorzec z spark.test.js: pola, ktore jedna strona zapisuje, a druga czyta,
// musza byc sprawdzone w jednym przebiegu - inaczej literowka w nazwie pola
// przechodzi przez obie suity.

test('probka z src/telemetry.js przechodzi przez bufor i formatery', () => {
  const os = require('node:os');
  const { sample, toPayload } = require('../src/telemetry.js');

  const payload = toPayload(sample(os, null));
  pushTelemetry(payload);
  const last = telemetryHistory()[telemetryHistory().length - 1];

  assert.equal(last, payload);
  assert.notEqual(formatBytes(last.mem.used), null, 'mem.used musi istniec pod ta nazwa');
  assert.notEqual(formatBytes(last.mem.total), null, 'mem.total musi istniec pod ta nazwa');
  assert.notEqual(formatUptime(last.uptime), null, 'uptime musi istniec pod ta nazwa');
  assert.equal(typeof last.cpu.cores, 'number', 'cpu.cores musi istniec pod ta nazwa');
  assert.notEqual(barLevel(last.mem.percent), 'unknown', 'mem.percent musi byc liczba');
});
