// ============================================================================
// LunaCore - lunar phase maths for the brand mark
// ----------------------------------------------------------------------------
// Pure module: no DOM, no Electron, no state. `node --test` can require() it
// directly (see test/moonphase.test.js) the same way it does hotkeys.js and
// modifiers.js.
//
// The brand glyph (modules/brand.js) shows the REAL phase of the Moon for the
// current date, and animates through a full lunation on hover. Everything it
// needs to draw that is here: where in the synodic cycle we are (0 = new,
// 0.5 = full), how much of the disc that lights, its name, and the SVG path of
// the lit crescent/gibbous.
//
// Accuracy: a mean-cycle approximation from a known new-moon epoch. It ignores
// the Moon's orbital eccentricity, so it can be up to ~14 h off around the
// quarters - invisible at a 22px glyph, and not worth an ELP2000 port.
// ============================================================================

'use strict';

/** Mean length of one new-moon -> new-moon cycle, in milliseconds. */
export const SYNODIC_MONTH_MS = 29.530588853 * 24 * 60 * 60 * 1000;

/** A well-determined new moon: 2000-01-06 18:14 UTC (Meeus, "Astronomical
 *  Algorithms"). Everything is measured forward and back from here. */
export const NEW_MOON_EPOCH_MS = Date.UTC(2000, 0, 6, 18, 14, 0);

/** Wrap any real number into [0, 1). */
function wrap01(x) {
  const r = x % 1;
  return r < 0 ? r + 1 : r;
}

/**
 * Position in the synodic cycle for a given moment.
 *
 * @param {Date|number} [when] a Date or epoch-ms; defaults to now
 * @returns {number} 0 at new moon, 0.5 at full, approaching 1 back at new.
 *   Always in [0, 1). Junk input resolves to 0 (new) rather than NaN.
 */
export function phaseFraction(when = Date.now()) {
  const ms = when instanceof Date ? when.getTime() : Number(when);
  if (!Number.isFinite(ms)) return 0;
  return wrap01((ms - NEW_MOON_EPOCH_MS) / SYNODIC_MONTH_MS);
}

/**
 * Fraction of the visible disc that is lit, 0..1.
 *
 * Follows from the phase angle directly: (1 - cos(2*pi*f)) / 2. 0 at new,
 * 1 at full, 0.5 at both quarters.
 *
 * @param {number} fraction a value from phaseFraction()
 * @returns {number} 0..1
 */
export function illumination(fraction) {
  const f = wrap01(Number(fraction) || 0);
  return (1 - Math.cos(2 * Math.PI * f)) / 2;
}

/** The eight traditional phase names, as i18n keys, in cycle order. */
export const PHASE_KEYS = [
  'brand.moon.new',
  'brand.moon.waxingCrescent',
  'brand.moon.firstQuarter',
  'brand.moon.waxingGibbous',
  'brand.moon.full',
  'brand.moon.waningGibbous',
  'brand.moon.lastQuarter',
  'brand.moon.waningCrescent',
];

/**
 * Name of the phase a fraction falls in, as an i18n key from PHASE_KEYS.
 *
 * Each of the four "moment" phases (new, quarters, full) owns a 1/8-cycle band
 * centred on its exact instant; the crescents and gibbous phases fill the gaps.
 *
 * @param {number} fraction a value from phaseFraction()
 * @returns {string} one of PHASE_KEYS
 */
export function phaseName(fraction) {
  const f = wrap01(Number(fraction) || 0);
  const idx = Math.round(f * 8) % 8;
  return PHASE_KEYS[idx];
}

/**
 * Geometry of the terminator (the day/night line on the disc) for a fraction.
 *
 * @param {number} fraction a value from phaseFraction()
 * @returns {{litSide: 'left'|'right', terminatorRx: number, crescent: boolean,
 *   illum: number}} `terminatorRx` is the terminator ellipse's horizontal
 *   radius as a share (0..1) of the disc radius; `crescent` is true when the
 *   terminator bows toward the lit limb (less than half lit).
 */
export function terminatorGeometry(fraction) {
  const f = wrap01(Number(fraction) || 0);
  const k = Math.cos(2 * Math.PI * f); // +1 at new, -1 at full
  return {
    litSide: f < 0.5 ? 'right' : 'left', // northern-hemisphere convention
    terminatorRx: Math.abs(k),
    crescent: k > 0,
    illum: (1 - k) / 2,
  };
}

/**
 * SVG path `d` for the lit portion of a disc of radius `r` centred at (0, 0).
 *
 * Two arcs: the bright limb (a fixed semicircle on the lit side) and the
 * terminator (a half-ellipse whose width and bow direction carry the phase).
 * At the quarters `terminatorRx` is 0 and the ellipse arc degrades to the
 * vertical diameter, which is exactly right.
 *
 * @param {number} r disc radius in SVG units
 * @param {number} fraction a value from phaseFraction()
 * @returns {string} an SVG path, e.g. "M 0 -40 A 40 40 0 0 1 0 40 A ... Z"
 */
export function moonLitPath(r, fraction) {
  const { litSide, terminatorRx, crescent } = terminatorGeometry(fraction);
  const R = Number(r) || 0;
  const rx = R * terminatorRx;
  const right = litSide === 'right';

  // Bright limb: top -> bottom along the lit edge. Sweep 1 bows through +x
  // (right), sweep 0 through -x (left).
  const limbSweep = right ? 1 : 0;
  // Terminator: bottom -> top - the OPPOSITE direction from the limb above.
  // Sweep-flag direction is relative to travel direction, so going
  // bottom-to-top flips which flag value bows which way versus the limb's
  // top-to-bottom arc: here sweep 1 bows -x (left), sweep 0 bows +x (right).
  // A crescent's terminator still bows into the lit side, and a gibbous
  // phase's still bows the other way; only the flag needed to express that
  // is inverted from the limb's mapping above.
  const termSweep = crescent === right ? 0 : 1;

  // Round to 3 dp: SVG needs nothing finer at this size, and it snaps the
  // float dust from cos() near the quarters (2.4e-15) cleanly to 0.
  const n = (v) => {
    const r = Math.round(v * 1000) / 1000;
    return Object.is(r, -0) ? 0 : r;
  };
  return [
    `M 0 ${n(-R)}`,
    `A ${n(R)} ${n(R)} 0 0 ${limbSweep} 0 ${n(R)}`,
    `A ${n(rx)} ${n(R)} 0 0 ${termSweep} 0 ${n(-R)}`,
    'Z',
  ].join(' ');
}
