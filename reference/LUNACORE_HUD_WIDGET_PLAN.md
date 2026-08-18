# LunaCore HUD Widget Plan (Reference)

**Status: all four shipped.** Two were built close to the original spec
(Clipboard, Todo), one was reframed mid-build (Media Deck), one was
deliberately narrowed (Device Toggle → mic mute only). §2 below is current
truth; §1 is the original one-line-per-widget brief, kept for context.
Compacted 2026-08-18.

---

## 1. Original brief (four widgets, each a `widget` contract module: ESM,
`mount(root)` → disposer, `registry.js` registration)

| Widget | Purpose | Sketch |
|---|---|---|
| Media Deck | Volume + playback control | IPC `media:update` (poll) / `media:command` |
| Global Clipboard | Persistent clipboard manager | Poll `clipboard.readText()`, cap 20, inject via `pty:paste` |
| Device Toggle Panel | Enable/disable Bluetooth/mic/webcam | PowerShell (`pnputil`/`devcon`) toggles + status read-back |
| Pin-Board Todo | Project-independent task list | JSON CRUD on `config/todo.local.json`, autosave |

Contract: strictly no DOM-reading at module scope; IPC listeners live at
module scope (via `feeds.js`), never inside a widget; prefer clean
unmount/remount over `location.reload()`.

## 2. What actually shipped (2026-08-17/18) — read this for current truth

**479 tests.** All four registered, placed in `classic`, `monitor-heavy` and
`bottom-dock` (not `focus` — deliberately thin), localized PL/EN.

**Media Deck — reframed.** Didn't use the Spotify/`media-control` route
sketched above. Uses Windows' own GSMTC plus a Core Audio COM interop —
works with any player, no OAuth, no network. Full record in
`LUNA_HUD_SPECIFICATION.md` §6.3.

**Global Clipboard — shipped as specified, plus a real off switch.**
`src/clipboard.js` + `src/renderer/modules/clipboard.js`. Poll 1.2s, cap 20,
4000 chars/clip, MRU dedupe. **The one deviation: OFF by default**
(`clipboardEnabled` in `uiprefs.js`), and the switch stops the watcher
entirely, not just the display — a clipboard poller reads everything
copied anywhere on the machine (password managers included) and persists
it to disk in plain text, which the README's "I only read what this list
says" promise can't cover if it's on by default.

**Device Toggle Panel — narrowed to microphone mute.** Shipped
`helpers/devices/mic.ps1` + `src/devices.js`; the Bluetooth/webcam
`pnputil` toggles from the brief were dropped. `pnputil` device disabling
can't satisfy the brief's own "reflect real-time physical state"
requirement — it needs elevation (silently no-ops for a normal user),
persists after LunaCore exits, and has no cheap state read-back. Mic mute
has none of those problems (same soft, reversible, exactly-readable
endpoint property Windows' own mic-mute key sets) and reports three states
— muted / live / unavailable — never guessing.

**Pin-Board Todo — shipped, then promoted to per-project.** `src/todo.js` +
`src/renderer/modules/todo.js`, pure/tested list ops, debounced autosave
that flushes on `cleanup()` instead of dropping the last edit. Shipped
global first (matching the scratchpad's own scoping call), then promoted
2026-08-18 to **one list per project**, keyed by `session.projectId` — a
tab/project switch flushes any pending save under the project it was typed
for first, so mid-edit text can't land on the wrong list.

**Still owed:** manual `npm start` verification on a real desktop of
whether `mic.ps1` resolves a capture endpoint on Mati's machine — the one
thing no unit test can answer.
