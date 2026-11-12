# Luna Core Memory: a RAG-style memory across all projects

Status: **phases 1 to 5 built** (2026-11-11). Written 2026-11-10. Section 0 holds the
decisions made so far; section 11 lists the questions they answer.

## 0. Decisions so far (2026-11-11)

Mati asked for a recommendation on the three shaping questions. These are now the working
decisions. They override anything below that says otherwise.

1. **Truth lives in markdown files in one private git repo.** One folder per project plus
   `global/`. Central, not inside each project, because LunaCore workers run in worktrees
   and would scatter in-repo memory across branches. No Supabase for now.
2. **Per project, everything reachable on demand.** Every session loads a generated
   project card (about 1,500 to 2,000 tokens). The rest of that project's memory, and
   every other project's, is searched when needed, for example when Mati says "same
   mechanic as in SteelQuote".
3. **The card carries a short architecture map** (what lives where). This covers what
   Mati expected from `codebase-memory-mcp`. That tool is a code graph, not a memory, and
   is not loaded per session. It may return later as an on-demand tool for large repos,
   without a reminder hook, if the map proves too thin.
4. **Capture is automatic and happens outside the working session.** A session-end hook
   gives the transcript to a small model in the background. Nothing is added to CLAUDE.md
   telling Luna to capture while working, and Mati is not asked at the end of a session.
5. **Two trust levels.** `observed` memories are saved automatically, are searchable, and
   are always returned with source, date and a "not verified" label. Only `confirmed`
   memories go into the project card. A memory becomes confirmed when Mati approves it in
   the HUD inbox or when it is used later and holds up. Anything that contradicts or
   replaces a confirmed memory always waits for Mati.
6. **Assumed unless Mati says otherwise:** LunaCore first, local embeddings, memories
   written in English.

### Revised 2026-11-11: sync through LunaCore's cloud sync, not a git repo

Mati wants the memory on every PC that runs LunaCore, through the sync that already
exists. This replaces decision 1 and the "memory repo" in sections 5 and 10.

7. **Transport is the existing cloud sync** (`src/cloudsync.js`, table `sync_units`). Add
   a fourth scope, `memory`, beside `life`, `todos` and `config`. One memory is one unit:
   key `<project>/<id>`, value the record from section 4. Newest-wins per unit and
   tombstones for deletes already work that way. Needs one migration (the scope check in
   `sync_units` and `push_units`) and unit builders in `cloudrows.js`.
8. **Each PC keeps a local mirror as markdown files** in LunaCore's data directory, and
   builds its own search index from them. The files stay readable and editable; an edit is
   picked up and pushed like any other local change.
9. **Vectors are never synced.** Each PC embeds locally. A PC with no embedding model
   running falls back to keyword search and still works.
10. **A project is identified by its normalized git remote URL,** not its path. The two
    PCs have different user folders, so a path cannot be the key.
11. **The inbox syncs too.** A candidate captured on one PC can be approved on the other.
12. **History and undo.** Git gave these for free and cloud sync does not. A superseded or
    deleted memory is kept as a tombstoned record for a retention period, and the HUD gets
    an "export all to a folder" action for backups.
13. **Memory is opt-in per project.** Nothing is captured or loaded for a project until it
    is switched on. Company repositories stay exactly as they are until Mati opts one in.
    No separate store for them.
14. **The secret scanner runs before a push, not only before saving,** because a memory
    now leaves the machine.

15. **Show sync health per PC.** In October 2026 the second PC was not publishing at all
    and nothing said so. The same failure would leave one PC working from stale memory
    without any sign of it. The HUD shows, per machine, when it last pushed and last
    pulled the `memory` scope, and flags a machine that has been silent too long. The
    project card states its own age when the last pull is old.
16. **Start with the import.** The 11 existing LunaCore auto-memory entries live only on
    the work PC. Importing them into the synced scope is the first thing built: it gives
    the other PC real content on day one and exercises the whole path (write, push, pull,
    mirror, search) before any capture logic exists.
17. **Capture can run on either PC, so duplicates are checked after a pull,** not only at
    capture time. Two PCs can propose the same memory from different sessions; the inbox
    merges near-duplicates before showing them.
18. **Keep each memory small.** One fact per unit, a few hundred words at most. Units are
    synced whole and newest-wins, so a large multi-fact memory edited on two PCs would
    lose one side's edit.

Phase 1 becomes: migration and `memory` scope, local mirror, import of the 11 auto-memory
entries, CLI search, the sync-health line. Phase 6 (second PC) disappears: it works from
phase 1.

Where the sections below still say "memory repo", "git pull" or "commit", read "the
synced `memory` scope and its local mirror". Questions 1, 2, 7 and 9 in section 11 are
answered by the decisions above.

### Build decisions, 2026-11-11 (phase 1 started on `feat/memory-phase1`)

Answered by Mati:

19. **Phase 1 search is keyword only** (SQLite FTS5 through Node's built-in `node:sqlite`,
    which works in Electron 43). Embeddings come in phase 2, chosen by recall on the golden
    set, stored as blobs and compared in plain JS. No native package.
20. **The per-project switch is synced.** Unit `memory-on:<project>` in the `config` scope,
    so switching a project on applies on every PC.
