# Concept: smooth (Apple-like) drag-to-reorder for the to-do widget

Status: **not implemented yet** - planned, picking this up on the home PC.
Owner file: `src/renderer/modules/todo.js` (+ `src/renderer/styles.css`).

## Why

The to-do list (`todo.js`) already supports drag-to-reorder, but it uses
native HTML5 drag-and-drop (`draggable`, `dragstart`/`dragover`/`drop`). That
API has no concept of animating sibling rows out of the way while you drag -
the list just snaps into the new order on drop. Mati wants it to feel like
iOS Reminders / macOS Finder list reordering: as the dragged row crosses over
another row, that row visibly slides out of the way in real time, and the
dragged row sticks to the cursor with no lag.

Native HTML5 DnD cannot produce that feel (the browser owns the drag image
and there's no hook to animate other list items mid-drag), so the fix is to
replace it with a hand-rolled pointer-events drag, using the FLIP technique
(First-Last-Invert-Play) for the sibling-shift animation.

Went through the `design-motion-principles` skill for this: context is a
**productivity tool** (Emil primary / Jakub secondary) - so the motion should
be restrained and fast (sub-300ms, ideally ~150-200ms), never bouncy/elastic,
and must respect `prefers-reduced-motion`.

## Current code (as of 2026-08-19, what to replace)

In `src/renderer/modules/todo.js`, inside `renderRows()`'s `items.forEach(...)`
loop, there is a block starting with:

```js
// Drag-to-reorder: grab any row, drop it on another to move it there.
li.draggable = true;
li.addEventListener('dragstart', (e) => { ... });
li.addEventListener('dragover', (e) => { ... });
li.addEventListener('dragleave', () => { ... });
li.addEventListener('drop', (e) => { ... });
li.addEventListener('dragend', () => { ... });
```

...and a module-scope `let dragIndex = null;` near the top (next to the
`expanded` Set). All of that goes away and is replaced by the pointer-based
mechanism below. `reorderTodo(list, fromIndex, toIndex)` (already added,
already tested in `test/todo.test.js`) stays exactly as-is - it's the pure
commit step, unchanged by this rewrite.

In `src/renderer/styles.css`, the rules to replace are:

```css
.todo-item--dragging { opacity: 0.45; }
.todo-item--drag-over {
  border-color: var(--edge-glow);
  box-shadow: 0 0 var(--glow-size-sm) var(--glow);
}
```

(`.todo-item--expanded`, right above them, is unrelated - keep it.)

## The mechanism (pointer-events + FLIP)

One dragged row follows the pointer 1:1 with **no transition** (it must feel
glued to the cursor). Every other row gets a `transform: translateY(...)`
**with** a short transition, toggled on/off as the dragged row's midpoint
crosses each sibling's midpoint - that's the "slide out of the way" effect.
Nothing is actually reordered in the DOM (or in `items`) until drop; the
final order is committed once via the existing `reorderTodo`.

### State

Replace `let dragIndex = null;` with a single `let drag = null;` holding
everything for the in-flight gesture:

```js
let drag = null; // { pointerId, li, originalIndex, startClientY, startTop,
                  //   rowHeight, moved, siblings, targetIndex }
```

`siblings` is captured once at drag start: every *other* row's
`{ index, el, mid }` (original `items[]` index, the `<li>`, and its
`getBoundingClientRect()` vertical midpoint at that moment). Their rects
never change during the drag - only their `transform` is toggled - so this
snapshot stays valid for the whole gesture.

### Wiring, per row (inside the `items.forEach` loop in `renderRows()`)

```js
li.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  // Let the checkbox and the ⚡/✕ buttons handle their own clicks.
  if (e.target.closest('input, button')) return;
  startDrag(e, li, index);
});
```

`startDrag` records the pointer id, the row's starting `top`/height, and
captures the pointer (`li.setPointerCapture(e.pointerId)`) so move/up events
keep arriving even if the cursor leaves the row. It does **not** yet add the
`--dragging` visual or start animating siblings - that only happens once the
pointer has moved past a small threshold (~4px), so a plain click-to-expand
on the text isn't mistaken for a drag.

### On pointermove (throttled via `requestAnimationFrame`)

1. `dy = e.clientY - drag.startClientY`.
2. If `!drag.moved && Math.abs(dy) > 4`: flip `drag.moved = true`, add
   `todo-item--dragging` to `li`, bump its `z-index`.
3. If `drag.moved`: set `li.style.transform = translateY(${dy}px)` (dragged
   row - no transition, follows pointer exactly).
4. Compute `draggedMid = drag.startTop + drag.rowHeight / 2 + dy`.
5. For each sibling, decide its live shift:
   ```js
   let shift = 0;
   if (s.index < drag.originalIndex && s.mid > draggedMid) shift = drag.rowHeight;
   else if (s.index > drag.originalIndex && s.mid < draggedMid) shift = -drag.rowHeight;
   s.el.style.transform = shift ? `translateY(${shift}px)` : '';
   ```
   (A sibling that *was* above the dragged row but now sits below the
   dragged row's current position slides down by one row-height to make
   room; symmetric case for a sibling below. This is the whole trick - no
   library needed.)
6. `drag.targetIndex = count of siblings whose original `mid` < draggedMid`
   - this lands exactly on the `toIndex` shape `reorderTodo` already expects
   (an index into the array with the dragged item removed).

### On pointerup / pointercancel

1. If `drag.moved && drag.targetIndex !== drag.originalIndex`:
   `commit(reorderTodo(items, drag.originalIndex, drag.targetIndex))` - this
   re-renders the list from scratch in the new order, which should look
   seamless since every sibling was already visually sitting in its target
   slot.
2. Clear every inline `transform` (dragged row + all siblings), remove
   `todo-item--dragging`, release pointer capture, `drag = null`.
3. If `!drag.moved` (never crossed the threshold): do nothing extra - it was
   a plain click, and the existing click handlers (checkbox, text-expand,
   inject/remove buttons) already fired normally.

### CSS

Siblings' shift transition (add near the current `.todo-item--expanded` /
old drag rules in `styles.css`):

