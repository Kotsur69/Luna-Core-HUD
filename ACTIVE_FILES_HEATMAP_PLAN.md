# Active-Files Edit Heatmap — Implementation Plan

**Status: SHIPPED 2026-08-13.** Source idea: `LUNA_HUD_SPECIFICATION.md`
§6.2. Shape mirrors `TERMINAL_CUSTOMIZER_PLAN.md`. Built per §11's order,
verified against §13's checklist in `npm start`, then amended twice more the
same day from Mati's manual test feedback — see **§14** for what changed
after the initial ship and why the plan below no longer matches the code in
three places (R8, §3.3, §5.3).

---

## 0. What's already decided (with Mati, 2026-08-13)

| Question | Decision |
|---|---|
| Metric | **Real +/- added/removed line counts per file**, git-diff-stat style. Not a blink, not a frequency-only tally. |
| UI home | **Small tile in the right panel**, alongside Context / Usage / Telemetry / Skill Tracker / Ports. A glowing list, one row per file. |
| Sort | Recency primary; magnitude drives glow intensity. |
| Scope | **Active session only.** No persistence across restarts, no new local file, no new pref. Resets when the transcript/tab does — same scoping as the context bar and the sparkline. |
| Prefs | **No new `uiprefs.js` DEFAULTS entry** — see §7 for why that is the convention, not a shortcut. |
| Live indicator | **Added 2026-08-13, before build started.** A file currently being read/edited (tool called, result not back yet) lights up distinctly from the heat glow — see §5.6. Event-driven off `start`/`end`, no timer. |

**Two decisions the original brief assumed that the transcript overrules —
see §2. Both make the build *smaller*, not bigger:**

1. We do **not** need to write an LCS line diff over `old_string`/`new_string`.
   The CLI already writes a computed unified diff into the transcript.
2. We do **not** need an `fs` read of the file after a `Write`. The
   transcript distinguishes create-vs-update and carries a real patch for
   the update case.

---

## 1. Zero-token compliance

Strict **Passive Observer**, and the narrowest kind: it adds **no new data
source and no new file I/O at all**. `TranscriptWatcher.accumulate()`
(`src/observer.js:584`) already reads the newly-appended JSONL fragment
every 1.5 s and already `JSON.parse`s every line containing `"tool_use"` or
`"tool_result"` (`toolEventsFromLines()`, `src/observer.js:316-346`). This
feature reads **more fields off objects that are already parsed** and rides
the **existing `metrics:tools` IPC channel** (`src/main.js:529` →
`src/preload.js:31-33` → `src/renderer/modules/sessions.js:99-107`).

- No second watcher (`LUNA_HUD_SPECIFICATION.md` §5 step 1 explicitly warns
  against one).
- No new IPC channel.
- No disk read of the edited files — which also removes a correctness trap:
  reading a file "immediately after" an edit races the next edit, and would
  report the state at *read* time, not at *edit* time. The transcript's own
  snapshot cannot race.
- No writes to the PTY. This widget has no Action Injector half.

---

## 2. What the transcript actually carries (verified against real JSONL)

Verified by grepping `C:\Users\mmazur\.claude\projects\C--Users-mmazur--local-bin\*.jsonl`.
This section is the payload of the research; the rest of the plan follows
from it.

### 2.1 The `tool_use` side (assistant entry) — already parsed, fields currently dropped

`message.content[]` block: `{ type: 'tool_use', id, name, input }`. For our
three tools `input.file_path` is an absolute path:

```
"name":"Read","input":{"file_path":"C:\\Users\\mmazur\\source\\repos\\AMSteel_Quote\\STAN_PROJEKTU.md"
"name":"Write","input":{"file_path":"...\\CRU2026\\status_projektu.md","content":"# CRU2026 — Stan projektu\n\n## O…
…"file_path":"…\\Luna-Core-HUD\\src\\main.js","old_string":"let usageAnnounced = { at50: false, at80: false };","new_s…
```

**Answer to the flagged open question:** `toolEventsFromLines()` reads
`part.name` only and emits `{ phase, id, tile, at }`. **`file_path`,
`old_string` and `new_string` are dropped on the floor today** — they never
reach `foldToolEvents()`, and `foldToolEvents()`'s `open` map is
`id -> tile` where the value is a **plain string** (`src/observer.js:367`,
and asserted as such at `test/observer.test.js:399`). So yes: the fold
collapses them away. Extending both functions is unavoidable; §3.2 says
exactly how, and §12 flags the two test assertions it touches.

### 2.2 The `tool_result` side — the real find

The tool_result entry (a `role: 'user'` message) carries a **top-level
`toolUseResult` object, a sibling of `message`, not inside
`message.content`**. For `Edit` it looks like:

```
"toolUseResult":{"filePath":"…\\src\\main.js","oldString":"…","newString":"…","structuredPatch":[…],"originalFile":…}
```

and `structuredPatch` is **a unified diff the CLI already computed**:

```
"structuredPatch":[{"oldStart":43,"oldLines":6,"newStart":43,"newLines":19,
  "lines":["     }"," }"," ","+# --- Baza danych …","+$pgCtl = '…'", …]}]
```

