# LunaCore HUD Widget Implementation Plan

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