21. **Claude auto-memory stays as it is until the project card ships.** After phase 3 it
    becomes a capture source only and its index is no longer loaded.
22. **Existing docs are indexed later, local only.** Not in phase 1. They will be reference
    chunks built on each PC from the repo, never synced, ranked below memories.

Chosen while building:

23. **A project is `host/owner/repo`** (the key `src/missionrepokey.js` already produces,
    without its `git:` prefix). The unit key is `<project>/<id>`; `global/<id>` for what
    holds everywhere. A repository without an origin remote has no project memory.
24. **Mirror layout:** `<config>/memory/global/<id>.md` and
    `<config>/memory/projects/<host>/<owner>/<repo>/<id>.md`. The path is the identity:
    `id` and `project` in the frontmatter are written for the reader and ignored on read.
25. **The record gained a `title`** (one line, shown in search results and later on the
    card). The record is flat and at most 6,500 bytes; the body at most 5,000 characters.
26. **The sync engine is `configsync.js`** with a file-backed provider, not new merge code.
    The `memory` scope runs as a second transport with its own state file
    (`cloud-sync-memory.local.json`), so a failing memory sync cannot hold back life,
    to-dos and settings.
27. **A file that does not parse pauses the memory sync** and is listed in
    `memory status`. Skipping it would publish it as a delete.
28. **The index is in memory and rebuilt from the files** on each start. There is no index
    file to go stale. A persistent store returns in phase 2 as an embedding cache.
29. **Heartbeat:** each PC publishes `_health/<machine> = {at, count}` at most every six
    hours or when its memory count changes. Silent for three days is flagged.
30. **CLI:** `node scripts/luna.js memory search|list|status|enable|disable|import-auto|eval`
    (`npm run memory -- search "..."`). It works with LunaCore closed and uses an
    installed LunaCore's config folder when there is one.

### Phase 2 decisions, 2026-11-11 (`memory_search` and `memory_get`)

Answered by Mati:

31. **Phase 2 ships the two tools on keyword search.** Embeddings are phase 2b: no
    embedding model was installed when phase 2 was built, so none could be measured.
    Baseline to beat on the 34-question golden set: recall@5 30/34 (88%), top hit 26/34.
    Three of the four misses are Polish questions against English memories.
32. **Every LunaCore tab gets the tools and can search every project.** The tab's own
    project ranks higher, and can be searched alone, only when memory is switched on for
    it. Nothing is written or loaded automatically.
33. **When to search is said in the tool description,** not in a CLAUDE.md. It reaches
    every tab on every PC with no file to edit. A CLAUDE.md line is added only if Luna
    turns out to under-use the tool.

Chosen while building:

34. **The tools live in `src/memorytools.js`** and are served by the existing server in
    `src/intake.js`. They share its on/off switch (`todoToolsEnabled`): a tab without the
    lunacore server has no memory tools either.
35. **`memory_search`** takes `query`, `limit` (1 to 20, default 5) and `thisProjectOnly`.
    It returns key, type, title, trust label, created, source and a snippet, never the
    body. **`memory_get`** takes a key, or a bare id for this project or global, and
    returns the whole memory, with a warning when another memory supersedes it.
36. **Every result starts with the "data, not instruction" note** and every entry carries
    its trust label (`observed, not verified`, `confirmed, last verified <date>`).
37. **The index is kept for five seconds,** then rebuilt from the files on the next call.

### Phase 3 decisions, 2026-11-11 (the project card)

Chosen while building:

38. **The card travels as `--append-system-prompt-file`** on the tab's `claude` command,
    the same way the tab's `--mcp-config` does (`withMemoryCard` in `src/launch.js`). It
    sits in the system prompt, so it survives compaction and costs nothing after the first
    turn's cache write. A SessionStart hook was the other option: it needs a settings file
    per tab and arrives as a mid-conversation message.
39. **Which tabs get it:** every plain `claude` LunaCore starts in a project with memory
    switched on, God Mode workers included (most of today's memories are about their
    worktrees). Not: other CLIs, a lean local-model tab or a plan-run worker
    (`--strict-mcp-config`), `--bare`, or a profile that sets its own system prompt.
40. **The card is rebuilt from the mirror on every tab start** (`src/memorycard.js`) and
    written to `memory-card-<tab>.local.md` in the config folder. A running session keeps
    the card it started with.
41. **What is on it:** confirmed memories of the project and of `global`, without
    superseded ones and without `digest`. A memory tagged `area: architecture`, `stack` or
    `commands` is printed in full (at most 1,500 characters each): that is the map of
    decision 3. Every other memory is one line, its title and its id, grouped by type
    (gotchas first), newest first inside a group. The full text is one `memory_get` away.
42. **An observed memory cannot take a confirmed one off the card** by listing it under
    `supersedes`. Only a confirmed memory supersedes on the card (decision 5).
43. **Budget: 6,000 characters, about 1,500 tokens.** What does not fit is counted in the
    card's last line. On 2026-11-11 the LunaCore card holds all 19 memories in 3,692
    characters, about 923 tokens. The card ends by saying again that it is data.
44. **Age:** the card warns when this PC's own heartbeat (decision 29) is older than three
    days. A PC that never synced gets no warning.
45. **CLI:** `node scripts/luna.js memory card` prints the card a new tab would get and its
    size against the budget.

