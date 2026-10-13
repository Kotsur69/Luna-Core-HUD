// ============================================================================
// LunaCore - Mission Control config loader
// ----------------------------------------------------------------------------
// Loads config/missioncontrol.json (+ the gitignored missioncontrol.local.json,
// whose lists REPLACE the shipped ones key by key). Same contract as the other
// config loaders (prompts.js, cheatsheets.js): safe read, validate at the
// boundary, and a broken file degrades to the shipped defaults - or, if those
// are broken too, to empty lists - never a crash.
//
// These rules end up inside a model prompt, so every string is length-capped
// and every list is count-capped: a hand-edited file can make the mail job
// dumber, never make the prompt unbounded.
// ============================================================================

'use strict';

const fs = require('fs');
const paths = require('./paths');
const { hasText, normalizeText } = require('./localized');

const BASE_FILE = paths.bundled('missioncontrol.json');
const localFile = () => paths.local('missioncontrol.local.json');

const MAX_RULES = 40;
const MAX_RULE_CHARS = 300;
const MAX_SENDERS = 200;
const MAX_QUERY_CHARS = 200;
const MAX_CATEGORIES = 12;
const SENDER_RE = /^(@[a-z0-9.-]+\.[a-z]{2,}|[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})$/i;
const CATEGORY_ID_RE = /^[a-z0-9-]{1,32}$/;
const COLOR_ID_RE = /^([1-9]|1[01])$/; // Google Calendar event colorIds are "1".."11"
const HEX_RE = /^#[0-9a-f]{6}$/i;

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

const clampInt = (v, min, max, fallback) =>
  Number.isInteger(v) ? Math.min(max, Math.max(min, v)) : fallback;

/** Non-empty strings, trimmed, capped in length and count. */
function ruleList(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((r) => typeof r === 'string' && r.trim())
    .map((r) => r.trim().slice(0, MAX_RULE_CHARS))
    .slice(0, MAX_RULES);
}

/** Exact addresses or @domains only - anything else is dropped. */
function senderList(raw) {
  if (!Array.isArray(raw)) return [];
  const valid = raw.filter((s) => typeof s === 'string' && SENDER_RE.test(s.trim()));
  return [...new Set(valid.map((s) => s.trim().toLowerCase()))].slice(0, MAX_SENDERS);
}

function normalizeCategory(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.id !== 'string' || !CATEGORY_ID_RE.test(raw.id)) return null;
  return {
    id: raw.id,
    label: hasText(raw.label) ? normalizeText(raw.label) : raw.id,
    colorId: typeof raw.colorId === 'string' && COLOR_ID_RE.test(raw.colorId) ? raw.colorId : null,
    color: typeof raw.color === 'string' && HEX_RE.test(raw.color) ? raw.color : '#888888',
  };
}

const MAX_TRACKS = 50;
const MAX_TRACK_NAMES = 6;
const MAX_TRACK_NAME_CHARS = 60;

const trackName = (s) => (typeof s === 'string' && s.trim() ? s.trim().slice(0, MAX_TRACK_NAME_CHARS) : null);
const inRange = (v, lim) => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= lim;

/** A known track for event weather (its own coordinates beat geocoding the town); null when the name or coordinates are unusable. */
function normalizeTrack(raw) {
  if (!raw || typeof raw !== 'object' || !inRange(raw.lat, 90) || !inRange(raw.lon, 180)) return null;
  const name = trackName(raw.name);
  const list = (v) => (Array.isArray(v) ? v : []).map(trackName).filter((n) => n && n.length >= 3).slice(0, MAX_TRACK_NAMES);
  const names = list(raw.names);
  if (!name || !names.length) return null;
  // towns: matched only for trackday events ("Trackday Kielce" -> Tor Kielce).
  return { name, names, towns: list(raw.towns), lat: raw.lat, lon: raw.lon };
}

function normalizeWeather(raw) {
  const w = raw && typeof raw === 'object' ? raw : {};
  return {
    category: typeof w.category === 'string' && CATEGORY_ID_RE.test(w.category) ? w.category : null,
    tracks: (Array.isArray(w.tracks) ? w.tracks : []).map(normalizeTrack).filter(Boolean).slice(0, MAX_TRACKS),
  };
}

/** A section's value from `local` when it has the key, otherwise from `base`. */
const pick = (base, local, key) =>
  local && Object.prototype.hasOwnProperty.call(local, key) ? local[key] : base && base[key];

/**
 * @returns {{mail:{query:string,maxThreads:number,trashCategories:string[],trashSenders:string[],
 *   flagCategories:string[],neverTrash:string[],keepSenders:string[]},
 *   calendar:{days:number,categories:Array<{id:string,label:unknown,colorId:string|null,color:string}>,
 *     weather:{category:string|null,tracks:Array<{name:string,names:string[],lat:number,lon:number}>}}}}
 */
function loadMissionConfig() {
  const base = readJson(BASE_FILE) || {};
  const local = readJson(localFile()) || {};
  const bm = base.mail || {};
  const lm = local.mail || {};
  const bc = base.calendar || {};
  const lc = local.calendar || {};

  const query = pick(bm, lm, 'query');
  const rawCategories = pick(bc, lc, 'categories');
  const categories = (Array.isArray(rawCategories) ? rawCategories : [])
    .map(normalizeCategory)
    .filter(Boolean)
    .slice(0, MAX_CATEGORIES);

  return {
    mail: {
      query: typeof query === 'string' && query.trim() ? query.trim().slice(0, MAX_QUERY_CHARS) : 'in:inbox',
      maxThreads: clampInt(pick(bm, lm, 'maxThreads'), 1, 100, 40),
      trashCategories: ruleList(pick(bm, lm, 'trashCategories')),
      trashSenders: senderList(pick(bm, lm, 'trashSenders')),
      flagCategories: ruleList(pick(bm, lm, 'flagCategories')),
      neverTrash: ruleList(pick(bm, lm, 'neverTrash')),
      keepSenders: senderList(pick(bm, lm, 'keepSenders')),
    },
    calendar: {
      days: clampInt(pick(bc, lc, 'days'), 1, 31, 7),
      categories,
      weather: normalizeWeather(pick(bc, lc, 'weather')),
    },
  };
}

module.exports = { loadMissionConfig, ruleList, senderList, normalizeCategory, normalizeWeather };
