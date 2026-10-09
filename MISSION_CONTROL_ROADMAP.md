# Mission Control — Roadmap to "my whole life in one dashboard"

Mission Control (**Ctrl+Shift+M**) shipped in **v0.14.0** with four columns:
Inbox cleanup, Calendar, Telemetry and News. This file is everything still
owed to finish it, plus the ideas Mati picked on 2026-10-09. Every decision
below was **answered by Mati** — do not re-ask them; ask only what is listed
under *Open questions*.

---

## ▶ Starting prompt (copy, paste, go)

> Continue Mission Control in LunaCore. Read `MISSION_CONTROL_ROADMAP.md`
> top to bottom, then `CLAUDE.md` and the memory index. Pick the **first
> workstream not marked ✅** in *Build order* below (or the one I name here:
> `____`). Before writing code: ask me the *Open questions* for that
> workstream in one AskUserQuestion round, verify any external tool live
> (install + probe it, don't trust its docs), and tell me the plan in five
> lines. Then build it TDD-first, run the full `npm test`, smoke-test the
> panel in the running app over CDP (screenshot), run `ecc:security-reviewer`
> on anything touching IPC / preload / network / spawned processes, fix
> CRITICAL+HIGH, update this file (mark the workstream ✅, move learnings into
> *Gotchas*), and commit + push the explicit file list (never `git add -A`,
> leave other sessions' hunks out). Talk to me in the language I write in.

---

## What shipped in v0.14.0

- **Inbox cleanup** — Haiku dry-run scan of `in:inbox` via the claude.ai Gmail
  connector, tick → Apply = `trash_thread` only on approved ids.
- **Calendar** — Google Calendar API (read-only OAuth, PKCE, loopback,
  token encrypted with `safeStorage`), every ticked calendar, week list + month
  grid, natural-language quick add (Haiku parse → editable draft → create).
- **Telemetry** — `gh api graphql`: contributions, 8-week bars, 12-week
  heatmap, open PRs / reviews / issues; Claude weekly budget vs even pace,
  burn rate, projected hit; late-week flags (`src/renderer/modules/missionpace.js`).
- **News** — vendored Agent-Reach (`helpers/agent-reach/`, MIT, upstream
  `94f06c1`) + `lunacore_fetch.py` bridge in its own venv; sources (YouTube,
  RSS, web via Jina, GitHub) and topics (YouTube, GitHub, Bilibili, HN);
  one Haiku call → briefing + per-section summary + picked links.

## Decisions already made (2026-10-09)

| Topic | Decision |
|-------|----------|
| Project classes | **Set in the UI.** New projects appear as *unassigned*; one click marks them **work / fun / other**. Stored in `config/mission-projects.local.json`. Nothing hard-coded. |
| Claude % per project | **Tokens weighted by model price** from the local transcripts (reuse `src/rates.js` + `config/rates.json`), share of the current weekly window. Labelled as an *estimate*. |
| Weekly review | **Sunday 20:00 automatic + "Generate now" button**, saved to history, **emailed to Mati** with Gmail `send_message` (**recipient hard-checked = Mati's own address, nothing else**). |
| Missed schedule | **Catch up once on next launch** (no duplicates: key by ISO week / date). |
| Models | **Picker per job in the UI** (like the mail column), default Haiku. |
| X / Reddit | **Cookie extract through Agent-Reach** (`twitter-cli`, `rdt-cli` configs). Cookies stay in Agent-Reach's own config; LunaCore never reads or stores them. |
| Extra ideas kept | Morning brief, Focus / time per project, Goals per week, Trackday weather. (*Stale-project radar*, *Claude ROI* and *Release radar* were **not** picked — don't build them.) |
| News presets | AI/Claude, Honkai Star Rail leaks, Motorsport/trackday, Dev/tools (lists below). |

---

## Build order

Each workstream is shippable on its own. Data first, because the weekly
review and the morning brief are only as good as what they summarise.

### W1 — Project ledger: Claude % per project ⏳

*"Which project ate my weekly limit?"* — Mati's favourite metric.

- **Source:** `~/.claude/projects/*/*.jsonl`. Every assistant line carries
  `cwd`, `timestamp`, `message.model` and `message.usage`
  (`input_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`,
  `output_tokens`). Verified live 2026-10-09.
- **Project key:** the git root of `cwd` (walk up to `.git`); a God Mode
  worktree (`.git` file pointing at `…/worktrees/…`) folds into its parent
  repo. Non-repo cwds (`~`, Temp, scratchpads) → bucket *other*.
- **Weight:** cost via `rates.js` (input, cache write, cache read, output at
  their own rates; unknown model → a visible *unpriced* bucket, never
  guessed). Window = the Claude weekly window from the usage poll
  (`resetsAt − 7 d … now`); fall back to Monday 00:00 if no reset time.
- **Show:** in Telemetry, a stacked bar of the weekly % by project (tinted by
  class work / fun / other / unassigned), the top 5 as rows with
  "≈ 23 % of weekly limit", and the unassigned ones with the 3-way class
  toggle.
- **Perf:** transcripts are big — stream line by line, cache per file by
  `(size, mtime)` → per-day per-project totals in memory; never re-read an
  unchanged file. Off the main thread if a full scan takes > 200 ms.
- **Files:** `src/missionledger.js` (pure aggregation + cache),
  `src/missionprojects.js` (class store), IPC `mission:ledger`,
  `mission:project-class`.
- **Done when:** numbers for the current week match a hand count on one
  project within 1 %, a re-open costs < 50 ms, classes persist.

### W2 — Focus / time per project ⏳

- **Active time:** from the same transcript timestamps — consecutive events
  in one project less than 10 min apart count as continuous work; a gap ends
  a block. Plus commit timestamps (`git log`) for repos without Claude
  sessions.
- **Show:** a day × project heatmap for the week, hours per project,
  **context switches per day** (project changes inside 30 min).
- **Reuse:** W1's scan pass (one reader, two aggregates).

### W3 — Weekly review (Sunday 20:00, email) ⏳

The summary Mati asked for: *"we worked a lot on fun projects, a lot of new
functions/commits went to X, the work project stands on Y, with its to-dos."*

- **Inputs (all local or free, gathered first, then ONE model call):**
  - W1 Claude % per project + W2 hours, split **fun vs work**;
  - per repo in `config/repos.local.json` (+ roots): `git log --since` this
    week — commit count, `feat:` subjects ("new functions"), `fix:` count,
    lines ±;
  - open To-Dos per project (`todo.local.json`);
  - Telemetry flags, GitHub PRs/issues;
  - W4 goals for the week, if set.
- **Output (JSON → rendered card + email):** headline, *Fun* block, *Work*
  block (per work project: status sentence + open to-dos), "where Claude
  went" table, goals scorecard, 3 suggestions for next week.
- **Schedule:** Sunday 20:00 local; on launch, if this ISO week has no review
  and it is past Sunday 20:00 → generate once. History in
  `config/mission-weekly.local.json` (last 12).
- **Email:** Gmail connector `send_message`, **To = Mati's own address only**
  (checked in main before the job; the job's allowed tools = `send_message`
  only; the prompt carries the finished body, so no other recipient is
  possible). Plain text + a short HTML version.
- **Model:** picker (default Haiku; Sonnet recommended for this job).

### W4 — Goals per week ⏳

- Monday (or first open of the week): "3 goals for this week" input in the
  panel, stored with the ISO week.
- The weekly review scores each goal against commits / closed to-dos (the
  model judges with evidence lines: done / partly / not yet).

### W5 — X and Reddit in News + quick search + presets ⏳

- **Setup:** Agent-Reach channels `twitter` (twitter-cli, cookies
  `auth_token` + `ct0`) and `reddit` (rdt-cli session). Use Agent-Reach's own
  `cookie_extract.py` / install flow inside the News venv, as a second
  "Set up X / Reddit" step. **Cookies never cross into LunaCore** — the
  bridge only calls the CLIs.
- **Bridge:** new platforms `twitter` (topic search + account source) and
  `reddit` (subreddit source: hot/new; topic search) in `lunacore_fetch.py`;
  argv with `--` before user text, same caps.
- **Quick search (new UI):** a row of platform buttons — click **X**, type a
  topic, Enter → fetch + Haiku summary with the most important links on top.
  Nothing saved unless you press "★ save as topic".
- **Presets** (one click adds a ready topic/source set; names verified live
  before shipping — the subreddit spellings below are Mati's, not checked):
  - **AI / Claude:** r/Anthropic, r/ClaudeAI, r/claudexplorers, r/LocalLLaMA,
    r/singularity; X topics "Claude Code", "Anthropic".
  - **Honkai Star Rail leaks:** r/honkaistarrailleaks (verify exact name);
    X topic "HSR leaks".
  - **Motorsport / trackday:** r/formula1, r/simracing, r/trackdays;
    X topics "F1", "WEC".
  - **Dev / tools:** r/programming, r/webdev, r/electronjs; HN front page
    RSS; GitHub trending (via Agent-Reach `github` recipes).

### W6 — Morning brief (08:00) ⏳

- One card: today's calendar, mail that needs a call (read-only Gmail query,
  never trash), the last News briefing (or a fresh scan of starred presets),
  open to-dos for today's projects, what was committed yesterday, and
  trackday weather if a motorsport event is ≤ 3 days away.
- 08:00 + catch-up on launch, history last 14, model picker.

### W7 — Trackday weather ⏳

- Calendar events in the *trackday* category (or with a track name) →
  geocode the location (Open-Meteo geocoding, free, no key) → forecast for
  the event hours, 3 days ahead: temp, rain %, wind. Shown next to the event
  in week + month view and in the morning brief. No tokens.

### W8 — Owed fixes from v0.14.0 ⏳

- **pip hash pinning:** `requirements.txt` is version-pinned only; generate
  `--require-hashes` (pip-compile) and give pip a minimal env.
- **Usage 429:** the Claude usage endpoint answered 429 on 2026-10-08, so the
  Telemetry budget block showed "no data". Back off and show the last good
  reading with its age instead of nothing.
- **hnrss.org 502s** — flaky upstream; consider the HN Algolia API as the
  Hacker News topic backend.
- **Google Cloud setup (Mati):** create the Desktop OAuth client, save it as
  `config/google-oauth.local.json`, **publish** the consent screen (testing
  mode expires refresh tokens after 7 days), click Connect.
- **God Mode v2 live run** is still owed (see `FUTURE_PLAN.md`) — it shipped
  in v0.14.0 without one.

---

## Open questions (ask at the start of the matching workstream)

- **W1:** count only this machine's transcripts (the only ones visible)?
  Show $ next to the %, or only %?
- **W3:** which address receives the weekly email (assume the Gmail account
  the connector is signed in to — confirm)? Polish or English? Include cost
  numbers?
- **W5:** dedicated scraping accounts or the main ones for X / Reddit cookies
  (ban risk sits on the account)? How many posts per topic (cost)?
- **W6:** 08:00 fixed, or "first launch after 06:00"? Weekends too?
- **W7:** which tracks are frequent (pre-seed coordinates: Tor Poznań,
  Silesia Ring…)?

## Guardrails (repo rules that bit us — keep them)

- **Untrusted content in prompts:** everything fetched or read from mail is
  data inside a fenced block, angle brackets defused, model output validated
  against the ids we sent; the renderer never receives a URL, only keys
  resolved in main (`openResolved`, throttled).
- **Spawned processes:** `execFile`, argv arrays, `--` before user text,
  minimal env (no API keys), neutral cwd, `python -I -B`.
- **Network from Python:** `public_url()` DNS + per-redirect check in the
  bridge; keep it for every new platform.
- **Tokens:** every model call is a click or an opt-in schedule, shows its
  cost, and is listed under README *Core constraint* exceptions.
- **Repo:** GateGuard wants facts before the first edit of each file; never
  `git add -A`; `src/main.js` often carries another session's hunk;
  comments in English; `pl`/`en` i18n for every string (Polish without
  diacritics); CSS via `--space-*` / `--fs-*` tokens only (theme test);
  widget ids / template ids must be unique (`telemetry` and `w-telemetry`
  were already taken).

## Gotchas learned building v0.14.0

- `python -I` ignores **all** `PYTHON*` env vars → use `-B` to keep `.pyc`
  out of `helpers/`.
- Bilibili's search API returns 412 / non-JSON unless you first hit the home
  page for the anonymous `buvid3` cookie.
- Agent-Reach's channels mostly *check* tools; the fetching is upstream CLIs
  plus its recipe docs (`agent_reach/skill/references/*.md`).
- `RegExp.test(undefined)` tests the string `"undefined"` — type-check ids
  first.
- YouTube channel handles: `@anthropic-ai`, not `@AnthropicAI`.
