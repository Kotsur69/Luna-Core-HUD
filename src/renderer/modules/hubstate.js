// ============================================================================
// LunaCore - notification hub: shared view for the face icon and the drawer
// ----------------------------------------------------------------------------
// One subscription to main's hub:changed push (src/hubipc.js) and one place
// that holds the current {items, done, needs}. The face icon (hubicon.js) and
// the drawer (hubpanel.js) both read it through onHubView(). Main already
// cleans and caps every item; this module only checks the shape, so a broken
// push can never throw inside a renderer listener.
// ============================================================================

'use strict';

const EMPTY = Object.freeze({ items: [], done: [], needs: 0 });

let view = EMPTY;
let failed = false;
let started = false;
const listeners = new Set();

const call = (fn, ...args) => Promise.resolve().then(() => window.lunacore[fn](...args)).catch(() => ({ ok: false, reason: 'ipc' }));

/** A pushed or listed view -> a safe {items, done, needs}, or null when unusable. */
function shapeOf(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.items)) return null;
  const items = raw.items.filter((i) => i && typeof i === 'object' && typeof i.id === 'string');
  const done = Array.isArray(raw.done) ? raw.done.filter((i) => i && typeof i === 'object' && typeof i.id === 'string') : [];
  return { items, done, needs: items.filter((i) => i.kind === 'needs').length };
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
  if (next) view = next;
  publish();
}

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

/** Marks one item done in main; the push that follows repaints everything. */
export async function markHubDone(id) {
  const res = await call('hubDone', id);
  if (res && res.ok) await refreshHub();
  return res || { ok: false, reason: 'ipc' };
}
