// ============================================================================
// LunaCore - usage limits meter (5h + weekly)
// ----------------------------------------------------------------------------
// Data arrives on IPC usage:update (a GET against the CLI's OAuth endpoint -
// zero tokens). The renderer keeps the last payload and counts down to the
// reset from resetsAt locally, so a language switch and the ticking clock
// refresh the UI without a new request.
// ============================================================================

'use strict';

import { t } from './util.js';
import { onLangChange, onUsageUpdate } from './bus.js';

const usageBody = document.getElementById('usage-body');
const usageRefreshBtn = document.getElementById('usage-refresh');

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

// Via feeds.js, not straight off IPC - see the note there on disposability.
onUsageUpdate((usage) => {
  lastUsage = usage;
  renderUsage();
});

usageRefreshBtn.addEventListener('click', async () => {
  usageRefreshBtn.classList.add('is-spinning');
  try {
    const u = await window.lunacore.refreshUsage();
    if (u) {
      lastUsage = u;
      renderUsage();
    }
  } catch {
    /* ignore - the watcher will emit on its next tick anyway */
  } finally {
    setTimeout(() => usageRefreshBtn.classList.remove('is-spinning'), 400);
  }
});

// Refresh the reset labels every 30 s (the countdown is computed locally from
// resetsAt, with no new network request).
setInterval(() => {
  if (lastUsage && !lastUsage.error) renderUsage();
}, 30000);

onLangChange(renderUsage);
