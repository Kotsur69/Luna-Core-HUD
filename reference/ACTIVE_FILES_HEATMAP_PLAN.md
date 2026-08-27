# Active-Files Edit Heatmap (Reference)

**Status: shipped, done.** This used to be a 791-line build plan (decision
table, transcript research, build order, a 14-item risk log, and a manual
test checklist). That's all history now — the code is the source of truth.
This is the compact version: what the feature does, where the data comes
from, which files implement it, and the gotchas worth remembering if you
touch it again. Compacted 2026-08-18.

---

## 1. What it does

A tile in the right panel (`src/renderer/modules/activefiles.js`) listing
files touched in the **active session only** (no persistence, resets with
the tab — same scoping as the context bar):

- **Real `+`/`-` line counts per file**, git-diff-stat accurate — not a
  blink, not a frequency tally.
- **Live indicator**: a file between its tool call and the result pulses
  (`.is-live`) before any stat is known.
- **Read-only rows** (touched, not changed) render dimmed, no numbers.
- **Deleted-file indicator**: a file removed outside an Edit (e.g. a nested
  `Bash rm`) flips to `.is-deleted` — struck-through, stats kept.
- Sorted: live rows first, then changed-ahead-of-read-only, then recency.
  `MAX_ROWS = 8`, overflow shown as an honest `+N more` (never hidden
  silently).

## 2. How it works — the data source is the whole trick

**Zero-token, no new I/O.** `TranscriptWatcher.accumulate()`
(`src/observer.js`) already parses every `tool_use`/`tool_result` line. This
feature just reads more fields off objects already parsed, and rides the
existing `metrics:tools` IPC channel — no second watcher, no disk read of
the edited files.

The `tool_result` entry carries a top-level `toolUseResult` object with a
**`structuredPatch`** — a unified diff the CLI already computed. Counting
`+`/`-` lines in it gives exact git-diff-stat numbers, and it beats diffing
`old_string`/`new_string` ourselves: an LCS over the two snippets counts a
one-word typo fix in a 40-line block as `+40 -40`; `structuredPatch` reports
`+1 -1`, same as `git diff --stat` would. `structuredPatch` is the primary
path; a line-level LCS (`countStringDiff`, capped at `MAX_DIFF_LINES` to
avoid an O(n·m) table on the watcher's 1.5 s tick) is the fallback only.

`Write` distinguishes new-file (`type: 'create'`, pure additions from
`content`) vs overwrite (`type: 'update'`, real `structuredPatch`) — no `fs`
read-after-write needed either way. `Read` contributes `+0 -0`, a
touch/recency signal only.

## 3. Files

| Path | Role |
|---|---|
| `src/filestat.js` | Pure diff-stat extraction (`countPatch`, `countLines`, `countStringDiff`, `fileStatFromEntry`) |
| `src/observer.js` | `toolEventsFromLines()` / `foldToolEvents()` widened to carry `file`/`added`/`removed` |
| `src/renderer/modules/activefiles.js` | The widget: reducer, render, self-heal timer, deleted-file poll |
| `src/renderer/modules/sessions.js` | Routes tool events to the widget alongside Skill Tracker |
| `src/main.js` / `src/preload.js` | `files:check-exist` IPC — batch `fs.existsSync`, read-only (§5) |
| `config/layouts.json` | Widget placed in `classic`, `monitor-heavy`, `bottom-dock` (omitted from `focus`) |

No new `uiprefs.js` entry — this widget has no filter and no persisted
content, matching every other zero-config right-panel widget.

## 4. Known limitations (accepted, not bugs)

- **A resumed session (`--continue`) starts empty.** The watcher's
  `firstPass` guard deliberately suppresses replay of history — otherwise
  every row would light at once and "recency" would mean nothing.
- **MCP file-editing tools are invisible.** `toolEventsFromLines()` only
  recognizes tools mapped in `TOOL_TO_TILE`; an MCP editor's result becomes
  an orphan and is dropped. The tile under-reports in an MCP-heavy session.
- **`toolUseResult` is an undocumented CLI artefact**, not part of the
  Anthropic messages API — it's Claude Code's own resume/undo bookkeeping
  and can change shape in any release. If it does, `fileStatFromEntry()`
  degrades to `{0,0}`/`null` and the row goes dim rather than throwing.
- **Cross-project absolute paths will appear** in multi-tab sessions.
  `shortPath()`'s last-two-segments rule keeps them readable; the row's
  `title` carries the full path. No path filter in v1 (would need the same
  `hideSystemPorts`-style toggle `ports.js` has — a second feature).

## 5. Post-ship amendments (2026-08-13, same day, from manual testing)

Three real gaps Mati found in his first `npm start` pass:

1. **Live-indicator self-heal.** A row's `.is-live` pulse could survive past
   the edit actually finishing (root cause never conclusively isolated — real
   transcript sampling showed clean start/end pairing). Fixed with
   `MAX_LIVE_MS` (20s) + a pure `clearStaleInProgress()` sweep on a timer —
   the widget's first timer, added because "never stay lit forever" mattered
   more than "no timer" once it was actually observed.
2. **Heat glow removed.** The original design gave every row a permanent
   magnitude-driven glow (no decay, by design). It read as "still lit" even
   once `.is-live` was correctly off. Glow is now `.is-live`'s alone; a
   settled row's `+`/`-` numbers (color-coded) are the only signal left.
3. **Deleted-file indicator.** A `Bash rm`/`del` has no `file_path` in its
   tool input, so there's no transcript lifecycle event for it — existence
   can only be answered by asking the filesystem. This is the one place the
   feature breaks its own "no new I/O" rule: a new `files:check-exist` IPC
   batch-checks `fs.existsSync` on tracked paths, polled off the same
   self-heal timer (no second timer).

**413 tests**, `--luna-probe` clean.

## 6. Accumulated diff viewer (2026-08-27, follow-up to the git-sourced signal)

Clicking a **CHANGED** or **DELETED** row opens a read-only modal
(`#filediff-modal`, third instance of the `#stimeline-modal` overlay
skeleton) showing that file's accumulated `git diff HEAD -- <file>` — the diff
*behind* the `+`/`-` numbers the row already shows. Pure read-only rows stay
inert: there is no diff to show, so they get no cursor and no button
semantics.

- **Scope / Passive Observer.** Same class as `files:check-exist`: `git diff`
  is a local disk read — zero tokens, zero PTY writes, no watcher — and it
  runs *only* on an explicit user click, never on a timer. Renderer has no
  `child_process`, so the text comes over a new `files:diff` IPC channel from
  main, which reuses `src/gitfiles.js`'s `git()` helper (no second way to
  shell out).
