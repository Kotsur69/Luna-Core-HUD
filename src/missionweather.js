// ============================================================================
// LunaCore - Mission Control: weather for calendar events (main process)
// ----------------------------------------------------------------------------
// Every event within AHEAD_DAYS that has a place gets the hourly Open-Meteo
// forecast (free, no key, no tokens) for its own hours, cut down to temp
// min-max, worst rain chance and worst wind. Beyond RELIABLE_DAYS it is
// flagged longRange - a trend to watch, not a number to pack for.
//
// Where:
//   1. a known track (calendar.weather.tracks) named in the title or the
//      location - its own coordinates ("Tor Kielce" is not the city); for a
//      trackday also its home town ("Trackday Kielce" at "Kielce");
//   2. otherwise the location through Open-Meteo geocoding: each comma part
//      as a whole ("Tor X, Radom" -> "Radom"), then, if none matched, its
//      single words, keeping the most populous hit ("Hala Expo Kielce" ->
//      Kielce, not a hamlet called "Hala").
// Online meetings (links, Teams, Zoom, Meet...) have no place and are skipped.
//
// Privacy: only location text leaves the PC - never titles, never a part with
// a street number; postcodes are cut off before the town is sent. A country
// or region hit ("Polska") is no place and is ignored.
//
// Everything Open-Meteo returns is untrusted: numbers are checked finite and
// in range, names are capped, only the arrays we read are cached. Forecasts
// are cached per place for CACHE_MS, so re-opening the calendar is free.
// ============================================================================

'use strict';

const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
const GEOCODE_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
/** Trackdays get booked weeks out; Open-Meteo forecasts 16 days. */
const AHEAD_DAYS = 14;
/** Today + AHEAD_DAYS, so an event late on the last day is still covered. */
const FORECAST_DAYS = AHEAD_DAYS + 2;
/** Past this, a forecast is a trend, not a plan: marked longRange (the badge says so). */
const RELIABLE_DAYS = 7;
const CACHE_MS = HOUR_MS;
const FETCH_TIMEOUT_MS = 10000;
const MAX_EVENTS = 25;
const MAX_CACHE = 200;
const MAX_HOURS = 24 * 16;
/** Hour rows sent for the expandable table: 3 all-day days x 10 h fit; a long event is cut. */
const MAX_HOUR_ROWS = 48;
const MAX_QUERY_CHARS = 100;
const MAX_PLACE_CHARS = 80;
const MAX_GEOCODE_PARTS = 3;
const MAX_GEOCODE_WORDS = 4;
/** Results asked per geocoding query; the most populous one wins. Polish names
    ("Warszawa") only match with language=pl; English ones ("Warsaw") still do. */
const GEOCODE_COUNT = 5;
/** An all-day event is forecast for its daylight hours, at most 3 days. */
const ALL_DAY_FROM_H = 8;
const ALL_DAY_TO_H = 18;
const MAX_ALL_DAY_DAYS = 3;
const ONLINE_RE = /https?:|www\.|\bteams\b|\bzoom\b|google meet|meet\.google|\bskype\b|\bwebex\b|\bonline\b|\bdiscord\b/;

/** Lower case, no diacritics ("Tor Poznań" == "tor poznan"); ł has no NFD form. */
const fold = (s) =>
  String(s || '')
    .replace(/ł/g, 'l')
    .replace(/Ł/g, 'L')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Whole words only: "tor" must not match inside "motor". */
const hasPhrase = (text, phrase) => new RegExp(`(^|[^a-z0-9])${escapeRe(fold(phrase))}($|[^a-z0-9])`).test(text);

const TRACKDAY_RE = /\btrack ?days?\b/;

/** Title or calendar says trackday ("Trackday Kielce", the "Trackdays" calendar), or the motorsport category. */
function isTrackday(ev, rules) {
  if (rules.category && ev.category === rules.category) return true;
  return TRACKDAY_RE.test(fold(`${ev.title || ''} ${ev.calendar || ''}`));
}

/**
 * The known track an event is at: one of its names anywhere in title or
 * location; or, for a trackday, its home town ("Trackday Kielce" at
 * "Kielce" is Tor Kielce - a work meeting in Kielce is not).
 */
function findTrack(ev, rules) {
  const tracks = rules.tracks || [];
  const text = fold(`${ev.title || ''} ${ev.location || ''}`);
  const byName = tracks.find((t) => t.names.some((n) => hasPhrase(text, n)));
  if (byName || !isTrackday(ev, rules)) return byName || null;
  return tracks.find((t) => (t.towns || []).some((n) => hasPhrase(text, n))) || null;
}

/** The location text worth geocoding, or '' (none, or an online meeting). */
function placeText(ev) {
  const loc = typeof ev.location === 'string' ? ev.location.trim() : '';
  return loc && !ONLINE_RE.test(fold(loc)) ? loc : '';
}