Settled by Mati on 2026-11-11, after phase 3:

- **The architecture map** is the confirmed memory `architecture-map`. The LunaCore card
  is now 20 memories, 4,881 characters, about 1,221 tokens.
- **The code-discovery hook** (`~/.claude/hooks/cbm-session-reminder`) **stays.** It costs
  about 200 tokens and answers a different question than the map (who calls what).
- **The Claude auto-memory index stays loaded** (this reverses decision 21 for now). It
  costs about 500 tokens, and auto-memory is still the only way a session saves a new
  fact. Revisit once capture (phase 4) exists.

Still open:

- **The with/without comparison** from section 9 needs a week of real sessions.
- **A "where we stopped" note** for phase 4: one short note per project written at
  session end (what was being built, what is done, what is left) and shown on the card,
  so a new session can continue half-done work without an explanation. Proposed, not
  yet decided.
- **Feature notes**, also for phase 4: when a feature ships, one note says what it does,
  which files hold it and what to watch for when porting it. This is what makes "use
  the same logic in another app" work. Proposed, not yet decided.

### Phase 4 decisions, 2026-11-11 (capture and the inbox)

Chosen while building:

46. **There is no separate inbox store.** A memory that is not `confirmed` is an inbox
    entry. Capture saves its candidates as `observed` memories in the mirror, so they are
    searchable at once, they sync like every other memory, and a candidate captured on
    one PC can be approved on the other (decisions 5 and 11). Section 4's `inbox/` folder
    is not built.
47. **Capture runs in LunaCore's main process, not in a Claude Code hook**
    (`src/memorycapture.js`). A hook needs a settings file per tab and dies with the
    session. LunaCore knows every tab's transcript already. A ledger
    (`memory-capture.local.json`) keeps, per transcript, the byte offset read so far.
48. **When a session is captured:** one minute after its tab closed, or after 20 minutes
    without a new line in a tab that stays open. Only the text after the offset is read,
    so a long or resumed session is captured piece by piece and never twice. Sessions
    open when LunaCore quits are captured on the next start. At most three model calls
    per five-minute tick.
49. **Only the user's own tabs, only projects with memory switched on.** God Mode worker
    tabs are not captured: one run starts many short sessions. Revisit if their lessons
    turn out to be missing.
50. **The model reads a digest, not the transcript** (`src/memorydigest.js`): what the
    user typed, what the assistant answered, and one line per tool call. Tool results
    are never copied (section 7, external text). The one exception is the first 300
    characters of a failed local call (shell, file read or edit). At most 60,000
    characters; a longer piece keeps its start and its end. A piece under 600 characters
    costs no model call.
51. **The extractor is `claude -p --model haiku`** with no tools, no settings and no MCP
    servers (`missionrunner.runJob`, lean). The prompt goes in through stdin because it
    does not fit a Windows command line. Measured on one real session of 2026-11-10:
    22 seconds, 5 candidates.
52. **Filter** (`src/memoryextract.js`): each candidate is rebuilt by `checkRecord`; the
    model cannot set id, project, source or confidence. Dropped: a `digest`, a secret,
    a near-duplicate of an existing memory or of an earlier candidate. At most five per
    piece. The digest is scrubbed for secrets before it is sent.
53. **A proposed supersede does nothing until approved.** Only a `confirmed` memory
    takes another one out of search and off the card (this extends decision 42 to the
    index and to `memory_get`).
54. **Approve, edit, reject** (`src/memoryinbox.js`). Approve sets `confirmed` and
    `last_verified`. Reject deletes the file, which syncs as a tombstone. Edit changes
    title, text, type or area and keeps the entry waiting. Near-duplicates among the
    waiting entries are shown as one; a decision on it removes the others (decision 17).
