// ============================================================================
// LunaCore - Context Window bar (transcript JSONL)
// ----------------------------------------------------------------------------
// Owns the fill bar, the percentage, the model badge (B3) and the session
// cost/time line (B4). Everything here is driven by metrics the observer reads
// off the transcript file - PASSIVE OBSERVER, zero extra tokens.
// ============================================================================

'use strict';

import { t } from './util.js';
import { onActiveContext, onBackgroundContext, onLangChange, registerSessionView } from './bus.js';

// Bar colour thresholds: < 60% green, 60-85% amber, > 85% red + alarm.
export const CTX_WARN_HIGH = 0.85;
export const CTX_WARN_MID = 0.6;

const ctxFill = document.getElementById('ctx-fill');
const ctxPercent = document.getElementById('ctx-percent');
const ctxWarn = document.getElementById('ctx-warn');
const ctxTokens = document.getElementById('ctx-tokens');
const ctxModel = document.getElementById('ctx-model');
const ctxCost = document.getElementById('ctx-cost');

// Last metrics kept so a language switch can re-render the text.
let lastCtxMetrics = null;

/**
 * Paints the context bar.
 * `live` marks a fresh metric; a plain tab switch only restores the view, so it
 * passes false and nothing downstream may fire off the back of it.
 */
export function applyCtxMetrics(metrics, live = true) {
  if (!metrics || typeof metrics.percent !== 'number') return;
  lastCtxMetrics = metrics;
  const pct = Math.max(0, Math.min(1, metrics.percent));

  // Bar: scaleX 0..1 (no layout thrash) + colour by threshold.
  ctxFill.style.setProperty('--ctx', pct.toFixed(3));
  ctxFill.classList.toggle('is-mid', pct >= CTX_WARN_MID && pct < CTX_WARN_HIGH);
  ctxFill.classList.toggle('is-high', pct >= CTX_WARN_HIGH);

  ctxPercent.textContent = `${Math.round(pct * 100)}%`;
  renderModelBadge(metrics);
  renderCostLine(metrics);
  renderCtxText();
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
  if (!ctxModel) return;
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
  if (!ctxCost) return;
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
  ctxFill.style.setProperty('--ctx', '0');
  ctxFill.classList.remove('is-mid', 'is-high');
  ctxPercent.textContent = '0%';
  ctxWarn.textContent = '';
  ctxTokens.textContent = '';
  renderModelBadge(null);
  renderCostLine(null);
}

/** The two text lines under the bar (warning + token counts) - i18n-aware. */
function renderCtxText() {
  if (!lastCtxMetrics) return;
  const pct = Math.max(0, Math.min(1, lastCtxMetrics.percent));
  ctxWarn.textContent = pct >= CTX_WARN_HIGH ? t('ctx.warn.compact') : '';
  const k = (n) => `${Math.round(n / 1000)}k`;
  ctxTokens.textContent = t('ctx.tokens', {
    used: k(lastCtxMetrics.tokens),
    limit: k(lastCtxMetrics.limit),
  });
}

onActiveContext((metrics) => applyCtxMetrics(metrics, true));

// A background tab keeps its latest metrics on its own bucket, so switching to
// it shows ITS numbers rather than somebody else's.
onBackgroundContext((bucket, metrics) => {
  bucket.lastCtx = metrics;
});

onLangChange(renderCtxText);

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
