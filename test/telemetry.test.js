// Testy E1 - arytmetyka telemetrii maszyny (RAM / CPU / uptime). Czyste funkcje
// karmione atrapa `os`, bez I/O i bez Electrona.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');

const {
  cpuTotals,
  cpuPercent,
  memStats,
  sample,
  toPayload,
  hasLoadAverage,
  TelemetryWatcher,
  SAMPLE_MS,
} = require('../src/telemetry');

const GB = 1024 * 1024 * 1024;

/** Rdzen o zadanych licznikach tickow. */
function core(idle, busy, speed = 3400) {
  return { speed, times: { user: busy, nice: 0, sys: 0, idle, irq: 0 } };
}

/** Atrapa `os` - tylko to, czego dotyka telemetry.js. */
function fakeOs(over = {}) {
  return {
    totalmem: () => 32 * GB,
    freemem: () => 12 * GB,
    cpus: () => [core(1000, 1000), core(1000, 1000)],
    uptime: () => 3600,
    loadavg: () => [1.5, 1.2, 0.9],
    platform: () => 'linux',
    ...over,
  };
}

// ---- cpuTotals: sumowanie i przypadki puste --------------------------------

test('cpuTotals sumuje liczniki wszystkich rdzeni', () => {
  const r = cpuTotals([core(100, 300), core(200, 400)]);
  assert.equal(r.idle, 300);
  assert.equal(r.total, 1000);
});

test('cpuTotals zwraca null dla braku rdzeni', () => {
  assert.equal(cpuTotals([]), null);
  assert.equal(cpuTotals(null), null);
  assert.equal(cpuTotals(undefined), null);
});

// Maszyna bez odczytu CPU to nie maszyna na 0% - null musi przejsc dalej,
// bo linijke pozniej dzielilibysmy przez zero.
test('cpuTotals odroznia brak odczytu od zerowego obciazenia', () => {
  assert.equal(cpuTotals([{ times: { user: 0, idle: 0 } }]), null);
});

test('cpuTotals pomija rdzen bez pola times zamiast rzucac', () => {
  const r = cpuTotals([core(100, 100), {}, null]);
  assert.equal(r.total, 200);
});

// ---- cpuPercent: to jest DELTA, nie odczyt ---------------------------------

test('cpuPercent liczy zajetosc z roznicy dwoch probek', () => {
  const prev = { idle: 1000, total: 2000 };
  const cur = { idle: 1100, total: 2200 }; // 200 tickow, z tego 100 bezczynnych
  assert.equal(cpuPercent(prev, cur), 50);
});

test('cpuPercent bez poprzedniej probki zwraca null, nie zero', () => {
  assert.equal(cpuPercent(null, { idle: 1, total: 2 }), null);
});

test('cpuPercent zwraca null gdy licznik nie drgnal', () => {
  const same = { idle: 1000, total: 2000 };
  assert.equal(cpuPercent(same, same), null);
});

// Po uspieniu maszyny liczniki potrafia sie cofnac. To "nie wiadomo",
// a nie "bezczynny".
test('cpuPercent zwraca null gdy liczniki sie cofnely', () => {
  assert.equal(cpuPercent({ idle: 1000, total: 2000 }, { idle: 900, total: 1900 }), null);
});

test('cpuPercent trzyma sie zakresu 0-100', () => {
  const r = cpuPercent({ idle: 0, total: 0 }, { idle: 0, total: 1000 });
  assert.equal(r, 100);
});

// ---- memStats ---------------------------------------------------------------

test('memStats liczy uzycie i procent', () => {
  const r = memStats(32 * GB, 12 * GB);
  assert.equal(r.used, 20 * GB);
  assert.equal(r.percent, 63);
});

test('memStats zwraca null dla bezsensownego totalu', () => {
  assert.equal(memStats(0, 0), null);
  assert.equal(memStats(-1, 0), null);
  assert.equal(memStats(NaN, 0), null);
});

// Odczyt "wiecej wolnego niz calosc" nie moze dac ujemnego uzycia ani paska
// wychodzacego poza panel.
test('memStats przycina absurdalny odczyt zamiast go propagowac', () => {
  const r = memStats(8 * GB, 99 * GB);
  assert.equal(r.used, 0);
  assert.equal(r.percent, 0);
  const r2 = memStats(8 * GB, -5);
  assert.equal(r2.percent, 100);
});

// ---- sample: kazde pole osobno moze byc nieznane ---------------------------

test('sample sklada pelny odczyt', () => {
  const s = sample(fakeOs(), { idle: 1000, total: 3000 });
  assert.equal(s.mem.percent, 63);
  assert.equal(s.cpu.cores, 2);
  assert.equal(s.cpu.speedMhz, 3400);
  assert.equal(s.uptime, 3600);
  assert.deepEqual(s.load, [1.5, 1.2, 0.9]);
});

