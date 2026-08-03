// ============================================================================
// LunaCore - burn-rate sparkline (context window over time)
// ----------------------------------------------------------------------------
// PASSIVE OBSERVER: the same `usage` samples that feed the Context Window bar,
// just remembered over time. You can watch the context creep towards a compact,
// plus the rate (tok/min) and the estimated time to the 85% threshold. No new
// IPC channel (it is a second subscriber on the context stream), no extra tokens.
// ============================================================================

'use strict';

import { t } from './util.js';
import {
  onActiveContext,
  onBackgroundContext,
  onSessionRestarted,
  onLangChange,
  registerSessionView,
} from './bus.js';
import { CTX_WARN_HIGH } from './thresholds.js';

export const SPARK_MAX = 80; // how many samples the chart keeps
const BURN_WINDOW_MS = 5 * 60 * 1000; // rate is measured over this window

// Elements of the current mount, or null when this half is not on screen. The
// markup belongs to the `context` widget (one panel section, two modules), so
// they arrive via mountSpark(root) rather than from document.getElementById.
let els = null;

let sparkBuf = []; // [{ t, tokens, percent, limit }]

/**
 * Appends a sample to a buffer, trimming it to SPARK_MAX. Shared by the active
 * tab and by every background tab, which keep their own buffers.
 *
 * An unchanged token count only refreshes the timestamp instead of adding a
 * point - otherwise a quiet session would fill the chart with duplicates.
 *
 * `limit` rides along because renderBurn needs it to place the 85% threshold.
 * It is refreshed on the no-change path too: B2 promotes the window mid-session
 * when observed tokens exceed it, so a sample can outlive the limit it was born
 * with.
 */
export function pushSample(buf, metrics) {
  const now = Date.now();
  const prev = buf[buf.length - 1];
  if (prev && prev.tokens === metrics.tokens) {
    prev.t = now;
    prev.limit = metrics.limit;
  } else {
    buf.push({
      t: now,
      tokens: metrics.tokens,
      percent: metrics.percent,
      limit: metrics.limit,
    });
    if (buf.length > SPARK_MAX) buf.shift();
  }
  return buf;
}

/**
 * Minutes until the 85% threshold at the current rate.
 *
 * @returns {number|null} minutes, 0 when already past the threshold, or null
 *   when it cannot be known (no limit yet, or the context is not growing).
 *
 * Exported and pure because of the bug it exists to prevent. This used to be
 * inline in renderBurn as `CTX_WARN_HIGH * last.limit`, and `limit` was never
 * put in the sample - so the product was NaN, `remaining > 0` was false, and the
 * code took the else branch and announced "in compact zone" at 6% context. A
 * wrong ETA is worse than none, which is the rule B4 already set for cost: an
 * unknown model gets no estimate at all. Hence null rather than a guess.
 */
export function etaMinutes(last, rate) {
  if (!last || typeof last.limit !== 'number' || !(last.limit > 0)) return null;
  if (typeof last.tokens !== 'number' || !(rate > 0)) return null;
  const remaining = CTX_WARN_HIGH * last.limit - last.tokens;
  if (!(remaining > 0)) return 0; // already inside the compact zone
  return remaining / rate;
}

/** Draws the line + fill in a 0..100 (x) / 0..30 (y, inverted) viewBox. */
function renderSpark() {
  if (!els) return;
  const n = sparkBuf.length;
  if (n < 2) {
    els.line.setAttribute('points', '');
    els.area.setAttribute('d', '');
    return;
  }
  // The Y scale follows the data, not a fixed 0-100%.
  //
  // On a fixed 0-100% axis a typical context increase (say 4% -> 7%) is one
  // pixel in a 30-pixel box - the chart was "correct" and useless. MIN_SPAN
  // guards the other side: without it a flat session would stretch rounding
  // noise over the full height and look like an avalanche. The absolute numbers
  // (tok/min, ETA) sit right next to it in renderBurn, so the chart is free to
  // be relative.
  const MIN_SPAN = 0.02; // 2 percentage points
  let lo = Infinity;
  let hi = -Infinity;
  for (const s of sparkBuf) {
    const p = Math.max(0, Math.min(1, s.percent));
    if (p < lo) lo = p;
    if (p > hi) hi = p;
  }
  if (hi - lo < MIN_SPAN) {
    const mid = (lo + hi) / 2;
    lo = mid - MIN_SPAN / 2;
    hi = mid + MIN_SPAN / 2;
  }
  // A little breathing room top and bottom so the line does not hug the edge.
  const pad = (hi - lo) * 0.12;
  lo -= pad;
  hi += pad;
  const range = hi - lo || 1;

  const pts = sparkBuf.map((s, i) => {
    const x = (i / (n - 1)) * 100;
    const p = Math.max(0, Math.min(1, s.percent));
    const y = Math.max(0, Math.min(30, (1 - (p - lo) / range) * 30));
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  });
  els.line.setAttribute('points', pts.join(' '));
  els.area.setAttribute('d', `M0,30 L${pts.join(' L')} L100,30 Z`);
}