55. **In the HUD** the notification hub shows "N memories to review" (it counts on the
    hub's badge and has its own switch in Settings). It opens the inbox window
    (`src/renderer/modules/memoryinbox.js`).
56. **A full inbox pauses capture.** 40 entries waiting for a project: no more model
    calls for it until some are reviewed.
57. **CLI:** `memory inbox`, `memory approve <id>`, `memory reject <id>`, and
    `memory capture <transcript.jsonl> [--save]`, which shows what the extractor keeps
    from one transcript and writes nothing without `--save`.
58. **Feature notes are in** as a trial: when a session finished a feature the extractor
    may write one `project-fact` with `area: feature`. They go through the inbox like
    everything else.

59. **Capture only opens files under `~/.claude/projects`.** The ledger is a file anyone
    can edit, so a path in it is checked before it is read. A tab's transcript is noted
    at every turn end, so the session before a `/clear` is not lost.
60. **A captured memory is never global until Mati clicks "Make global"** (security
    review fix, 2026-11-11). `candidatesFrom` files every candidate under the session's
    project; when the model said `global`, the record's `source` ends in
    `, suggested global` (no new field: `checkRecord` drops unknown ones). The inbox
    shows that as a note and offers "Make global" (`makeGlobal` in `src/memoryinbox.js`,
    IPC `memory:make-global`) on any waiting project entry: the same record moves to
    `global` with the same id (`<id>-2` ... `<id>-9` when taken), loses its
    `supersedes` and the note, and stays waiting. A global entry carries the note
    "Global: approving puts this on every project's card". Folded duplicates stay put.
61. **The inbox says when the captured session read outside content** (security review
    fix, 2026-11-11). `digestTranscript` counts the tool calls named `WebFetch`,
    `WebSearch`, `Agent`, `Task` or `mcp__*` (not `mcp__lunacore__*`); `extractPiece`
    appends `, read <n> outside source(s)` to the `source` before the extractor's
    `, suggested global` note, which always comes last. `listInbox` reads the number
    back as `outside`, and the inbox and `luna memory inbox` ask Mati to check the text
    before approving.

Found by the security review of 2026-11-11 and left open for Mati:

- **Fixed 2026-11-11:** `memory_search` returns an unreviewed memory without its snippet (`unreviewed: true`), and `memory_get` adds a warning not to act on its text unchecked.
- **Fixed 2026-11-11:** the secret scanner (`src/hostscrub.js`) now masks, in free text, Stripe `sk_`/`rk_` live and test keys and `pk_live_`, JWTs (Supabase keys), `Bearer` tokens (the word stays), Slack `xoxb-`/`xoxp-`/`xoxa-`/`xoxr-`/`xoxs-`, Google `AIza`, npm `npm_`, GitHub `github_pat_` and `ghp_`/`gho_`/`ghu_`/`ghs_`/`ghr_`, and the password in `scheme://user:password@host`.
- **Fixed 2026-11-11:** capture files every memory under its project and marks a `global` suggestion in `source`; only the inbox's "Make global" moves it (decision 60).
- **Fixed 2026-11-11:** capture counts the web, subagent and foreign MCP calls of the session into `source`, and the inbox shows a note to check the text (decision 61).

These four are queued as to-do cards for a God Mode run (2026-11-11): unapproved
memories come back from search without their text, the scanner learns the missing token
shapes, a captured memory becomes global only by a "Make global" click, and the inbox
shows when the session read outside content. Each card replaces its bullet above when
it lands.

Not built in phase 4:

- **`memory_propose`** (section 7 step 5, "remember this" mid-session). Claude
  auto-memory still does that job and its index stays loaded (see above).
- **The "where we stopped" note.** Still proposed, not decided.
- **Auto-accept for low-risk types** (question 4). Everything is approved by hand until
  the approval rate is known.

To judge after a week (section 9, inbox quality): the share of candidates approved. Under
about a third means the extractor prompt is wrong.

### Improvements proposed after phase 4 (2026-11-11)

Recommended by Luna, in the order she would build them. None is decided yet.

1. **(Built in phase 5.) Measure for a week before adding anything.** Log per capture what was proposed,
   approved, edited and rejected, per type. Under about a third approved means the
   extractor prompt is wrong, and nothing below is worth building until that number is
   known. The read side (how often a memory is searched or opened) comes from the same
   log.
2. **(Built in phase 5.) Feed rejections back to the extractor.** The titles of the last 20 rejected
   candidates go into the prompt as "not wanted". A rejected file is deleted today, so
   this needs a small local list of rejected titles.
3. **The "where we stopped" note.** One short note per project, overwritten at each
   capture: what was being built, what is done, what is left. It is shown on the card
   and needs no approval, because it is a status that decays, not a fact.
4. **Keyboard review in the inbox.** `A` approve, `R` reject, `E` edit, arrows to move.
5. **Approve from the phone.** The inbox already syncs; the phone app needs the list and
   two buttons.
6. **Embeddings (phase 2b).** Three of the four misses on the golden set are Polish
   questions against English memories. It matters more as captured memories pile up.
7. **Capture a God Mode run once, from its run report,** not per worker tab (decision
   49). One model call per run, and workers meet exactly the gotchas worth keeping.
8. **Auto-accept low-risk types** once a type's approval rate has stayed above about
   90% for a few weeks (question 4).

Items 1 and 2 were built in phase 5 (decisions 62 to 64 below). Items 3 to 8 are separate
and can be taken in any order.

### Phase 5 decisions, 2026-11-11 (keeping memories true, and the log)

Numbers 60 and 61 are kept for the two queued inbox cards ("Make global" and the
outside-content note).

Chosen while building:

62. **One local log per PC** (`src/memorylog.js`, `memory-log.local.jsonl` in the config
    folder, one JSON object per line). It records each capture (what was kept, what the
    filter dropped and why), each candidate proposed, each inbox decision (approved,
    edited, rejected), each `memory_search` and `memory_get`, and each report on a
    memory. Past 1 MB the older half is dropped. Every line is rebuilt field by field
    when it is read.
63. **The log is not synced.** It says what happened on this PC. A candidate captured on
    one PC and approved on the other is "proposed" here and "approved" there, so **the
    approval rate is approved over (approved + rejected)**, which is right on either PC.
    It is shown per type, and "approved after an edit" is counted apart.
64. **Rejected titles go back to the extractor.** The last 20 titles rejected for the
    project (and for `global`) are listed in the prompt as "not wanted: do not propose
    them or their kind again". Only the title of a rejected candidate is kept, in the
    log; the file is still deleted. A rejection made on the other PC is not known here.
65. **Stale:** a confirmed `gotcha` or `how-to` that nobody has verified for 180 days.
    It is still returned and stays on the card, ranks at 0.8 in search, and its trust
    label reads `confirmed, not verified since <date>`.
66. **Decay:** a `digest` older than 60 days is left out of search. The file stays.
67. **Anchors are files only.** A memory's body is read for repository paths in
    backticks (`src/memorycapture.js`): at least one folder and a file extension, and
    the top folder must exist in the repository. A bare file name, a `*.local.*` file,
    a path under `node_modules` or one that starts with a domain is not an anchor.
    Functions and flags are not checked: that needs a search of the code per memory.
    The check runs only on a PC where LunaCore knows the repository's folder (one of
    its projects or an open tab); `global` memories are not checked.
