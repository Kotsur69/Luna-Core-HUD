# LunaCore — Sound & Voice Feedback (Reference)

**Status: shipped, done.** This used to be a 935-line build plan (design +
step-by-step build log + a Q&A transcript with Mati). That's all history now —
the code is the source of truth. This is the compact version: what the
feature does, which files implement it, and what to touch if you want to mess
with it. Compacted 2026-08-12.

---

## 1. What it does

Two independent categories, both **local-only feedback** per the zero-token
rule (`LUNA_HUD_SPECIFICATION.md` §1) — no CLI data read for the SFX/canned
clips, no network call ever, no model involved:

- **SFX + canned voice clips** — short pre-recorded audio files (`.wav`/`.mp3`)
  fired on specific UI/session events (§3).
- **Live narration (opt-in)** — reads the assistant's last turn aloud using
  real, dynamically synthesized speech (not a canned clip). Off by default
  (`soundReadOutputEnabled`).

---

## 2. Engine: mpv, one persistent process

One `mpv --idle` process per channel, spawned once at app boot and controlled
over its JSON IPC pipe (named pipe on Windows, unix socket elsewhere) — not a
spawn-per-sound. A keystroke sound fired at typing speed would otherwise spawn
10–20 OS processes per second; instead every `play()` call after boot is a
sub-millisecond local IPC write.

**Two channels, two mpv instances:** the default channel (SFX + canned voice
clips) and a separate `voice` channel (live narration), so a keystroke tick
can't cut off a multi-sentence readout mid-sentence.

**Live narration specifically** uses Windows SAPI (`System.Speech`) via a
fixed PowerShell script — fully offline, no network, no npm dependency. It
synthesizes to a temp `.wav`, then plays that through the `voice` mpv channel
like any other file.

**Fails silent + loud-once:** if `mpv` isn't on `PATH`, one console warning
logs and every `play()` call becomes a permanent no-op. Same principle for a
PowerShell/SAPI failure — narration is silently skipped. Neither path ever
crashes or blocks the app.

---

## 3. Event → trigger map

| Event | Sound key | Notes |
|---|---|---|
| Keystroke in terminal | `sfx.keystroke` | Throttled to 55ms; 4 selectable variants (mechanical/soft/scifi/typewriter) |
| Nav click (tabs, buttons) | `sfx.navClick` | |
| Theme/language switch | `sfx.modeToggle` | |
| New terminal tab | `sfx.terminalNew` | |
| Terminal tab closed | `sfx.terminalClose` | |
| App startup | `voice.welcome` | |
| Approval prompt appears in PTY output | `voice.needYou` | Fires once per prompt *appearance*, not once per stdout chunk. Matched against phrase list in `config/sound-triggers.json` |
| Assistant turn ends, ran long enough | `voice.done` | Gated by `soundLongTaskMinutes` — short back-and-forth turns stay silent |
| Usage crosses 50% / 80% | `voice.usage50` / `voice.usage80` | Fires once per fresh threshold crossing, debounced both ways |
| Read-output-aloud (opt-in) | *(live SAPI synthesis, no fixed key)* | Reads the assistant's last turn text, extracted/cleaned by `ttsExtract.js`, capped at 1500 chars |

---

## 4. Files

| File | Role |
|---|---|
| `src/soundManager.js` | Owns one `mpv --idle` process + its JSON IPC pipe (`SoundManager` class) |
| `src/sounds.js` | Loads `config/sounds.json`, resolves an event key (`'sfx.navClick'`, `'voice.done'`) → `{path, volume}` |
| `config/sounds.json` | SFX/voice event → `{file, volume}` map (`sfx.keystroke` instead carries a `variants` array) |
| `src/soundTriggers.js` | Loads `config/sound-triggers.json` |
| `config/sound-triggers.json` | The exact PTY-output phrases that count as "approval prompt shown" |
| `src/renderer/modules/sound.js` | Renderer-side trigger helpers (`sfx.*`, `voice.*`), owns the keystroke throttle |
| `src/tts.js` | `synthesizeToWav(text)` — spawns the PowerShell script, returns a temp `.wav` path |
| `src/ttsExtract.js` | Pure text extraction for narration: `extractSpokenText()`, `stripMarkdown()`, `capLength()` |
| `helpers/tts/sapi-speak.ps1` | The actual Windows SAPI invocation |
| `helpers/sounds/{sfx,voice}/` | The audio assets themselves |

---

## 5. Preferences (`src/uiprefs.js`, persisted in `config/ui.local.json`)

| Key | Default | Meaning |
|---|---|---|
| `soundEnabled` | `true` | Master on/off for both channels |
| `soundVolume` | `70` | 0–100, applied to both mpv channels |
| `soundKeystrokeVariant` | `'mechanical'` | Which of the 4 keystroke clips |
| `soundLongTaskMinutes` | `10` | Minimum turn length before `voice.done` fires |
| `soundReadOutputEnabled` | `false` | Opt-in live narration toggle |

---

## 6. Testing

Pure functions only, `node --test` — matches the project-wide convention of
testing logic, not OS/DOM wrappers:

- `src/sounds.js` → `pickSoundEntry()`
- `src/ttsExtract.js` → `extractSpokenText()`, `stripMarkdown()`, `findTurnEndMessage()`, `capLength()`
- `config/sounds.json`/`config/rates.json` **data** tests (shipped config actually contains what the code expects)

`soundManager.js` and `tts.js` are thin OS-process wrappers — same
not-unit-tested category as `PortWatcher`/`UsageWatcher` — verified manually
via `npx electron . --enable-logging`, once with `mpv` on `PATH` and once with
it removed.
