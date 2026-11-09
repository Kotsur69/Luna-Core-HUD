# Implementation Plan: Free God Mode v2 - plan-only runs, best-models-only coding, wait instead of downgrade

> **🟡 BUILT, LIVE CHECKS OWED (re-checked against `main` 2026-11-10, after v0.25.0).**
> Written 2026-11-06 as a planning doc. Every slice is now on `main`: the plan-run core
> (`src/orchestraPlanRun.js`, released in v0.25.0), F1 lockdown / start / board (`89b377f`),
> F2 + F3 proxy 429, gateway request window and substitution guard (`88cbc66`,
> `src/fallbackproxy.js`, `src/freeLimit.js`, `src/freePacer.js`), F4 approve plan, build from
> plan and Q8 auto-split (`d0277a0`), F6a / F6b Workers selector, hybrid `free` model and risk
> guard (`21ba3d7`), F6c / F6d / F5 free packages, Claude review gate, 1 h hand-over and opt-in
> branch review (`62be1b4`). The F1-F6 work after v0.25.0 is not released yet. What is left is
> Mati's live checks (see "Resume here").

## Resume here

1. Built: F1-F6 and Q8 (see the status banner). The text below the "Goal" section is the
   original plan, kept as the design record.
2. Live checks owed (unit tests cannot clear these), taken from "Success criteria":
   - a real plan run (e.g. Blade & Bullet "story, physics, mechanics") writes the topic docs,
     `CRITIQUE.md` and `PLAN.md` on `luna-plan/<slug>` and nothing outside `docs/plans/<slug>/`;
   - a build run's log shows only `auto:coding` models (F3);
   - with every coding model limited, the run pauses, shows the retry time and continues on
     its own after the reset (F2), including the CLI's transcript entry for the proxy's 429;
   - Approve plan creates exactly one to-do per unchecked task, also when clicked twice (F4);
   - a hybrid run ("Plan with free models in mind") sends a simple package to a free worker,
     passes the Claude review gate and integrates.
3. When the live checks pass, `git mv` this file to `docs/done_docs/DONE_FREE_GODMODE_V2_PLAN.md`.

## Goal

Free God Mode follows one rule from Mati: **only the best free models write code; the weaker
ones do ideas, research, plans and Markdown, and never touch code.** Waiting a day for limits
to reset is fine. Quietly falling back to a weaker model is not.

Two run types on the God Mode board:

| Run | Profile | Writes | Ends with |
|---|---|---|---|
| **Plan run** (new) | `FreeLLMAPI - easy tasks` (`auto:easy`) | only `docs/plans/<slug>/*.md` | a plan Mati reads and approves |
| **Build run** (exists as "Free providers") | `FreeLLMAPI - coding` (`auto:coding`) | code on `luna-free/*` branches | pushed branches Mati reviews |

Examples:
- **Blade & Bullet:** "ideas: story, physics, mechanics" -> `story.md`, `physics.md`,
  `mechanics.md` in parallel, then `PLAN.md` that merges them into a build plan with tasks and
  acceptance tests. Nothing is built.
- **New SaaS:** `research.md` (market, options, trade-offs) -> `stack.md` (recommended stack and
  why) -> `PLAN.md` (milestones, tasks, acceptance tests).

## Already in place (2026-11-06, live-checked)

- FreeLLMAPI named chains, each called as `auto:<name>`. A named chain only falls back
  **inside itself**, verified through the `X-Routed-Via` header:
  - `auto:coding`: Nemotron 3 Ultra 550B, GPT-OSS 120B, Nemotron 3 Super 120B.
  - `auto:easy`: Gemini 3.5-3.8 Flash, Qwen3.8 27B, Dots3 Note Preview, Command A Reasoning,
    Command A+, GLM-4.7 Flash, Muse Glimmer 30B, Llama 4 Scout.
  - The two chains share no models, so planning never uses up the coding quota.
  - `auto:default` (86 models) stays the active chain for everything else.
- LunaCore profiles (`config/profiles.local.json`):
  - `freellm-chain` = "FreeLLMAPI - coding". Fallback chain `free-coding` = `["auto:coding"]`
    (in `config/freechains.local.json`).
  - `freellm-auto` = "FreeLLMAPI - easy tasks". `ANTHROPIC_MODEL=auto:easy`, deliberately **no**
    fallback chain, so `pickFreeProfileId()` (`src/orchestraFree.js`) can never choose it for a
    build run.
- God Mode already pauses a whole run when a worker hits a usage limit and resumes on its own
  at the reset: `observer.js usageLimitFrom()` -> `main.js onUsageLimit` ->
  `orchestra.js onUsageLimit()` / `pauseUntil()`. Free tabs are `ownBackend`
  (`main.js failoverEligible`), so they are never moved to a Claude account.

