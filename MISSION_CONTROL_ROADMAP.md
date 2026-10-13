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

### W1 — Project ledger: Claude % per project ✅ (2026-10-09)

*"Which project ate my weekly limit?"* — Mati's favourite metric.

**Shipped:** Telemetry → *Where Claude went*: stacked bar by class, top 5
with "≈ x % of weekly limit · ~$y", one-click work / fun / other, the PCs
feeding the numbers. Files: `src/missionledger.js` (scan + cache + price),
`src/missionrepokey.js` (cwd → project key, no spawn),
`src/missionledgersync.js` (multi-PC files), `src/missionprojects.js`
(classes + shared folder), `src/missionledgerservice.js` (glue), renderer
`modules/missionledger.js` + `missionledgerview.js` (pure math). IPC
`mission:ledger`, `mission:project-class`, `mission:ledger-pick-dir`,
`mission:ledger-clear-dir`. Verified on real data: hand count of one project
within 0.13 %, full scan 423 ms with a worst event-loop stall of 4 ms (no
worker needed), re-open 25 ms.

**Answers (Mati, 2026-10-09):** show % **and** $; prices for the 5.5 models
are Mati's (`config/rates.json`: Opus 4/20, Sonnet 2/10, Haiku 0.1/0.5);
**all 3 PCs share one Claude account**, so the % is of the combined usage.
Mati wants the ledger on **all 3 PCs** → each PC writes
`<shared folder>/ledger-<hostname>.json` (hour × project × model token
counts only — no paths, no prompts) and merges the others'. Projects are
keyed by normalised git remote so clones at different paths match.

**Pinned projects (Mati, 2026-10-09):** synthara, blade&bullet,
money_printer (= `money_printer_turbo_trader`) and job-autoapply-pl always
show on top with ★, even at 0 % ("no Claude this week"). Stored as
`pinned: [{key, name, folders[]}]` in `mission-projects.local.json`; a
pin's `folders` are aliases, so sessions from a repo folder that no longer
exists on this PC still count for it. No UI to add pins yet (config only).

**Colours:** work = blue `#3d8bff`, fun = pink `#ff5fb4`, other = grey —
fixed per class on `.mc-ledger`, *not* theme accents (see Gotchas).

**Security review (ecc:security-reviewer):** no CRITICAL / HIGH. Fixed:
symlink-safe temp write into the shared folder (random name + `wx`), cap of
500 project keys per peer and 50 projects per report (renderer DoS),
token-count clamp, UNC / relative `cwd` → *other* (no SMB/NTLM probe),
case-insensitive own-file skip. Left open (LOW): peers are unauthenticated
(can inflate numbers), lstat→read TOCTOU, unbounded partial transcript
line, producer/validator regex drift (`_` hosts, `/` in model ids),
worktree `gitdir:` can point anywhere, bidi chars in names, non-atomic
`mission-projects.local.json` write.

**Re-class (2026-10-09):** each row's class chip is a button — click steps
work → fun → other → work (`nextClass` in `missionledgerview.js`), saved via
the existing `mission:project-class`. The non-repo *other* bucket stays a
plain tag.

**Not done yet:** pin / unpin from the UI; re-classing a project outside the
top 5 + pins (it has no row).

### W1b — Move the ledger files between the 3 PCs ⏳ (Mati's setup)

