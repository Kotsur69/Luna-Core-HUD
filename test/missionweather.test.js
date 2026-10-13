// ============================================================================
// LunaCore - Mission Control event weather tests (src/missionweather.js)
// ----------------------------------------------------------------------------
// fetch is an injected fake keyed by URL; the clock is fixed. Times are built
// in LOCAL time (new Date(y, m, d, h)), like the module's all-day spans.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const w = require('../src/missionweather.js');

const HOUR = 3600 * 1000;
const NOW = new Date(2026, 9, 13, 12).getTime();
const TRACKS = [
  { name: 'Tor Poznan', names: ['tor poznan'], lat: 52.418, lon: 16.812 },
  { name: 'Tor Kielce', names: ['tor kielce', 'miedziana gora'], lat: 50.836, lon: 20.551 },
];
const RULES = { tracks: TRACKS };
const at = (d, h) => new Date(2026, 9, d, h).getTime();
const iso = (ms) => new Date(ms).toISOString();
const timed = (id, from, to, extra = {}) => ({ id, title: 'x', start: iso(from), end: iso(to), allDay: false, location: '', ...extra });

/** Hourly arrays from local day 13 00:00; temp = hour of day, rain = 10 x hour % 100, wind 20. */
function hourly(days = 9) {
  const time = [];
  const temperature_2m = [];
  const precipitation_probability = [];
  const wind_speed_10m = [];
  for (let ms = at(13, 0); ms < at(13 + days, 0); ms += HOUR) {
    const h = new Date(ms).getHours();
    time.push(ms / 1000);
    temperature_2m.push(h);
    precipitation_probability.push((h * 10) % 100);
    wind_speed_10m.push(20);
  }
  return { time, temperature_2m, precipitation_probability, wind_speed_10m };
}

/** Fake Open-Meteo: `geo` maps a geocoding query to its first result (or nothing). */
function fakeFetch(geo = {}) {
  const calls = [];
  const fetchImpl = async (url) => {
    const u = new URL(url);
    calls.push(u);
    if (u.hostname.startsWith('geocoding')) {
      const hit = geo[u.searchParams.get('name')];
      return { ok: true, json: async () => ({ results: hit ? [hit] : [] }) };
    }
    return { ok: true, json: async () => ({ hourly: hourly(16) }) };
  };
  const geoNames = () => calls.filter((u) => u.hostname.startsWith('geocoding')).map((u) => u.searchParams.get('name'));
  return { fetchImpl, calls, geoNames };
}

const town = (name, population, lat = 50.87, lon = 20.63) => ({ name, latitude: lat, longitude: lon, population });

test('fold makes names match without diacritics or case', () => {
  assert.equal(w.fold('Tor Poznań ŁÓDŹ'), 'tor poznan lodz');
});

test('findTrack: whole words in title or location ("tor" never inside "motor")', () => {
  assert.equal(w.findTrack({ title: 'Jazda', location: 'Tor Kielce' }, TRACKS).name, 'Tor Kielce');
  assert.equal(w.findTrack({ title: 'Trening Tor Poznań' }, TRACKS).name, 'Tor Poznan');
  const short = [{ name: 'T', names: ['tor'], lat: 1, lon: 1 }];
  assert.equal(w.findTrack({ title: 'Motorsport meetup' }, short), null);
});

test('placeText skips empty and online-meeting locations', () => {
  assert.equal(w.placeText({ location: 'Kielce' }), 'Kielce');
  for (const loc of ['', 'Microsoft Teams Meeting', 'https://meet.google.com/abc', 'Zoom', 'online']) {
    assert.equal(w.placeText({ location: loc }), '', loc);
  }
});

test('eventHours: timed span as is; all-day = 08-18 per day, at most 3 days', () => {
  assert.deepEqual(w.eventHours(timed('a', at(14, 9), at(14, 16))), [[at(14, 9), at(14, 16)]]);
  assert.deepEqual(w.eventHours({ allDay: true, start: '2026-10-17', end: '2026-10-19' }), [
    [at(17, 8), at(17, 18)],
    [at(18, 8), at(18, 18)],
  ]);
  assert.equal(w.eventHours({ allDay: true, start: '2026-10-17', end: '2026-10-27' }).length, 3);
  assert.deepEqual(w.eventHours({ allDay: false, start: 'soon' }), []);
});

