# LunaCore - God Mode v3: the Orchestrator

## Goal

Turn God Mode from a paste-loop into a supervisor. Mati writes short to-do
notes ("rewrite the db layer", "new app icon", "read my mails and summarize"),
walks away overnight, and an orchestrator model:

1. **routes** each item to the right model and project (DB rewrite -> Opus,
   icon -> Sonnet, mail digest -> Haiku),
2. **writes a proper prompt** from the short note (context, goal, definition
   of done),
3. **opens a worker tab** with that model in that project and sends it,
4. **supervises**: reads every finished turn, answers the worker's questions
   itself, nudges when it drifts, retries when it fails,
5. **finishes the job**: tests pass, `.md` docs updated, commit, push, tick
   the item - then the next one,
6. leaves a **morning report** of what happened.

Plus, independent of the orchestrator: **add to-dos from any Claude tab** by
just typing "add to my todos: x, y, z".

## Where we are (v2, 2026-10-05)

God Mode today has no model of its own. Per tab: read the list, paste the
first open item verbatim (+ a fixed "don't stop to ask" line), wait for
`onTurnEnd`, tick, next. v2 made it per-tab and parallel (different projects
in parallel, same project refused). v3 keeps that loop as **Simple** mode and
adds **Orchestrator** mode next to it.

## Relation to LUNA_HARNESS_TREE_SPEC.md

That spec (Go + Bubble Tea, Kimi/Codex/LM Studio workers, file-lock mutexes)
is an earlier concept for a standalone TUI; it does not match this Electron
app. v3 is its concrete, in-app first step and keeps its two core ideas:

- **route work by specialty** - here to Claude models first; a worker is a
  LunaCore *profile* + model, so LM Studio / GLM / CCR providers (already
  supported as profiles) can be routing targets later without a redesign;
- **a live panel of every worker** - the "harness matrix" becomes the
  orchestrator view in Phase 6.

File-level locks are replaced by the simpler v2 rule: one worker per
project at a time.

## Decisions locked in (Mati, 2026-10-05)

1. **Full autonomy.** Testing, prompt writing, updating `.md` files,
   committing and pushing are all in scope - no human checkpoint mid-run.
2. **Cost is not a constraint.** God Mode is for unattended/overnight work on
   personal and fun projects, so the orchestrator may use Opus freely and
   take as many supervision turns as it needs (bounded only by loop guards,
   see Guardrails - those are about runaway loops, not money).
3. **Tools are already there.** Gmail, Calendar and the other MCPs are
   installed, so "read my mails" style tasks are normal tasks.
4. **To-dos can be added from the terminal** by talking to Claude in any tab.

## Reused, not rebuilt

| Need | Already exists |
|------|----------------|
| Open a tab in a project | `createSession({ projectId, profileId })` in `src/main.js` |
| Type into a tab | `pastePrompt(text, submit, sessionId)` |
| "Worker finished a turn" | `TranscriptWatcher.onTurnEnd` (`src/observer.js`) |
| Read what the worker said | the session's JSONL transcript (observer already tails it) |
| Usage-limit / connection-drop recovery | `godmode.js` signals + `autoproceed.js` |
| Keep the PC awake, local backend watchdog | `src/overnight.js` (multi-run since v2) |
| Parallel runs, one per project | v2 `runs` map + `findProjectConflict()` |
| To-do storage | `src/todo.js` (`readTodos`/`writeTodos`, per project) |
| Slash-command safety | `promptFor()` in `godmode.js` |

New code goes into `src/orchestrator/*` - `src/main.js` is already far past
the file-size guideline, so it only gets thin IPC wiring.

## Architecture

```
 To-do list ──► Orchestrator (main process, src/orchestrator/)
                  │
                  ├─ brain.js      headless `claude -p --model opus` calls,
                  │                JSON in / JSON out, validated at the boundary
                  ├─ router.js     note -> { project, model, prompt, doneWhen }
                  ├─ dispatcher.js open worker tab (model + project), send prompt
                  ├─ supervisor.js on each worker turn-end: done | question |
                  │                nudge | retry | blocked
                  ├─ finisher.js   verify -> docs -> commit -> push -> tick
                  └─ journal.js    per-run log + morning report
                  │
 Worker tabs ◄────┘ ordinary LunaCore tabs running `claude --model <x>`
```