68. **`memory_verify`**, a third tool beside `memory_search` and `memory_get`. A session
    reports how a memory it relied on turned out. `holds` moves `last_verified` of a
    confirmed memory to today, at most once in 7 days (each move is a sync push).
    `wrong` needs a note and puts the memory on the review list; the memory itself is
    not changed. **A session cannot confirm, edit or delete a memory**, and its own
    `holds` does not settle a report: only Mati does. This narrows decision 5: "used
    later and holds up" refreshes a confirmed memory, it does not confirm an observed
    one, because that would let a session put text on the project card unread.
69. **The review list** (`src/memoryreview.js`) is every confirmed, not superseded
    memory with a flag: reported wrong, names a file that is gone, or stale, in that
    order. Per entry: **Still true** (`last_verified` becomes today, the flags clear,
    and the files missing at that moment are not flagged again) or **Retire** (asked
    twice; the file is deleted and the delete syncs as a tombstone).
70. **In the HUD** the memory window has two tabs, "To approve" and "To check". It
    opens on "To check" when nothing waits for approval. The hub item counts both. The
    footer shows the last 7 days: proposed, approved, rejected and the rate.
71. **CLI:** `memory review`, `memory verify <id>`, `memory retire <id>` and
    `memory stats [--days n] [--all]` (approval rate per type, what the filter
    dropped, and which memories were found and opened most).

From the security and code review of phase 5 (2026-11-11), fixed before the commit:

72. **The log trims reads first.** Every `memory_search` and `memory_get` writes a line,
    so a session searching in a loop could have pushed a report or a decision out of
    the log. Past 1 MB the older half of the read lines goes first; reports and
    decisions go only when they alone are too big.
73. **One open report per memory.** A second `wrong` on a memory that is already
    reported adds nothing. A report that cannot be written is answered as a failure,
    not as "flagged".
74. **The HUD can settle only what is on the review list.** `memory:verify` and
    `memory:retire` refuse a confirmed memory that has no flag, so those channels are
    no way to delete or re-date an arbitrary memory. The CLI has no such limit.
75. **A rejected title is quoted in the extractor prompt,** and a rejected candidate
    takes its open report with it.

Known limits, accepted for now:

- **A session's `holds` clears the stale flag.** That is what it is for, but a session
  steered by text it read could keep a wrong gotcha looking fresh. A report of `wrong`
  is not affected by it. If this turns out to matter: a separate "verified by a
  session" date that does not clear the flag.
- **The anchor check looks at the main checkout.** A worktree is folded into its
  repository, so a file that exists only on a worktree's branch is flagged as gone.
- **A log that cannot be read counts as empty** (the error goes to the console). Until
  it can be read again, reports are missing from the review list.
- **The hub count reads the mirror and the log once a minute.** Fine for hundreds of
  memories; cache it if the mirror grows into the thousands.

- **Reports and accepted missing files live in the local log.** A memory a session
  reported wrong on one PC is not on the other PC's review list. Staleness is read
  from the record's dates, so that flag is the same everywhere.
- **Card reads are not counted.** A memory read from the project card needs no tool
  call, so "never searched or opened" does not mean "never used". A flag for unread
  memories waits for the work map (below), which sees the card being loaded.
- **No monthly reminder.** The hub item stays up while anything is on either list.

Done-when of section 10, checked on 2026-11-11: a confirmed memory that names
`src/removed-poller.js` appears on the review list as "names a file that is gone"
(`test/memoryreview.test.js`, and `memory review` on the real store), and
`memory stats` prints the approval rate of the chosen number of days.

### Bonus, wanted by Mati on 2026-11-11: a live work map in LunaCore

Mati wants a panel in the HUD that shows what the session in the active tab is doing,
in the spirit of the Claude Code plugin `github.com/alexeyw/lot-map` (MIT): the model in
the centre, stations around it (Files, Shell, Network, Memory, Agents, Skills), a pulse
to a station when a call starts and back when it ends, errors in red, a ring for the
context window.

- **Built as LunaCore's own widget, not by installing the plugin.** In a LunaCore tab
  `claude` runs inside a terminal, where the plugin draws text only and needs 144
  columns. The widget is a renderer module with its own design in LunaCore's themes.
- **No new data source and no tokens.** It rides the feed the Skill Tracker already
  uses: `TranscriptWatcher` -> `metrics:tools` (start and end of each tool call) and
  `metrics:context`. Subagents, skills and the model come from the same transcript.
