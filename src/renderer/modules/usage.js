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
//
// ONE PROVIDER AT A TIME: the tile shows only the limits of the profile the
// active terminal tab runs - Claude's rows on a Claude tab, that provider's
// block on a Codex / GLM / ... tab, never both. See selectVisibleUsage().
//
// SEVERAL CLAUDE ACCOUNTS (docs/CLAUDE_ACCOUNTS_PLAN.md Phase 2): with
// accounts set up in Settings the watcher's payload carries `accounts` -
// groups per window (5-hour, Weekly), one row per account, the active one
// first and dotted. Claude's rows then render from it; `accounts: null` (no
// accounts, no reading yet) keeps the meter exactly as before. A payload
// without the field (the refresh button's direct read) keeps the last view.
// ============================================================================

'use strict';

import { t, loc } from './util.js';
import { onLangChange, onUsageUpdate, onActiveProfile } from './bus.js';
import { defineWidget } from './registry.js';

/** How often the "resets in ..." labels are recomputed (locally, no request). */
const COUNTDOWN_MS = 30000;

/** How often the "updated Xs ago" label ticks (locally, no request). */
const FRESHNESS_MS = 1000;

// Elements of the current mount, or null when this widget is not on screen.
let els = null;
let lastGoodUsage = null; // last payload WITH status==='ok' - what the bars render from
let lastError = null; // status value of most recent error/unconfigured payload
// Other configured providers (src/providerusage.js). Only the watcher's
// payload carries them; a refresh-button read without the field keeps these.
let lastOthers = [];
// Profile id of the active terminal tab (bus replay), null with no tab.
let activeProfileId = null;
// The per-account view (Phase 2), null when there is none - see accountViewOf().
let lastAccounts = null;

const isRecord = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

/**
 * The per-account view to keep after a payload: the payload's own when it
 * carries the field (null = no accounts -> the meter as before), the
 * previous one when it does not. A malformed view counts as none.
 * @param {object|null} usage
 * @param {object|null} previous
 */
export function accountViewOf(usage, previous) {
  if (!isRecord(usage) || !Object.prototype.hasOwnProperty.call(usage, 'accounts')) return previous;
  const view = usage.accounts;
  if (!isRecord(view) || !Array.isArray(view.groups)) return null;
  const groups = view.groups.filter((g) => isRecord(g) && typeof g.window === 'string' && Array.isArray(g.rows));
  return groups.length ? { ...view, groups } : null;
}

/**
 * What a screen reader hears for one account row's bar:
 * "34%, resets in 2h 10m" / "100%, limit reached, resets in 1h 5m".
 */
export function accountMeterText(row, when, translate = t) {
  if (typeof row.pct !== 'number') return translate('usage.accounts.noData');
  const parts = [`${row.pct}%`];
  if (row.limited) parts.push(translate('usage.accounts.limited'));
  if (when) parts.push(translate('usage.resetIn', { when }));
  return parts.join(', ');
}

/**
 * Which provider's limits the tile shows for the active tab. `others` only
 * holds NON-Claude profiles (src/providerusage.js skips Claude, local models
 * and command-less profiles), so a profile found there gets its own block and
 * everything else - a Claude tab, no tab yet, a profile we hold no reading
 * for - falls back to Claude's rows, which is what the tile showed first
 * before it was split per provider. Never returns both.
 * @param {Array<object>} others the payload's `others` list
 * @param {string|null} profileId the active tab's profile
 * @returns {{provider: 'claude', entry: null} | {provider: 'other', entry: object}}
 */
export function selectVisibleUsage(others, profileId) {
  const entry = profileId && Array.isArray(others)
    ? others.find((o) => o && typeof o === 'object' && o.profileId === profileId)
    : null;
  return entry ? { provider: 'other', entry } : { provider: 'claude', entry: null };
}

