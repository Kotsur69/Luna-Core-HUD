// ============================================================================
// LunaCore - category icons for the libraries directory (Ctrl+B)
// ----------------------------------------------------------------------------
// Fourteen tiles in a grid are fourteen identical squares until the icon tells
// them apart, so the icon is load-bearing here rather than decoration.
//
// WHY DRAWINGS AND NOT GLYPHS
// ---------------------------
// The obvious move is a Unicode glyph per category - "▶", "♪" - straight out of
// config. Two reasons not to:
//
//   1. A glyph is whatever the font decides. Half of the interesting ones are
//      outside the HUD's font stack and land as tofu on a machine that is not
//      this one, and a few of them get promoted to full-colour emoji by the
//      system emoji font, which drops a cartoon into a monochrome HUD.
//   2. A glyph in config is a second path for data to reach the DOM. The
//      catalog already names an id rather than carrying a URL for exactly that
//      reason (src/libraries.js) - the icon follows the same rule: config NAMES
//      an icon, this file DRAWS it, and a name nobody here knows falls back.
//
// So each icon is a list of plain SVG shapes, built with createElementNS - no
// innerHTML, no path string ever sourced from config. All of them share one
// stroke weight, one 24x24 grid and currentColor: the tile decides the colour
// and the icon inherits it, which is what keeps hover and the neon accents free.
// ============================================================================

'use strict';

/** The box every icon is drawn in. The shapes below are all in these units. */
const VIEWBOX = 24;

/**
 * name -> shapes. A shape is [tag, attributes], drawn in order.
 *
 * Keys are matched against `category.icon` from the catalog, which the loader
 * has already reduced to a lowercase slug. `default` is the required fallback -
 * test/libraries.test.js asserts it exists, and that every shipped category
 * names an icon that appears here.
 */
