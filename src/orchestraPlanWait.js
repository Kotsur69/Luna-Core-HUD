// ============================================================================
// LunaCore - God Mode: wait out a Claude usage limit before planning (pure)
// ----------------------------------------------------------------------------
// The headless planner (src/orchestraPlan.js) used to fail outright when the
// 5 h or weekly Claude window was spent - the board said the planning budget
// had hit its limit and Mati had to come back and press Re-plan by hand. Now
// a limit becomes a WAIT: orchestra.js arms one timer for the reset and plans
// on its own when the window opens again, showing the resume time with a
// cancel option meanwhile.
//
// This file is only the decision: given the planner's result and the latest
// usage reading (src/usage.js limits), wait until when - or fail as before.
//
//   - a usage-limit message from the CLI ("Claude AI usage limit reached|
//     <epoch>", "You've hit your limit") is always a wait;
//   - the planner's own --max-budget-usd cap ('budget') is a wait only when
//     the usage reading shows a spent window too - a real dollar cap does not
//     go away by waiting, so it still fails;
//   - the resume time comes from the CLI's reset epoch, else the spent
//     window's resetsAt (weekly before 5 h), else a re-probe in 30 min.
// ============================================================================

'use strict';

/** At or above this, a window counts as spent. */
const FULL_PCT = 99;
/** Start this long after the reset, so the first request lands after it. */
const RESUME_GRACE_MS = 60 * 1000;
/** When no reset time is known at all: look again after this long. */
const FALLBACK_WAIT_MS = 30 * 60 * 1000;
/** Never re-plan sooner than this (a reset already past or a clock skew). */
const MIN_WAIT_MS = 60 * 1000;

const LIMIT_TEXT_RE = /usage limit|limit reached|hit your (usage )?limit|out of (extra )?usage|(5-hour|weekly|session) limit|rate[_ ]limit/i;

/** True when CLI output text describes an account usage limit. */
function isUsageLimitText(text) {
  return LIMIT_TEXT_RE.test(String(text || ''));
}

/**
 * The reset time the CLI prints after a pipe ("...limit reached|1760000000"),
 * as epoch ms, or null.
 */
function resetFromText(text) {
  const m = /\|\s*(\d{10,13})\b/.exec(String(text || ''));
  if (!m) return null;
  const n = Number(m[1]);
  return n < 1e12 ? n * 1000 : n;
}

/** The usage window that is spent: weekly first (it outlasts the 5 h one). */
function spentWindow(limits) {
  const list = Array.isArray(limits) ? limits : [];
  const find = (w) => list.find((l) => l && l.window === w && typeof l.percentUsed === 'number' && l.percentUsed >= FULL_PCT);
  return find('weekly') || find('5h') || null;
}

function resetMs(limit) {
  const at = limit && typeof limit.resetsAt === 'string' ? Date.parse(limit.resetsAt) : NaN;
  return Number.isFinite(at) ? at : null;
}

/**
 * Decides what a failed planning attempt should do.
 * @param {{res:{ok:boolean, error?:string, detail?:string}|null, limits?:Array, now:number}} input
 * @returns {{action:'none'}|{action:'fail'}|{action:'wait', resumeAt:number, window:'5h'|'weekly'|null, source:'cli'|'usage'|'fallback'}}
 */
function planWaitDecision({ res, limits = [], now }) {
  if (!res || res.ok) return { action: 'none' };
  const spent = spentWindow(limits);
  const limitHit = res.error === 'limit' || (res.error === 'budget' && (isUsageLimitText(res.detail) || !!spent));
  if (!limitHit) return { action: 'fail' };

  const fromCli = resetFromText(res.detail);
  const fiveHour = (Array.isArray(limits) ? limits : []).find((l) => l && l.window === '5h');
  const fromUsage = resetMs(spent) || (res.error === 'limit' ? resetMs(fiveHour) : null);
  let resumeAt;
  let source;
  if (fromCli && fromCli > now) {
    resumeAt = fromCli;
    source = 'cli';
  } else if (fromUsage && fromUsage > now) {
    resumeAt = fromUsage;
    source = 'usage';
  } else {
    resumeAt = now + FALLBACK_WAIT_MS;
    source = 'fallback';
  }
  return {
    action: 'wait',
    resumeAt: Math.max(resumeAt + RESUME_GRACE_MS, now + MIN_WAIT_MS),
    window: spent ? spent.window : null,
    source,
  };
}

/**
 * The one pending wait: armed by orchestra.js makePlan() on a 'wait'
 * decision, fires `replan(ctx)` at resumeAt. Timers and the clock are
 * injected. onChange gets the view - null, or
 * {state:'waiting'|'planning'|'failed', resumeAt, window, source, projectId, error}.
 * @param {{setTimer:Function, clearTimer:Function, now:() => number,
 *          onChange:Function, replan:(ctx:object) => Promise<object>}} deps
 */
function createPlanWaiter({ setTimer, clearTimer, now, onChange, replan }) {
  let wait = null;
  let timer = null;

  const view = () => (wait
    ? {
      state: wait.state,
      resumeAt: wait.resumeAt || null,
      window: wait.window || null,
      source: wait.source || null,
      projectId: wait.ctx ? wait.ctx.projectId : null,
      error: wait.error || null,
    }
    : null);

  function stopTimer() {
    if (timer) clearTimer(timer);
    timer = null;
  }

  /** Drops the wait (if any) and tells the renderer. */
  function clear() {
    stopTimer();
    if (!wait) return;
    wait = null;
    onChange(null);
  }

  /** @param {object} ctx the makePlan context @param {{resumeAt:number, window, source}} decision */
  function arm(ctx, decision) {
    stopTimer();
    wait = { state: 'waiting', ctx, resumeAt: decision.resumeAt, window: decision.window, source: decision.source };
    timer = setTimer(fire, Math.max(0, decision.resumeAt - now()));
    onChange(view());
  }

  async function fire() {
    timer = null;
    if (!wait || wait.state !== 'waiting') return;
    const { ctx } = wait;
    wait = { ...wait, state: 'planning' };
    onChange(view());
    let res;
    try {
      res = await replan(ctx);
    } catch {
      res = { ok: false, error: 'failed' };
    }
    // replan() may have armed a fresh wait (the limit is still on) - keep it.
    if (wait && wait.state === 'waiting') return;
    if (res && res.ok) {
      clear();
      return;
    }
    wait = { state: 'failed', ctx, error: (res && res.error) || 'failed' };
    onChange(view());
  }

  function cancel() {
    if (!wait || wait.state === 'planning') return { ok: false, error: 'notWaiting' };
    clear();
    return { ok: true };
  }

  return {
    arm,
    cancel,
    clear,
    view,
    isWaiting: () => !!wait && wait.state === 'waiting',
    isPlanning: () => !!wait && wait.state === 'planning',
  };
}

module.exports = {
  isUsageLimitText,
  resetFromText,
  spentWindow,
  planWaitDecision,
  createPlanWaiter,
  FULL_PCT,
  RESUME_GRACE_MS,
  FALLBACK_WAIT_MS,
  MIN_WAIT_MS,
};
