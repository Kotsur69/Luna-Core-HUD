// ============================================================================
// LunaCore - helpers shared by the Mission Control IPC modules
// ----------------------------------------------------------------------------
// missioncontrolipc.js, missioncalipc.js and missionnewsipc.js all need these;
// they live here so none of those modules has to import another.
// ============================================================================

'use strict';

const LANGS = ['pl', 'en'];

/** Local ISO 8601 with the zone offset, e.g. 2026-10-08T14:03:00+02:00. */
function localIsoNow(date = new Date()) {
  const pad = (n) => String(Math.abs(n)).padStart(2, '0');
  const off = -date.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `${sign}${pad(Math.trunc(off / 60))}:${pad(off % 60)}`
  );
}

/** A typed error (GithubError, NewsError) keeps its reason; anything else gets `fallback`. */
function typedFailure(label, err, fallback) {
  const reason = err && typeof err.reason === 'string' ? err.reason : fallback;
  console.error(`[mission] ${label}:`, reason, err && err.message);
  return { ok: false, reason };
}

module.exports = { LANGS, localIsoNow, typedFailure };
