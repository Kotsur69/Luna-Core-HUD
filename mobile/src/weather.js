// ============================================================================
// LunaCore phone - Today's weather (Open-Meteo: free, no key)
// ----------------------------------------------------------------------------
// docs/DONE_CLOUD_SYNC_PLAN.md phase 4c. The place is a town typed once on this
// phone (no GPS: vercel.json turns geolocation off), geocoded and kept in
// localStorage; only that town name and its coordinates leave the phone.
// Parsing is the PC's own (src/missionweather.js): every number Open-Meteo
// returns is range-checked there.
// ============================================================================

import mw from '../../src/missionweather.js';

const { parseGeocode, summarize } = mw;
const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
const GEOCODE_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const HOUR_MS = 60 * 60 * 1000;
const AHEAD_MS = 24 * HOUR_MS;
const CACHE_MS = 30 * 60 * 1000;
const TIMEOUT_MS = 10000;
const MAX_NAME = 80;
/** Cleared on logout (cloud.js). */
export const PLACE_KEY = 'lunacore.today.place';

let cache = null; // {key, at, hourly}
/** The place when localStorage refuses it (private mode); gone on reload. */
let memoryPlace = null;

async function getJson(url, params) {
  const res = await fetch(`${url}?${new URLSearchParams(params)}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`weather-http-${res.status}`);
  return res.json();
}

const inRange = (v, min, max) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;

/** The saved place, or null when none (or it no longer parses). */
export function savedPlace() {
  try {
    const p = JSON.parse(localStorage.getItem(PLACE_KEY) || 'null');
    if (p && typeof p.name === 'string' && inRange(p.lat, -90, 90) && inRange(p.lon, -180, 180)) return { name: p.name.slice(0, MAX_NAME), lat: p.lat, lon: p.lon };
  } catch {
    // Private mode or a broken value: fall back to this session's place.
  }
  return memoryPlace;
}

export function savePlace(place) {
  memoryPlace = { name: place.name, lat: place.lat, lon: place.lon };
  try {
    localStorage.setItem(PLACE_KEY, JSON.stringify({ name: place.name, lat: place.lat, lon: place.lon }));
  } catch {
    // Private mode: memoryPlace keeps it until the app closes.
  }
}

/** A typed town -> {name, lat, lon} (the most populous hit), or null. */
export async function findPlace(name) {
  const q = String(name).trim().slice(0, MAX_NAME);
  if (q.length < 2) return null;
  const hit = parseGeocode(await getJson(GEOCODE_URL, { name: q, count: '5', format: 'json', language: 'pl' }));
  return hit ? { name: hit.name || q, lat: hit.lat, lon: hit.lon } : null;
}

/**
 * The next 24 hours at `place`: {tMin, tMax, rain, wind, hours[]} or null.
 * One forecast per place is reused for CACHE_MS.
 */
export async function nextHours(place, now = Date.now()) {
  const key = `${place.lat.toFixed(2)},${place.lon.toFixed(2)}`;
  if (!cache || cache.key !== key || now - cache.at > CACHE_MS) {
    const body = await getJson(FORECAST_URL, {
      latitude: place.lat.toFixed(4),
      longitude: place.lon.toFixed(4),
      hourly: 'temperature_2m,precipitation_probability,precipitation,wind_speed_10m',
      timeformat: 'unixtime',
      forecast_days: '2',
    });
    cache = { key, at: now, hourly: body && body.hourly };
  }
  const from = now - (now % HOUR_MS);
  return summarize(cache.hourly, [[from, from + AHEAD_MS]]);
}
