# LunaCore - "God Mode" (unattended to-do runner)

## Goal

Arm a toggle on the active tab. LunaCore then works through that tab's
to-do list one item at a time - inject, wait for Claude to finish, tick
done, inject the next - surviving usage-limit walls and dropped
connections on its own, so Mati can walk away for hours and come back to
a finished (or stalled-with-a-reason) list.

## Decisions locked in (2026-08-19)

1. **Ambiguous stop = auto-nudge.** Every injected to-do gets a fixed
   suffix telling Claude to use its own judgement and not stop to ask -
   because `onTurnEnd` (see below) cannot tell "task done" apart from
   "Claude is waiting on a clarifying answer," and a silently-abandoned
   task discovered 5 hours later is worse than a slightly bossier prompt.
2. **Connection-lost recovery = send "continue".** Not a resend of the
   original task text - the context is intact, this is a nudge, not a
   restart.
3. **Usage-limit handling = keep cycling for the whole run.** Not a single
   wait-then-stop. Pause, wait out the reset, resume, repeat - as many
   times as it takes to clear the list or run out of tasks.
4. **Scope for v1 = active tab only.** One God Mode run at a time, tied to
   whichever tab has it armed. Per-tab arming (parallel runs on multiple
   tabs) is a possible v2, not now.
5. **Arming is gated behind a confirm dialog, every time.** Not a
   one-time setting or a plain toggle-click - clicking ARM opens a modal
   ("Are you sure?" / Yes / No, plain copy per Mati) and only a Yes
   actually starts the run. This is the deliberate friction point: God
   Mode can burn tokens across an unattended multi-hour, multi-session
   run, so it must never arm from a stray click the way autocompact's
   toggle can.

## What already exists and gets reused (no new mechanism needed)

- `window.lunacore.pastePrompt(text, submit, sessionId)` (preload.js) -
  injects text into a tab's PTY and hits Enter when `submit` is true.
  Already wired to the to-do widget's inject (`⚡`) button
  (`src/renderer/modules/todo.js`).
- `window.lunacore.onTurnEnd(({sessionId, turn}) => ...)` (preload.js,
  fed by `TranscriptWatcher.onTurnEnd` in `src/observer.js` via
  `src/main.js`) - fires when the assistant's turn is STRUCTURALLY done
  (`stop_reason` present and not `"tool_use"`, read straight from the
  JSONL transcript). This is the "task finished, send the next one"
  signal - reliable because it reads CC's own structured output, not a
  text-scrape of the TUI.
- `detectApprovalPrompt(raw, patterns)` (`src/observer.js`) +
  `config/sound-triggers.json` - the established pattern for recognizing
  literal substrings in CC's raw TUI stdout. Currently only has an
  `approvalPrompt` category (drives the "needs your input" sound). God
  Mode adds two sibling categories to the same config file rather than
  inventing a new detection mechanism.
- `autocompact.js` - the armed-toggle + edge-triggered auto-injection
  shape (module-scope armed flag that survives a remount, edge/cooldown
  guards, a visible ARMED status, disarm at any time) is the template for
  God Mode's own arm/fire logic. God Mode is the second consumer of this
  shape, not a new pattern.
- `notify.js` / the existing sound cues - reused for "list finished" and
  "stalled, need you" pings, same as the existing long-task/all-done
  chime.

## New pieces

### 1. Config: two new trigger categories

`config/sound-triggers.json` gains:

```json
{
  "approvalPrompt": [ ... existing ... ],
  "usageLimit": [ /* literal substrings CC prints on hitting the 5h wall */ ],
  "connectionError": [ "API Error: Connection lost mid-response" ]
}
```

`connectionError` has one confirmed real sample already (from the
2026-08-18 session transcript): `"API Error: Connection lost mid-response.
The response above may be incomplete."`

`usageLimit` still needs a real captured sample - the literal text CC
prints when the 5-hour window is actually exhausted (not the harness's
own "[Usage limit approaching. Checkpoint now...]" hint, which is a
different, softer message and not the hard wall). Plan: start with a
best-guess default list, and swap in Mati's own pasted text the first
time he sees it for real - same "data, not code, because CC's TUI text
changes between releases" reasoning `sound-triggers.json` already
documents.

If CC's usage-limit message carries a reset time (it usually does -
"resets 3pm" - style text), that gets parsed for the actual wait length;
otherwise God Mode falls back to a fixed re-check interval (poll every
few minutes) until output starts flowing again.

### 2. `src/renderer/modules/godmode.js` (new widget/module)

State machine, module-scope (survives remount, same reasoning as
`autoCompactArmed`):

- `armed` (bool) - the toggle.
- `queue` - derived from the active tab's open to-dos at arm time (NOT a
  live-recompute on every render, so a to-do added mid-run doesn't jump
  the queue - open question, see below).
- `phase`: `idle | running | waiting-limit | waiting-connection | stalled`.
- `currentItem` - the to-do currently injected and awaiting `onTurnEnd`.
- `retryCount` - per-item, for the connection-error backoff cap.

Flow:

1. Arm -> snapshot open to-dos for the active session -> inject item 1
   (`pastePrompt(text + autonomyNudge, true)`).
2. `onTurnEnd` for THIS session while `phase === 'running'`:
   - Tick the item done (`toggleTodo`).
   - If queue empty -> disarm, notify "God Mode: list finished".
   - Else inject the next item.
