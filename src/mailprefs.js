// ============================================================================
// LunaCore - report email settings + send state (main process)
// ----------------------------------------------------------------------------
// config/mail.local.json (gitignored, per machine, never synced):
//   nightlyEnabled  boolean, default false - the nightly summary email
//   nightlyTime     'HH:MM' local, default '22:30'
//   sendWhenEmpty   boolean, default false - mail even a day with nothing in it
//   godmodeEmail    boolean | null - "Email me when a run finishes"; null =
//                   never touched, which means ON once Gmail is connected
//   weeklyEmail     boolean | null - mail the weekly review (Life Settings);
//                   null = never touched = ON once Gmail is connected
//
// config/mail-state.local.json - what was already sent, so a restart never
// sends twice:
//   lastNightly     'YYYY-MM-DD' of the last nightly summary sent
//   todoBaseline    {date, done: ['<project>|<at>']} - to-dos already done
//                   when the day was first seen (todos carry no done time)
//   godmode         {runId: 'pushed|integrationState'} - the run emails sent
//
// Same loader contract as the other config files: safe read, validate at the
// boundary, a broken file yields the defaults.
// ============================================================================

'use strict';

const fs = require('fs');
const paths = require('./paths');

const PREFS_FILE = 'mail.local.json';
const STATE_FILE = 'mail-state.local.json';
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const RUN_ID_RE = /^[a-z0-9]{1,40}$/;
const RUN_KEY_RE = /^\d{1,4}\|[a-z]{1,24}$/;
const TODO_KEY_MAX = 300;
const MAX_BASELINE = 5000;
const MAX_RUNS = 50;

const DEFAULT_PREFS = Object.freeze({ nightlyEnabled: false, nightlyTime: '22:30', sendWhenEmpty: false, godmodeEmail: null, weeklyEmail: null });

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeJson(file, data, isDefault) {
  if (isDefault) paths.ensureUserDir();
  const tmp = file.replace(/(\.local)?\.json$/, `.${process.pid}.tmp.local.json`);
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}

const bool = (v, fallback) => (typeof v === 'boolean' ? v : fallback);

function normalizePrefs(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  return {
    nightlyEnabled: bool(r.nightlyEnabled, DEFAULT_PREFS.nightlyEnabled),
    nightlyTime: typeof r.nightlyTime === 'string' && TIME_RE.test(r.nightlyTime) ? r.nightlyTime : DEFAULT_PREFS.nightlyTime,
    sendWhenEmpty: bool(r.sendWhenEmpty, DEFAULT_PREFS.sendWhenEmpty),
    godmodeEmail: typeof r.godmodeEmail === 'boolean' ? r.godmodeEmail : null,
    weeklyEmail: typeof r.weeklyEmail === 'boolean' ? r.weeklyEmail : null,
  };
}

function normalizeState(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const b = r.todoBaseline && typeof r.todoBaseline === 'object' ? r.todoBaseline : null;
  const godmode = {};
  if (r.godmode && typeof r.godmode === 'object') {
    for (const [id, key] of Object.entries(r.godmode).slice(-MAX_RUNS)) {
      if (RUN_ID_RE.test(id) && typeof key === 'string' && RUN_KEY_RE.test(key)) godmode[id] = key;
    }
  }
  return {
    lastNightly: typeof r.lastNightly === 'string' && DATE_RE.test(r.lastNightly) ? r.lastNightly : '',
    todoBaseline:
      b && typeof b.date === 'string' && DATE_RE.test(b.date) && Array.isArray(b.done)
        ? { date: b.date, done: b.done.filter((k) => typeof k === 'string' && k.length <= TODO_KEY_MAX).slice(0, MAX_BASELINE) }
        : null,
    godmode,
  };
}

/**
 * @param {{prefsPath?:string, statePath?:string}} [opts] test paths
 */
function createMailPrefs(opts = {}) {
  const prefsFile = () => opts.prefsPath || paths.local(PREFS_FILE);
  const stateFile = () => opts.statePath || paths.local(STATE_FILE);

  const loadPrefs = () => normalizePrefs(readJson(prefsFile()));
  const loadState = () => normalizeState(readJson(stateFile()));

  /** Merges a renderer patch - only known keys, each validated. Throws on a bad value. */
  function savePrefs(patch) {
    if (!patch || typeof patch !== 'object') throw new Error('bad payload');
    const next = { ...loadPrefs() };
    for (const key of Object.keys(DEFAULT_PREFS)) {
      if (!Object.hasOwn(patch, key)) continue;
      const v = patch[key];
      if (key === 'nightlyTime') {
        if (typeof v !== 'string' || !TIME_RE.test(v)) throw new Error('bad time');
      } else if (typeof v !== 'boolean') {
        throw new Error('bad value');
      }
      next[key] = v;
    }
    writeJson(prefsFile(), next, !opts.prefsPath);
    return next;
  }

  /** Applies `fn(state)` -> new state and saves it; returns what was saved. */
  function updateState(fn) {
    const next = normalizeState(fn(loadState()));
    writeJson(stateFile(), next, !opts.statePath);
    return next;
  }

  return { loadPrefs, savePrefs, loadState, updateState };
}

/** "Email me when a run finishes": an explicit choice, else ON when connected. */
const godmodeEmailOn = (prefs, connected) => connected && (prefs.godmodeEmail === null ? true : prefs.godmodeEmail);

/** The weekly review email: an explicit choice, else ON when connected. */
const weeklyEmailOn = (prefs, connected) => connected && (prefs.weeklyEmail === null ? true : prefs.weeklyEmail);

module.exports = { createMailPrefs, normalizePrefs, normalizeState, godmodeEmailOn, weeklyEmailOn, DEFAULT_PREFS, MAX_RUNS };