- **Hook refusals: in the transcript, not in what the observer sends (checked
  2026-11-12).** A PreToolUse refusal (the Fact-Forcing Gate, for example) is written
  as an ordinary `tool_result` with `"is_error": true`, content starting
  `PreToolUse:<Tool> hook error: ...`, and a top-level `toolDenialKind` on the entry.
  Hooks that pass only leave `attachment` entries (`hook_success`,
  `async_hook_response`, `hook_non_blocking_error`). `src/observer.js` drops all of
  it for built-in tools: `toolEventsFromLines()` emits an `end` event with no
  `is_error` and no content, so a refused Edit looks like a finished one on
  `metrics:tools`. Only `metrics:mcp` carries `ok:false` plus the content, so a refused
  MCP call shows up as an MCP error, not as a hook refusal. The work map model
  (`src/renderer/modules/workmapmodel.js`) therefore has **no Hooks station**. Adding
  one needs the observer to forward `is_error` and a short content prefix (or the
  `toolDenialKind`) on tool `end` events: a main-process change for its own package.
  The model already flags a tool end with `ok:false` / `isError:true` as an error,
  so it is ready for that field.
- **Skills station gap (found with the above).** `metrics:tools` carries a Skill
  Tracker tile, not the tool name, and the `Skill` tool has no tile, so observer.js
  never sends it. The model maps `Skill` by name, but the station stays dark until
  the observer forwards tool names (the same observer change as above).
- **The Memory station is the part that serves this plan.** It lights up and counts
  when a session calls `memory_search` or `memory_get`, and marks the card loaded at
  tab start. That count is the evidence for the with/without comparison of section 9.
- **Usage counts per memory** come with it: a memory that is never read is flagged for
  the review list (phase 5), one that is read often moves up the card.
- **Order:** after phase 4, unless Mati moves it forward. It is a bonus, so it must not
  delay capture.

## 1. Why

Luna starts every session knowing almost nothing about the project beyond CLAUDE.md. What
was learned yesterday (why a design was rejected, which command hangs, how a release is
cut) is either gone or sitting in a place nothing reads.

There are already four memory mechanisms on the workstation. None of them does the job:

| Mechanism | What it holds | State on 2026-11-10 |
|-----------|---------------|---------------------|
| Claude Code auto-memory (`~/.claude/projects/<project>/memory/`) | Hand-written facts, one file each, index loaded every session | Works. 11 entries for LunaCore. Per project and per machine, no search, the whole index is always loaded |
| ECC session summaries and learned skills | A summary of the previous session, five learned skills | Injected at session start. The summary is a list of file names and truncated prompts, not knowledge |
| `codebase-memory-mcp` (code graph) | Functions, calls, routes | Zero calls in 274 sessions, although a hook demands it at every start. One stale index of an old copy of this repo |
| graphify | Knowledge graph per repo | Not installed. Synthara's CLAUDE.md points at output that does not exist |

So the gap is not "more memory tools". It is one store that every project shares, that is
searched instead of loaded whole, and that is written to deliberately.

## 2. What it should do

1. **Recall across projects.** A fix found in SteelQuote (Prisma, Postgres) is available
   in CRU.
2. **Stay small in context.** A short project card at session start. Everything else is
   fetched by search when needed.
3. **Be trustworthy.** Every memory has a source, a date and a scope. A wrong memory can
   be found, corrected and retired.
4. **Be written on purpose.** Candidates are extracted automatically. What is kept passes
   a filter and, at least at first, Mati's approval.
5. **Work on both PCs.**
6. **Be readable without the tool.** If LunaCore is off, the memory is still files a
   person can open.

Out of scope: indexing source code. Code is read live with grep and file reads, which are
always current. The memory holds what the code cannot tell you.

## 3. What goes in

| Type | Example | Typical life |
|------|---------|--------------|
| `decision` | "God Mode cards may build God Mode cards. No separate-run rule." | Long, until superseded |
| `gotcha` | "`git worktree remove` empties a junction target. Use `npm ci --ignore-scripts` in the worktree." | Long, re-verify when tools change |
| `how-to` | "Release: upload the installer as `LunaCore-Setup-X.exe` with dashes, or auto-update breaks." | Long |
| `project-fact` | "SteelQuote app lives in `finance_calculator_deployed/nextjs_space`. `pgdata` is a live database." | Until the repo changes |
| `preference` | "Comments in English. Polish UI strings in `config/*.json` without diacritics." | Long |
| `domain` | "PGL per type is computed ... / Ortec exports arrive as ..." | Long |
| `digest` | "2026-11-10: crash resume, editor auto-save shipped in 737ddab." | Short, decays |
| `reference` | A link to a dashboard, ticket or document | Until it 404s |

Not stored: secrets, tokens, customer personal data, raw mail content, anything that is
already in CLAUDE.md or obvious from the code.

The rule for keeping something, taken from the auto-memory guidance: it is **applicable**
(it would change what Luna does next time) and **durable** (it matters beyond this task).

## 4. Shape of a memory

Markdown file with frontmatter. One fact per file.

```markdown
---
id: worktree-node-modules-junction
type: gotcha
scope: project            # global | project | area
project: luna-core-hud    # omitted when global
area: worktrees           # optional, free tag
created: 2026-10-21
last_verified: 2026-11-02
source: session 7f3a... / commit 2ef0680 / Mati said
confidence: confirmed     # confirmed | observed | inferred
supersedes: []            # ids this replaces
links: [gm-deps-asar-lock]
---
Do not create new node_modules junctions for worktrees.

**Why:** `git worktree remove` follows the junction and empties the main node_modules.
**How to apply:** run `npm ci --ignore-scripts` inside the worktree instead.
```