```css
.todo-item { transition: transform var(--dur-fast) var(--ease-smooth); }
.todo-item--dragging {
  transition: none; /* follows the pointer exactly, no lag */
  z-index: 5;
  cursor: grabbing;
}
```

Reuse the tokens already in the file (`--dur-fast`, `--ease-smooth:
cubic-bezier(0.22, 1, 0.36, 1)` - grep showed dozens of existing uses, this
is the established "settle" easing, no new token needed). That satisfies the
Emil-weighted "match established conventions, sub-300ms" guidance.

### Reduced motion

```js
const REDUCED_MOTION = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
```
computed once at module load (mirrors `boot.js`'s pattern for the same
media query). When true, skip step 5's `transform` transition (siblings can
still jump to their target slot instantly for positional feedback - just
without the animated slide). Simplest implementation: add a
`.todo-list.is-reduced-motion .todo-item { transition: none; }` class toggled
once at mount, rather than branching the JS per-row.

## Files to touch

- `src/renderer/modules/todo.js` - the rewrite above.
- `src/renderer/styles.css` - swap `.todo-item--dragging`/`--drag-over` for
  the rules above.
- No test changes needed: `reorderTodo` itself (the pure function under
  test) is untouched - only its caller changes.

## Verification checklist (do this before calling it done)

1. `npm test` - must stay at 609/609 (or more, if `reorderTodo` gains
   tests, it already has 5).
2. `npm start` - actually drag a few to-dos around, check:
   - dragged row follows the cursor with no visible lag/jitter,
   - other rows slide (not snap) out of the way as you cross them,
   - dropping lands them in the right place, no visual "pop" on release,
   - dragging past the top/bottom of the list doesn't throw,
   - clicking (not dragging) a row still expands its text as before,
   - the checkbox and ⚡/✕ buttons still work with a single click.
3. Toggle Windows' "Show animations" / reduced-motion setting and confirm
   the drag still functions (row still moves to the right slot) just
   without the sliding animation.
4. Commit + push once it feels right.