/** The [fromMs, toMs) spans to forecast; [] when the times are unusable. */
function eventHours(ev) {
  if (!ev.allDay) {
    const from = Date.parse(ev.start);
    const to = Date.parse(ev.end);
    if (!Number.isFinite(from)) return [];
    return [[from, Number.isFinite(to) && to > from ? to : from + HOUR_MS]];
  }
  const [y, m, d] = String(ev.start).split('-').map(Number);
  const endMs = Date.parse(`${ev.end}T00:00:00`);
  const out = [];
  for (let i = 0; i < MAX_ALL_DAY_DAYS; i++) {
    const from = new Date(y, m - 1, d + i, ALL_DAY_FROM_H).getTime();
    // Day one always counts; later days only while before the exclusive end.
    if (!Number.isFinite(from) || (i > 0 && !(from < endMs))) break;
    out.push([from, new Date(y, m - 1, d + i, ALL_DAY_TO_H).getTime()]);
  }
  return out;
}

const finite = (v, min, max) => (typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : null);

const round1 = (v) => (v === null ? null : Math.round(v * 10) / 10);

/**
 * Open-Meteo hourly arrays (timeformat=unixtime) -> a summary of the hours
 * touching `spans` plus those hours one by one (for the expandable table:
 * a trackday's tyre call can change from hour to hour), or null when none of
 * them is in the forecast.
 * @returns {{tMin:number, tMax:number, rain:number|null, wind:number|null,
 *   hours:Array<{t:number, temp:number, rain:number|null, mm:number|null, wind:number|null}>}|null}
 */
function summarize(hourly, spans) {
  const h = hourly && typeof hourly === 'object' ? hourly : {};
  const time = Array.isArray(h.time) ? h.time.slice(0, MAX_HOURS) : [];
  const hours = [];
  time.forEach((sec, i) => {
    if (finite(sec, 0, 1e11) === null) return;
    const ms = sec * 1000;
    // An hourly value covers [ms, ms + 1 h): count it when that overlaps a span.
    if (!spans.some(([from, to]) => ms + HOUR_MS > from && ms < to)) return;
    const temp = finite((h.temperature_2m || [])[i], -60, 60);
    if (temp === null) return;
    hours.push({
      t: ms,
      temp: round1(temp),
      rain: finite((h.precipitation_probability || [])[i], 0, 100),
      mm: round1(finite((h.precipitation || [])[i], 0, 500)),
      wind: round1(finite((h.wind_speed_10m || [])[i], 0, 400)),
    });
  });
  if (!hours.length) return null;
  const pick = (k) => hours.map((x) => x[k]).filter((v) => v !== null);
  const max = (list) => (list.length ? Math.round(Math.max(...list)) : null);
  const temps = pick('temp');
  return {
    tMin: Math.round(Math.min(...temps)),
    tMax: Math.round(Math.max(...temps)),
    rain: max(pick('rain')),
    wind: max(pick('wind')),
    hours: hours.slice(0, MAX_HOUR_ROWS),
  };
}

/** GeoNames feature codes that are no place to forecast: countries, regions, continents. */
const AREA_RE = /^(PCL|ADM1|ADM2|CONT|RGN)/;

function parseHit(hit) {
  if (!hit || typeof hit !== 'object') return null;
  // "Polska" at the end of an address must not put the event in the middle of the country.
  if (typeof hit.feature_code === 'string' && AREA_RE.test(hit.feature_code)) return null;
  const lat = finite(hit.latitude, -90, 90);
  const lon = finite(hit.longitude, -180, 180);
  if (lat === null || lon === null) return null;
  return {
    lat,
    lon,
    name: typeof hit.name === 'string' ? hit.name.slice(0, MAX_PLACE_CHARS) : '',
    population: finite(hit.population, 0, 1e10) || 0,
  };
}

/**
 * The most populous valid hit as {lat, lon, name, population}, or null. Open-Meteo's
 * first hit is not always the city: "Warszawa" can open with a US historic district.
 */
function parseGeocode(body) {
  const hits = (body && Array.isArray(body.results) ? body.results.slice(0, GEOCODE_COUNT) : []).map(parseHit).filter(Boolean);
  return hits.reduce((best, h) => (!best || h.population > best.population ? h : best), null);
}

/** Only the arrays summarize() reads, capped - never the raw response. */
function trimHourly(h) {
  const pick = (k) => (h && Array.isArray(h[k]) ? h[k].slice(0, MAX_HOURS) : []);
  return {
    time: pick('time'),
    temperature_2m: pick('temperature_2m'),
    precipitation_probability: pick('precipitation_probability'),
    precipitation: pick('precipitation'),
    wind_speed_10m: pick('wind_speed_10m'),
  };
}

/** Postcodes: PL "40-610", and plain 4-6 digit ones. */
const POSTCODE_RE = /^(\d{2}-\d{3}|\d{4,6})$/;

/**
 * Comma parts worth sending. A postcode is dropped but its town kept
 * ("40-610 Katowice" -> "Katowice"); a part still holding digits is a street
 * address ("Stalowa 1") and stays on the PC.
 */
