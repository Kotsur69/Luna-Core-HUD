// ============================================================================
// LunaCore - Context Window bar (transcript JSONL)
// ----------------------------------------------------------------------------
// Owns the fill bar, the percentage, the model badge (B3) and the session
// cost/time line (B4). Everything here is driven by metrics the observer reads
// off the transcript file - PASSIVE OBSERVER, zero extra tokens.
// ============================================================================

'use strict';

import { t, pulse } from './util.js';
import { onActiveContext, onBackgroundContext, onLangChange, registerSessionView } from './bus.js';
// Bar colour thresholds: < 60% green, 60-85% amber, > 85% red + alarm. They live
// in their own module so this one can import spark.js without forming a cycle.
import { CTX_WARN_HIGH, CTX_WARN_MID, ctxLevel } from './thresholds.js';
import { defineWidget } from './registry.js';
import { mountSpark } from './spark.js';

// Elements of the current mount, or null when this widget is not on screen.
let els = null;

// Last metrics kept so a language switch can re-render the text - and so a
// remount can repaint the real numbers instead of starting again from 0%.
let lastCtxMetrics = null;

// E3: the band the bar was in at the previous LIVE reading, so a crossing can be
// told from a steady state. null means "nothing to compare against yet" - which
// is why it is null and not 0: a session that opens at 90% must not pulse.
let lastCtxLevel = null;

/**
 * Paints the context bar.
 * `live` marks a fresh metric; a plain tab switch only restores the view, so it
 * passes false and nothing downstream may fire off the back of it.
 */
export function applyCtxMetrics(metrics, live = true) {
  if (!metrics || typeof metrics.percent !== 'number') return;
  // The metrics are remembered even while unmounted - only the painting stops.
  // That is what lets a remount show the session's real state immediately.
  lastCtxMetrics = metrics;
  if (!els) return;
  const pct = Math.max(0, Math.min(1, metrics.percent));

  // Bar: scaleX 0..1 (no layout thrash) + colour by threshold.
  els.fill.style.setProperty('--ctx', pct.toFixed(3));
  els.fill.classList.toggle('is-mid', pct >= CTX_WARN_MID && pct < CTX_WARN_HIGH);
  els.fill.classList.toggle('is-high', pct >= CTX_WARN_HIGH);

  // E3: one pulse when the bar crosses UPWARD into a worse band. The colour
  // change alone is easy to miss in peripheral vision, which is where this bar
  // lives while you are reading the terminal.
  //
  // Three conditions, each of them load-bearing:
  //   * `live` - a tab switch replays remembered metrics, and a replay is not an
  //     event. Without this, clicking between two tabs would fire alarms.
  //   * a previous level exists - the FIRST reading of a session that is already
  //     at 90% has not crossed anything; it merely arrived that way.
  //   * strictly greater - coming back down after a compact is relief, and
  //     relief does not need to grab your eye.
  const level = ctxLevel(pct);
  if (live && lastCtxLevel !== null && level > lastCtxLevel) pulse(els.fill, 'is-crossing');
  lastCtxLevel = level;

  els.percent.textContent = `${Math.round(pct * 100)}%`;
  renderModelBadge(metrics);
  renderCostLine(metrics);
  renderCopyPath(metrics);
  renderCtxText();
}

/**
 * B6: the copy-transcript-path button.
 *
 * Hidden until the observer has actually pinned a file - before that there is
 * no path to copy and a dead button would only invite a click. The path rides
 * along on the metrics, so it is per tab for free: switching tabs restores that
 * tab's metrics, and with them ITS transcript.
 */
function renderCopyPath(metrics) {
  if (!els || !els.copyPath) return;
  const ctxCopyPath = els.copyPath;
  const file = (metrics && metrics.file) || '';
  ctxCopyPath.hidden = !file;
  if (!file) {
    delete ctxCopyPath.dataset.path;
    return;
  }
  ctxCopyPath.dataset.path = file;
  // The path itself in the tooltip - often all you wanted, without pasting it
  // anywhere. Set here rather than left to data-i18n-title, so a language
  // switch (which re-runs applyStatic) does not drop it: renderCtxText's
  // subscriber re-renders this too.
  ctxCopyPath.title = `${t('ctx.copyPath.title')}\n${file}`;
}

/** Formats a context window as "200k" / "1M". */
function formatLimit(limit) {
  if (!limit || typeof limit !== 'number') return '';
  return limit >= 1000000 ? `${limit / 1000000}M` : `${Math.round(limit / 1000)}k`;
}

/**
 * Model badge (B3) together with the detected context window (B2).
 * The window is shown DELIBERATELY: now that the limit is no longer a constant,
 * without this text a 200k -> 1M promotion would be invisible and impossible to
 * verify by eye. No model (fresh session, local backend with no model field)
 * hides the badge rather than showing an empty pill.
 */
function renderModelBadge(metrics) {
  if (!els || !els.model) return;
  const ctxModel = els.model;
  const label = (metrics && metrics.modelLabel) || '';
  if (!label) {
    ctxModel.hidden = true;
    ctxModel.textContent = '';
    ctxModel.removeAttribute('title');
    return;
  }
  const limit = formatLimit(metrics.limit);
  ctxModel.textContent = limit ? `${label} · ${limit}` : label;
  // Full model id in the tooltip - the label is shortened, the original is
  // sometimes what you need.
  ctxModel.title = metrics.model || label;
  ctxModel.hidden = false;
}

