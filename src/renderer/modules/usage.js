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
// leaves the "updated Xs ago" tooltip to grow instead of resetting - see
// renderFreshness(). Only 'reauth' (no valid token) and 'off' (feature
// disabled) still take over the whole tile, because those are real, lasting
// states the next 15 s heartbeat (src/usage.js UsageWatcher) can't fix on
// its own - the user has to do something (run `claude`, flip the flag).
//
// SEVERAL CLAUDE ACCOUNTS: once an account in Settings has a usage login,
// the Claude view becomes one compact grid grouped by window: the window
// label once per group, then one line per account (dot on the one new work
// runs on, name, bar, percent, reset), plus one muted line per account that
// needs attention. See visibleAccounts() / groupUsageRows() / usageGrid().
//
// ONE PROVIDER AT A TIME: the tile shows only the limits of the profile the
// active terminal tab runs - Claude's rows on a Claude tab, that provider's
// block on a Codex / GLM / ... tab, never both. See selectVisibleUsage().
// ============================================================================

'use strict';

import { t, loc } from './util.js';
import { onLangChange, onUsageUpdate, onActiveProfile } from './bus.js';
import { defineWidget } from './registry.js';

/** How often the "resets in ..." labels are recomputed (locally, no request). */
const COUNTDOWN_MS = 30000;

/** How often the "updated Xs ago" tooltip ticks (locally, no request). */
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
// One entry per stored Claude account (src/claudeaccountusage.js). Like
// `others`, only the watcher's payload carries it; a payload without the
// field keeps the last list.
let lastAccounts = [];

/**
 * The accounts the tile draws: all of them once at least one has a usage
 * login, none while nothing is connected (the tile then shows the single
 * ~/.claude read exactly as before).
 * @param {Array<object>} accounts the payload's `accounts` list
 * @returns {Array<object>}
 */
export function visibleAccounts(accounts) {
  const list = Array.isArray(accounts) ? accounts.filter((a) => a && typeof a === 'object') : [];
  return list.some((a) => a.status !== 'unconnected') ? list : [];
}

/**
 * The message an account shows instead of (or under) its bars, or null when
 * the bars say it all. Stale bars stay on a transient error.
 * @param {{status?: string, main?: boolean, limits?: Array<object>}} account
 * @returns {string|null} i18n key
 */