- **HEAD as the base.** `git diff HEAD -- <file>` matches the
  `git diff HEAD --numstat` the numstat signal already uses, so the modal
  shows the diff behind the *same* number. A deleted row's `git diff HEAD`
  already renders the full removal — the click just has to still fire.
- **Untracked files.** Nothing to diff against HEAD, so the handler falls back
  to `git diff --no-index -- /dev/null <file>` (exits 1 by design, real
  all-`+` output). Gated on `git ls-files --error-unmatch` first, so a
  tracked-but-clean file shows the honest empty state instead.
- **Security guard.** `file` is renderer-supplied. `pathInsideCwd()`
  (`src/gitfiles.js`) `path.resolve`s it against `session.cwd` and rejects
  anything that escapes (`reason: 'outside'`) — the handler never diffs an
  arbitrary path. Non-git dir / no HEAD / git failure return
  `{ ok: false, reason }` and the modal shows the empty / not-a-repo string,
  never a crash.
- **Size cap.** ~20000 chars (diffs run bigger than turn text); past that the
  reply sets `truncated` and the modal shows the same truncated-hint pattern
  as the timeline / MCP modals.
- **Files.** `src/filediff.js` (new — pure `classifyDiffLine` / `parseDiff`,
  raw stdout → `{ lines: [{ kind, text }], truncated }` for the renderer to
  paint, `createElement` per line, never `innerHTML` with git output),
  `src/gitfiles.js` (`git` + `pathInsideCwd` exports), `src/main.js`
  (`files:diff` handler), `src/preload.js` (`getFileDiff`),
  `src/renderer/index.html` (`#filediff-modal`), `src/renderer/styles.css`
  (`.filediff__add` / `__del` / `__hunk`), `src/renderer/modules/activefiles.js`
  (clickable rows + modal), `src/renderer/i18n.js` (`activefiles.diff.*`,
  PL + EN).

### Manual checklist (DOM / modal — same style as §5)

- [ ] Click a **CHANGED** row → modal opens with the accumulated diff, add
      lines green, del lines red, `@@` / `diff --git` headers dim, context
      plain.
- [ ] Click a **DELETED** row → modal shows the full removal diff.
- [ ] Click a **pure read-only** row → nothing happens (no cursor, no modal).
- [ ] Untracked file (created via Bash) → modal shows an all-`+` diff of the
      new content.
- [ ] Non-git directory / repo with no commits → modal shows
      "No changes to show" / "Not a git repository", no crash.
- [ ] **Esc**, the **×** button, and a **backdrop** click each close the modal.
- [ ] A diff over ~20000 chars → the truncated hint shows under the `<pre>`.
- [ ] PL / EN: title, empty string, not-a-repo string, truncated hint, close
      tooltip all switch with the language.