## Live checks done (2026-11-06, before any building)

| Check | Result |
|---|---|
| Search engines in FreeLLMAPI | Tavily, Exa, Firecrawl, Linkup all keyed and answering. `POST /v1/search` with `"engine": "<id>-search"` picks one; without it Tavily (default) goes first and the rest take over as credits run out. Response: `{query, results, provider, engine}`. |
| Claude Code WebSearch on a free model | **Works.** Headless `claude -p` on `auto:easy` used WebSearch through the gateway (`webSearchRequests: 1`) and returned real URLs. The CLI prints `unrecognized_model auto:easy` - harmless; its "cost" figure is its own estimate, the gateway is free. |
| Plan-worker lockdown | **Works** with CLI 2.1.319: `--permission-mode dontAsk --allowedTools Read Glob Grep WebSearch "Edit(docs/plans/<slug>/**)"`. The plan file was written; `src/app.js` stayed untouched; Bash was refused. **`Write(...)` rules do NOT match** - use `Edit(...)`, which covers Write too. `docs/...`, `./docs/...` and `/docs/...` all behaved the same. Oddity to re-check when building: `permission_denials` also listed the allowed file once although it was written. |
| Gateway answer when a whole chain is limited | HTTP **429** `rate_limit_error`: "All models rate-limited after 1 attempt. Soonest cooldown reset ~2m ..." with `Retry-After` (seen 90 and 600 s). Later calls while cooling: 429 "All models exhausted: 1 route checked ..." **without** `Retry-After`. (Burst of 60 at a 1-model test chain; the chain was deleted afterwards.) |
| Gateway's own rate limit | `x-ratelimit-limit: 120` per window on the unified key, shared by every worker. |

## Gaps found in the code

1. **Exhausted chain = error, not a wait.** When every model of the chain is cooling,
   `fallbackproxy.js:215` answers `overloaded_error`. The observer does not read that as a usage
   limit (`LIMIT_TEXT` / status 429), so the worker hits API errors and stalls instead of the run
   pausing.
2. **The proxy cannot see substitution.** It fails over only on 429 / 5xx / "unknown model". A
   gateway that answers from another model returns 200, and the proxy passes it through.
3. **No plan-only run.** Every run goes planner -> coding workers, with
   `permissionMode: 'bypassPermissions'` (`orchestra.js:294`). Nothing limits a worker to writing
   Markdown.
4. **Web search needs setup.** Claude Code's WebSearch is an Anthropic server-side tool. Free
   models only get it through the gateway (see "Research tools" in F1). Until that is set up, a
   plan run only has model knowledge, WebFetch and the repo.

## Slice F1 - Plan-only runs (the main slice)

