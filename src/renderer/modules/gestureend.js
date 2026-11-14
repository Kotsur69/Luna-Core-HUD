// ============================================================================
// LunaCore - one idempotent end for a pointer gesture
// ----------------------------------------------------------------------------
// Every drag in the HUD (a splitter, a widget being carried to another region)
// puts global state up when it starts: a body class, pointer capture, a tile
// lifted to position:fixed with its own pointer events off. If the gesture only
// listens for pointerup/pointercancel, an alt-tab, a native dialog, a capture
// dropped because the element was rebuilt, or a pen whose release never arrives
// leaves that state up - and the bars it covers stop taking clicks until the
// app is restarted.
//
// armGestureEnd() wires EVERY way a gesture can end to one callback that runs
// exactly once and removes all of its own listeners before it does, so a throw
// in the callback cannot leave a listener behind either.
//
// No DOM access at module scope and no imports: the caller passes the window
// and the capture target, so a plain node test can drive it with EventTarget.
// ============================================================================

'use strict';

/**
 * Arms the end of one pointer gesture.
 *
 * Ends on: pointerup / pointercancel for the same pointer ('up' / 'cancel'),
 * lostpointercapture on `target` ('lost'), window blur ('blur'), Escape
 * ('escape' - swallowed so it does not also reach the terminal), and any NEW
 * pointerdown while this one is still live ('stale': the release of the old one
 * was lost, so the old one cannot still be in progress). The returned function
 * ends it by hand with whatever reason the caller passes ('manual' by default),
 * e.g. when the element the gesture belongs to is being torn down. Only 'up'
 * is a deliberate drop; every other reason is an interruption.
 *
 * A second touch or pen contact counts as a new press too, so it interrupts a
 * drag in flight - deliberate: these are single-pointer gestures, and treating
 * any press as proof the old release was lost is what lets a stuck one heal.
 * A mouse's other buttons fire no pointerdown mid-drag, so they are unaffected.
 *
 * The new-pointerdown listener is in the capture phase on purpose: the window's
 * capture phase of the pointerdown that STARTED the gesture has already passed
 * when this is armed, so it can never end the gesture it just began.
 *
 * @param {{
 *   win: EventTarget,
 *   target?: EventTarget | null,
 *   pointerId: number,
 *   onEnd: (reason: string) => void,
 * }} opts
 * @returns {(reason?: string) => boolean} ends the gesture; false if it had already ended
 */
export function armGestureEnd({ win, target = null, pointerId, onEnd }) {
  if (!win || typeof win.addEventListener !== 'function') {
    throw new TypeError('armGestureEnd: win must be an EventTarget');
  }
  if (typeof onEnd !== 'function') throw new TypeError('armGestureEnd: onEnd must be a function');

  let ended = false;
  const samePointer = (e) => e.pointerId === pointerId;

  const onUp = (e) => {
    if (samePointer(e)) end('up');
  };
  const onCancel = (e) => {
    if (samePointer(e)) end('cancel');
  };
  const onLost = (e) => {
    if (samePointer(e)) end('lost');
  };
  const onBlur = () => end('blur');
  const onKey = (e) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    end('escape');
  };
  const onNewDown = () => end('stale');

  const listeners = [
    [win, 'pointerup', onUp, false],
    [win, 'pointercancel', onCancel, false],
    [win, 'blur', onBlur, false],
    [win, 'keydown', onKey, true],
    [win, 'pointerdown', onNewDown, true],
  ];
  if (target && typeof target.addEventListener === 'function') {
    listeners.push([target, 'lostpointercapture', onLost, false]);
  }
  for (const [t, type, fn, capture] of listeners) t.addEventListener(type, fn, capture);

  function end(reason = 'manual') {
    if (ended) return false;
    ended = true;
    // Unhook first: whatever onEnd does (or throws), no listener outlives the gesture.
    for (const [t, type, fn, capture] of listeners) t.removeEventListener(type, fn, capture);
    onEnd(reason);
    return true;
  }

  return end;
}