export const ICONS = {
  // Four panes: a layout assembled from parts.
  blocks: [
    ['rect', { x: 3, y: 3, width: 8, height: 8, rx: 1.5 }],
    ['rect', { x: 13, y: 3, width: 8, height: 8, rx: 1.5 }],
    ['rect', { x: 3, y: 13, width: 8, height: 8, rx: 1.5 }],
    ['rect', { x: 13, y: 13, width: 8, height: 8, rx: 1.5 }],
  ],

  // Four-point sparkle plus a satellite: motion and effects.
  sparkles: [
    ['path', { d: 'M11 3 12.7 9.3 19 11 12.7 12.7 11 19 9.3 12.7 3 11 9.3 9.3Z' }],
    ['path', { d: 'M18 15.5 18.8 18.2 21.5 19 18.8 19.8 18 22.5 17.2 19.8 14.5 19 17.2 18.2Z' }],
  ],

  // Axis with three bars: measurement.
  chart: [
    ['polyline', { points: '4 3.5 4 20 20.5 20' }],
    ['line', { x1: 8.5, y1: 20, x2: 8.5, y2: 14 }],
    ['line', { x1: 13, y1: 20, x2: 13, y2: 8.5 }],
    ['line', { x1: 17.5, y1: 20, x2: 17.5, y2: 11.5 }],
  ],

  // Wand with two sparks: something done for you.
  wand: [
    ['line', { x1: 4, y1: 20, x2: 14, y2: 10 }],
    ['path', { d: 'M17 3v4M15 5h4' }],
    ['path', { d: 'M19.5 10.5v3M18 12h3' }],
  ],

  // Isometric cube: a runtime you build on.
  cube: [
    ['path', { d: 'M12 2.8 20.5 7.4v9.2L12 21.2 3.5 16.6V7.4Z' }],
    ['polyline', { points: '3.5 7.4 12 12 20.5 7.4' }],
    ['line', { x1: 12, y1: 12, x2: 12, y2: 21.2 }],
  ],

  // Three nodes and their connectors: a drawn system.
  diagram: [
    ['rect', { x: 2.5, y: 3, width: 6.5, height: 6, rx: 1.5 }],
    ['rect', { x: 15, y: 3, width: 6.5, height: 6, rx: 1.5 }],
    ['rect', { x: 8.75, y: 15, width: 6.5, height: 6, rx: 1.5 }],
    ['path', { d: 'M5.75 9v3h12.5V9' }],
    ['line', { x1: 12, y1: 12, x2: 12, y2: 15 }],
  ],

  // Magnifier: going out and finding things.
  search: [
    ['circle', { cx: 10.5, cy: 10.5, r: 6.5 }],
    ['line', { x1: 15.5, y1: 15.5, x2: 20.5, y2: 20.5 }],
  ],

  // Stacked planes: a whole app generated at once.
  layers: [
    ['path', { d: 'M12 2.5 21 7l-9 4.5L3 7Z' }],
    ['polyline', { points: '3 12 12 16.5 21 12' }],
    ['polyline', { points: '3 16.5 12 21 21 16.5' }],
  ],

  // Level meter: audio and media.
  waveform: [
    ['line', { x1: 4, y1: 10, x2: 4, y2: 14 }],
    ['line', { x1: 8, y1: 6.5, x2: 8, y2: 17.5 }],
    ['line', { x1: 12, y1: 3, x2: 12, y2: 21 }],
    ['line', { x1: 16, y1: 7.5, x2: 16, y2: 16.5 }],
    ['line', { x1: 20, y1: 10, x2: 20, y2: 14 }],
  ],

  // Prompt and caret: the machine itself.
  terminal: [
    ['rect', { x: 2.5, y: 4, width: 19, height: 16, rx: 2 }],
    ['polyline', { points: '7 10 10 13 7 16' }],
    ['line', { x1: 12.5, y1: 16, x2: 17, y2: 16 }],
  ],

  // Hub and spokes: many agents, one coordinator.
  network: [
    ['circle', { cx: 12, cy: 12, r: 2.6 }],
    ['circle', { cx: 12, cy: 4, r: 2 }],
    ['circle', { cx: 19, cy: 17.5, r: 2 }],
    ['circle', { cx: 5, cy: 17.5, r: 2 }],
    ['line', { x1: 12, y1: 6, x2: 12, y2: 9.4 }],
    ['line', { x1: 14.2, y1: 13.4, x2: 17.2, y2: 15.9 }],
    ['line', { x1: 9.8, y1: 13.4, x2: 6.8, y2: 15.9 }],
  ],

  // Pencil: writing and making.
  pencil: [
    ['path', { d: 'M4 20.5h4L20 8.5a2.47 2.47 0 0 0-3.5-3.5L4 17Z' }],
    ['line', { x1: 15.5, y1: 6, x2: 19, y2: 9.5 }],
  ],

  // Briefcase: the business side of the toolbox.
  briefcase: [
    ['rect', { x: 2.5, y: 7, width: 19, height: 13, rx: 2 }],
    ['path', { d: 'M9 7V5.5A1.5 1.5 0 0 1 10.5 4h3A1.5 1.5 0 0 1 15 5.5V7' }],
    ['line', { x1: 2.5, y1: 12.5, x2: 21.5, y2: 12.5 }],
  ],

  // Camera body with its lens barrel: video.
  video: [
    ['rect', { x: 2.5, y: 6, width: 12.5, height: 12, rx: 2 }],
    ['path', { d: 'M15 10.5 21.5 7v10L15 13.5Z' }],
  ],

  // The fallback: the same diamond the overlay's filter field already wears, so
  // a tile with no usable icon still looks like it belongs here.
  default: [['path', { d: 'M12 2.5 21.5 12 12 21.5 2.5 12Z' }]],
};

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * Builds the <svg> for an icon name.
 *
 * Unknown names draw the default rather than nothing: the loader has already
 * defaulted anything malformed, so reaching this branch means the config named
 * a real-looking icon this file has not been taught yet - and an empty tile
 * would hide that, where a neutral diamond does not.
 *
 * Decorative by construction: the tile's own accessible name is its title, and
 * a second announcement of "video icon" is noise to a screen reader.
 *
 * @param {string} name
 * @returns {SVGElement}
 */
export function iconSvg(name) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${VIEWBOX} ${VIEWBOX}`);
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.5');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');

  for (const [tag, attrs] of ICONS[name] || ICONS.default) {
    const shape = document.createElementNS(SVG_NS, tag);
    for (const [key, value] of Object.entries(attrs)) shape.setAttribute(key, String(value));
    svg.appendChild(shape);
  }
  return svg;
}