**Board:** next to "Free providers", a run type switch **Build / Plan only**. Plan only takes
one free-text box: Mati types what has to be planned, in his own words ("ideas for Blade &
Bullet: story, physics, mechanics, how they connect"). **No presets** (Q1).

**Topic split.** One planner call (Claude or Free, the D1 choice) turns the text into 2-6
research topics with a slug and a one-line question each. This is an easy job, so it is fine on
the free planner. LunaCore validates the answer (slugs, count, length caps) like
`validatePlan()`. The board shows the topics before Approve, so Mati can rename, add or drop
some.

**Packages** (new pure module `src/orchestraPlanRun.js`):
- one package per topic -> `docs/plans/<slug>/<topic>.md`, all in parallel;
- one `critique` package that depends on all topic packages -> `docs/plans/<slug>/CRITIQUE.md`
  (Q2). A different model of `auto:easy` from the topic writers when possible. It lists holes,
  contradictions between topics, unproven assumptions and missing sources. It does not
  propose the plan itself;
- one `synthesis` package that depends on the critique -> `docs/plans/<slug>/PLAN.md`. It must
  answer every critique point (fixed, or accepted with a reason) in a "Critique answered"
  section;
- every brief states the goal, the output path, a fixed section outline, and "no code, no edits
  outside this folder";
- `PLAN.md` has a fixed outline: Summary, Decisions, Critique answered, Milestones, Tasks
  (checkbox list, sized and checked as in "Task sizing" below), Risks, Open questions. F4
  parses the Tasks section.
- **All plan docs are English** (Q4), whatever language Mati types in.
- **Plan workers read the whole repo** (Q5): code, assets, configs, existing docs, so ideas fit
  what is already built. They can edit nothing outside `docs/plans/<slug>/`.

**Task sizing (Q3).** Target: one task = one worker session (well under the 2 h cap), one area
of the code, one checkable acceptance test. How well a model can judge that differs, so the
two planners get different treatment:

| | Claude planner | Free planner |
|---|---|---|
| Sizing | judgment: reads the code, sizes by real effort | rules: sizes by things LunaCore can count |
| Each task must list | files / areas, acceptance test | same, and the list is checked |
| LunaCore check | light: format, acceptance test present | strict: files exist (or are marked new), at most 5 files and 1 top-level area per task, at most ~400 lines of existing code touched, acceptance test is a command or a concrete check, no task text over the cap |
| A task fails the check | flagged on the board | sent back once: "split these tasks"; still failing -> flagged |
| At run time | stall -> Sonnet -> Opus escalation (today) | a task that stalls or hits the 2 h cap twice goes back to the planner to be split into 2-3 smaller ones |

So a free planner does not need good judgment: it only has to follow counting rules that
LunaCore checks, and the run itself corrects what slipped through. Mati can always re-plan a
free plan with the Claude planner from the board.

**Enforced by config, not by the prompt** (weaker models drift):
1. Workers run on the easy profile with `--permission-mode dontAsk` (not `bypassPermissions`).
   Allowed tools: `Read`, `Glob`, `Grep`, `WebSearch`, `WebFetch`, the read-only Playwright MCP
   tools, `Edit(docs/plans/<slug>/**)` (covers Write; a `Write(...)` rule does not match).
   Everything else is denied without a prompt. Live-checked, see "Live checks done".
2. Finish guard in `orchestraFinish.js`: for a plan run, `git status` may only show paths under
   `docs/plans/<slug>/`. Anything else is reverted, logged, and the package is stalled with the
   reason `outsidePlanFolder`.
3. Branch `luna-plan/<slug>`, always committed and pushed, integration fixed to `branches`
   (same rules as `orchestraFree.js`, its own prefix).

**Research tools (D3: required).** Every plan run must be able to search the web and read
pages. Every research doc ends with a `## Sources` section listing the URLs it used; the
finish guard stalls a topic package whose doc has no sources.
1. **FreeLLMAPI search (first choice).** The gateway's Search page (Modele -> Search) serves
   `POST /v1/search`, and the app says it "also answers web searches from Claude Code and
   Codex". So the normal WebSearch tool should work on free profiles once an engine key is set.
   Engines rotate in priority order when one runs out of free credits:

   | Engine | Free tier | Notes |
   |---|---|---|
   | Tavily | 1,000 credits/month, no card | 1 credit per search, sourced answers, current default |
   | Exa | $10/month credits, no card | also reads pages |
   | Firecrawl | 1,000 credits/month (2 per search), no card | also reads pages |
   | Linkup | free monthly credits (eligible accounts) | sourced answers |

   All four keys are set (2026-11-06), roughly 2,500+ searches a month together. WebSearch
   from `claude` on `auto:easy` is live-checked.
2. **Playwright MCP (reading).** It runs locally as tools, so any tool-calling model can use
   it. For pages that WebFetch cannot read (JS-heavy sites, docs portals, competitor sites).
   Plan workers get it read-only: navigate, snapshot, evaluate. No form filling, no downloads.
3. **Fallbacks if search runs dry:** the vendored Agent-Reach (Reddit / HN / public platforms,
   already used by Mission Control feeds), and Jina Reader (`r.jina.ai/<url>`, free) for turning
   a page into Markdown through WebFetch.

**Report:** the run report links every `.md` written; the inbox item says "Plan ready to review".

Tests: topic-split validation; package graph (topics -> critique -> synthesis); brief
contents; the free-planner sizing checks (file count, area, touched lines, acceptance test); the finish guard
(inside / outside / mixed paths); branch prefix safety. UI strings in pl + en, no diacritics in
config.

## Slice F2 - Wait instead of downgrade

- `fallbackproxy.js`: when every chain model is limited, answer **429** (today it answers
  `overloaded_error`, `fallbackproxy.js:215`) with a body in the form `usageLimitFrom()` /
  `parseResetAt()` already read: limit text plus a **local clock time**, e.g.
  `Free coding models: usage limit reached · resets 3:40pm`. `parseResetAt` reads only
  "resets H[:MM]am|pm" (optionally "Mon D,"), not an epoch.
- Reset time, in order: the gateway's `Retry-After`; else the "Soonest cooldown reset ~Xm" in
  its message; else the proxy's own soonest cooldown; else now + 30 min. The gateway sends the
  429 itself (see "Live checks done"), so the proxy mostly rewrites it, not invents it.
- **Verify when building:** the CLI writes the proxy's 429 body into the transcript as an API
  error entry (`apiErrorStatus: 429` + text), after its own internal 429 retries.
- The existing run-wide pause takes over: workers wait, `RESUME_TEXT` continues them at the
  reset. No new pause machinery.
- Daily caps often come with no reset time. Then the wait is 30 min and the proxy re-probes one
  model, the same idea as `orchestraPlanWait.js FALLBACK_WAIT_MS`. The board shows "Free coding
  models limited - retrying at HH:MM".
- Cooldown for `limit` without `Retry-After` goes from 60 s to the gateway's "~Xm" hint when
  present.
- Gateway rate limit: 120 requests per window on one key, for all workers together. With many
  free workers, the proxy should space requests (or the run caps free workers) rather than
  hit it; a gateway-level 429 that is not "All models ..." is a short wait, not a long pause.

Tests: the proxy's exhausted-chain answer is parsed by `usageLimitFrom()` into the right epoch;
a run with an exhausted free chain pauses and resumes (fake timers).

## Slice F3 - Substitution guard

- A chain entry may declare which real models it accepts:
  `"expect": ["nemotron-3-ultra", "gpt-oss-120b", "nemotron-3-super"]` (substrings of the
  `X-Routed-Via` value).
- `fallbackproxy.js` reads `X-Routed-Via` on every answer. If it matches none of `expect`, the
  answer counts as a failure of kind `substituted`: that model cools down, and the request goes
  to the next one, or to the F2 wait when none is left. Streaming answers: decide on the
  response headers, before any body is forwarded.
- The real model goes into `x-lunacore-model` and the run log, so the board shows who actually
  wrote the code.
- Only for build runs. Plan runs accept any `auto:easy` member.

Tests: matching and non-matching `X-Routed-Via`; a missing header (accept, log a warning);
cooldown and retry order.

## Slice F4 - Plan -> build hand-off

- On a finished plan run, the board shows **Approve plan** for `PLAN.md`.
- Approve merges `luna-plan/<slug>` into `main` (D2) and turns each unchecked task
  in the Tasks section into a LunaCore to-do tagged with the plan slug (existing to-do store).
- Mati then starts a normal **Build** run with Free providers on those to-dos. Its planner reads
  `PLAN.md` as context; each worker brief links the task's acceptance test.
- The build planner is Claude or Free, chosen on the board (D1).

Tests: Tasks-section parser (checkboxes, nested items, acceptance-test lines); idempotent
import, so approving twice does not duplicate to-dos.

## Slice F6 - Hybrid runs: "Plan with free models in mind"

A normal Claude God Mode run where Claude hands only the **very simple** packages to free
models (font sizes, spacing, colours, copy text, a config value, one small frontend tweak).
Heavy work stays on Claude.

**Board: one "Workers" selector** replaces the single "Free providers" tick:

| Option | Planner | Workers |
|---|---|---|
| **Claude only** (default) | Claude | Claude (today's run, unchanged) |
| **Plan with free models in mind** (new) | Claude | Claude, plus free for the simple packages |
| **Free only** (today's "Free providers") | Claude or Free (D1) | free coding profile |

**Planner.** With the hybrid option on, the planner schema's per-package `model` enum gains
`"free"` (today `opus` / `sonnet`, `orchestraPlan.js:79`). The prompt rule: `"free"` only for
small, mechanical, low-risk changes - styling, layout, copy, i18n strings, a config value -
in 1-2 files, with no logic, state, IPC, security, data or build changes. When in doubt:
`sonnet`.

**LunaCore guard (Claude's judgment, plus rules).** A package marked `free` is upgraded to
`sonnet` (and the board says why) when it:
- lists more than 2 files, or no files;
- touches a protected path: `src/main.js`, `src/preload.js`, IPC handlers, auth / keys /
  secrets, migrations, `package.json` / lockfiles, build config, CI, test infrastructure;
- has no acceptance test or verify step.
The protected list lives in config, so each repo can extend it.

**Workers.** Free packages run on the `FreeLLMAPI - coding` profile (`auto:coding`), never
`auto:easy`: they write code, and only the best free models write code. Same worktree flow as
Claude packages.

**Gate before a free package joins the run** (because hybrid runs integrate into `main`, unlike
free-only runs):
1. verify passes (the normal loop, max rounds as today);
2. one short, read-only Claude review of the package diff (headless Sonnet): pass / fail with
   reasons;
3. pass -> the package integrates like any Claude package. Fail, or two stalls -> the package is
   **handed to Claude** (Sonnet) from its current worktree. This is an upgrade, not a downgrade,
   so it matches Mati's rule.

**Waiting (Q9).** A free package waiting on free limits (F2) for **1 hour** while Claude
packages depend on it is handed to Claude (Sonnet) from its worktree. With no dependants it
just waits for the reset.

**Report.** Per package: who planned it free, guard upgrades, review result, hand-overs. Over
time this shows which kinds of tasks free models really handle.

Tests: schema with and without the hybrid option; the guard (file count, protected paths,
missing verify); review pass / fail / hand-over transitions; a Claude-only run is byte-for-byte
unchanged (no `free` in the schema).

## Slice F5 (optional) - Claude review of free branches

When a free build run settles, an opt-in checkbox runs one read-only headless Claude review
per `luna-free/*` branch. It writes `docs/plans/<slug>/REVIEW.md`. This costs a few Claude
tokens per branch and catches what weaker models get wrong. It waits for the Claude limit like
the planner does (`orchestraPlanWait.js`).

## Risks

| Risk | Mitigation |
|---|---|
| Free coding models are well below Claude | Acceptance tests in every task; the verify loop; F5 review; never auto-merge (`luna-free/*` stays branches-only) |
| A weak model writes outside the plan folder | Permission allow-list + finish guard (F1), not the prompt |
| Gateway behaviour changes (catalog sync, chain format) | F3 guard catches silent substitution; live re-check after FreeLLMAPI updates |
| Exhausted-chain answer not parsed as a limit | Gateway answer is known (429 + Retry-After); F2 rewrites it into the "resets H:MMpm" form the observer parses, with a unit test on the real body |
| 120-request gateway window shared by all workers | Proxy spacing / free-worker cap (F2) |
| Search credits run out mid-run | Four engines rotate in the gateway; Agent-Reach / Jina Reader fallbacks; sources section shows what was really read |
| Prompts may be used for training on free tiers | Plan and build runs only on repos Mati is allowed to share; noted on the board |
| `orchestra.js` is already 2395 lines | New logic goes into new pure modules (`orchestraPlanRun.js`, proxy helpers); `orchestra.js` only wires |

## Decisions (Mati, 2026-11-06)

- **D1 - Build planner: both, as a choice.** The board offers "Planner: Claude / Free". Claude =
  today's headless planner (waits for the Claude reset when spent). Free = the same planner call
  on the coding profile (`auto:coding`); its output still goes through `validatePlan()`.
- **D2 - Approved plans merge into `main`** (the target branch). Plans are docs only, and the
  build run needs `PLAN.md` on its base.
- **D3 - Web research is required**, built in F1 (see "Research tools"), and every research doc
  lists its sources.
- **D4 - Mati creates the repo first.** "Plan only" never creates project folders.
- **Not building yet (2026-11-06).** This is a planning phase: refine the doc together first.

## Answered (Mati, 2026-11-06)

- **Q1 - No presets.** Mati types what to plan; the planner splits it into topics.
- **Q2 - Critic round: yes** (`CRITIQUE.md` before `PLAN.md`).
- **Q3 - One task = one worker session**, with the two-planner sizing in F1.
- **Q4 - English only.**
- **Q5 - Plan workers read everything**, edit only their plan folder.

- **Q6 - Plan runs start right away** after the topic split (topics shown, no confirm step).
- **Q7 - Free-planner limits accepted:** 5 files / 1 area / ~400 touched lines per task.
- **Q8 - Auto-split:** a free task that stalls twice is split automatically and the run goes on.
- **Hybrid runs (Mati's idea, 2026-11-06):** "Plan with free models in mind" option, Claude
  decides which simple packages go to free models (Slice F6). Claude-only stays available.

- **Q9 - Hybrid waiting:** a free package that has waited **1 hour** on free limits while Claude
  packages depend on it is handed to Claude (Sonnet).
- **Q10 - Hybrid review: yes**, a short read-only Claude review of every free package diff.

## Open questions (planning together)

None right now. Search keys are set and the pre-build live checks are done (see "Live checks
done"). Two small checks stay for build time: the `permission_denials` oddity (F1) and the CLI's
transcript entry for the proxy's 429 (F2).

## Success criteria

- A plan run on Blade & Bullet with topics "story, physics, mechanics" produces three topic docs
  and `PLAN.md` on `luna-plan/<slug>`, and changes no file outside `docs/plans/<slug>/`.
- A build run never lets a model outside `auto:coding` write code (F3 log shows only the three
  coding models).
- With every coding model limited, the run pauses, shows the retry time, and continues on its
  own after the reset, without a stall and without a weaker model.
- Approving a plan creates exactly one to-do per unchecked task.
