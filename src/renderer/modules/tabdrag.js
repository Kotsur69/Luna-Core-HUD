// ============================================================================
// LunaCore - session tab live-drag math (sessions.js "drag-to-reorder")
// ----------------------------------------------------------------------------
// The tab bar reorders Chrome-style: the dragged tab follows the pointer and
// its neighbours slide aside to show where it will land. Everything here is the
// arithmetic behind that, on plain `{left, width}` rects snapshotted at drag
// start - no DOM, so it is require()-able from node --test (test/tabdrag.test.js),
// same shape as flip.js planList().
//
// Index semantics match the IPC contract (`sessions:reorder`): a slot is the
// dragged tab's FINAL index in the list, counted after it has been removed -
// the same number the old HTML5 dropIndex() produced.
// ============================================================================

'use strict';

/**
 * Keeps a drag offset inside the bar: the dragged tab may travel as far as the
 * first tab's left edge and the last tab's right edge, never past them.
 *
 * @param {Array<{left: number, width: number}>} rects
 * @param {number} fromIndex
 * @param {number} dx
 * @returns {number}
 */
export function clampDx(rects, fromIndex, dx) {
  const self = rects[fromIndex];
  if (!self) return 0;
  const first = rects[0];
  const last = rects[rects.length - 1];
  const min = first.left - self.left;
  const max = last.left + last.width - (self.left + self.width);
  return Math.min(max, Math.max(min, Number(dx) || 0));
}

/**
 * Where the dragged tab would land: the number of OTHER tabs whose midpoint
 * lies left of the dragged tab's centre. That is its final index after
 * removal, and it clamps itself at both ends (0 and n-1).
 *
 * @param {Array<{left: number, width: number}>} rects
 * @param {number} fromIndex
 * @param {number} draggedCenterX
 * @returns {number}
 */
export function targetSlot(rects, fromIndex, draggedCenterX) {
  let slot = 0;
  for (let i = 0; i < rects.length; i++) {
    if (i === fromIndex) continue;
    if (draggedCenterX > rects[i].left + rects[i].width / 2) slot++;
  }
  return slot;
}

/**
 * How far each tab has to slide so the bar previews the drop: tabs between the
 * original and the target slot move one dragged-tab width (plus gap) toward
 * the hole the dragged tab left. The dragged tab itself is 0 - the caller
 * moves it with the pointer.
 *
 * @param {Array<unknown>} rects only the length is read
 * @param {number} from
 * @param {number} to
 * @param {number} width dragged tab width + the bar's gap
 * @returns {number[]} one offset per tab, in px
 */
export function siblingOffsets(rects, from, to, width) {
  return rects.map((_, i) => {
    if (i === from) return 0;
    if (to > from && i > from && i <= to) return -width;
    if (to < from && i >= to && i < from) return width;
    return 0;
  });
}
