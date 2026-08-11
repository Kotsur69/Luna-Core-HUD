# LunaCore — Sound & Voice Feedback Implementation Plan

## 0. Grounding: how this fits the existing architecture

Before any code: this repo has a hard rule (see `FUTURE_PLAN.md`) — **ZERO EXTRA
TOKENS**. Every feature is either a **Passive Observer** (reads stdout/files) or
an **Action Injector** (writes plain text to PTY stdin). Sound is neither — it's
a third, purely local category — but it must be wired the same disciplined way
the rest of the app is:

- Main process owns anything that touches the OS (child processes, fs). Sound
  playback is a child process (`mpv`), so **the audio engine lives in `main.js`
  + a new `src/soundManager.js`**, exactly like `usage.js`/`ports.js` own their
  own OS-facing work.
- Renderer never gets raw Node access (`contextIsolation: true`, `nodeIntegration:
  false`). It asks for a sound the same way it asks for anything else — through
  `window.lunacore.*` in `preload.js`, one narrow method.
- Config-driven, not hardcoded: this repo already keeps *content* in
  `config/*.json` (`cheatsheets.json`, `themes.json`, `rates.json`) and *loaders*
  in matching `src/*.js` files (`loadCheatsheets()`, `loadThemes()`). Sound event
  → file mappings and volumes get the same treatment: `config/sounds.json` +
  `src/sounds.js`.
- Preferences persist the way theme/lang/boot already do: validated read/write
  in `uiprefs.js`, defaults on missing/corrupt data, never throw.
- Renderer-side, anything with mount/unmount state follows the widget contract
  (`registry.js` `defineWidget`) or the plain-module pattern (`bus.js`,
  `led.js`) depending on whether it owns DOM. The sound trigger module owns no
  DOM, so it's a **plain service module**, imported by the modules that already
  own the click handlers — no new global click-scraper, no new coupling.

## 1. Audio engine: mpv as a persistent `--idle` instance, not spawn-per-sound

**Do not spawn a new `mpv` process per sound event.** A key-click sound fired at
typing speed (10–20/sec) would spawn 10–20 OS processes per second — process
creation overhead (~10–30 ms on Windows) plus audio-device contention would
cause audible lag and eventually dropped/garbled playback. This is the one
detail in the original brief (`mpv --no-video --no-terminal --no-config` spawned
per event) that needs correcting before writing any code.

**Correct design:** start ONE long-lived `mpv --idle` process when LunaCore
boots, controlled over its **JSON IPC socket** (`--input-ipc-server=<pipe>`).
Every sound event becomes a `loadfile` command sent over that socket — a few
KB over a named pipe, not a process spawn. This is mpv's documented scripting
interface (`mpv(1)`, `--input-ipc-server`, `docs/ipc.rst` in the mpv repo).

### 1.1 `src/soundManager.js` (new file, main process)

