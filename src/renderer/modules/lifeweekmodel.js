// ============================================================================
// LunaCore - Life dashboard: Week tab view math (pure, renderer)
// ----------------------------------------------------------------------------
// The decisions behind the Week tab (lifeweek.js), with no DOM, so node --test
// pins them: which hours split to draw, what the mail line says, which
// generate actions are offered.
// ============================================================================

'use strict';

export const CLASSES = ['work', 'fun', 'other', 'unassigned'];

/** [{cls, hours, share}] for the hours split bar; [] when hours are unknown or zero. */
export function classRows(hours) {
  if (!hours || hours.error || !hours.byClass || !(hours.totalH > 0)) return [];
  return CLASSES.map((cls) => ({ cls, hours: hours.byClass[cls] || 0, share: (hours.byClass[cls] || 0) / hours.totalH })).filter((r) => r.hours > 0);
}

/**
 * The mail line under the review: {key, vars} for t().
 * sent / failed / off / not connected / not sent yet.
 */
export function mailLine(entry, view) {
  const mail = entry && entry.mail;
  if (mail && mail.sentAt) return { key: 'life.week.mail.sent', vars: { at: mail.sentAt } };
  if (mail && mail.error) return { key: 'life.week.mail.failed', vars: { reason: mail.error } };
  if (!view || !view.gmail || !view.gmail.connected) return { key: 'life.week.mail.noGmail', vars: {} };
  return { key: view.mailOn ? 'life.week.mail.pending' : 'life.week.mail.off', vars: {} };
}

/** Weeks the Generate button may build, newest first, with whether each already exists. */
export function generateTargets(view) {
  const have = new Set((view && Array.isArray(view.weeks) ? view.weeks : []).map((w) => w.week));
  return (view && Array.isArray(view.generatable) ? view.generatable : []).map((week) => ({ week, exists: have.has(week) }));
}

/** '$0.0123' style cost, or '' when unknown. */
export function costText(usd) {
  return typeof usd === 'number' && Number.isFinite(usd) ? `$${usd < 0.1 ? usd.toFixed(4) : usd.toFixed(2)}` : '';
}
