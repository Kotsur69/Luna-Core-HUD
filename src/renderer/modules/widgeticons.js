// ============================================================================
// LunaCore - per-widget icons for the collapsed-column rail (panels.js)
// ----------------------------------------------------------------------------
// A railed region shows one 28px button per panel. The first letter of each
// title used to stand in for an icon, which made "Skills", "Skill Tracker" and
// "Scratchpad" three identical S buttons. An icon per widget tells them apart.
//
// Same rules as libicons.js, and the same drawing code (drawIcon): plain SVG
// shapes on a 24x24 grid, built with createElementNS, no innerHTML, stroke in
// currentColor so the button decides the colour. Keys are widget ids
// (`section.dataset.widget`), which come from defineWidget() calls in this
// directory - never from config.
//
// test/widgeticons.test.js asserts that every widget registered with a
// non-empty titleKey (i.e. every widget that can appear on a rail) has an
// entry here, and that `default` exists.
// ============================================================================

'use strict';

import { drawIcon } from './libicons.js';

/** widget id -> shapes. A shape is [tag, attributes], drawn in order. */
export const WIDGET_ICONS = {
  // Half-dial with a needle: how much of the plan is used.
  usage: [
    ['path', { d: 'M3.5 17a8.5 8.5 0 0 1 17 0' }],
    ['line', { x1: 12, y1: 17, x2: 16, y2: 10.5 }],
    ['circle', { cx: 12, cy: 17, r: 1.2 }],
  ],

  // CPU die with pins: machine telemetry.
  telemetry: [
    ['rect', { x: 6, y: 6, width: 12, height: 12, rx: 1.5 }],
    ['rect', { x: 9.5, y: 9.5, width: 5, height: 5, rx: 0.5 }],
    ['path', { d: 'M9.5 3v3M14.5 3v3M9.5 18v3M14.5 18v3M3 9.5h3M3 14.5h3M18 9.5h3M18 14.5h3' }],
  ],

  // Head and shoulders: the active profile.
  profile: [
    ['circle', { cx: 12, cy: 8, r: 4 }],
    ['path', { d: 'M4.5 20.5a7.5 7.5 0 0 1 15 0' }],
  ],

  // Folder: the active project.
  project: [['path', { d: 'M3 7.5A1.5 1.5 0 0 1 4.5 6H9l2 2.5h8.5A1.5 1.5 0 0 1 21 10v8.5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5Z' }]],

  // Stacked planes: the context window filling up.
  context: [
    ['path', { d: 'M12 2.5 21 7l-9 4.5L3 7Z' }],
    ['polyline', { points: '3 12 12 16.5 21 12' }],
    ['polyline', { points: '3 16.5 12 21 21 16.5' }],
  ],

  // A branch leaving the trunk and merging back.
  git: [
    ['circle', { cx: 6.5, cy: 5.5, r: 2 }],
    ['circle', { cx: 6.5, cy: 18.5, r: 2 }],
    ['circle', { cx: 17.5, cy: 8, r: 2 }],
    ['line', { x1: 6.5, y1: 7.5, x2: 6.5, y2: 16.5 }],
    ['path', { d: 'M17.5 10c0 4-4 4.5-11 6.5' }],
  ],

  // Two ticked rows and an open one.
  todo: [
    ['polyline', { points: '3.5 6 5 7.5 7.5 5' }],
    ['polyline', { points: '3.5 12 5 13.5 7.5 11' }],
    ['rect', { x: 3.5, y: 16.5, width: 4, height: 4, rx: 1 }],
    ['line', { x1: 11, y1: 6.5, x2: 20.5, y2: 6.5 }],
    ['line', { x1: 11, y1: 12.5, x2: 20.5, y2: 12.5 }],
    ['line', { x1: 11, y1: 18.5, x2: 20.5, y2: 18.5 }],
  ],

  // Plug with two prongs: MCP servers plugged in.
  mcp: [
    ['path', { d: 'M9 3v4.5M15 3v4.5' }],
    ['path', { d: 'M6.5 7.5h11V11a5.5 5.5 0 0 1-11 0Z' }],
    ['line', { x1: 12, y1: 16.5, x2: 12, y2: 21 }],
  ],

  // Five-point star: what Claude knows how to do.
  skills: [['path', { d: 'M12 3 14.6 8.6 20.6 9.3 16.1 13.4 17.3 19.4 12 16.4 6.7 19.4 7.9 13.4 3.4 9.3 9.4 8.6Z' }]],

  // Pulse line: skills firing live.
  skilltracker: [['polyline', { points: '2.5 12 7 12 9.5 5 14.5 19 17 12 21.5 12' }]],

  // Speech bubble: saved prompts.
  prompts: [
    ['path', { d: 'M4 5.5A1.5 1.5 0 0 1 5.5 4h13A1.5 1.5 0 0 1 20 5.5v9a1.5 1.5 0 0 1-1.5 1.5H10l-4.5 4v-4h0A1.5 1.5 0 0 1 4 14.5Z' }],
    ['line', { x1: 8, y1: 8.5, x2: 16, y2: 8.5 }],
    ['line', { x1: 8, y1: 12, x2: 13, y2: 12 }],
  ],

  // Open book: reference sheets.
  cheatsheets: [
    ['path', { d: 'M12 6.5C10 5 7 4.5 3 5v13.5c4-.5 7 0 9 1.5 2-1.5 5-2 9-1.5V5c-4-.5-7 0-9 1.5Z' }],
    ['line', { x1: 12, y1: 6.5, x2: 12, y2: 20 }],
  ],

  // Clipboard with its clip.
  clipboard: [
    ['rect', { x: 5, y: 4.5, width: 14, height: 17, rx: 2 }],
    ['rect', { x: 9, y: 2.5, width: 6, height: 4, rx: 1 }],
  ],

  // Note page with a folded corner and lines.
  scratchpad: [
    ['path', { d: 'M5 3.5h9.5L19 8v12.5H5Z' }],
    ['polyline', { points: '14.5 3.5 14.5 8 19 8' }],
    ['line', { x1: 8, y1: 12.5, x2: 16, y2: 12.5 }],
    ['line', { x1: 8, y1: 16.5, x2: 13.5, y2: 16.5 }],
  ],

  // Two overlapping files: the files a session is touching.
  activefiles: [
    ['path', { d: 'M8 3h7.5L20 7.5V17H8Z' }],
    ['polyline', { points: '15.5 3 15.5 7.5 20 7.5' }],
    ['path', { d: 'M8 7H4v14h12v-4' }],
  ],

  // Three events on a line.
  sessiontimeline: [
    ['line', { x1: 2.5, y1: 12, x2: 21.5, y2: 12 }],
    ['circle', { cx: 6, cy: 12, r: 2 }],
    ['circle', { cx: 12, cy: 12, r: 2 }],
    ['circle', { cx: 18, cy: 12, r: 2 }],
  ],

  // Heart with a pulse through it: health checks.
  diagnostics: [
    ['path', { d: 'M12 20.5S3 15 3 9a4.5 4.5 0 0 1 9-1 4.5 4.5 0 0 1 9 1c0 6-9 11.5-9 11.5Z' }],
    ['polyline', { points: '7 12 9.5 12 11 9.5 13 14.5 14.5 12 17 12' }],
  ],

  // Monitor and phone side by side.
  devices: [
    ['rect', { x: 2.5, y: 4.5, width: 13, height: 10, rx: 1.5 }],
    ['path', { d: 'M6 19h6M9 14.5V19' }],
    ['rect', { x: 17, y: 9, width: 4.5, height: 10, rx: 1 }],
  ],

  // Network socket: listening ports.
  ports: [
    ['rect', { x: 3.5, y: 5, width: 17, height: 14, rx: 2 }],
    ['path', { d: 'M8 15v-3.5h1.5V9h5v2.5H16V15Z' }],
  ],

  // Play triangle in a frame.
  media: [
    ['rect', { x: 3, y: 4.5, width: 18, height: 15, rx: 2 }],
    ['path', { d: 'M10 9v6l5-3Z' }],
  ],

  // Painter's palette.
  appearance: [
    ['path', { d: 'M12 3a9 9 0 0 0 0 18c1.4 0 2-1 2-2 0-1.5-1.5-2 0-3.5 1-1 2.5-.5 4-.5 2 0 3-1.5 3-3.5C21 6.5 17 3 12 3Z' }],
    ['circle', { cx: 7.5, cy: 11, r: 1.2 }],
    ['circle', { cx: 10.5, cy: 7, r: 1.2 }],
    ['circle', { cx: 15.5, cy: 7.5, r: 1.2 }],
  ],

  // Lightning bolt: one-click actions.
  actions: [['path', { d: 'M13.5 2.5 5 13.5h6.5l-1 8 8.5-11h-6.5Z' }]],

  // Calendar page with its rings.
  calendar: [
    ['rect', { x: 3.5, y: 5, width: 17, height: 15.5, rx: 2 }],
    ['path', { d: 'M8 3v4M16 3v4' }],
    ['line', { x1: 3.5, y1: 10, x2: 20.5, y2: 10 }],
  ],

  // Envelope: inbox cleanup.
  mailcleanup: [
    ['rect', { x: 2.5, y: 5, width: 19, height: 14, rx: 2 }],
    ['polyline', { points: '3 6 12 13 21 6' }],
  ],

  // Folded newspaper.
  missionnews: [
    ['path', { d: 'M4 4.5h12.5v14a2 2 0 0 0 2 2H6a2 2 0 0 1-2-2Z' }],
    ['path', { d: 'M16.5 9H20v9.5a2 2 0 0 1-2 2' }],
    ['line', { x1: 7, y1: 8.5, x2: 13.5, y2: 8.5 }],
    ['line', { x1: 7, y1: 12, x2: 13.5, y2: 12 }],
    ['line', { x1: 7, y1: 15.5, x2: 11, y2: 15.5 }],
  ],

  // Radar sweep: the mission-wide readout.
  missiontelemetry: [
    ['circle', { cx: 12, cy: 12, r: 9 }],
    ['circle', { cx: 12, cy: 12, r: 4.5 }],
    ['line', { x1: 12, y1: 12, x2: 18.4, y2: 5.6 }],
  ],

  // The fallback: the same diamond libicons.js falls back to.
  default: [['path', { d: 'M12 2.5 21.5 12 12 21.5 2.5 12Z' }]],
};

/**
 * Builds the decorative <svg> for a widget id. Unknown ids (a widget added
 * without teaching this file) draw the default rather than an empty button.
 *
 * @param {string} id
 * @returns {SVGElement}
 */
export function widgetIconSvg(id) {
  const shapes = Object.hasOwn(WIDGET_ICONS, id) ? WIDGET_ICONS[id] : WIDGET_ICONS.default;
  return drawIcon(shapes);
}
