# LunaCore HUD Widget Implementation Plan

> **STATUS — all four shipped. Read §5 at the bottom first: two of the four
> were built as written, one was reframed during its own build (Media Deck),
> and one was deliberately narrowed (Device Toggle Panel), with the reasoning
> recorded there rather than silently.**

This document provides architectural instructions for Claude to implement four native HUD widgets. Each must strictly adhere to the `widget` contract (ESM module, `mount(root)`, `unmount()` disposer, `registry.js` registration).

---

## 1. Media Deck (Spotify/Audio Controller)
*   **Purpose:** Control system volume and media playback.
*   **Implementation:**
    *   **Backend (`src/media.js`):** Use a lightweight Node.js wrapper (e.g., `media-control` or custom PS scripts) to interact with the OS media controller.
    *   **Renderer (`src/renderer/modules/media.js`):** A widget with Play/Pause, Skip, and a Vol Slider.
    *   **Data Flow:** IPC `media:update` (polling metadata) and `media:command` (executing Pause/Skip).

## 2. Global Clipboard Repository
*   **Purpose:** Persistent clipboard manager with injection.
*   **Implementation:**
    *   **Backend (`src/clipboard.js`):** Periodically check `clipboard.readText()`. If content changed and is unique, append to `config/clipboard.local.json` (cap at 20 entries).
    *   **Renderer (`src/renderer/modules/clipboard.js`):** A list-based widget showing the last 20 items.
    *   **Actions:** 
        *   ⚡ **Inject:** `pty:paste` (bracketed paste).
        *   📋 **Copy:** Sets `clipboard.writeText()` back to the system.

## 3. Device Toggle Panel (Hardware Control)
*   **Purpose:** Enable/Disable system devices (Bluetooth, Mic, Webcam).
*   **Implementation:**
    *   **Backend (`src/devices.js`):** Execute PowerShell commands to toggle devices (`pnputil` / `devcon` or custom scripts).
    *   **Renderer (`src/renderer/modules/devices.js`):** UI toggles with visual state tracking.
    *   **State:** Needs a `checkDeviceStatus()` function to reflect the real-time physical state (LED or device enabled/disabled status).

## 4. Pin-Board Todo-List
*   **Purpose:** Project-independent task tracking.
*   **Implementation:**
    *   **Backend (`src/todo.js`):** JSON CRUD operations on `config/todo.local.json`.
    *   **Renderer (`src/renderer/modules/todo.js`):** List widget with checkboxes, "Add Todo" input, and delete buttons.
    *   **Interaction:** Must handle state persistence (autosave on change) using the same pattern as the scratchpad.

---

## Technical Contract Reference (For Claude)

All modules **must** export:
```js
defineWidget({
  id: '...',
  titleKey: '...',
  template: '...',
  mount(root) {
    // 1. DOM initialization (root.querySelector)
    // 2. Bus subscriptions
    // 3. Return disposer function
  },
});
```
*   **Strictly NO DOM-reading at module scope.**
*   **IPC listeners must live at module scope, not in widgets.** Use `feeds.js` to broadcast IPC to the event bus.
*   **Always use `location.reload()` as a last resort; prefer clean unmount/remount.**

---

## 5. What actually shipped (2026-08-17) — current truth, read this first

**479 tests** (was 438). All four widgets are registered, placed in `classic`,
`monitor-heavy` and `bottom-dock` (not `focus` — that preset is deliberately
thin), and localized PL/EN.

### 5.1 Media Deck — shipped 2026-08-17, reframed
Built before this document's other three, and it did not use the Spotify/
`media-control` route sketched in §1. It uses Windows' own GSMTC plus a Core
Audio COM interop, so it works with any player and needs no OAuth and no
network. Full record in `LUNA_HUD_SPECIFICATION.md` §6.3.

### 5.2 Global Clipboard — shipped as specified, plus an off switch
`src/clipboard.js` (pure core + `ClipboardWatcher`) and
`src/renderer/modules/clipboard.js`. Poll 1.2 s, cap 20, per-clip cap 4000
chars, MRU dedupe (re-copying something moves it up rather than duplicating
it), injected via the existing `pty:paste` — no new paste path.

**The one addition to the plan: it is OFF by default** (`clipboardEnabled` in
`uiprefs.js`) **and the switch stops the watcher, not just the display.** Every
other reader in this app reads something the user is already showing us — its
own transcripts, its own ports, its own CPU. A clipboard poller reads
everything copied anywhere on the machine, password managers included, and
persists it to disk in plain text. An app whose README promises "I only read
what this list says" cannot ship that switched on and still mean it. Both the
new read and the new file are now disclosed in the README's own table.

### 5.3 Device Toggle Panel — NARROWED to microphone mute
Shipped as mic mute only (`helpers/devices/mic.ps1` + `src/devices.js`), not
the Bluetooth/webcam `pnputil` toggles §3 asked for.

The blocker is §3's own requirement — a `checkDeviceStatus()` that "reflects
the real-time physical state". `pnputil` device disabling cannot honour it:
it needs elevation (so the toggle silently no-ops for a normal user), it
persists after LunaCore exits (so the app changes the machine in a way its
README does not claim), and its state has no cheap read-back, so the switch
drifts out of sync the first time anything else touches the device. **A
privacy control that lies about whether your camera is off is worse than no
control.** Mic mute has none of those problems: it is a soft, instantly
reversible endpoint property that reads back exactly, and it is the same one
Windows' own mic-mute key sets. Three states, never two — muted, live, and
*unavailable* when there is no capture endpoint. It never guesses.

No poller here either, unlike Media Deck: every read is a ~200 ms PowerShell
spawn and mute state only changes when someone changes it, so it reads on
mount, after each toggle, and on demand.

### 5.4 Pin-Board Todo — shipped as specified, then promoted to per-project
`src/todo.js` (validation + persistence, the scratchpad's IPC shape) and
`src/renderer/modules/todo.js`, whose list operations are pure and exported
so the ordering, the cap and what "clear done" removes are all unit-tested
without a DOM. Debounced autosave, and `cleanup()` flushes a pending save
instead of dropping the last edit — the one thing the scratchpad's own header
warns about.

Shipped global (the scratchpad's own call, for the same reason); promoted to
**one list per project** on 2026-08-18 (`dcd7b3b`) — keyed by
`session.projectId` (falling back to a default key when a session has none),
same shape as `config/scratchpad.local.md`'s per-project cousin would need if
it ever wanted the same treatment. `getTodos`/`saveTodos` now take a
`sessionId`; the renderer re-fetches on every tab/project switch
(`syncTodoProject()`), flushing any pending debounced save under the
project it was typed for first, so a switch mid-edit cannot land text on the
wrong project's list.

### 5.5 Still owed
Manual `npm start` verification of all three new widgets on a real desktop —
in particular whether `mic.ps1` resolves a capture endpoint on Mati's machine,
which is the one thing no unit test here can answer.
