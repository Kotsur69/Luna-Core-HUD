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
//   replyRead       boolean, default false - "Read replies to Luna's Work
//                   emails" (src/lunasworkMailReplies.js). Set only through
//                   setReplyRead, after its own gmail.readonly consent - never
//                   by the generic savePrefs patch
//   replyClients    {projectId: ['client@x.com', ...]} - addresses Mati
//                   allow-listed per project; their replies count as client
//                   feedback (setReplyClients)
//
// config/mail-state.local.json - what was already sent, so a restart never
// sends twice:
//   lastNightly     'YYYY-MM-DD' of the last nightly summary sent
//   todoBaseline    {date, done: ['<project>|<at>']} - to-dos already done
//                   when the day was first seen (todos carry no done time)
//   godmode         {runId: 'pushed|integrationState'} - the run emails sent
//   godmodePending  [{id, at, reason, summary}] - run emails waiting for
//                   Gmail (src/godmodePending.js), oldest first
//
// Same loader contract as the other config files: safe read, validate at the
// boundary, a broken file yields the defaults.
// ============================================================================

'use strict';

const fs = require('fs');
const paths = require('./paths');
const { normalizePending } = require('./godmodePending');

const PREFS_FILE = 'mail.local.json';
const STATE_FILE = 'mail-state.local.json';
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const RUN_ID_RE = /^[a-z0-9]{1,40}$/;
const RUN_KEY_RE = /^\d{1,4}\|[a-z]{1,24}$/;
const TODO_KEY_MAX = 300;
const MAX_BASELINE = 5000;
const MAX_RUNS = 50;
const PROJECT_ID_RE = /^[A-Za-z0-9._-]{1,80}$/;
// Same shape as gmailsend's EMAIL_RE: one bare address, nothing to inject.
const EMAIL_RE = /^[^\s@<>()",;:\\[\]]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;
const MAX_CLIENTS = 10;
const MAX_CLIENT_PROJECTS = 50;
// Keys that would reach the prototype of a plain object instead of an own entry.
const RESERVED_IDS = new Set(['__proto__', 'constructor', 'prototype']);
const projectIdOk = (id) => typeof id === 'string' && PROJECT_ID_RE.test(id) && !RESERVED_IDS.has(id);

const DEFAULT_PREFS = Object.freeze({
  nightlyEnabled: false,
  nightlyTime: '22:30',
  sendWhenEmpty: false,
  godmodeEmail: null,
  weeklyEmail: null,
  replyRead: false,
  replyClients: Object.freeze({}),
});
// What a renderer patch (mail:set) may change; the reply settings have their own setters.
const PATCH_KEYS = ['nightlyEnabled', 'nightlyTime', 'sendWhenEmpty', 'godmodeEmail', 'weeklyEmail'];

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

/** A project's allow-listed addresses: valid, lower case, unique, capped; null when the list is bad. */
function cleanClientList(list) {
  if (!Array.isArray(list) || list.length > MAX_CLIENTS) return null;
  if (!list.every((a) => typeof a === 'string' && EMAIL_RE.test(a.trim()))) return null;
  return [...new Set(list.map((a) => a.trim().toLowerCase()))];
}

function normalizeClients(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [id, list] of Object.entries(raw).slice(0, MAX_CLIENT_PROJECTS)) {
    const clean = projectIdOk(id) ? cleanClientList(list) : null;
    if (clean && clean.length) out[id] = clean;
  }
  return out;
}

function normalizePrefs(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  return {
    nightlyEnabled: bool(r.nightlyEnabled, DEFAULT_PREFS.nightlyEnabled),
    nightlyTime: typeof r.nightlyTime === 'string' && TIME_RE.test(r.nightlyTime) ? r.nightlyTime : DEFAULT_PREFS.nightlyTime,
    sendWhenEmpty: bool(r.sendWhenEmpty, DEFAULT_PREFS.sendWhenEmpty),
    godmodeEmail: typeof r.godmodeEmail === 'boolean' ? r.godmodeEmail : null,
    weeklyEmail: typeof r.weeklyEmail === 'boolean' ? r.weeklyEmail : null,
    replyRead: r.replyRead === true,
    replyClients: normalizeClients(r.replyClients),
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
    godmodePending: normalizePending(r.godmodePending),
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
    for (const key of PATCH_KEYS) {
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

  /**
   * "Read replies to Luna's Work emails". Main calls it only after the read
   * consent went through (on) or after revoking it (off).
   */
  function setReplyRead(on) {
    if (typeof on !== 'boolean') throw new Error('bad value');
    const next = { ...loadPrefs(), replyRead: on };
    writeJson(prefsFile(), next, !opts.prefsPath);
    return next;
  }

  /** One project's allow-listed client addresses; [] removes the project. Throws on a bad list. */
  function setReplyClients(projectId, list) {
    if (!projectIdOk(projectId)) throw new Error('bad value');
    const clean = cleanClientList(list);
    if (!clean) throw new Error('bad value');
    const prev = loadPrefs();
    const replyClients = { ...prev.replyClients };
    delete replyClients[projectId];
    if (clean.length) {
      if (Object.keys(replyClients).length >= MAX_CLIENT_PROJECTS) throw new Error('bad value');
      replyClients[projectId] = clean;
    }
    const next = { ...prev, replyClients };
    writeJson(prefsFile(), next, !opts.prefsPath);
    return next;
  }

  /** Applies `fn(state)` -> new state and saves it; returns what was saved. */
  function updateState(fn) {
    const next = normalizeState(fn(loadState()));
    writeJson(stateFile(), next, !opts.statePath);
    return next;
  }

  return { loadPrefs, savePrefs, setReplyRead, setReplyClients, loadState, updateState };
}

/** "Email me when a run finishes": an explicit choice, else ON when connected. */
const godmodeEmailOn = (prefs, connected) => connected && (prefs.godmodeEmail === null ? true : prefs.godmodeEmail);

/** The weekly review email: an explicit choice, else ON when connected. */
const weeklyEmailOn = (prefs, connected) => connected && (prefs.weeklyEmail === null ? true : prefs.weeklyEmail);

module.exports = { createMailPrefs, normalizePrefs, normalizeState, godmodeEmailOn, weeklyEmailOn, DEFAULT_PREFS, MAX_RUNS, MAX_CLIENTS };