```js
// ============================================================================
// LunaCore - Sound Manager (mpv audio engine)
// ----------------------------------------------------------------------------
// Owns ONE persistent `mpv --idle` process, controlled over its JSON IPC pipe.
// Every playSfx()/playVoice() call sends a `loadfile` command down that pipe -
// no per-event process spawn (see SOUNDS_IMPLEMENTATION_PLAN.md §1 for why).
//
// Fails silent + loud-once: if mpv is not on PATH, the manager logs ONE warning
// and every subsequent play() call becomes a no-op. The HUD must never crash or
// block because a sound file is missing or mpv isn't installed - same
// degrade-gracefully rule usage.js follows for a dead network.
// ============================================================================

'use strict';

const { spawn } = require('child_process');
const net = require('net');
const os = require('os');
const path = require('path');
const fs = require('fs');

const IS_WINDOWS = process.platform === 'win32';

// Windows: named pipe (no filesystem entry). POSIX: unix socket path in tmpdir.
const IPC_PATH = IS_WINDOWS
  ? `\\\\.\\pipe\\lunacore-mpv-${process.pid}`
  : path.join(os.tmpdir(), `lunacore-mpv-${process.pid}.sock`);

class SoundManager {
  /** @param {{volume?: number}} [opts] volume: 0..100, default 70 */
  constructor(opts = {}) {
    this.volume = clampVolume(opts.volume);
    this.enabled = true; // user toggle (Preferences); see §5
    this.available = false; // becomes true once mpv --idle is confirmed alive
    this.proc = null;
    this.sock = null;
    this.warned = false;
    this.pending = []; // commands queued while the IPC socket is still connecting
  }

  /** Spawns `mpv --idle` and opens the IPC socket. Call once at app startup. */
  start() {
    let mpvPath;
    try {
      mpvPath = resolveMpv(); // throws if not found - see resolveMpv() below
    } catch {
      this._warnOnce('mpv not found on PATH - sound feedback disabled (silent fallback)');
      return;
    }

    this.proc = spawn(
      mpvPath,
      [
        '--idle=yes',
        '--no-video',
        '--no-terminal',
        '--no-config',
        `--input-ipc-server=${IPC_PATH}`,
        `--volume=${this.volume}`,
      ],
      { stdio: 'ignore' },
    );

    this.proc.on('error', () => this._warnOnce('mpv failed to start - sound feedback disabled'));
    this.proc.on('exit', () => {
      this.available = false;
      this.sock = null;
    });

    // mpv needs a moment to create the pipe/socket before we can connect.
    setTimeout(() => this._connect(), 400);
  }

  _connect(attempt = 0) {
    const sock = net.createConnection(IPC_PATH);
    sock.on('connect', () => {
      this.sock = sock;
      this.available = true;
      for (const cmd of this.pending.splice(0)) this._send(cmd);
    });
    sock.on('error', () => {
      if (attempt < 5) setTimeout(() => this._connect(attempt + 1), 300);
      else this._warnOnce('could not reach mpv IPC socket - sound feedback disabled');
    });
  }

  _send(commandObj) {
    if (!this.sock) {
      this.pending.push(commandObj);
      return;
    }
    try {
      this.sock.write(JSON.stringify(commandObj) + '\n');
    } catch {
      /* pipe closed mid-write - next play() call will re-warn if still dead */
    }
  }

  _warnOnce(msg) {
    if (this.warned) return;
    this.warned = true;
    console.warn(`[soundManager] ${msg}`);
  }

  /**
   * Plays a resolved absolute file path. `replace` (default) cuts off whatever
   * is currently playing - correct for short UI blips; pass `append-play` for
   * voice lines that should queue instead of clipping each other (used by the
   * usage-threshold announcer so 50% and 80% never overlap-cut).
   */
  play(filePath, { mode = 'replace' } = {}) {
    if (!this.enabled || !fs.existsSync(filePath)) return;
    this._send({ command: ['loadfile', filePath, mode] });
  }

  setEnabled(enabled) {
    this.enabled = !!enabled;
  }

  setVolume(vol) {
    this.volume = clampVolume(vol);
    this._send({ command: ['set_property', 'volume', this.volume] });
  }

  stop() {
    if (this.proc) {
      try {
        this.proc.kill();
      } catch {
        /* already dead */
      }
    }
    this.proc = null;
    this.sock = null;
  }
}

function clampVolume(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : 70;
}

/** Finds mpv on PATH, or at a user-configured override. Throws if absent. */
function resolveMpv() {
  const override = process.env.LUNACORE_MPV_PATH;
  if (override && fs.existsSync(override)) return override;
  // Rely on PATH resolution - `spawn` on Windows needs the .exe resolved by the
  // shell, so probe with `where`/`command -v` rather than trusting a bare name.
  const { execSync } = require('child_process');
  const probe = IS_WINDOWS ? 'where mpv' : 'command -v mpv';
  try {
    const out = execSync(probe, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    const first = out.split(/\r?\n/)[0];
    if (first) return first;
  } catch {
    /* not found */
  }
  throw new Error('mpv not found');
}

module.exports = { SoundManager };
```

**Why a socket instead of `spawn()` per clip, in one sentence:** one process
absorbs the ~50–150 ms mpv startup cost exactly once at app boot, and every
subsequent trigger is a sub-millisecond local IPC write.

### 1.2 Wiring into `main.js`

```js
// near the other Passive Observer imports:
const { SoundManager } = require('./soundManager');
const { loadSoundConfig, resolveSoundFile } = require('./sounds'); // §2

let soundManager = null;

// in app.whenReady().then(...), alongside startPortWatcher()/startUsageWatcher():
soundManager = new SoundManager({ volume: readUiPrefs().soundVolume });
soundManager.setEnabled(readUiPrefs().soundEnabled !== false);
soundManager.start();

// in window-all-closed, alongside the other teardown calls:
if (soundManager) soundManager.stop();
```

