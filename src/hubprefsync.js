// ============================================================================
// LunaCore - notification hub: its Settings synced across PCs (main)
// ----------------------------------------------------------------------------
// docs/tbc_docs/NOTIFICATION_HUB_PLAN.md N7. The hub's switches live in
// ui.local.json (src/uiprefs.js), which never syncs as a whole. This
// configsync.js provider (same contract as src/hubdone.js and
// src/hostdefault.js) carries four of them as `config` units, newest `u` wins:
//
//   hub:pref:autoOpen  {value: 'always'|'needed'|'never'}   hubAutoOpen
//   hub:pref:toasts    {value: boolean}                      hubToasts
//   hub:pref:sources   {value: {group: false}}               hubSources
//   hub:pref:notify    {value: boolean}                      notificationsEnabled
//
// hubWidth (the drawer's dragged width - each PC has its own screen) and
// hubBriefHintSeen (a one-time hint per PC) stay local on purpose.
//
// - valid(): a cloud value is untrusted; it goes through the same cleaners
//   uiprefs.js uses and is REJECTED (null) when the cleaner would change it -
//   a bad value never turns into a default that then wins.
// - isDefault() (handed back by read(), where configsync.js looks for it): on
//   a first sync a unit that still holds the store's default is stamped 0, so
//   a fresh PC never overwrites a real choice made elsewhere.
// - write(): one writeUiPrefs() partial merge - every other pref is kept.
// ============================================================================

'use strict';

const fs = require('fs');
const { cleanHubAutoOpen } = require('./uiprefs');
const { cleanHubSources } = require('./hubsources');

const PROVIDER_NAME = 'hubprefs';
const KEY_PREFIX = 'hub:pref:';

const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** A clean pref value, or null when the raw value is not one the cleaner keeps as is. */
const cleanBool = (v) => (typeof v === 'boolean' ? v : null);
const cleanAutoOpen = (v) => (typeof v === 'string' && cleanHubAutoOpen(v) === v ? v : null);
function cleanSources(v) {
  // Only switched-off groups are stored: any other value is a broken row.
  // Unknown groups are dropped quietly (a newer PC may know more groups).
  if (!isObject(v) || !Object.values(v).every((on) => on === false)) return null;
  return cleanHubSources(v);
}

/**
 * Unit key -> the ui.local.json pref it carries, its cleaner and its default
 * (the uiprefs.js DEFAULTS: auto-open 'needed', toasts on, all sources on,
 * system notifications off).
 */
const UNITS = Object.freeze({
  [`${KEY_PREFIX}autoOpen`]: Object.freeze({ pref: 'hubAutoOpen', clean: cleanAutoOpen, fallback: cleanHubAutoOpen(undefined) }),
  [`${KEY_PREFIX}toasts`]: Object.freeze({ pref: 'hubToasts', clean: cleanBool, fallback: true }),
  [`${KEY_PREFIX}sources`]: Object.freeze({ pref: 'hubSources', clean: cleanSources, fallback: Object.freeze({}) }),
  [`${KEY_PREFIX}notify`]: Object.freeze({ pref: 'notificationsEnabled', clean: cleanBool, fallback: false }),
});

/** The ui.local.json keys this provider syncs. */
const SYNCED_PREFS = Object.freeze(Object.values(UNITS).map((u) => u.pref));

const specOf = (k) => (typeof k === 'string' && Object.hasOwn(UNITS, k) ? UNITS[k] : null);

/** A cloud unit -> {value} or null (unknown key, wrong shape, value the cleaner rejects). */
function validPref(k, v) {
  const spec = specOf(k);
  if (!spec || !isObject(v) || !Object.hasOwn(v, 'value')) return null;
  const value = spec.clean(v.value);
  return value === null ? null : { value };
}

/** First sync: a pref still at its default never beats another PC's choice. */
function isDefaultPref(k, v) {
  const spec = specOf(k);
  return Boolean(spec) && isObject(v) && sameJson(v.value, spec.fallback);
}

/** True when a ui:set partial touches a synced pref (main: sync soon, so it travels). */
const touchesSyncedPrefs = (partial) => isObject(partial) && SYNCED_PREFS.some((k) => k in partial);

/**
 * The configsync.js provider.
 * @param {{readPrefs:()=>object, writePrefs:(partial:object)=>object|null, file?:()=>string|null}} deps
 *   readPrefs / writePrefs = uiprefs.js readUiPrefs / writeUiPrefs; file =
 *   ui.local.json (its mtime stamps a real choice on the first sync).
 */
function createHubPrefsProvider({ readPrefs, writePrefs, file = () => null }) {
  return {
    name: PROVIDER_NAME,
    owns: (k) => typeof k === 'string' && k.startsWith(KEY_PREFIX),
    valid: validPref,
    read(now) {
      const prefs = readPrefs() || {};
      const units = Object.entries(UNITS)
        .map(([k, spec]) => {
          const value = spec.clean(prefs[spec.pref]);
          return [k, { value: value === null ? spec.fallback : value }];
        })
        .sort((a, b) => a[0].localeCompare(b[0]));
      let base = 0;
      try {
        const f = file();
        if (f) base = Math.floor(Math.min(fs.statSync(f).mtimeMs, now));
      } catch {
        base = 0; // No file yet: nothing was chosen here.
      }
      // configsync.js reads isDefault from the read() result (firstSyncDefaults).
      return { units, base, isDefault: isDefaultPref };
    },
    isDefault: isDefaultPref,
    write(units) {
      const partial = {};
      for (const [k, v] of units) {
        const clean = validPref(k, v);
        if (clean) partial[specOf(k).pref] = clean.value;
      }
      // A missing unit (a tombstone from a broken peer) leaves the local pref alone.
      if (!Object.keys(partial).length) return;
      if (!writePrefs(partial)) throw new Error('ui prefs not written');
    },
  };
}

module.exports = { createHubPrefsProvider, validPref, touchesSyncedPrefs, SYNCED_PREFS, PROVIDER_NAME, KEY_PREFIX, UNITS };