LunaCore only reads/writes a folder; something has to sync it. Mati: no
OneDrive for personal stuff, Google Drive desktop is blocked by company
policy, a work PC sits behind Zscaler.
- **Try first: Syncthing** on all 3 PCs, one shared folder → in LunaCore
  *Share with other PCs…* → pick it.
  **This PC (KT-PC-LLM), 2026-10-09:** the SyncTrayzor *installer* failed for
  Mati; the **portable** build works (v2.2.0, sha512 checked against the
  release's `sha512sum.txt.asc`) → `%LOCALAPPDATA%\SyncTrayzorPortable\
  SyncTrayzorPortable-x64\SyncTrayzor.exe`. Syncthing folder id
  `lunacore-ledger` = `%USERPROFILE%\LunaLedger`, set as LunaCore's shared
  folder. Not paired with the other PCs yet. Zscaler may block its relays / port
  22000 — if so, it fails silently (peer shows a stale "x hours ago").
- **Fallback: Gmail transport** (Gmail works everywhere for Mati): each PC
  mails its ledger JSON to Mati's own address under a label, the others read
  the newest per machine. Needs a Gmail API scope via the existing Google
  OAuth (`src/gcal.js` pattern) — a token-free path, not the claude.ai
  connector (that costs a model call per read). Own small workstream; ask
  before adding the scope.
- Open: should the work / fun / other classes sync too (today per PC)?

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

### W2 — Focus / time per project ✅ (2026-10-13)

**Shipped:** Telemetry → *Focus this week* (under *Where Claude went*, same
`mission:ledger` call, no new IPC): week total, today's hours + switches, a
table of the top 6 projects × Mon–Sun (heat cells, exact time in title +
hidden text), per-day wall-clock hours and switches. Files:
`src/missionfocus.js` (pure: moments → blocks, union, week split),
`src/missioncommits.js` (own commits via `git log`, cached 10 min),
`missionledger.js` `events()`, `missionledgersync.js` `blocks`, renderer
`modules/missionfocus.js` + `missionfocusview.js` (pure).
Verified on real data: cold report 1.5 s (7 repos × 2 gits ≈ 0.7 s), re-open
28 ms; week 10:37 h, LunaCore 7:58 h.

**Answers (Mati, 2026-10-13):** all PCs (blocks ride in each PC's
`ledger-<pc>.json` as `[startMs, endMs, key, name]`, unioned so the same
work seen twice counts once); **+5 min** after a block's last moment (a lone
reply = 5 min); shown **in Telemetry**.

