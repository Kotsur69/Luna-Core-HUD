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

// Elements of the current mount, or null when this widget is not on screen.
let els = null;
let lastGoodUsage = null; // last payload WITHOUT .error - what the bars render from
let lastError = null; // .error of the most recent payload, or null if it was good

/** Applies a fresh payload to module state. Pure state update, no render. */
function applyUsage(usage) {
  if (usage && !usage.error) {
    lastGoodUsage = usage;
    lastError = null;
  } else {
    lastError = (usage && usage.error) || null;
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
 * Humanises elapsed time since fetchedAt (ms epoch) -> "3s" / "42s" / "5m" /
 * "2h 5m". null when fetchedAt is missing/invalid (nothing to show yet).
 * `now` is a param (not Date.now() inline) so this stays a pure, testable
 * function - same shape as formatBytes/formatUptime in modules/telemetry.js.
 */
export function fmtAgo(fetchedAt, now = Date.now()) {
  if (typeof fetchedAt !== 'number' || !Number.isFinite(fetchedAt)) return null;
  const sec = Math.max(0, Math.round((now - fetchedAt) / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${h}h ${m}m`;
}

/** Builds one usage row (label + bar + % + time to reset). */
function usageRow(labelKey, win) {
  const row = document.createElement('div');
  row.className = 'usage-row';

  const head = document.createElement('div');
  head.className = 'usage-row__head';
  const label = document.createElement('span');
  label.className = 'usage-row__label';
  label.textContent = t(labelKey);
  const pct = document.createElement('span');
  pct.className = 'usage-row__pct';
  pct.textContent = `${win.pct}%`;
  head.append(label, pct);

  const bar = document.createElement('div');
  bar.className = 'usage-bar';
  const fill = document.createElement('div');
  fill.className = 'usage-bar__fill';
  // Fill via scaleX (--usage 0..1), consistent with .ctx-bar__fill.
  fill.style.setProperty('--usage', String(win.pct / 100));
  // Colour thresholds: >=90 bad (red), >=70 warn (orange), otherwise ok.
  fill.dataset.level = win.pct >= 90 ? 'bad' : win.pct >= 70 ? 'warn' : 'good';
  bar.appendChild(fill);

  const reset = document.createElement('div');
  reset.className = 'usage-row__reset hint';
  const when = fmtResetWhen(win.resetsAt);
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
 * Updates the "updated Xs ago" hint from lastGoodUsage.fetchedAt. Only ever
 * touches one textContent - never rebuilds the tile - so it is safe to call
 * every second without risking the flicker a full renderUsage() would cause.
 */
function renderFreshness() {
  if (!els || !els.updated) return;
  const when = lastGoodUsage ? fmtAgo(lastGoodUsage.fetchedAt) : null;
  els.updated.textContent = when ? t('usage.updatedAgo', { when }) : '';
}

/** Renders the tile from the current state. Error states become a message. */
function renderUsage() {
  if (!els) return; // not mounted - state is kept, the DOM is not ours
  const usageBody = els.body;
  usageBody.innerHTML = '';

  if (!lastGoodUsage) {
    // Never had good data yet: 'reauth'/'off' are worth naming explicitly,
    // anything else (incl. no payload at all) just reads as "still checking".
    const key =
      lastError === 'reauth'
        ? 'usage.reauth'
        : lastError === 'off'
          ? 'usage.off'
          : lastError
            ? 'usage.unavailable'
            : 'usage.loading';
    usageBody.appendChild(usageMessage(key));
    renderFreshness();
    return;
  }

  if (lastError === 'reauth' || lastError === 'off') {
    // Persistent, real states - not a blip the 15 s heartbeat will quietly
    // fix on its own, so this is the one case still worth swapping the tile.
    usageBody.appendChild(usageMessage(lastError === 'reauth' ? 'usage.reauth' : 'usage.off'));
    renderFreshness();
    return;
  }

  const u = lastGoodUsage;
  const windows = [
    ['usage.window.5h', u.fiveHour],
    ['usage.window.week', u.sevenDay],
    ['usage.window.opus', u.sevenDayOpus],
    ['usage.window.sonnet', u.sevenDaySonnet],
  ];
  let any = false;
  for (const [key, win] of windows) {
    if (win && typeof win.pct === 'number') {
      usageBody.appendChild(usageRow(key, win));
      any = true;
    }
  }
  if (!any) {
    usageBody.appendChild(usageMessage('usage.unavailable'));
    renderFreshness();
    return;
  }
  if (u.extraUsage) usageBody.appendChild(usageMessage('usage.extra'));
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
