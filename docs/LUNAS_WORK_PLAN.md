# Luna's Work — plan

> Status: **IN PROGRESS.** Written 2026-10-22. Phase 1 slice 1 done
> (`9f65d6a`). **Resume here: Phase 1, slice 2** (button + settings +
> pre-production pack).

## What it is

A long-running mode that **builds a project, tests it like a human, critiques
it, writes its own to-dos and keeps going until it decides the project is
done** — or Mati stops it. God Mode builds a fixed list of cards once; Luna's
Work wraps God Mode in an outer loop with a brain that *generates* the next
list from what it saw while testing.

Not game-only. Same loop for a web app (AMSteel calculator), web design, an
Electron app, a Unity game. What changes per project type is only the
**tester adapter** (how Luna "plays" the thing).

Goal case: Mati fills a pre-production pack, starts a run, goes on vacation,
comes back to a working app on `main` and a run report.

Inspiration: Stefan 3D AI, "This Is What Opus 5.5 Max Built in 36 Hours"
(Unity MMO, one giant session: pre-production folder, Unity/Blender MCP,
gray-box → refine passes, parallel agents, screenshot self-testing, occasional
human steering). Luna's Work keeps those ingredients but makes the loop, the
memory and the stop rule explicit instead of trusting one context window.

## Decisions (Mati, 2026-10-22)

| | |
|---|---|
| First tester adapter | **Web app** (Playwright, this PC). Electron and Unity come after. |
| Run output | **Merge to `main`** every iteration. The God Mode self-check gate still applies: a red merged result is not pushed to `main` (pushed as `luna/<slug>-integration`, the fix-up worker gets one try). |
| Budget | **No spend cap.** On a usage limit the run waits for the reset and continues. It runs until SHIP, plateau, or Mati stops it. |
| Unity | Lives on Mati's other PC, Unity MCP already connected there. Luna's Work runs in the LunaCore on that PC. |
| God Mode v2 | **Must not change behavior.** Luna's Work is its own button and panel. It reuses God Mode only through additive hooks; every God Mode test must stay green, and a new test pins God Mode's default behavior. Only one of the two may run on a project at a time. |

## The loop

```
  PRE-PRODUCTION (once, interactive)
      Luna interviews Mati -> design pack in the project repo
                          |
                          v
  ┌──> DIRECTOR ──> BUILD ──> LAUNCH ──> PLAYTEST ──> CRITIC ──┐
  │    picks the     God Mode   LunaCore   fresh agent,  review,  │
  │    next cards    run, merge starts the no code      to-dos,  │
  │    (max N)       mode       app        access       verdict  │
  └──────────────────────── CONTINUE ─────────────────────────────┘
                     SHIP (confirmed) / PLATEAU / STOP -> report
```

One **iteration** = Director → God Mode run → launch → playtest → critic.
Every role starts fresh and reads its state from disk; nothing depends on a
long context.

### Roles

| Role | How it runs | Sees | Writes |
|---|---|---|---|
| **Interviewer** | Normal tab, interactive, before the run | Mati's answers, references | The design pack |
| **Director** | Headless `claude -p --json-schema`, read-only tools (like `orchestraPlan.js`) | Design pack, open cards, last critic verdict, Mati's steer cards | Ordered list of card ids for this iteration (validated) |
| **Builders** | Existing God Mode run, `integration: merge` | Their brief, the code | Code, tests, ticked cards |
| **Playtester** | Headless `claude -p` with **only** the adapter's tools (Playwright MCP for web); no Read/Grep/Edit/Bash | The running app, `TEST_PLAN.md`, `SHIP_CRITERIA.md` — **not** the code, not builder messages, not earlier scores | Findings with evidence (screenshot + steps), scores (schema) |
| **Critic** | Headless `claude -p --json-schema`, read-only | Playtest report, design pack, score history, git log of the iteration | New/updated cards, `PLAYTEST_LOG.md` entry, verdict |

The Playtester never sees the code or its previous scores — that is the
anti-self-grading rule. Scores without evidence are dropped at validation.

### Models per role (idea #9)

Configurable in the Luna's Work settings, saved as LunaCore's default and
overridable per project when a run starts.

| Role | Default | Choices |
|---|---|---|
| Director | **opus** | opus / sonnet / haiku / auto |
| Builders (God Mode workers) | **opus** | opus / sonnet / haiku / auto |
| Playtester | **sonnet** | opus / sonnet / haiku / auto |
| Critic | **opus** | opus / sonnet / haiku / auto |
| Specialist reviewers, researcher | **sonnet** | opus / sonnet / haiku / auto |