function locationParts(location) {
  return String(location)
    .split(',')
    .map((p) =>
      p
        .trim()
        .split(/\s+/)
        .filter((w) => !POSTCODE_RE.test(w))
        .join(' ')
        .slice(0, MAX_QUERY_CHARS)
    )
    .filter((p) => p.length >= 2 && !/\d/.test(p))
    .slice(0, MAX_GEOCODE_PARTS);
}

/** Single words of the parts, for the fallback search; last words first (towns tend to end a venue name). */
function locationWords(parts) {
  const words = parts.flatMap((p) => p.split(/\s+/).reverse()).filter((w) => w.length >= 3 && /^\p{L}[\p{L}-]*$/u.test(w));
  return [...new Set(words)].slice(0, MAX_GEOCODE_WORDS);
}

/** Insert-ordered map capped at MAX_CACHE entries (oldest out first). */
function cacheSet(map, key, value) {
  map.delete(key);
  map.set(key, value);
  if (map.size > MAX_CACHE) map.delete(map.keys().next().value);
}

/**
 * @param {{fetchImpl?:Function, now?:()=>number}} [deps]
 */
function createWeather({ fetchImpl = (...a) => fetch(...a), now = Date.now } = {}) {
  const forecasts = new Map(); // "lat,lon" -> {at, hourly}
  const places = new Map(); // folded query -> {at, place: {lat, lon, name, population} | null}

  async function getJson(url, params) {
    const res = await fetchImpl(`${url}?${new URLSearchParams(params)}`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    return res.json();
  }

  /** One geocoding query, cached. A found place never moves; a "no hit" is asked again after CACHE_MS. */
  async function lookup(name) {
    const key = fold(name);
    const hit = places.get(key);
    if (hit && (hit.place || now() - hit.at < CACHE_MS)) return hit.place;
    // A network failure throws past the cache: only a real answer is remembered.
    const place = parseGeocode(await getJson(GEOCODE_URL, { name, count: String(GEOCODE_COUNT), format: 'json', language: 'pl' }));
    cacheSet(places, key, { at: now(), place });
    return place;
  }

  async function geocode(location) {
    const parts = locationParts(location);
    for (const part of parts) {
      const place = await lookup(part);
      if (place) return place;
    }
    // No part is a place as a whole ("Tor Kielce"): the biggest town among its words.
    let best = null;
    for (const word of locationWords(parts)) {
      const place = await lookup(word);
      if (place && (!best || place.population > best.population)) best = place;
    }
    return best;
  }

  async function forecast(lat, lon) {
    const key = `${lat.toFixed(2)},${lon.toFixed(2)}`;
    const hit = forecasts.get(key);
    if (hit && now() - hit.at < CACHE_MS) return hit.hourly;
    const body = await getJson(FORECAST_URL, {
      latitude: lat.toFixed(4),
      longitude: lon.toFixed(4),
      hourly: 'temperature_2m,precipitation_probability,precipitation,wind_speed_10m',
      timeformat: 'unixtime',
      forecast_days: String(FORECAST_DAYS),
    });
    const hourly = trimHourly(body && body.hourly);
    cacheSet(forecasts, key, { at: now(), hourly });
    return hourly;
  }

  return {
    /**
     * @param {object[]} events  normalized calendar events (gcal.js)
     * @param {{category:string|null, tracks:Array<{name:string, names:string[], towns:string[], lat:number, lon:number}>}} rules
     * @returns {Promise<Record<string, {tMin:number, tMax:number, rain:number|null, wind:number|null, hours:object[], place:string, longRange:boolean}>>}
     *   keyed by event id; events with no place or no forecast are left out
     */
    async forEvents(events, rules) {
      const at = now();
      const horizon = at + AHEAD_DAYS * DAY_MS;
      // Soonest first, so the cap never drops tomorrow for next week.
      const picked = (Array.isArray(events) ? events : [])
        .filter((ev) => ev && ev.id && (placeText(ev) || findTrack(ev, rules)))
        .map((ev) => ({ ev, spans: eventHours(ev) }))
        .filter(({ spans }) => spans.length > 0 && spans[spans.length - 1][1] > at && spans[0][0] < horizon)
        .sort((a, b) => a.spans[0][0] - b.spans[0][0])
        .slice(0, MAX_EVENTS);
      const out = {};
      for (const { ev, spans } of picked) {
        try {
          const loc = placeText(ev);
          const where = findTrack(ev, rules) || (loc ? await geocode(loc) : null);
          if (!where) continue;
          const summary = summarize(await forecast(where.lat, where.lon), spans);
          if (summary) out[ev.id] = { ...summary, place: where.name, longRange: spans[0][0] > at + RELIABLE_DAYS * DAY_MS };
        } catch (err) {
          console.error('[weather] forecast failed:', err && err.message);
        }
      }
      return out;
    },
  };
}

module.exports = { createWeather, findTrack, isTrackday, locationParts, placeText, eventHours, summarize, parseGeocode, locationWords, fold, AHEAD_DAYS };