## 2. Sound event mapping + config

### 2.1 Directory structure (as requested)

```
helpers/
  sounds/
    sfx/
      keystroke.wav        # short mechanical/sci-fi click, <80ms
      nav-click.wav        # UI click: tab switch, panel toggle, button press
      mode-toggle.wav      # distinct blip for theme/lang/compact-mode switch
      terminal-new.wav     # new tab/session created
      terminal-close.wav   # tab closed
    voice/
      welcome-mati.mp3     # "Welcome Mati"
      need-you.mp3         # "Mati, I need you for a sec"
      done.mp3             # "Done" (+ optional chime layered in the file itself)
      usage-50.mp3         # "50% usage limit crossed"
      usage-80.mp3         # "5 hour usage limit is close to cross"
```

`helpers/` is a new top-level directory (assets only, no code) — deliberately
kept next to `config/` rather than under `src/` so it reads as *data*, matching
how `config/*.json` already sits outside `src/`.

### 2.2 `config/sounds.json` (new — mirrors `config/cheatsheets.json`'s shape)

```json
{
  "sfx": {
    "keystroke":     { "file": "sfx/keystroke.wav",      "volume": 35, "throttleMs": 55, "enabled": true },
    "navClick":      { "file": "sfx/nav-click.wav",       "volume": 55 },
    "modeToggle":    { "file": "sfx/mode-toggle.wav",     "volume": 60 },
    "terminalNew":   { "file": "sfx/terminal-new.wav",    "volume": 65 },
    "terminalClose": { "file": "sfx/terminal-close.wav",  "volume": 65 }
  },
  "voice": {
    "welcome":  { "file": "voice/welcome-mati.mp3", "volume": 85 },
    "needYou":  { "file": "voice/need-you.mp3",     "volume": 90 },
    "done":     { "file": "voice/done.mp3",         "volume": 80 },
    "usage50":  { "file": "voice/usage-50.mp3",     "volume": 90 },
    "usage80":  { "file": "voice/usage-80.mp3",     "volume": 95 }
  }
}
```

`volume` per clip lets a quiet keystroke tick coexist with a voice line that
must cut through — mpv's `--volume` on the shared instance sets a *global*
level (§1), so per-clip volume is applied via the `loadfile` command's options
string (`file,replace,volume=35`) rather than the global property.

### 2.3 `src/sounds.js` (new — loader, same shape as `loadCheatsheets()`)

```js
'use strict';

const fs = require('fs');
const path = require('path');

const CONFIG_DIR = path.join(__dirname, '..', 'config');
const ASSETS_DIR = path.join(__dirname, '..', 'helpers', 'sounds');
const FILE = path.join(CONFIG_DIR, 'sounds.json');

let cache = null;

/** Loads config/sounds.json once; missing/corrupt file -> empty {sfx:{}, voice:{}}. */
function loadSoundConfig() {
  if (cache) return cache;
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    cache = { sfx: raw.sfx || {}, voice: raw.voice || {} };
  } catch {
    cache = { sfx: {}, voice: {} };
  }
  return cache;
}

/** Resolves an event key ('sfx.keystroke' or 'voice.done') to an absolute path + volume. */
function resolveSoundFile(key) {
  const [group, name] = String(key).split('.');
  const cfg = loadSoundConfig();
  const entry = cfg[group] && cfg[group][name];
  if (!entry || typeof entry.file !== 'string' || entry.enabled === false) return null;
  const full = path.join(ASSETS_DIR, entry.file);
  if (!fs.existsSync(full)) return null; // missing asset -> silent no-op, not a crash
  return { path: full, volume: typeof entry.volume === 'number' ? entry.volume : 70 };
}

module.exports = { loadSoundConfig, resolveSoundFile };
```

## 3. IPC bridge (renderer → main), following the exact existing pattern

### 3.1 `preload.js` addition

```js
// --- Sound feedback ---
/** Fires a UI sound/voice cue by key, e.g. 'sfx.navClick', 'voice.done'. */
playSound: (key) => ipcRenderer.send('sound:play', key),
```

(No new getters needed — sound prefs ride the *existing* `ui:get`/`ui:set`
channels, extended in `uiprefs.js`, §5.)

### 3.2 `main.js` — `registerIpc()` addition

