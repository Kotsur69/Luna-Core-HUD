// ============================================================================
// LunaCore - Mission Control trackday weather tests (src/missionweather.js)
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
const TRACKS = [{ name: 'Tor Poznan', names: ['tor poznan'], lat: 52.418, lon: 16.812 }];
const RULES = { category: 'motorsport', tracks: TRACKS };
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

function fakeFetch() {
  const calls = [];
  const fetchImpl = async (url) => {
    const u = new URL(url);
    calls.push(u);
    const body = u.hostname.startsWith('geocoding') ? { results: [] } : { hourly: hourly() };
    return { ok: true, status: 200, json: async () => body };
  };
  return { fetchImpl, calls };
}

test('fold makes track names match without diacritics or case', () => {
  assert.equal(w.fold('Tor Poznań ŁÓDŹ'), 'tor poznan lodz');
});

test('isTrackday: the category, "trackday" in the title, or a known track name', () => {
  assert.ok(w.isTrackday({ title: 'x', category: 'motorsport' }, RULES));
  assert.ok(w.isTrackday({ title: 'Track day z ekipa' }, RULES));
  assert.ok(w.isTrackday({ title: 'Jazda', location: 'Tor Poznań, Przezmierowo' }, RULES));
  assert.ok(!w.isTrackday({ title: 'Dentist', location: 'Poznan' }, RULES));
  assert.ok(!w.isTrackday({ title: 'x', category: 'work' }, { category: null, tracks: [] }));
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

test('forEvents: a known track uses its own coordinates, no geocoding', async () => {
  const { fetchImpl, calls } = fakeFetch();
  const weather = w.createWeather({ fetchImpl, now: () => NOW });
  const out = await weather.forEvents([timed('e1', at(14, 9), at(14, 12), { title: 'Trackday Tor Poznan' })], RULES);
  assert.deepEqual(out, { e1: { tMin: 9, tMax: 11, rain: 90, wind: 20, place: 'Tor Poznan' } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].hostname, 'api.open-meteo.com');
  assert.equal(calls[0].searchParams.get('latitude'), '52.4180');
  assert.equal(calls[0].searchParams.get('timeformat'), 'unixtime');
});

test('forEvents: an unknown place is geocoded part by part; only the location leaves the PC', async () => {
  let n = 0;
  const calls = [];
  const fetchImpl = async (url) => {
    const u = new URL(url);
    calls.push(u);
    if (u.hostname.startsWith('geocoding')) {
      n += 1;
      // The first part ("Autodrom X") has no hit; the city does.
      const body = n === 1 ? { results: [] } : { results: [{ latitude: 50.06, longitude: 19.94, name: 'Krakow' }] };
      return { ok: true, json: async () => body };
    }
    return { ok: true, json: async () => ({ hourly: hourly() }) };
  };
  const weather = w.createWeather({ fetchImpl, now: () => NOW });
  const ev = timed('e2', at(15, 10), at(15, 11), { title: 'Secret plan', category: 'motorsport', location: 'Autodrom X, Krakow' });
  const out = await weather.forEvents([ev], RULES);
  assert.equal(out.e2.place, 'Krakow');
  const names = calls.filter((u) => u.hostname.startsWith('geocoding')).map((u) => u.searchParams.get('name'));
  assert.deepEqual(names, ['Autodrom X', 'Krakow']);
  assert.ok(calls.every((u) => !u.href.includes('Secret')));
});

test('forEvents skips non-trackdays, past events, events beyond the horizon and placeless ones', async () => {
  const { fetchImpl, calls } = fakeFetch();
  const weather = w.createWeather({ fetchImpl, now: () => NOW });
  const far = 13 + w.AHEAD_DAYS + 1;
  const out = await weather.forEvents(
    [
      timed('work', at(14, 9), at(14, 10), { title: 'Standup', location: 'Office' }),
      timed('past', at(12, 9), at(12, 10), { title: 'Trackday' }),
      timed('far', at(far, 9), at(far, 10), { title: 'Trackday Tor Poznan' }),
      timed('noplace', at(14, 9), at(14, 10), { title: 'Trackday' }),
    ],
    RULES
  );
  assert.deepEqual(out, {});
  assert.equal(calls.length, 0);
});

test('forecasts are cached per place for an hour; a failed fetch leaves the event out, not a crash', async () => {
  let t = NOW;
  const { fetchImpl, calls } = fakeFetch();
  const weather = w.createWeather({ fetchImpl, now: () => t });
  const ev = [timed('e1', at(14, 9), at(14, 12), { title: 'Tor Poznan' })];
  await weather.forEvents(ev, RULES);
  await weather.forEvents(ev, RULES);
  assert.equal(calls.length, 1);
  t += 2 * HOUR;
  await weather.forEvents(ev, RULES);
  assert.equal(calls.length, 2);

  const broken = w.createWeather({ fetchImpl: async () => ({ ok: false, status: 503 }), now: () => NOW });
  assert.deepEqual(await broken.forEvents(ev, RULES), {});
});

test('parseGeocode validates coordinates and caps the name', () => {
  assert.equal(w.parseGeocode({ results: [{ latitude: 999, longitude: 1, name: 'x' }] }), null);
  assert.equal(w.parseGeocode({}), null);
  assert.equal(w.parseGeocode({ results: [{ latitude: 1, longitude: 2, name: 'y'.repeat(500) }] }).name.length, 80);
});

test('track names match whole words only ("tor" never inside "motor")', () => {
  const short = { category: null, tracks: [{ name: 'T', names: ['tor'], lat: 1, lon: 1 }] };
  assert.ok(!w.isTrackday({ title: 'Motorsport meetup' }, short));
  assert.ok(w.isTrackday({ title: 'Jazda: tor, sobota' }, short));
});

test('geocoding never sends a part with digits; a "no hit" is asked again after an hour', async () => {
  let t = NOW;
  const calls = [];
  const fetchImpl = async (url) => {
    const u = new URL(url);
    calls.push(u);
    return { ok: true, json: async () => (u.hostname.startsWith('geocoding') ? { results: [] } : { hourly: hourly() }) };
  };
  const weather = w.createWeather({ fetchImpl, now: () => t });
  const ev = [timed('e3', at(15, 10), at(15, 11), { category: 'motorsport', location: 'ul. Polna 12, 62-080 Tarnowo, Nowhere' })];
  await weather.forEvents(ev, RULES);
  assert.deepEqual(calls.map((u) => u.searchParams.get('name')), ['Nowhere']);
  await weather.forEvents(ev, RULES);
  assert.equal(calls.length, 1, 'no hit is cached');
  t += 2 * HOUR;
  await weather.forEvents(ev, RULES);
  assert.equal(calls.length, 2, 'and retried after the TTL');
});