### The brain

- Runs as **headless Claude Code**: `claude -p --model opus
  --output-format json`, spawned by main. It uses Mati's existing Claude
  login - no separate API key, no new secret.
- Every brain call has one job and one JSON shape (route, write prompt,
  judge a turn, write the report). The output is parsed and validated; a
  malformed answer is retried once, then the item is marked `blocked` -
  never guessed at.
- The brain sees: the to-do note, the project's `CLAUDE.md`/README summary,
  recent git log, the available models/profiles, and (when supervising) the
  worker's last turn. Not the whole transcript - a bounded tail.

### 1. Route + write the prompt

One brain call per item returns:

```json
{
  "project": "luna-core-hud",
  "model": "opus | sonnet | haiku",
  "why": "schema migration with data risk",
  "prompt": "full worker prompt...",
  "doneWhen": ["npm test passes", "README updated", "pushed to current branch"],
  "dependsOn": []
}
```

Default routing guidance given to the brain (editable in a config file, not
hard-coded): architecture, refactors, DB/data work, hard debugging -> Opus;
everyday features, UI, icons, docs -> Sonnet; reading/summarizing mail,
calendar, quick lookups -> Haiku.

**Plan only** (dry run): run step 1 for the whole list and show the routes
and prompts without executing anything. This is how Mati tests the
prompt-writing before trusting it overnight.

### 2. Dispatch

