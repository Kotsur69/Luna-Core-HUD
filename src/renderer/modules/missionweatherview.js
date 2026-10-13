// ============================================================================
// LunaCore - Mission Control: hourly weather view math (pure, renderer)
// ----------------------------------------------------------------------------
// One forecast hour -> a track-surface guess for the expandable hourly table
// (missioncaledit.js). A guess from the forecast, labelled as one in the UI:
// the rain AMOUNT decides first (a 90% chance of 0.1 mm is a damp line, not
// a wet track), the chance only when the amount is unknown or tiny.
// No DOM, so node --test pins it.
// ============================================================================

'use strict';

/** mm in the hour from which the track is wet / may be damp. */
const WET_MM = 0.5;
const DAMP_MM = 0.1;
/** Rain chance (%) that makes an hour "wet" / "maybe" when the amount says little. */
const WET_CHANCE = 70;
const MAYBE_CHANCE = 40;

/**
 * @param {{rain:number|null, mm:number|null}} hour
 * @returns {'dry'|'maybe'|'wet'}
 */
export function surfaceOf(hour) {
  const mm = hour && typeof hour.mm === 'number' ? hour.mm : null;
  const rain = hour && typeof hour.rain === 'number' ? hour.rain : null;
  if (mm !== null && mm >= WET_MM) return 'wet';
  if (mm !== null && mm >= DAMP_MM) return rain !== null && rain >= WET_CHANCE ? 'wet' : 'maybe';
  if (mm === null && rain !== null && rain >= WET_CHANCE) return 'wet';
  return rain !== null && rain >= MAYBE_CHANCE ? 'maybe' : 'dry';
}