3. Raw stdout for this session matches `usageLimit` pattern while
   `phase === 'running'`:
   - `phase = 'waiting-limit'`. Wait (parsed reset time or poll
     interval). On resume, re-inject the CURRENT item (not skipped, not
     assumed done) and go back to `running`.
4. Raw stdout matches `connectionError` pattern:
   - `phase = 'waiting-connection'`. Short backoff, `pastePrompt('continue',
     true)`. Cap retries (e.g. 3) before giving up and going to
     `stalled` + notify - an infinite retry loop on a truly dead session
     is worse than surfacing it.
5. Disarm at any time (mouse click, same as autocompact) -> stop
   injecting, leave whatever is mid-flight alone.

### 3. UI

A toggle + status line, most likely living in the To-do widget itself
(right under the existing clear-done button) rather than the Actions
panel - it is very specifically "run THIS list," not a global HUD
setting. Status states mirror autocompact's `.is-armed`/fired flash
pattern: `off / armed / running (n left) / waiting for limit reset /
waiting for connection / stalled - needs you`.

Clicking the toggle does NOT arm directly - it opens a confirm modal
first (reusing the app's existing overlay/backdrop/modal shape, the same
one `#palette` and `#gitquick` already use). Plain copy: a short "Are you
sure?" message plus how many open to-dos are queued, and Yes / No
buttons. Only Yes calls the actual arm step above. No code path arms God
Mode without going through this modal - not the toggle's `change` event
directly, so a future dev adding a second way to trigger it (a hotkey,
say) has to route through the same confirm, not bypass it.

## Resolved during build (2026-08-19)

- **Queue: live, not a snapshot.** `godmode.js` never caches its own copy of
  the list - every step calls `window.lunacore.getTodos(sessionId)` /
  `saveTodos(...)` fresh. A task added or edited mid-run just joins the run;
  there is no separate queue to desync from the widget.
- **Confirm popup: a NATIVE OS dialog (`dialog.showMessageBox`), not a custom
  in-page modal.** Simpler and more robust than hand-rolling an
  overlay/backdrop/focus-trap (nothing `#palette`/`#gitquick`-shaped was
  reused after all), genuinely modal so no stray click behind it can double-
  arm, and it is literally the "popup window, are you sure, yes/no" Mati
  asked for. PL/EN text picked from `readUiPrefs().lang`. Skipped entirely
  (never opens) when the list has 0 open items - nothing to confirm.
- **`usageLimit` patterns are a best guess, not a captured sample.** Seeded
  with `["usage limit reached", "Usage limit reached", "5-hour limit
  reached"]` in `config/sound-triggers.json`. `connectionError` has the one
  real confirmed string from the 2026-08-18 transcript. Swap in the real
  usage-limit text the next time Mati sees the actual wall - same "data, not
  code" reasoning the file already documents. No reset-time parsing in v1
  (the real message format is still unknown); the fallback is a fixed
  5-minute re-nudge poll (`LIMIT_POLL_MS`) while `waiting-limit`.
- **Connection-error retry cap: 3**, then `stalled` + `voice.needYou()`.
  5s backoff between attempts (`CONN_BACKOFF_MS`).
- **Autonomy-nudge suffix: fixed and global**, not per-item - one constant
  (`AUTONOMY_NUDGE`) appended to every injected task.
- **Listener scope deliberately deviates from `autocompact.js`'s template.**
  Autocompact's injecting subscription lives inside `mount()` on purpose (an
  unmounted widget can't inject invisibly). God Mode's whole point is
  surviving exactly the "not looking at it" case, so its `onTurnEnd` /
  `onGodModeSignal` listeners are registered ONCE at module scope in
  `godmode.js` and keep running whether or not the To-do widget is on
  screen. The safety counterweight is the confirm-gate at arm time, not
  continuous visibility.
- **No new widget/layout slot.** `godmode.js` exports one function,
  `mountGodModeControl(root)`, called from `todo.js`'s own `mount()` - the
  toggle+status markup lives inside `w-todo`'s `<template>` in index.html, so
  it is structurally part of the To-do widget, not a separately placed panel.

## Files touched

- `config/sound-triggers.json` - `usageLimit` + `connectionError` arrays.
- `src/soundTriggers.js` - loads all three pattern lists now.
- `src/main.js` - `spawnInto()`'s `proc.onData` also scans for the two new
  categories and `send()`s `godmode:signal`; new `ipcMain.handle('godmode:confirm', ...)`
  using `dialog.showMessageBox`; the `--luna-probe` widget-probe script grew
  a `godmode` marker (`#godmode-toggle`) alongside the existing `todo` one.
- `src/preload.js` - `onGodModeSignal`, `confirmGodMode`.
- `src/renderer/modules/godmode.js` - new, the whole state machine.
- `src/renderer/modules/todo.js` - imports and mounts/unmounts the control.
- `src/renderer/index.html` - toggle + status markup inside `w-todo`.
- `src/renderer/styles.css` - `.godmode-field` spacing, `.switch-field.is-stalled`.
- `src/renderer/i18n.js` - `godmode.*` keys, PL + EN.

## Status

Built. Verified with `--luna-probe` (headless widget-contract check): the
God Mode toggle mounts exactly once, survives 3 remount passes across all 4
layout presets and every theme, no token leaks. Manual smoke-test still
needed for the parts the probe cannot reach - actually clicking ARM with
todos queued, confirming the native Yes/No dialog, watching an item get
injected and ticked done, and (whenever the real wall text is known)
`usageLimit` detection.
