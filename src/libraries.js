// ============================================================================
// LunaCore - recommended libraries & tools directory (Ctrl+B)
// ----------------------------------------------------------------------------
// Loads a curated link catalog from config/libraries.json (+ an optional
// config/libraries.local.json override, gitignored). Same contract as the other
// config loaders (cheatsheets.js, prompts.js, layouts.js, themes.js): safe read,
// validate at the boundary, a broken file yields an EMPTY list rather than a
// crash - the overlay then simply shows nothing.
//
// WHY THIS FILE OWNS THE URLS
// ---------------------------
// The renderer never hands an address back to the main process. That rule is
// already written into main.js twice (claude:docs, update:open-releases):
// shell.openExternal on a renderer-supplied string is an open redirect straight
// into the user's browser. A directory of 30+ links cannot hardcode each one in
// main.js, so the compensating control is resolveLibraryUrl(): the renderer
// names an ID, and the address comes from THIS file's own validated catalog.
// An id that is not in the catalog resolves to null and nothing opens.
//
// Ids are DERIVED from the item name, never authored. Anyone can drop an entry
// into libraries.local.json without inventing a key, and a name that collides
// gets a numeric suffix so two entries can never resolve to the same link.
// ============================================================================

'use strict';

const fs = require('fs');
const paths = require('./paths');
const { hasText, normalizeText, mergeKey } = require('./localized');

const BASE_FILE = paths.bundled('libraries.json');
const localFile = () => paths.local('libraries.local.json');

/** Only these two schemes may ever reach shell.openExternal. */
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

/** Safe read + JSON parse. Returns null when the file is missing or invalid. */
function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Accepts a URL only if it parses AND uses http(s). This is the gate that keeps
 * a `file:///`, `javascript:` or custom-scheme entry in a hand-edited
 * libraries.local.json from becoming something the OS will happily launch.
 * @returns {string} the normalized href, or '' when rejected
 */
function safeUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return '';
  try {
    const parsed = new URL(value.trim());
    return ALLOWED_PROTOCOLS.has(parsed.protocol) ? parsed.href : '';
  } catch {
    return '';
  }
}

/**
 * Derives a stable, readable id from an item name: "Kokonut UI" -> "kokonut-ui",
 * "cloudflare/computer" -> "cloudflare-computer". A name that slugifies to
 * nothing (all punctuation, say) falls back to a positional key, so it still
 * gets a working id instead of being dropped.
 */
function slugify(name, ordinal) {
  const slug = String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || `item-${ordinal}`;
}

/** The icon a category falls back to when it names none, or names one badly. */
const DEFAULT_ICON = 'default';

/** An icon name is a slug, never a glyph and never markup. */
const ICON_PATTERN = /^[a-z][a-z0-9-]{0,23}$/;

/**
 * Validates the icon NAME a category carries.
 *
 * The config names an icon; it never contains one. That is deliberate and it is
 * the same rule the URLs follow two functions up: a glyph - or worse, an SVG
 * string - in a hand-edited libraries.local.json would be a second path for
 * data to reach the DOM, and the renderer would have to trust it. A slug can
 * only ever select a drawing the renderer already ships
 * (src/renderer/modules/libicons.js), so an unknown or hostile value is inert.
 *
 * Anything that is not a plain lowercase slug resolves to 'default' rather than
 * being rejected: a category with a typo'd icon should still appear in the grid
 * with a neutral tile, not vanish from the catalog.
 *
 * @param {unknown} value
 * @returns {string} a usable icon name, never empty
 */
function normalizeIcon(value) {
  if (typeof value !== 'string') return DEFAULT_ICON;
  const slug = value.trim();
  return ICON_PATTERN.test(slug) ? slug : DEFAULT_ICON;
}

/**
 * Validates a single entry. Returns { name, url, description } or null.
 * `name` and `url` are required; `description` is optional. None of the three
 * is localized - a library's name and address are the same in every language,
 * and the descriptions are technical blurbs deliberately kept in English
 * (a plain string means "the same in every language"; see src/localized.js).
 */
function normalizeItem(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.name !== 'string' || !raw.name.trim()) return null;
  const url = safeUrl(raw.url);
  if (!url) return null;
  const description = typeof raw.description === 'string' ? raw.description.trim() : '';
  return { name: raw.name.trim(), url, description };
}

/** Validates a category. Returns { title, icon, items } or null (no items). */
function normalizeCategory(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (!hasText(raw.title)) return null;
  const items = Array.isArray(raw.items) ? raw.items.map(normalizeItem).filter(Boolean) : [];
  if (items.length === 0) return null;
  return { title: normalizeText(raw.title), icon: normalizeIcon(raw.icon), items };
}

/**
 * Loads the catalog: base merged with local. A local category REPLACES the base
 * one with the same title; new categories are appended.
 *
 * Ids are assigned here, after the merge, so they reflect what is actually on
 * screen. They are unique across the WHOLE catalog, not per category - the
 * renderer passes one back as the only thing identifying a link.
 *
 * @returns {{categories: Array<{title, icon, items: Array<{id,name,url,description}>}>, total: number}}
 */
function loadLibraries() {
  const byTitle = new Map();
  const collect = (src) => {
    if (!src || !Array.isArray(src.categories)) return;
    for (const raw of src.categories) {
      const category = normalizeCategory(raw);
      // Keyed through mergeKey() for the same reason cheatsheets.js does it:
      // a localized title is an OBJECT, and objects compare by identity in a
      // Map - every category would look unique and the local override would
      // silently stop working.
      if (category) byTitle.set(mergeKey(category.title), category);
    }
  };
  collect(readJson(BASE_FILE));
  collect(readJson(localFile()));

  const used = new Set();
  let total = 0;
  const categories = [...byTitle.values()].map((category) => ({
    title: category.title,
    icon: category.icon,
    items: category.items.map((item) => {
      const base = slugify(item.name, total);
      // Two entries named the same would otherwise resolve to one URL, and the
      // second link in the list would open the first one's page.
      let id = base;
      for (let n = 2; used.has(id); n++) id = `${base}-${n}`;
      used.add(id);
      total++;
      return { id, ...item };
    }),
  }));

  return { categories, total };
}

/**
 * Resolves an id coming FROM THE RENDERER to a URL in the catalog.
 *
 * Reads fresh rather than serving a cached list: the catalog is small, and a
 * stale cache after an edit to libraries.local.json would mean an id opening
 * the address that used to sit at that position. Unknown id -> null, and the
 * caller opens nothing.
 *
 * @param {unknown} id
 * @returns {string|null}
 */
function resolveLibraryUrl(id) {
  if (typeof id !== 'string' || !id) return null;
  for (const category of loadLibraries().categories) {
    for (const item of category.items) {
      if (item.id === id) return item.url;
    }
  }
  return null;
}

// normalizeItem / normalizeCategory / safeUrl / slugify are exported for the
// same reason paths.js exports resolveUserDir: they are the pure decisions, and
// `node --test` can cover every rejection branch without a fixture directory.
module.exports = {
  loadLibraries,
  resolveLibraryUrl,
  normalizeItem,
  normalizeCategory,
  normalizeIcon,
  safeUrl,
  slugify,
};
