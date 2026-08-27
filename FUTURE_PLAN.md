# LunaCore — Future Plan (Visual Templates, Layout & Ideas)

## START HERE — where things stand (2026-08-26)

Everything below this box is either **live plan** (§8) or **history**. Read this
box, then §8's Phase A table, then jump to §A2a–§A2f for the widget contract and
the six lessons the conversions have cost so far.

| | State |
|---|---|
| **Shipped** | Phases 1–4, the whole §5.5 shortlist, **Phase B 8/8**, **Phase A 5/5 DONE** (A1 renderer split, A2 contract + **13/13 conversions**, A3 tests, A4, A5), full **PL/EN localization of `config/*.json`** (schema in README → *Language*), **C1 (layout presets) DONE** — 4 presets, switchable live — and **C2 (fold + resize panels) DONE** — every widget title folds (persisted per widget id in `ui.local.json`), and the region borders drag to re-column any preset (persisted per layout id); 35 tests, shipped 2026-08-17 (`0749717`), interaction layer hardened 2026-08-19 (`43dbecf`) — and **C3 (theme vocabulary + motion) DONE** — 45 tokens, 9 themes, 2 bundled faces — and **D0–D3 DONE**: config relocation, **a real NSIS installer + portable .exe**, LUNA/CORE icon, honest degradation — **D4–D6 DONE**: release hygiene, `v0.9.0` public, notify-and-click auto-update, **Electron 33 → 43 (`npm audit` clean)** — and **E1/E3 DONE**: machine telemetry widget, threshold pulse, pane fade-in — and **sound & voice feedback DONE** (mpv sfx cues, all triggers incl. task-complete/approval-prompt/startup-greeting, offline-SAPI read-output-aloud — tracked separately in [`SOUNDS_IMPLEMENTATION_PLAN.md`](SOUNDS_IMPLEMENTATION_PLAN.md), not duplicated here) — and **Ctrl+L "Ustawienia" (Settings overlay) DONE
2026-08-13**: started as the Terminal Appearance Customizer
([`TERMINAL_CUSTOMIZER_PLAN.md`](reference/TERMINAL_CUSTOMIZER_PLAN.md), from
`LUNA_HUD_SPECIFICATION.md` §6.5), grew into a general Settings overlay from
Mati's live feedback — see that plan's **§1 and §3 for the full list** (all 9
terminal knobs incl. a custom background image; sound + boot-sequence moved
out of the left panel to declutter it; a real `allowTransparency` bug found
and fixed, which is what made opacity/blur actually work) — and
**Active-Files Edit Heatmap DONE 2026-08-13**
([`ACTIVE_FILES_HEATMAP_PLAN.md`](reference/ACTIVE_FILES_HEATMAP_PLAN.md), from
`LUNA_HUD_SPECIFICATION.md` §6.2): real git-diff-stat `+`/`-` counts per
file, a live "currently being edited" pulse, and (added same day from
manual-test feedback) a bounded self-heal so the live pulse cannot get
stuck lit, the permanent heat-glow removed so a settled row never reads as
"still lit", and a deleted-file indicator (`files:check-exist` IPC,
`fs.existsSync`, since a `rm`/`del` has no transcript event to ride) — and
**multi-repo project switching DONE 2026-08-13**: a "+" button next to the
Project switcher opens a native folder picker and writes the pick straight
to `config/projects.local.json`, no more hand-editing JSON to add a repo on
another drive — and **GPU usage DONE 2026-08-13**: a third row in the
System tab next to CPU/RAM, Windows-only, reading the same DXGI "GPU
Engine" counters Task Manager's own GPU column reads
([`src/gpu.js`](src/gpu.js)), on its own slower timer so it never blocks
`telemetry.js`'s pure 2 s sample. **413 tests.** — and **the D5 update notice
moved out of the left panel 2026-08-13**: now a chip next to the Ctrl+K /
Ctrl+L chips in the terminal bar, hidden unless there is actually something to
do (`available` / `downloading` / `ready`), so "could not check for updates"
no longer sits there permanently. Caught the same flex-child `[hidden]` bug
this file already hit for `.badge` and the original `.update` block, on first
hand-launch — see §D5b. Since then: all Polish code comments translated to
English (`d5db8bb`, 2026-08-17), `package.json`/lockfile synced to `0.9.1`
(`2b81bae`, 2026-08-17), **`v0.9.1` cut and published**
([releases/tag/v0.9.1](https://github.com/Kotsur69/Luna-Core-HUD/releases/tag/v0.9.1),
2026-08-17) — and, same day, two more picks off the §6 backlog: **Session
Timeline & Snapshot Scrubber DONE 2026-08-17**
(`LUNA_HUD_SPECIFICATION.md` §6.1): a compact scrollable strip of turn markers
in the right rail riding `TranscriptWatcher.onTurnEnd()` (zero new IPC/file
read), click opens a read-only preview modal of that turn's captured text —
and **Media Deck DONE 2026-08-17** (§6.3, reframed): play/pause/skip + system
volume via Windows' own GSMTC (not the Spotify Web API originally sketched —
works with any app, needs no OAuth/network) for transport and a Core Audio
COM interop for volume, `src/media.js`, polling every 2 s and pushing only on
change. **438 tests.** — and, 2026-08-18: **per-project pin-board todo DONE**
(§2 of `reference/LUNACORE_HUD_WIDGET_PLAN.md` — was global, now keyed off each tab's
`session.projectId`, `dcd7b3b`) and **Notifications DONE** (§5.2 below,
`2a6079a`): an opt-in OS toast on a session going busy→idle (background tabs
included — `led.js` never had an idle timer for them before this) or crossing
85% context, per-tab edge/hysteresis mirroring autocompact.js, click focuses
the window (new `window:focus` IPC) and jumps to that tab. **578 tests.** —
and **`package.json`/lockfile synced to `0.9.2`, `v0.9.2` cut and published**
([releases/tag/v0.9.2](https://github.com/Kotsur69/Luna-Core-HUD/releases/tag/v0.9.2),
2026-08-18) — and, 2026-08-19: **God Mode (unattended to-do runner) DONE**
(`71610db`, [`reference/GODMODE_PLAN.md`](reference/GODMODE_PLAN.md)): arm a
tab's to-do list and LunaCore injects each open item in turn, waits for
`onTurnEnd`, ticks it done, injects the next — surviving usage-limit walls
and dropped connections on its own — and **Ctrl+G git quick-menu DONE**
(`4e81a52`, `2eda376`): commit/push/fetch/status per tab, second fix needed
because the shortcut never actually received the keyboard the first time —
and **Auto-proceed DONE 2026-08-19**
([`reference/AUTOPROCEED_PLAN.md`](reference/AUTOPROCEED_PLAN.md)): a
standalone toggle next to Auto-compact, generalizing godmode.js's own
connection-drop recovery so it works on ANY open tab during ordinary work,
not only a tab an active God Mode run owns — arms independently, skips a
tab godmode.js is already handling, 3-retry cap with backoff. **604
tests.** `package.json`/lockfile bumped to **`0.9.3`** (not yet released as
a public build) — and, same day: **smooth pointer-drag to-do reordering
DONE** (`021cf77`, [`reference/TODO_DRAG_REORDER_PLAN.md`](reference/TODO_DRAG_REORDER_PLAN.md)):
replaced native HTML5 drag-and-drop's snap-into-place with a FLIP-based
pointer drag — the dragged row follows the cursor with no lag, and every
sibling row it crosses slides aside live. **617 tests.** — and,
2026-08-26: **Typing Synth DONE**
([`reference/TYPING_SYNTH_PLAN.md`](reference/TYPING_SYNTH_PLAN.md)'s
"Resolved 2026-08-26" section): picked back up from the pause below and
shipped in one day across three passes — sample-based keystroke sounds (7
variants, random pitch per hit) rather than the originally-planned
oscillator synth, replacing the old mpv keystroke path entirely; see that
doc for the full pivot and the CSP bug that was the actual root cause —
and, same day: **MCP debugger, safe half, DONE**
([`reference/MCP_DEBUGGER_PLAN.md`](reference/MCP_DEBUGGER_PLAN.md), from
`CONCEPT_MCP_DEBUGGER.md`): a server's row in the MCP health panel pulses
while a call to it is in flight, and the last 30 completed calls per tab
get a JSON-RPC Inspector list (server/tool/ok-fail/latency, click for the
pretty-printed request/response, capped ~2KB). Deliberately NOT the whole
concept — the failure-injector/restart piece would need LunaCore to proxy a
server and rewrite `~/.claude.json`, which breaks the read-only-config rule
`mcphealth.js` already established, so it stays an open idea in the concept
doc rather than shipping half-safe. **678 tests.** Not yet manually
verified against a real MCP call in the wild (Mati's own MCP usage is rare
— see the health panel's own finding) — that's the actual test, not
`npm test`. |
| **In flight** | **Phase E** — E1 (telemetry widget) and E3 (the two motions C1c deferred) are **DONE 2026-08-09**; **E2/C2 (fold + resize panels) DONE 2026-08-17** (see the Shipped row); **E4/C4 (drag a widget tile between regions) is the one remaining panel-engine piece** — still deferred. Phase D is CLOSED, `v0.9.0` is public, and **`v0.9.1` is now also public** — [releases/tag/v0.9.1](https://github.com/Kotsur69/Luna-Core-HUD/releases/tag/v0.9.1). It carries everything that had landed on `main` since `v0.9.0` with nothing shipped: the sound/voice work, the Settings overlay, the `LUNA_HUD_SPECIFICATION.md` v2.0.0 rewrite, the Active-Files Heatmap, multi-repo project switching, the GPU widget, the D5 chip relocation, and the Electron 33→43 security fixes D5a flagged (§D5a: *"only a released `v0.9.1` actually delivers the fix"*). **D5 (auto-update) verified end-to-end**: an installed build discovers and applies an update going *from* `v0.9.1` onward. Updating *from* `v0.9.0` does not currently work — known, not blocking, not being chased. **Whole-app OS-level window transparency was requested by Mati and explicitly deferred** (not started) — see `reference/TERMINAL_CUSTOMIZER_PLAN.md` §4 for why (frameless-window + custom titlebar, window-recreation-on-toggle, 9-theme token rework — a project of its own). |
| **§D2a checks** | ✅ **PASSED 2026-08-09** — Mati: *"yes everything spawns."* The terminal launches a real `claude` session from the installed build (checked against Electron **33**; §D6a flags that a redo under **43** is still owed — cheap, and belongs in the next pre-flight per §D6a). |
| **Next action** | The MCP debugger's safe half is **shipped, hand-verified 2026-08-27** — `reference/MCP_DEBUGGER_PLAN.md` §6's checklist walked end to end against a real `codebase-memory-mcp` call (pulse, inspector row, modal pretty-print, failure badge, truncation notice, background-tab, PL/EN); no longer a pending item, and the failure-injector/restart piece stays deferred. Typing Synth **shipped 2026-08-26** (see [`reference/TYPING_SYNTH_PLAN.md`](reference/TYPING_SYNTH_PLAN.md)'s "Resolved" section). Auto-proceed itself is still unverified against a real connection drop in the wild — that's the actual test, not `npm test`. Otherwise: pick one of `LUNA_HUD_SPECIFICATION.md` §6's remaining scored module ideas (voice ducking now that Media Deck's volume primitive exists, multi-agent visualizer, …), or **E4/C4 drag-drop** (move a widget tile between regions — E2/C2 fold + resize is already shipped), or §9 multi-model. Redoing the §D2a eyes-only spawn check against the packaged Electron 43 build (never done — the original PASSED was against 33) is cheap and still owed whenever convenient. If Mati wants it, the whole-app transparency project (§10.7) is also still open as its own plan doc. |
| **Direction changed 2026-08-05** | Mati: *"lets scratch the animations and templates work and lets proceed to make this as a working product … the fun stuff we can always make it later."* **C4 is deferred by decision, not blocked** (C2 was later un-deferred and shipped 2026-08-17). Target is a **public GitHub release**, **installer + portable**, **Windows now while keeping Linux/macOS possible**. |
| **Branch** | `main` |

Two facts that decide most design questions here, both learned the hard way:

- **ZERO EXTRA TOKENS.** Every idea in this file must stay a **Passive Observer**
  (read/regex on stdout + files) or an **Action Injector** (write plain text to
  PTY stdin). No hidden prompts, no middleware, no touching the `claude` binary.
  This is the one rule that never changes.
- **Nothing in normal use unmounts a widget**, so a forgotten disposer is
  invisible until Phase C, where it will look like a layout bug. Run
  `npx electron . --luna-probe` after every conversion — equal subscriber counts
  before/after and `rows: 1` means clean. §A2a explains what it checks;
  **§A2b explains what it cannot** (that one cost a near-miss data-loss bug).

Verification commands, in the order they earn their keep:

```bash
npm test                          # 604 tests, ~1 s, no extra deps
npm run dist                      # D2: NSIS installer + portable .exe -> dist/
dist\win-unpacked\LunaCore.exe --luna-probe   # probe the PACKAGED build; result
                                  # lands in %APPDATA%\LunaCore\luna-probe.json
                                  # (a packaged GUI app has no stdout)
npx electron . --luna-probe       # remounts every widget 3×, then cycles every
                                  # layout preset 2× and returns; prints bus counts
npx electron . --enable-logging   # renderer console → stdout (smoke test, no DevTools)
npm start                         # the only way to check anything interactive
```

`--enable-logging` prints **"Renderer process crashed"** on teardown and a CSP
warning. Both are noise — the crash line tracks the `timeout` value. Don't chase
them.

### ✅ Done: per-file context weight (2026-08-17) — LUNA_HUD_ADVANCED_SPEC §2

The last unbuilt piece of the heatmap's spec. Each row now carries `≈6.7k · 2.5%`
alongside its `+`/`-` counts. Full behaviour in README (*Per-file context
weight*); what belongs here is why the number is what it is.

**Measure what entered the window, not what is on disk.** A Read's
`toolUseResult` carries `file.content` — the exact text the CLI pasted. Using it
rather than the file's size gets two cases right for free: a partial read charges
only its slice, and a file read three times charges three times. That second one
is the whole value of the feature; on the session that built it, `uiprefs.js` was
the heaviest file precisely because it was read twice.

**Only a Read counts.** Write content is model *output*; an Edit's result is a
snippet, and the `originalFile` beside it is CLI bookkeeping the model never
sees. Charging `originalFile` would bill a whole file for a one-line edit — the
kind of wrong number that looks plausible, so both cases are pinned in tests.

**The `≈` is load-bearing.** Every other token figure in the HUD is exact,
straight from `message.usage`; the API reports usage per message and never per
tool result, so this one cannot be. It is labelled everywhere it appears, the
tooltip carries the exact character count and the read count, and the ratio lives
in exactly one place (`src/filestat.js`) with the estimate computed once in the
main process — the renderer sums what it is handed and never re-derives it, so
the two halves cannot drift apart.

Validated before building rather than after: a scan of this session's transcript
showed 41 files read, ≈63.6k tokens, **23.4% of peak context**. Worth knowing
that the answer is a quarter and not a rounding error.

Probe after the change: all 18 rows at 1, `activeContext` balanced at 4 before
and after the remount passes (the new subscription disposes cleanly). 567 tests,
up from 557.

### ✅ Done: MCP health + git station (2026-08-17) — two panels that answer questions nothing else does

Both are new backlog items, not scheduled phases: they came out of asking what
the HUD could tell you that Claude Code cannot. Both follow `ports.js` exactly —
main-process scanner, pure parsers, widget contract, lazy load on first mount.
Full behaviour is in README (*MCP server health*, *Git station*); what belongs
here is what the build taught.

**A mention is not a call.** The MCP panel's premise is "which servers am I
actually using", and Claude Code stores no MCP usage — `skillUsage` and
`pluginUsage` exist, MCP has nothing — so it has to be mined out of the
transcripts. The first miner matched `mcp__` anywhere in a line and produced a
confident, completely wrong answer: **every** server on this machine read as
"used today, dozens of calls", and it invented one named `<server>` out of
documentation that spells the pattern out literally. Transcripts are full of
server names that were never invoked — tool definitions, the deferred-tool
listing, prose. Anchoring on `"name":"mcp__…`, which only a `tool_use` block
produces, dropped 23 servers to 17 and the call counts to the truth. Verified
independently by `grep -roh '"name":"mcp__[^"]*"'` over all 55 transcripts
before it was believed. Both failure modes are pinned in tests, because a panel
that answers this question wrongly is worse than no panel.

**And the answer, on this machine: 16 of 17 configured MCP servers have never
been called. Once.** The only real usage in 166 MB of history is two Hugging
Face connector tools, 16 calls. That is the harness audit the panel was built
to make possible, and it paid for itself before shipping.

**Read-only, on purpose.** The panel never writes `~/.claude.json`: a bug there
breaks Claude Code itself, not just the HUD. It never reads an `env` *value*
either — server specs are where API keys live, so only key names leave the main
process.

**The git station's number is `behind`, then `diverged`.** A dirty tree is
self-inflicted and already known; two clones of one repo drifting apart is the
one that stays invisible. LunaCore itself has been bitten (71 commits on the
other PC) and so has money_printer_turbo. A branch with no upstream reports
**noUpstream** rather than `clean`, because ahead/behind are unavailable there
rather than zero — reporting a confident 0 is how divergence hides.

**Fetch yes, pull no.** Fetch cannot touch a working tree, so it is safe from a
panel you glance at; pull can leave a repo mid-merge from a stray click. The
fetch path is checked against the configured list before it runs — the renderer
names a repo, it does not name a directory. Same shape as the MCP probe, which
takes a server *name* and looks the spec up from config the main process read
itself.

**Not on a timer.** The transcript scan is ~1 s and git status is a process per
repo; both answer questions that change a few times a day. So: lazy on first
mount, manual refresh, and a slow 120 s tick for git only. `discoverRepos` runs
on a button, never on a schedule — a status board whose rows appear on their own
is not a status board.

Measured here: transcript scan 660 ms over 166 MB / 55 files (cached per file by
size+mtime after that), repo discovery 8 ms for 12 repos, full status sweep
1.1 s for 12. 552 tests, up from 512.

**✅ The app ran (2026-08-17, later).** `npm install` first — `node_modules` was
still on Electron 33.4.11 against a `^43.0.0` package; it resolved to 43.3.0 with
the node-pty prebuilt intact and 0 vulnerabilities. Boot clean, then
`--luna-probe` passed on every axis: **23/23 widgets mounted exactly once**
(`mcp` and `git` included), three remount passes left every bus subscriber count
identical, four presets cycled twice and landed back on `classic`, and all
**18 themes** cycled with zero tokens leaked or lost.

That run also caught the probe drifting: `rows` is hand-written, and it had
stopped growing after `skills` — `media`, `sessiontimeline`, `devices`, `todo`,
`clipboard`, `mcp` and `git` were never being checked, which is the exact blind
spot its own header warns about. Markers added; the rule now lives in README
(*Checking a widget really tears down*).

**Open, small: `langChange` 24 → 25.** The counter grows by one across the
*layout and theme* passes, not across the remount passes — which is where a
missing widget disposer would show, so `mcp`/`git` are unlikely culprits. The
baseline run that would have settled it failed for an unrelated reason worth
recording: **a `git worktree` checkout cannot run the probe without its own
`npm install`**, because Electron cannot resolve `@lydell/node-pty` and dies in
a modal before the window paints.

**✅ Fixed from that run: the probe was spawning with `shell: true`.** Electron's
log carried a `DEP0190` deprecation, and it turned out to be the only
`shell: true` in the whole codebase — mine, from the same day. With a shell the
args array is concatenated into an unescaped command line, and those args can
come from a `.mcp.json` inside a cloned repo. It was there for a real reason:
Windows MCP launchers are `.cmd` shims and Node refuses to spawn one without a
shell (`EINVAL`, not `ENOENT`, since CVE-2024-27980). `spawnPlan()` runs the
shim through `cmd.exe /c` with the arguments still passed as an array, so Node
escapes each one — verified that `x & echo PWNED` arrives as a single literal
argv entry. Side effect: the **first successful live probe**, `npx
@modelcontextprotocol/server-everything` → `{ok: true, tools: 13, ms: 6755}`.
Worth noting how it surfaced — not from a test, but from reading the log of a
run somebody made by clicking the button.

**Also found: `mpv` is not on PATH, so all sound feedback is silently disabled**
(`[soundManager] ... silent fallback`). This reframes the four zero-byte `.wav`
files still on the backlog — filling them changes nothing until there is a player,
so the player comes first.

**Still owed:** the human half. Nothing above tells us whether a 9 px splitter is
comfortable to grab, how a folded panel sits inside `.panel__scroll`, or whether
`mic.ps1` finds a capture endpoint on this machine.

### ✅ Done: the by-hand pass on `context` (2026-08-03) — and it caught a 3-refactor-old bug

**Result: the conversion is clean.** Bar, `%`, tokens, `Sonnet 5 · 1M` badge and
the `~$` cost line all render; the sparkline draws and the tok/min text updates;
copy-path keeps its path through a PL→EN→PL round-trip; and
`__luna.remount('context')` ×3 leaves `busStats()` identical while bar *and*
sparkline repaint with real numbers (`6% -> 6%`, `spark 2 -> 2`). The half-dead
failure mode did not appear. Two items are still unchecked and cost nothing to
leave open: two tabs holding independent state, and the amber bar + amber tab dot
past 60%.

**What it found is the point.** The burn line read `▲ 2.0k tok/min · w strefie
compact` at **6%** context. Cause: `pushSample()` stored `{t, tokens, percent}`
while `renderBurn()` computed `CTX_WARN_HIGH * last.limit` — `limit` was never in
the sample, so the product was `NaN`, `remaining > 0` was `false`, and it took the
else branch. **The ETA to 85% had never worked once**, in any session, since
`55ac9e5` shipped the sparkline. It survived A1 and A2 because `NaN` comparisons
do not throw — they quietly pick the wrong branch — and nothing in `test/` touched
either function.

Fixed the same day: `limit` now rides in the sample (refreshed on the no-change
path too, since B2 promotes the window mid-session), and the arithmetic moved into
a pure exported `etaMinutes()` that returns **null** when the limit is unknown, so
the UI shows the rate and claims nothing — the rule B4 already set for cost. Nine
tests in `test/spark.test.js` (159 → 168), the last of which feeds a real
`pushSample()` output into `etaMinutes()`: testing them separately would have
passed while the field was still being dropped.

**The transferable lesson:** a value read but never written fails silently when
`NaN` is the intermediate. Unit tests on either half in isolation cannot see it;
only the seam can. Worth a look wherever else one module produces a record another
consumes by field name.

<details>
<summary>The original checklist, kept for the next conversion that needs one</summary>

The `context` conversion shipped **machine-verified only**: 159/159 tests green,
`node --check` clean, and a probe run with `activeContext: 3` / `sessionViews: 4`
**unchanged** before/after (those two numbers are the whole point — if either had
moved, a state-keeping subscription had wrongly been moved into `mount()`), plus
`rows: {…, context: 1, spark: 1}`. None of that can see a pixel. Run `npm start`
and check:

- [ ] Bar fills, shows `%`, tokens, the model badge and the `~$` cost line.
- [ ] Run a few prompts — the sparkline draws and the tok/min text updates.
- [ ] Click ⧉ copy-path → path on the clipboard; **toggle PL/EN and re-check the
      button's tooltip still carries the path** (`applyStatic` resets `title`;
      the `onLangChange` handler is what puts it back).
- [ ] Two tabs: each shows its own `%`, its own sparkline, its own path.
- [ ] Let a tab pass 60% → bar goes amber **and the tab dot goes amber too**
      (that dot is the `thresholds.js` regression check — `sessions.js` reads it).
- [ ] DevTools: `__luna.stats()` → `__luna.remount('context')` ×3 → `stats()`
      identical, and the bar **and** sparkline repaint immediately with real
      numbers, not `0%`.

The half-dead failure mode is the one to look for: a bar that works perfectly
above a sparkline that never draws (or the reverse). Two modules share that root.

</details>

---

<details>
<summary><strong>Historical status log (2026-07-23 → 07-24) — kept for the bug post-mortems</strong></summary>

> Status baseline (2026-07-23): Phases 1–4 + backlog 7A/7B/7C are **done and
> pushed**, plus the **command palette (Ctrl+K)**, **token burn-rate sparkline**,
> **theming system** (§2), **PL/EN language switch**, **usage-limits gauge**,
> **armed auto-compact**, **CWD/project switcher**, and the **cyberpunk boot
> sequence**. That closes the entire §5.5 shortlist — everything below is now
> *future* work, and §8 is the live plan. Order is a suggestion, not a contract.
>
> **Update 2026-07-24:** **A3** (test harness — now 90 unit tests, `npm test`,
> zero new deps), **B1** (persist active profile), **B2** (context-limit
> auto-detect), **B3** (model badge) and **B4** (session cost/time HUD) are done.
> Phase A is 1½ of 5; Phase B is 4 of 7. The remaining structural work — **A1
> (split `renderer.js`) and A2 (widget contract)** — is still the gate in front
> of all of Phase C. **None of it has been hand-launched yet.**
>
> ⚠️ **Bug found and fixed the same day (commit `cba1d4b`):** B2 originally
> defaulted *every* Claude model to a 200k context window. Wrong — the current
> family is **1M** (Opus 4.8/4.7/4.6, Sonnet 5/4.6, Fable 5); only Haiku 4.5 is
> 200k. The bar would have read 100% at roughly 20%, and armed auto-compact
> would have fired far too early. `models.js` now carries a per-model window
> table consulted *before* the default. The A3 net caught it (a B3 test asserting
> `opus-4-8 → 200k` failed — the assertion was the bug, not the fix).
>
> ⚠️ **The same bug, second variant, found on first hand-launch (2026-07-24):**
> the window table fixed above was still **missing `claude-opus-5` entirely**, so
> Opus 5 fell through to the 200k default — the identical lying bar, from config
> drift rather than wrong logic. `config/rates.json` was missing it too, which
> (correctly, by design) meant *no* cost figure at all. Sonnet 5 was in both
> tables and worked, which is what made the fault look model-specific. **Lesson:
> a new model needs two entries, and fixture-based tests cannot see a stale
> table** — `npm test` now asserts the shipped config covers every current model
> (90 → 92 tests).
>
> ⚠️ **Colourless terminal (same launch):** Claude Code exports `NO_COLOR=1`, and
> `stripClaudeSessionMarkers()` scrubbed only `CLAUDE*`. The nested `claude`
> inherited it and rendered with no colour at all (white logo instead of orange).
> Looked like a theming bug; it was not — xterm was receiving plain text, so no
> theme could have fixed it. New `withColorSupport()` clears the colour-suppressing
> vars and declares `xterm-256color` + `truecolor`; the PTY was also still asking
> for 8-colour `xterm-color`. Applied *before* the profile merge so a profile that
> deliberately sets `TERM`/`NO_COLOR` still wins.
>
> **Code comments are English from 2026-07-24 onward** (international project).
> Translation of the older Polish comments is in progress, module by module.
> The one hard rule that never changes:
>
> ⚠️ **ZERO EXTRA TOKENS.** Every idea here must stay a **Passive Observer**
> (read/regex on stdout + files) or an **Action Injector** (write plain text to
> PTY stdin). No hidden prompts, no middleware, no touching the `claude` binary.

</details>

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

- ✅ ~~**Persist active profile**~~ **BUILT 2026-07-24.** Landed in
  `ui.local.json` (`profile` key) rather than `profiles.local.json` as sketched
  here — `uiprefs.js` already existed, already took arbitrary keys, and is
  already gitignored, so it needed no new file or loader. Switching a profile
  saves it; startup prefers it; an id that no longer exists in the config falls
  back silently to `activeProfile` (so a config copied from another machine
  still boots).
- **Session cost/time HUD.** Parse the transcript's `usage` you already read and
  show elapsed session time + a rough token→$ estimate (per-model rate table in
  config). Pure read, zero tokens. This was an original inspiration item.
- ✅ ~~**Model badge.**~~ **BUILT 2026-07-24.** Pill next to the context %,
  showing model **and** detected window (`Opus 4.8 · 200k`); full model id in the
  tooltip. Theme-token-only (`--bg-panel-2` / `--text`), so it inherits all five
  themes; hidden until a model is actually known, so a fresh tab shows no empty
  pill. Unknown ids (local LM Studio models) render **verbatim** instead of being
  guessed at.
- ✅ ~~**Context-limit auto-detect.**~~ **BUILT 2026-07-24**, but *not* the way
  this line assumed. Inferring 200k vs 1M from the model id alone does **not**
  work: 1M is largely a session/beta property and often isn't in the transcript's
  model field at all. `src/models.js` therefore uses two signals: (1) a `1m`
  marker in the id when present, and (2) — the one that actually fixes it —
  **observation**: context cannot exceed its own window, so tokens above the
  assumed limit prove the assumption wrong and promote it to the next known tier.
  Self-healing, and needs no knowledge of beta flags.
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
- ✅ ~~**Notifications.**~~ **BUILT 2026-08-18.** Opt-in OS toast (Electron
  `Notification`, silent) when a session's context crosses 85% or it goes
  busy→idle — active tab or a background one (`led.js` gained a per-bucket
  idle timer for this; background tabs never had one). Per-tab edge/hysteresis
  mirrors autocompact.js's; click focuses the window (new `window:focus` IPC)
  and switches to that tab. Toggle: `notificationsEnabled` in
  `ui.local.json`, its own widget next to Actions. `src/renderer/modules/notify.js`.
  ↳ **Extended 2026-08-27:** the same busy→idle edge now also flashes the
  taskbar button (`window:flash` IPC → `BrowserWindow.flashFrame`) whenever the
  window is unfocused — a milder companion to the toast, under the same opt-in.
  `busyIdleCues()` is the pure split: toast for a tab you are not watching,
  flash only when the whole window is unfocused (then for any tab); Windows
  clears the flash on focus and a `focus` handler clears it after a clicked
  toast. 721 tests.

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
  - **Feature #4 (2026-08-27):** the armed toggle now has three *exclusive*
    trigger modes, picked in the Settings overlay and persisted in
    `ui.local.json` (`autoCompactMode` / `autoCompactEveryTurns` /
    `autoCompactAfterMinutes`; the arm toggle itself stays per-session). `turns`
    fires every N completed turns on the **active** tab (background turns never
    count, same safety model as the threshold); `time` fires N minutes after the
    last compact, but only once context is also past 60% so an idle near-empty
    session is left alone. All three share the 60 s cooldown, the dead-session
    guard, and a new "toggle must be on screen" guard. Four pure deciders
    (`nextThresholdState` / `nextTurnState` / `nextTimeState` /
    `canAutoCompactFire`), unit-covered in `test/autocompact.test.js`. Live
    firing still wants a GUI hand-verification pass.
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
  the signal was already in the stream. Its busy→idle edge is what
  Notifications (§5.2) rides, 2026-08-18.
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

- **`renderer.js` is ~1400 lines** (it grew again with B3). The single biggest debt item now. Split by
  concern (terminal / context / usage / ports / palette / appearance / boot).
  Beware: plain `<script>`s share one global scope — the i18n `t` collision
  bricked the whole renderer once. Prefer `<script type="module">` over more
  IIFEs. This is Phase A1 in §8.
- ✅ ~~**Dead `.panel__spacer` CSS**~~ — **DROPPED 2026-08-03 (A4).**
- ✅ ~~**Skill scan is synchronous (~2.4s).**~~ **BUILT 2026-08-03 (A5).**
- **Refactor `index.html` static panels → widget mounts** (blocks §3/§4).
- ✅ ~~**Tests.**~~ **BUILT 2026-07-24 (A3).** `npm test` → `node --test`, no new
  dependencies. **71 tests** across `test/{observer,profiles,projects,ports,skills,models}.test.js`,
  ~0.4 s. To make them reachable, the module-private pure helpers are now exported
  (`normalizeProfile`, `normalizeProject`/`expandHome`, `parseWindows`/`parsePosix`/
  `dedupeByPort`, `categorize`) — additive only.
  ↳ It earned its keep the same day: the B2 change broke an existing assertion
  (`600k tokens → 100%`, true only while the limit was hardcoded), which is
  exactly the signal a refactor net is for.
  ↳ **Still missing: a smoke test that the window boots.** `node --check` cannot
  catch the one failure mode that has actually bricked this app (the i18n `t`
  global collision) — plain `<script>`s share one scope and only fail at runtime.
  Until A1 moves the renderer to `<script type="module">`, launching by hand
  remains the only real check.
- ✅ ~~**`CONTEXT_LIMIT` const**~~ superseded by auto-detect (§5.1) on 2026-07-24.
  It survives only as a re-export alias of `models.DEFAULT_CONTEXT_LIMIT` for
  back-compat; no arithmetic uses it any more.
- **Boot timings are duplicated** in `styles.css` and `renderer.js`
  (`BOOT_FADE_MS` must match `.boot.is-out`). Small, but if the fade is ever
  retuned, change both.

---

## 7. Packaging & distribution

- **electron-builder** (the old "Phase 5"): produce a real Windows installer
  (`.exe` / NSIS) + portable build, with the LunaCore icon. Then optionally
  auto-update via GitHub releases (repo is already `Kotsur69/Luna-Core-HUD`).
- ~~**First-run config bootstrap.** On first launch, copy shipped `config/*.json`
  defaults into a user config dir so updates don't clobber local edits.~~
  **SUPERSEDED 2026-08-05 (D1) — and the original advice here was wrong.** Copying
  defaults into the user directory would *shadow* them, so an update could never
  deliver a new theme or a corrected rate table. Base and local are already
  separated by filename (`themes.json` ships, `themes.local.json` is yours), so
  the user directory holds **overrides only**. See §D1a.

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
| A1 | ✅ **Split `renderer.js` into modules** | §6 | **DONE 2026-07-25.** 1554 lines → a 60-line entry point + 21 modules in `src/renderer/modules/`, loaded as `<script type="module">`. Verified first: Chromium blocks ESM over `file://`, but **Electron 33 does not** — probed with a throwaway app before committing to the approach, so no bundler and no custom protocol. See A1a below for the two couplings that had to be broken. |
| A2 | 🟢 **Widget contract** | §4 | **Contract DONE 2026-07-25, all 13/13 blocks converted 2026-08-03.** Shape is `{ id, titleKey, template, mount(root) -> cleanup? }` — see A2a for why it is not quite the `{title, mount, unmount}` sketched here, A2b for the one thing a mechanical port still got wrong, A2e for the first mounting-order dependency between two widgets, and A2f for the one widget (`terminal`) that opts out of remounting entirely. |
| A3 | ✅ **Tests on the pure modules** | §6 | **DONE 2026-07-24.** `npm test` → `node --test`, now 92 tests, ~0.4 s, no new deps. Includes two **data** tests asserting the shipped rate/window tables cover every current model — logic tests on fixtures cannot catch a stale table. Covers `usageToMetrics`, `encodeProjectDir`, `detectTools`, `normalizeProfile`, `expandHome`/`normalizeProject`, `parseWindows`/`parsePosix`/`dedupeByPort`, `categorize`, `contextLimitFor`/`modelLabel`. This is the net that made A1 safe — it caught nothing during the split, which is the point: the suite covers the *pure* modules, and A1 never touched them. Now 117 tests. |
| A4 | 🟢 **Kill the dead bits** | §6 | **DONE 2026-08-03.** `CONTEXT_LIMIT` is no longer a magic number (now an alias of `models.DEFAULT_CONTEXT_LIMIT`), and the dead `.panel__spacer` CSS rule (`src/renderer/styles.css`) — unused since its div was removed in 7C — is dropped. |
| A5 | **Async skill scan** | §6 | 🟢 **DONE 2026-08-03.** `scanSkills()` (`src/skills.js`) walks with `fs.promises.readdir`/`readFile` and fans out concurrently (`Promise.all` across subdirs and files) instead of blocking the event loop with `readdirSync`/`readFileSync`. `loadSkills()` caches the in-flight **Promise** (not a resolved value) so concurrent callers dedupe; a new `rescanSkills()` (IPC `skills:rescan`, `preload.js`) replaces that cached promise to force a fresh scan. `main.js` dropped the `setTimeout(…, 3000)` pre-warm — `loadSkills()` now fires immediately since it no longer blocks. UI: a `.usage-refresh`-style ↻ button next to "Skille" in `w-skills` (`skills.js`), spinning via `is-spinning` while awaiting. Verified: 168/168 tests, `--luna-probe` unchanged (main-process-only change), and hand-confirmed by Mati — rescan works without an app restart. |

#### A1a — what the split actually cost

Moving code was the easy half. The single file hid **two couplings** that only
became visible once modules had to name their dependencies, and both are now
tiny subscriber lists in `src/renderer/modules/bus.js` rather than direct calls:

1. **`applyLang()` was a hub.** It hard-called `renderLed`, `renderPtyStatus`,
   `renderCtxText`, `renderBurn`, `renderUsage`, `renderAutoCompact`,
   `renderBootPref` and reset the palette cache — i.e. the appearance section had
   to import eight other modules. Now `appearance.js` emits one language change
   and each module re-renders **its own** text.
2. **Tab switching reached into three sections' globals.** `stashActive()` /
   `restoreActive()` read and wrote `sparkBuf`, `lastCtxMetrics`, `ledState`,
   `ledDead` directly. Now each module registers a `{save, load, clear}` view on
   the bus, so **no module writes another's keys** on a session bucket.

Two smaller wins fell out of it: the sparkline sampling rule existed twice
(active tab and background tab, subtly different) and is now one `pushSample()`;
and auto-compact stopped being called from inside `applyCtxMetrics` — it
subscribes to the live-metrics stream itself, which removes an import cycle and
makes "never fires on a tab restore" structural instead of a `live` flag.

**Known papercut, deliberately not fixed here** (behaviour-preserving refactor):
switching language does not re-render the tab strip, so a tab's close-button
tooltip keeps the old language until the next `renderTabs()`. One line —
`onLangChange(renderTabs)` in `sessions.js` — whenever someone wants it.

#### A2a — the contract, and the two things the one-liner hid

The sketch was `{ id, title, mount(el), unmount() }`. What shipped is
`{ id, titleKey, template, mount(root) -> cleanup? }`, and each difference is
load-bearing:

- **`titleKey`, not `title`.** Once a layout preset renders block headers, a
  literal string freezes the HUD into one language. The key is resolved through
  i18n at render time.
- **`template`, not markup in JS.** Each block's HTML moves into a
  `<template id="w-…">` at the end of `index.html` and is cloned on mount, so the
  live DOM is identical to what the static markup produced — **this whole
  refactor needed no CSS changes**. Building blocks with `createElement` would
  have thrown away the `data-i18n` attributes and the ability to read the HUD's
  structure as HTML. Rule: a template holds **exactly one root element**, which
  becomes the widget root — an extra wrapper would be one more level for the
  panel's flex layout to trip over.
- **`mount()` returns its cleanup** instead of a separate `unmount()`. The
  disposers are closed over by the function that created them; a sibling method
  would have to re-find them in module state.

**The blocker the plan did not mention: nothing could unsubscribe.** `bus.js`
subscriber functions returned `void`, and renderer modules subscribed to IPC
directly — where preload exposes only `ipcRenderer.on(...)` with **no removal**
(`preload.js` `onPorts`/`onUsage`). A remounted widget would therefore leave its
old handler behind and render twice per tick, permanently, with no way to undo
it. Two changes fix it, and they are the actual prerequisites:

1. Every `bus.js` subscribe call now returns a disposer.
2. New `modules/feeds.js` owns one IPC listener per process-wide channel and
   re-emits on the bus. **The rule: IPC listeners live at module scope; widgets
   only ever touch the bus.** `sessions.js` keeps its own because it is the
   session router — it demultiplexes by `sessionId` before anyone can use a
   payload, and already fans out through the bus.

The feed channels **replay** their last payload to a late subscriber. Without
that, a widget mounted between two polls would sit empty for up to 90 s (usage).

**Verifying it is the hard part, and needed new tooling.** Nothing in normal use
unmounts anything, so a forgotten disposer is invisible — it would first show up
in Phase C, looking like a layout bug. Three things now make it checkable:

- `busStats()` reports subscriber counts per channel.
- `window.__luna` in the renderer: `remount(id)`, `mounted()`, `widgets()`, `stats()`.
- **`npx electron . --luna-probe`** — mounts the HUD, remounts every widget three
  times, prints counts before/after, and quits. Equal counts = clean teardown;
  `rows: 1` = mounted exactly once, neither missing nor duplicated.

First run was clean on all counts.

**Hand-verified by Mati the same day** (app launched, not just probed): the block
mounts in its old position and still grows; filter toggle, the folded-count line,
open / copy / kill and the PL↔EN switch all behave; the usage tile still fills
through the rewired feed; and the whole HUD is unregressed — context bar, badge,
cost, sparkline, tabs, themes, palette, skills search, scratchpad. **The B8
duration sweep was watched for the first time here too, and works** — including
a tool still running after a tab switch, which had also only ever been unit-proven.

Two smaller notes. `src/renderer/package.json` (`{"type": "module"}`) lets Node
load these ESM files directly — **the `.mjs` copy trick used to `node --check` the
renderer in A1 is retired**, and `test/` can now reach renderer modules, which is
what makes `registry.js` testable (142 tests). And the transitional
`[data-slot]` placeholder is `display: contents`, so it contributes nothing to
layout while converted and unconverted blocks sit side by side; Phase C replaces
it with real named slots.

**Conversion order for the rest** (each one leaves the app working):
~~`scratchpad`~~ → ~~`skilltracker`~~ (timers must stop on unmount) → ~~`usage`~~
(30 s tick) → ~~`context`+`spark`+`autocompact`~~ (coupled trio, three session
views) → ~~`cheatsheets`/`prompts`/`skills`~~ → ~~`switchers`/`actions`/`appearance`~~
(§A2e) → ~~`terminal`~~ (§A2f), last, since it owns the xterm panes. **A2 is now
fully converted, 13/13.**

#### A2b — `scratchpad` (2026-07-27): cleanup is not always "undo"

The second conversion was meant to be the mechanical one, and the markup half
was: template + slot, zero CSS. But a straight port would have introduced a
**data-loss bug that the probe cannot see**.

The autosave is debounced 500 ms. Cleanup's job is usually to *cancel* pending
work — and cancelling here silently throws away the user's last edit if the
widget unmounts mid-pause. So `cleanup()` **flushes**: it clears the timer, then
fires the save it was waiting on.

The general rule, worth carrying into the remaining conversions: a disposer must
cancel *effects*, but commit *pending user intent*. `skilltracker` and `usage`
are next and their timers are pure display — those genuinely just cancel.

Cheap tell for which kind you have: if the timer's callback writes anything the
user typed, it needs a flush.

#### A2c — `autocompact` (2026-08-03): the first widget whose state is not in its DOM

The right-panel five were all, in the end, painters: hand them a payload and they
redraw. `autocompact` is the first converted block that **owns state the DOM does
not hold** — `autoCompactArmed` is a module variable, and the `<template>` clone
always arrives unchecked. Three things fell out of that, in rising order of how
badly they bite.

1. **mount() must repaint from module state.** A remount rebuilds the toggle in
   its authored state, so without an explicit restore the HUD would read *off*
   while the module kept firing `/compact`. Not a cosmetic bug: a wrong label on
   the one control in the app that **spends tokens on its own**. The probe cannot
   see this — it counts subscribers, not pixels.
2. **The edge/cooldown flags must NOT be per-mount.** `autoCompactFired` and
   `autoCompactFiredAt` are the entire anti-spam mechanism. Had they moved into
   `mount()`, a remount would re-arm the edge and clear the 60 s cooldown, i.e.
   hand you a second `/compact` seconds after the first. They stay module-level;
   only the *view* is rebuilt.
3. **The injecting subscription belongs in `mount()`, not at module scope.**
   Tempting to leave `onActiveContext` at import time "so it keeps working" — but
   unmounted means there is no visible toggle, and an injector the user can
   neither see nor disarm is precisely what the zero-surprise-spend rule exists
   to prevent. Unmounted auto-compact is *off*, and remounting restores the armed
   state it had.

The generalised rule, next to A2b's: **a disposer cancels effects and commits
pending user intent; a mount restores view from state, and must never reset the
state itself.** The flash timer here is the easy half — it only repaints a label,
so it cancels, exactly as A2b predicted for "pure display" timers.

One shape note for whoever does `actions`/`appearance` next: this widget's root
is **not** a `.panel__section` — it is the `<label class="switch-field">` itself,
because the block shares the "Akcje" section with the physical COMPACT button.
Wrapping it in a section would have turned one panel section into two and changed
the spacing. The "exactly one root element" rule says nothing about *which*
element, and `boot-field` in the Wyglad section will have the same shape.

Also worth knowing: the `WIDGETS` list in `renderer.js` used to be documented as
cosmetic. It is cosmetic **for layout** only — a widget that subscribes in
`mount()` joins its bus channel in mount order, so `autocompact` has to be
mounted after `context` to keep the subscriber order the old import order gave
them. The comment there now says so.

Verified: 159/159 tests, `node --check` clean, and a probe run with
`activeContext: 3` / `langChange: 13` **identical before and after** 3× remounts —
matching the pre-change baseline, which is what proves the subscription moved into
`mount()` rather than being duplicated. `rows.autocompact: 1` (the probe gained
that counter; its own doc says every converted widget owes one).

**Hand-verified by Mati (2026-08-03)**, app launched, not just probed:

- [x] Placement unchanged — the toggle sits flush under COMPACT CONTEXT with the
      same spacing. This is the check for the `<label>`-as-root decision: a
      `.panel__section` wrapper would have shown up as a seam splitting Akcje.
- [x] Arming works — `.is-armed` glow, status `uzbrojone · prog 85%`.
- [x] PL/EN round-trip **while armed** is exact: `uzbrojone · prog 85%` →
      `armed · 85% threshold` → back. The `onLangChange` disposer is correct.
- [x] `__luna.remount('autocompact')` while armed → `{checked, armed, status}`
      **identical** before and after, `activeContext` still 3. Failure mode 1 is
      closed: the state restore in `mount()` works and nothing leaked.

**Not exercised by hand:** the live 85% crossing, i.e. an actual `/compact`
injection and the `wyslano /compact` flash. Deliberately skipped — it costs a
real compact, and this refactor did not touch `maybeAutoCompact()`'s logic or the
injector it calls. The hysteresis/cooldown arithmetic is unit-covered; what was
*not* re-proven end-to-end is that the flash still paints on the remounted DOM.
Cheap to fold into the next session that legitimately hits 85%.

> **Update 2026-08-27 (Feature #4):** `maybeAutoCompact()` is gone — split into
> `onContext()` plus the pure `nextThresholdState` / `nextTurnState` /
> `nextTimeState` / `canAutoCompactFire` deciders (see §5.1's Feature #4 note).
> The `context`-mode path is the same arithmetic; `turns` and `time` are new and
> still owe the same live hand-verification.

#### A2d — the three list builders (2026-08-03): renders that read state out of the DOM

`cheatsheets`, `prompts` and `skills` converted as one group because they are one
shape: an async `init*()` that loads config into module state, a render that
rebuilds a `.cheats` container from it, and a delegated click that injects into
the pty. Converting them together meant the second and third cost almost nothing.

The trap they share is new, and it is the natural sequel to §A2c. There the
question was *"is this state or view?"*. Here the render **answered that question
by asking the DOM** — `cheatsheets` and `prompts` recovered which `<details>` the
user had expanded by querying the live nodes, then rebuilt from what they found:

```js
const open = [...container.querySelectorAll('.cheat')].map((d) => d.open);
container.innerHTML = '';   // …and now the only copy of that state is gone
```

That is correct for the case it was written for — a language switch, where the
old nodes are still standing when the render begins. On a **remount** they are
not: the nodes were dropped by `unmountWidget`, the read returns `[]`, and every
group snaps back to "first one only". Nothing throws, nothing logs; you just find
the panel collapsed and blame yourself for having closed it.

**The rule: a render may write to the DOM, never read from it.** If a render needs
to know something, that something is state and belongs at module scope. The DOM is
an output.

`skills` had the sharper version of the same question, because its filter query is
not a preference — it is something you **typed**. §A2b's rule decides it: a
disposer cancels effects but commits pending user intent, and a query is intent.
It lives at module scope, `mount()` restores the input from it, and a remount
finds the same narrowed list you left. That change also fixed `currentQuery()`,
which read the box directly and therefore answered `''` for any render happening
while the widget was off screen. Its `<details>` state needed none of this: it is
*derived* (`open = Boolean(q)`), not chosen, so it rebuilds itself — the useful
distinction being **chosen state must be stored, derived state must not be**.

Two smaller notes for the conversions still to come:

- **Keep `--grow`.** All three sections carry `.panel__section--grow`, and they
  are what divide the left panel's free height between them. Dropping it from any
  one would silently redistribute the other two. (`w-usage` already carries the
  mirror-image note: it does *not* grow, and copying a growing template would have
  done the same damage in reverse.)
- **The probe's `rows` counter should point at the container, not the content.**
  These three fill themselves from async config that may not have landed when the
  probe runs. `#cheatsheets` / `#prompts` / `#skills-search` always exist once
  mounted; counting entries would have made the probe flaky for no benefit.

Verified: 168/168 tests, and a probe run with **9 widgets** mounted, each remounted
3×, reporting identical bus counts before and after (`langChange 13 → 13`) and
every `rows` marker at 1.

**Hand-verified by Mati (2026-08-03)**, app launched, not just probed. The check
that matters is the round-trip the old code would have failed:

- [x] Expand a group, type a filter, `remount` all three → `open true -> true`,
      `query "react"` intact, `count (16/335) -> (16/335)`, bus stats identical,
      one container each. Both halves of the lesson above, closed.
- [x] Placement, order and shared height unchanged; PL/EN relabels headers, group
      titles, category names and the count.
- [x] One click on a cheat button injects **exactly one** command — the failure
      mode subscriber counts cannot see, since these listeners live inside `root`.

#### A2e — `actions`, `appearance`, `project`, `profile` (2026-08-03): a nested slot, and a second one-root-two-owners widget

Four widgets, one new structural wrinkle each has since made moot for whoever
does `terminal`:

**A mounting-order dependency, for the first time.** `autocompact`'s
`[data-slot]` used to sit directly in `index.html`'s static markup; converting
`actions` moved that slot *inside* `w-actions`'s `<template>`, since the toggle
and the physical COMPACT button share one `.panel__section`. That makes
`actions` a hard prerequisite for `autocompact`: `mountIntoSlot('autocompact')`
does `document.querySelector('[data-slot="autocompact"]')`, and that element
does not exist until `actions` has already been mounted and cloned its
template into the DOM. `renderer.js`'s `WIDGETS` array was previously only
order-sensitive for the bus (`autocompact` after `context`); it is now also
order-sensitive for **DOM existence**, and the comment above the array says so.
Nothing else nests like this yet, but `terminal` owning the xterm panes means
it is worth checking before assuming order there is cosmetic too.

**`boot.js` needed the `mountSpark()` treatment.** `#boot-toggle` /
`#boot-status` live in the Wyglad section, which became the `appearance`
widget — but `boot.js` also owns the always-present `#boot` overlay, which is
static markup outside any widget and must stay that way. Splitting the file
in two would have been the wrong fix (the overlay and the toggle share
`bootEnabled`/`renderBootPref`). Instead `boot.js` grew a `mountBoot(root)`
export that `appearance.js` calls from its own `mount()`, identical in shape to
`context.js` calling `mountSpark(root)` — one root, two owning modules, one
`return` composing both disposers.

**The repaint-from-state rule (§A2c) applies to `<select>`s too.** A remount
clones the template fresh, so `<select>` comes back with whatever `<option>`
was authored first selected — not the theme or profile actually active.
`appearance.js` now keeps `activeThemeId` at module scope (language needed no
twin: `window.i18n.lang` is already the global source of truth) and repaints
the theme `<select>`'s options and value from it on every mount, not just at
first launch. `switchers.js` has the sharper version: the profile/project
`<select>`s reflect **whichever tab is active**, which changes on every tab
switch via `syncSwitchers()`, not just once at startup — so it tracks
`currentProfileId`/`currentProjectId` separately from `lastProfiles.activeId`/
`lastProjects.activeId` (the latter is only ever the config file's default and
would have silently reverted the pick on a remount otherwise).

**Two widgets from one file, again.** `switchers.js` splits into `profile` and
`project` for the same reason `cheatsheets`/`prompts`/`skills` are three
separate `defineWidget()` calls in one file (§A2d): each `<select>` is its own
`.panel__section`, and a template holds exactly one root.

Verified: 168/168 tests, and a probe run with **13 widgets** mounted, each
remounted 3×, reporting identical bus counts before and after (`langChange`
unchanged) and every `rows` marker at 1. Hand-launched and confirmed by Mati
2026-08-03 (theme swap, PL/EN, profile/project switch mid-session, the COMPACT
button, the boot toggle).

#### A2f — `terminal` (2026-08-03): the one widget that must never remount

The last block, and the one the whole conversion order (§A2a) was built around
avoiding until everything else was proven out.

**The risk.** `terminal`'s children are not just in-memory JS state like every
other widget converted so far — `terminals.js`'s `ensureTerm()`/`termsBySession`
own real `xterm.Terminal` instances wired to real PTY child processes. The
standard widget contract clones a fresh `<template>` on every `mount()`, which
is exactly what makes `unmount()`/`remount()` safe to exercise elsewhere (§4's
whole reason for existing: catch a leaked subscriber). For `terminal` that same
clone would produce a brand-new, **empty** `#terminal` div — every running
session's live xterm buffer would be silently detached from the DOM while its
process kept running headless in the background. No error, no console warning
(before this fix) — tabs would just appear to vanish.

**The fix: `remountable: false`, not "skip the conversion."** Presented with
this to Mati directly rather than picking silently; his call (recorded verbatim
as "Adapted widget, remount excluded") was to keep `terminal` a real, registered
widget — so Phase C can still treat it structurally like everything else — but
make `unmount`/`remount` explicitly refuse instead of running:
- `registry.js`'s `normalizeWidget()` gained a `remountable` field, defaulting
  to `true`; `terminal` is the only spec that sets it to `false`.
- `host.js`'s `remountWidget()` checks the flag first and, if `false`, logs a
  `console.warn` and returns `false` instead of unmounting/remounting.
- No change was needed to `--luna-probe` itself (`src/main.js`) — it only calls
  `remountWidget()` on whatever `__luna.mounted()` reports, and that call is now
  a harmless no-op for `terminal`.

**Composition needed a new file, not an extension of `terminals.js`.** Four
modules share the one `<main>` root: `terminals.js` (the xterm host),
`led.js` (working/waiting indicator), `sessions.js` (tab bar), `palette.js`
(the Ctrl+K chip). `sessions.js` and `palette.js` already import FROM
`terminals.js` — importing back would cycle, the exact thing A1a's history
warns against — so the composition (`defineWidget({id:'terminal', ...})`) lives
in a new `modules/terminal.js` instead, calling `mountTerminalHost(root)` /
`mountLed(root)` / `mountTabs(root)` / `mountPaletteChip(root)` and returning no
cleanup at all (there is nothing to undo — this widget is never meant to come
back down).

**Each of the four modules got the same small surgery**: the element(s) it
used to grab via top-level `document.getElementById()` moved into a
`mountX(root)`-style export using `root.querySelector()`, with a null-guard
added to whatever render function reads them. `sessions.js`'s IPC listeners
(`onData`/`onExit`/`onContext`/`onTools`/`onRestarted`/`onSessions`) stay at
module scope, unchanged — ES module imports run synchronously before any real
IPC event can fire, so by the time one lands, the widget-mount loop (which runs
before any `initX()` call, see `renderer.js`) has already set every `els`/
`tabEls` binding.

Verified: 168/168 tests, and a probe run with **all 14 widgets** listed and
mounted (`terminal` included), each of the 13 remountable ones remounted 3× with
identical bus counts before/after, and `terminal` staying mounted and untouched
by the sweep (refused internally, no crash, no count drift). **A2 is now fully
converted — 13/13 blocks.** Hand-launched and confirmed by Mati 2026-08-03
(tabs, LED, Ctrl+K palette, no session ever went blank).

### Phase B — Daily-driver quick wins (§5.1)

Cheap, satisfying, all Observer/Injector. Safe to cherry-pick in any order once
Phase A is done — or before it, if you want a break from refactoring.

| # | Item | Notes |
|---|------|-------|
| B1 | ✅ **Persist active profile** | **DONE 2026-07-24.** `ui.local.json` `profile` key; unknown id falls back silently to config. |
| B2 | ✅ **Context-limit auto-detect** | **DONE 2026-07-24** — see §5.1 for the correction: the model id alone is *not* a sufficient signal, so `src/models.js` also promotes the window when observed tokens exceed it. Kills the "bar lies on 1M sessions" bug. |
| B3 | ✅ **Model badge** | **DONE 2026-07-24.** Pill showing model + detected window (`Opus 4.8 · 200k`), theme-token-only, hidden until a model is known. Same parse as B2 — two payoffs, as predicted. |
| B4 | ✅ **Session cost/time HUD** | **DONE 2026-07-24.** `config/rates.json` (+ gitignored local override) + pure `src/rates.js`. Observer accumulates cumulative session usage incrementally (reads only bytes appended since the last tick). Renderer shows `12m 4s · ~$0.83`. **An unknown model gets no estimate at all** — a confident wrong number is worse than none. |
| B5 | ✅ **Port filter toggle** | **DONE 2026-07-25.** `isSystemPort()` in `src/ports.js` tags each row (`system`); the renderer decides whether to show them. Three signals — known OS process names, ports < 1024, ports ≥ 49152 — with a dev-port allow-list that beats both ranges. The line under the list always says how many rows were folded, so it stays a toggle and never a silent filter. Persisted as `hideSystemPorts`. |
| B6 | ✅ **Copy-transcript-path button** | **DONE 2026-07-25.** The observer puts the file it pinned on the metrics object, so the path is per tab for free and needed no new IPC. Button hidden until a file is pinned; full path in the tooltip. |
| B7 | ✅ **Skill search box** | **DONE 2026-07-25.** Filters on name **and** description, expands every surviving category, and shows `12/339` in the counter so a filtered view is never mistaken for the whole list. Pure renderer re-render — the scan result was already in memory. |
| B8 | ✅ **Skill Tracker: duration, not a blink** | **DONE 2026-07-25.** A tile sweeps left→right for as long as the tool actually runs and flashes once when it returns. Built as sketched: the watcher emits a `{phase,id,tile,at}` lifecycle on the existing `metrics:tools` channel and the renderer owns the visual state machine. See below for how each of the four obstacles was answered. |

#### B8 — how the four obstacles were answered

The tracker had **no concept of a tool finishing**. `lightTiles()` added
`.is-active` and set a `TILE_ACTIVE_MS = 1500` timer that each new detection
merely restarted, so a long `Bash` and an instant `Read` looked identical.

The end signal was in the transcript all along: a `tool_use` block carries an
`id`, and a later user message carries a `tool_result` with a matching
`tool_use_id`. `toolEventsFromLines()` reads both shapes and `foldToolEvents()`
pairs them — still Passive Observer, still zero extra tokens. `toolsFromLines()`
is now derived from the same parser, so one place understands the transcript
instead of two.

1. **Poll granularity.** Both halves of a fast tool arrive in one 1.5 s tick.
   Answered on two axes: duration comes from the entries' own `timestamp`, never
   from when we happened to read them, and the tile honours a
   `MIN_ACTIVE_MS = 900` floor measured from when it *lit* (the start may have
   been read seconds late). Replaying a real session showed **27 of 48 calls
   finished under 1.5 s** — over half would otherwise have been invisible.
2. **The fill is indeterminate.** `.is-running::after` is a looping gradient
   sweep, not a percentage. It stops on `tool_result`, then `.is-done` flashes
   for 450 ms.
3. **Tools that never return.** A `MAX_ACTIVE_MS = 10 min` watchdog. A first
   pass over an existing transcript folds its events and then **drops** the open
   map: a tool left dangling by a killed session is history, not live activity.
4. **Concurrency.** The renderer keeps `id -> {tile, startedAt}` and counts per
   tile, so `Edit`/`MultiEdit`/`NotebookEdit` share one tile that goes dark only
   when the last outstanding id closes.

Two decisions worth remembering. **A background tab's events are folded onto its
bucket, not dropped** — a tool that starts while you are looking elsewhere has to
still be running when you come back, and that is only true if we tracked its
start; stale ids are pruned when the bucket loads, since a background tab runs no
watchdog. And the whole thing is driven by **one reconcile loop** that ticks only
while a tile is lit: per-tile and per-id timers were the obvious alternative and
would have meant four timer maps to keep in sync.

Under `prefers-reduced-motion` the sweep becomes a **static fill** rather than
being exempted from the global block — the "running" state still reads, nothing
moves.

#### What B8 exposed: the shell tile had never lit on Windows

First hand-launch found the Shell tile dead while every other tile worked. Not a
B8 bug — `TOOL_TILES` predated Claude Code's **PowerShell** tool and only listed
`Bash`/`BashOutput`/`KillShell`. On Windows the CLI reaches for PowerShell for
most shell work, so the tile had probably never lit on this machine. Counting
tool names across recent transcripts: **PowerShell 49, Bash 19**. The tile is now
`Shell` and covers both.

Two things worth keeping from that:

- **The duration sweep is what made it visible.** While every tile was a 1.5 s
  flicker, a missing flicker read as "I must have blinked". A tile that stays lit
  for seconds makes an absent one obvious. Better feedback finds bugs that better
  tests did not.
- **The suite could not have caught it, for the same reason the stale rate table
  slipped through** (see A3): every test fed the parser a name it already knew.
  Fixture-shaped tests verify the *logic*, never the *table*. The durable check
  is the one that found it — scan real transcripts for tool names the map has no
  entry for. Worth re-running whenever the CLI ships new tools; `AskUserQuestion`
  is currently tile-less too, deliberately.

### Phase C — Layout & visual templates (§2.3, §3)

The original "move the elements around" ask. Only sane **after** A2.

| # | Item | Ref | State |
|---|------|-----|-------|
| C1 | **Layout presets** as data | §3.1 | ✅ **DONE 2026-08-05** — 4 presets, live switching, 24 tests. See §C1a. |
| C2 | **Collapsible + resizable panels** | §3.2 | ✅ **DONE 2026-08-17** — chevron collapse on every widget title, drag splitters on the column boundaries, no library. Both persist into `ui.local.json` as predicted. `src/renderer/modules/panels.js` + 27 tests. See §C2a. |
| C3 | **Theme vocabulary + motion tokens** | §2.3, §C1b | ✅ **DONE 2026-08-05** — 17 → 45 tokens, 5 → 9 themes, 2 bundled faces, layout-switch stagger, 16 tests. See §C1d. **2026-08-17: 9 → 18 themes**, no new tokens needed — see §C2b. |
| C4 | **Drag-and-drop rearrange** | §3.3 | ⏸ **DEFERRED 2026-08-05 by decision** — stretch. Evaluate a dep honestly before pulling one in. |

#### C1a — layout presets: the design, and the one rule that makes it safe

**Shipped so far (2026-08-05):** `src/layouts.js` + `test/layouts.test.js` (168 → **184 tests**).
Pure, DOM-free, same base+local merge and reject-don't-repair validation as
`themes`/`profiles`/`projects`. Schema:

```json
{ "id": "classic", "label": { "pl": "Klasyczny", "en": "Classic" },
  "grid": { "columns": "260px 1fr 280px", "rows": "1fr", "areas": ["left main right"] },
  "chrome": { "brand": "left", "status": "left" },
  "slots": { "left": ["actions", "…"], "main": ["terminal"], "right": ["context", "…"] } }
```

`areas` is `grid-template-areas` as an array of rows, and **region names come out
of the areas themselves** — there is no fixed left/center/right vocabulary, so a
preset can be three columns, two columns, or a terminal-over-dock without the
loader knowing those shapes exist.

**The rule the whole feature rests on: a layout switch MOVES widget roots between
slots, it never remounts them.** `terminal` is `remountable: false` (§A2f) because
its children are live xterm instances wired to real PTYs; a re-clone would orphan
every running session. A DOM move (`slot.appendChild(existingRoot)`) preserves the
subtree, so the same code path is safe for every widget — and it sidesteps every
state-restore concern §A2c/§A2d catalogued, because nothing is ever rebuilt.
Follow the move with `fitAndResize()`; xterm needs to re-measure, not re-create.

A widget the *new* layout has no region for is genuinely unmounted — and that is
safe precisely because of the A2 discipline: §A2c makes `mount()` repaint from
module state, §A2d keeps chosen state (filter query, open groups) at module
scope. **The conversion work is what makes layout switching cheap.**

**Two validation rules protect the user from a config they cannot escape**
(`REQUIRED_WIDGETS`, both unit-pinned): a layout must place `terminal` (or the
HUD has no terminal) and must place `appearance` (or it hides the layout
`<select>` and locks you into itself until you hand-edit JSON). Both failures are
silent and total, which is exactly what boundary validation is for.

**Built (2026-08-05).** Four presets in `config/layouts.json`: `classic` (today's
HUD, unchanged), `focus` (terminal + one 250px rail, monitor blocks unmounted),
`monitor-heavy` (380px right column with every list in it), `bottom-dock`
(terminal on top, three docks under it). `layouts:list` IPC beside `themes:list`,
a `layout` key in `uiprefs.js`, `src/renderer/modules/layout.js`, a layout
`<select>` in Appearance, and `.app` emptied out in `index.html`.

Four things that turned out to matter, none of them obvious from the schema:

- **Chrome is not a widget, and cannot become one.** `ptystatus.js` captures
  `#pty-status-dot` **at import time**, and `<template>` content is not part of
  the document — so the brand mark and the PTY status line can never live in one.
  They sit in `<div id="app-chrome" hidden>` and `layout.js` *moves* them into
  whichever region `layout.chrome` names, parking them back there while the shell
  is rebuilt. A preset that points chrome at the terminal's region is **corrected,
  not honoured** (that region is rendered bare, so the nodes would be dropped) —
  the one place in this loader that repairs instead of rejecting, because losing
  the connection indicator has an obviously right answer.
- **The terminal's region is rendered bare** — no padding, no `.panel__scroll`.
  Its root is already a full `.panel--center`, and xterm measures against a fixed
  box: put it in an `overflow-y` container and it grows instead of fitting.
- **`renderer.js`'s two ordering constraints are now enforced structurally**,
  not by list order. Nested widgets mount **last**, which satisfies both at once:
  `autocompact` joins the context channel after `context` (bus order) and after
  `actions` exists (its slot is inside `w-actions`). A layout still cannot place
  it, and `planRegions()` warns and skips if one tries.
- **Top-level `await`.** The presets arrive over IPC, so `renderer.js` is still
  importing when `did-finish-load` fires. The bottom `DOMContentLoaded` listener
  became a direct `fitAndResize()`, and `--luna-probe` now polls for `__luna`
  instead of concluding the renderer died.

**A pre-existing bug this surfaced.** `remountWidget()` re-clones the host's
template, whose nested placeholder is empty — so `__luna.remount('actions')` left
`autocompact` registered as mounted with its root in a detached subtree. Invisible
before C1 because nothing ever remounted `actions` in anger. `NESTED` now lives in
`host.js` (not `layout.js`) and `remountWidget()` takes nested children down and
puts them back. The probe gained `rowsAtStart` / `rowsAfterRemounts` so a future
zero can be blamed on the right pass.

**Verified:** 192/192 tests; probe cycles all four presets twice and returns to
`classic` with `activeContext: 3` / `langChange: 14` **identical** at all three
checkpoints and every `rows` marker at 1.

⬜ **Not hand-checked by Mati yet** — the probe cannot see a pixel. Run `npm start`
and look at `focus` and `bottom-dock`: region gaps, whether the docks are tall
enough at 270px, and whether the terminal still fits after each switch.

#### C1b — why every theme looks like the same HUD in a different hue

**The diagnosis, and it is not architectural.** `applyThemeVars()`
(`appearance.js`) does `root.style.setProperty(k, v)` for *any* `--*` key, so a
theme can already carry any token at all — `--radius` proves it (matrix ships
`4px`, everything else `10px`). The problem is that **the vocabulary is 17
tokens and 15 of them are colours.** Everything that gives a look its identity —
typography, border treatment, glow strength, texture, motion character — is
hardcoded in `styles.css`. A theme therefore *cannot* be more than a hue swap.

**So C3 is mostly additive: grow the vocabulary, have `styles.css` consume it.
`theme.js` and `applyThemeVars()` need no changes.** Five groups:

| Group | Tokens | What it buys |
|---|---|---|
| **Form** | `--radius`, `--radius-sm`, `--border-w`, `--panel-gap`, `--pad-panel` | matrix reads as a terminal (0px, hairline), nord as an IDE (12px, soft) |
| **Typography** | `--font-ui`, `--font-mono`, `--font-display`, `--tracking-title`, `--case-title` | the single biggest identity lever, and currently 100% hardcoded |
| **Depth** | `--glow-strength`, `--text-glow`, `--shadow-panel` | neon vs. flat, without touching a colour |
| **Texture** | `--texture` (a `background-image` on an `.app::before` layer), `--texture-opacity` | scanlines / bloom / grain / none — biggest per-token payoff |
| **Motion** | `--dur-*`, `--ease-*`, `--motion-scale` | a calm theme and a snappy theme can differ in *feel*, not just colour |

**Font constraint:** the renderer runs on `file://` with no network. Any non-system
font must be a **bundled local woff2** — no Google Fonts `@import`, which would
fail silently offline and fall back mid-launch. Ship at most two faces.

**New presets worth having** (each a different *shape*, not a different hue):
`tokyo-night` (muted indigo, soft radius, no scanlines, calm motion — the
work-all-day theme), `amber-crt` (mono-amber phosphor, radius 0, heavy scanlines,
text-glow), `paper` (a real light mode: serif display, zero glow, hairline rules),
`void` (OLED near-black, one accent, maximum contrast, minimum chrome).

#### C1c — the motion system (CSS-only, zero deps)

The project ships no animation library and should keep it that way; GSAP/motion
would be a dependency for effects CSS already does. What transfers from the
motion-foundations discipline is the **token table and the rules**, not the API.

```css
--dur-instant: 80ms;  --dur-fast: 180ms;  --dur-normal: 350ms;  --dur-slow: 600ms;
--ease-smooth: cubic-bezier(.22, 1, .36, 1);   /* enter, settle */
--ease-sharp:  cubic-bezier(.4, 0, .2, 1);     /* exit, dismiss */
--ease-bounce: cubic-bezier(.34, 1.56, .64, 1);/* arm / confirm, sparingly */
```

Four rules, all of which the HUD already half-follows:

1. **Motion must guide attention, communicate state, or preserve spatial
   continuity.** Anything else gets cut, not tuned.
2. **`transform` and `opacity` only** — never `width`/`height`/`top`/`left`. The
   context bar already obeys this (`scaleX(var(--ctx))`); the panel collapse in
   C2 is the one legitimate exception, and it animates `grid-template-columns` on
   the container rather than the panels.
3. **Every duration comes from a token.** Hardcoded `0.3s` in a rule is the same
   class of bug as a hardcoded colour — it is why the boot timings are currently
   duplicated between `styles.css` and `boot.js` (§6).
4. **Reduced motion overrides everything.** The global block already exists (it
   landed with the boot sequence); the pattern to copy is B8's — *substitute* a
   static state, don't exempt or blank it.

Where it actually pays off, in priority order: **layout switch** (a staggered
fade+rise as the HUD reassembles — C1's whole payoff, and the reason C3 should
land near C1), **tab switch** (crossfade + slide for spatial continuity),
**context-bar threshold crossings** (60%/85% are colour-only today; a single
pulse makes them felt), **panel collapse** (C2), and **widget mount** (the
stagger, reused).

#### C1d — C3 as built (2026-08-05)

**The vocabulary went 17 tokens → 45**, and the shape of the work was exactly as
§C1b predicted: additive. `applyThemeVars()` already did `setProperty()` for any
`--*` key, so nothing in the theme *pipeline* needed rewriting — the tokens had
to be declared in `:root` and then actually consumed by `styles.css`, which was
~60 hardcoded values (9 font stacks, 24 radii, 18 borders, 30 durations).

**Four things worth knowing:**

1. **The texture layer lives on `body::after`, not `.app::before`.** An
   `::before` on a grid container is laid out **as a grid item** and would eat a
   cell of whatever layout preset is active. It sits at `z-index: 50` — above the
   HUD, below the palette (100) and boot (200), because the palette is a surface
   you read and type on, and boot already runs its own CRT sweep.

2. **Themes now `extend` each other.** With 45 tokens, every variant of a look
   would otherwise restate all of them and drift apart on first edit.
   `amber-crt` declares 20 tokens and resolves to 39 by extending `matrix` —
   same CRT *form*, entirely different colour. A missing parent or a cycle costs
   the theme its inheritance, not its existence.

3. **`KNOWN_TOKENS` in `theme.js` is guarded against drift by a test that parses
   the `:root` block out of `styles.css`.** That is what makes duplicating the
   list safe. It caught its first real drift within a minute of being written
   (`--stagger` declared in CSS, missing from the list).

4. **Reduced motion is handled once, at the token layer**: the media query zeroes
   `--dur-*` and `--stagger`, so every transition in the HUD collapses to an
   instant jump to its end state. `--stagger` **must** go to zero with them — a
   delay on a zero-length animation with `backwards` fill does not shorten
   anything, it just holds each region invisible until its turn.

**Two pre-existing bugs the work surfaced**, neither introduced by C3:

- **Stale theme tokens.** `applyThemeVars()` only ever *set* tokens. That was
  invisible while all five themes carried the same 17 keys and overwrote each
  other; with themes that deliberately set only what they care about,
  `matrix` (`--radius: 0`) → `light` (silent on radius) left every corner square
  and the bug looked like it belonged to `light`. Now the outgoing theme's keys
  are `removeProperty`'d, falling back to `:root` rather than to a second copy of
  the defaults kept in JS.
- **`applyTerminalTheme()` threw on every theme switch with a live session.**
  `term.options = { ...term.options, theme }` carries `cols`/`rows` along in the
  spread, and xterm throws `Option "cols" can only be set in the constructor`.
  Fixed by assigning the `theme` sub-option alone.

**How the second one was found is the point:** the probe's first theme pass
reported `"themes": []` and a clean sweep. That was a **false pass** —
`initAppearance()` is async and not awaited, so `__luna` existed while the theme
map was still empty. The probe now waits for it and errors out rather than
reporting success over an empty list. A probe that cannot fail is worse than no
probe.

**Verification:** 192 → **208 tests**. Probe clean: 9 themes cycled with
`themeTokensLeaked: []` / `themeTokensLost: []`, bus subscriber counts identical
at all three checkpoints, every `rows` marker at 1, all four presets cycled twice
and returned.

- [ ] **Not hand-checked by Mati yet — the probe cannot see a pixel.** Sweep is
      nine themes × four layouts. Specifically: is the scanline texture on
      `matrix`/`amber-crt` readable over the terminal or does it fight xterm; do
      `paper` and `void` have enough contrast on the dim text; does the
      layout-switch stagger feel right or is 45 ms too slow at four regions.

**Deliberately not built:** the tab-switch crossfade and the context-bar
threshold pulse from §C1c. Tabs are `display: none` panes, so a crossfade needs
JS to hold the outgoing pane alive — and xterm must not be animated while it
measures. The threshold pulse needs a JS edge-detector for the 60%/85% crossings;
the CSS side (`--dur-*`, `--ease-bounce`) is ready for whoever builds it.

#### C2a — collapsible + resizable panels as built (2026-08-17)

**512 tests** (was 479). One new module, `src/renderer/modules/panels.js`, plus
two keys in `ui.local.json` (`collapsed`, `layoutSizes`) and one call at the end
of `applyLayout()`. Nothing in the widget contract changed and no widget was
touched — which is the point below.

**FOLD rests on an invariant that already held.** Every widget root is a
`.panel__section` whose first child is an `<h2 class="panel__title">`; 20
widgets obey it because the template markup was written that way, not because
anything enforced it. That is what makes the fold generic — one decorator over
`.panel__section[data-widget]` — instead of 20 per-widget implementations. The
whole title row is the handle so the target is panel-wide, and a click that
lands on a real control inside a title (ports' filter, context's copy-path) is
let through untouched.

**The bug that would have shipped.** i18n's `applyStatic()` translates by
assigning `el.textContent`, and a dozen titles carry `data-i18n` on the `<h2>`
itself. That assignment drops every child — so switching PL↔EN would silently
strip the chevron out of exactly those panels and leave it in the ones whose
title wraps its label in a `<span>`. Caught by reading `applyStatic`, not by a
test, and it is the reason decoration is split in two: `ensureChevron()` re-runs
on every language change, the listener wiring runs once and is guarded by a
`data-fold-wired` flag. Attributes and listeners survive `textContent`; children
do not.

**RESIZE has one rule, and it is the whole design:**

> **An elastic (`fr`) track never becomes a fixed one.**

The obvious implementation — read the used pixel widths, write them back as
`px` — is what most hand-rolled splitters do, and it breaks the HUD the next
time the window is resized: every column is now frozen and the terminal stops
filling the space. So a handle beside a `px` track drags *that* track and lets
the `fr` track absorb it, and a handle between two `fr` tracks shifts the ratio
while **keeping their sum**, which is what stops a drag stealing width from a
third column elsewhere in the row. A boundary that can offer neither — nothing
elastic left to absorb, or a track the parser cannot describe — gets **no
handle at all**, because a handle that silently does nothing is worse than no
handle. `splitterPlan()` is that decision, and it is pure, so all four shipped
presets are pinned by test.

Three smaller decisions worth recording:

* **Splitters are absolutely positioned over the grid gaps**, not grid items. A
  splitter left in flow would be auto-placed into an implicit cell and shove the
  layout sideways. Hence `position: relative` on `.app`.
* **`parseTracks()` bails on any value containing `(`.** `minmax()`/`repeat()`
  hold spaces of their own, so a whitespace split would corrupt them. Bailing
  costs that layout its handles, which is the honest outcome — this module has
  no idea how to resize a track it cannot describe.
* **Stored widths are validated as a whitelist, not parsed.** `ui.local.json` is
  hand-editable and the value goes straight into an inline `style`. Two gates:
  a coarse one in `uiprefs.js` (don't persist a novel) and the strict track
  grammar in `panels.js` (`isSafeColumns`), at the place that does the writing.
  A stored value is also dropped when its track count no longer matches the
  preset's — edit `layouts.json` and old widths die rather than smearing across
  the wrong columns.

**Rows are not resizable**, deliberately: presets stack regions into rows by
name, so a row border is rarely one continuous line to grab.

**What §C1c predicted, and what happened.** That section listed panel collapse
as the one legitimate exception to "transform and opacity only", expecting it to
animate `grid-template-columns`. It does not. Folding a *section* (not a region)
can only be animated by driving `height`/`grid-template-rows`, and the trick for
that needs an extra wrapper element around every widget body — a DOM change 20
widgets are already written against. So the chevron carries the motion and the
body just goes. The exception §C1c reserved was not needed.

**Still owed:** the *feel*. The app has since run (see the MCP/git section near
the top of this file): it boots on Electron 43.3.0 and `--luna-probe` cycles all
four presets twice with every widget mounting exactly once, so the machinery is
sound. What no probe can answer is whether the 9 px handle is comfortable to
grab and whether a folded panel inside `.panel__scroll` leaves the gap looking
right. Those need eyes.

#### C2b — 9 → 18 themes (2026-08-17)

**No new tokens.** Every one of the nine additions is expressed in the C3
vocabulary as it already stood, which is the first real evidence that §C1b's
bet paid off: the vocabulary was sized for looks nobody had designed yet, and
nine unplanned ones needed nothing added.

Added: **dracula**, **gruvbox**, **solarized**, **blueprint**, **crimson**,
**glacier**, **vapor**, **newsprint**, **e-ink**. Four use `extends` and are a
few dozen lines each (`crimson` ← cyberpunk, `vapor` ← synthwave, `newsprint`
and `e-ink` ← paper) — the inheritance C3 built and, until now, only `amber-crt`
exercised.

The interesting half is `--texture`, which was the single biggest per-token
payoff in C3 and had been used for exactly one effect (scanlines) across three
themes. It now carries four distinct motifs: **scanlines** (cyberpunk, matrix,
amber-crt, crimson), a **drafting grid** built from two crossed
`repeating-linear-gradient`s (blueprint), **halftone dots** from a tiled
`radial-gradient` (vapor, and newsprint at `--texture-blend: multiply` over
light paper), and **diagonal hatch** (gruvbox, glacier). `--texture-size` and
`--texture-blend` had never been set by a shipped theme before; both are now
load-bearing.

### Phase D — Make it a product (§7)

**Promoted to the live plan 2026-08-05.** Target agreed with Mati: a **public
GitHub release**, shipping **both** an NSIS installer and a portable `.exe`,
**Windows now** while keeping Linux/macOS possible.

| # | Item | State |
|---|------|-------|
| D0 | **Packaging pre-flight audit** | ✅ **DONE 2026-08-05.** Findings below. |
| D1 | **Config relocation** (bundled defaults vs writable user dir) | ✅ **DONE 2026-08-05** — `src/paths.js`, 9 modules converted, 208 → 216 tests. See §D1a. |
| D2 | **electron-builder** | ✅ **DONE 2026-08-05** — NSIS (per-user) + portable, LUNA/CORE icon, packaged probe. See §D2a. |
| D3 | **Degrade honestly** | ✅ **DONE 2026-08-05** — English default, "Claude Code not found" notice, version 0.9.0. See §D3a. |
| D4 | **Release hygiene** | ✅ **DONE 2026-08-06** — README download section + full read/write/network disclosure, CSP (`default-src 'none'`), boot failsafe moved out of inline. See §D4a. |
| — | **`v0.9.0` released** | ✅ **DONE 2026-08-06** — annotated tag on `e4704e6`, public GitHub release with both binaries attached. See §D4b for how it was published without admin rights. |
| D5 | **Auto-update** | ✅ **DONE 2026-08-09** — notify-only via electron-updater; `build.publish` → GitHub. See §D5a. |
| D6 | **Electron 33 → 43** | ✅ **DONE 2026-08-09** — `npm audit` 1 high / 17 advisories → **0**. ABI 125 → 148 survived because the pty addon is Node-API. See §D6a. |

#### D0 — what the pre-flight audit found

Read-only sweep of every filesystem path for "does this survive being inside an
asar". Four results, two of them corrections to assumptions in this very file:

- **The write surface is 2 files, not 10.** Only `uiprefs.js` and `scratchpad.js`
  ever write. The other eight config modules are read-only, and reading from
  inside an asar works fine — so their `*.local.json` resolving into the bundle
  merely means *no override applies*, and a packaged app still works correctly on
  shipped defaults. That is what let D1 split into a blocking half and a
  feature half.
- **`withClaudeOnPath()` (`main.js:327`) already handles an un-PATHed install**,
  and if `claude` is genuinely absent the PTY still spawns a working shell with a
  `command not found`. So D3 is "make that legible to a newcomer", **not** "rescue
  a dead app" — the earlier guess that it would be a dead black terminal was wrong.
- **Confirmed read-only**, matching the standing constraint: `usage.js:27`
  (`~/.claude/.credentials.json`, a single `readFileSync`), `observer.js:85`
  (`~/.claude/projects`), `skills.js:24` (`~/.claude/skills`, `~/.claude/plugins`).
- **`contextIsolation: true` / `nodeIntegration: false` are already correct**
  (`main.js:179`). Missing: a Content-Security-Policy — that is the warning
  `--enable-logging` prints. Folded into D4.

**Four things outside Phase D that a *public* release needs.** One is a trap:

1. **The app defaults to Polish** (`uiprefs.js` `DEFAULTS.lang: 'pl'`). Every
   stranger who downloads it gets a Polish UI on first launch. One line, large
   consequence, and invisible to us — Mati's own `ui.local.json` already records
   a choice, so it can never be reproduced on this machine. → D3.
2. **README needs a download section and a plain disclosure** of what the app
   reads. An app that reads a credentials file *without saying so* reads as
   malware on a public repo. → D4.
3. **No CSP.** → D4.
4. **Polish comments in `main.js`/`theme.js`/`scratchpad.js`/`cheatsheets.js`,
   and a Polish `package.json` description.** Only the description is
   user-visible (it lands in installer metadata). The rest is polish, not a
   blocker.

**Cannot be solved, only documented:** an unsigned Windows binary triggers
SmartScreen. A code-signing certificate is a few hundred a year. The README
should make the warning expected rather than alarming.

#### D2a — packaging, and the probe that went silent

Shipped as `042d9c4`. `npm run dist` produces `LunaCore Setup 0.9.0.exe` (NSIS,
per-user, no UAC) and `LunaCore-0.9.0-portable.exe`, ~77 MB each.

Three settings carry the whole thing:

- **`asarUnpack` for `@lydell/node-pty`.** A native module will not load from
  inside an asar. Without this the terminal never spawns — the one failure that
  makes the entire app pointless, and one no test can reach.
- **`files` allowlist excludes `config/*.local.json`.** Verified by listing the
  built archive rather than by trusting the glob: all 6 woff2 faces and all 7
  base configs present, **zero `*.local.json`**. `profiles.local.json` holds API
  keys, so this is the difference between a release and an incident.
- **`perMachine: false`.** No UAC prompt, which matters when the binary is
  already unsigned and facing SmartScreen. Stacking two scary dialogs on a first
  run is how people decide not to bother.

**The lesson worth keeping: the probe went silent on the packaged build and
looked like a pass.** A packaged Windows app is a GUI-subsystem binary and never
attaches to the parent console, so `console.log` went nowhere — `--luna-probe`
on the `.exe` printed nothing at all and exited 0. This is the *same* failure the
theme probe taught us in §C1d, in a new disguise: **a probe that cannot report is
indistinguishable from a probe that passed.** It now writes `luna-probe.json` to
`userData` as well, and the packaged build then reported the full clean sweep —
14 widgets mounted, 4 presets cycled, all 9 themes loaded *from inside the asar*,
identical bus counts, `rows` all 1.

**The icon** is LUNA over CORE in the 04b_30 pixel font, yellow on the cyberpunk
plate. `scripts/make-icon.js` renders it with Electron — already a devDependency,
so no new packages — by drawing into a 64px canvas and upscaling 8× with
`imageSmoothingEnabled = false`; drawing straight at 512px would antialias a
pixel font into mush. The `.ttf` is only rasterized, never copied into the repo
or the shipped app, so the release redistributes no font. The script **hard-fails
if the face did not load**, because a silently-missing pixel font produces a
smooth icon that looks deliberate rather than broken. Known limitation, accepted:
a wordmark cannot survive downscaling to 16×16, so the taskbar icon is a yellow
smudge — legible as *which* app, not as text.

<h5>Still unverified by human eyes</h5>

The probe cannot see a pixel or spawn a real PTY. **Installed and machine-checked
2026-08-06** (silent `/S` install, per-user, no admin prompt); what a machine
could settle is settled, and what is left genuinely needs eyes:

- [x] **Installer works.** `%LOCALAPPDATA%\Programs\lunacore\` populated, exit 0.
- [x] **Packaged app boots and mounts everything** — probe from the installed
      `.exe`: 14 widgets mounted + remounted, identical bus counts, 9 themes read
      from inside `app.asar`, every `rows` at 1.
- [x] **`asarUnpack` did its job.**
      `resources\app.asar.unpacked\...\@lydell\node-pty-win32-x64\prebuilds\win32-x64\conpty.node`
      exists **outside** the archive. Worth noting: electron-builder unpacked the
      *platform* package (`node-pty-win32-x64`), which the configured glob
      (`@lydell/node-pty/**`) does not literally match — it auto-unpacks `.node`
      binaries. The setting is still right to keep; it just was not what saved us.
- [x] **Portable config really does land next to the `.exe`** — proved rather
      than assumed: a `themes.local.json` planted in `dist\LunaCore-config\`
      appeared in the portable probe's theme list (`portable-probe-test`) and in
      no other build, so `PORTABLE_EXECUTABLE_DIR` resolves as §D1a claims.
      **Note the folder is created lazily on first write**, so a fresh portable
      run that changes nothing correctly leaves no folder — that absence is not a
      bug, and it is why the injected-theme test was needed at all.
- [ ] **Terminal spawns and `claude` actually runs.** The native module loading
      is proven; a real PTY session is not.
- [ ] Headings render in Chakra Petch, not Segoe — a fallback means `assets/`
      did not ship (the asar listing says it did; eyes beat listings).
- [ ] **Change theme → close → reopen → it remembered.** Needs a click: the
      write only happens on a real preference change, so no probe can reach it.
- [ ] Icon reads acceptably in the taskbar and Start Menu.

#### D5a — auto-update, and the three things that shaped it

Built 2026-08-09. **222 → 240 tests** (18 new in `test/update.test.js`).
Notify-only by Mati's choice: check on launch, download only
on a click, install only on a second click (`autoDownload = false`,
`autoInstallOnAppQuit = false`).

- **A portable build must REFUSE to update, and that is a correctness bug
  waiting to happen, not a missing feature.** `dist/latest.yml` lists only
  `LunaCore-Setup-<v>.exe` — the portable `.exe` is not in it. An NSIS update
  works by running that installer, and a portable copy has no installation to
  replace, so "updating" one would install a SECOND, installed LunaCore beside
  it while the user keeps launching the old portable exe. `supportsUpdates()`
  refuses and the HUD says so; silence would have read as "you are current".
- **D5 breaks D4's headline claim, so the README edit is PART of D5.** The
  disclosure section said *"Network — one endpoint, one verb … the only outbound
  request LunaCore makes"*. That sentence is false the moment the updater ships.
  It is now a two-row table with an off switch each (`ENABLE_AUTO_UPDATE`), plus
  a plain statement that the SHA-512 check in `latest.yml` is **not** a
  code-signing check, because the binary is still unsigned. On a public repo the
  disclosure is the product; shipping the feature without it would have been the
  actual regression.
- **The notice lived in the `appearance` widget, not a widget of its own** —
  because C1 made widget placement DATA, and a preset is free to drop a widget.
  An update notice that a layout can drop is invisible exactly to the people who
  need it. `appearance` is in `REQUIRED_WIDGETS`, so every valid preset carried
  it by construction. Same one-root-two-owners shape as `mountBoot()`.
  ↳ **Moved 2026-08-13** to a chip in the `terminal` widget's bar instead — see
  §D5b. The `REQUIRED_WIDGETS` guarantee still holds (`terminal` is in that list
  too); what changed is that the notice is now hidden unless there is something
  to actually do, instead of a permanent fixture.

**A blind spot found and closed:** `busStats()` had a hardcoded channel list, so
the new `updateState` channel was invisible to `--luna-probe` — the one tool
whose entire job is catching a forgotten disposer. Adding a bus channel without
adding it to `busStats()` silently opts it out of the check. Now covered:
`updateState: 1` before, after 3× remounts, and after cycling all four presets.

**CSP needed no change**, and that is worth stating: the updater runs in MAIN,
which CSP does not govern — the same reason the usage gauge's HTTPS call
coexists with `connect-src 'none'` in the renderer.

**Found in passing, NOT fixed** *(→ fixed the same day by D6, §D6a)*: `npm audit`
reports **Electron 33 as a high** (ASAR integrity bypass, context-isolation
bypass, and ~25 more), i.e. the shipped `v0.9.0` binary carries them. D5 is the
mechanism that can now deliver the fix to people who already downloaded it.
Note the trap before upgrading: §A1 established ESM-over-`file://` works in
Electron 33 and explicitly says to **re-verify it on any Electron upgrade** — a
wrong answer there is a blank window, not a warning.

> The upgrade landed in `a773edb`. `v0.9.0` in the wild still carries these; only
> a released `v0.9.1` actually delivers the fix. That is why cutting it is the
> next action and not a nice-to-have.

#### D5b — moving the notice out of the left panel, and the [hidden] bug it re-triggered (2026-08-13)

Mati's ask: put the update notice somewhere small and discoverable next to the
Ctrl+K / Ctrl+L chips, and stop showing it — including "could not check for
updates" — when there is nothing to do about it. The permanent left-panel block
from D5a was correct but noisy: it rendered `checking` / `current` / `error`
too, and a build checks on every launch, so most of the time it had nothing
useful to say.

- **`describe()` (`modules/update.js`) now returns `null` for everything except
  `available`, `downloading` and `ready`.** `checking`, `current`/`none`,
  `error` and `unsupported` (dev clone or portable build) all render nothing.
  The state machine in `src/update.js` is unchanged and still runs in full on
  every launch; only what the renderer chooses to SHOW got smaller. The manual
  "Sprawdź"/"Ponów" (check/retry) buttons and the release-notes link went with
  it — checking already happens automatically, so a manual re-check button was
  the one piece of the old UI actually worth losing.
- **The chip lives in `terminal`'s bar now, not `appearance`'s root** — see the
  amended bullet in §D5a. `terminal` is also in `REQUIRED_WIDGETS`, so the
  same "no layout preset can hide this" guarantee carries over unchanged;
  `terminal.js` gained a sixth owning module (`mountUpdateChip`, alongside
  `mountPaletteChip` / `mountTermcustomChip`) and, like those two, it returns no
  disposer — `terminal` never unmounts (§A2f).
- **Caught on first hand-launch: the chip was permanently visible, and empty.**
  `.terminal-bar` is `display: flex`, and a flex child's own `display` rule (from
  `.palette-chip`) beats the browser's default `[hidden] { display: none }`
  unless an author rule forces it — the *exact* bug class this file already hit
  for `.badge` (§6) and the original D5a `.update` block, and had already
  pre-empted for `.notice`/`.palette`/`.termcustom`/`.boot`. Missed here on the
  first pass: nothing overrode `[hidden]` for the new `.update-chip`, so it
  showed unconditionally, and since `render()` only fills in text for a state
  worth showing, what Mati actually saw was a mystery empty amber pill that
  glowed on hover and meant nothing. Fixed with one rule,
  `.update-chip[hidden] { display: none; }`. **The lesson repeats a third time
  now: any hideable element inside a flex container in this codebase needs its
  own `[hidden]` override, full stop — it is not something to rediscover by eye
  each time.**

No new tests: the renderer state machine here was already outside `npm test`'s
reach before this change (only `src/update.js`'s pure functions are covered,
per D5a) and still is — `413` stays `413`. Verified by hand only: Mati caught
the `[hidden]` bug on the first `npm start` after the move, the fix landed, and
a second launch was clean enough to move straight to committing.

#### D3a — degrading honestly for someone who is not Mati

Three changes, all aimed at a first-time user rather than at us:

- **Default language is now `en`** (`uiprefs.js`). This was the audit's trap: it
  is a *first-run* value only, so a machine whose `ui.local.json` already records
  a choice can never reproduce the bug — it was invisible here by construction
  while handing every stranger a UI they could not read.
- **"Claude Code not found" notice.** `findExecutable()` in `launch.js` searches
  PATH *after* `withClaudeOnPath()` has had its say, so a native install in
  `~/.local/bin` still counts as found. The notice is a sibling of `.app`, not a
  child — a child would be laid out as a grid item and swallow a region of the
  active preset, the same trap C3's texture layer hit. Dismissible, not blocking:
  LunaCore is perfectly usable as a plain terminal or with a non-Claude profile.
- **The docs URL lives in `main.js`, not the renderer.** `shell.openExternal` on
  a renderer-supplied string is an open redirect into the user's browser; the
  renderer can only ask for the one page we chose.

**`findExecutable` is pure and the tests caught a real flaw in it.** It took
`isWindows` as a parameter but used the *host* platform's `path.join`, so on
Windows the flag and the separator could disagree — harmless while we ship
Windows only, and a silent wrong answer the first time anyone runs it elsewhere.
Now it selects `path.win32.join` / `path.posix.join` explicitly. Six tests
(216 → 222).

**Its failure mode is silence.** If the check itself throws, the notice does not
appear: a banner claiming Claude Code is missing on a machine where it is
installed would send someone to reinstall a working tool. Only a definite
"not found" is worth interrupting anyone for.

**Not done in D3:** surfacing *corrupt config* in the UI. The loaders already
reject-don't-repair and warn to the main-process console, but a user never sees
that console. Needs a warn channel from main to the renderer; **not** picked up by
D4 either — carried forward, and called out here so it is not mistaken for
finished.

#### D4a — release hygiene: the disclosure, and a CSP that had to move code

**The README disclosure was the point of D4, not the CSP.** LunaCore reads
`~/.claude/.credentials.json`. On Mati's own machine that is a convenience; on a
public repo, an app that reads a credentials file *without saying so* is
indistinguishable from malware, and "the source is right there" does not repair a
first impression. The new *What LunaCore reads, writes and sends* section lists
every path read, the two files written, and the single network endpoint — each
linked to the source that does it. **Every claim was re-derived from `src/` this
session rather than from this file**, which matters: the write surface really is
two files (`uiprefs.js:96`, `scratchpad.js:45`), and that is what makes the claim
defensible rather than merely reassuring.

**The CSP forced a code change, and it was the interesting part.** `script-src
'self'` cannot coexist with the inline boot failsafe — and that failsafe is
load-bearing: it is the only thing that removes the boot overlay if the renderer
dies while parsing, which the `t` collision with `i18n.js` once did for real.
Granting `'unsafe-inline'` to keep it would have made the directive decorative.
It moved to `boot-failsafe.js`, still a **classic** script, still outside the
module graph, so the guarantee it exists for is unchanged.

`style-src` keeps `'unsafe-inline'`, and that is not laziness: xterm.js creates
its own `<style>` elements for dimensions and theme, and the context bar ships a
`style="--ctx: 0"` attribute. The theme tokens written through
`el.style.setProperty()` — most of the theming system — are CSSOM and never
needed the exemption at all.

**`connect-src 'none'` is the directive that earns its keep.** The usage gauge's
HTTPS call lives in the MAIN process, which CSP does not govern, so forbidding
the renderer outright costs nothing — and the renderer is the half that renders
config-driven content.

**The question that actually needed answering: does `'self'` match `file://`?**
Chromium file: origins are opaque, and a CSP that quietly blocked every script
would have produced a blank window — the failure mode this project has hit twice.
It works, verified in both trees: `--enable-logging` shows no violation and no
`Refused to`, and `--luna-probe` reports 14 widgets mounted and remounted with
identical bus counts, 9 themes, every `rows` at 1. **Electron's own CSP warning
disappearing is the cheap tell that the header parsed at all** — a malformed CSP
would have left that warning up while enforcing nothing, which is the same
"looks like a pass" trap as §D2a's silent probe.

**Already done, contrary to §D0's list:** the `package.json` description is
English (`"Visual GUI dashboard for the Claude Code CLI…"`). No change needed.

#### D4b — publishing the release from a machine with no admin rights

Worth writing down, because the obvious route is blocked here and will stay
blocked.

`gh` cannot be installed on this laptop: the GitHub CLI ships a **per-machine
MSI**, `winget` downloaded it fine and then the installer returned **1602, "You
cancelled the installation"** — which is Windows' misleading way of saying a UAC
prompt appeared and nobody could approve it. The laptop is IT-managed.

**The CLI was never needed.** `git push` works, so Git Credential Manager already
holds a GitHub token with repo scope, and `git credential fill` will hand it over:

```bash
TOKEN=$(printf "protocol=https\nhost=github.com\n\n" | git credential fill | sed -n 's/^password=//p')
```

From there the REST API does everything `gh release create` would:
`POST /repos/:owner/:repo/releases` to create it, then
`POST uploads.github.com/repos/:owner/:repo/releases/:id/assets?name=…` with
`Content-Type: application/octet-stream` and `--data-binary @file` per asset.

**Two things that bite:** GitHub replaces spaces in asset names with dots, so the
installer was uploaded as `LunaCore-Setup-0.9.0.exe` and the README download table
had to be corrected to match (`70376ff`) — a table that disagrees with the release
page is the first thing a visitor checks. And **a tag is not a release**: pushing
`v0.9.0` alone left the README's "Latest release →" link 404ing, because
`/releases/latest` only resolves once a published, non-draft release exists.

**Shipped without the §D2a eyes-only checks**, by Mati's explicit decision. They
are still outstanding and now apply to a binary strangers can download.

#### D1a — config relocation: the two roots, and what §7 got wrong

Shipped as `4fe6d87` (writers) + `f79d506` (readers). `src/paths.js` owns:

```
bundled(name) -> shipped defaults, read-only, fine inside app.asar
local(name)   -> per-machine overrides and state, MUST be writable
```

**The bug this fixes.** Ten modules resolved `CONFIG_DIR` as
`__dirname/../config`. Inside `app.asar` that path is readable but **not
writable**, so every `*.local.json` write would have failed silently in a built
app — theme, language, layout, active profile, port filter and scratchpad all
forgotten on restart. The app would have looked completely fine.

**In a dev clone nothing changes.** Unpackaged, both roots are the repo's own
`config/`, so `npm start` and `npm test` behave exactly as before and there is
nothing to migrate for anyone running from source. Only `app.isPackaged` sends
the writable root elsewhere: `PORTABLE_EXECUTABLE_DIR` next to the `.exe` for the
portable target, else `app.getPath('userData')/config`. Gating on `isPackaged`
also means a stray env var in a dev shell cannot redirect config out from under
you.

**§7's "copy shipped `config/*.json` into a user config dir on first run" was
wrong, and this is the interesting part.** It solves a problem this codebase does
not have: the two concerns are already separated **by filename** — `themes.json`
ships, `themes.local.json` is yours, and every loader merges base then local.
Copying defaults across would *shadow* them, so an update could never deliver a
new theme or a corrected rate table. **The user directory holds overrides only**,
and a missing override file was already a no-op everywhere
(`readJson` → `null` → `collect()` returns early). The right fix was smaller than
the planned one, not bigger.

Three implementation notes worth keeping:

- **`resolveUserDir()` is pure** — every environment (dev / portable / installed /
  degraded) is a plain input object, so `node --test` covers all four branches
  with no Electron and no new deps. Same A3 convention that made `etaMinutes()`
  testable.
- **It caught a bug during the write.** `userDir()` memoized unconditionally,
  which would have pinned the whole session to the fallback directory if the
  first call landed before `app.whenReady()`. The degraded branch is no longer
  cached; two tests cover it.
- **The override path is a function, not a const.** These modules are required at
  the top of `main.js`, *before* `app.whenReady()`, so a path captured at import
  time could bake in the wrong directory even where `userDir()` would later
  resolve correctly. Costs one pair of parens per call site.
- **`projects.js` is the only file that keeps `require('path')`** — `expandHome()`
  still needs `path.join`/`path.normalize`. `paths` vs `path` in one file is a
  genuine reading trap, so there is a comment there saying so.

**The probe earned its keep again.** `cheatsheets.js` and `prompts.js` have **no
test file**, so `--luna-probe` is the only thing that loads them; a missing
`require` would have been invisible to all 216 tests. It reports
`rows: {cheatsheets: 1, prompts: 1}` plus all 9 themes and all 4 presets, which is
what makes the conversion verified rather than merely green.

#### D6a — ten majors of Electron, and why the terminal did not break

**Shipped as `a773edb`, 2026-08-09.** `electron ^33.0.0` → `^43.0.0` (43.3.0),
`allowScripts` repinned. Two lines of `package.json` and a lockfile; the work was
entirely in proving it was safe.

**What it bought.** `npm audit`: **1 high / 17 Electron advisories → 0**. Three of
those seventeen sit on code paths this app actually uses, which is the reason it
was worth doing now rather than "eventually":

- `shell.openPath` path-validation bypass via embedded null byte — and §D4a's
  whole open-redirect defence is *"never let the renderer supply the string"*.
  That defence assumes the shell API itself is sound.
- **Context-isolation bypass via `Function.prototype.bind` hijack.**
- **`contextBridge` honouring prototype setters** — an attack on the preload
  boundary, which is the single wall between the renderer and Node.

The last two are not "a dependency has a CVE". They are attacks on the exact
mechanism the security model is built from.

**The gamble was `@lydell/node-pty` 1.2.0-beta.12.** Node ABI moved **125 → 148**;
that shatters any V8-bound native addon, and a dead pty means a dead app. It was
resolved by *looking at the binary* rather than trusting the README:

```
prebuilds/win32-x64/conpty.node
  napi_ / node_api      → present
  v8:: / NODE_MODULE_VERSION → absent
```

One binary per **platform**, not per **ABI**. That is the Node-API signature, and
Node-API is ABI-stable by contract. Then verified live rather than inferred — a
throwaway Electron 43 main process loaded the addon and round-tripped stdout from
a real spawned pty. *Reading the shape of an artifact beats reading its docs; both
beat assuming.*

**§A1's trap was the other risk, and the packaged probe is what closed it.**
A1 says ESM-over-`file://` works in Electron **33** and to re-verify on any
upgrade, because a wrong answer is a blank window rather than an error. Running
`--luna-probe` **from `dist/win-unpacked/`** answers it properly: asar-packed ESM
resolving under a Chromium ten majors newer, 15 widgets mounted and remounted,
identical bus counts at all three checkpoints, 4 presets, 9 themes, no token
leaks, every `rows` at 1. Running it from source would only have tested the
easier half.

**Two things worth knowing on a fresh clone:**

- `npm rebuild electron` reported success **without fetching the binary**, despite
  `allowScripts` naming the exact version. `node node_modules/electron/install.js`
  had to be run directly. A silent no-op that claims success is worse than a
  failure.
- `npm install` failed `EBUSY` on `icudtl.dat` while a dev instance was running.
  Obvious in hindsight; not obvious at 21:49.

**Not covered by any of this:** whether `claude` still spawns *in the GUI* under
43. The pty check proves the addon works and the probe proves the widgets mount,
but the §D2a eyes-only check was performed against an Electron **33** build. It is
cheap to redo and belongs in the `v0.9.1` pre-flight.

### Phase E — Telemetry & motion (§4, §C1c leftovers)

**Started 2026-08-09**, after Mati confirmed the §D2a eyes-only checks pass
("yes everything spawns"). Chosen shape: *streaming chart + big KPI*,
**machine-wide**, RAM + CPU + uptime/load/cores.

| # | Item | State |
|---|------|-------|
| E1 | **`telemetry` widget** (RAM / CPU / uptime) | ✅ **DONE 2026-08-09** — `src/telemetry.js` + widget, 39 tests. See §E1a. |
| E2 | **C2 collapsible + resizable panels** | ✅ **DONE 2026-08-17** — see C2 in Phase C and §C2a. |
| E3 | **The two motions C1c left unbuilt** | ✅ **DONE 2026-08-09** — threshold pulse + pane fade-in. See §E3a. |
| E4 | **C4 drag-and-drop rearrange** | ⏸ still deferred — stretch. |

#### E1a — telemetry, and the three readings that would have been lies

Sampling the machine is easy; sampling it *honestly* is where the work went.

1. **CPU percent is a delta, not a reading.** `os.cpus()` returns cumulative
   tick counters since boot. Sample once and divide and you get the average load
   since the machine started — a number that is both wrong and almost perfectly
   stable, which is the worst possible combination because it looks like it
   works. `cpuPercent()` needs two samples and returns **null** until it has
   them; `TelemetryWatcher.start()` takes a baseline without emitting, so the
   chart never opens on an empty column.
2. **`os.loadavg()` returns `[0,0,0]` on Windows, by documentation.** This is a
   Windows-first app, so rendering "0.00 0.00 0.00" would be a fabricated
   reading dressed as a measurement. The payload carries `null` and the widget
   says nothing — the D3 rule, and B4's costing rule, applied to a third case.
3. **Unknown is not zero.** A missing reading draws as an *empty* tick, never a
   floor-level bar, and `barLevel(null)` is its own band. A zero-height bar in a
   chart of percentages reads as "0%", which is a claim.

**The watcher deliberately breaks PortWatcher's rule.** `PortWatcher` only emits
when the scan changed; this one emits every tick, unchanged or not. A time series
that suppresses repeats leaves gaps that render as "flat" when they actually mean
"no sample" — the chart would silently lie about its own time axis.

**Pause freezes the picture, not the feed.** Samples keep accumulating while
paused, so resuming shows the present rather than replaying a backlog. The
alternative — freezing the buffer — puts a real gap in the series while the axis
still claims even spacing, i.e. exactly the lie the previous paragraph avoids.

**Where the widget lives:** all four presets, between `usage` and `skilltracker`.
That broke `test/layouts.test.js`, which pins `classic`'s slot list — working as
intended; the assertion moved with the data.

#### E3a — the motion C1c deferred, and the a11y bug it was hiding

C1c listed two effects as "deliberately not built". Building them turned up a
third thing that was already wrong.

**The context bar had an infinite alarm with a hardcoded duration.**
`.ctx-bar__fill.is-high` ran `animation: ctx-alarm 1s ease-in-out infinite`, and
the same rule sat on `.usage-bar__fill[data-level='bad']`. The
`prefers-reduced-motion` block works at the **token** layer (§C1d) — it zeroes
`--dur-*` — so a hardcoded `1s` sails straight past it. Anyone who had switched
motion off still got a bar throbbing at them forever. It also violated C1c rule 3
("every duration comes from a token") and the general guidance that continuous
animation is for loading indicators only: after ten seconds the eye filters it
out, and the *event* was never "being above 85%" — it was **crossing** 85%.

Replaced by a single pulse on an upward crossing, `var(--dur-slow)` +
`var(--ease-bounce)`, animating `filter` because the element already owns
`transform` for its `scaleX`. Three conditions gate it, each load-bearing:
`live` (a tab switch replays remembered metrics and a replay is not an event),
a previous band exists (a session that *opens* at 90% crossed nothing), and
strictly greater (coming down after a compact is relief, and relief does not need
to grab your eye). `ctxLevel()` went into `thresholds.js` — ordered `0|1|2`, so
the direction of travel is comparable; band *names* would have made
`level > lastLevel` quietly meaningless.

**The tab crossfade shipped as half of itself, on purpose.** C1c was right that a
true crossfade needs JS to hold the outgoing pane alive, and that xterm must not
be animated while it measures. So only the **incoming** pane animates, and only
`opacity` — which touches neither layout nor `clientWidth/Height`, so
`fitAndResize()` sees exactly the dimensions it saw before. `display: none →
block` restarts a CSS animation by itself, so no JS was needed at all. The
outgoing pane still vanishes instantly. Spatial continuity is not fully solved;
the hard swap is gone.

**One more stale token, same class as `--border`:** `.tab__ctx.is-high` read
`var(--danger, #ff6b8a)`. `--danger` has never existed (`--bad` is the token), so
that dot rendered hardcoded pink in all nine themes and no test could see it.

**Verification:** 266 → **285 tests**. Probe clean: 15 widgets mounted and
remounted, `telemetryUpdate` stable at 1 across all three checkpoints, 4 presets
cycled, 9 themes with no token leaks. `--enable-logging` shows no CSP violation
and no module-resolution failure.

- [ ] **Not hand-checked by Mati yet — the probe cannot see a pixel.** Worth a
      look: does the sparkline read at 210 px (the `monitor-heavy` left rail is
      narrower than `classic`'s right); is the pulse on a threshold crossing
      visible without being startling; does the pane fade-in feel like polish or
      like lag on a slow machine.

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
per-account.** Each `claude` has its own window (model-detected since B2 — 1M for
the current family, 200k only for Haiku 4.5), so the context bar,
sparkline and tool tiles are per tab. The 5h/weekly limits are one shared quota
across every tab (and every session run outside the HUD), so they stay a single
global readout and must never be summed per tab.

The trap this creates: N tabs can each show a calm green context bar while
draining one quota N times faster. Per-tab metrics *structurally cannot* warn
about this — only the global gauge can. Worth adding an "N active sessions" badge
next to the 5h readout so the burn rate is attributable to tab count.

**Fixed 2026-07-25 — and it was worse than described here.** The old note assumed
only two *resuming* tabs were ambiguous. In fact two **fresh** sessions in one
folder raced too: both watchers poll on independent 1.5 s timers, and whichever
ticked first claimed any newly appeared transcript — regardless of which PTY
created it. Hand-testing an Opus tab beside a Sonnet tab showed each displaying
the other's model, context and cost. `claimedTranscripts` guaranteed no two
watchers shared a file, so the result was a clean bijection that was simply the
wrong way round — which is why it looked half-working instead of obviously broken.

The fix turned the guess into a lookup: `main.js` mints a UUID per spawn and
passes `--session-id <uuid>` to the CLI, and since a transcript is named after
its session id (verified: the `sessionId` field equals the filename), the watcher
opens `<uuid>.jsonl` by name. No stdout parsing was needed after all. The
timestamp heuristic survives only as a fallback for bare-shell profiles and
hand-typed `claude`, where we do not control the launch.

Lesson for the test suite: 92 tests were green throughout. `scratchpad/check-pin.js`
drove watcher ticks **sequentially**, so the interleaving that caused the bug
could never occur. `test/pinning.test.js` now ticks two watchers in the
adversarial order on purpose.