Mati's standard is Director opus, Builders opus, Playtester sonnet. Critic
opus and reviewers sonnet are Luna's defaults for the roles Mati did not name.

**`auto` = Luna decides**, per task, with rules in `lunasworkRules.js` that
are pure and tested, and every choice is logged in the run report with its
reason:
- Builders: card size L, or a risky area (IPC, auth, migrations, merge
  conflicts last iteration), gets opus. Size S/M cards get sonnet. After two
  stalls the existing Sonnet → Opus escalation applies.
- Playtester: exploratory passes get sonnet. The **SHIP confirmation pass**
  always gets opus.
- Director, Critic: opus at milestone gates and step-back iterations,
  sonnet otherwise.

Usage limits: by default the run **waits** for the reset (Mati's decision).
Optional, off by default: fall back to the free providers
(`orchestraFree.js`) for builders and playtester while Claude is limited.

### Design pack (in the project repo, `design/`)

| File | Owner | Purpose |
|---|---|---|
| `BRIEF.md` | Interviewer, Mati | What it is, who for, the one-sentence success |
| `DESIGN.md` | Interviewer; Director may append, never rewrite | Features, screens, rules, look and feel |
| `SHIP_CRITERIA.md` | Interviewer | **Milestone ladder** with gates (e.g. skeleton → core flows → complete → polish). The Critic cannot move to the next milestone until the current gate passes. |
| `TEST_PLAN.md` | Interviewer; Critic appends journeys | User journeys the Playtester must run every iteration, plus free exploration |
| `references/` | Mati | Screenshots, mockups, example data (e.g. a real AMSteel quote) |
| `PLAYTEST_LOG.md` | Critic only | One entry per iteration: what was played, good, bad, broken, missing, scores, verdict |
| `ARCHITECTURE.md` | Critic, after each iteration | Project memory (idea #1): modules, data flow, conventions. Every builder brief says "read this first". |
| `DECISIONS.md` | Director, Critic | Decision log: "chose X because Y", plus every decision-queue answer. Builders must not contradict an entry without a new entry. |
| `ROADMAP.md` | Interviewer; Director moves through it | Goal → milestones → epics → cards (idea #5). Phase 2. |

The to-do backlog stays in the LunaCore to-do cards (existing MCP
`luna_todo_add` / `luna_todo_update`), tagged per run, so it syncs to the
phone like every other card.

### Critic rules

- Every finding is one of **bug / feel / missing / idea**, with a severity.
- Bugs and blockers on the current milestone outrank everything; `idea` cards
  are only created once the current milestone gate passes. This is what stops
  the backlog from exploding.
- Every 5th iteration is a **step back**: re-read `BRIEF.md` + `DESIGN.md`
  and ask "is this still that product?" before writing cards.

### Human steering

Mati adds a to-do card to the project with the `steer` tag (from the phone,
already synced). The Director must schedule every open `steer` card first.
A steer card saying `stop` ends the run after the current iteration.

### Stop rules (pure, `lunasworkRules.js`)

| Verdict | When | Then |
|---|---|---|
| **SHIP** | Critic says every gate in `SHIP_CRITERIA.md` passes **and** a second, independent Playtester run (fresh, SHIP criteria only) agrees | Final report, run ends |
| **PLATEAU** | 3 iterations with no score gain and no card closed | Stop, email Mati with the log |
| **RED** | Self-check stayed red after fix-up in 2 iterations in a row | Stop — `main` not pushable |
| **STOP** | Kill switch, or a `stop` steer card | Finish current step, report |
| **WAIT** | Usage limit | Pause until reset (existing `orchestraPlanWait` / run pause), then continue — no cap |

## Tester adapters

One interface: `start(profile) -> {url|handle}`, `tools()` (what the
Playtester is allowed), `stop()`, `evidenceDir`.

| Adapter | Status | How it plays |
|---|---|---|
| **web** | Slice 3 | LunaCore runs the project's start command (from the project profile, not from model output), waits for the URL, Playtester drives it via Playwright MCP: clicks, forms, screenshots, console errors, mobile + desktop width |
| electron | Later | The in-process Electron wrapper already used for smoke tests (memory: smoke-test without a CDP port) |
| unity | Later, other PC | Unity MCP: play mode, screenshots, console. Needs a `PlaytestDriver` dev-only script in the game (scripted inputs + JSON state dump). Constraint: one editor = one Unity MCP connection, so code workers run in parallel worktrees but scene/prefab work goes through **one scene worker**; one owner per scene; UnityYAMLMerge as git merge driver. Starts with a live spike (install, play mode, screenshot, one scripted input) before any design work. |

### Project profile (LunaCore local settings, not the repo)

`adapter`, `startCommand`, `url`, `readyTimeoutSec`, `checkCommand`. Kept in
LunaCore's local config so nothing a model writes into the repo can change the
command LunaCore runs — same trust boundary as God Mode's planner.

## Reuse from God Mode

| Need | Existing piece |
|---|---|
| Plan cards → packages, run workers, worktrees, nudges, stalls | `orchestra.js` / `orchestraSupervisor.js` (`makePlan`, `launch`) |
| Merge + full test + fix-up + push gate | `orchestraIntegrate.js`, `orchestraSelfCheck.js`, `orchestraFixup.js` |
| Wait for usage reset | `orchestraPlanWait.js`, run-wide pause |
| Headless structured call + trust boundary | `orchestraPlan.js` pattern (`claude -p --json-schema`, validate, never reject) |
| Report, email, phone snapshot | `orchestraReport.js`, `godmodemail.js`, `godmodesnapshot.js` |
| Keep PC awake / power | `keepawake.js`, `orchestraPower.js` |

Two **additive-only** hooks in `orchestra.js`: start a plan from a given card
list, and an optional "run settled" callback (finalize idle). Both are
optional: with them unset, God Mode behaves exactly as today. That is pinned by
a test, and the full God Mode suite must stay green on every slice. Everything
else goes in new modules, and `main.js` (3522 lines) only gets wiring.

## New modules

| File | Kind | Content |
|---|---|---|
| `src/lunaswork.js` | Controller | Run state machine (`preprod → directing → building → launching → playtesting → critiquing → …`), injected deps, persisted to `lunaswork.local.json` on every transition, resumes after restart |
| `src/lunasworkRules.js` | Pure | Stop rules, milestone gate, plateau, steer priority, score validation |
| `src/lunasworkDirector.js` | Headless call | Schema + validation of the chosen card ids |
| `src/lunasworkPlaytest.js` | Headless call + adapters | Adapter interface, `web` adapter, playtest schema + validation, evidence folder |
| `src/lunasworkCritic.js` | Headless call | Schema, validation (card text capped, kinds/severities checked), writes `PLAYTEST_LOG.md`, creates cards |
| `src/lunasworkPack.js` | IO | Design pack templates, read/append rules, interview brief |
| `src/renderer/modules/lunaswork.js` | UI | Start / steer / stop, current iteration + role, score chart per milestone, link to evidence |
| `src/preload.js` + IPC | Bridge | Narrow channels, payloads validated in main (security review) |

Strings: `pl` + `en` for all UI text.

## Scale-up features (for very large projects)

Numbers match the idea list from 2026-10-22. Idea #13 (spreading workers over
several PCs) is **dropped** by Mati's decision.

| # | Feature | What it does | Phase |
|---|---|---|---|
| 1 | Project memory | `ARCHITECTURE.md` + `DECISIONS.md`, updated by the Critic every iteration, read first by every builder | 1 |
| 3 | Bugs become tests | Every `bug` card must ship with a repro test (enforced in the Critic's card text and checked at finish: the card's commit adds or changes a test file). Web: screenshot comparison for key screens. | 1 |
| 4 | Checkpoint + rollback | `main` is tagged `luna-work/<run>/iter-N` after each green iteration. If a core `TEST_PLAN.md` journey breaks or the milestone score drops by more than a set margin, `main` is reverted to the last good tag (a revert commit, never a force-push) and the failed work becomes cards. | 1 |
| 9 | Models per role | See "Models per role" | 1 |
| 11 | Decision queue | Risky choices (new dependency, schema/migration, deleting a feature, changing `DESIGN.md`) go to Mati's phone with a **default answer and a deadline** (default 2 h). No reply means the safe default is taken and logged in `DECISIONS.md`. The run never blocks on it, and keeps working on other cards meanwhile. | 1 |
| 2 | Contracts + ownership | Before a parallel build, the Director writes the interfaces between packages and a file ownership map. It is fed to God Mode's existing overlap guard, so clashes are prevented, not just reported. | 2 |
| 5 | Roadmap levels | `ROADMAP.md`: goal → milestones → epics → cards. The Director works one epic at a time instead of a flat pile of cards. | 2 |
| 6 | Playtester personas | First-time user, power user, phone user, accessibility, "break it". Rotated: the core journeys every iteration, one extra persona per iteration, all of them at a milestone gate. | 2 |
| 7 | Specialist reviews on a schedule | Security every 3 iterations, performance every 5, cleanup (`refactor-cleaner`) at each milestone gate. Findings become cards like the Critic's. Uses the existing ECC agents. | 2 |
| 8 | Self-learning skills | At each milestone gate a pass turns what worked into project skills in the repo (`.claude/skills/`), so later workers start with them. Reviewed by the Critic, never edits global `~/.claude`. | 2 |
| 12 | Live dashboard | HUD + phone: iteration timeline, scores per milestone over time, tokens per role, cards opened/closed, latest screenshots, pending decisions. Email only at milestone gates and at the end (B12), never per iteration. | 2 |
| 10 | Staging | Migrations and edge functions applied to a **staging** copy, and the Playtester tests staging. Anything touching production goes to the decision queue. | 3 |
| 14 | Research step | When the design references other products ("like X"), a research agent fills `design/references/` before building starts. | 3 |
| 15 | Asset pipeline (games) | Generation APIs + Blender MCP, an asset list so nothing is generated twice, and a style check where the Critic compares new assets with the art direction references. | 3 |

### Second round (2026-10-22)

Numbered B1-B19 to keep them apart from the first list. B18 (writing lessons
into the global `~/.claude` config, too much context) and B20 (a stricter
permission profile for builders) are **dropped** by Mati's decision.

| # | Feature | What it does | Phase |
|---|---|---|---|
| B1 | Done = verified in the app | Every card carries acceptance checks. A builder's LUNA_DONE only moves it to *built*; it closes when the next Playtester pass confirms the checks in the running app. Failed checks reopen it with the evidence. | 1 |
| B2 | Iteration 0 (new projects) | For an empty repo: scaffold from a stack template (Next.js/TS, Python, …) with tests, lint, CI and `.env.example` before any feature card. | 1 |
| B3 | Survive the machine | Watchdog restarts LunaCore and resumes the run; Windows updates paused for the run's length; disk cleanup of old evidence and settled worktrees; low-disk stops the run and emails Mati. | 1 |
| B4 | Stuck cards | A card that fails two iterations is split into smaller cards by the Critic, or goes to the decision queue. | 1 |
| B5 | Scope guard | The Director cannot schedule work outside `DESIGN.md` / `ROADMAP.md` without a decision-queue entry. | 1 |
| B6 | Design match score | Screenshots compared with the mockups in `design/references/`; a per-screen fidelity score in the playtest. | 2 |
| B7 | Web quality budgets | Lighthouse (performance, a11y, best practices, SEO) every iteration via chrome-devtools MCP, trend on the dashboard, a drop creates cards. | 2 |
| B8 | Second-opinion model | At milestone gates a different model (Codex / Gemini) reviews alongside the Critic. | 2 |
| B9 | Flaky test quarantine | A test that fails then passes unchanged is quarantined with a card, so it cannot trigger a rollback. | 1 |
| B10 | Realistic data | A seed / fixtures step from `design/references/` (e.g. real steel prices, real quotes), so the Playtester tests real cases. | 2 |
| B11 | pl/en completeness | A check that every new UI string exists in both languages, for projects that use both. | 2 |
| B12 | Milestone emails + return pack | Like God Mode's run email, but per **milestone gate**, not per iteration: what was reached, screenshots, scores, the decisions taken, and a link for feedback. At SHIP / stop: the "while you were away" pack: what changed, the ten riskiest decisions to double-check, rollbacks and why, a screen tour. | 2 |
| B13 | Demo video | The playtest evidence turned into a short walkthrough video with the `Remotion vids` setup, attached to the milestone email. | 3 |
| B14 | Docs at SHIP | README, user guide, changelog per iteration, a release following the normal release process. | 2 |
| B15 | Time to SHIP | Estimate from cards closed per iteration and roadmap left, on the dashboard and in the milestone email. | 2 |
| B16 | Project queue | When a run ships, the next project in the queue starts. | 3 |
| B17 | Mid-run feedback | See "Feedback while it runs". | 1 |
| B19 | Fresh code graph | codebase-memory index and codemaps refreshed every iteration; builder briefs say "query the graph first". | 2 |

### Third round (2026-10-22)

Numbered C1-C14. C3 (mutation testing), C4 (mocks for external services),
C12 (project presets) and C14 (run audit trail) are **dropped** by Mati's
decision.

| # | Feature | What it does | Phase |
|---|---|---|---|
| C1 | Design variants (**toggle**, off by default) | For key screens, 2-3 variants are built behind a switch; the choice is offered in the milestone email (Mati) or made by the Critic when nobody answers by the decision-queue deadline. Losing variants are removed. | 2 |
| C2 | Clickable mockup first (**toggle**, off by default) | Pre-production ends with a rough clickable prototype of the main screens; the real build starts after Mati approves it, or after the decision-queue deadline if he does not answer. | 2 |
| C5 | Backup before data changes | A snapshot of the staging data before every schema change; a rollback (#4) restores the data with the code. | 3 |
| C6 | GDPR / legal pack (EU web apps) | Privacy policy, cookie consent, data export and deletion, generated and checked at SHIP. Legal text is marked "draft, check before publishing" in the return pack. | 2 |
| C7 | Cross-browser and devices | The Playtester rotates Chromium / Firefox / WebKit and phone / tablet / desktop widths; every engine and width at a milestone gate. | 2 |
| C8 | Load test | For apps with a backend: a short stress run at the "complete" milestone; failures become cards. | 3 |
| C9 | Error tracking at SHIP | Error reporting (Sentry or similar) wired in at SHIP, so post-launch errors can become cards. The key is a secret: asked through the decision queue, never committed. | 3 |
| C10 | Launch assets | Landing page copy, screenshots, store listing, a short pitch, via the ECC marketing agent, at SHIP. | 3 |
| C11 | "Hand me the wheel" | Mati takes over: the run pauses at the end of the current iteration, he works by hand, and on hand-back the Critic reads his commits as decisions (`DECISIONS.md`) and the run continues. | 1 |
| C13 | Ask Luna about the run | A chat from the phone or HUD about the current run ("why did you roll back iteration 14?"), answered by a read-only call over the run state, `PLAYTEST_LOG.md` and `DECISIONS.md`. | 2 |

### Feedback while it runs (B17)

The run **never pauses** for feedback. Mati (or a client) gives input
whenever they look at it, e.g. from a laptop on vacation after a milestone
email or a push, and the next iteration plans it in.

- **Channels:** a steer card from the phone (exists), the feedback link in
  the milestone email, and for web apps a small feedback widget on the
  **staging** build that a client can use without a LunaCore account.
- **Triage:** at the start of every iteration the Director reads new
  feedback. The Critic turns free text ("looks good, but the header is too
  big and the PDF export is missing") into cards: look and bug feedback
  becomes cards straight away and is scheduled first; anything that changes
  scope or `BRIEF.md` goes through the decision queue.
- **Trust:** Mati's feedback can change anything. Client feedback can create
  look/bug cards directly, but scope changes from a client always wait for
  Mati's yes in the decision queue (with no default answer, the rest of the
  run continues meanwhile).
- **Closing the loop:** each feedback item gets a status (planned / built /
  verified in app), visible on the phone and in the next milestone email.
- **Later option:** reply to the milestone email itself. That needs Gmail read
  access, which LunaCore does not have today (it only sends).

## Build plan

Each slice: `/plan` → TDD → `/code-review` → security review for IPC. The full
God Mode suite runs green on every slice. Live-checked end to end before this
doc becomes `DONE_LUNAS_WORK_PLAN.md`.

### Phase 1 — the loop works on a web app

1. ✅ **Rules + state** (`9f65d6a`, 2026-10-22) — `lunasworkRules.js` (stop,
   gate, plateau, steer priority, rollback trigger, `auto` model choice),
   `lunasworkStore.js`, 35 tests in `test/lunaswork-rules.test.js`. No IO.
   After review: scores compared only within one milestone, steer cards never
   cut by the limit, stuck cards left out, corrupt records dropped (never
   invented), run id restricted to git-tag-safe characters, a `researcher`
   role added (default sonnet).
2. **Settings + pre-production pack** — the Luna's Work button and settings
   (models per role, project profile), design pack templates including
   `ARCHITECTURE.md` / `DECISIONS.md`, interview brief, pack completeness check.
3. **Web playtester** — start app + readiness wait, headless Playtester with
   Playwright MCP only, schema, evidence screenshots, screenshot comparison.
   **Live check on AMSteel_Quote** before moving on.
4. **Critic + Director** — cards (bug cards require a repro test),
   `PLAYTEST_LOG.md`, project memory updates, milestone gate, steer cards.
5. **Outer loop** — the two optional God Mode hooks, merge mode per iteration,
   checkpoint tags + rollback, usage-limit wait, stop rules, run report + email.
6. **Decision queue** — phone question with default + deadline, never blocks,
   answers into `DECISIONS.md`.
7. **Panel** — start / steer / stop, current iteration + role, basic scores.
8. **Done = verified (B1), stuck cards (B4), scope guard (B5), flaky
   quarantine (B9)** — rules in `lunasworkRules.js`, wired into the Critic.
9. ✅ **Mid-run feedback (B17).** `lunasworkFeedback.js`: items stored in
   the run (never a pause), rule-based triage into cards at the start of
   every iteration (look / bug tagged `feedback`, scheduled right after
   steer cards; scope held by a decision - Mati's `feedbackScope` defaults
   to approve, a client's `clientScope` has none), per-item status
   (planned / built / verified) on the phone's God Mode page with a
   feedback form (`todos` unit `lunaswork-feedback:<id>`), and a lean
   milestone email (scores, what waits, feedback + link). The full B12 pack
   stays in Phase 2.
10. ✅ **Iteration 0 (B2) + survive the machine (B3).** `lunasworkScaffold.js`
    (empty repo -> Next.js/TS or Python (uv + pytest) template cards, built
    as iteration 0; profile defaults confirmed at start) and
    `lunasworkMachine.js` (watchdog task + `--lunaswork-watchdog`, Windows
    Update pause/restore, evidence + worktree cleanup, low-disk stop + email).
11. ✅ **"Hand me the wheel" (C11).** HUD panel and phone buttons: the run
    pauses at the end of the current iteration (persisted phase `handed`,
    app stopped, no step runs; a run waiting on a usage limit before its
    Director is handed at once). Usage-limit waits and decision deadlines
    keep ticking. Hand-back: `lunasworkHandback.js` reads every commit since
    the pause (git log + numstat) into one `DECISIONS.md` line each ("Mati
    changed X by hand") and a "Manual changes" section in `ARCHITECTURE.md`,
    then the run goes on from directing. The phone writes
    `lunaswork-wheel:<id>` units through the `todos` outbox
    (`lunasworkWheel.js`); the PC applies the newest of its run once.

### Phase 2 — scale

12. Contracts + ownership map (#2) · 13. Roadmap levels (#5) · 14. Playtester
personas (#6) · 15. Scheduled specialist reviews (#7) · 16. Self-learning
skills (#8) · 17. Live dashboard + phone snapshot (#12) · 18. Milestone
emails + return pack (B12) · 19. Design match + Lighthouse budgets (B6, B7) ·
20. Second-opinion model (B8) · 21. Realistic data + pl/en check (B10, B11) ·
22. Docs at SHIP + time to SHIP (B14, B15) · 23. Fresh code graph (B19) ·
24. Cross-browser and devices (C7) · 25. Design variants + mockup-first
toggles (C1, C2) · 26. GDPR / legal pack (C6) · 27. Ask Luna about the run (C13).

### Phase 3 — reach

28. Staging + client feedback widget (#10, B17) · 29. Backup before data
changes (C5) · 30. Load test (C8) · 31. Error tracking + launch assets
(C9, C10) · 32. Research step (#14) · 33. Demo video (B13) · 34. Project
queue (B16) · 35. Electron adapter · 36. Unity adapter (spike on the Unity PC
first) · 37. Asset pipeline (#15).

## Risks

- **Score inflation / fake progress** — mitigated by a Playtester with no code
  access, evidence-required scores, and a second Playtester for SHIP.
- **Backlog explosion** — milestone gate + `idea` cards only after the gate.
- **Endless run** — no budget cap by decision, so PLATEAU and RED are the
  safety net; both stop and email instead of grinding.
- **Merge to `main` while away** — guarded by the self-check gate plus
  checkpoint tags and automatic rollback (#4); slice 5 must be live-checked on
  a throwaway repo first.
- **Model cost with opus builders** — no cap by decision; `auto` and the
  optional free-provider fallback are the levers if it gets too expensive.
- **Unity** — single editor connection and YAML merges; deliberately last.
