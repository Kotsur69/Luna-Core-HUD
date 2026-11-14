// ============================================================================
// LunaCore - God Mode predictive context routing (opt-in: plan option `contextGuard`)
// ----------------------------------------------------------------------------
// Each worker tab's transcript watcher reports how full its context is
// (tokens / limit, src/observer.js; the HUD's burn-rate sparkline reads the
// same numbers). From the recent samples predictContext() estimates when the
// context fills up. A worker predicted to fill within CONTEXT_HORIZON_MS gets
// `/compact` typed into its session - at most once per context window (a
// drop in tokens starts a new window). Keys are typed only where no
// permission prompt can be open (canType): Enter would answer one blindly.
// A session that cannot take input, or must not be typed into, is marked
// instead (pkg.contextResume), so its next resume brief starts with a
// progress summary (contextResumeSection). The pure functions decide;
// createContextGuard only keeps the samples and talks to the run.
// ============================================================================

'use strict';

// Compact when the context is predicted to be full within this.
const CONTEXT_HORIZON_MS = 10 * 60 * 1000;
// The fill rate is read over this much recent history...
const SAMPLE_WINDOW_MS = 15 * 60 * 1000;
// ...from at least this many samples spanning at least this long, so one
// big tool result does not read as a runaway rate.
const MIN_SAMPLES = 3;
const MIN_SPAN_MS = 2 * 60 * 1000;
// A context below this fill is never compacted, whatever the rate says.
const MIN_FILL_PERCENT = 50;
const MAX_SAMPLES = 120;
// What the HUD's COMPACT button types (main.js pty:command): the command and Enter.
const COMPACT_TEXT = '/compact\r';
const MAX_SUMMARY_FILES = 20;
const MAX_SUMMARY_WORDS_CHARS = 600;

// A drop of at least this share of the limit starts a new context window (a
// compact landed, a fresh conversation). A smaller dip is noise - a stray
// reading - and must not re-arm the window's one compact.
const NEW_WINDOW_DROP_PERCENT = 10;

const isCount = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const isLimit = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0;

/** Whether reading `next` starts a new context window after reading `prev`. */
function isNewWindow(prev, next) {
  if (!prev || !next || !isCount(prev.tokens) || !isCount(next.tokens) || !isLimit(next.limit)) return false;
  return prev.tokens - next.tokens >= (next.limit * NEW_WINDOW_DROP_PERCENT) / 100;
}

/**
 * The samples after one more reading: a new array, old ones out of the
 * window. A new context window (isNewWindow: a compact, a fresh
 * conversation) or a clock that stepped back starts a new history.
 * @param {Array<{at:number, tokens:number, limit:number}>} samples
 * @param {{at:number, tokens:number, limit:number}} sample
 */
function withSample(samples, sample, windowMs = SAMPLE_WINDOW_MS) {
  const list = Array.isArray(samples) ? samples : [];
  if (!sample || !isCount(sample.at) || !isCount(sample.tokens) || !isLimit(sample.limit)) return list;
  const last = list[list.length - 1];
  if (last && (isNewWindow(last, sample) || sample.at < last.at)) return [sample];
  return [...list, sample].filter((s) => sample.at - s.at <= windowMs).slice(-MAX_SAMPLES);
}

/**
 * How full the context is and when it will be full at the recent rate.
 * @param {Array<{at:number, tokens:number, limit:number}>} samples oldest first
 * @returns {null | {percent:number, tokensPerMin:number, etaMs:number|null}}
 *   null = not enough history yet; etaMs null = the context is not growing
 */
function predictContext(samples) {
  const list = Array.isArray(samples) ? samples : [];
  if (list.length < MIN_SAMPLES) return null;
  const first = list[0];
  const last = list[list.length - 1];
  const span = last.at - first.at;
  if (span < MIN_SPAN_MS || !isLimit(last.limit)) return null;
  const percent = Math.min(100, Math.round((last.tokens / last.limit) * 100));
  const rate = (last.tokens - first.tokens) / span;
  if (!(rate > 0)) return { percent, tokensPerMin: 0, etaMs: null };
  const etaMs = Math.max(0, Math.round((last.limit - last.tokens) / rate));
  return { percent, tokensPerMin: Math.round(rate * 60 * 1000), etaMs };
}

/**
 * Compact now? Only a context past MIN_FILL_PERCENT that is predicted to be
 * full within the horizon, and only once per context window.
 * @param {{percent:number, etaMs:number|null}|null} prediction
 * @param {boolean} compactedThisWindow
 */
function shouldCompact(prediction, compactedThisWindow, horizonMs = CONTEXT_HORIZON_MS) {
  if (!prediction || compactedThisWindow) return false;
  return prediction.percent >= MIN_FILL_PERCENT && prediction.etaMs !== null && prediction.etaMs <= horizonMs;
}

/** A stored pkg.contextResume mark, shape-checked; null when off-shape. */
function normalizeContextResume(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (!isCount(raw.at) || !isCount(raw.percent)) return null;
  return { at: raw.at, percent: Math.min(100, Math.round(raw.percent)), etaMs: isCount(raw.etaMs) ? raw.etaMs : null };
}

const minutesOf = (ms) => Math.max(1, Math.round((ms || 0) / 60000));

/**
 * The resume brief's progress summary for a worker whose last session ran
 * out of context without taking /compact; '' for any other package.
 * @param {{contextResume?:object|null, touched?:string[], lastWords?:string|null}} pkg
 */