Counting `lines` entries whose first character is `+` or `-` gives **exact**
git-diff-stat numbers.

**Why this beats diffing `old_string`/`new_string` ourselves**, which is
what the original brief assumed: an LCS over the two snippets counts every
*modified* line as one add **and** one remove, and it can't see the context
lines the CLI keeps. A one-word typo fix in a 40-line `old_string` would
read `+40 -40` from a naive string diff and `+1 -1` from `structuredPatch`.
The second is what a git diff stat says, and it is what Mati asked for.
**`structuredPatch` is the primary path; the string diff is a fallback
only** (§3.1).

### 2.3 `Write` — the "no before snapshot" problem is already solved

`toolUseResult` for `Write` is
`{ type, filePath, content, structuredPatch, originalFile }`, and `type`
distinguishes the two cases:

| Case | Observed shape | Stat |
|---|---|---|
| New file | `{"type":"create","filePath":…,"content":"…","structuredPatch":[],"originalFile":null}` — e.g. `11a436ef-…jsonl:416` | Pure additions: count lines of `content` |
| Overwrite | `{"type":"update","filePath":…,"content":"…","structuredPatch":[{"oldStart":3,…}]}` — e.g. `35efba87-…jsonl:2149`, `2014e9fd-…jsonl:2607` | Real `structuredPatch` count |

So the fallback originally proposed (count all lines as "written", or
`fs`-read the result) is **not needed**. Dropped. §12/R4 keeps one
defensive branch in case a future CLI omits the patch.

### 2.4 `Read` — touch only, and it names its file too

`"toolUseResult":{"type":"text","file":{"filePath":"…","content":"…","numLines":…,"totalLines":…}}`.
Note `filePath` is nested one level deeper here than for Edit/Write. We
take the path from the **`tool_use` input** anyway (§3.2), so this only
matters if we ever want `numLines`. A Read contributes `+0 -0` — a
recency/touch signal, rendered differently (§5.3).

### 2.5 One tool call per transcript entry (empirical)

Two greps across every transcript on this machine —
`"type":"tool_use".*"type":"tool_use"` and
`"type":"tool_result".*"type":"tool_result"` — returned **0 matches in 0
files**. That is what makes the single top-level `toolUseResult`
unambiguously attributable to the single `tool_result` block in that entry.
It is an observation, not a documented guarantee, so §3.2 guards it: read
`toolUseResult` **only when the entry holds exactly one `tool_result`
block**, otherwise emit a 0/0 touch.

---

## 3. New pure module + the two extended functions

### 3.1 New file: `src/filestat.js` (pure, no I/O — the `ttsExtract.js` shape)