This is deliberately the format the existing auto-memory already uses, plus scope, source
and verification fields, so the 11 existing entries import without rewriting.

## 5. Architecture (recommended)

```
  memory repo (git, private)              LunaCore main process
  ---------------------------             ---------------------------------
  global/*.md                    read     indexer: watches the repo,
  projects/<project>/*.md      -------->  chunks, embeds, writes the index
  inbox/*.md  (candidates)                        |
        ^                                         v
        | write (approved)               index.sqlite  (FTS5 + vectors)
        |                                         |
  capture: session end  ---> extractor            v
  (hook)                     (small model)  lunacore MCP server
                             -> inbox       memory_search / memory_get /
                                            memory_propose / memory_verify
                                                  |
                                                  v
                                           every Claude session
```

**Files are the source of truth, the index is disposable.** The index can be deleted and
rebuilt from the files at any time. Sync between PCs is `git pull`. History and undo come
free. A person can read and edit a memory in any editor.

**The index is SQLite with full-text search and a vector column,** inside LunaCore's data
directory. No server to run. Which SQLite binding to use (the module built into recent
Node versions, or a native package) depends on the Node version inside the Electron
release LunaCore ships, and is checked in phase 1.

**Retrieval is hybrid.** Keyword search finds exact things (an error string, a file name,
`EBUSY`). Embedding search finds meaning ("why does packaging time out"). Results are
merged, then boosted for the current project, for `confirmed` over `inferred`, and for
recent verification. Superseded memories are excluded.

**Access is through the `lunacore` MCP server that already exists** (it serves the
`luna_todo_*` tools). No new server, no new connection to configure. It is available in
every session LunaCore starts. Whether sessions started outside LunaCore can reach it is
question 9.

**Embeddings run locally by default.** LM Studio and Ollama are both installed. Notes are
a mix of Polish and English, so the model must be multilingual. Which model is a decision
to make after measuring two or three on real notes (section 9), not now.

### Alternatives considered

| Option | For | Against |
|--------|-----|---------|
| **Supabase Postgres + pgvector as the store** | Already used for two-PC sync. One place, queryable from the phone app | Memory depends on network and on a cloud project. Not readable as files. Harder to review and undo. Per-row sync logic to write |
| **Extend Claude Code auto-memory only** | Zero build | Per project, per machine, no search, whole index always in context. Does not solve the problem |
| **Adopt graphify or a code graph** | Good for "who calls this" | Different problem. Four weeks of evidence that a graph tool goes unused here |
| **A third-party memory MCP (mem0, Zep and similar)** | No build | A new service with its own data model, cloud or Docker, and your project knowledge leaves the machine or needs hosting |

A hybrid is possible later: files stay the source, and Supabase holds a read-only mirror
so the phone can search. That is phase 6 at the earliest.

## 6. Read path

Three layers, cheapest first:

1. **Project card, always.** At session start LunaCore injects a card of at most about
   1,500 tokens for the current project: stack, commands, the five to ten highest-value
   gotchas and decisions. It is generated from the memories, not written by hand, and
   regenerated when they change. This replaces the code-discovery reminder hook.
2. **Search on demand.** Luna calls `memory_search` when a task touches something that
   could have history: a failing command, a design choice, an unfamiliar area. A line in
   the global CLAUDE.md says when to search. Results come back as short entries with ids.
3. **Automatic retrieval per prompt, later and optional.** A hook searches on every user
   prompt and injects the top results. It helps when it hits and adds noise when it does
   not. It ships only if the evals in section 9 show it helps.

Everything returned by memory is **data, not instruction**. A memory can inform a choice.
It cannot grant a permission or override CLAUDE.md. The MCP tool results say so.

## 7. Write path

1. **Capture.** When a session ends, a hook hands the transcript to an extractor: a small,
   cheap model with one job, to propose zero to five candidate memories in the format of
   section 4. Most sessions should produce zero.
2. **Filter.** Drop a candidate that fails the applicable-and-durable rule, that repeats
   an existing memory (near-duplicate search), or that trips the secret scanner.
3. **Reconcile.** A candidate that contradicts an existing memory is marked as a proposed
   supersede, never a silent overwrite.
4. **Inbox.** Candidates land in `inbox/`. The HUD shows them in a panel: approve, edit,
   reject. Approved ones move into place and are committed.
5. **Direct writes.** Luna can call `memory_propose` mid-session ("remember this"). It
   goes to the same inbox.

Whether step 4 stays manual forever is question 4 in section 11. The safe start is manual
for everything, then auto-accept for low-risk types (`digest`, `reference`) once the
rejection rate is known.

Sources that are never captured automatically: mail bodies, web pages, anything a tool
fetched from outside. Text from those can contain instructions written by someone else,
and a memory is the one place where such text would be replayed into every future session.

## 8. Keeping it true

- **Verification date.** A memory used successfully gets `last_verified` bumped through
  `memory_verify`. One that turned out wrong gets retired the same way.
- **Staleness.** A `gotcha` or `how-to` unverified for a set period is flagged in the HUD,
  ranked lower, and still returned with a "not verified since" note.
