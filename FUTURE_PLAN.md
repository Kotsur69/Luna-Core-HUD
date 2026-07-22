# LunaCore — Future Plan (Visual Templates, Layout & Ideas)

> Status baseline: Phases 1–4 + backlog 7A/7B/7C are **done and pushed**, plus
> the **command palette (Ctrl+K)**, **token burn-rate sparkline**, **theming
> system** (§2), **PL/EN language switch**, and the **usage-limits gauge**
> (§5.5). Remaining items below are *future* work. Order is a suggestion, not a contract. The one hard rule that
> never changes:
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
8. [Suggested phasing](#8-suggested-phasing)

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
- **Armed auto-compact button.** A left-panel *toggle* (armed / off). When armed
  and context crosses the threshold, auto-inject `/compact`. Off by default,
  clearly user-armed. The compact itself costs tokens (expected + explicit).
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
- **CWD / project switcher.** Launch `claude` in different repos from a picker
  (location, complementing profiles which are environment).
  ↳ **Note:** possible stepping-stone toward a **multi-terminal workspace** —
  Mati is deciding on that separately (revisit **tomorrow, ~2026-07-21**). Design
  the CWD switcher so it doesn't block a later multi-PTY tabs feature.
- ✅ ~~**Local scratchpad.**~~ **BUILT 2026-07-20.** Right-panel notepad,
  autosaved to `config/scratchpad.local.md` (plain file, gitignored, 256 KB cap)
  with a button that injects the notes via bracketed paste. Shipped **global,
  not per-cwd** — keying notes by project only makes sense once the CWD switcher
  exists; revisit then.
- **Cyberpunk boot sequence.** Short themed startup animation — pure polish.
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

- **Dead `.panel__spacer` CSS** — the div was removed in 7C; drop the rule.
- **Skill scan is synchronous (~2.4s).** Pre-warm hides it, but move
  `scanSkills()` to a worker thread or async fs walk so it never blocks main.
- **Refactor `index.html` static panels → widget mounts** (blocks §3/§4).
- **Tests.** None yet (deferred by design). When ready: unit-test the pure
  modules first — `observer.usageToMetrics`, `ports.scanPorts` parsing,
  `skills.categorize`, `profiles.normalizeProfile` — they're side-effect-free and
  cheap to cover. Then a smoke test that the window boots.
- **`CONTEXT_LIMIT` const** → superseded by auto-detect (§5.1).

---

## 7. Packaging & distribution

- **electron-builder** (the old "Phase 5"): produce a real Windows installer
  (`.exe` / NSIS) + portable build, with the LunaCore icon. Then optionally
  auto-update via GitHub releases (repo is already `Kotsur69/Luna-Core-HUD`).
- **First-run config bootstrap.** On first launch, copy shipped `config/*.json`
  defaults into a user config dir so updates don't clobber local edits.

---

## 8. Suggested phasing

A lean order that front-loads the "visual templates + move elements" ask:

1. **Theme tokens + theme picker** (§2.1–2.2) — biggest visual payoff, low risk.
2. **Layout presets** (§3.1) — data-driven grid; delivers "different positions"
   without a full drag engine.
3. **Widget refactor** (§4) — the enabler; do it once, unlocks the rest.
4. **Collapsible/resizable panels** (§3.2) + **density/font/glow presets** (§2.3).
5. **Quick-win features** (§5.1) — cheap, satisfying, all token-safe.
6. **Drag-and-drop rearrange** (§3.3) + medium features (§5.2) as appetite allows.
7. **Cleanup pass** (§6) before/around **packaging** (§7).

> Pick any slice — none of this is committed work. Tell me where to start and
> I'll spec that piece properly before touching code.
