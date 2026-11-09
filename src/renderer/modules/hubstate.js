// ============================================================================
// LunaCore - notification hub: shared view for the face icon and the drawer
// ----------------------------------------------------------------------------
// One subscription to main's hub:changed push (src/hubipc.js) and one place
// that holds the current {items, done, needs}. The face icon (hubicon.js) and
// the drawer (hubpanel.js) both read it through onHubView(). Main already
// cleans and caps every item; this module only checks the shape, so a broken
// push can never throw inside a renderer listener.
//
// N7: the hub Settings sync across PCs. When another PC's choice lands, main
// pushes 'hub:prefsChanged' (no payload); onHubPrefs() listeners get the
// freshly re-read getUiPrefs() so toasts, auto-open, Settings and the system
// notification switch apply it live, without a restart.
// ============================================================================

'use strict';

const EMPTY = Object.freeze({ items: [], done: [], needs: 0, unseen: 0 });

let view = EMPTY;
let failed = false;
let started = false;
let loaded = false;
const listeners = new Set();

const call = (fn, ...args) => Promise.resolve().then(() => window.lunacore[fn](...args)).catch(() => ({ ok: false, reason: 'ipc' }));

/** A pushed or listed view -> a safe {items, done, needs}, or null when unusable. */
function shapeOf(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.items)) return null;
  const items = raw.items.filter((i) => i && typeof i === 'object' && typeof i.id === 'string');
  const done = Array.isArray(raw.done) ? raw.done.filter((i) => i && typeof i === 'object' && typeof i.id === 'string') : [];
  const needs = items.filter((i) => i.kind === 'needs').length;
  const unseen = Number.isInteger(raw.unseen) && raw.unseen >= 0 ? Math.min(raw.unseen, needs) : 0;
  return { items, done, needs, unseen };
}

function publish() {
  for (const fn of listeners) {
    try {
      fn(view, failed);
    } catch (err) {
      console.error('[hub] view listener failed', err);
    }
  }
}

function accept(raw) {
  const next = shapeOf(raw);
  failed = !next;
  if (next) {
    view = next;
    loaded = true;
  }
  publish();
}

/** True once main has answered with a real view (not the empty placeholder). */
export const hubLoaded = () => loaded;

/** Asks main for the list now (launch, window focus, after a mark). */
export async function refreshHub() {
  const res = await call('hubList');
  accept(res && res.ok ? res : null);
}

/** Starts the push subscription once; safe to call from every mount. */
export function startHub() {
  if (started) return;
  started = true;
  if (window.lunacore && typeof window.lunacore.onHubChanged === 'function') window.lunacore.onHubChanged(accept);
  window.addEventListener('focus', () => refreshHub());
  refreshHub();
}

/** fn(view, failed) now and on every change; returns an unsubscribe. */
export function onHubView(fn) {
  listeners.add(fn);
  fn(view, failed);
  return () => listeners.delete(fn);
}

const prefsListeners = new Set();
let prefsWired = false;

async function rereadPrefs() {
  const prefs = await call('getUiPrefs');
  if (!prefs || typeof prefs !== 'object' || prefs.ok === false) return;
  for (const fn of prefsListeners) {
    try {
      fn(prefs);
    } catch (err) {
      console.error('[hub] prefs listener failed', err);
    }
  }
  // A switched-off source group changes the list: ask main for it now.
  refreshHub();
}

/**
 * fn(prefs) whenever another PC changed the synced hub Settings (N7); the
 * prefs are the whole re-read ui.local.json. Returns an unsubscribe.
 */
export function onHubPrefs(fn) {
  prefsListeners.add(fn);
  if (!prefsWired && window.lunacore && typeof window.lunacore.onHubPrefsChanged === 'function') {
    prefsWired = true;
    window.lunacore.onHubPrefsChanged(() => {
      rereadPrefs();
    });
  }
  return () => prefsListeners.delete(fn);
}

/** Marks one item done in main; the push that follows repaints everything. */
export async function markHubDone(id) {
  const res = await call('hubDone', id);
  if (res && res.ok) await refreshHub();
  return res || { ok: false, reason: 'ipc' };
}

/** The drawer shows the list: main marks its open Needs-you items seen (no ids cross). */
export async function markHubSeen() {
  if (!view.unseen) return { ok: true, unseen: 0 };
  const res = await call('hubSeen');
  return res || { ok: false, reason: 'ipc' };
}
