// ============================================================================
// LunaCore - usage limits meter (5h + weekly)
// ----------------------------------------------------------------------------
// Data arrives on IPC usage:update (a GET against the CLI's OAuth endpoint -
// zero tokens). The renderer keeps the last payload and counts down to the
// reset from resetsAt locally, so a language switch and the ticking clock
// refresh the UI without a new request.
//
// A2: converted to the widget contract, following modules/ports.js. The split
// is the one every conversion uses - `lastGoodUsage` is APP state and stays at
// module scope (the bus channel replays, so a remount repaints from it at once
// instead of flashing "checking limits..."), while `els` belongs to the mount
// and is null whenever this block is off screen.
//
// The one real leak this fixes: the 30 s countdown used to be a module-level
// setInterval that nothing could ever stop.
//
// STALE-WHILE-ERROR: a transient 'unavailable' read (network blip, one bad
// poll) used to wipe the bars and show an error sentence instead, so the tile
// looked like it kept disappearing every few polls. Now the bars always
// render from the last GOOD payload (lastGoodUsage); a transient error only
// leaves the "updated Xs ago" label to grow instead of resetting - see
// renderFreshness(). Only 'reauth' (no valid token) and 'off' (feature
// disabled) still take over the whole tile, because those are real, lasting
// states the next 15 s heartbeat (src/usage.js UsageWatcher) can't fix on
// its own - the user has to do something (run `claude`, flip the flag).
// ============================================================================

'use strict';

import { t } from './util.js';
import { onLangChange, onUsageUpdate } from './bus.js';
import { defineWidget } from './registry.js';

/** How often the "resets in ..." labels are recomputed (locally, no request). */
const COUNTDOWN_MS = 30000;

/** How often the "updated Xs ago" label ticks (locally, no request). */
const FRESHNESS_MS = 1000;

// Default reset times for common windows (in milliseconds from now)
const WINDOW_RESETS = {
  '5h': 5 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
  monthly: 30 * 24 * 60 * 60 * 1000,
  balance: null, // no reset for balance
};

/** Computes a resetsAt timestamp from a window type. */
function getResetsAt(windowType) {
  const ms = WINDOW_RESETS[windowType];
  if (!ms) return null;
  return new Date(Date.now() + ms).toISOString();
}

// Elements of the current mount, or null when this widget is not on screen.
let els = null;
let lastGoodUsage = null; // last payload WITH status==='ok' - what the bars render from
let lastError = null; // status value of most recent error/unconfigured payload

/** Applies a fresh payload to module state. Pure state update, no render. */
function applyUsage(usage) {
  if (usage && usage.status === 'ok') {
    lastGoodUsage = usage;
    lastError = null;
  } else if (usage && usage.status) {
    // Persistent error states that need user action
    lastError = usage.status; // 'unconfigured', 'error', 'unsupported'
  }
}

