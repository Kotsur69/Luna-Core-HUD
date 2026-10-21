// ============================================================================
// LunaCore - Web Push requests from a PC / host (main)
// ----------------------------------------------------------------------------
// docs/REMOTE_HOST_PLAN.md H4. The `push` edge function sends the actual
// notification (supabase/functions/push); this side only says what happened:
//
//   chat events   approval needed, session done / failed (src/hostchat.js)
//   usage         80 % and 95 % of the 5 h and weekly limits, once per window
//                 (a window is identified by its reset time), from wherever
//                 the PC puts its `usage` snapshot
//
// Each request carries a dedupe key; the function fires a key once. Only the
// event, this machine's name and the key go out: never text from a session.
// ============================================================================

'use strict';

const LEVELS = [80, 95];
const WINDOWS = ['fiveHour', 'sevenDay'];
const MAX_SENT = 64;
const KEY_RE = /^[A-Za-z0-9:._-]{1,120}$/;

const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

/**
 * A `usage` snapshot (src/usagesnapshot.js) -> the alerts due now. Only the
 * highest level crossed in a window is sent; the lower one counts as sent too,
 * so a jump straight to 96 % is one notification, not two.
 * @param {object|null} snap
 * @param {Set<string>} sent keys already sent
 * @returns {{alerts: {window: string, level: number, key: string}[], sent: Set<string>}}
 */
function usageAlerts(snap, sent) {
  const next = new Set(sent);
  const alerts = [];
  for (const window of WINDOWS) {
    const w = isObject(snap) ? snap[window] : null;
    if (!isObject(w) || !Number.isFinite(w.pct)) continue;
    // Minutes: a reset time that wobbles by seconds between reads is the same window.
    const id = Number.isFinite(w.resetsAt) ? Math.round(w.resetsAt / 60000) : 'none';
    const crossed = LEVELS.filter((l) => w.pct >= l);
    if (!crossed.length) continue;
    const top = crossed[crossed.length - 1];
    const key = `usage:${window}:${top}:${id}`;
    if (!next.has(key)) alerts.push({ window, level: top, key });
    for (const l of crossed) next.add(`usage:${window}:${l}:${id}`);
  }
  // Old windows fall out; the function's own dedupe still holds for them.
  const trimmed = new Set([...next].slice(-MAX_SENT));
  return { alerts, sent: trimmed };
}

/**
 * @param {{invoke: (body: object) => Promise<unknown>, machine: string,
 *   log?: (line: string) => void}} deps
 *   invoke = the cloud client's functions.invoke('push', {body})
 */
function createHostPush({ invoke, machine, log = (l) => console.error(l) }) {
  let sent = new Set();

  function post(body) {
    if (!KEY_RE.test(body.key)) return Promise.resolve();
    return Promise.resolve()
      .then(() => invoke(body))
      .then((res) => {
        if (res && res.error) log(`[hostpush] ${body.event} not sent: ${res.error.message || 'error'}`);
      })
      .catch((err) => log(`[hostpush] ${body.event} failed: ${err && err.message}`));
  }

  return {
    /** hostchat's notify(kind, {key}). */
    chat(kind, info) {
      if (!['approval', 'done', 'failed'].includes(kind) || !info || typeof info.key !== 'string') return Promise.resolve();
      return post({ event: kind, machine, key: info.key });
    },
    /** After each usage put: the 80 % / 95 % alerts not sent yet. */
    usage(snap) {
      const r = usageAlerts(snap, sent);
      sent = r.sent;
      return Promise.all(r.alerts.map((a) => post({ event: 'usage', machine, key: a.key, window: a.window, level: a.level })));
    },
  };
}

module.exports = { createHostPush, usageAlerts, LEVELS };