```js
// Sound feedback: renderer never touches mpv directly (contextIsolation).
ipcMain.on('sound:play', (_event, key) => {
  if (!soundManager || typeof key !== 'string') return;
  const resolved = resolveSoundFile(key);
  if (resolved) soundManager.play(resolved.path);
});
```

### 3.3 `src/renderer/modules/sound.js` (new — plain service module, no DOM)

This is the single renderer-side entry point every other module calls. It
owns the keystroke **throttle** (the one place spam-prevention logic lives) so
callers don't each reinvent it.

```js
'use strict';

// Per-key cooldown so a burst (fast typing, rapid tab-clicking) can't flood
// the IPC channel / mpv socket. Keyed by sound name so keystroke's 55ms
// cooldown doesn't also throttle an unrelated nav click.
const lastFired = new Map();

function playSound(key, { throttleMs = 0 } = {}) {
  if (throttleMs > 0) {
    const now = Date.now();
    const last = lastFired.get(key) || 0;
    if (now - last < throttleMs) return;
    lastFired.set(key, now);
  }
  window.lunacore.playSound(key);
}

export const sfx = {
  keystroke: () => playSound('sfx.keystroke', { throttleMs: 55 }),
  navClick: () => playSound('sfx.navClick'),
  modeToggle: () => playSound('sfx.modeToggle'),
  terminalNew: () => playSound('sfx.terminalNew'),
  terminalClose: () => playSound('sfx.terminalClose'),
};

export const voice = {
  welcome: () => playSound('voice.welcome'),
  needYou: () => playSound('voice.needYou'),
  done: () => playSound('voice.done'),
  usage50: () => playSound('voice.usage50'),
  usage80: () => playSound('voice.usage80'),
};
```

Throttle value lives with the caller-facing helper (`keystroke`), not buried
in `config/sounds.json`'s `throttleMs`, because the renderer must enforce it
regardless of config — a hand-edited config that dropped `throttleMs` must not
silently remove the flood guard. (The config field stays as documentation /
future tunability; the code default of 55ms is what actually protects it.)

## 4. Hook points — exact files and lines

| Event | File : line | Change |
|---|---|---|
| Tactile keystroke | `src/renderer/modules/terminals.js:89` | In `instance.onData((data) => window.lunacore.write(data, sessionId))`, add `sfx.keystroke()` — see §4.1 for why *not* every byte |
| New terminal/tab | `src/renderer/modules/sessions.js:231` | `tabNewBtn.addEventListener('click', ...)` → add `sfx.terminalNew()` |
| Tab switch (nav) | `src/renderer/modules/sessions.js:177` | Inside `renderTabs()`'s `btn.addEventListener('click', ...)` → add `sfx.navClick()` |
| Close tab (nav) | `src/renderer/modules/sessions.js:197-200` | `close.addEventListener('click', ...)` → add `sfx.terminalClose()` |
| Theme toggle | `src/renderer/modules/appearance.js:78-81` | `themeSwitcher.addEventListener('change', ...)` → add `sfx.modeToggle()` |
| Language toggle | `src/renderer/modules/appearance.js:83-86` | `langSwitcher.addEventListener('change', ...)` → add `sfx.modeToggle()` |
| Compact-mode toggle | `src/renderer/modules/autocompact.js` (near `#autocompact-toggle` listener, ~line 108) | add `sfx.modeToggle()` |
| Startup greeting | `src/main.js`, in `app.whenReady().then(...)` | after `soundManager.start()`, delayed call to `voice.welcome` equivalent (main-side, see §4 table note) |
| Permission/approval needed | `src/observer.js` (new detector) + `src/main.js:361` (`proc.onData`) | see §4.2 |
| Task complete | `src/observer.js` (`TranscriptWatcher`) | see §4.3 |
| Usage 50%/80% | `src/main.js` `startUsageWatcher()` (`src/usage.js`'s `UsageWatcher` callback) | see §4.4 |

### 4.1 Why keystroke sound needs a source-level decision, not just a throttle

`instance.onData` in `terminals.js:89` fires for **every character xterm.js
reports as user input** — that includes bracketed-paste content and IME
composition, not just single keypresses. Options, in order of recommendation:

1. **(Recommended)** Only fire on single-character, non-control input:
   `if (data.length === 1 && data >= ' ') sfx.keystroke();` — pasting a
   multi-line prompt (`pastePrompt` in `preload.js:119`, used by the prompt
   library) never triggers this listener anyway, since it goes through a
   *different* IPC channel (`pty:paste`), not `onData`. So this guard mainly
   protects against xterm.js's own multi-byte sequences (arrow keys emit
   `\x1b[A` etc.) triggering three "keystrokes" for one arrow press.