- **Decay.** A `digest` drops out of search after a period and is archived, not deleted.
- **Anchors.** A memory that names a file, function or flag is checked by the indexer. If
  the thing no longer exists, the memory is flagged.
- **Review.** A monthly pass over the flagged list. It should take minutes.

## 9. How we will know it works

Before building retrieval, write a golden set: 30 to 50 real questions per project with
the memory that should answer each. Examples from what is already known:

- "A package run says restarted: timeout. Where do I look first?"
- "Can I junction node_modules into a worktree?"
- "How do I name the installer asset for a release?"
- "God Mode Retry says busy after the laptop slept."

Measured:

- **Recall at 5:** is the right memory in the top five? This picks the embedding model
  and the ranking weights.
- **Card usefulness:** do sessions with the card make fewer wrong first moves? Compare a
  sample of sessions with and without it.
- **Noise:** how often does a returned memory get ignored or turn out irrelevant?
- **Inbox quality:** share of candidates approved. If it is below roughly a third, the
  extractor prompt is wrong.
- **Cost:** tokens per session for the card and searches, and extractor cost per session.

A change to chunking, model or ranking ships only if recall on the golden set does not
drop.

## 10. Phases

Each phase is usable on its own and each ends with something Mati can judge.

| Phase | Builds | Done when |
|-------|--------|-----------|
| 0 | Decisions from section 11. The golden set for LunaCore | The questions are answered and 30 questions exist |
| 1 | Memory repo. Import of the 11 auto-memory entries, the 5 learned skills, and selected docs. Indexer and a CLI search | `luna memory search "worktree junction"` returns the right entry |
| 2 | `memory_search` and `memory_get` on the lunacore MCP server. One line in CLAUDE.md | Luna answers the golden questions from memory in a real session |
| 3 | Project card at session start. Remove the code-discovery hook | The card is under budget and the with/without comparison is done |
| 4 | Capture: session-end extractor, filter, inbox panel in the HUD | A week of real sessions produces candidates worth approving |
| 5 | Verification, staleness flags, anchors, the review list. Plus, from the proposals of 2026-11-11: the capture and usage log, and rejected titles fed back to the extractor | A deliberately broken memory gets flagged, and the approval rate of a week of captures can be read |
| 6 | Second PC. Optional Supabase mirror for the phone | Both machines return the same results |
| 7 | Only if the evals ask for it: per-prompt automatic retrieval, reranking | Recall or noise numbers justify it |

Phases 1 to 3 are the core. They are also where it becomes clear whether the rest is
worth building.

## 11. Questions for Mati

Recommended answer first in each.

1. **Where does the truth live?** (a) Markdown files in a private git repo, index rebuilt
   locally. (b) Supabase with pgvector. (c) Both, with files as the source.
2. **One memory for everything, or work and private apart?** (a) One repo with scopes.
   (b) Company projects (AMSafe, SteelQuote, CRU, Ortec work) in a separate store from
   personal ones (Blade & Bullet, money printer, Synthara). This matters if company
   knowledge must not sit on a personal GitHub account.
3. **Embeddings: local or API?** (a) Local through LM Studio or Ollama: free, private,
   needs the app running. (b) An API: better quality, costs money, sends note text out.
4. **Who approves a new memory?** (a) Mati approves everything at first, then low-risk
   types are auto-accepted. (b) Always manual. (c) Fully automatic with a weekly review.
5. **Which projects first?** (a) LunaCore only, then add one at a time. (b) All at once.
6. **Should existing docs be indexed too** (`docs/reference/ENGINEERING_NOTES.md`, the
   plans in `docs/tbc_docs/`, the Polish plan files in SteelQuote and CRU)? (a) Yes, as
   searchable reference chunks, separate from memories. (b) Memories only.
7. **Should the phone app be able to search memory?** (a) Not now. (b) Yes, which needs
   the Supabase mirror.
8. **What is the budget for the session-start card?** (a) About 1,500 tokens. (b) Larger,
   since quality matters more to you than context. (c) No card, search only.
9. **Does it live inside LunaCore,** which makes it available only when LunaCore runs the
   MCP server, **or as a separate small tool** LunaCore merely uses? (a) Inside LunaCore
   first, extracted later if needed. (b) Separate from day one.
10. **Language of memories.** (a) English, like code comments, with Polish terms kept
    where they are the real domain word (`kontrahent`, PGL). (b) Whatever language the
    session was in.
11. **What happens to the old mechanisms?** Recommended: keep Claude auto-memory as a
    capture source and import it, stop the code-discovery hook, drop graphify, leave ECC
    session summaries as they are until phase 4 replaces their purpose.
12. **Is there a deadline or a trigger for this?** For example, before the company agent
    work starts, since that project will want the same store for its ontology decisions.

## 12. Risks

- **A confidently wrong memory is worse than none.** That is why there is provenance,
  verification and an approval step, and why the card is generated only from `confirmed`
  entries.
- **Memory as an attack surface.** Anything written into memory is replayed into future
  sessions. External text is never auto-captured, and memory content is always framed as
  data.
- **Building a system nobody feeds.** This is what happened to the code graph. The answer
  is that capture is automatic and reading is automatic (the card), so the system works
  without Mati or Luna remembering to use it.
- **Scope creep.** Phases 1 to 3 are small. If they do not visibly help, stop there.
