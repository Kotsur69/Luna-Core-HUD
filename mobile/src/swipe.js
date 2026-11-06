// ============================================================================
// LunaCore phone - swipe a row left to reveal one action (iOS Mail style)
// ----------------------------------------------------------------------------
// The row's track follows the finger (no transition while dragging), then
// snaps open or closed on release: past half the action width, or a quick
// flick, decides (settleSwipe; test/mobileswipe.test.mjs). A vertical move
// first is a scroll and is left alone (touch-action: pan-y in CSS). A drag
// never also counts as a tap, and a tap on an open row only closes it.
// Reduced motion: the CSS drops the snap transition.
// ============================================================================

const DRAG_START_PX = 8;
const FLICK_PX_PER_MS = 0.5;
const RUBBER = 0.25; // how much of the drag past the action still moves the row
/** A finger held still this long before release is no flick any more. */
const STALE_VELOCITY_MS = 100;

/** Where a released row settles: true = open. */
export function settleSwipe({ offset, velocity, width }) {
  if (velocity <= -FLICK_PX_PER_MS) return true;
  if (velocity >= FLICK_PX_PER_MS) return false;
  return offset <= -width / 2;
}

/** The track offset for a drag: never right of closed, rubber-banded past the action. */
export function clampOffset(offset, width) {
  if (offset >= 0) return 0;
  if (offset >= -width) return offset;
  return -width + (offset + width) * RUBBER;
}

/**
 * @param {HTMLElement} row      holds the action (behind) and the track (on top)
 * @param {HTMLElement} track    the element that slides
 * @param {HTMLElement} action   the revealed button
 * @param {{width: number, onOpen?: () => void, onClose?: () => void}} opts
 * @returns {{close: () => void, isActive: () => boolean}}  active = open or being dragged
 */
export function attachSwipe(row, track, action, { width, onOpen = () => {}, onClose = () => {} }) {
  let open = false;
  let drag = null; // {x, y, base, pointerId, offset, active}
  let last = { x: 0, t: 0 };
  let velocity = 0;
  let swallowClick = false;

  function setOpen(next) {
    open = next;
    row.classList.remove('is-dragging');
    row.classList.toggle('is-open', open);
    track.style.transform = open ? `translateX(${-width}px)` : '';
    action.tabIndex = open ? 0 : -1;
    action.setAttribute('aria-hidden', String(!open));
    if (open) onOpen();
    else onClose();
  }
  setOpen(false);

  track.addEventListener('pointerdown', (e) => {
    if (!e.isPrimary || e.button !== 0) return;
    swallowClick = false; // a new touch never inherits the last drag's guard
    const base = open ? -width : 0;
    drag = { x: e.clientX, y: e.clientY, base, pointerId: e.pointerId, offset: base, active: false };
    last = { x: e.clientX, t: e.timeStamp };
    velocity = 0;
  });

  track.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    if (!drag.active) {
      if (Math.abs(dy) > DRAG_START_PX && Math.abs(dy) >= Math.abs(dx)) {
        drag = null; // a scroll, not a swipe
        return;
      }
      if (Math.abs(dx) <= DRAG_START_PX) return;
      drag.active = true;
      row.classList.add('is-dragging');
      track.setPointerCapture(e.pointerId);
    }
    const dt = e.timeStamp - last.t;
    if (dt > 0) velocity = (e.clientX - last.x) / dt;
    last = { x: e.clientX, t: e.timeStamp };
    drag.offset = clampOffset(drag.base + dx, width);
    track.style.transform = `translateX(${drag.offset}px)`;
  });

  function end(e, cancelled) {
    if (!drag || e.pointerId !== drag.pointerId) return;
    const { active, offset } = drag;
    drag = null;
    if (!active) return;
    // iOS often sends no click after a moved touch: the guard lives one task only.
    swallowClick = !cancelled;
    if (swallowClick) setTimeout(() => (swallowClick = false), 0);
    const v = e.timeStamp - last.t > STALE_VELOCITY_MS ? 0 : velocity;
    setOpen(cancelled ? open : settleSwipe({ offset, velocity: v, width }));
  }
  track.addEventListener('pointerup', (e) => end(e, false));
  track.addEventListener('pointercancel', (e) => end(e, true));

  // Capture phase: runs before the link navigates.
  track.addEventListener(
    'click',
    (e) => {
      if (swallowClick || open) {
        e.preventDefault();
        e.stopImmediatePropagation();
        if (!swallowClick) setOpen(false);
      }
      swallowClick = false;
    },
    true,
  );

  return { close: () => open && setOpen(false), isActive: () => open || Boolean(drag && drag.active) };
}