/** Formats a rate: below 1k as a number, above as "1.8k". */
function fmtRate(r) {
  const a = Math.abs(r);
  return a >= 1000 ? `${(a / 1000).toFixed(1)}k` : `${Math.round(a)}`;
}

/** Computes the rate over the time window and writes the text + ETA to 85%. */
function renderBurn() {
  if (!els) return;
  const ctxBurn = els.burn;
  const n = sparkBuf.length;
  if (n < 2) {
    ctxBurn.textContent = t('burn.collecting');
    return;
  }
  const last = sparkBuf[n - 1];
  // Oldest sample still inside BURN_WINDOW_MS.
  let first = sparkBuf[0];
  for (const s of sparkBuf) {
    if (last.t - s.t <= BURN_WINDOW_MS) { first = s; break; }
  }
  const dtMin = (last.t - first.t) / 60000;
  if (dtMin <= 0) { ctxBurn.textContent = '—'; return; }

  const rate = (last.tokens - first.tokens) / dtMin; // tokens / min
  if (rate > 5) {
    const min = etaMinutes(last, rate);
    // null = the limit is not known yet: show the rate and claim nothing. The
    // old code could not express this and guessed "in compact zone" instead.
    let eta = '';
    if (min === 0) {
      eta = t('burn.eta.zone');
    } else if (min !== null) {
      eta = t('burn.eta.to85', { min: min < 1 ? '<1' : Math.round(min) });
    }
    ctxBurn.textContent = t('burn.up', { rate: fmtRate(rate), eta });
  } else if (rate < -5) {
    ctxBurn.textContent = t('burn.down', { rate: fmtRate(rate) });
  } else {
    ctxBurn.textContent = t('burn.stable');
  }
}

/**
 * Mounts this module's half of the `context` widget.
 *
 * The Context Window section is one panel block owned by two modules, and a
 * widget root can only have one mount(). context.js therefore defines the
 * widget and calls this from inside its mount(), composing the two cleanups.
 *
 * Only the DOM is mounted here: the sample buffer and every subscription below
 * stay at module scope, so the chart's history survives an unmount.
 *
 * @param {Element} root the widget root
 * @returns {() => void} disposer
 */
export function mountSpark(root) {
  els = {
    line: root.querySelector('#ctx-spark-line'),
    area: root.querySelector('#ctx-spark-area'),
    burn: root.querySelector('#ctx-burn'),
  };

  // Paint the history we already have rather than an empty chart.
  renderSpark();
  renderBurn();

  return () => {
    els = null;
  };
}

// ---- Subscriptions that maintain STATE stay at module scope -----------------
//
// NOT disposed on unmount, and deliberately unlike the ports/usage widgets.
// `activeContext` is a non-replaying channel, so a disposed subscription would
// lose samples permanently - and because renderBurn() measures a rate across a
// 5-minute window, a hole in the buffer does not just lose pixels, it makes the
// tok/min figure and the ETA wrong. The renders are no-ops while unmounted,
// which gives the same teardown guarantee without dropping data.

onActiveContext((metrics) => {
  if (!metrics || typeof metrics.tokens !== 'number') return;
  sparkBuf = pushSample(sparkBuf, metrics);
  renderSpark();
  renderBurn();
});

onBackgroundContext((bucket, metrics) => {
  bucket.sparkBuf = pushSample(bucket.sparkBuf || [], metrics);
});

// Restart = a new context: drop the history.
onSessionRestarted(() => {
  sparkBuf = [];
  renderSpark();
  renderBurn();
});

onLangChange(renderBurn);

registerSessionView({
  save(bucket) {
    bucket.sparkBuf = sparkBuf;
  },
  load(bucket) {
    sparkBuf = bucket.sparkBuf || [];
    renderSpark();
    renderBurn();
  },
  clear(bucket) {
    bucket.sparkBuf = [];
  },
});
