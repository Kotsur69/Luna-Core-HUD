// ============================================================================
// LunaCore - Mission Control settings as cloud units (main)
// ----------------------------------------------------------------------------
// Providers for src/configsync.js (docs/CLOUD_SYNC_PLAN.md, 2b):
//
//   news            mission-news.local.json
//     news:source:<id> = {platform, target, label}
//     news:topic:<id>  = {query, platforms}
//   missionProjects mission-projects.local.json
//     proj:class:<projectKey> = {class}    'work' | 'fun' | 'other'
//     proj:pinned             = {list}     the whole pinned list
//
// Cloud values go through the stores' own normalizers (missionnewsstore.js,
// missionprojects.js) - the same gate the renderer's edits pass.
// ============================================================================

'use strict';

const fs = require('fs');
const path = require('path');
const { readDoc, writeAtomic } = require('./projectsync');
const news = require('./missionnewsstore');
const missionProjects = require('./missionprojects');
const { validKey } = require('./missionledgersync');

const SOURCE = 'news:source:';
const TOPIC = 'news:topic:';
const CLASS = 'proj:class:';
const PINNED = 'proj:pinned';

const isPlainObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const list = (v) => (Array.isArray(v) ? v : []);
const mtimeBase = (file, now) => Math.floor(Math.min(fs.statSync(file).mtimeMs, now));

/** Reads the file as a plain object (null when missing); throws when unreadable. */
function readStore(file) {
  const doc = readDoc(file);
  if (doc !== null && !isPlainObject(doc)) throw new Error('not a JSON object');
  return doc;
}

function store(file, doc) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeAtomic(file, JSON.stringify(doc, null, 2) + '\n');
}

/** Local units first (always kept), then arrivals while `room(k)` allows. */
function capArrivals(merged, local, room) {
  const mine = new Set(local.units.map(([k]) => k));
  return merged.filter(([k]) => mine.has(k) || room(k));
}

function newsSource(id, raw) {
  const s = news.validId(id) && isPlainObject(raw) ? news.normalizeSource({ ...raw, id }) : null;
  return s && { platform: s.platform, target: s.target, label: s.label };
}

function newsTopic(id, raw) {
  const t = news.validId(id) && isPlainObject(raw) ? news.normalizeTopic({ ...raw, id }) : null;
  return t && { query: t.query, platforms: t.platforms };
}

/** @param {string} file mission-news.local.json */
function createNewsProvider(file) {
  const kinds = [
    { prefix: SOURCE, field: 'sources', clean: newsSource, max: news.MAX_SOURCES },
    { prefix: TOPIC, field: 'topics', clean: newsTopic, max: news.MAX_TOPICS },
  ];
  const kindOf = (k) => kinds.find((x) => k.startsWith(x.prefix));
  return {
    name: 'news',
    owns: (k) => Boolean(kindOf(k)),
    valid(k, v) {
      const kind = kindOf(k);
      return kind ? kind.clean(k.slice(kind.prefix.length), v) : null;
    },

    read(now) {
      const doc = readStore(file);
      if (!doc) return { units: [], base: 0 };
      const units = [];
      for (const { prefix, field, clean } of kinds) {
        const seen = new Set();
        for (const raw of list(doc[field])) {
          // An item without a valid id stays in the file but is not synced.
          const v = raw && !seen.has(raw.id) ? clean(raw.id, raw) : null;
          if (!v) continue;
          seen.add(raw.id);
          units.push([prefix + raw.id, v]);
        }
      }
      return { units, base: mtimeBase(file, now), doc };
    },

    resolve(merged, local) {
      const room = Object.fromEntries(kinds.map((x) => [x.prefix, x.max - local.units.filter(([k]) => k.startsWith(x.prefix)).length]));
      return capArrivals(merged, local, (k) => room[kindOf(k).prefix]-- > 0);
    },

    write(units, local) {
      const doc = local.doc || {};
      const next = { ...doc };
      for (const { prefix, field } of kinds) {
        const unsynced = list(doc[field]).filter((raw) => !(raw && news.validId(raw.id)));
        const synced = units.filter(([k]) => k.startsWith(prefix)).map(([k, v]) => ({ id: k.slice(prefix.length), ...v }));
        next[field] = [...unsynced, ...synced];
      }
      store(file, next);
    },
  };
}

function projectClass(key, raw) {
  return validKey(key) && isPlainObject(raw) && missionProjects.CLASSES.includes(raw.class) ? { class: raw.class } : null;
}

function pinnedList(raw) {
  const clean = isPlainObject(raw) ? missionProjects.normalizePinned(raw.list) : [];
  return clean.length ? { list: clean } : null;
}

/** @param {string} file mission-projects.local.json */
function createMissionProjectsProvider(file) {
  return {
    name: 'missionProjects',
    owns: (k) => k === PINNED || k.startsWith(CLASS),
    valid: (k, v) => (k === PINNED ? pinnedList(v) : projectClass(k.slice(CLASS.length), v)),

    read(now) {
      const doc = readStore(file);
      if (!doc) return { units: [], base: 0 };
      const { classes, pinned } = missionProjects.normalize(doc);
      const units = Object.entries(classes).map(([key, cls]) => [CLASS + key, { class: cls }]);
      if (pinned.length) units.push([PINNED, { list: pinned }]);
      return { units, base: mtimeBase(file, now), doc };
    },

    resolve(merged, local) {
      let room = missionProjects.MAX_CLASSES - local.units.filter(([k]) => k.startsWith(CLASS)).length;
      return capArrivals(merged, local, (k) => k === PINNED || room-- > 0);
    },

    /** Everything but classes and pinned stays as this PC has it (minus the old folder-sync `sharedDir`). */
    write(units, local) {
      const classes = {};
      let pinned = [];
      for (const [k, v] of units) {
        if (k === PINNED) pinned = v.list;
        else classes[k.slice(CLASS.length)] = v.class;
      }
      const { sharedDir, ...rest } = local.doc || {};
      store(file, { ...rest, classes, pinned });
    },
  };
}

module.exports = { createNewsProvider, createMissionProjectsProvider };
