# Luna's Work — plan

> Status: **PLAN, not built.** Written 2026-10-22. Waiting for Mati's confirm
> before slice 1.

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
| 12 | Live dashboard | HUD + phone: iteration timeline, scores per milestone over time, tokens per role, cards opened/closed, latest screenshots, pending decisions. One daily summary email instead of one per iteration. | 2 |
| 10 | Staging | Migrations and edge functions applied to a **staging** copy, and the Playtester tests staging. Anything touching production goes to the decision queue. | 3 |
| 14 | Research step | When the design references other products ("like X"), a research agent fills `design/references/` before building starts. | 3 |
| 15 | Asset pipeline (games) | Generation APIs + Blender MCP, an asset list so nothing is generated twice, and a style check where the Critic compares new assets with the art direction references. | 3 |

## Build plan

Each slice: `/plan` → TDD → `/code-review` → security review for IPC. The full
God Mode suite runs green on every slice. Live-checked end to end before this
doc becomes `DONE_LUNAS_WORK_PLAN.md`.

### Phase 1 — the loop works on a web app

1. **Rules + state** — `lunasworkRules.js` (stop, gate, plateau, steer
   priority, rollback trigger, `auto` model choice), state store, tests. No IO.
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

### Phase 2 — scale

8. Contracts + ownership map (#2) · 9. Roadmap levels (#5) · 10. Playtester
personas (#6) · 11. Scheduled specialist reviews (#7) · 12. Self-learning
skills (#8) · 13. Live dashboard + phone snapshot + daily email (#12).

### Phase 3 — reach

14. Staging (#10) · 15. Research step (#14) · 16. Electron adapter ·
17. Unity adapter (spike on the Unity PC first) · 18. Asset pipeline (#15).

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