2. Skip entirely and rely only on the 55ms throttle (§3.3) — simpler, but a
   held-down arrow key or fast paste-via-terminal-native-shortcut still ticks
   audibly at the throttle ceiling (~18/sec), which reads as a stutter, not a
   typewriter. Option 1 is worth the one extra condition.

### 4.2 Permission/approval detection (new, heuristic — flag this clearly to Mati)

There is currently **no existing signal** for "Claude is waiting on a y/n
approval" — `detectTools()` in `observer.js` only recognizes tool *names*, not
prompt state. This has to be a new stdout pattern match, and unlike tool
detection it is **version-fragile**: Claude Code's approval TUI text can
change between CLI releases. Treat it the same way `config/cheatsheets.json`
treats content — **data, not code**, so Mati can fix a broken match without a
rebuild.

**`config/sound-triggers.json` (new):**
```json
{
  "approvalPrompt": [
    "Do you want to proceed",
    "Do you want to make this edit",
    "Do you trust the files in this folder"
  ]
}
```

**`src/observer.js` addition:**
```js
/** @param {string[]} patterns literal substrings, case-sensitive (from config) */
function detectApprovalPrompt(raw, patterns) {
  if (!raw || !patterns || patterns.length === 0) return false;
  const clean = String(raw).replace(ANSI_RE, '');
  return patterns.some((p) => clean.includes(p));
}
```
Exported alongside `detectTools`. In `main.js`'s `proc.onData` (line ~361),
alongside the existing `detectTools(data)` call:
```js
if (detectApprovalPrompt(data, approvalPatterns)) {
  soundManager.play(resolveSoundFile('voice.needYou').path);
}
```
Debounce this the same way usage thresholds are debounced (§4.4) — a TUI
redraw can repeat the same prompt text across several stdout chunks while the
user is still reading it; fire once per prompt *appearance*, not once per
chunk (track "currently showing a prompt" per-session, clear it on the next
`pty:write`/`pty:command` from that session, since any input means the user
answered it).

### 4.3 Task-complete detection — via transcript `stop_reason`, not stdout scraping

Claude Code's JSONL transcript already carries the exact signal needed: an
assistant message's `stop_reason` is `"tool_use"` while the turn still has
pending tool calls, and `"end_turn"` (or similar terminal reason) when control
returns to the user. This is **more reliable than regexing stdout** for "is
Claude done talking", and it's the same file `TranscriptWatcher` already tails
in `observer.js` for context-window metrics — no new file I/O, just reading
one more field off a JSON object already being parsed.

Add to `observer.js` (new function, same fixture style as `toolEventsFromLines`):
```js
/** True if this fragment contains an assistant message whose turn is fully done. */
function hasTurnEnd(text) {
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim();
    if (!line || !line.includes('"stop_reason"')) continue;
    try {
      const obj = JSON.parse(line);
      const reason = obj && obj.message && obj.message.stop_reason;
      if (reason && reason !== 'tool_use') return true;
    } catch {
      /* incomplete line - skip */
    }
  }
  return false;
}
```
Wire it into `TranscriptWatcher.accumulate()` (`observer.js`, inside the
per-tick block that already computes `events`), guarded by `!firstPass` (same
guard tool events use — a resumed session's *history* must not replay a "done"
chime for every past turn). Emit through a new callback, e.g. `onTurnEnd`,
threaded through the constructor the same way `onTools` already is; `main.js`
wires it to `soundManager.play(resolveSoundFile('voice.done').path)`.

### 4.4 Usage threshold announcements (50% / 80%) — main process, debounced both ways

Hook site: `src/main.js`'s `startUsageWatcher()`, inside the `UsageWatcher`
callback (currently just `mainWindow.webContents.send('usage:update', usage)`).
`usage.fiveHour.pct` (`src/usage.js:107`, produced by `pickWindow()`) is the
exact number to watch.

