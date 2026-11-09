// ============================================================================
// LunaCore - God Mode board: hybrid runs and the free-branch review
// ----------------------------------------------------------------------------
//  - hybridLines(): what a hybrid run's free package is doing (src/
//    orchestraHybrid.js packageView) - running free, under the Claude
//    review, waiting on a limit, the review verdict and every hand-over to
//    Sonnet with its reason.
//  - freeReviewLine(): the opt-in F5 review of a free run's luna-free/*
//    branches (src/orchestraFreeReview.js) - running, waiting, done, failed.
// Pure: returns text + tone; the caller puts it in through textContent only.
// ============================================================================

'use strict';

import { t } from './util.js';

const HAND_OVER_KINDS = new Set(['reviewFail', 'twoStalls', 'freeWait']);
const REVIEW_RESULTS = new Set(['pass', 'fail', 'error']);
const MAX_REASONS_SHOWN = 3;

const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const clock = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const textList = (v) => (Array.isArray(v) ? v.filter((s) => typeof s === 'string' && s) : []);

function reviewLine(review) {
  if (!isObject(review) || !REVIEW_RESULTS.has(review.result)) return null;
  const reasons = textList(review.reasons).slice(0, MAX_REASONS_SHOWN).join('; ');
  if (review.result === 'pass') return { text: t('orch.hybrid.reviewPass'), cls: '' };
  if (review.result === 'error') return { text: t('orch.hybrid.reviewError', { error: review.error || '-' }), cls: 'is-bad' };
  return { text: t('orch.hybrid.reviewFail', { reasons: reasons || '-' }), cls: 'is-bad' };
}

/**
 * The hybrid lines of one package card; [] outside a hybrid run.
 * @param {{hybrid?:object|null}} pkg
 * @returns {Array<{text:string, cls:string}>}
 */
export function hybridLines(pkg) {
  const h = pkg && isObject(pkg.hybrid) ? pkg.hybrid : null;
  if (!h) return [];
  const out = [];
  if (h.runsFree === true) out.push({ text: t('orch.hybrid.free'), cls: '' });
  if (h.reviewing === true) out.push({ text: t('orch.hybrid.reviewing'), cls: '' });
  if (isObject(h.reviewWait) && Number.isFinite(h.reviewWait.until)) {
    out.push({ text: t('orch.hybrid.reviewWait', { time: clock(h.reviewWait.until) }), cls: 'is-warn' });
  }
  if (isObject(h.freeWait) && Number.isFinite(h.freeWait.until)) {
    out.push({ text: t('orch.hybrid.freeWait', { time: clock(h.freeWait.until) }), cls: 'is-warn' });
  }
  const review = reviewLine(h.review);
  if (review) out.push(review);
  for (const hand of Array.isArray(h.handOvers) ? h.handOvers : []) {
    if (!isObject(hand) || !HAND_OVER_KINDS.has(hand.kind)) continue;
    out.push({ text: t('orch.hybrid.handedOver', { why: t(`orch.hybrid.h.${hand.kind}`) }), cls: 'is-warn' });
  }
  return out;
}

/**
 * The F5 review status under its checkbox, or null before it ran.
 * @param {{freeReview?:object|null}} plan
 * @returns {{text:string, cls:string}|null}
 */
export function freeReviewLine(plan) {
  const r = plan && isObject(plan.freeReview) ? plan.freeReview : null;
  if (!r) return null;
  const n = Number.isInteger(r.total) ? r.total : 0;
  const done = Number.isInteger(r.done) ? r.done : 0;
  if (r.state === 'running') return { text: t('orch.freeReview.running', { done, n }), cls: '' };
  if (r.state === 'waiting') {
    const time = Number.isFinite(r.resumeAt) ? clock(r.resumeAt) : '-';
    return { text: t('orch.freeReview.waiting', { time }), cls: 'is-warn' };
  }
  if (r.state === 'done') {
    const files = textList(r.files).join(', ');
    return { text: t('orch.freeReview.done', { files: files || '-' }), cls: r.error ? 'is-warn' : '' };
  }
  if (r.state === 'failed') return { text: t('orch.freeReview.failed', { error: r.error || '-' }), cls: 'is-bad' };
  return null;
}