function contextResumeSection(pkg) {
  const mark = normalizeContextResume(pkg && pkg.contextResume);
  if (!mark) return '';
  const files = (Array.isArray(pkg.touched) ? pkg.touched : []).slice(0, MAX_SUMMARY_FILES);
  const words = String(pkg.lastWords || '').replace(/\s+/g, ' ').trim().slice(0, MAX_SUMMARY_WORDS_CHARS);
  const eta = mark.etaMs === null ? '' : `, predicted full within ${minutesOf(mark.etaMs)} min`;
  return [
    '## Context (LunaCore)',
    `Your previous session was close to its context limit (${mark.percent}% used${eta}) and could not take /compact, so this is a fresh session.`,
    'Progress so far:',
    files.length ? `- files changed in this worktree: ${files.join(', ')}` : '- no changed files recorded yet',
    ...(words ? [`- your last message: ${words}`] : []),
    '- run `git log --oneline -15` and `git status` here first; do not redo committed work.',
    'Keep the context lean: read only the parts of files you need.',
  ].join('\n');
}

/**
 * The guard of one run.
 * @param {{
 *   enabled: () => boolean, live: () => boolean,
 *   pkgBySession: (sessionId:string) => object|null,
 *   canType: (pkg:object) => boolean,
 *   writePty: (sessionId:string, text:string) => boolean,
 *   patch: (id:string, fields:object) => void, record: (id:string, entry:object) => void,
 *   commit: () => void, onEvent?: (kind:string, data:object) => void,
 *   now: () => number, log?: (line:string) => void,
 * }} opts
 *   canType: true only when the worker can never show a permission prompt
 *   (missing = never type: the conservative default).
 */
function createContextGuard(opts) {
  const log = opts.log || (() => {});
  const onEvent = opts.onEvent || (() => {});
  const canType = typeof opts.canType === 'function' ? opts.canType : () => false;
  /** sessionId -> {samples, compacted, prediction} */
  const sessions = new Map();

  /**
   * One context reading of a worker tab.
   * @param {string} sessionId
   * @param {{tokens:number, limit:number}|null} context
   * @returns {boolean} true when the reading belonged to a run worker and was kept
   */
  function onSample(sessionId, context) {
    if (opts.enabled() !== true || !context || typeof context !== 'object') return false;
    const pkg = opts.pkgBySession(sessionId);
    if (!pkg) return false;
    const prev = sessions.get(sessionId) || { samples: [], compacted: false };
    const samples = withSample(prev.samples, { at: opts.now(), tokens: context.tokens, limit: context.limit });
    // A new context window (the compact landed, or a fresh conversation):
    // its one compact is still to come.
    const newWindow = isNewWindow(prev.samples[prev.samples.length - 1], context);
    const state = { samples, compacted: newWindow ? false : prev.compacted, prediction: predictContext(samples) };
    sessions.set(sessionId, state);
    // The worker compacted after all: a resume mark of the old window is stale.
    if (newWindow && normalizeContextResume(pkg.contextResume)) {
      opts.patch(pkg.id, { contextResume: null });
      opts.commit();
    }
    if (pkg.state === 'launched' && !pkg.awaitingDeps && opts.live() && shouldCompact(state.prediction, state.compacted)) {
      act(sessionId, pkg, state);
    }
    return true;
  }

  /** Sends /compact, or marks the package for a resume with a progress summary. */
  function act(sessionId, pkg, state) {
    sessions.set(sessionId, { ...state, compacted: true });
    const p = state.prediction;
    const detail = `${p.percent}% used, full in ~${minutesOf(p.etaMs)} min`;
    const typable = canType(pkg) === true;
    const sent = typable && opts.writePty(sessionId, COMPACT_TEXT) === true;
    if (!sent) opts.patch(pkg.id, { contextResume: { at: opts.now(), percent: p.percent, etaMs: p.etaMs } });
    opts.record(pkg.id, { at: opts.now(), kind: 'compact', reason: sent ? 'contextCompact' : 'contextResume', detail });
    const why = typable ? 'tab took no input' : 'a permission prompt could be open, nothing typed';
    log(`[context] ${pkg.id}: ${sent ? '/compact sent' : `${why}, marked for resume`} (${detail})`);
    onEvent(sent ? 'contextCompact' : 'contextResume', { id: pkg.id, percent: p.percent, etaMs: p.etaMs });
    opts.commit();
  }

  return {
    onSample,
    forget: (sessionId) => sessions.delete(sessionId),
    clear: () => sessions.clear(),
    /** The board's view of one package's session, or null without one. */
    view(pkg) {
      const state = pkg && pkg.sessionId ? sessions.get(pkg.sessionId) : null;
      const mark = normalizeContextResume(pkg && pkg.contextResume);
      if (!state && !mark) return null;
      const p = state ? state.prediction : null;
      return {
        percent: p ? p.percent : null,
        etaMs: p ? p.etaMs : null,
        compacted: !!(state && state.compacted),
        resumeMarked: !!mark,
      };
    },
  };
}

module.exports = {
  CONTEXT_HORIZON_MS,
  SAMPLE_WINDOW_MS,
  MIN_SAMPLES,
  MIN_SPAN_MS,
  MIN_FILL_PERCENT,
  NEW_WINDOW_DROP_PERCENT,
  COMPACT_TEXT,
  isNewWindow,
  withSample,
  predictContext,
  shouldCompact,
  normalizeContextResume,
  contextResumeSection,
  createContextGuard,
};