```js
// module-scope in main.js, alongside `let usageWatcher = null;`
let usageAnnounced = { at50: false, at80: false };

function checkUsageThresholds(usage) {
  const pct = usage && usage.fiveHour && typeof usage.fiveHour.pct === 'number'
    ? usage.fiveHour.pct
    : null;
  if (pct === null) return;

  if (pct >= 80 && !usageAnnounced.at80) {
    usageAnnounced.at80 = true;
    soundManager.play(resolveSoundFile('voice.usage80').path);
  } else if (pct >= 50 && !usageAnnounced.at50) {
    usageAnnounced.at50 = true;
    soundManager.play(resolveSoundFile('voice.usage50').path);
  }
  // Reset once the window rolls over (pct drops well below 50 again), so the
  // NEXT 5h window re-announces instead of staying permanently silenced.
  if (pct < 40) usageAnnounced = { at50: false, at80: false };
}
```
Call `checkUsageThresholds(usage)` inside the existing `UsageWatcher` callback
in `startUsageWatcher()`, right after (or instead of) the `send('usage:update', ...)`
line. The `pct < 40` re-arm threshold (rather than `< 50`) avoids chatter if
usage hovers exactly at 50% across two consecutive polls.

## 5. Persisted preferences — extending `uiprefs.js`

Follow the exact validate-at-boundary pattern already used for `hideSystemPorts`:

