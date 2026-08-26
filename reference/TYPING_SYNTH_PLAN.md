# LunaCore — Typing Synth (v1: user keystrokes only)

## Goal

Replace the static keystroke `.wav` clips with a live Web Audio synth that
pitches and decays with typing speed — deep/slow for a deliberate pace,
tight/fast as typing speeds up. From `CONCEPT_TYPING_SYNTH.md`.

## Decisions locked in (2026-08-19)

1. **v1 scope = user typing only.** Not the "agent output stream" texture
   layer, not the LED/scanline visual sync the concept doc also sketches.
   Both stay v2 candidates. Same "ship the core, defer the fun stuff"
   pattern the rest of this project follows.
2. **New engine, not a new keystroke variant.** The existing
   `soundKeystrokeVariant` picks one of 4 `.wav` files played through the
   mpv pipeline (`config/sounds.json` → IPC → main process →
   `soundManager.js`). A synth has no file and needs no IPC round-trip —
   it's a sibling engine, not a 5th variant entry.
3. **CORRECTED 2026-08-19 — the `onData` gate was never the bug.**
   Instrumented `terminals.js`'s `onData` directly (`npx electron .
   --enable-logging`): every real keystroke arrives as a clean length-1
   chunk, no ConPTY batching observed. The only non-length-1 chunks seen
   were terminal focus in/out escapes (`\x1b[I` / `\x1b[O`, length 3),
   which the existing gate already excludes correctly. **Do not "fix" this
   gate — it is not broken.** The real "works once then goes silent" bug
   is downstream, somewhere between `sfx.keystroke()` firing (confirmed
   correct on every keystroke) and actual mpv playback — narrowed but not
   found; see `lunacore_keystroke_sound_bug` memory for the last state.
   Whatever it is, it blocks the synth too, since both engines would still
   share this same trigger point once fixed.
4. **`AudioContext` created lazily**, on the first real keystroke — not at
   module load. Browsers require a user gesture before audio can start, and
   an eager top-level side effect in a renderer module is exactly the bug
   class just fixed in `godmode.js` this same morning (breaks if the module
   is ever pulled into a Node test context).

## What already exists and gets reused

- `instance.onData` in `src/renderer/modules/terminals.js:174` — the one
  and only Action Injector trigger point for keystroke sound. Gets fixed,
  not replaced.
- `sfx.keystroke()` in `src/renderer/modules/sound.js` — becomes
  engine-aware (reads a new pref, same pattern it already uses for
  `keystrokeVariant`) rather than being duplicated.
- `soundKeystrokeVariant`'s validation shape in `src/uiprefs.js`
  (allowlist constant + `DEFAULTS` entry + `applyPartialUiPrefs` handling)
  — the new `soundKeystrokeEngine` pref follows the identical pattern.
- `termcustom.js`'s Settings-overlay sound section — the new Engine control
  sits next to the existing keystroke-variant `<select>`, wired the same
  way (`els.*` lookup, `change` listener, `window.lunacore.setUiPrefs`).
- The "pure function tested, OS/DOM wrapper manual-verified" split
  `src/sounds.js`'s `pickSoundEntry()` already establishes
  (`reference/SOUNDS_IMPLEMENTATION_PLAN.md` §6) — the WPM→sound mapping
  is pure and tested; the actual `AudioContext` graph is not.

## New pieces

### 1. Find and fix the real sound-playback bug (blocking, replaces the old §1)

Not an `onData` fix (see decision #3 — that gate is fine as-is). The break
is somewhere in `sfx.keystroke()` → IPC → `main.js`'s `sound:play` handler →
`resolveSoundFile()` → `soundManager.play()`'s gate (`enabled` /
`available` / `fs.existsSync`) → mpv. Four-checkpoint console logging was
added at each hop and then removed again once the trace confirmed the
`terminals.js` gate is clean — next session should re-add it starting
downstream of that gate rather than re-proving it.

### 2. `src/renderer/modules/keysynth.js` (new)

- **Pure, tested**: inter-keystroke delay (ms) → `{frequency, decayMs}`,
  plus the paste-vs-typing chunk-length classifier.
- **Manual-verified only**: the `AudioContext` / `OscillatorNode` /
  `GainNode` / `BiquadFilterNode` graph and playback — square wave +
  bandpass filter + sharp amplitude envelope per the concept doc's "warm
  mechanical click" description.

### 3. `soundKeystrokeEngine` preference

`'sample' | 'synth'`, default `'sample'` — no behavior change for existing
installs. `src/uiprefs.js` (validation + default), `termcustom.js` +
`index.html` + `i18n.js` (PL/EN) for the UI control.

## Resolved question (2026-08-19)

What's the real `onData` chunk-size distribution for genuine fast typing
vs. an actual paste? **Answered**: real typing is always clean length-1
chunks. A paste-vs-typing classifier is therefore unnecessary — pastes
were never the risk, the length-1 gate already naturally excludes anything
bigger. This closes what §1 used to call the "open question."

## Files touched

- `src/renderer/modules/keysynth.js` — new.
- `src/renderer/modules/sound.js` — `sfx.keystroke` engine switch.
- `src/uiprefs.js` — `soundKeystrokeEngine` pref.
- `src/renderer/modules/termcustom.js` — Engine control.
- `src/renderer/index.html` — control markup.
- `src/renderer/i18n.js` — PL/EN keys.

(`terminals.js` no longer needs a change here — see decision #3.)

## Status

**Paused 2026-08-19.** Root-caused as far as "not the `onData` gate,
somewhere in the IPC→main→soundManager→mpv chain" and then set aside in
favor of the Auto-proceed feature (`AUTOPROCEED_PLAN.md`), which Mati
judged higher-value: connection drops during real work cost him time
directly, a silent keystroke click does not. Pick up at §1 above.

## Resolved 2026-08-26 — shipped, but not as planned above

Picked back up and shipped in one day, in three passes. The final shape
diverges from most of this plan's "New pieces" section — worth reading as
history, not as what got built.

**Pass 1 — bypass, not fix.** The IPC→main→soundManager→mpv break from §1
was never found. Instead of hunting it further, `src/renderer/modules/
keysynth.js` (new) replaced `sfx.keystroke()` outright for every install —
not the planned `soundKeystrokeEngine: 'sample' | 'synth'` toggle (decision
#2/§3 above). There is no synth/sample switch and no `uiprefs.js`/`i18n.js`
change; the old mpv keystroke path (`config/sounds.json`'s 4 `.wav`
variants, `helpers/sounds/sfx/keystroke-*.wav`) is simply dead now — see
`helpers/sounds/README.md`. `terminals.js`'s `onData` gate stayed exactly
as decision #3 said: not broken, not touched.

**Pass 2 — sample-based, not oscillator-based.** Mati liked
github.com/nathan-fiscaletti/keyboardsounds's mechanic (random pitch shift
per hit from a real sample pack) more than a synthesized tone, however
modulated. `keysynth.js` was rewritten around real recordings
(`assets/keysounds/*.mp3`/`.wav`, new) instead of the
`OscillatorNode`/`BiquadFilterNode` graph §2 describes — an onset-detecting
RMS-envelope slicer cuts each multi-keystroke recording into individual
~140ms hits at load time, normalized to a consistent peak (raw recordings
sit well under full scale, unlike an oscillator's always-±1 output — silent
otherwise regardless of gain). WPM-based pitch/decay (this doc's §2.1,
"acoustic acceleration") became the base rate, with random jitter on top.
The agent-output-stream texture from §2.2 (deferred as v2 in decision #1)
*was* built this same day, staying oscillator-based as originally
sketched — out of scope for the sample rework since it was never reported
as "generic."

**Pass 3 — the actual silent-audio bug, unrelated to either pass above.**
After pass 2, Mati reported the sound as still barely audible. Two
AI-proposed fixes (peak normalization, then reworking the slicer to be
onset-triggered instead of duration-gated) were each verified against the
real asset files via a headless-Electron diagnostic script - and were
real, worthwhile fixes - but didn't change what Mati heard, because
neither addressed the actual bug: `index.html`'s CSP (`connect-src
'none'`, documented there as a deliberate "renderer structurally cannot
reach the network" invariant) was silently blocking every `fetch()` of the
local asset files, `.catch(() => [])` hiding the failure with no trace.
Found by launching with `--enable-logging` and reading the console instead
of guessing a third time. Fixed by routing the read through IPC instead of
loosening that CSP invariant: `main.js` gained `ipcMain.handle('keysynth:
read', ...)` (reads `assets/keysounds/<basename>`, sanitized), `preload.js`
exposes `window.lunacore.readKeysound(name)`, `keysynth.js` calls that
instead of `fetch()`. Load failures now `console.error` instead of
disappearing.

**Since then**: a mouse-click sound (same sample-pool/random-pitch
mechanic, wired to every click in the HUD via `termcustom.js`) was added
and then removed the same day - Mati found it "kinda annoying quickly."
The 3 files it used (ATM/secret-code/security-code) were kept and became 3
more keyboard variants instead (`atm`/`secretcode`/`securitycode`),
sharing the same onset-slicer as the other 4 packs. **7 keyboard variants
ship in total.** Full history: `lunacore_keystroke_sound_bug` memory.
