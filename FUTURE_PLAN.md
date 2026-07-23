# LunaCore — Future Plan (Visual Templates, Layout & Ideas)

> Status baseline (2026-07-23): Phases 1–4 + backlog 7A/7B/7C are **done and
> pushed**, plus the **command palette (Ctrl+K)**, **token burn-rate sparkline**,
> **theming system** (§2), **PL/EN language switch**, **usage-limits gauge**,
> **armed auto-compact**, **CWD/project switcher**, and the **cyberpunk boot
> sequence**. That closes the entire §5.5 shortlist — everything below is now
> *future* work, and §8 is the live plan. Order is a suggestion, not a contract.
> The one hard rule that never changes:
>
> ⚠️ **ZERO EXTRA TOKENS.** Every idea here must stay a **Passive Observer**
> (read/regex on stdout + files) or an **Action Injector** (write plain text to
> PTY stdin). No hidden prompts, no middleware, no touching the `claude` binary.

---

## Table of contents

1. [Guiding principles](#1-guiding-principles)
2. [Theming system (visual templates)](#2-theming-system-visual-templates)
3. [Layout engine (movable / swappable panels)](#3-layout-engine-movable--swappable-panels)
4. [Widget catalogue](#4-widget-catalogue--turn-panels-into-modular-tiles)
5. [Feature ideas backlog](#5-feature-ideas-backlog)
6. [Technical debt & cleanup](#6-technical-debt--cleanup)
7. [Packaging & distribution](#7-packaging--distribution)
8. [The plan from here](#8-the-plan-from-here-rewritten-2026-07-23)
9. [Multi-model command center](#9-multi-model-command-center--the-bigger-idea)

---

## 1. Guiding principles

- **Config-driven first.** Anything visual (theme, layout, widget placement)
  should be a JSON/CSS file the user can swap, not hardcoded. Mirror the existing
  `config/*.json` + gitignored `*.local.json` merge pattern already used by
  profiles / cheatsheets.
- **No layout thrash.** Keep using `transform`/CSS custom properties for anything
  animated (like the context bar already does with `scaleX(var(--ctx))`).
- **Everything stays observable, nothing becomes an agent.** A widget may *read*
  more (git status, disk, GPU) but must never *ask a model* anything.
- **Degrade gracefully.** A broken theme/layout file must fall back to the
  shipped default (same as `profiles.js` FALLBACK), never a blank window.

---

## 2. Theming system (visual templates)

> ✅ **BUILT 2026-07-22** — §2.1 (token extraction) and §2.2 (theme picker) are
> shipped. `styles.css` is now fully tokenised (`:root` custom properties incl.
> `--btn-grad`, `--btn-grad-hover`, `--glow`, `--term-bg`). Themes live in a
> single `config/themes.json` (not a `themes/` dir as sketched below):
> **cyberpunk / synthwave / matrix / nord / light**, each `{ id, label, vars,
> terminal }`. `src/theme.js` loads + validates them (FALLBACK cyberpunk).
> The **Appearance** section in the left panel switches live via IPC
> `themes:list`, rewriting `documentElement` CSS vars **and** the xterm ANSI
> palette; choice persists to `config/ui.local.json` (`src/uiprefs.js`).
> A `config/themes.local.json` (gitignored) overrides by `id`.
> **Still future:** §2.3 presets (density / font pack / glow toggle) and a
> cycle-theme hotkey.

Right now the theme is a fixed `:root { … }` block in `styles.css` (neon magenta +
cyan cyberpunk). Goal: make the whole look a **swappable template**.

### 2.1 Extract theme into tokens

Move every colour/rounding/spacing decision into CSS custom properties (most
already are: `--bg`, `--neon-magenta`, `--radius`…). Then a "theme" is just a set
of values for those tokens — no structural CSS changes needed.

```
config/themes/
  cyberpunk.json      # current default (magenta + cyan)
  synthwave.json      # hot pink + orange sunset
  matrix.json         # green-on-black terminal purist
  nord.json           # muted arctic blues (easy on eyes)
  mono-amber.json     # single-accent retro CRT amber
  light-daylight.json # actual light mode for daytime work
```

Each theme file = flat `{ "--bg": "#0a0710", "--neon-magenta": "#c774ff", … }`.
A small `src/theme.js` loads the selected theme and writes the vars onto
`document.documentElement.style`. Live switch = no reload.

### 2.2 Theme picker

A dropdown in the left panel (same component style as the profile switcher) →
persists choice to `config/ui.local.json`. Bonus: a "cycle theme" hotkey.

### 2.3 Presets beyond colour

- **Density presets:** `comfortable` / `compact` / `dense` — scales paddings and
  font sizes via a `--density` multiplier so power users can cram more on screen.
- **Font pack:** let the user pick the terminal + UI font (Cascadia / JetBrains
  Mono / Fira Code) from a list; xterm already supports `fontFamily`.
- **Glow toggle:** a `reduce-glow` / `reduce-motion` mode (kills the neon
  box-shadows and the `ctx-alarm` pulse) — accessibility + battery.

---

## 3. Layout engine (movable / swappable panels)

Today the layout is a fixed 3-column CSS grid: `260px | 1fr | 280px`. The ask is
**different positions of elements** — so make the layout data, not hardcoded.

### 3.1 Layout presets (cheap first step)

Ship a handful of named layouts selectable from a menu; each just changes the
grid template + which widgets go in which slot.

| Preset | Shape | Good for |
|--------|-------|----------|
| `classic` | left `controls` · center `terminal` · right `monitor` | current default |
| `focus` | terminal full-bleed, panels collapse to thin icon rails | deep work / small screens |
| `monitor-heavy` | narrow terminal, wide right column with big context bar + ports | watching a long run |
| `bottom-dock` | terminal on top, all widgets in a horizontal dock below | ultrawide monitors |
| `left-only` | everything on the left, terminal fills the rest | muscle-memory / one-handed |

Implementation: a `config/layouts/*.json` describing
`{ grid: "…", slots: { left: [...widgetIds], right: [...] } }`. Renderer builds
panels from that instead of the current static HTML.

### 3.2 Collapsible / resizable panels

- **Collapse buttons** on each panel header (chevron) → panel shrinks to a thin
  rail, terminal reclaims the space. State saved per layout.
- **Draggable splitters** between columns (a thin `<div>` grip + pointer events
  writing the grid-template widths). No library needed for 2 handles.

### 3.3 Drag-and-drop widget rearrange (stretch)

The real "move elements around" feature: make each monitor block a **widget tile**
the user can drag between slots. Persist the arrangement to `ui.local.json`.
Keep it dependency-light (HTML5 drag events) — or adopt a tiny grid lib
(`muuri` / `gridstack`) only if hand-rolling gets messy. Evaluate build-cost vs.
benefit before pulling a dep in (per the "audit the harness" habit).

---

## 4. Widget catalogue — turn panels into modular tiles

Once layout is data-driven, refactor today's blocks into interchangeable widgets
so any of them can live in any slot:

- `terminal` (the xterm core — always present, usually center)
- `context-bar` (Context Window %)
- `skill-tracker` (tool tiles)
- `ports` (localhost tracker)
- `cheatsheets` (action buttons)
- `skills` (skill cheat-sheet)
- `profile-switcher`
- `compact-button`
- …plus the new ones from §5.

A widget = `{ id, title, mount(el), unmount() }`. This is the enabler for both
the layout engine (§3) and any future feature (§5) — build it once, reuse.

---

## 5. Feature ideas backlog

Grouped by how much they cost vs. how token-safe they are. All are Observer/
Injector-only.

### 5.1 Quick wins (small, high value)

- **Persist active profile** to `profiles.local.json` (already flagged) — start
  in the last-used profile instead of the default.
- **Session cost/time HUD.** Parse the transcript's `usage` you already read and
  show elapsed session time + a rough token→$ estimate (per-model rate table in
  config). Pure read, zero tokens. This was an original inspiration item.
- **Model badge.** Show which model the current session is on (read from
  transcript / stdout), so profile switches are visually obvious.
- **Context-limit auto-detect.** Fix the `CONTEXT_LIMIT=200000` gotcha: infer the
  real window (200k vs 1M) from the model id in the transcript instead of a
  hardcoded const.
- **Port filter toggle.** The "hide system noise (svchost/System), show only dev
  servers" switch — a toggle, not a permanent filter, so nothing is hidden by
  surprise.
- **Copy-transcript-path button.** One click to copy the current `.jsonl` path
  (handy for debugging / sharing).

### 5.2 Medium features

- **Command history / recent injections.** A scrollable log of the last N buttons
  you pressed → click to re-fire. Purely local.
- **Custom cheat-sheet editor.** A small in-app form to add/edit cheat-sheet
  groups and buttons, writing to `cheatsheets.local.json` — no hand-editing JSON.
- **Skill categorisation override.** Let the user drag a skill into the right
  category (fixes the "rough heuristic" problem) and save the mapping to JSON —
  the manual-mapping idea, but with a UI.
- **Skill search box.** Filter the 339-skill list as you type (name +
  description). The list is already in memory; just filter the DOM.
- **Multi-session tabs.** Run more than one `claude` PTY in tabs, each with its
  own profile. Big but very much in the spirit of a "command center".
- **Git widget.** Show current branch + dirty-file count for the cwd (read-only
  `git status --porcelain`), with quick-inject buttons for the git cheat-sheet.
- **Notifications.** OS toast when context crosses 85%, or when the PTY goes idle
  after being busy (parse stdout quiet-period). Uses Electron `Notification`.

### 5.3 Bigger / exploratory

- **GPU / system meters.** Small tiles for GPU/VRAM/CPU (relevant to your Synthara
  + local-LLM work). Read via `nvidia-smi` / OS counters on a slow poll.
- **LM Studio health check.** When on the LM Studio profile, ping
  `http://localhost:1234/v1/models` and show up/down + loaded model. Local HTTP
  only, no Claude tokens.
- **Session snapshots / bookmarks.** Save a note + timestamp against the current
  transcript so you can jump back to "where I was" across restarts.
- **Themeable sound cues.** Optional subtle SFX on compact / tool-run / alarm
  (off by default). Fits the cyberpunk vibe; easy to overdo — keep opt-in.

### 5.4 Google Calendar agenda widget (Option B — native, on-brand)

A right-panel **"📅 Agenda"** tile showing today + the next few events, styled to
match the cyberpunk theme (not an embedded Google iframe). Reuses OAuth
credentials that already exist (`gen-lang-client-0284743207`, calendars
Studia / Praca / Rodzina). **Token-safe:** never touches the `claude` PTY — the
"zero extra tokens" rule is about the Claude session, and this widget only talks
to the Google Calendar API.

- **Auth:** reuse the existing Google OAuth client + refresh token. Do the token
  exchange/refresh in LunaCore's **main process** (never the renderer), expose
  only sanitized event data over IPC. Credentials go in a gitignored
  `config/google.local.json` — never committed.
- **Data flow (Passive Observer style):** `src/calendar.js` in main polls the
  Calendar API on a slow interval (e.g. every 5 min, plus manual refresh) →
  normalizes to `{ id, title, start, end, calendarId, color }` → IPC
  `calendar:update` → renderer builds `.cal-event` rows. Same shape as the
  existing `PortWatcher` (poll → emit-on-change → guard busy).
- **UI:** grouped by day (Today / Tomorrow / rest), colour-coded per calendar,
  "in 2h" relative badges. Empty + error states like the ports list already has.
- **Read-only first**, then a small "＋ quick add" that POSTs a new event
  (title + time) — routed to the right `calendar_id` per the existing
  category→calendar mapping.
- **Caveat — token refresh:** the stored Calendar token may be **expired**; ship
  a proper refresh flow so the widget degrades to a "reconnect" prompt instead of
  going silently blank. This is the main risk, handle it first.
- **Config:**
  ```
  config/google.local.json   # gitignored: client id/secret, refresh token, calendar ids
  ```
- **Not** Option A (embedded `<webview>` of calendar.google.com): rejected here on
  purpose — it works but looks like Google, not LunaCore. Keep it as the fallback
  if native auth proves too fiddly.

### 5.5 Mati's shortlist (approved direction)

The ideas below are the ones picked to actually build. All Observer/Injector,
token-safe. Priority order roughly top-to-bottom.

- ✅ ~~⭐ **Prompt library (MUST).**~~ **BUILT 2026-07-20.** `src/prompts.js` +
  `config/prompts.json` (+ gitignored `.local.json`), left-panel "Prompty"
  section. Injection uses **bracketed paste** (`ESC[200~ … ESC[201~`) over a new
  `pty:paste` IPC channel — a raw write would submit at the first newline and
  split the prompt into several messages. Main button pastes *without* sending
  (you can still edit); the `⏎` button pastes and sends.
- ✅ ~~**Command palette (Ctrl+K).**~~ **BUILT 2026-07-22.** Renderer-only overlay
  fuzzy-searching every injectable action — the COMPACT button, cheat-sheets,
  prompts, skills — keyboard-first (`↑↓`/`Enter`/`Esc`). Firing routes to the
  **existing** injector per row (command types, prompt pastes / ⇧ sends, skill
  copies its name). No new PTY channel, no tokens.
- ✅ ~~**Armed auto-compact button.**~~ **BUILT 2026-07-22.** Left-panel toggle,
  off by default. When armed and context crosses 85%, the renderer injects
  `/compact` through the **existing** `runCommand` injector — no new IPC. Edge
  trigger with hysteresis (fires once at 0.85, re-arms only below 0.60) plus a
  60 s cooldown and a dead-session guard, so it can't loop. The compact itself
  costs tokens — expected, and only ever after you armed it.
- ✅ ~~**Token burn-rate sparkline.**~~ **BUILT 2026-07-22.** SVG sparkline of
  context % over time under the Context Window bar + tok/min + ETA to 85%, from a
  second `metrics:context` listener on the same `usage` samples (no new IPC,
  no polling). Dashed line marks the 85% threshold.
- ✅ ~~**Theme + language switch.**~~ **BUILT 2026-07-22.** Full theming system
  (see §2) — 5 live-swappable themes — plus a **PL/EN language switch**
  (`src/renderer/i18n.js`, `data-i18n*` attrs + `t()` for dynamic strings). Both
  persist to `config/ui.local.json`. Translates LunaCore's chrome only, not the
  `claude` CLI output. (Language wasn't on the original shortlist — added on
  request alongside theming.)
- ✅ ~~**Working-vs-waiting LED.**~~ **BUILT 2026-07-20.** Dot in the terminal
  bar, driven entirely by stdout activity in the renderer — amber pulsing while
  data flows, steady green after 800 ms of silence, red on exit. No new IPC:
  the signal was already in the stream. OS notifications still open as a pairing.
- ✅ ~~**CWD / project switcher.**~~ **BUILT 2026-07-22.** `config/projects.json`
  (+ gitignored `.local.json`) with `~`-prefixed portable paths, `src/projects.js`
  as the loader/validator (analog of `profiles.js`), a mutable `activeCwd` +
  `safeCwd()` guard in main (missing folder → home, so a config listing another
  machine's repos still boots), and a "Project" select in the left panel.
  Location complements profiles, which are environment. `TranscriptWatcher`
  needed no change: it follows the globally-newest `*.jsonl` by mtime, so it
  re-attaches itself after a cwd switch.
  ↳ **Still open:** the **multi-terminal workspace** question. The switcher was
  deliberately built so it does *not* block multi-PTY tabs — see §9.
- ✅ ~~**Local scratchpad.**~~ **BUILT 2026-07-20.** Right-panel notepad,
  autosaved to `config/scratchpad.local.md` (plain file, gitignored, 256 KB cap)
  with a button that injects the notes via bracketed paste. Shipped **global,
  not per-cwd** — keying notes by project only makes sense once the CWD switcher
  exists; revisit then.
- ✅ ~~**Cyberpunk boot sequence.**~~ **BUILT 2026-07-23.** ~1.4 s themed overlay:
  wordmark reveal, drifting grid, CRT scan sweep, a five-line subsystem log and a
  `scaleX` progress rule. Colours come **only** from theme tokens, so it inherits
  all five themes for free; the log is i18n'd (PL/EN). Deliberately non-blocking —
  the PTY starts and streams underneath, and click / any key dismisses it
  instantly (no `preventDefault`, so the keystroke still reaches the terminal).
  Toggle in **Appearance** persists to `ui.local.json` (`boot`); the change
  applies next launch. Honours `prefers-reduced-motion` by not running at all.
  ↳ Shipped alongside it: a **global reduced-motion block** in `styles.css` — the
  HUD had none, and it's the one WCAG-severity gap the animation work exposed.
  Decorative pulses/blinks collapse to zero; the usage-refresh spinner is exempt
  because a loading indicator is the one legitimate continuous motion. Nothing is
  lost, because every state signal in the HUD carries its meaning in **colour**
  (LED, PTY dot, context alarm) with motion only as reinforcement.
  ↳ Also shipped: an inline failsafe in `index.html` that force-hides the overlay
  after 4 s. It exists because a renderer parse error (the old i18n `t` collision)
  would otherwise leave the overlay covering the whole HUD permanently — that
  inline timer is the only code that survives such a crash.
- ✅ ~~**Session % + weekly limit gauge.**~~ **BUILT 2026-07-22.** Right-panel
  tile showing the **5-hour** and **weekly** subscription windows (+ Opus/Sonnet
  weekly splits) as `scaleX` bars with % and a "resets in …" countdown. Solved
  the "not in transcript/stdout" problem token-safely: `src/usage.js`
  (`UsageWatcher`) reads the CLI's OAuth token from `~/.claude/.credentials.json`
  and does a plain **GET** to `api.anthropic.com/api/oauth/usage` — read-only,
  never `/v1/messages`, zero tokens. Rides the CLI's own token refresh (never
  writes the creds file); 90 s poll + manual ↻ + 30 s countdown tick; `reauth` /
  `off` / `unavailable` states. Kill switch: `ENABLE_USAGE_METER` in `main.js`.

**Far-future (not now):**
- **Voice inject.** Speak → transcribe locally → inject as stdin. Cross-links the
  Luna Voice project. Explicitly a "future future" item — revisit much later.

**Explicitly not selected this round** (from §5.1–5.3, left as backlog): files-
touched panel, activity timeline/replay, project-context glance, git widget,
GPU meters, LM Studio health, session snapshots, sound cues, calendar quick-add
beyond read-only.

---

## 6. Technical debt & cleanup

- **`renderer.js` is ~1370 lines.** The single biggest debt item now. Split by
  concern (terminal / context / usage / ports / palette / appearance / boot).
  Beware: plain `<script>`s share one global scope — the i18n `t` collision
  bricked the whole renderer once. Prefer `<script type="module">` over more
  IIFEs. This is Phase A1 in §8.
- **Dead `.panel__spacer` CSS** — the div was removed in 7C; drop the rule.
- **Skill scan is synchronous (~2.4s).** Pre-warm hides it, but move
  `scanSkills()` to a worker thread or async fs walk so it never blocks main.
- **Refactor `index.html` static panels → widget mounts** (blocks §3/§4).
- **Tests.** None yet (deferred by design). When ready: unit-test the pure
  modules first — `observer.usageToMetrics`, `ports.scanPorts` parsing,
  `skills.categorize`, `profiles.normalizeProfile`, `projects` `~`-expansion —
  they're side-effect-free and cheap to cover. Then a smoke test that the window
  boots. Doing these *before* the split (§8 A1) is what makes the split verifiable.
- **`CONTEXT_LIMIT` const** → superseded by auto-detect (§5.1).
- **Boot timings are duplicated** in `styles.css` and `renderer.js`
  (`BOOT_FADE_MS` must match `.boot.is-out`). Small, but if the fade is ever
  retuned, change both.

---

## 7. Packaging & distribution

- **electron-builder** (the old "Phase 5"): produce a real Windows installer
  (`.exe` / NSIS) + portable build, with the LunaCore icon. Then optionally
  auto-update via GitHub releases (repo is already `Kotsur69/Luna-Core-HUD`).
- **First-run config bootstrap.** On first launch, copy shipped `config/*.json`
  defaults into a user config dir so updates don't clobber local edits.

---

## 8. The plan from here (rewritten 2026-07-23)

The old §8 is spent: step 1 (theme tokens + picker) shipped, and the §5.5
shortlist is closed. This is the replacement — four phases, ordered so that each
one makes the next cheaper instead of more expensive.

### Phase A — Pay the structural debt *first* (the enabler)

**Why first:** `renderer.js` is now ~1370 lines and every feature since the
palette has made it worse. Layout presets built on today's static HTML would be
work thrown away the moment widgets land. Do the boring one now, while the
feature set is stable and nothing is half-finished.

| # | Item | Ref | Notes |
|---|------|-----|-------|
| A1 | **Split `renderer.js` into modules** | §6 | Mechanical, behaviour-preserving. One file per concern: `terminal`, `context`, `usage`, `ports`, `palette`, `appearance`, `boot`. Plain `<script>`s share one global scope — the i18n `t` collision proved that the hard way — so either wrap each in an IIFE **or** switch to `<script type="module">` and stop relying on globals. Prefer modules. |
| A2 | **Widget contract** | §4 | `{ id, title, mount(el), unmount() }`. Convert existing blocks one at a time; the app keeps working after every single step. |
| A3 | **Tests on the pure modules** | §6 | `observer.usageToMetrics`, `ports.scanPorts` parsing, `skills.categorize`, `profiles.normalizeProfile`, `projects` `~`-expansion. Side-effect-free, cheap, and they're the safety net that makes A1 safe to do at all. Do these *before* A1 if you want the refactor to be genuinely verifiable. |
| A4 | **Kill the dead bits** | §6 | `.panel__spacer` CSS rule, `CONTEXT_LIMIT` const (superseded by auto-detect, B2). |
| A5 | **Async skill scan** | §6 | `scanSkills()` still blocks main ~2.4 s; pre-warm only hides it. Worker thread or async fs walk. |

### Phase B — Daily-driver quick wins (§5.1)

Cheap, satisfying, all Observer/Injector. Safe to cherry-pick in any order once
Phase A is done — or before it, if you want a break from refactoring.

| # | Item | Notes |
|---|------|-------|
| B1 | **Persist active profile** | Start in the last-used profile. `ui.local.json` already exists and now takes arbitrary keys — trivial. |
| B2 | **Context-limit auto-detect** | Read the model id from the transcript, infer 200k vs 1M. Removes the `CONTEXT_LIMIT` gotcha that currently makes the bar lie on 1M sessions. |
| B3 | **Model badge** | Show the model the session is actually on. Makes profile switches visually obvious and pairs naturally with B2 — same parse, two payoffs. |
| B4 | **Session cost/time HUD** | Elapsed time + token→$ estimate from a per-model rate table in config. Pure read. |
| B5 | **Port filter toggle** | Hide system noise (svchost/System) — a *toggle*, never a permanent silent filter. |
| B6 | **Copy-transcript-path button** | One click to copy the `.jsonl` path. |
| B7 | **Skill search box** | Filter the ~339-skill list as you type. The list is already in memory. |

### Phase C — Layout & visual templates (§2.3, §3)

The original "move the elements around" ask. Only sane **after** A2.

1. **Layout presets** (§3.1) — `classic` / `focus` / `monitor-heavy` / `bottom-dock`, as data.
2. **Collapsible + resizable panels** (§3.2) — chevron collapse, two drag splitters, no library.
3. **Density / font / glow presets** (§2.3) — the `reduce-glow` half is now partly free, since the reduced-motion block landed with the boot sequence.
4. **Drag-and-drop rearrange** (§3.3) — stretch. Evaluate a dep honestly before pulling one in.

### Phase D — Make it a product (§7)

1. **electron-builder** → real NSIS installer + portable `.exe`, LunaCore icon.
2. **First-run config bootstrap** → copy shipped `config/*.json` into a user config dir so updates never clobber local edits. **Do this before the first release, not after** — retrofitting it once people have local edits is painful.
3. Optional auto-update via GitHub releases (repo is already `Kotsur69/Luna-Core-HUD`).

### What is deliberately *not* scheduled

The §9 multi-model work below. It's the most interesting direction the project
has, but it's a **product decision**, not a queue item — picking it changes what
LunaCore *is* (a Claude Code HUD → a multi-provider AI dev console). It deserves
an explicit yes before it displaces Phase A.

---

## 9. Multi-model command center — the bigger idea

> **Status: unscheduled backlog.** Ideas only, ranked by implementation cost.
> Nothing here is committed work.

The premise: LunaCore is currently a Claude Code HUD. The natural next identity
is **the cockpit for coding with any AI backend** — Claude, Kimi, a local LM
Studio model — with the same observer/injector discipline.

**The unlock already exists.** `config/profiles.json` sets `env` per session,
including `ANTHROPIC_BASE_URL`. Any provider exposing an Anthropic-compatible
endpoint can therefore be driven by the *existing* profile switcher with **zero
new code** — Moonshot's Kimi models publish exactly such an endpoint, and the
LM Studio profile already ships. Most of §9 is about making that fact visible and
pleasant, not about building new plumbing.

### Ranked easiest → hardest

| # | Idea | Cost | What it is | Risk / catch |
|---|------|------|-----------|--------------|
| 1 | **Ship provider profiles as presets** | XS | Add Kimi (+ any other Anthropic-compatible vendor) to `profiles.json` next to LM Studio, keys via gitignored `.local.json`. | Verify each vendor's current base URL before committing it — they move. |
| 2 | **Provider badge + cost model per profile** | S | Show which backend is live and price tokens with that profile's rate table (local = free). Extends B3/B4 rather than duplicating them. | Rate tables go stale; keep them in config, not code. |
| 3 | **Backend health tile** | S | Ping the active profile's `/v1/models` (LM Studio, Ollama, vLLM) → up/down + loaded model. Local HTTP only. | Slow poll, guard against a hung endpoint blocking the UI. |
| 4 | **Model-swap without losing the session** | S–M | Palette rows for "restart this cwd on profile X" — the plumbing exists (profile + project switchers), this is just one fused action. | Restart is still a restart; be honest in the UI that context is lost. |
| 5 | **GPU / VRAM meters** | M | `nvidia-smi` on a slow poll. Genuinely useful next to a local model — you can *see* whether the 70B fits. | Windows/NVIDIA-specific; degrade to hidden, never to a broken tile. |
| 6 | **Multi-session tabs (multi-PTY)** | M–L | ✅ **BUILT** (`1e5e307` + `7c732e7`). N terminals, each with its own PTY, profile, cwd, xterm buffer and context metrics. Background tabs keep running and keep scrollback; tabs carry their own context %. | The predicted blocker was real and was the bulk of the work. Solved in two steps: scope the watcher to the session's cwd (`encodeProjectDir`), then **pin** it to a single file — transcript dirs are keyed by *folder*, files by *session*, so two tabs on one repo still collided. See §6a. |
| 7 | **Side-by-side model duel** | L | Same prompt, two backends, two panes, compare answers. Killer demo for "which model do I actually need". | Costs real tokens on every paid pane — must be explicit, opt-in, never automatic. Violates "zero extra tokens" unless the user initiates each run. |
| 8 | **Local prompt/response archive + search** | L | Index your own `~/.claude/projects/**/*.jsonl` into a searchable local history ("when did I solve this before?"). Read-only, zero tokens, and it's *your* data already on disk. | Index size and staleness; needs a real store (SQLite) rather than JSON. |
| 9 | **Cross-provider usage ledger** | L | One dashboard for Claude subscription limits + Kimi spend + local runtime hours. Extends the existing usage gauge to a multi-vendor picture. | Every vendor has a different (or no) usage endpoint. Design for "unavailable" as a first-class state, like the current gauge already does. |
| 10 | **Voice inject** | XL | Speak → transcribe locally → inject as stdin. Cross-links the Luna Voice project. | Still explicitly a "future future" item. |

**#6 is built.** Multi-session tabs is what turns LunaCore from a nice window
into an actual command center. The predicted prerequisite (per-session transcript
attachment) was indeed the whole job — see below.

### 6a. Two scopes, and why it matters

The lesson worth keeping: **context window is per-process, usage limits are
per-account.** Each `claude` has its own 200k window, so the context bar,
sparkline and tool tiles are per tab. The 5h/weekly limits are one shared quota
across every tab (and every session run outside the HUD), so they stay a single
global readout and must never be summed per tab.

The trap this creates: N tabs can each show a calm green context bar while
draining one quota N times faster. Per-tab metrics *structurally cannot* warn
about this — only the global gauge can. Worth adding an "N active sessions" badge
next to the 5h readout so the burn rate is attributable to tab count.

Known remaining gap: two tabs both **resuming** (`--continue`) into the same
folder. Pinning distinguishes sessions by "new file after startup" or "existing
file that grew after startup"; two resumed sessions offer neither signal
cleanly. Fixing it properly needs the session UUID, which means parsing it out of
the CLI's stdout — still zero-token, but a bigger change.