| Export | Signature | Behaviour |
|---|---|---|
| `countPatch(structuredPatch)` | `→ {added, removed}` | Sums over hunks; `line[0] === '+'` → added, `'-'` → removed, everything else (context `' '`, `'\ No newline…'`) ignored. Non-array / empty → `{0,0}`. |
| `countLines(text)` | `→ number` | `''` → 0; drops the single trailing empty element when the text ends in `\n` (a file ending in a newline has N lines, not N+1). |
| `countStringDiff(oldString, newString)` | `→ {added, removed}` | **Fallback only.** Line-level LCS, no dependency. Guard: if either side exceeds `MAX_DIFF_LINES` (2000), skip the O(n·m) table and return `{added: newLines, removed: oldLines}` — a 5000×5000 matrix on the 1.5 s watcher tick is not worth an exact answer nobody asked for. |
| `fileStatFromEntry(obj)` | `→ {file, added, removed} \| null` | The resolver. Order: (1) `r.filePath` or `r.file?.filePath`, else `null`; (2) non-empty `r.structuredPatch` → `countPatch`; (3) `r.type === 'create'` + string `r.content` → `{added: countLines(content), removed: 0}`; (4) string `r.oldString` + `r.newString` → `countStringDiff`; (5) otherwise `{added: 0, removed: 0}` (a Read, or a shape we don't recognise). A failed Edit writes an error *string* into `toolUseResult`, so the `typeof === 'object'` guard at the top naturally excludes it — a rejected edit contributes nothing, which is correct. |

`shortPath()` lives in the renderer, not here — see §5.2.

### 3.2 `src/observer.js` — widen the two functions

**`toolEventsFromLines()` (lines 316-346).** Same loop, same single
`JSON.parse` per line, two additions:

- `tool_use` branch (line 332): also read `part.input?.file_path` and
  attach it as `file` (`''` when the tool has none — Bash, Grep, Task).
- `tool_result` branch (line 337): compute `fileStatFromEntry(obj)` **once
  per entry**, guarded on the entry holding exactly one `tool_result` block
  (§2.5). Attach `added` / `removed` to the end event.

**`foldToolEvents()` (lines 361-376).** Widen `open`'s value from the bare
tile string to `{ tile, file }`, and carry `file` onto the end event the
same way it already resolves `tile`. This is the fold's existing job —
*"a `tool_result` does NOT repeat the tool's name, so an end event has no
tile of its own; `foldToolEvents()` resolves it from the id that opened it"*
(`src/observer.js:310-312`). The file path is the identical problem with
the identical answer, so it belongs here rather than in a per-widget join
map in the renderer.

Resulting event shapes:

```
{ phase: 'start', id, tile, at, file }
{ phase: 'end',   id, tile, at, file, added, removed }
```

**Explicitly rejected alternative:** taking the end event's path from
`toolUseResult.filePath` instead of joining through `open`. It works today,
but `input.file_path` is the *documented tool input schema* while
`toolUseResult` is an internal CLI artefact — pinning the file identity to
the more stable of the two is worth the small widening. The stat still
comes from `toolUseResult` and degrades to `0/0` if that shape ever
changes, which is a dim row instead of a missing one.

**Cost:** two assertions in `test/observer.test.js` change — see §12/R1.

### 3.3 `src/main.js` and `src/preload.js` — no change at all

`onTools: (events) => send('metrics:tools', { sessionId, events })`
(`src/main.js:529`) is already a pass-through of whatever
`foldToolEvents()` returns. The wider events ride it for free. Payload
growth is two integers and one path string per event — the file *contents*
never leave the main process.

---

## 4. Renderer routing: `sessions.js` (5 lines)

`window.lunacore.onTools()` (`src/renderer/modules/sessions.js:99-107`)
already demultiplexes active-vs-background exactly the way this widget
needs. Add a second pair of calls alongside the Skill Tracker's:

```js
if (active) { applyToolEvents(events); applyFileEvents(events); }
else { trackBucketTools(bucket, events); trackBucketFiles(bucket, events); }
```

New import from `./activefiles.js`. **Do not** add a new IPC listener —
`FUTURE_PLAN.md` §A2a's rule: *"IPC listeners live at module scope; widgets
only ever touch the bus"*, and `sessions.js` is the one sanctioned
exception because it is the session router.

**Revised from the original brief:** the heatmap now consumes **both**
`start` and `end` events, not `end` only.

- `start` → upsert the row, set `inProgress: true`, bump `lastAt` (so it
  jumps to the top). **Stats are untouched** — a `start` never changes
  `added`/`removed`, it only flips the live flag. This is what makes "a
  rejected or still-running edit never inflates the stat" still true.
- `end` → upsert the row, set `inProgress: false`, **add** `added`/`removed`
  (accumulate, don't replace — §13's "two edits to the same file accumulate
  into one row" check still applies), bump `touches`/`lastAt`.

See §5.6 for the visual and §12/R8 for the one new failure mode this adds.

---

## 5. UI: the widget

### 5.1 Identity and registration

| Thing | Value |
|---|---|
| Widget id | `activefiles` |
| Module | `src/renderer/modules/activefiles.js` (new, from scratch — not a conversion) |
| Template | `<template id="w-activefiles">` in `src/renderer/index.html`, next to `w-skilltracker` (line 258) |
| Title key | `activefiles.title` |
| Import | one line in `src/renderer/renderer.js` under `-- Right panel: metrics --` (lines 31-38), after `skilltracker` |

Template root: **`<div class="panel__section">`** — deliberately *without*
`--grow`, matching `w-usage`'s comment at `index.html:235-237` (*"copying
one of them here would quietly redistribute the right panel's height"*).
Exactly one root element, per §A2a.

```html
<template id="w-activefiles">
  <div class="panel__section">
    <h2 class="panel__title" data-i18n="activefiles.title">Aktywne pliki</h2>
    <ul id="afile-list" class="afile-list"></ul>
    <p id="afile-empty" class="hint" data-i18n="activefiles.empty">…</p>
  </div>
</template>
```

Rows are built by JS (`document.createElement`, never `innerHTML` with
data — `ports.js:39-47` is the precedent, and file paths are untrusted-ish
text from disk).

### 5.2 Row content

One `<li class="afile">` per file:

- **`.afile__name`** — `shortPath(file)`: the last two path segments, e.g.
  `modules/ports.js`. `title` = the full absolute path (`ports.js`'s
  tooltip pattern). Pure, exported, unit-tested; handles `\` and `/`, and
  a bare filename.
  - *Deliberately not cwd-relative in v1.* Threading the session `cwd` from
    `sessionList` metadata into this module is real coupling for a marginal
    gain, and two segments disambiguates in practice. Flagged as a Phase-2
    refinement if it proves ambiguous.
- **`.afile__stat`** — `<i class="afile__add">+12</i><i class="afile__del">−3</i>`,
  using theme tokens `--good` (add) and `--bad` (remove) — both exist in
  all 9 themes (`config/themes.json`). A zero side is omitted rather than
  shown as `+0`.
- Read-only rows (`added + removed === 0`) get `.is-read`: dimmed, no
  numbers, a small glyph instead. A file that was only *looked at* should
  not look like a file that was *changed*.

### 5.3 The glow

Per row: `li.style.setProperty('--heat', ratio)` where
`ratio = clamp((added + removed) / maxMagnitudeInSession, 0.15, 1)`. CSS
reads `--heat` for `box-shadow` alpha and border colour, reusing the
`.skill-tile.is-active` glow vocabulary (`styles.css:975-979`,
`--glow-size-md`). New CSS block `/* ---- Active files ---- */` near the
Skill Tracker's at `styles.css:947`.

**No timer.** A decaying-with-age glow was considered and rejected: it
needs a repaint loop, and rows only go stale when nothing is happening —
which is exactly when the tile doesn't matter. Recency is expressed by
sort order alone. This sidesteps §A2b/§A2c's whole timer-teardown category.

### 5.4 Truncation, honestly

`MAX_ROWS = 8`. When more files were touched, the hint line reads
`activefiles.more` → *"+{n} więcej"* / *"+{n} more"*. This is `ports.js`'s
rule (`ports.js:84-92`): **a list that hides rows silently is worse than no
list**.

**No path filtering in v1.** Real transcripts are full of
`AppData\Local\Temp\claude\…\scratchpad\*` reads and reads of the
transcript's own `.jsonl`. Tempting to filter; deferred on purpose, because
a filter needs the same visible-count honesty and a toggle, i.e.
`ports.js`'s whole `hideSystemPorts` apparatus — which is a *second*
feature. Revisit after living with it.

### 5.5 State placement (the §A2c rule)

- **Module scope:** `let files = new Map()` keyed by absolute path →
  `{ file, added, removed, touches, lastAt, inProgress }`. This is app
  state, not view state — `ports.js:16-19`'s rule verbatim.
- **Mount scope:** `let els = null`, every render early-returns on `!els`.
  `mount(root)` **repaints from `files` immediately** (§A2c failure mode 1:
  a remount must show truth, not the template's authored empty state).
- **Cleanup:** disposes `onLangChange` / `onSessionRestarted` and nulls
  `els`. Nothing to flush (§A2b: no user-typed data here) and no timer to
  cancel (§5.3).

Exported pure reducer `applyFileEvent(map, ev)` so the accumulation logic
is unit-testable without a DOM — the same split `spark.js` uses for
`pushSample()` / `etaMinutes()`.

### 5.6 Live "in use" indicator

The heat glow (§5.3) answers *"what got changed"*. This answers a different
question Mati asked for: *"what is happening right now"* — a file between
its `start` (tool called) and `end` (result back) event.

- `li.classList.toggle('is-live', row.inProgress)`. A distinct visual from
  the heat glow, not a variant of it — `is-live` wins the row's border/dot
  colour regardless of `--heat`, so a huge-diff file mid-edit doesn't get
  confused with a huge-diff file that just finished.
- CSS: a small pulsing dot (`@keyframes afile-pulse`, opacity 1↔0.4,
  ~1.2s) next to `.afile__name`, plus a steady (non-animated)
  accent-coloured left border. **The pulse is a CSS animation, not a JS
  timer** — it runs on the DOM only while `.is-live` is present and costs
  nothing when no row has it, so it doesn't reopen §5.3's "no timer"
  decision or its teardown category.
- A brand-new file (no prior row) can arrive via `start` before any `end` —
  render it immediately as a live, zero-stat, `.is-read`-style row (name
  only, no `+`/`-` yet) rather than waiting for the first `end`. That *is*
  the feature: visibility into "being worked on right now," not just "was
  changed."
- Sort: `inProgress` rows first (regardless of recency group from R6),
  then changed-ahead-of-read-only, then `lastAt`. A file actively being
  edited outranks a file that was edited a second ago.
- Clearing: `end` sets `inProgress: false` unconditionally, even for a
  failed/rejected result (`fileStatFromEntry` returning `null`/`{0,0}` still
  reaches the reducer as an `end` event with the file identity attached in
  `foldToolEvents()` — only the *stat* is affected by a failure, not the
  live flag). A row must never stay lit after its tool call has returned.

---

## 6. Session scoping (tabs)

Mirrors `skilltracker.js:242-262` exactly:

```js
registerSessionView({
  save(bucket)  { bucket.activeFiles = new Map(files); },
  load(bucket)  { files = bucket.activeFiles || new Map(); render(); },
  clear(bucket) { bucket.activeFiles = new Map(); },
});
onSessionRestarted(() => { files = new Map(); render(); });
```

`registerSessionView` stays at **module scope**, not inside `mount()` —
same reason `skilltracker.js:238-241` gives: a background tab's bookkeeping
must stay correct while the widget is off screen, and the subscriber count
the `--luna-probe` watches must stay constant across remounts.

`clearSessionView()` is already called on restart by `sessions.js:114`, so
a profile/project switch wipes the map for free.

**No persistence.** No `ui.local.json` key, no new file. Closing the tab or
restarting LunaCore starts from empty — which is the decision in §0 and
matches the context-%/sparkline scoping.

---

## 7. Prefs schema — none, and why that's the convention

Checked against the actual `uiprefs.js` DEFAULTS consumers: `context`,
`spark`, `usage`, `skilltracker` and `telemetry` — every zero-config
right-panel widget — have **no on/off pref**. Only two right-panel widgets
carry one, and each for a specific reason: `ports` (`hideSystemPorts`, a
*filter* whose state must survive a restart) and `scratchpad` (persisted
*content*). This widget has neither a filter nor content.

Visibility is already user-controllable without a pref:
`config/layouts.json` presets decide which widgets exist where (§8), and
`__luna.layout(id)` switches live.

**Conclusion: no `DEFAULTS` entry, no `readUiPrefs()` branch, no
`writeUiPrefs()` branch.** If §5.4's path filter ever ships, *that* earns a
pref, following `hideSystemPorts` exactly.

---

## 8. Layout placement — `config/layouts.json`

The widget must be listed in a preset's `slots` or it never mounts
(`src/layouts.js:99-117`). Add `"activefiles"` after `"skilltracker"` in:

- `classic` → `right` (line 16)
- `monitor-heavy` → `right` (lines 45-55)
- `bottom-dock` → `dock-b` (line 70)
- **`focus` → deliberately omitted.** That preset is the minimal one
  (`main` + `side` with 6 widgets); a widget absent from a preset is simply
  not mounted — `REQUIRED_WIDGETS` is only `['terminal', 'appearance']`
  (`src/layouts.js:44`), so omission is legal and silent.

**Gotcha worth flagging:** `loadLayouts()` merges `config/layouts.local.json`
over the base **by whole preset id** (`src/layouts.js:188-197`). If Mati
ever creates that gitignored file, a preset defined there shadows the base
one entirely and the new widget won't appear in it. No such file exists
today (`config/` holds only `ui.local.json` as a `.local`), so this is a
note for later, not a build step.

---

## 9. i18n (`src/renderer/i18n.js`)

New keys, PL block (~line 128, next to `skilltracker.*`) and EN block
(~line 306):

| Key | PL | EN |
|---|---|---|
| `activefiles.title` | `Aktywne pliki` | `Active files` |
| `activefiles.empty` | `Zadnych zmian w plikach w tej sesji.` | `No file changes this session.` |
| `activefiles.hint` | `+/- to realne linie z diffa transcriptu.` | `+/- are real diff lines from the transcript.` |
| `activefiles.more` | `+{n} wiecej` | `+{n} more` |
| `activefiles.readonly` | `tylko odczyt` | `read only` |

`activefiles.title` / `activefiles.empty` are static markup (`data-i18n`),
resolved by `window.i18n.applyStatic(root)` inside `mountWidget()`
(`host.js:95`). `activefiles.more` / `activefiles.readonly` are dynamic →
`t()` at render time, re-rendered from the `onLangChange` subscription
bound in `mount()` (`ports.js:141` pattern). Note the existing PL strings
are deliberately ASCII-only — follow that.

---

## 10. Testing

Convention per `LUNA_HUD_SPECIFICATION.md` §5 step 7: **test pure
functions, not DOM/OS wrappers.** Runner is plain `node --test`
(`package.json:10`); current baseline is **362 tests**. Renderer ESM is
directly `require()`-able thanks to `src/renderer/package.json`'s
`"type": "module"` (see `test/widgets.test.js:3-7`).

**New — `test/filestat.test.js`** (main process, pure):
- `countPatch` sums `+`/`-` across multiple hunks and ignores context lines.
- `countPatch` ignores a `\ No newline at end of file` line.
- `countPatch` on `[]` / `undefined` / garbage → `{0,0}`.
- `countLines('')` → 0; trailing-newline file counts N, not N+1.
- `countStringDiff` reports `+1 -1` for a one-line change inside a 5-line
  block (this is the assertion that documents *why* `structuredPatch` is
  preferred — contrast it with the naive `+5 -5`).
- `countStringDiff` above `MAX_DIFF_LINES` falls back to the whole-block
  count without hanging.
- `fileStatFromEntry` prefers `structuredPatch` over `oldString`/`newString`
  when both are present.
- `fileStatFromEntry` on `type:'create'` with empty patch → all-additions
  from `content`.
- `fileStatFromEntry` on a Read entry (`{type:'text', file:{filePath}}`) →
  `{file, 0, 0}`.
- `fileStatFromEntry` on a failed Edit (`toolUseResult` is an error
  *string*) → `null`.
- `fileStatFromEntry` on an entry with no `toolUseResult` → `null`.

**Extended — `test/observer.test.js`** (reusing the `useLine`/`resLine`
helpers at lines 308-328, extended to take `input` and `toolUseResult`):
- `toolEventsFromLines` carries `input.file_path` onto the start event.
- `toolEventsFromLines` carries `added`/`removed` onto the end event.
- A tool with no `file_path` (Bash) still yields `file: ''` and breaks
  nothing.
- `foldToolEvents` resolves the end event's `file` from the id that opened
  it, across chunks (the file-path twin of the existing test at line 362).
- An orphan end (no matching start) is still dropped, stat and all.
- Two assertions **updated**, not added — see §12/R1.

**New — `test/activefiles.test.js`** (renderer ESM, pure):
- `shortPath` on a Windows absolute path → last two segments.
- `shortPath` on a POSIX path, and on a bare filename.
- `applyFileEvent` accumulates two edits to the same file into one row.
- `applyFileEvent` on a `start` event sets `inProgress: true` and leaves
  `added`/`removed` untouched (creates a zero-stat row if new).
- `applyFileEvent` on the matching `end` event sets `inProgress: false` and
  **adds** to `added`/`removed` — does not replace them.
- `applyFileEvent` on a failed/rejected `end` (stat `{0,0}` or absent)
  still clears `inProgress: false` — a row never stays lit past its `end`.
- `applyFileEvent` on a Read bumps `touches` and `lastAt` but leaves
  `added`/`removed` at 0.
- Sort order: live rows first, then changed-ahead-of-read-only (R6), then
  `lastAt` descending within each group.

**Not tested:** the DOM render, the glow, the `<template>` clone — same
category as `soundManager.js` / `tts.js`. Covered by §13's manual
checklist and the probe instead.

---

## 11. Build order

1. **`src/filestat.js` + `test/filestat.test.js`** — TDD, tests first (the
   project's own workflow rule). Fully standalone; nothing else needs to
   exist. Delivers a verifiable unit with zero app risk.
2. **`src/observer.js`** — widen `toolEventsFromLines()` /
   `foldToolEvents()`; update the two affected assertions and add the new
   observer tests. `npm test` must be green (≈ 362 + ~18) before anything
   renders. **The app still behaves identically at this point** — the
   extra fields are simply unread.
3. **`src/renderer/index.html`** — `<template id="w-activefiles">`.
4. **`src/renderer/modules/activefiles.js`** — pure reducer + `shortPath`
   first (with `test/activefiles.test.js`), then `defineWidget()`,
   `registerSessionView()`, `onSessionRestarted`, `onLangChange`.
5. **`src/renderer/renderer.js`** — one import, after `skilltracker`.
6. **`src/renderer/modules/sessions.js`** — the 2 routing lines (§4).
7. **`config/layouts.json`** — three presets (§8). *First point at which
   anything is visible.*
8. **`src/renderer/styles.css`** — `.afile-*` block, `--heat` glow.
9. **`src/renderer/i18n.js`** — PL + EN (§9).
10. **Verify** — §13's checklist, then `npx electron . --luna-probe`.
11. **Docs** — `README.md`'s data-flow table gains a row; `FUTURE_PLAN.md`'s
    START-HERE box and `LUNA_HUD_SPECIFICATION.md` §6.2 get marked shipped.
    Per spec §5 step 8, `LUNA_HUD_SPECIFICATION.md` itself stays a stable
    reference — only the §6.2 status line changes.

Steps 1-2 and 3-9 are two independently mergeable slices: after step 2 the
observer is richer and everything still passes; after step 9 the tile
exists.

---

## 12. Open risks and technical flags

**R1 — Two existing test assertions change (certain, small).**
`test/observer.test.js:365` asserts the fold's start event deep-equals
`{phase, id, tile, at}` exhaustively — widening the event breaks it.
`test/observer.test.js:399` asserts `[...open.values()]` deep-equals
`['Edit', 'Edit']` — widening `open`'s value to `{tile, file}` breaks it.
*Mitigation:* update both rather than dodging them with conditionally-spread
fields. Heterogeneous event objects (`file` sometimes present) are exactly
the shape that produces an `undefined` bug six months later. Both
assertions are testing an object shape *by accident*, not by design; the
behaviours they exist to protect (tile resolution, cross-chunk survival)
stay asserted.

**R2 — A resumed session shows nothing until it acts again (by design,
worth confirming).**
`accumulate()`'s `firstPass` guard (`src/observer.js:597`, `629-639`)
deliberately suppresses `onTools` on the initial sweep of an existing
transcript — *"everything in that first pass already happened"*. On
`--continue`, the heatmap therefore starts empty even though the transcript
records an hour of edits.
*Recommendation: keep the guard.* Replaying history would make "recency"
meaningless and light every row at once, which is precisely the bug the
guard was written to prevent for tiles. But this is a **visible product
decision**, not an invisible detail — worth one sentence to Mati before
build. If he wants history, the clean shape is a separate one-shot
`history` payload with no glow, as its own phase.

**R3 — MCP file-editing tools are invisible (accepted limitation).**
`toolEventsFromLines()` skips any `tool_use` whose name maps to no Skill
Tracker tile (`src/observer.js:334-336`), so an MCP editor (Serena,
morphllm, etc.) never produces an event. Its `tool_result` then becomes an
orphan and is dropped by the fold. The tile will honestly under-report in
an MCP-heavy session.
*Mitigation:* none in v1 — fixing it means decoupling file tracking from
`TOOL_TO_TILE`, which changes the fold's contract for everyone. Note it in
the module header so nobody re-discovers it as a bug.

**R4 — `toolUseResult` is an undocumented CLI artefact.**
It is not part of the Anthropic messages API; it is something Claude Code
writes for its own resume/undo machinery, and the CLI can change it in any
release. This is the same class of fragility the Skill Tracker's stdout
scan already suffered (`src/observer.js:277-284`).
*Mitigation, and the reason §3.2 joins the file path through `open` rather
than through `toolUseResult`:* if the result shape changes,
`fileStatFromEntry()` returns `{added: 0, removed: 0}` or `null`, and the
row degrades to a dim read-only touch — **the widget loses its numbers,
not its rows, and nothing throws**. Verify the shape once against a fresh
transcript at build time rather than trusting this document.

**R5 — "exactly one tool call per entry" is observed, not guaranteed**
(§2.5).
*Mitigation:* the guard in §3.2 — read `toolUseResult` only when the entry
holds exactly one `tool_result` block, else emit `0/0`. Cheap, and it
fails toward under-reporting rather than mis-attributing a diff to the
wrong file.

**R6 — `Read` rows may drown out `Edit` rows.**
Claude reads far more files than it writes, and `MAX_ROWS = 8` sorted by
recency could fill entirely with reads at the exact moment an edit lands.
*Mitigation to build in from the start:* sort **changed files ahead of
read-only files**, then by `lastAt` within each group. Cheap, and it makes
the tile answer the question it's named after. Worth eyeballing in
`npm start` before committing to a final sort — the same "look at it before
polishing" advice `TERMINAL_CUSTOMIZER_PLAN.md` §2 gave for opacity/blur,
and that one turned out to matter.

**R7 — Absolute paths from other projects will appear.**
Multi-tab sessions on different repos, plus reads under
`AppData\Local\Temp\claude\…`, will show up. `shortPath()`'s
last-two-segments rule keeps them readable, and each row's `title` carries
the full path. See §5.4 for why no filter ships in v1.

**R8 — A `start` with no matching `end` stays lit forever (new, from
§5.6). RESOLVED 2026-08-13 — see §14.1; this entry is kept for the
reasoning, not as the current behaviour.**
If the CLI process is killed, crashes, or a permission prompt sits
unanswered indefinitely between the `tool_use` and `tool_result` entries,
`foldToolEvents()`'s `open` map never resolves that id, so `inProgress`
never flips back to `false` — the row (and its pulse) is stuck live for the
rest of the session. This is the one place §5.6 reopens a "no timer" risk
that §5.3 deliberately avoided.
*Original mitigation (superseded):* `onSessionRestarted` (§6) clears the
whole map, covering the common case (killed CLI ⇒ restarted session); the
narrower live-tab case was accepted as correct-not-a-bug, and no
polling/timeout was added on the reasoning that it would be the widget's
first timer and the failure was rare and self-resolving.
*What actually happened:* Mati's very first manual test hit a row stuck
live past its edit finishing. Whether the root cause was truly a lost `end`
event or something else was never conclusively isolated — real transcript
data sampled afterward showed 100% clean start/end pairing — but regardless
of cause, "the row must never stay lit forever" turned out to matter more
than "no timer," so §14.1 adds the bounded self-heal this entry originally
argued against.

---

## 13. Verification checklist (manual, `npm start`)

- [x] `npm test` green — 362 baseline + the new files, no regressions.
- [x] Tile appears in the right panel under Skill Tracker in `classic`.
- [x] An `Edit` produces a row with **numbers that match `git diff --stat`**
      for that same change. This is the whole feature — check it against a
      real edit, not a synthetic one.
- [x] A `Write` to a **new** file shows `+N` with N = the file's real line
      count, `-0`.
- [x] A `Write` over an **existing** file shows a real `+N -M`, not the
      whole file as additions.
- [x] A `Read` shows a dimmed read-only row with no numbers.
- [x] A **rejected/failed** Edit adds nothing.
- [x] **Live indicator:** kick off a slow/large Edit or Write and confirm
      the row pulses (`.is-live`) between the tool call and its result,
      then stops pulsing and shows real numbers the instant the result
      lands. A brand-new file shows a live zero-stat row before its first
      `end`.
- [x] Two edits to the same file accumulate into **one** row, not two.
- [x] Editing >8 files shows exactly 8 rows plus an accurate `+N more`.
- [x] **Tab switch:** tab A's files stay on tab A; switching to B shows
      B's; switching back restores A's. (This is the §6 session-view check
      and the one most likely to be wrong.)
- [x] Edits made **while a tab is in the background** are present when you
      switch to it.
- [x] Profile/project **restart** empties the tile.
- [x] PL ↔ EN round-trip: title, empty hint and the `+N more` line all
      switch and switch back.
- [x] `__luna.remount('activefiles')` — rows **identical** before and after
      (the §A2c repaint-from-state check), and `busStats()` unchanged (no
      leaked disposer).
- [x] `npx electron . --luna-probe` — `rows.activefiles: 1`, all bus counts
      equal before/after 3× remount.
- [x] `__luna.layout('focus')` then back to `classic` — tile unmounts
      cleanly and returns with its rows intact.

**§14 amendments, checked separately:**
- [x] A row cannot stay `.is-live` for more than `MAX_LIVE_MS` regardless
      of whether its `end` event ever arrives (§14.1).
- [x] A settled row (not `.is-live`) never glows, at any magnitude — the
      `+`/`−` numbers are the only signal (§14.2).
- [x] Deleting a tracked file (outside LunaCore, or via a `Bash rm`/`del`
      the nested session runs) flips that row to `.is-deleted` within one
      `STALE_CHECK_MS` tick, keeps its last known `+`/`−`, and clears back
      to normal if the file reappears (§14.3).

---

## 14. Post-ship amendments (2026-08-13, same day, from Mati's manual test)

The build in §11 shipped and passed §13's checklist and `--luna-probe`
clean. Mati's own manual test pass in `npm start` then found three real
gaps in one sitting — two amendments to what already existed, one genuinely
new capability outside the original scope.

### 14.1 Live-indicator self-heal (amends R8)

*Symptom:* "if its edited it lights up which is amazing, but after
finishing the edit it still is lit up." A row's `.is-live` pulse survived
past the edit visibly completing.

*Fix:* `activefiles.js` gained `MAX_LIVE_MS` (20000) and
`clearStaleInProgress(map, now, maxAgeMs)` — a pure, unit-tested sweep that
forces `inProgress: false` on any row that has been live longer than a real
Edit/Write/Read call could plausibly take. Runs every `STALE_CHECK_MS`
(5000) on the mounted widget's own timer, and once more as a catch-up in
`registerSessionView.load()` for a tab that was backgrounded (no timer runs
off screen). This is the widget's first timer — R8 explicitly argued
against adding one; the argument lost to what actually happened in testing.

### 14.2 Heat glow made exclusive to `.is-live` (amends §5.3)

*Symptom:* "they are still glowing if no works is being done" — the
permanent, magnitude-driven ambient glow §5.3 specified (by design: no
decay, no timer, ratio from total `added + removed`) read as "still lit"
to Mati even once `.is-live` was correctly off.

*Fix:* the `--heat` custom property and its `box-shadow`/`border-color`
CSS are gone from the base `.afile` rule. A settled row is now visually
flat; its `+`/`−` numbers (already colour-coded via `--good`/`--bad`)
remain the sole signal of magnitude, in text rather than glow. Glow is now
`.is-live`'s alone, which is also a simplification: no more "is this glow
the heat or the live state" ambiguity to design around.

### 14.3 Deleted-file indicator (new capability, outside §0's original scope)

*Symptom:* Mati asked LunaCore's nested Claude session to edit and then
delete a file. The edit's `+6/-1` row was correct — but after the file was
actually deleted, the row kept showing `+6/-1` as if nothing had happened.

*Why this needed a real exception to §1/§3.3:* `rm`/`del`/`Remove-Item` is
a **Bash** call — no `file_path` in its `input`, so there is no lifecycle
event to ride, transcript-only. Existence can only be answered by asking
the filesystem, and the renderer has no `fs` access under context
isolation. So, unlike everything else in this plan:

- **New IPC channel**, `files:check-exist` (`ipcMain.handle` in
  `src/main.js`, exposed as `window.lunacore.checkFilesExist(paths)` in
  `src/preload.js`) — batch `fs.existsSync` over the tracked paths, read-only.
- Polled from `activefiles.js`'s existing self-heal timer (§14.1) via a new
  `refreshDeleted()` — no second timer — plus once on mount and once on a
  backgrounded tab's `load()`.
- New pure reducer `applyDeletedFlags(map, existsMap)`, unit-tested
  alongside `clearStaleInProgress`.
- `applyFileEvent` now resets `deleted: false` on any real event for that
  path (a `Write` recreating a deleted file, say) — optimistic, corrected
  by the next existence sweep if wrong.
- Row keeps its stats (the edit still happened) and gains `.is-deleted`:
  struck-through name, dimmed, a static red border (never a glow — nothing
  about a deletion is "live"), and a small `activefiles.deleted` badge.
  Wins over `.is-live` in the CSS cascade on the (implausible) chance both
  are ever true at once.

This is still a **read**, never a write, never network, never a model
call — the same Passive Observer spirit as the rest of the app, just no
longer "rides an existing channel with zero new I/O" the way §1 promised.
That promise held for the diff *stats*; it does not hold for *existence*,
which the transcript structurally cannot express.

---

### Files this plan touches

| Path | Change |
|---|---|
| `src/filestat.js` | **new** — pure diff-stat extraction |
| `src/observer.js` | widen `toolEventsFromLines()` (L316-346) + `foldToolEvents()` (L361-376) |
| `src/renderer/modules/activefiles.js` | **new** — the widget |
| `src/renderer/modules/sessions.js` | 2 routing lines at L99-107 |
| `src/renderer/renderer.js` | 1 import at L31-38 |
| `src/renderer/index.html` | `<template id="w-activefiles">` near L258 |
| `src/renderer/styles.css` | `.afile-*` block near L947 |
| `src/renderer/i18n.js` | 5 keys × 2 languages (~L128, ~L306) |
| `config/layouts.json` | 3 presets (L16, L45-55, L70) |
| `test/filestat.test.js` | **new** |
| `test/activefiles.test.js` | **new** |
| `test/observer.test.js` | extend; 2 assertions updated (L365, L399) |
| `src/main.js` | **§14.3, amendment** — `files:check-exist` IPC handler |
| `src/preload.js` | **§14.3, amendment** — `checkFilesExist` exposed |

**Unchanged, deliberately:** `src/uiprefs.js` — still no new pref, still no
second watcher/timer at the main-process level. (`src/main.js` and
`src/preload.js` were originally on this list too — §14.3 is the one
amendment that touches them, for the reason given there.)

**Status: all done.** §11's original build shipped 2026-08-13 and passed
§13; §14's three amendments shipped the same day from the manual test that
followed. 413 tests, `--luna-probe` clean.
