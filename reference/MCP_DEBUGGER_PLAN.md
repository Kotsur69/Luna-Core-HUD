# MCP debugger, safe half (Reference)

**Status: shipped, partial - code-complete, NOT yet hand-verified.**
`CONCEPT_MCP_DEBUGGER.md` sketched three pieces - live flow mapping, a
JSON-RPC inspector, and a failure-injector/restart gateway. Only the first
two shipped. This is the compact "what shipped and why the third piece
didn't" doc; the concept file stays at root since §3 of it is still a live,
unbuilt idea. Shipped 2026-08-26: 678/678 tests green and `--luna-probe`
confirms a clean mount, but neither can see a real pulse or a real payload
in the inspector - **§6 is the next session's actual work.**

---

## 1. Why the scope split

The concept's own §3 ("Implementation: intercept the stdin/stdout streams of
active MCP processes in LunaCore's main process") turned out to describe
something LunaCore cannot do the way it's written. The MCP servers are child
processes of the `claude` CLI running inside the PTY, not of LunaCore itself
- there is no stdio handle to tap without becoming a proxy that
`~/.claude.json` gets rewritten to point at instead of the real server.

That's a real design, not a dead end, but it breaks a hard line this
project already drew (`src/mcphealth.js`'s own header: config is read-only,
"a bug there breaks Claude Code itself, not just the HUD") and only takes
effect on the next session/server start, not instantly. Mati's call
(2026-08-26): ship the two pieces that need none of that - flow mapping and
the inspector both turn out to be fully answerable from the same transcript
tailing every other widget here already does - and leave the proxy/failure
-injector/restart piece as an explicit, un-built v2 in the concept doc.

Confirmed while scoping this: Claude Code's own `/mcp` command *does* offer
a per-server "Reconnect" action, but only through its interactive menu - not
a plain-text command LunaCore could inject via the existing Action Injector
pattern. So even the "restart" half of §3 has no cheap path today.

## 2. What shipped

- **Live Connection Flow Mapping**: a server's row in the existing MCP
  health panel pulses cyan for the duration of an in-flight call to it.
- **JSON-RPC Inspector**: the last 30 completed calls per tab, newest first
  - server, tool, ok/fail, latency. Click one to open a modal with the
  pretty-printed request and response, capped at ~2KB each with a
  "truncated" notice past that.

Both are Passive Observer, same as the health scan they sit next to: no new
process spawned, no interception, no config touched. The data source is the
transcript's own `tool_use`/`tool_result` pair for each MCP call - the same
structured entries the Skill Tracker (B8) already reads, just for `mcp__*`
names instead of built-in tool names.

## 3. Files

