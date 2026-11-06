# Smooth pointer-drag to-do reordering (Reference)

**Status: shipped, done.** This used to be a build plan written before the
work started (`CONCEPT_TODO_DRAG_MOTION.md`). That's history now — the code
is the source of truth. This is the compact version: what shipped, which
files implement it, and the gotchas worth remembering. Shipped `021cf77`
(2026-08-19), compacted 2026-08-26.

---

## 1. What it does

The to-do list's drag-to-reorder used to be native HTML5 drag-and-drop
(`draggable`, `dragstart`/`dragover`/`drop`) — the browser owns the drag
image and gives no hook to animate other rows mid-gesture, so the list just
snapped into its new order on drop. Replaced with a hand-rolled
pointer-events drag using FLIP (First-Last-Invert-Play):

- The dragged row follows the pointer 1:1 with no transition (glued to the
  cursor, no lag).
- Every sibling row it crosses slides one row-height aside, with a short
  transition, as the dragged row's midpoint crosses that sibling's midpoint.
- Nothing is actually reordered in the DOM or in `items` until pointerup —
  the final order is committed once via the existing `reorderTodo()`, which
  needed no change (it stayed the pure commit step, already tested).

Motion is restrained and fast (sub-300ms), matching the productivity-tool
guidance the `design-motion-principles` skill gave before the build (Emil
primary / Jakub secondary — no bounce, no elastic).

## 2. Files

| Path | Role |
|---|---|
| `src/renderer/modules/todo.js` | `startDrag`/pointermove/pointerup wiring, `resolveDrag()` (pure, exported — the crossing math, no DOM), `flushSettle()` |
| `src/renderer/styles.css` | `.todo-item--dragging` (no transition, follows pointer exactly) replacing the old `--dragging`/`--drag-over` HTML5-DnD rules; row-shift transition reuses the existing `--dur-fast`/`--ease-smooth` tokens |
| `test/todo.test.js` | 8 new tests for `resolveDrag()` (609 → 617 total) |

## 3. Gotchas found during the build (all fixed, worth remembering)

- **Shift by the dragged row's height, not each sibling's.** A
  click-expanded row that wraps to two lines would otherwise misalign the
  siblings it crosses.
- **On release, the row rides into the slot its neighbours already opened,
  then the order swaps in** — not a teleport out from under the cursor.
  `flushSettle()` lands that early if a second grab arrives mid-settle,
  since `getBoundingClientRect()` reports transformed boxes.
- **Watch the gesture on `window`, not via `setPointerCapture`.** Capture
  retargets the compatibility mouse events too, which would move `click`
  from the `<span>` to the `<li>` and silently kill click-to-expand.
- **Reduced motion needed no branch.** `styles.css` already zeroes
  `--dur-fast` at the token layer, and `settleMs()` reads the duration back
  off the row — so `prefers-reduced-motion` collapses the transition to 0s
  for free, no separate code path.

## 4. Explicitly deferred, not built

Nothing — the concept doc's full scope (pointer-drag + FLIP sibling-shift +
reduced-motion respect) shipped as planned.