export function accountMessageKey(account) {
  const status = account && account.status;
  const hasBars = Boolean(account && Array.isArray(account.limits) && account.limits.length > 0);
  if (status === 'reconnect') return account.main ? 'usage.account.reconnectMain' : 'usage.account.reconnect';
  if (status === 'unconnected') return 'usage.account.unconnected';
  if (hasBars) return null;
  return status === 'error' ? 'usage.unavailable' : 'usage.loading';
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
  if (usage && Array.isArray(usage.accounts)) lastAccounts = usage.accounts;
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

/** Short forms of the same windows, for the tile's narrow left column. */
const WINDOW_SHORT_KEYS = {
  '5h': 'usage.window.short.5h',
  daily: 'usage.window.short.day',
  weekly: 'usage.window.short.week',
  monthly: 'usage.window.short.month',
};

/** Group order: shortest window first; anything else follows in arrival order. */
const WINDOW_ORDER = ['5h', 'daily', 'weekly', 'monthly'];

/** Provider labels that just restate the window, so ours may replace them. */
const GENERIC_LABELS = ['5-hour window', 'Daily limit', 'Weekly limit', 'Monthly limit'];

/** One-line forms of the messages accountMessageKey() picks. */
const SHORT_MESSAGE_KEYS = {
  'usage.account.reconnect': 'usage.account.short.reconnect',
  'usage.account.reconnectMain': 'usage.account.short.reconnectMain',
  'usage.account.unconnected': 'usage.account.short.unconnected',
  'usage.unavailable': 'usage.account.short.unavailable',
  'usage.loading': 'usage.account.short.loading',
};

/** Settings anchor the muted row's arrow opens (index.html, Claude accounts). */
const ACCOUNTS_SETTINGS_ANCHOR = 'claude-accounts-section';

function hasGenericLabel(limit) {
  return Boolean(WINDOW_LABEL_KEYS[limit && limit.window]) && (!limit.label || GENERIC_LABELS.includes(limit.label));
}

/**
 * The row label: the localized window name when the provider's label is the
 * generic English one, otherwise the provider's own (a model name, "MCP").
 */
export function limitLabel(limit, translate = t) {
  if (hasGenericLabel(limit)) return translate(WINDOW_LABEL_KEYS[limit.window]);
  return (limit && limit.label) || translate('usage.window.custom');
}

/** The left-column label: "5h" / "wk" for shared windows, else limitLabel(). */
export function windowShortLabel(limit, translate = t) {
  if (hasGenericLabel(limit)) return translate(WINDOW_SHORT_KEYS[limit.window]);
  return limitLabel(limit, translate);
}

/** The one-line key for a message key from accountMessageKey(). */
export function shortMessageKey(key) {
  return SHORT_MESSAGE_KEYS[key] || key;
}

/** Bar level by percent: neutral < 70, warn >= 70, bad >= 90. */
export function usageLevel(percent) {
  return percent >= 90 ? 'bad' : percent >= 70 ? 'warn' : 'good';
}

/** Rows with the same key share a group: the window, or window + label for custom ones. */
function groupKey(limit) {
  return hasGenericLabel(limit) ? limit.window : `${limit.window || 'custom'}:${limit.label || ''}`;
}

/**
 * The spent weekly limit that makes a 5 h reading moot, or null. With the
 * week at 100% the 5 h room can't be used, so the tile dims that row.
 * @param {object} limit the row's limit
 * @param {Array<object>} siblings every limit of the same account / source
 * @returns {object|null} the weekly limit doing the blocking
 */
export function blockingWeekly(limit, siblings) {
  if (!limit || limit.window !== '5h' || !Array.isArray(siblings)) return null;
  return siblings.find((l) => l && l.window === 'weekly' && hasGenericLabel(l)
    && typeof l.percentUsed === 'number' && l.percentUsed >= 100) || null;
}

function isDrawable(limit) {
  return Boolean(limit) && (typeof limit.percentUsed === 'number' || typeof limit.valueText === 'string');
}

/**
 * Regroups per-account limits into per-window groups: 5 h first, then daily,
 * weekly, monthly, then any other window in arrival order. Inside a group the
 * rows keep the account order. Accounts that have a message to show (see
 * accountMessageKey) land in `notices`, once each, whether or not they also
 * still have (stale) bars.
 * @param {Array<{account?: object|null, limits?: Array<object>}>} sources
 * Each row carries `blockedBy`: the spent weekly limit that makes a 5 h row
 * moot (see blockingWeekly), or null.
 * @returns {{groups: Array<{key: string, rows: Array<{account: object|null, limit: object, blockedBy: object|null}>}>,
 *   notices: Array<{account: object, key: string}>}}
 */
export function groupUsageRows(sources) {
  const byKey = new Map();
  const notices = [];
  for (const source of Array.isArray(sources) ? sources : []) {
    if (!source || typeof source !== 'object') continue;
    const account = source.account || null;
    const limits = Array.isArray(source.limits) ? source.limits : [];
    for (const limit of limits) {
      if (!isDrawable(limit)) continue;
      const key = groupKey(limit);
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push({ account, limit, blockedBy: blockingWeekly(limit, limits) });
    }
    const message = account ? accountMessageKey(account) : null;
    if (message) notices.push({ account, key: message });
  }
  const rank = (key) => {
    const i = WINDOW_ORDER.indexOf(key);
    return i === -1 ? WINDOW_ORDER.length : i;
  };
  const groups = [...byKey.keys()]
    .map((key, arrival) => ({ key, arrival }))
    .sort((a, b) => rank(a.key) - rank(b.key) || a.arrival - b.arrival)
    .map(({ key }) => ({ key, rows: byKey.get(key) }));
  return { groups, notices };
}

function span(className, text) {
  const el = document.createElement('span');
  el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

/** The marker + name cells of an account row (multi-account grid only). */
function accountCells(account) {
  const isActive = Boolean(account && account.active);
  const mark = span('usage-line__mark', isActive ? '●' : '');
  if (isActive) {
    mark.setAttribute('role', 'img');
    mark.setAttribute('aria-label', t('usage.account.active'));
  } else {
    mark.setAttribute('aria-hidden', 'true');
  }
  const label = (account && account.label) || '';
  const name = span('usage-line__name', label);
  name.title = label;
  return [mark, name];
}

/** The bar, percent and reset cells of one limit (or one value cell). */
function limitCells(limit) {
  if (typeof limit.percentUsed !== 'number') {
    return [span('usage-line__value', limit.valueText)];
  }
  const bar = document.createElement('div');
  bar.className = 'usage-bar';
  const fill = document.createElement('div');
  fill.className = 'usage-bar__fill';
  fill.style.setProperty('--usage', String(Math.min(100, Math.max(0, limit.percentUsed)) / 100));
  fill.dataset.level = usageLevel(limit.percentUsed);
  bar.appendChild(fill);
  const pct = span('usage-line__pct', `${limit.percentUsed}%`);
  // Only a real resetsAt from the provider is trustworthy. A "now + window"
  // fallback restarts on every repaint and pins the label at the full window.
  const when = fmtResetWhen(typeof limit.resetsAt === 'string' ? limit.resetsAt : null);
  const reset = span('usage-line__reset', when || t('usage.resetNow'));
  reset.title = when ? t('usage.resetIn', { when }) : t('usage.resetting');
  return [bar, pct, reset];
}

/** One grid row. `win` is the window label, or null on a group's later rows. */
function usageLine({ win, account, withAccount, cells }) {
  const line = document.createElement('div');
  line.className = 'usage-line';
  const winCell = span('usage-line__win', win ? win.short : '');
  if (win) {
    line.classList.add('is-group-start');
    winCell.title = win.full;
  }
  line.appendChild(winCell);
  if (withAccount) line.append(...accountCells(account));
  line.classList.toggle('is-active', Boolean(account && account.active));
  line.append(...cells);
  return line;
}

/** Dims a 5 h line whose week is spent; the tooltip says why and until when. */
function markBlocked(line, weekly) {
  line.classList.add('is-blocked');
  const when = fmtResetWhen(typeof weekly.resetsAt === 'string' ? weekly.resetsAt : null);
  line.title = t('usage.blockedByWeekly', { when: when || t('usage.resetNow') });
  // The cell tooltips (reset time, account name) would hide the line's one.
  // The window label keeps its own: it names the group, not this account.
  for (const cell of line.querySelectorAll(':not(.usage-line__win)[title]')) cell.removeAttribute('title');
}

/** The muted one-line stand-in for an account's bars, with a Settings arrow. */
function noticeCells({ account, key }) {
  const msg = span('usage-line__msg', t(shortMessageKey(key)));
  msg.title = t(key);
  if (key === 'usage.loading') return [msg];
  const link = document.createElement('button');
  link.type = 'button';
  link.className = 'usage-line__link';
  link.textContent = '↗';
  link.title = t('usage.account.openSettings');
  link.setAttribute('aria-label', `${(account && account.label) || ''} - ${t('usage.account.openSettings')}`);
  link.addEventListener('click', () => {
    import('./termcustom.js')
      .then((m) => m.openSettingsAt(ACCOUNTS_SETTINGS_ANCHOR))
      .catch((err) => console.error('[usage] could not open Settings:', err));
  });
  return [msg, link];
}

/**
 * The compact grid: one line per (window, account), the window label only on
 * a group's first line, then one muted line per account with a message.
 * @param {Array<{account?: object|null, limits?: Array<object>}>} sources
 * @param {boolean} withAccount true for the multi-account view (marker + name columns)
 */
function usageGrid(sources, withAccount) {
  const grid = document.createElement('div');
  grid.className = withAccount ? 'usage-grid' : 'usage-grid usage-grid--solo';
  const { groups, notices } = groupUsageRows(sources);
  for (const group of groups) {
    group.rows.forEach(({ account, limit, blockedBy }, i) => {
      const win = i === 0 ? { short: windowShortLabel(limit), full: limitLabel(limit) } : null;
      const line = usageLine({ win, account, withAccount, cells: limitCells(limit) });
      if (blockedBy) markBlocked(line, blockedBy);
      grid.appendChild(line);
    });
  }
  notices.forEach((notice, i) => {
    const line = usageLine({ win: null, account: notice.account, withAccount, cells: noticeCells(notice) });
    line.classList.add('is-muted');
    if (i === 0 && groups.length > 0) line.classList.add('is-group-start');
    grid.appendChild(line);
  });
  return grid;
}

/** One non-Claude provider: a heading, then its rows or "not available". */
function usageProviderBlock(entry) {
  const block = document.createElement('div');
  block.className = 'usage-provider';
  const title = document.createElement('div');
  title.className = 'usage-provider__title';
  title.textContent = loc(entry.displayName) || entry.profileId || '';
  block.appendChild(title);
  const limits = entry.status === 'ok' ? (entry.limits || []).filter(isDrawable) : [];
  if (limits.length > 0) {
    block.appendChild(usageGrid([{ account: null, limits }], false));
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

function usageMessage(key) {
  const p = document.createElement('p');
  p.className = 'hint';
  p.textContent = t(key);
  return p;
}

/**
 * Puts "updated Xs ago" into the refresh button's tooltip. Only ever touches
 * one attribute - never rebuilds the tile - so it is safe to call every second
 * without risking the flicker a full renderUsage() would cause.
 */
function renderFreshness() {
  if (!els || !els.refresh) return;
  const { entry } = selectVisibleUsage(lastOthers, activeProfileId);
  const accountTimes = visibleAccounts(lastAccounts).map((a) => a.updatedAt).filter((v) => typeof v === 'number');
  const newestAccount = accountTimes.length > 0 ? { updatedAt: Math.max(...accountTimes) } : null;
  const source = entry || newestAccount || lastGoodUsage;
  const when = source ? fmtAgo(source.updatedAt) : null;
  const base = t('usage.refresh.title');
  els.refresh.title = when ? `${base} · ${t('usage.updatedAgo', { when })}` : base;
}

/** Renders the tile from the current state: the active tab's provider only. */
function renderUsage() {
  if (!els) return; // not mounted - state is kept, the DOM is not ours
  const usageBody = els.body;
  usageBody.innerHTML = '';
  const { entry } = selectVisibleUsage(lastOthers, activeProfileId);
  const accounts = visibleAccounts(lastAccounts);
  if (entry) usageBody.appendChild(usageProviderBlock(entry));
  else if (accounts.length > 0) usageBody.appendChild(usageGrid(accounts.map((a) => ({ account: a, limits: a.limits })), true));
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
  const limits = (u.limits || []).filter((l) => l && typeof l.percentUsed === 'number');
  if (limits.length === 0) {
    usageBody.appendChild(usageMessage('usage.unavailable'));
    return;
  }
  usageBody.appendChild(usageGrid([{ account: null, limits }], false));

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
      if (lastGoodUsage || lastOthers.length > 0 || lastAccounts.length > 0) renderUsage();
    }, COUNTDOWN_MS);

    // Tick the "updated Xs ago" tooltip every second - a plain attribute
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