test('summarize: min-max temp, worst rain and wind over the event hours only', () => {
  // Hours 9, 10, 11 -> temps 9..11, rain 90, 0, 10.
  assert.deepEqual(w.summarize(hourly(), [[at(14, 9), at(14, 12)]]), { tMin: 9, tMax: 11, rain: 90, wind: 20 });
  assert.equal(w.summarize(hourly(), [[at(30, 9), at(30, 12)]]), null, 'beyond the forecast');
});

test('summarize drops out-of-range or non-numeric values from the API', () => {
  const bad = { time: [at(14, 9) / 1000, at(14, 10) / 1000], temperature_2m: [999, 'x'], precipitation_probability: [50, 50] };
  assert.equal(w.summarize(bad, [[at(14, 9), at(14, 11)]]), null);
  const ok = { time: [at(14, 9) / 1000], temperature_2m: [12.4], precipitation_probability: [null], wind_speed_10m: [-3] };
  assert.deepEqual(w.summarize(ok, [[at(14, 9), at(14, 10)]]), { tMin: 12, tMax: 12, rain: null, wind: null });
});

test('any event with a place gets weather - not only trackdays', async () => {
  const f = fakeFetch({ Kielce: town('Kielce', 190000) });
  const weather = w.createWeather({ fetchImpl: f.fetchImpl, now: () => NOW });
  const out = await weather.forEvents([timed('dentist', at(14, 9), at(14, 12), { title: 'Dentysta', location: 'Kielce' })], RULES);
  assert.deepEqual(out, { dentist: { tMin: 9, tMax: 11, rain: 90, wind: 20, place: 'Kielce', longRange: false } });
});

test('a known track uses its own coordinates, no geocoding ("Tor Kielce" is not the city)', async () => {
  const f = fakeFetch();
  const weather = w.createWeather({ fetchImpl: f.fetchImpl, now: () => NOW });
  const out = await weather.forEvents([timed('e1', at(14, 9), at(14, 12), { title: 'Trackday', location: 'Tor Kielce' })], RULES);
  assert.equal(out.e1.place, 'Tor Kielce');
  assert.deepEqual(f.geoNames(), []);
  assert.equal(f.calls[0].searchParams.get('latitude'), '50.8360');
  assert.equal(f.calls[0].searchParams.get('timeformat'), 'unixtime');
});

test('a venue name that is no place falls back to its words, keeping the biggest town', async () => {
  const f = fakeFetch({ Kielce: town('Kielce', 190000), Hala: town('Hala', 120, 10, 10) });
  const weather = w.createWeather({ fetchImpl: f.fetchImpl, now: () => NOW });
  const out = await weather.forEvents([timed('e2', at(15, 10), at(15, 11), { title: 'Targi', location: 'Hala Expo Kielce' })], RULES);
  assert.equal(out.e2.place, 'Kielce');
  // Whole part first, then the words (last first).
  assert.deepEqual(f.geoNames(), ['Hala Expo Kielce', 'Kielce', 'Expo', 'Hala']);
});

test('comma parts are tried in order; a part with digits never leaves the PC; titles never do', async () => {
  const f = fakeFetch({ Radom: town('Radom', 200000) });
  const weather = w.createWeather({ fetchImpl: f.fetchImpl, now: () => NOW });
  const ev = timed('e3', at(15, 10), at(15, 11), { title: 'Secret plan', location: 'Autodrom X, ul. Polna 12, Radom' });
  const out = await weather.forEvents([ev], RULES);
  assert.equal(out.e3.place, 'Radom');
  assert.deepEqual(f.geoNames(), ['Autodrom X', 'Radom']);
  assert.ok(f.calls.every((u) => !u.href.includes('Secret') && !u.href.includes('Polna')));
});

