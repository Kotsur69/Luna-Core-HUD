// ============================================================================
// LunaCore - Mission Control: ledger view math (pure, renderer)
// ----------------------------------------------------------------------------
// mission:ledger report + the weekly limit's percentUsed in, rows and stacked-
// bar segments out. No DOM, so node --test pins it.
//
// "≈ 23 % of weekly limit" = project's share of the priced Claude spend in the
// window x the weekly percentUsed. That assumes the limit burns in proportion
// to API-price cost - an estimate, and the UI says so. Without a usage
// reading the percentages fall back to "share of Claude spend".
// ============================================================================

'use strict';

export const TOP_N = 5;
/** Unassigned projects offered for a class at once. */
export const MAX_ASSIGN = 20;
export const CLASS_ORDER = ['work', 'fun', 'other', 'unassigned'];

/** A project's class; the non-repo "other" bucket is always class other. */
const classOf = (p) => (p.key === 'other' ? 'other' : p.cls || 'unassigned');

/**
 * @param {{ok:boolean, totalUsd:number, unpricedTokens:number, projects:Array}|null} report
 * @param {number|null} weeklyPct percentUsed of the weekly limit, or null
 */
export function ledgerView(report, weeklyPct) {
  if (!report || !report.ok || !Array.isArray(report.projects)) return null;
  const hasLimit = typeof weeklyPct === 'number' && Number.isFinite(weeklyPct);
  const scale = hasLimit ? weeklyPct : 100;
  const all = report.projects
    .filter((p) => p.pinned || p.usd > 0 || p.unpricedTokens > 0)
    .map((p) => ({
      key: p.key,
      name: p.name,
      cls: classOf(p),
      usd: p.usd,
      pct: p.share * scale,
      unpricedTokens: p.unpricedTokens,
      pinned: p.pinned === true,
    }));
  // Pinned projects always get a row (even at 0 %), then the top spenders.
  const pinnedRows = all.filter((r) => r.pinned);
  const others = all.filter((r) => !r.pinned);
  const rows = [...pinnedRows, ...others];

  const top = [...pinnedRows, ...others.slice(0, TOP_N)];
  const rest = others.slice(TOP_N);
  const segments = CLASS_ORDER.map((cls) => ({
    cls,
    pct: rows.filter((r) => r.cls === cls).reduce((s, r) => s + r.pct, 0),
  })).filter((s) => s.pct > 0);

  return {
    basis: hasLimit ? 'limit' : 'spend',
    top,
    restCount: rest.length,
    restPct: rest.reduce((s, r) => s + r.pct, 0),
    segments,
    unassigned: rows
      .filter((r) => r.cls === 'unassigned')
      .slice(0, MAX_ASSIGN)
      .map(({ key, name }) => ({ key, name })),
    totalUsd: report.totalUsd,
    unpricedTokens: report.unpricedTokens || 0,
  };
}
