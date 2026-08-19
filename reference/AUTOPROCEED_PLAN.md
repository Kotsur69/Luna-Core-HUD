# LunaCore — Auto-proceed (connection-error auto-recovery)

## Goal

Arm a toggle in the Actions section, next to Auto-compact. When ARMED, any
open tab whose stdout shows "API Error: Connection lost mid-response" gets
"continue" injected for it automatically, after a short backoff — with no
God Mode run required. Mati's own words: he tasks something normal, steps
away for a few minutes, and comes back having lost most of that time to a
dead turn nobody noticed.

## Decisions locked in (2026-08-19)

1. **Standalone, not a God Mode sub-feature.** `godmode.js` already has
   near-identical connection-drop recovery (`handleConnectionError`), but
   only for the one tab an active to-do run is bound to. Mati's actual pain
   happens on ordinary, non-God-Mode work — arming a whole unattended
   to-do-runner just to get connection recovery would be the wrong tool for
   the job. This is its own toggle, its own module.
2. **Per-session, not per-active-tab.** `godmode:signal` already carries a
   `sessionId` regardless of which tab is on screen (`main.js:560-565`),
   and `pastePrompt()` already accepts a target `sessionId` — so a
   backgrounded tab recovers exactly like the one Mati is looking at. This
   is the one place this feature diverges from autocompact.js's template
   (which only ever watches the active tab's context stream).
3. **Never double-fires with an active God Mode run.** If godmode.js is
   already driving recovery for a session (armed, not idle/stalled), this
   toggle skips that session entirely (`godmode.js`'s new `isBoundSession()`
   export) — otherwise both would inject "continue" for the same drop.
4. **Off by default, not persisted.** Same reasoning as `autocompact.js`:
   arming it costs a token round-trip per drop, so it's armed deliberately
   each session rather than remembered across restarts.
5. **Module-scope listeners, not mount-scoped.** Deliberate deviation from
   autocompact.js's template, matching the reasoning godmode.js already
   documents for itself: the whole point is surviving a tab nobody is
   looking at, so `onTurnEnd`/`onGodModeSignal` are wired once at import
   time and stay live regardless of whether the toggle's DOM is on screen.
   The armed/disarmed check inside the signal handler is the real gate; the
   visible toggle is the up-front friction, not continuous visibility.

## What already exists and gets reused

- `config/sound-triggers.json`'s `connectionError` category + `main.js`'s
  existing `detectApprovalPrompt(data, triggers.connectionError)` scan
  (`main.js:563-564`) — already broadcasts `godmode:signal
  {sessionId, type: 'connectionError'}` for every session, unconditionally,
  regardless of whether God Mode is armed anywhere. No new detection.
- `window.lunacore.pastePrompt(text, submit, sessionId)` — the same Action
  Injector godmode.js's own `handleConnectionError` uses, just called with
  a bare `'continue'` and no bound-session restriction.
- `autocompact.js`'s toggle shape (module-scope armed flag surviving a
  remount, `.is-armed`/`.is-fired` flash via the shared `.switch-field`
  CSS, `defineWidget` + a `w-actions`-nested `[data-slot]`) — visual and
  structural template for this control.
- `godmode.js`'s retry-cap/backoff numbers (`MAX_CONN_RETRIES`,
  `CONN_BACKOFF_MS`) — same shape, own constants, since this module doesn't
  share godmode.js's state machine.

## New pieces

- `src/renderer/modules/autoproceed.js` (new) — the toggle widget +
  per-session recovery state (`Map<sessionId, {retryCount, lastSignalAt,
  timer}>`, independent per tab). `handleGodModeSignal` gates on
  `autoProceedArmed`, skips `isBoundSession(sessionId)`, dedupes a repeated
  stdout redraw within `SIGNAL_COOLDOWN_MS` (4s), waits `BACKOFF_MS` (5s),
  then injects `continue` and resets the flash. `handleTurnEnd` clears a
  session's retry count on a real recovered turn. Caps at `MAX_RETRIES` (3)
  per stalled turn, same cap godmode.js uses, then gives up quietly.
- `godmode.js`'s new `isBoundSession(sessionId)` export — read-only
  accessor (`sessionId === boundSessionId && phase !== 'idle' && phase !==
  'stalled'`), no behavior change to godmode.js itself.
- `src/renderer/modules/host.js` — `NESTED` map gains `autoproceed:
  'actions'`, alongside the existing `autocompact: 'actions'` entry.
- `src/renderer/index.html` — new `w-autoproceed` template (mirrors
  `w-autocompact` exactly) + a second `[data-slot="autoproceed"]` inside
  `w-actions`.
- `src/renderer/renderer.js` — `import './modules/autoproceed.js';` next to
  the existing `autocompact.js` import.
- `src/renderer/i18n.js` — `autoproceed.label/hint/off/armed/sent`, PL + EN.

## Files touched

- `src/renderer/modules/autoproceed.js` — new.
- `src/renderer/modules/godmode.js` — `isBoundSession()` export.
- `src/renderer/modules/host.js` — `NESTED` map entry.
- `src/renderer/index.html` — template + slot.
- `src/renderer/renderer.js` — import.
- `src/renderer/i18n.js` — PL/EN keys.

## Status

**Shipped 2026-08-19.** Manually verified via `npx electron .
--enable-logging`: mounts cleanly, no console errors, toggle flips to
"armed" with the mode-toggle click sound. `npm test` green throughout (604
tests, unchanged — this feature has no pure-function surface to unit test,
same category as `autocompact.js`/`godmode.js`). Not yet exercised against
a real "Connection lost mid-response" drop in the wild — first real-world
hit is the actual test.
