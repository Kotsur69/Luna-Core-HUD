// ============================================================================
// LunaCore - usage limits meter (5h + weekly)
// ----------------------------------------------------------------------------
// Data arrives on IPC usage:update (a GET against the CLI's OAuth endpoint -
// zero tokens). The renderer keeps the last payload and counts down to the
// reset from resetsAt locally, so a language switch and the ticking clock
// refresh the UI without a new request.
//
// A2: converted to the widget contract, following modules/ports.js. The split
// is the one every conversion uses - `lastUsage` is APP state and stays at
// module scope (the bus channel replays, so a remount repaints from it at once
// instead of flashing "checking limits..."), while `els` belongs to the mount
// and is null whenever this block is off screen.
//
// The one real leak this fixes: the 30 s countdown used to be a module-level
// setInterval that nothing could ever stop.
// ============================================================================

'use strict';

import { t } from './util.js';
import { onLangChange, onUsageUpdate } from './bus.js';
import { defineWidget } from './registry.js';

/** How often the "resets in ..." labels are recomputed (locally, no request). */
const COUNTDOWN_MS = 30000;

// Elements of the current mount, or null when this widget is not on screen.
let els = null;
let lastUsage = null;

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

/** Renders the tile from the current state. Error states become a message. */
function renderUsage() {
  if (!els) return; // not mounted - lastUsage is kept, the DOM is not ours
  const usageBody = els.body;
  usageBody.innerHTML = '';
  const u = lastUsage;
  if (!u) {
    usageBody.appendChild(usageMessage('usage.loading'));
    return;
  }
  if (u.error) {
    const key =
      u.error === 'reauth' ? 'usage.reauth' : u.error === 'off' ? 'usage.off' : 'usage.unavailable';
    usageBody.appendChild(usageMessage(key));
    return;
  }
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
    return;
  }
  if (u.extraUsage) usageBody.appendChild(usageMessage('usage.extra'));
}

defineWidget({
  id: 'usage',
  titleKey: 'usage.title',
  template: 'w-usage',
  mount(root) {
    els = {
      body: root.querySelector('#usage-body'),
      refresh: root.querySelector('#usage-refresh'),
    };

    // Via feeds.js, not straight off IPC - see the note there on disposability.
    // It replays, so a remount repaints from the last poll instead of waiting
    // up to 90 s for the next one.
    const offUsage = onUsageUpdate((usage) => {
      lastUsage = usage;
      renderUsage();
    });

    const offLang = onLangChange(renderUsage);

    els.refresh.addEventListener('click', async () => {
      const btn = els.refresh;
      btn.classList.add('is-spinning');
      try {
        const u = await window.lunacore.refreshUsage();
        if (u) {
          lastUsage = u;
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
      if (lastUsage && !lastUsage.error) renderUsage();
    }, COUNTDOWN_MS);

    renderUsage();

    return () => {
      offUsage();
      offLang();
      clearInterval(countdown);
      els = null;
    };
  },
});