**Rules:** moments of one project < 10 min apart join; a different project
starting ≤ 30 min after the previous block = a switch; "mine" = commit
author email equals that repo's `git config user.email` (no email → repo
skipped); `--all` so commits fetched from another PC still count; the week
is the local Mon–Sun (lines up with W3's Sunday review), not the Claude
window the ledger uses.

**Reviews (ecc:security-reviewer + ecc:typescript-reviewer):** no CRITICAL /
HIGH. Fixed: a cold git scan can no longer stall `mission:ledger` (8 s
deadline, stale cache served while refreshing), `-c core.fsmonitor=false`,
15 s git timeout + a 1 min retry after a failed repo (not 10 min of "no
commits"), switches judged against the block that ends last, own blocks
split into <= 1-day pieces (peers reject > 2 days), Focus table rebuilt only
for a new report / language. Left open (LOW): bidi / zero-width chars in
peer project names, a peer can rename a project (unauthenticated peers, as
W1), a switch across midnight is not counted, mapped network drives in
`repos.local.json` are allowed.

**Original spec:**

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

### W5 — X and Reddit in News + quick search + presets ✅ (2026-10-09; X search fixed 2026-10-13)

**Update 2026-10-13 — X search works again.** twitter-cli 0.8.5 is still the
latest and upstream is dormant (issue #88, 7 unmerged PRs). Root cause: X now
serves the *anonymous* x.com page without the `ondemand.s` bundle that
ClientTransaction init needs (`/home` and `/search` too; a `/home`-only URL
change does not help). The logged-in page still has it, so the `SHIMS["twitter"]`
runtime patch in `lunacore_fetch.py` sends the session cookies for that one
page fetch and clears them after. Live-verified: topic `nvidia` and `@nvidia`
25 posts each. Gotcha when testing: twitter-cli caches the init for 1 h in
`~/.twitter-cli/transaction_cache.json` — delete it to get an honest result.
The notes below are the 2026-10-09 state; presets still use X accounts
(topic presets are a follow-up).


**Live check (2026-10-09, Mati connected both):** Reddit search + all 11
preset subreddits read 23–25 posts each (`HonkaiStarRail_leaks`,
`claudexplorers`, `trackdays`, `electronjs` all exist). X account
timelines 25 posts (`claudeai`, `AnthropicAI`, `HonkaiStarRail`, `F1`,
`FIAWEC`). **X search answers HTTP 404** to twitter-cli 0.8.5 (latest; both
`top` and `latest` tabs; "Failed to init ClientTransaction") → presets use
X *accounts* instead of X topics, the UI says "X search is down", quick
search defaults to Reddit. Re-test X search when twitter-cli updates.
Bug found live: `python -I` drops `PYTHONUTF8`, so the CLI child crashed
on the first emoji (cp1250) → `-X utf8` on the child.

**Shipped:** News → *X and Reddit* block (Install X / Reddit tools →
Connect X / Connect Reddit → Check again), *Quick search* (platform toggle
X / Reddit / YouTube / HN / GitHub, Enter, result + "★ Save as topic"),
*Presets* (AI / Claude, HSR leaks, Motorsport, Dev / tools — merge, no
duplicates), X accounts (`@handle`) and subreddits (`r/name`) as sources,
X / Reddit as topic platforms. 25 posts per X / Reddit section.
- Bridge: `twitter` (search `-t top`, `user-posts`) and `reddit` (`sub -s
  hot`, `search -s top -t week`) in `lunacore_fetch.py`; `configure x|reddit`
  is an interactive console (hidden paste of Cookie-Editor's *Header
  String*) that writes into Agent-Reach's `config.yaml` (X) / rdt-cli's
  `credential.json` (Reddit), then does one tiny live check.
- Main: `setupSocial()` = `pip install -r requirements-social.txt -c
  requirements.txt` (whole tree pinned); `configure()` spawns that console
  detached (own window); IPC `mission:news-setup-social`,
  `mission:news-configure` (`'x'|'reddit'` only), `mission:news-scan` +
  `adhoc {query, platform}` re-validated with `normalizeTopic`.
- Installed into Mati's News venv on this PC (twitter-cli 0.8.5, rdt-cli
  0.4.1, `pip check` clean). The other PCs install with the button.
- Mati's browser is **Opera GX** (not Chrome / Edge as first answered):
  neither CLI knows it, and its cookie DB is locked while it runs (shadow
  copy needs admin) → the paste flow is the only path. Cookie-Editor
  installs in Opera GX from the Chrome Web Store.

**Still to do (needs Mati):** Connect X + Connect Reddit once, then verify
live: the JSON shapes against real data, 25 posts arriving, preset
subreddit names (`HonkaiStarRail_leaks` per search, ~338k members;
`claudexplorers`, `trackdays`, `electronjs` unchecked), the HSR one.
GitHub *trending* has no stable endpoint — the Dev preset uses a GitHub
topic search "trending" instead.

**Security review (ecc:security-reviewer):** no CRITICAL. Fixed both HIGH:
twitter-cli (on a rejected login) and rdt-cli (on a 7-day-old one, even via
`uv run --with browser-cookie3`, then overwriting `credential.json`) fall
back to reading **other browsers' cookie stores** → each CLI now runs
through a `python -I -c` shim that stubs `extract_from_browser` /
`extract_browser_credential`, with an empty `APPDATA` / `LOCALAPPDATA` and
`UV_OFFLINE=1`; verified live (no `credential.json` appeared). Fixed MEDIUM:
whole dependency tree pinned, symlink check before rdt's writer, 10 s gap
between quick searches (main), max 12 X / Reddit items per scan, 5 s
cooldown on the configure console. Fixed LOW: `fullmatch` regexes, tighter
permalink, no CLI stderr echoed, configure errors caught. Left open: pip
hashes (with W8), orphaned CLI child on a scan timeout (≤ 30 s).

**Answers (Mati, 2026-10-09):** cookies from his **main** X / Reddit
accounts (he accepts the ban risk); **25 posts** per topic / source; logged
in on **Opera GX** (said Chrome / Edge first).

**Found live (2026-10-09), before any install:**
- Reddit has **no anonymous path**: `hot.rss` answered 200 once, then every
  request 429 (even 6 s apart), a sub 403, `.json` 403. Agent-Reach's
  `channels/reddit.py` says the same → logged-in **rdt-cli** is required.
- Both upstream CLIs **fall back to reading browser cookies on their own**
  (twitter-cli when the env pair is missing *or invalid*; `rdt login` /
  7-day refresh). Chrome 127+ on Windows encrypts cookies app-bound, so that
  fallback likely fails anyway → plan for the **Cookie-Editor paste**.
- Keeping cookies out of LunaCore: open a console running Agent-Reach's
  `configure twitter-cookies` (hidden `getpass` prompt → its own
  `~/.agent-reach/config.yaml`); a matching bridge `configure-reddit`
  writes `~/.config/rdt-cli/credential.json`. The bridge passes the X pair
  to `twitter` as child env only; Node never sees a cookie.
- Neither README documents its JSON fields (`SCHEMA.md`); rdt `--json` is an
  `{ok, schema_version, data, error}` envelope; non-TTY output defaults to
  YAML → always pass `--json`. twitter count flag is `--max`, not `-n`.
- **Blocked:** installing `twitter-cli` / `rdt-cli` (PyPI / pinned git) for
  the live probe needs Mati's go-ahead (auto-mode refused third-party code).

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

### W7 — Trackday weather ✅ (2026-10-13)

- Calendar events in the *trackday* category (or with a track name) →
  geocode the location (Open-Meteo geocoding, free, no key) → forecast for
  the event hours, 3 days ahead: temp, rain %, wind. Shown next to the event
  in week + month view and in the morning brief. No tokens.

**Shipped:** `src/missionweather.js` + `mission:cal-weather`. A trackday =
category `motorsport`, "trackday"/"track day" in the title, or a known track
name in title/location (`calendar.weather` in `config/missioncontrol.json`:
10 pre-seeded tracks — Tor Poznan, Silesia Ring, Slovakia Ring, Brno, Most,
Hungaroring, Red Bull Ring, Sachsenring, Lausitzring, Nurburgring; add your
own in `missioncontrol.local.json`). Unknown places are geocoded per comma
part of the location ("Autodrom X, Radom" → Radom); only the location text
leaves the PC, never the title. Horizon **7 days** (not 3 — Open-Meteo is
fine that far for planning). All-day events are forecast 08–18, max 3 days.
Badge `12–17°C · deszcz 40% · wiatr 25 km/h` (amber at rain ≥ 50%) under the
event, week + month day list. Main computes it from the events it listed
itself, never from renderer input. Forecast cache 1 h per place.
Morning brief part waits for W6.

**Update 2026-10-13 (Mati's feedback):** weather is no longer trackday-only —
**every event with a place** within **14 days** gets it (work in Katowice
too). Known track in title/location first (now 12: + Tor Kielce, Autodrom
Jastrzab; "Silesia" alone matches Silesia Ring — Mati's events are often
title-only, no location). Otherwise geocode with `language=pl` (Polish names
like "Warszawa" only match in pl), 5 results, most populous wins (the first
hit for "Warszawa" in en was a US historic district); if no comma part is a
place, its single words are tried and the biggest town wins ("Hala Expo
Kielce" → Kielce). Online meetings (Teams/Zoom/Meet/links) skipped. Over 7
days out the badge says "≈" (long range, a trend). Open-Meteo stops at 16
days, so an event 18 days out has no weather until it is 14 days out.
Refresh: on every Mission Control open and hourly while open (main caches
1 h). The `category` setting was dropped from `calendar.weather`.

**Focus redesign (same day):** three headline tiles (this week / today /
switches today), each day cell prints its time on the heat tile (dark text
on bright levels), today's column lit, a share bar under each project, the
method note folded under "How is this counted?".

**Hourly + real-calendar fixes (same day):** the weather line is its own
row under the event (a button: never nested in the clickable event row) and
unfolds an hour-by-hour table - hour, temp, rain chance, rain **mm**, wind,
and a dry / may rain / wet guess per hour (`missionweatherview.js
surfaceOf`: mm decides first - >= 0.5 mm wet, 0.1-0.5 maybe unless >= 70 %;
chance alone only when mm is missing). Rain mm added to the forecast fetch;
max 48 hour rows. Found on Mati's real calendar: (1) the work address
"..., Stalowa 1, 40-610 Katowice, Polska" resolved to "Polska" (country
centre) - postcodes are now cut off with the town kept, and country /
region hits (GeoNames PCL*, ADM1/2, CONT, RGN) are rejected; (2) "Trackday
Kielce" at "Kielce" got the city - tracks have optional `towns`, matched only
for trackday events (title/calendar says trackday, or `calendar.weather.
category` = motorsport). Verified on the real agenda: work -> Katowice,
Trackday Kielce -> Tor Kielce. Gotcha: a Python heredoc turned "\b" in a JS
regex into a backspace char - write such patches as script files.

**Quick add picks a calendar (same day, Mati's ask):** create no longer
runs a model + MCP create_event on the primary calendar - it POSTs through
the Calendar API (`gcal.createEvent`, free, instant) into the calendar
chosen in the draft. `mission:cal-calendars` lists the writable calendars
as opaque keys (sha256 of the id: calendar ids are email addresses and never
reach the renderer). Default: a trackday (motorsport category or "trackday"
in the title) goes to the calendar named like "Trackdays", else the last one
used (localStorage), else primary; changing the category re-picks until the
calendar is chosen by hand. Creates are rate-limited like edits (1/s).
Needs the calendar.events scope like editing (one reconnect). The model
still parses the natural-language text into the draft.

### W7b — Click-to-edit calendar events ✅ (2026-10-13, Mati's ask)

- Click an event you own (week list or month day list) → inline card: title,
  start, end, location → Save PATCHes Google directly (`gcal.updateEvent`,
  `mission:cal-update`) — no model, instant, free. Moving the start keeps the
  length (like Google). All-day ↔ timed switch and category are not editable.
- **OAuth scope widened** to `calendar.readonly` + `calendar.events`. Old
  tokens lack the second → first Save answers `gcal-scope` and the Connect
  button reappears: **Mati reconnects once**.
- Editable = listed by main from an owner/writer calendar AND you are the
  organizer (or guests may modify). The renderer sends an event id, never a
  calendar id. Invites from others stay read-only.
- Follow-up idea: quick add could also use the API now (free, no Haiku).

**Reviews (security + JS):** no CRITICAL/HIGH security issue. Fixed: edits
rate-limited (1/s, `rate-limited`), an id seen in two calendars is not
editable, the edit map is cleared on disconnect, geocoding never sends a
location part with digits (street / postcode), forecasts cached as trimmed
arrays, "no hit" geocodes retried after 1 h, soonest trackdays first under
the 10-event cap, whole-word track names. Renderer: the open card's DOM
survives re-renders (refresh / weather / month load keep unsaved input), the
card shows only in the visible view, a save updates every cached month the
event touches and the week list only if it was there, newest weather call
wins. **Open LOWs:** PATCH sends no `timeZone` (offset-only times; a
hand-crafted offsetless time gets Google's 400 → generic error); no renderer
tests for the card; `missioncalendar.js` (596), `gcal.js` (556) and
`missioncontrolipc.js` (536) are now past 500 lines — extract next time
they grow. Not verified live: a real Save (needs Mati's reconnect); the card
itself was smoke-tested with a fake event in a second instance.

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

- ~~**W1:**~~ answered 2026-10-09 (see W1).
- **W3:** which address receives the weekly email (assume the Gmail account
  the connector is signed in to — confirm)? Polish or English? Include cost
  numbers?
- ~~**W5:**~~ answered 2026-10-09 (see W5).
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

## Gotchas learned building W1 (ledger)

- **Transcripts repeat assistant messages:** one `message.id` is written on
  several lines (586 of 946 ids in one file), and their `usage` can differ
  (28 cases in a week) → dedupe by id, keep the **max per field**. Summing
  lines roughly doubles the count.
- Subagent transcripts live one level deeper:
  `<project>/<session>/subagents/agent-*.jsonl` — easy to miss, real spend.
- `"model":"<synthetic>"` lines carry no real usage — skip them.
- Pre-filter lines with `Buffer.indexOf('"assistant"')` before `JSON.parse`;
  most bytes are tool results. Read in 1 MB chunks and keep the byte offset of
  the last complete line → re-open only reads the appended tail.
- Async chunked reads yield to the event loop; measure the **stall**, not the
  total: 423 ms total was only 4 ms worst stall, so no worker thread.
- `config/rates.json` matches by longest id prefix: without explicit
  `claude-*-5-5` rows, Opus/Sonnet 5.5 silently used the 5.0 prices and
  Haiku 5.5 was unpriced.
- Dev builds keep `config/*.local.json` in the repo's `config/` — a second
  app instance (CDP smoke test) shares it with the one Mati is running.
- Port 9333 can be held by another tool; pick a free CDP port and a separate
  `--user-data-dir` for the test instance.
- `.port-btn` is a fixed 22 px icon button; text buttons in Mission Control
  use `pad-send mc-connect`.
- **Theme accents are not semantic colours:** themes remap `--neon-cyan` /
  `--neon-magenta` (to orange, green…), so work vs fun looked alike for
  Mati. Data classes get fixed colours of their own.
- Transcripts mix `C:\…` and Git Bash `/c/…` cwds for the same repo;
  `path.isAbsolute('/c/x')` is true on Windows but means `C:\c\x`.
- Don't patch JS regexes / escapes through a Python or bash heredoc: `\\`
  and `\u0000` got turned into real NUL/DEL bytes and single backslashes
  (silently weakening a UNC check). Use the Edit tool or `String.raw`.

## Gotchas learned building W2 (focus)

- A transcript `message.id` repeats over several lines a few seconds apart —
  take the **first** line's timestamp as the reply's moment.
- Day bounds must come from `new Date(y, m, d + i)`, not `+ 24 h`, or a DST
  change shifts every later day by an hour.
- A day's hours are the **union** across projects (parallel sessions count
  once); per-project hours still add up to more than the day — say so in the UI.
- `cat > file` with no heredoc in the Bash tool waits on stdin until the
  timeout and leaves an empty file — the "hang" was the probe, not the code.

## Gotchas learned building W5 (X / Reddit)

- **Reddit has no anonymous path any more:** `hot.rss` 200 once, then 429
  on every request; `.json` 403. rdt-cli without a login → `forbidden`.
- **Both CLIs read other browsers' cookies on their own** (twitter-cli on a
  rejected login, rdt-cli after 7 days — via `uv run --with
  browser-cookie3`, then it overwrites its credential file). Stub the
  fallbacks (`python -I -c` shim) — env tricks alone are not enough.
- **`python -I` ignores `PYTHONUTF8`** — a child started with `-I` needs
  its own `-X utf8`, or Windows cp1250 stdout dies on the first emoji (a
  feed without emoji passes, so a single test can look fine).
- Test a batch, not one feed: r/programming worked alone while 10 other
  subreddits failed for the reason above.
- Both CLIs print **YAML when stdout is not a TTY** — always pass `--json`;
  both answer `{ok, schema_version, data, error}`. twitter's count flag is
  `-n/--max`; rdt `--compact` gives flat post dicts.
- browser_cookie3's Opera GX path is stale (`Default\Network\Cookies` now),
  and a running Chromium locks the DB (shadow copy needs admin).
- `pip install` of a fresh tree once failed with a hash mismatch on a
  corrupted download — retry with `--no-cache-dir` before suspecting PyPI.
- Windows `spawn(..., {detached: true, stdio: 'ignore'})` gives the child
  its own console window — how the paste prompt stays out of the app.
- A killed test Electron can leave its CDP port held by a dead PID — pick a
  new port rather than waiting.
- The classifier blocks reading browser cookie stores ("credential
  exploration") — by design; the paste flow is the answer, not a bypass.