test('sample bez poprzednich tickow oddaje cpu.percent = null', () => {
  const s = sample(fakeOs(), null);
  assert.equal(s.cpu.percent, null);
  assert.notEqual(s.mem, null, 'brak CPU nie moze zabrac odczytu RAM');
});

test('sample przezywa os, ktory rzuca', () => {
  const s = sample(
    fakeOs({
      cpus: () => {
        throw new Error('brak dostepu');
      },
    }),
    null
  );
  assert.equal(s.cpu.cores, 0);
  assert.notEqual(s.mem, null);
});

test('sample uodparnia sie na ujemny uptime', () => {
  assert.equal(sample(fakeOs({ uptime: () => -1 }), null).uptime, null);
  assert.equal(sample(fakeOs({ uptime: () => NaN }), null).uptime, null);
});

// TO JEST TEN WAZNY. os.loadavg() na Windows zwraca [0,0,0] z definicji, a to
// aplikacja pisana pod Windows. Pokazanie "0.00 0.00 0.00" byloby zmyslonym
// odczytem udajacym pomiar.
test('load average jest null na Windows, a nie trzema zerami', () => {
  const s = sample(fakeOs({ platform: () => 'win32', loadavg: () => [0, 0, 0] }), null);
  assert.equal(s.load, null);
  assert.equal(hasLoadAverage('win32'), false);
  assert.equal(hasLoadAverage('linux'), true);
  assert.equal(hasLoadAverage('darwin'), true);
});

test('sample odrzuca niekompletny loadavg', () => {
  assert.equal(sample(fakeOs({ loadavg: () => [1.0] }), null).load, null);
  assert.equal(sample(fakeOs({ loadavg: () => 'duzo' }), null).load, null);
});

// ---- toPayload: liczniki nie przechodza przez IPC --------------------------

test('toPayload zdejmuje surowe liczniki tickow', () => {
  const s = sample(fakeOs(), null);
  assert.notEqual(s.ticks, undefined, 'sample() trzyma ticks na uzytek watchera');
  assert.equal(toPayload(s).ticks, undefined, 'ale renderer ich nie dostaje');
  assert.notEqual(toPayload(s).mem, undefined);
});

test('toPayload zwraca null dla pustego wejscia', () => {
  assert.equal(toPayload(null), null);
});

// ---- TelemetryWatcher -------------------------------------------------------

test('watcher emituje probke na kazdy tick, takze niezmieniona', () => {
  const seen = [];
  const w = new TelemetryWatcher((p) => seen.push(p), fakeOs());
  w.start();
  w.tick();
  w.tick();
  w.stop();

  assert.equal(seen.length, 2, 'seria czasowa: identyczny odczyt to nadal punkt');
  assert.equal(seen[0].ticks, undefined);
});

// Pierwszy odczyt CPU zawsze bylby nullem - watcher pobiera baseline w start(),
// zeby wykres nie otwieral sie pusta kolumna.
test('watcher pobiera baseline w start(), wiec pierwszy tick zna juz CPU', () => {
  let n = 0;
  const osLike = fakeOs({
    // Kazde wywolanie przesuwa liczniki, jak na zywej maszynie.
    cpus: () => {
      n += 1;
      return [core(1000 * n, 1000 * n)];
    },
  });

  const seen = [];
  const w = new TelemetryWatcher((p) => seen.push(p), osLike);
  w.start();
  w.tick();
  w.stop();

  assert.notEqual(seen[0].cpu.percent, null, 'baseline z start() musi juz dzialac');
});

test('watcher nie startuje dwoch timerow', () => {
  const w = new TelemetryWatcher(() => {}, fakeOs());
  w.start();
  const first = w.timer;
  w.start();
  assert.equal(w.timer, first);
  w.stop();
  assert.equal(w.timer, null);
});

// ---- Test danych: atrapa musi odpowiadac prawdziwemu `os` ------------------
//
// Suita na samych atrapach potrafi byc zielona, gdy ksztalt prawdziwego API jest
// inny. To ten sam wzorzec, ktory wylapal brak Opusa 5 w rates.json.

test('prawdziwy os.cpus() ma ksztalt, ktorego oczekuje cpuTotals', () => {
  const r = cpuTotals(os.cpus());
  assert.notEqual(r, null, 'ta maszyna nie zaraportowala ani jednego rdzenia');
  assert.ok(r.total > 0);
  assert.ok(r.idle >= 0 && r.idle <= r.total);
});

test('prawdziwy os daje kompletna probke', () => {
  const s = sample(os, null);
  assert.notEqual(s.mem, null);
  assert.ok(s.mem.total > 0);
  assert.ok(s.cpu.cores > 0);
  assert.equal(typeof s.uptime, 'number');
});

test('interwal probkowania jest sensowny', () => {
  assert.ok(SAMPLE_MS >= 1000, 'czesciej niz raz na sekunde to juz koszt, nie pomiar');
  assert.ok(SAMPLE_MS <= 10000, 'rzadziej niz co 10 s i wykres przestaje byc "na zywo"');
});
