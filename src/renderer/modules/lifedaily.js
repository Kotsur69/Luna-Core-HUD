// ============================================================================
// LunaCore - Life dashboard: daily state (renderer)
// ----------------------------------------------------------------------------
// Check-in, habits, weekly goals and the live productivity score, next to the
// budget state in lifeui.js. Every answer comes from the life:* daily IPC
// (src/lifeipc.js) and is kept here; subscribers are told WHICH part changed,
// so a score refresh every minute redraws only the score card - never a
// form being typed in. The score polls while the dashboard is open.
// ============================================================================

'use strict';

import { setStatus, errText } from './lifeui.js';

const SCORE_EVERY_MS = 60 * 1000;

const daily = { checkin: null, habits: null, goals: null, score: null };
const listeners = new Set();
let timer = null;

export const getDaily = () => daily;

/** fn(part) runs after `part` ('checkin' | 'habits' | 'goals' | 'score') changed; returns the unsubscribe. */
export function onDaily(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

const ipcFailed = () => ({ ok: false, reason: 'ipc' });

function accept(part, res, quiet = false) {
  if (!res || !res.ok) {
    if (!quiet) setStatus(errText(res ? res.reason : 'failed'), true);
    return res || ipcFailed();
  }
  daily[part] = res;
  for (const fn of listeners) fn(part);
  return res;
}

const call = (fn, ...args) => Promise.resolve().then(() => window.lunacore[fn](...args)).catch(ipcFailed);

export const loadCheckin = async () => accept('checkin', await call('lifeCheckin'));
export const loadHabits = async () => accept('habits', await call('lifeHabits'));
export const loadGoals = async () => accept('goals', await call('lifeGoals'));
/** Quiet: a failed background refresh keeps the last score instead of flashing an error. */
export const loadScore = async () => accept('score', await call('lifeScore'), true);

/** Everything the prompts and the Overview need; the score last (it scans transcripts). */
export async function loadDaily() {
  await Promise.all([loadCheckin(), loadGoals(), loadHabits()]);
  await loadScore();
}

/** Every write refreshes the score too: a tick or a goal moves it at once. */
async function after(part, res) {
  const out = accept(part, res);
  if (out.ok) loadScore();
  return out;
}

export const setCheckin = async (date, sleep, energy) => after('checkin', await call('lifeCheckinSet', date, sleep, energy));
export const habitsDo = async (op, data) => after('habits', await call('lifeHabitsDo', op, data));
export const goalsDo = async (op, data) => after('goals', await call('lifeGoalsSet', op, data));

export async function setScorePrefs(weights, focusTargetH) {
  const res = await call('lifeScorePrefs', weights, focusTargetH);
  if (!res.ok) {
    setStatus(errText(res.reason), true);
    return res;
  }
  await loadScore();
  return res;
}

// Quiet reloads for another PC's changes: a failed background read keeps the last answer.
const RELOADS = {
  checkin: async () => accept('checkin', await call('lifeCheckin'), true),
  habits: async () => accept('habits', await call('lifeHabits'), true),
  goals: async () => accept('goals', await call('lifeGoals'), true),
};

/**
 * Another PC's check-in / habits / goals / score settings were merged here
 * (main's life:changed): reload those parts, so subscribers (the check-in and
 * goals prompts) re-evaluate without a restart.
 */
async function onSynced(payload) {
  const parts = payload && Array.isArray(payload.parts) ? payload.parts : [];
  await Promise.all(parts.filter((p) => Object.hasOwn(RELOADS, p)).map((p) => RELOADS[p]()));
  if (parts.length) await loadScore();
}

/** A field of the Life dashboard has focus: a redraw now would wipe what is being typed. */
function typingInLife() {
  const el = document.activeElement;
  return Boolean(el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) && el.closest && el.closest('#life'));
}

// Parts another PC changed while a field had focus; reloaded once it loses focus.
let heldParts = new Set();

function applySynced(parts) {
  onSynced({ parts }).catch(() => {
    // The next dashboard open reads again.
  });
}

if (typeof window !== 'undefined' && window.lunacore && typeof window.lunacore.onLifeChanged === 'function') {
  window.lunacore.onLifeChanged((payload) => {
    const parts = payload && Array.isArray(payload.parts) ? payload.parts : [];
    if (!typingInLife()) return applySynced(parts);
    heldParts = new Set([...heldParts, ...parts]);
  });
  document.addEventListener('focusout', () => {
    // After the focus has moved: tabbing to the next field still holds the reload.
    setTimeout(() => {
      if (!heldParts.size || typingInLife()) return;
      const parts = [...heldParts];
      heldParts = new Set();
      applySynced(parts);
    }, 0);
  });
}

/** Live while the dashboard is open: the score (focus, Now strip) refreshes every minute. */
export function startLive() {
  stopLive();
  timer = setInterval(loadScore, SCORE_EVERY_MS);
}

export function stopLive() {
  clearInterval(timer);
  timer = null;
}