```js
// DEFAULTS, in uiprefs.js:
soundEnabled: true,
soundVolume: 70,

// readUiPrefs(), added fields:
soundEnabled: typeof obj.soundEnabled === 'boolean' ? obj.soundEnabled : DEFAULTS.soundEnabled,
soundVolume: typeof obj.soundVolume === 'number' ? clampVolume(obj.soundVolume) : DEFAULTS.soundVolume,

// writeUiPrefs(partial), added handling:
if (partial && typeof partial.soundEnabled === 'boolean') next.soundEnabled = partial.soundEnabled;
if (partial && typeof partial.soundVolume === 'number') next.soundVolume = clampVolume(partial.soundVolume);
```
(`clampVolume` — small local helper, 0..100, same shape as `soundManager.js`'s.)

**UI:** add to the existing "Wyglad"/Appearance panel section in
`src/renderer/index.html` (right after the `lang-switcher` block, ~line 53),
reusing the `.switch` class already defined in `styles.css:240` for
`#autocompact-toggle`:
```html
<label class="ui-field">
  <span class="ui-field__label" data-i18n="appearance.sound">Dzwiek</span>
  <input type="checkbox" id="sound-toggle" class="switch__input" />
</label>
<label class="ui-field">
  <span class="ui-field__label" data-i18n="appearance.volume">Glosnosc</span>
  <input type="range" id="sound-volume" min="0" max="100" />
</label>
```
Wired in `appearance.js`'s `initAppearance()`/change listeners, mirroring
`themeSwitcher`'s pattern — on change, call `window.lunacore.setUiPrefs({...})`
so it persists, AND forward the live value so `main.js` can call
`soundManager.setEnabled()` / `setVolume()` without a restart (reuse the
existing `ui:set` handler in `main.js`, and after writing prefs there, apply
them to `soundManager` immediately — same handler, one extra couple of lines).

## 6. Fallback behavior (mpv missing) — no user-facing error, ever

- `SoundManager.start()` catches the "mpv not found" case, logs **once** to
  the main process console (visible via `--enable-logging`, same debug path
  FUTURE_PLAN.md already documents), and leaves `available = false`.
- Every `play()` call becomes a silent no-op (`if (!this.enabled ...)` guard;
  extend with `if (!this.available) return;`).
- The HUD never blocks, never shows a toast, never retries aggressively — this
  matches `usage.js`'s existing "degrade gracefully" philosophy for a dead
  network (states `'reauth'`/`'unavailable'` instead of an error dialog).
- Document in `README.md`'s setup section: sound is optional; installing mpv
  (`winget install mpv-player.mpv` / `choco install mpv` / `brew install mpv`)
  turns it on with no config changes needed beyond having it on PATH.

## 7. Asset sourcing — voice lines

Three options, cheapest first:

1. **Edge-TTS** (`edge-tts` npm/pip package, free, no API key) — good enough
   quality for 5 short phrases, fastest to bootstrap. One-off generation
   script, not a runtime dependency:
   ```bash
   edge-tts --voice en-US-GuyNeural --text "Welcome Mati" --write-media helpers/sounds/voice/welcome-mati.mp3
   ```
2. **ElevenLabs API** — noticeably better prosody for a "personality" voice,
   costs money per generation but these are one-time static files, not
   runtime calls — five short clips is pennies. Worth it if the voice is meant
   to feel like a distinct character.
3. **Local Kokoro** (open-weight TTS, runs offline) — best privacy story, most
   setup work (Python env, model weights). Overkill for 5 static phrases;
   reasonable only if more voice lines are expected later.

**Recommendation: start with Edge-TTS** for all five lines (cheap, offline
scriptable, replaceable later), swap in ElevenLabs only for `welcome`/`done`
if the free voice feels flat once it's actually running.

## 8. Testing — matching the project's `node --test` convention

New pure-logic pieces are unit-testable without touching mpv or Electron, the
same way `test/observer.test.js` tests `detectTools()`/`toolEventsFromLines()`
without a real PTY:

- `test/sounds.test.js` — `resolveSoundFile()` against a fixture config +
  missing-file case (returns `null`, doesn't throw).
- `test/observer.test.js` (extend) — `detectApprovalPrompt()` against sample
  stdout chunks; `hasTurnEnd()` against sample JSONL fragments (mirrors the
  existing `sumUsageByModel`/`toolEventsFromLines` fixture style in that file).
- `test/usage-thresholds.test.js` (new, or extend near `test/rates.test.js`) —
  `checkUsageThresholds()` as a pure function taking/returning the
  `usageAnnounced` state object (refactor it out of `main.js`'s module scope
  into an exported pure function for testability — same shape as
  `etaMinutes()` was pulled out of `spark.js` per the `context` conversion
  postmortem in `FUTURE_PLAN.md`).
- `SoundManager` itself is **not** unit-tested (it's a thin OS-process
  wrapper, same as `PortWatcher`/`UsageWatcher` aren't) — verify it manually
  via `npm start` with mpv installed and with it temporarily removed from
  PATH, confirming both the audible path and the silent-fallback path.

Run `npm test` after each phase below — it must stay green throughout (168
tests today; expect it to grow, not break).

## 9. Build order (do this, in this order)

1. ✅ **DONE** `helpers/sounds/{sfx,voice}/` placeholder files (even silent/short
   stubs) + `config/sounds.json` + `src/sounds.js` + its unit test. Nothing
   played yet at this stage.
2. ✅ **DONE** `src/soundManager.js` + wiring into `main.js` (start/stop only) +
   manual verification: `npx electron . --enable-logging`, confirmed the one
   warning line (mpv was absent on this machine at the time).
3. ✅ **DONE** `preload.js` + `sound:play` IPC handler +
   `src/renderer/modules/sound.js`. Manually triggered one call via
   `webContents.executeJavaScript()` to confirm the full round trip before
   touching any UI code.
4. ✅ **DONE** Wired the click-driven triggers (§4 table rows 2–7: new tab, tab
   switch, tab close, theme toggle, lang toggle, compact toggle).
5. ✅ **DONE** Keystroke sound (§4.1) — throttle + single-char guard in place;
   verified via a 100-call rapid-fire burst (0.30ms total, no lag).
6. ✅ **DONE** `uiprefs.js` extension (`soundEnabled`/`soundVolume`/
   `soundKeystrokeVariant`) + Appearance panel toggle/slider/variant-select
   (§5/§5.1), live-applied with no restart. Verified via a DOM round-trip test
   confirming `ui.local.json` persists correctly.
7. ✅ **DONE** Usage threshold announcer (§4.4), refactored into a pure
   `nextUsageAnnounced()` (`src/usage.js`) + `checkUsageThresholds()` wrapper
   (`main.js`), with `test/usage-thresholds.test.js`. Also: **all 5 voice
   lines are now real audio** (§10 below, §7's Edge-TTS recommendation, done
   ahead of schedule since the voice choice got decided here), and `mpv` is
   installed on this machine (`winget install mpv-player.mpv-CI.MSVC`) —
   audible verification is pending, deferred to a home machine.
8. Task-complete detection via `stop_reason` (§4.3).
9. Approval-prompt detection (§4.2) — last, because it's the most likely to
   need a follow-up config tweak once real CLI output is observed running
   against it (the `sound-triggers.json` patterns are a best guess from the
   current CLI's known prompt text, not something exercised against live
   output yet).
10. Startup greeting (§4 table, "Startup greeting" row) — trivial, ships last
    only because it's the least useful for catching integration bugs. Voice
    audio (`welcome-mati.mp3`) already exists; only the `main.js` wiring is
    missing.

## 10. Open questions for Mati — decisions (2026-08-11)

- **Voice choice for the 5 lines** — resolved 2026-08-11: woman's voice,
  girly/spicy personality. Went with Edge-TTS `en-US-AriaNeural` ("Positive,
  Confident" per Microsoft's own voice catalog), `--rate=+5% --pitch=+15Hz`
  for a perkier delivery. All 5 lines generated into `helpers/sounds/voice/`
  — see that folder's README for the regeneration command and exact text.
- **Keystroke sound** — resolved: not a simple on/off, it's a **4-way
  variant picker**. See §2.4 and §5.1 below.
- **Approval-prompt heuristic config UI** — deferred, decide later. Build
  order step 9 (§9) stays last / on hold; hand-editing
  `config/sound-triggers.json` is fine for now.

### 2.4 Keystroke sound variants (4 selectable options)

Instead of one `sfx/keystroke.wav`, ship four distinct clips and let Mati pick
which one plays — same "config is data" philosophy as the rest of §2, just
with a `variants` array instead of a single `file`:

```
helpers/sounds/sfx/
  keystroke-mechanical.wav   # loud clicky mechanical-keyboard style
  keystroke-soft.wav         # soft/muted tap
  keystroke-scifi.wav        # short synth blip
  keystroke-typewriter.wav   # typewriter-key clack
```

`config/sounds.json` — `sfx.keystroke` becomes a variant list instead of a
single entry:
```json
{
  "sfx": {
    "keystroke": {
      "volume": 35,
      "throttleMs": 55,
      "enabled": true,
      "variants": [
        { "id": "mechanical", "label": "Mechanical", "file": "sfx/keystroke-mechanical.wav" },
        { "id": "soft",       "label": "Soft",       "file": "sfx/keystroke-soft.wav" },
        { "id": "scifi",      "label": "Sci-fi",     "file": "sfx/keystroke-scifi.wav" },
        { "id": "typewriter", "label": "Typewriter", "file": "sfx/keystroke-typewriter.wav" }
      ]
    },
    "navClick":      { "file": "sfx/nav-click.wav",       "volume": 55 },
    "modeToggle":    { "file": "sfx/mode-toggle.wav",     "volume": 60 },
    "terminalNew":   { "file": "sfx/terminal-new.wav",    "volume": 65 },
    "terminalClose": { "file": "sfx/terminal-close.wav",  "volume": 65 }
  },
  "voice": { "...": "unchanged, see §2.2" }
}
```

`resolveSoundFile()` (§2.3) needs a second lookup path for this one entry:
`resolveSoundFile('sfx.keystroke', { variant: 'scifi' })` — looks up
`entry.variants.find(v => v.id === variant)` instead of `entry.file` when
`variants` is present, falling back to `variants[0]` if the stored variant id
doesn't match anything (renamed/removed clip, corrupt pref).

### 5.1 `soundKeystrokeVariant` preference

Extends §5's `uiprefs.js` changes:
```js
// DEFAULTS:
soundKeystrokeVariant: 'mechanical',

// readUiPrefs():
soundKeystrokeVariant: typeof obj.soundKeystrokeVariant === 'string'
  && KEYSTROKE_VARIANT_IDS.includes(obj.soundKeystrokeVariant)
  ? obj.soundKeystrokeVariant
  : DEFAULTS.soundKeystrokeVariant,
```
`KEYSTROKE_VARIANT_IDS` is a small local constant (`['mechanical', 'soft',
'scifi', 'typewriter']`) rather than reading `config/sounds.json` from
`uiprefs.js` — keeps `uiprefs.js` free of a new cross-module dependency, same
reasoning as its existing validators being self-contained.

**UI (§5's Appearance panel addition):** the keystroke row becomes a `<select>`
instead of implying on/off, right above the volume slider:
```html
<label class="ui-field">
  <span class="ui-field__label" data-i18n="appearance.keystrokeSound">Dzwiek klawiszy</span>
  <select id="sound-keystroke-variant">
    <option value="mechanical">Mechanical</option>
    <option value="soft">Soft</option>
    <option value="scifi">Sci-fi</option>
    <option value="typewriter">Typewriter</option>
  </select>
</label>
```
Changing it should preview-play the newly selected variant immediately (call
`sfx.keystroke()` once right after `setUiPrefs`) so picking one is
audition-by-ear, not trial-and-error via actual typing.