test('skips placeless, online, past and too-far events', async () => {
  const f = fakeFetch({ Kielce: town('Kielce', 190000) });
  const weather = w.createWeather({ fetchImpl: f.fetchImpl, now: () => NOW });
  const far = 13 + w.AHEAD_DAYS + 1;
  const out = await weather.forEvents(
    [
      timed('noplace', at(14, 9), at(14, 10), { title: 'Standup' }),
      timed('online', at(14, 9), at(14, 10), { location: 'Microsoft Teams Meeting' }),
      timed('past', at(12, 9), at(12, 10), { location: 'Kielce' }),
      timed('far', at(far, 9), at(far, 10), { location: 'Kielce' }),
    ],
    RULES
  );
  assert.deepEqual(out, {});
  assert.equal(f.calls.length, 0);
});

test('forecasts are cached per place for an hour; a "no hit" is asked again after it; a failed fetch is no crash', async () => {
  let t = NOW;
  const f = fakeFetch();
  const weather = w.createWeather({ fetchImpl: f.fetchImpl, now: () => t });
  const track = [timed('e1', at(14, 9), at(14, 12), { location: 'Tor Poznan' })];
  await weather.forEvents(track, RULES);
  await weather.forEvents(track, RULES);
  assert.equal(f.calls.length, 1, 'forecast cached');
  const nowhere = [timed('e4', at(14, 9), at(14, 12), { location: 'Nowhere' })];
  await weather.forEvents(nowhere, RULES);
  await weather.forEvents(nowhere, RULES);
  assert.deepEqual(f.geoNames(), ['Nowhere'], 'no hit cached');
  t += 2 * HOUR;
  await weather.forEvents(nowhere, RULES);
  assert.deepEqual(f.geoNames(), ['Nowhere', 'Nowhere'], 'and retried after the TTL');

  const broken = w.createWeather({ fetchImpl: async () => ({ ok: false, status: 503 }), now: () => NOW });
  assert.deepEqual(await broken.forEvents(track, RULES), {});
});

test('soonest events first under the cap', async () => {
  const f = fakeFetch({ Kielce: town('Kielce', 190000) });
  const weather = w.createWeather({ fetchImpl: f.fetchImpl, now: () => NOW });
  const later = Array.from({ length: 30 }, (_, i) => timed(`late${i}`, at(19, 9), at(19, 10), { location: 'Kielce' }));
  const out = await weather.forEvents([...later, timed('tomorrow', at(14, 9), at(14, 10), { location: 'Kielce' })], RULES);
  assert.ok(out.tomorrow);
  assert.equal(Object.keys(out).length, 25);
});

test('parseGeocode validates coordinates, caps the name, reads population', () => {
  assert.equal(w.parseGeocode({ results: [{ latitude: 999, longitude: 1, name: 'x' }] }), null);
  assert.equal(w.parseGeocode({}), null);
  const p = w.parseGeocode({ results: [{ latitude: 1, longitude: 2, name: 'y'.repeat(500), population: 'lots' }] });
  assert.deepEqual([p.name.length, p.population], [80, 0]);
});

test('parseGeocode keeps the most populous of the hits (the city, not a namesake district)', () => {
  const p = w.parseGeocode({
    results: [
      { name: 'Warszawa Historic District', latitude: 41.6, longitude: -87.6, population: 0 },
      { name: 'Warszawa', latitude: 52.23, longitude: 21.01, population: 1700000 },
    ],
  });
  assert.equal(p.name, 'Warszawa');
});

test('events up to two weeks out get weather; past a week it is flagged longRange', async () => {
  const f = fakeFetch({ Kielce: town('Kielce', 190000) });
  const weather = w.createWeather({ fetchImpl: f.fetchImpl, now: () => NOW });
  const out = await weather.forEvents(
    [
      timed('soon', at(15, 9), at(15, 10), { location: 'Kielce' }),
      timed('later', at(13 + 12, 9), at(13 + 12, 10), { location: 'Kielce' }),
    ],
    RULES
  );
  assert.equal(w.AHEAD_DAYS, 14);
  assert.deepEqual([out.soon.longRange, 'later' in out], [false, true]);
  assert.equal(out.later.longRange, true);
});