/** Humanises the time to reset (ISO -> "4d 2h" / "3h 12m" / "9m"). null once past. */
function fmtResetWhen(resetsAt) {
  if (!resetsAt) return null;
  const ms = new Date(resetsAt).getTime() - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const min = Math.floor(ms / 60000);
  const d = Math.floor(min / 1440);
  const h = Math.floor((min % 1440) / 60);
  const m = min % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

/**
 * Humanises elapsed time since updatedAt (ms epoch) -> "3s" / "42s" / "5m" /
 * "2h 5m". null when updatedAt is missing/invalid (nothing to show yet).
 * `now` is a param (not Date.now() inline) so this stays a pure, testable
 * function - same shape as formatBytes/formatUptime in modules/telemetry.js.
 */
export function fmtAgo(updatedAt, now = Date.now()) {
  if (typeof updatedAt !== 'number' || !Number.isFinite(updatedAt)) return null;
  const sec = Math.max(0, Math.round((now - updatedAt) / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${h}h ${m}m`;
}

/** Builds one usage row from a limit object in the new format. */
function usageRowForLimit(limit) {
  const row = document.createElement('div');
  row.className = 'usage-row';

  const head = document.createElement('div');
  head.className = 'usage-row__head';
  const label = document.createElement('span');
  label.className = 'usage-row__label';
  label.textContent = limit.label || t('usage.window.custom');
  const pct = document.createElement('span');
  pct.className = 'usage-row__pct';
  pct.textContent = `${limit.percentUsed}%`;
  head.append(label, pct);

  const bar = document.createElement('div');
  bar.className = 'usage-bar';
  const fill = document.createElement('div');
  fill.className = 'usage-bar__fill';
  fill.style.setProperty('--usage', String(limit.percentUsed / 100));
  // Colour thresholds: >=90 bad (red), >=70 warn (orange), otherwise ok.
  fill.dataset.level =
    limit.percentUsed >= 90 ? 'bad' : limit.percentUsed >= 70 ? 'warn' : 'good';
  bar.appendChild(fill);

  const reset = document.createElement('div');
  reset.className = 'usage-row__reset hint';
  // Try to get resetsAt from the limit, or compute from window type
  const resetsAt =
    typeof limit.resetsAt === 'string'
      ? limit.resetsAt
      : limit.window
        ? getResetsAt(limit.window)
        : null;
  const when = fmtResetWhen(resetsAt);
  reset.textContent = when ? t('usage.resetIn', { when }) : t('usage.resetting');

  row.append(head, bar, reset);
  return row;
}

function usageMessage(key) {
  const p = document.createElement('p');
  p.className = 'hint';
  p.textContent = t(key);
  return p;
}

/**
 * Updates the "updated Xs ago" hint from lastGoodUsage.updatedAt. Only ever
 * touches one textContent - never rebuilds the tile - so it is safe to call
 * every second without risking the flicker a full renderUsage() would cause.
 */
function renderFreshness() {
  if (!els || !els.updated) return;
  const when = lastGoodUsage ? fmtAgo(lastGoodUsage.updatedAt) : null;
  els.updated.textContent = when ? t('usage.updatedAgo', { when }) : '';
}

/** Renders the tile from the current state. Error states become a message. */
function renderUsage() {
  if (!els) return; // not mounted - state is kept, the DOM is not ours
  const usageBody = els.body;
  usageBody.innerHTML = '';

  if (!lastGoodUsage) {
    // Never had good data yet: show loading or last error
    const key =
      lastError === 'unconfigured'
        ? 'usage.unconfigured'
        : lastError === 'unsupported'
          ? 'usage.unsupported'
          : lastError === 'error'
            ? 'usage.unavailable'
            : 'usage.loading';
    usageBody.appendChild(usageMessage(key));
    renderFreshness();
    return;
  }

  if (lastError === 'unconfigured' || lastError === 'unsupported') {
    // Persistent states - not a blip the 15 s heartbeat will fix
    usageBody.appendChild(
      usageMessage(lastError === 'unconfigured' ? 'usage.unconfigured' : 'usage.unsupported')
    );
    renderFreshness();
    return;
  }

  const u = lastGoodUsage;

  // New format: iterate over limits[] array
  let any = false;
  for (const limit of u.limits || []) {
    if (typeof limit.percentUsed === 'number') {
      usageBody.appendChild(usageRowForLimit(limit));
      any = true;
    }
  }

  if (!any) {
    usageBody.appendChild(usageMessage('usage.unavailable'));
    renderFreshness();
    return;
  }

  // Show fallback indicator if applicable
  if (u.isFallback) {
    usageBody.appendChild(usageMessage('usage.fallback'));
  }

  renderFreshness();
}

defineWidget({
  id: 'usage',
  titleKey: 'usage.title',
  template: 'w-usage',
  mount(root) {
    els = {
      body: root.querySelector('#usage-body'),
      refresh: root.querySelector('#usage-refresh'),
      updated: root.querySelector('#usage-updated'),
    };

    // Via feeds.js, not straight off IPC - see the note there on disposability.
    // It replays, so a remount repaints from the last poll instead of waiting
    // up to 90 s for the next one.
    const offUsage = onUsageUpdate((usage) => {
      applyUsage(usage);
      renderUsage();
    });

    const offLang = onLangChange(renderUsage);

    els.refresh.addEventListener('click', async () => {
      const btn = els.refresh;
      btn.classList.add('is-spinning');
      try {
        const u = await window.lunacore.refreshUsage();
        if (u) {
          applyUsage(u);
          renderUsage(); // no-op if we were unmounted while awaiting
        }
      } catch {
        /* ignore - the watcher will emit on its next tick anyway */
      } finally {
        // Purely decorative, and bound to a node inside root: if this widget is
        // gone by now the element goes with it. Nothing to flush (cf. the
        // scratchpad debounce, which does carry user intent).
        setTimeout(() => btn.classList.remove('is-spinning'), 400);
      }
    });

    // Refresh the reset labels every 30 s (the countdown is computed locally
    // from resetsAt, with no new network request).
    const countdown = setInterval(() => {
      if (lastGoodUsage) renderUsage();
    }, COUNTDOWN_MS);

    // Tick the "updated Xs ago" label every second - a plain textContent
    // write, not a body rebuild, so it can't cause the flicker a full
    // renderUsage() on the same cadence would.
    const freshness = setInterval(renderFreshness, FRESHNESS_MS);

    renderUsage();

    return () => {
      offUsage();
      offLang();
      clearInterval(countdown);
      clearInterval(freshness);
      els = null;
    };
  },
});