/** Formats elapsed milliseconds as a compact "2h 14m" / "5m 3s" / "12s". */
function formatElapsed(ms) {
  if (typeof ms !== 'number' || !isFinite(ms) || ms <= 0) return '';
  const total = Math.floor(ms / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

/**
 * Formats a USD amount, widening precision for small numbers.
 *
 * NOTE: this mirrors formatUsd() in src/rates.js on purpose. The renderer runs
 * with contextIsolation, so it cannot require a main-process module; sending a
 * pre-formatted string over IPC instead would put presentation in the main
 * process. Small, deliberate duplication - keep the two in sync if either changes.
 */
function formatUsd(usd) {
  if (typeof usd !== 'number' || !isFinite(usd) || usd < 0) return '';
  if (usd === 0) return '$0.00';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}

/**
 * Session cost / time line (B4).
 *
 * The amount is always prefixed with "~" and never shown for a model missing
 * from config/rates.json - an unknown backend gets no number at all rather than
 * a confident-looking wrong one. Elapsed time alone still renders, since that
 * part is true regardless of whether we can price the session.
 */
function renderCostLine(metrics) {
  if (!els || !els.cost) return;
  const ctxCost = els.cost;
  const parts = [];
  const elapsed = formatElapsed(metrics && metrics.elapsedMs);
  if (elapsed) parts.push(elapsed);
  const usd = metrics && metrics.cost ? formatUsd(metrics.cost.usd) : '';
  if (usd) parts.push(`~${usd}`);

  if (parts.length === 0) {
    ctxCost.hidden = true;
    ctxCost.textContent = '';
    ctxCost.removeAttribute('title');
    return;
  }
  ctxCost.textContent = parts.join(' · ');
  ctxCost.title = usd
    ? 'Estimated spend for this session, from transcript token counts and config/rates.json. Prices go stale - verify before trusting.'
    : 'Elapsed session time. No price estimate: this model is not in config/rates.json.';
  ctxCost.hidden = false;
}

/** Clears the bar when a tab has no metrics yet. */
export function resetCtxUI() {
  lastCtxMetrics = null;
  // A restarted session starts a new history. Keeping the old band would make
  // the first reading of the new one look like a crossing.
  lastCtxLevel = null;
  if (!els) return;
  els.fill.style.setProperty('--ctx', '0');
  els.fill.classList.remove('is-mid', 'is-high', 'is-crossing');
  els.percent.textContent = '0%';
  els.warn.textContent = '';
  els.tokens.textContent = '';
  renderModelBadge(null);
  renderCostLine(null);
  renderCopyPath(null);
}

/** The two text lines under the bar (warning + token counts) - i18n-aware. */
function renderCtxText() {
  if (!els || !lastCtxMetrics) return;
  const pct = Math.max(0, Math.min(1, lastCtxMetrics.percent));
  els.warn.textContent = pct >= CTX_WARN_HIGH ? t('ctx.warn.compact') : '';
  const k = (n) => `${Math.round(n / 1000)}k`;
  els.tokens.textContent = t('ctx.tokens', {
    used: k(lastCtxMetrics.tokens),
    limit: k(lastCtxMetrics.limit),
  });
}

// ---- Subscriptions that maintain STATE stay at module scope ----------------
//
// Deliberately not disposed on unmount, unlike the ports/usage widgets. Those
// listen to REPLAYING bus channels, so a remount recovers the last payload;
// `activeContext` does not replay (bus.js), so disposing it here would drop
// samples for good. The renders above are already no-ops while unmounted, which
// gets the same teardown guarantee without losing the data.

onActiveContext((metrics) => applyCtxMetrics(metrics, true));

// A background tab keeps its latest metrics on its own bucket, so switching to
// it shows ITS numbers rather than somebody else's.
onBackgroundContext((bucket, metrics) => {
  bucket.lastCtx = metrics;
});

// ---- The widget -------------------------------------------------------------
//
// First widget whose markup is owned by TWO modules: the bar, badge, cost line
// and copy-path button here, the sparkline and burn text in spark.js. One root
// can only have one mount(), so this one mounts spark's half too and hands back
// a cleanup that undoes both. spark.js keeps its own state and subscriptions -
// only its DOM is mounted from here.

defineWidget({
  id: 'context',
  titleKey: 'ctxwin.title',
  template: 'w-context',
  mount(root) {
    els = {
      fill: root.querySelector('#ctx-fill'),
      percent: root.querySelector('#ctx-percent'),
      warn: root.querySelector('#ctx-warn'),
      tokens: root.querySelector('#ctx-tokens'),
      model: root.querySelector('#ctx-model'),
      cost: root.querySelector('#ctx-cost'),
      copyPath: root.querySelector('#ctx-copy-path'),
    };

    const offSpark = mountSpark(root);

    // Copy the pinned transcript path (B6). Bound inside root, so the host
    // removes it with the subtree - no disposer needed.
    els.copyPath.addEventListener('click', () => {
      const file = els.copyPath.dataset.path;
      if (!file) return;
      navigator.clipboard.writeText(file).catch(() => {});
      pulse(els.copyPath);
    });

    const offLang = onLangChange(() => {
      renderCtxText();
      renderCopyPath(lastCtxMetrics); // applyStatic just reset this button's title
    });

    // Repaint from what the session is actually at, not from zero.
    if (lastCtxMetrics) applyCtxMetrics(lastCtxMetrics, false);
    else resetCtxUI();

    return () => {
      offSpark();
      offLang();
      els = null;
    };
  },
});

registerSessionView({
  save(bucket) {
    bucket.lastCtx = lastCtxMetrics;
  },
  load(bucket) {
    if (bucket.lastCtx) applyCtxMetrics(bucket.lastCtx, false);
    else resetCtxUI();
  },
  clear(bucket) {
    bucket.lastCtx = null;
  },
});