| Path | Role |
|---|---|
| `src/observer.js` | `mcpEventsFromLines()` / `foldMcpEvents()` - splits an `mcp__server__tool` name, pairs the call's `tool_use` with the `tool_result` that closes it (by id), computes latency from the two timestamps. Wired into `TranscriptWatcher` via a new `onMcp` option, same shape as the existing `onTools`. |
| `src/main.js` | New `metrics:mcp` IPC channel, `{ sessionId, events }`, same envelope as `metrics:tools`. |
| `src/preload.js` | `window.lunacore.onMcp(callback)`. |
| `src/renderer/modules/sessions.js` | Routes `onMcp` events active-tab-live vs. background-bucket - the exact split `onTools` already uses. |
| `src/renderer/modules/mcp.js` | `formatPayload()` (pretty-print + reparse-then-format for a JSON-stringified string, capped), `createMcpState()`/`applyMcpEvent()`/`liveServers()` (pure, tested), the live-pulse row class, the calls list, and the detail modal (reuses `sessiontimeline.js`'s modal shape directly, same precedent `.gitquick` reusing `.palette__modal` already set). |
| `src/renderer/index.html`, `styles.css`, `i18n.js` | Markup, the `.mcp-item--live` pulse (reuses `.afile.is-live`'s `afile-pulse` keyframe rather than a new one), PL/EN strings. |

## 4. Gotchas found during the build (worth remembering)

- **A `tool_result` line never repeats the call's name.** There is
  deliberately no `'mcp__'` text prefilter on the whole line in
  `mcpEventsFromLines()` for this reason - every `tool_result` is emitted as
  an end candidate regardless of what closed it, and `foldMcpEvents()` drops
  it as an orphan if nothing MCP was open for that id. A line-level prefilter
  would have silently dropped every real MCP result.
- **A tool result's `content` often arrives as a JSON-stringified STRING**,
  not a parsed object - confirmed against a real transcript line before
  writing `formatPayload()`. Reparsing before pretty-printing is what turns
  that into readable indented JSON instead of one long escaped line.
- **Active-tab-only tracking still needs full per-tab bucket state**, not a
  simple "drop background events" filter - a call that starts on tab A and
  ends after switching to tab B would otherwise leave A's pulse stuck on
  forever with no event left to close it. `registerSessionView`
  (save/load/clear on tab switch) avoids that the same way
  `activefiles.js`/`sessiontimeline.js` already do.

## 5. Explicitly deferred, not built

**Failure injection and the restart button** (concept §2.3) - needs the
`~/.claude.json`-rewriting proxy described in §1 above. If revisited, it's
its own scoped decision (opt-in per server, automatic backup/restore,
restore-on-crash), not a small add to this shipped half.

## 6. Verification checklist (do this before calling it done)

Mati's own MCP usage is rare (the health panel's own finding: only
`codebase-memory-mcp` and the Hugging Face connector have ever fired on
this machine) - so unlike most features here, this one cannot be
hand-verified just by using the app normally for a bit. Trigger a call on
purpose.

1. `npm test` - should still be 678/678 (or more, if this session added
   anything else).
2. `npm start`, open a tab, and make Claude actually call an MCP tool - the
   codebase-memory-mcp server is the known-working one (e.g. ask it to list
   indexed projects). While the call is in flight:
   - the server's row in the MCP health panel (left panel or wherever it's
     placed in the active layout preset) should glow cyan and pulse - if
     the panel is folded/not on screen, open it first, the pulse does not
     retroactively appear once you switch to the layout.
   - once the call finishes, a new row should appear at the TOP of "Recent
     calls" below the server list, and the pulse should stop.
3. Click that new row - the modal should open showing:
   - the server/tool name and an OK badge,
   - a "Request" block with the pretty-printed input (or `{}` for a
     no-argument call),
   - a "Response" block with the pretty-printed result - readable indented
     JSON, not one long escaped string (this is the exact thing
     `formatPayload()`'s reparse step exists for - if it shows as one raw
     line, that step regressed).
   - Escape, the × button, and clicking the backdrop should all close it.
4. Trigger a call that FAILS (e.g. ask for a nonexistent project/resource
   from whichever server is available) - confirm the row and modal badge
   both read as a failure, not silently as OK.
5. Trigger a call whose result is large (a big list/read) - confirm the
   inspector shows a "...fragment cut off" notice under the Response block
   rather than silently truncating with no indication, and that the panel
   does not visibly stutter/freeze while it renders.
6. Background-tab correctness (the trickiest part to get right by
   inspection alone): start an MCP call on tab A, switch to tab B BEFORE it
   finishes, wait for it to finish, then switch back to A. Confirm:
   - tab A's pulse is off (not stuck on) and the call shows up in A's
     "Recent calls" - not tab B's.
   - switching between A and B repeatedly does not mix their call
     histories.
7. Toggle PL/EN (per `data-i18n` keys `mcp.calls.title`, `mcp.calls.empty`,
   `mcp.call.*`) - confirm both languages render sensibly, no leftover key
   names on screen.
8. If everything above holds: flip this doc's top status line to
   **"shipped, hand-verified"** with the date, and update
   `FUTURE_PLAN.md`'s "Next action" row to drop the "needs a real MCP call"
   caveat. If something's off, fix it here rather than filing it as a
   separate concept - this doc is the source of truth for what this
   feature is supposed to do.