- New tab per item, in the routed project, launched with `--model <x>`
  (new: a per-session model override on `createSession`, appended to the
  profile's args).
- Worker tabs run in the permission mode Mati already uses (auto mode), so
  they do not stall on approval prompts at 3am.
- The prompt always ends with the definition of done, including "commit
  with a conventional message and push" when the item touches a repo.

### 3. Supervise

On every worker `onTurnEnd`, the supervisor reads the worker's last turn and
asks the brain for a verdict:

| Verdict | Action |
|---------|--------|
| `done` | go to Finish |
| `question` | brain writes the answer, pasted into the worker tab |
| `nudge` | worker drifted or stopped early: paste a correction |
| `retry` | failed attempt: paste a fix-up instruction |
| `blocked` | cannot proceed without Mati: mark item blocked, move on |

This replaces v1/v2's "use your own judgement, don't ask" line: the worker is
allowed to ask, and the orchestrator answers.

### 4. Finish

The orchestrator checks `doneWhen` itself (brain call over the worker's own
report + a fresh `git status`/test-run turn), then makes sure docs are
updated, the commit exists and the push succeeded. Only then is the item
ticked. The worker tab is closed (or kept, per setting) and the next item
starts.

### 5. Journal + the morning report

Every decision (route, prompt, each verdict, every answer the brain gave on
Mati's behalf, tests run, commits, pushes, limit waits) is appended to
`userData/godmode-runs/<date>-<run>.jsonl` as it happens - so a crash at 4am
still leaves the record.

When the run ends (list empty, or Mati turns it off), the brain turns the
journal into **one report** Mati reads when he gets back to the PC. It is
the single place to start the day, so it covers everything:

| Section | What is in it |
|---------|---------------|
| **Summary** | items done / blocked / skipped, run time, time spent waiting on limits |
| **Done** | per item: what was done, model used, commits (hash + message), pushed branch, tests run and their result, docs updated |
| **To review** | what deserves a human look: risky or large diffs, files touched outside the item's obvious scope, tests that were changed (not just added), anything the brain was unsure about |
| **Decisions made for you** | every question a worker asked and the answer the brain gave - so Mati can overrule one in the morning |
| **Needs your answer** | blocked items, each with the exact question / missing info, ready to answer |
| **New to-dos** | follow-ups the workers discovered (also added to the to-do list via the `lunacore-todo` tools), plus the brain's suggested next steps |
| **Problems** | failures, retries, stalls, connection drops, limit walls and how each was handled |

Delivery:
- saved as `userData/godmode-reports/<date>.md` (kept, a history of nights);
- shown in LunaCore as a **Report** panel, opened automatically on the next
  start/focus after a run, with each "needs your answer" item answerable in
  place (the answer is sent to that item's worker, or re-queues it);
- optional: emailed to Mati via the Gmail MCP / sent as a phone push.

Simple mode (v2's paste-loop) gets a lighter version of the same report
from Phase 5: items done, items stalled and why, limit waits - no brain
needed, it is built straight from the journal.

## Add to-dos from the terminal

Type in any Claude tab: *"add to my todos: fix the icon, update the readme,
read my mails"* -> the items appear in that tab's project list, live.

How:
- LunaCore ships a tiny **`lunacore-todo` MCP server** (stdio) with tools
  `add_todos(items[])`, `list_todos()`, `complete_todo(id)`.
- It does NOT write the store file itself (main does read-modify-write on it;
  two writers would lose updates). It forwards to main over a
  **localhost-only endpoint with a random per-launch token** passed in the
  session env; main validates, writes via `todo.js`, and broadcasts so the
  widget updates.
- The target project comes from the calling tab: each session's env already
  carries its id (`sessionenv.js`), main maps id -> projectId. A Claude
  session outside LunaCore gets a clear "LunaCore is not running" error.
- The orchestrator uses the same tools, so a worker can add follow-up items
  it discovers ("found 3 flaky tests - added to todos").

This ships first: small, independent, useful on its own.

## Guardrails

Cost is not a limit, but runaway loops and irreversible damage still are.

- **Loop guard:** max supervisor rounds per item (default 25) and max
  identical verdicts in a row (3) -> `blocked`, not an infinite ping-pong.
- **Git:** push to the current branch is allowed. Never force-push, never
  rewrite published history, never delete branches - stated in every worker
  prompt AND checked in the finisher (refuse to tick if a force-push
  happened).
- **One worker per project at a time** (v2 rule) unless git worktrees are
  added later - two agents in one checkout corrupt each other's work.
- **Kill switch:** turning God Mode off stops the orchestrator, sends no
  further prompts, and leaves worker tabs open for inspection.
- **Everything logged** in the journal, so a bad night is debuggable.

## Phases

| # | Deliverable | Testable on its own by |
|---|-------------|------------------------|
| 1 | `lunacore-todo` MCP + localhost bridge | "add to my todos: a, b" in a tab |
| 2 | Per-session `--model` override, worker tab spawn | open a tab as Haiku from code |
| 3 | `brain.js` + router + **Plan only** dry run | route a real list, read the prompts |
| 4 | Supervisor loop (answer / nudge / retry / blocked) | a task that makes Claude ask a question |
| 5 | Finisher (verify, docs, commit, push) + journal + full morning report (all sections above) | a full overnight-style run on a toy repo |
| 6 | UI: Simple / Orchestrator mode, worker panel, Report panel with in-place answers, PL+EN | click-through |

Each phase: tests first (pure parts - routing JSON validation, verdict
handling, loop guard, token check - are unit-testable without Electron),
then `--luna-probe`, then a manual pass.

## Resolved (Mati, 2026-10-05)

- **Usage limits never stall a run.** Already shipped in v2 (see below):
  the wall is detected from the transcript with its reset time, the run
  waits it out and types "continue" on its own, as many times as needed.
- **The morning report is the deliverable** - done, to review, decisions
  made, questions to answer, new to-dos, problems (section 5).
- **Brain model:** Opus for every brain call (routing, prompts, judging,
  report).
- **Push target:** the project's current branch.
- **Worker tabs:** closed once their item is ticked; the journal and morning
  report keep the record.
- **Parallelism:** items in different projects run in parallel (one worker
  per project), same project stays serialized.