/** Applies a fresh payload to module state. Pure state update, no render. */
function applyUsage(usage) {
  if (usage && Array.isArray(usage.others)) lastOthers = usage.others;
  lastAccounts = accountViewOf(usage, lastAccounts);
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

/** i18n keys for the windows every provider shares; others keep their label. */
const WINDOW_LABEL_KEYS = {
  '5h': 'usage.window.5h',
  daily: 'usage.window.day',
  weekly: 'usage.window.week',
  monthly: 'usage.window.month',
};

/**
 * The row label: the localized window name when the provider's label is the
 * generic English one, otherwise the provider's own (a model name, "MCP").
 */
export function limitLabel(limit, translate = t) {
  const generic = ['5-hour window', 'Daily limit', 'Weekly limit', 'Monthly limit'];
  const key = WINDOW_LABEL_KEYS[limit && limit.window];
  if (key && (!limit.label || generic.includes(limit.label))) return translate(key);
  return (limit && limit.label) || translate('usage.window.custom');
}

/** A value-only row (prepaid balance, credits) - no bar, no reset. */
function usageValueRow(limit) {
  const row = document.createElement('div');
  row.className = 'usage-row';
  const head = document.createElement('div');
  head.className = 'usage-row__head';
  const label = document.createElement('span');
  label.className = 'usage-row__label';
  label.textContent = limitLabel(limit);
  const value = document.createElement('span');
  value.className = 'usage-row__pct';
  value.textContent = limit.valueText;
  head.append(label, value);
  row.append(head);
  return row;
}

/** One non-Claude provider: a heading, then its rows or "not available". */
function usageProviderBlock(entry) {
  const block = document.createElement('div');
  block.className = 'usage-provider';
  const title = document.createElement('div');
  title.className = 'usage-provider__title';
  title.textContent = loc(entry.displayName) || entry.profileId || '';
  block.appendChild(title);
  const rows = (entry.status === 'ok' ? entry.limits || [] : []).map((limit) => {
    if (typeof limit.percentUsed === 'number') return usageRowForLimit(limit);
    if (typeof limit.valueText === 'string') return usageValueRow(limit);
    return null;
  }).filter(Boolean);
  if (rows.length > 0) {
    block.append(...rows);
  } else {
    const key = entry.status === 'unconfigured' ? 'usage.other.unconfigured'
      : entry.status === 'error' ? 'usage.unavailable'
        : 'usage.other.notAvailable';
    const msg = usageMessage(key);
    if (entry.errorMessage) msg.title = entry.errorMessage;
    block.appendChild(msg);
  }
  return block;
}

/** A usage bar filled to `pct` (0..100); colour: >=90 bad, >=70 warn, else good. */
function usageBar(pct) {
  const bar = document.createElement('div');
  bar.className = 'usage-bar';
  const fill = document.createElement('div');
  fill.className = 'usage-bar__fill';
  fill.style.setProperty('--usage', String(pct / 100));
  fill.dataset.level = pct >= 90 ? 'bad' : pct >= 70 ? 'warn' : 'good';
  bar.appendChild(fill);
  return bar;
}

function span(className, text) {
  const el = document.createElement('span');
  el.className = className;
  el.textContent = text;
  return el;
}

/**
 * One account in a window group: dot (active), name, bar, %, reset. The
 * reset sits in a fixed, dim right column and turns full colour (plus
 * "limit reached" for screen readers) when this account is the limited one.
 */
function accountUsageRow(row) {
  const el = document.createElement('div');
  el.className = 'usage-acct';
  el.classList.toggle('is-active', row.active === true);
  el.classList.toggle('is-limited', row.limited === true);
  const hasPct = typeof row.pct === 'number';
  el.classList.toggle('is-empty', !hasPct);
  const when = fmtResetWhen(typeof row.resetsAt === 'string' ? row.resetsAt : null);

  const dot = span('usage-acct__dot', '');
  dot.setAttribute('aria-hidden', 'true');
  const label = String(row.label || '');
  const name = span('usage-acct__name', label);
  name.title = row.active ? `${label} - ${t('usage.accounts.active')}` : label;

  const bar = usageBar(hasPct ? row.pct : 0);
  bar.classList.add('usage-acct__bar');
  bar.setAttribute('role', 'meter');
  bar.setAttribute('aria-valuemin', '0');
  bar.setAttribute('aria-valuemax', '100');
  bar.setAttribute('aria-valuenow', String(hasPct ? row.pct : 0));
  bar.setAttribute('aria-label', row.active ? `${label} (${t('usage.accounts.active')})` : label);
  bar.setAttribute('aria-valuetext', accountMeterText(row, when));

  const pct = span('usage-acct__pct', hasPct ? `${row.pct}%` : '-');
  const reset = span('usage-acct__reset', when || '');
  if (row.limited) reset.title = t('usage.accounts.limited');
  el.append(dot, name, bar, pct, reset);
  return el;
}

/** Every window group of the per-account view. */
function accountGroups(view) {
  const wrap = document.createElement('div');
  wrap.className = 'usage-accounts';
  for (const group of view.groups) {
    const block = document.createElement('div');
    block.className = 'usage-acct-group';
    const title = document.createElement('div');
    title.className = 'usage-acct-group__title';
    title.textContent = limitLabel({ window: group.window });
    block.setAttribute('role', 'group');
    block.setAttribute('aria-label', title.textContent);
    block.append(title, ...group.rows.filter(isRecord).map(accountUsageRow));
    wrap.appendChild(block);
  }
  return wrap;
}

/** Builds one usage row from a limit object in the new format. */
function usageRowForLimit(limit) {
  const row = document.createElement('div');
  row.className = 'usage-row';

  const head = document.createElement('div');
  head.className = 'usage-row__head';
  const label = document.createElement('span');
  label.className = 'usage-row__label';
  label.textContent = limitLabel(limit);
  const pct = document.createElement('span');
  pct.className = 'usage-row__pct';
  pct.textContent = `${limit.percentUsed}%`;
  head.append(label, pct);

  const bar = usageBar(limit.percentUsed);

  const reset = document.createElement('div');
  reset.className = 'usage-row__reset hint';
  // Only a real resetsAt from the provider is trustworthy. A "now + window"
  // fallback restarts on every repaint and pins the label at the full window.
  const when = fmtResetWhen(typeof limit.resetsAt === 'string' ? limit.resetsAt : null);
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
  const { entry } = selectVisibleUsage(lastOthers, activeProfileId);
  const source = entry || lastAccounts || lastGoodUsage;
  const when = source ? fmtAgo(source.updatedAt) : null;
  els.updated.textContent = when ? t('usage.updatedAgo', { when }) : '';
}

/** Renders the tile from the current state: the active tab's provider only. */
function renderUsage() {
  if (!els) return; // not mounted - state is kept, the DOM is not ours
  const usageBody = els.body;
  usageBody.innerHTML = '';
  const { entry } = selectVisibleUsage(lastOthers, activeProfileId);
  if (entry) usageBody.appendChild(usageProviderBlock(entry));
  else if (lastAccounts) usageBody.appendChild(accountGroups(lastAccounts));
  else renderClaudeRows(usageBody);
  renderFreshness();
}

/** Claude's rows. Error states become a message. */
function renderClaudeRows(usageBody) {
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
    return;
  }

  if (lastError === 'unconfigured' || lastError === 'unsupported') {
    // Persistent states - not a blip the 15 s heartbeat will fix
    usageBody.appendChild(
      usageMessage(lastError === 'unconfigured' ? 'usage.unconfigured' : 'usage.unsupported')
    );
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
    return;
  }

  // Show fallback indicator if applicable
  if (u.isFallback) {
    usageBody.appendChild(usageMessage('usage.fallback'));
  }
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

    // Replays, so the first paint already knows the active tab's profile.
    const offProfile = onActiveProfile((profileId) => {
      activeProfileId = profileId || null;
      renderUsage();
    });

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
      if (lastGoodUsage || lastAccounts || lastOthers.length > 0) renderUsage();
    }, COUNTDOWN_MS);

    // Tick the "updated Xs ago" label every second - a plain textContent
    // write, not a body rebuild, so it can't cause the flicker a full
    // renderUsage() on the same cadence would.
    const freshness = setInterval(renderFreshness, FRESHNESS_MS);

    renderUsage();

    return () => {
      offUsage();
      offLang();
      offProfile();
      clearInterval(countdown);
      clearInterval(freshness);
      els = null;
    };
  },
});
