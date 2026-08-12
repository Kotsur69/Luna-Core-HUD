// ============================================================================
// LunaCore - Sound event config loader
// ----------------------------------------------------------------------------
// Loads config/sounds.json (shipped defaults, read via paths.bundled() same as
// theme.js/rates.js/cheatsheets.js) and resolves an event key ('sfx.navClick',
// 'voice.done') to an absolute asset path + volume. `sfx.keystroke` is special:
// it holds a `variants` array instead of a single `file` (4-way picker, see
// SOUNDS_IMPLEMENTATION_PLAN.md §3) - callers pass { variant } to pick one.
//
// Assets live in helpers/sounds/, sitting next to config/ as pure data, same
// reasoning as assets/fonts and assets/icon-*.png living outside src/. Unlike
// config/*.json there is no per-user *.local.json override for sound assets -
// nothing here is meant to vary per machine.
//
// Missing config, missing file, or a disabled entry all resolve to null - a
// silent no-op, never a crash. Playback code (soundManager, later steps) must
// treat null as "don't play", not as an error to surface.
// ============================================================================

'use strict';

const fs = require('fs');
const path = require('path');
const paths = require('./paths');

const BASE_FILE = paths.bundled('sounds.json');
const ASSETS_DIR = path.join(__dirname, '..', 'helpers', 'sounds');

let cache = null;

/** Safe read + JSON parse. Returns null when the file is missing or invalid. */
function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** Loads config/sounds.json once; missing/corrupt file -> empty {sfx:{}, voice:{}}. */
function loadSoundConfig() {
  if (cache) return cache;
  const raw = readJson(BASE_FILE);
  cache = {
    sfx: raw && typeof raw.sfx === 'object' && raw.sfx ? raw.sfx : {},
    voice: raw && typeof raw.voice === 'object' && raw.voice ? raw.voice : {},
  };
  return cache;
}

/**
 * Pure lookup: given an already-loaded config object, picks the {file, volume}
 * for a key - no fs access, so this is the piece unit tests exercise directly
 * (same split as paths.js's resolveUserDir()).
 *
 * `sfx.keystroke` carries `variants` instead of `file` - pass { variant } to
 * pick one by id; an unknown/omitted id falls back to variants[0] rather than
 * failing, so a renamed clip or a corrupt pref never goes fully silent.
 *
 * @param {{sfx: object, voice: object}} cfg
 * @param {string} key e.g. 'sfx.navClick', 'sfx.keystroke', 'voice.done'
 * @param {{variant?: string}} [opts]
 * @returns {{file: string, volume: number}|null}
 */
function pickSoundEntry(cfg, key, opts = {}) {
  const [group, name] = String(key).split('.');
  const entry = cfg && cfg[group] && cfg[group][name];
  if (!entry || typeof entry !== 'object' || entry.enabled === false) return null;

  const volume = typeof entry.volume === 'number' ? entry.volume : 70;

  if (Array.isArray(entry.variants)) {
    const wanted = entry.variants.find((v) => v && v.id === opts.variant);
    const chosen = wanted || entry.variants[0];
    if (!chosen || typeof chosen.file !== 'string') return null;
    return { file: chosen.file, volume };
  }
  if (typeof entry.file === 'string') return { file: entry.file, volume };
  return null;
}

/**
 * Resolves an event key ('sfx.keystroke', 'voice.done') to an absolute path +
 * volume, or null if unresolvable (missing key, disabled, missing asset file).
 * @param {string} key
 * @param {{variant?: string}} [opts]
 * @returns {{path: string, volume: number}|null}
 */
function resolveSoundFile(key, opts = {}) {
  const picked = pickSoundEntry(loadSoundConfig(), key, opts);
  if (!picked) return null;

  const full = path.join(ASSETS_DIR, picked.file);
  if (!fs.existsSync(full)) return null;
  return { path: full, volume: picked.volume };
}

module.exports = { loadSoundConfig, resolveSoundFile, pickSoundEntry };
