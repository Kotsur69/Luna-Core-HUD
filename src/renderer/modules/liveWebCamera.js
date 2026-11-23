// ============================================================================
// LunaCore - God Mode Live Web: the camera (pure)
// ----------------------------------------------------------------------------
// Slice 3 of #agymap. Where the canvas looks: a camera {x, y, k} maps a
// layout point p to the screen as p * k + (x, y), in CSS pixels. Fitting the
// web, easing toward the fit, zooming around the pointer and panning a
// keyboard-picked node into view are pure functions of it, so liveWebView.js
// keeps only the wiring. Every function returns a new camera.
// ============================================================================

'use strict';

import { clampZoom, ZOOM_MIN } from './liveMapHelpers.js';

/** Margin a fit leaves around the web (room for labels), in CSS px. */
export const FIT_PAD_PX = 56;
/** A small web is not blown up past this zoom. */
export const FIT_MAX_ZOOM = 1.4;
/** Share of the way to the fit the camera moves per frame while motion is allowed. */
export const FIT_EASE = 0.18;
/** Closer than this to the fit counts as there. */
const FIT_DONE_PX = 0.5;
const FIT_DONE_ZOOM = 0.001;

/**
 * @typedef {{x:number, y:number, k:number}} Camera
 * @typedef {{w:number, h:number}} Size CSS px of the stage
 */

/** A screen point (CSS px) in layout units. */
export const toWorld = (cam, sx, sy) => ({ x: (sx - cam.x) / cam.k, y: (sy - cam.y) / cam.k });

/**
 * The camera that shows the whole box, centred, or null without a box or a stage.
 * @param {{minX:number, minY:number, maxX:number, maxY:number}|null} box
 * @param {Size} size
 * @returns {Camera|null}
 */
export function fitCamera(box, size) {
  if (!box || !size || !(size.w > 0) || !(size.h > 0)) return null;
  const bw = Math.max(1, box.maxX - box.minX);
  const bh = Math.max(1, box.maxY - box.minY);
  const fitK = Math.min((size.w - 2 * FIT_PAD_PX) / bw, (size.h - 2 * FIT_PAD_PX) / bh);
  const k = Math.min(FIT_MAX_ZOOM, Math.max(ZOOM_MIN, Number.isFinite(fitK) && fitK > 0 ? fitK : 1));
  return { k, x: size.w / 2 - ((box.minX + box.maxX) / 2) * k, y: size.h / 2 - ((box.minY + box.maxY) / 2) * k };
}

/**
 * One step toward `target`.
 * @param {Camera} cam
 * @param {Camera} target
 * @param {number} ease 0..1 (1 = jump there)
 * @returns {{cam: Camera, moving: boolean}} moving: not there yet
 */
export function easeCamera(cam, target, ease) {
  const e = Number.isFinite(ease) ? Math.min(1, Math.max(0, ease)) : 1;
  const next = { k: cam.k + (target.k - cam.k) * e, x: cam.x + (target.x - cam.x) * e, y: cam.y + (target.y - cam.y) * e };
  const moving = Math.abs(target.x - next.x) > FIT_DONE_PX || Math.abs(target.y - next.y) > FIT_DONE_PX || Math.abs(target.k - next.k) > FIT_DONE_ZOOM;
  return { cam: next, moving };
}

/**
 * Zooms by `factor` keeping the layout point under (sx, sy) where it is.
 * @param {Camera} cam
 * @param {number} sx
 * @param {number} sy
 * @param {number} factor
 * @returns {Camera}
 */
export function zoomAround(cam, sx, sy, factor) {
  const k = clampZoom(cam.k * factor);
  const w = toWorld(cam, sx, sy);
  return { k, x: sx - w.x * k, y: sy - w.y * k };
}

/**
 * The camera that centres `p` when it sits outside the padded view, else null (it is in view).
 * @param {Camera} cam
 * @param {{x:number, y:number}} p layout point
 * @param {Size} size
 * @returns {Camera|null}
 */
export function revealCamera(cam, p, size) {
  const sx = p.x * cam.k + cam.x;
  const sy = p.y * cam.k + cam.y;
  if (sx >= FIT_PAD_PX && sx <= size.w - FIT_PAD_PX && sy >= FIT_PAD_PX && sy <= size.h - FIT_PAD_PX) return null;
  return { k: cam.k, x: size.w / 2 - p.x * cam.k, y: size.h / 2 - p.y * cam.k };
}
