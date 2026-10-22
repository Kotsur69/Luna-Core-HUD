# Notification hub ("Needs you") - plan

> **🟡 OPEN (2026-10-22).** Planned, not built. Answer the *Open questions*
> first, then build slice by slice (N1 → N6). Rename to
> `DONE_NOTIFICATION_HUB_PLAN.md` when every slice is built and live-checked.

Same rules as every other plan in this repo: zero extra tokens (the hub only
*reads* what other modules already produce), config-driven, a broken source
yields no items rather than a crash, pulled cloud rows are untrusted, and new
user-facing strings need `pl` + `en`.

## Resume here

- Nothing built yet. Start with the *Open questions* (one AskUserQuestion
  round), then **N1**.
- UI slices (N2, N3) go through the `ui-ux-pro-max` skill first (Mati's
  global rule for UI work). Smoke-test with the in-process Electron wrapper
  (memory: "Smoke-test UI without a CDP port").

## Goal (Mati, 2026-10-22, his words condensed)

1. When God Mode finishes it sends an email. The same thing should show up
   **as a window when I launch LunaCore on any other PC**.
2. A **notification symbol with a count** (like "! 1") listing **everything
   that needs my attention**: the God Mode summary, clicking through sleep,
   and the like.
3. Not Ctrl+Shift+M: **a little face icon** somewhere; clicking it opens a
   window with everything I need to click. Right now it looks horrible with
   white bars.
4. The summary should open as a **vertical window** with everything I need to
   know. Today it clutters the Mission Control panel and squeezes GitHub
   telemetry and the other columns to half height.

## What exists today (verified in code, 2026-10-22)

| Piece | Where | What it gives the hub |
|---|---|---|
| Run report | `src/orchestraReport.js` → `<config>/runs/<plan>.md` + `.html` (`src/reportHtml.js`) | `## Needs you`, `## Manual actions`, merged / pushed, self-check. **Only on the PC that ran it.** |
| Run email | `src/godmodemail.js` | "Needs you" first, the HTML report attached. Dedupe in `mail-state.local.json`. |
| Run history in the cloud | `src/godmodesnapshot.js` (`godmode` snapshot, last 10 runs per machine) via `src/snapshotputs.js` | Per run: repo name, pushed / merged / skipped / blocked, `manualActions` **as a count only**, self-check state, packages, PR links. Plus `live` (current run) and `tabs` (status lights). |
| Live run push | `src/godmodelivepub.js` | Urgent changes at once, heartbeat while running. |
| Open report | `orchestra:openReport` (`src/preload.js` `openOrchestraReport`) | Opens the local report. |
| Power countdowns | `src/orchestraPower.js` | Sleep-at-limit (60 s) and shutdown-when-done (120 s) countdowns, each with Cancel. Board only. |
| Plan wait | `src/orchestraPlanWait.js` | "Planning resumes at HH:MM" + Cancel. Board only. |
| OS toasts | `src/renderer/modules/notify.js` | Busy → idle and context ≥ 85 % toasts, opt-in. |
| Brief strip | `src/renderer/modules/missionbriefview.js` in `#mission-brief` (above the Mission Control columns) | **The cause of the "half window" complaint**: weekly / daily brief headline, priorities, events, to-dos, mail, news. |
| Other attention sources | `lifecheckin.js`, `lifegoals.js`, bills (`renderer/modules/lifebills.js`), `weeklyreview.js`, `nightlydigest.js`, `update.js`, `usage.js` / `providerusage.js`, `cloudsync.js` status, `gcal.js` (Google disconnected), `hostsetup.js` ("Needs setup"), to-do cards with `manual: true` | Each already knows whether something waits for Mati. |

Gap: nothing collects these in one place, and **no other PC can see a run's
"Needs you" / "Manual actions" text**. The snapshot only carries counts.

## Decisions proposed (confirm in the Open questions round)

| Topic | Proposal |
|---|---|
| Entry point | A small **Luna face icon** in the top palette bar, next to the Mission Control / Life chips (`#mission-open`, `#life-open` in `index.html`), with a **badge**: number of open "Needs you" items, hidden at 0. Plus a shortcut (candidate **Ctrl+Shift+H**; K, M and N are taken; verify H is free in `shortcuts.js` and in the terminal). |
| Window shape | A **vertical drawer** docked to the right edge, full window height, ~420 px wide (resizable, width saved in `ui.local.json`). The terminal stays visible and usable next to it. Not a modal. |
| Look | Theme tokens only (`--bg`, `--panel`, `--accent` ... from `themes.json`): no hard-coded white, so it matches every theme. Glass themes get the acrylic panel. Cards, not bars. |
| Sections | 1. **Needs you**: actionable items, each with one primary button. 2. **Briefs**: the weekly / daily brief, **moved out of Mission Control**. 3. **Recent**: done / FYI items from the last 7 days, collapsed by default. |
| Cross-PC | The run PC puts a run's Needs-you and Manual-action **lines** into the `godmode` snapshot (v2, capped and scrubbed). Every other PC reads the other machines' rows and shows them as items "from <machine>". |
| Seen / done state | Synced, so dismissing on one PC clears it everywhere: `sync_units` scope `config`, key `hub:done:<itemId>` (newest wins, like the other config units). No new table, no migration. |
| Auto-open on launch | Open the drawer once at startup when there are **unseen** Needs-you items (setting: *always / only when something needs me / never*; default "only when something needs me"). |
| OS toast | One native toast per **new** Needs-you item while the window is unfocused, through the existing `notify.js` opt-in. No new popup system. |

## The hub item (one shape for every source)

```js
/**
 * @typedef {object} HubItem
 * @property {string} id        stable: `<source>:<key>`, e.g. 'gm:p1a2b3:needs:0', 'life:checkin:2026-10-22'
 * @property {'needs'|'brief'|'info'} kind   which section
 * @property {string} source    'godmode' | 'power' | 'planwait' | 'life' | 'bills' | 'mail' | 'usage' | 'cloud' | 'google' | 'host' | 'update' | 'todo'
 * @property {string} title     one line, text only (never HTML)
 * @property {string} [detail]  optional second line, capped
 * @property {string} [machine] set when it came from another PC's snapshot
 * @property {number} at        epoch ms (sort: needs first, then newest)
 * @property {{label:string, action:string, arg?:string}} [primary]  action is a whitelisted name
 * @property {boolean} [local]  true = the action only works on this PC (power countdown, plan wait)
 * @property {number} [expiresAt] items like countdowns disappear on their own
 */
```

**Actions are names from a fixed whitelist**, resolved in the renderer to the
IPC that already exists: `openReport(planId)`, `cancelPower()`,
`cancelPlanWait()`, `openTab(sessionId)`, `openLife(tab)`,
`openMission(column)`, `openSettings(section)`, `installUpdate()`,
`markDone(id)`. Never a URL or command from a synced row. A remote item
(another PC) only gets `markDone` plus a "full report: in your email / on
<machine>" note.

## Sources → items (v1 list)

| Source | Item | Kind | Primary action | Clears when |
|---|---|---|---|---|
| God Mode run finished (local) | "God Mode: <repo> - 5 of 6 merged" + each Needs-you line | needs (when Needs-you is not empty), else info | Open report | Marked done |
| God Mode run finished (other PC) | Same, "from KT-PC-LLM" | needs / info | Mark done | Marked done (synced) |
| Manual actions in a run | One item per line ("apply migration X") | needs | Open report | Marked done |
| Worker waiting on approval | "<package> waits for an approval" | needs | Open tab | Approval answered |
| Sleep / shutdown countdown | "PC sleeps in 0:45" (live countdown) | needs, local | Cancel | Countdown ends / cancelled |
| Plan waiting for the reset | "Planning resumes at 14:05" | info, local | Cancel wait | Planning starts |
| Life check-in not done today | "Daily check-in" | needs | Open Life | Check-in saved |
| Weekly goals not set (Monday) | "Set this week's 3 goals" | needs | Open Life → Week | Goals saved |
| Bill due within 3 days / overdue | "Gas 400 zl due Friday" | needs | Open Life → Bills | Marked paid |
| Weekly review ready (Sunday) | "Weekly review is ready" | brief | Open Life → Week | Opened |
| Weekly / daily brief | The brief card itself (moved from Mission Control) | brief | Brief me / Regenerate | - |
| Mail "needs your call" | "3 mails need your call" | needs | Open Mission → Mail | Scan applied |
| Usage ≥ 80 % / 95 % | "Claude weekly at 92 %, resets Mon 09:00" | info | - | Window resets |
| Cloud logged out / sync error | "Cloud sync is off: log in" | needs | Open Settings → Cloud | Logged in |
| Google disconnected | "Google disconnected: reconnect" | needs | Open Settings → Google | Connected |
| Host needs setup | "Luna host on this PC needs setup" | needs | Open Settings → Host | Paired |
| Update available | "LunaCore 0.18.0 is ready" | info | Install | Installed |
| `[Mati]` manual to-do cards | Count: "4 manual to-dos" | info | Open To-do | None left |

Each row is a small pure **collector** `(state) → HubItem[]`, so a broken
source returns `[]` and is unit-tested on its own.

## Architecture

```
 main process                                     renderer
 ───────────────────────────────────────          ─────────────────────────────
 src/hubcollect.js   pure collectors per source   src/renderer/modules/hubicon.js
 src/hub.js          merge + sort + done-filter     face icon + badge in the palette bar
                     + dedupe, emits 'hub:changed'  src/renderer/modules/hubpanel.js
 src/hubpeers.js     other PCs' godmode rows →      right drawer: Needs you / Briefs / Recent
                     items (untrusted, re-cleaned)  (missionbriefview.js mounted here)
 src/hubipc.js       hub:list, hub:done,          preload: hubList(), hubDone(id),
                     hub:changed (push)             onHubChanged(cb), hub action calls
 src/hubdone.js      `hub:done:<id>` units via
                     configsync / cloudsync
```

- `src/main.js` is 3522 lines: wire the hub with **one `register()` call**
  (same as `cloudipc.js`), with no logic inside main.
- Sources push into the hub through hooks they already have (orchestra
  `commit()`, `orchestraPower` countdown state, the plan waiter's `onChange`,
  life IPC saves, usage poll, update events) or are polled at most every 60 s.
  No new file watchers.
- `hub:list` returns items already capped and cleaned. The renderer renders
  with `textContent` only.
- **IPC boundary** (`ecc:security-reviewer` before commit): `hub:done` takes an
  id string only (regex `^[a-z]+:[A-Za-z0-9:._-]{1,120}$`), and actions go
  through the existing, already-validated IPC handlers, never a generic
  "run action" channel.

## Slices

### N1 - Hub core + collectors (main, no UI)
- `hub.js`, `hubcollect.js`, `hubipc.js`, preload methods; collectors for
  godmode (local), power, planwait, life check-in, goals, bills, update.
- Done state local first (`hub-done.local.json`), synced in N4.
- Tests: every collector (empty / broken / normal input), sort order, dedupe,
  done filter, id regex.
- **Done when** `hub:list` returns the right items in a test harness and
  `npm test` is green.

### N2 - Face icon + badge (renderer)
- `hubicon.js`: icon in the palette bar next to the Mission Control / Life
  chips, badge = open `needs` count, pulses once when the count goes up
  (respect `prefers-reduced-motion`). Shortcut (Open question 3).
- **Done when** the badge follows `hub:changed` live and the shortcut toggles
  the drawer.

### N3 - Vertical drawer + move the brief out of Mission Control
- `hubpanel.js`: right drawer, three sections, card per item, one primary
  button, "Mark done", relative times, "from <machine>" chip.
- Mount `missionbriefview.js` in the drawer's Briefs section and **remove
  `#mission-brief` from the Mission Control overlay**, so the columns get
  their full height back. Keep the Mission Control chip; drop nothing else.
- Theme tokens only; check it on Luna, Holo, Tokyo Night, Void and one glass
  theme (no white bars).
- **Done when** a smoke screenshot shows the drawer on 3 themes and Mission
  Control's columns are full height.

### N4 - Across PCs
- `godmodesnapshot.js` **v2**: each run also carries `needsYou: string[]`
  and `manualActionLines: string[]` (max 10 each, 200 chars, paths scrubbed
  with `scrubPaths`, control characters out). A v1 row still reads (counts
  only, "details in your email").
- `hubpeers.js`: read the other machines' `godmode` rows (same pattern as
  `src/missionnewspeers.js`), turn their runs into items with `machine` set.
- `hubdone.js`: `hub:done:<id>` as `config` units, so "Mark done" on the
  home PC clears it on the work PC. Prune keys older than 30 days.
- Auto-open on launch when unseen Needs-you items exist (setting).
- **Done when** a run finished on PC A shows on PC B at launch, and marking
  it done on B clears it on A after the next sync.

### N5 - The rest of the sources + toasts
- Collectors for mail needs-call, usage ≥ 80 / 95 %, cloud / Google
  disconnected, host needs setup, `[Mati]` to-dos, weekly review.
- New Needs-you item while unfocused → one toast through `notify.js`
  (respects its opt-in), click focuses the window and opens the drawer.
- **Done when** each collector has tests and a toast shows once per new item.

### N6 - Settings + polish
- Ctrl+L → "Notification hub": auto-open (always / only when needed /
  never), toasts on / off, per-source on / off (a friend without Life turns
  it off), drawer width reset.
- README section, pl + en strings, `npx electron . --luna-probe` clean
  (subscriber counts equal before / after remount).
- **Done when** every setting works and the probe is clean.

### Later (not v1)
- Same items on the phone's Today page (the phone already reads the
  `godmode` snapshot).
- Snooze ("remind me tomorrow").
- Act on another PC's item (cancel its sleep countdown) through host commands.

## Open questions (ask before N1)

1. **Auto-open on launch:** only when something needs you (proposed), or
   always / never?
2. **Which sources in v1?** The table above is everything; anything to drop
   (e.g. usage %, update available) or add?
3. **Shortcut:** Ctrl+Shift+H, or none (icon only)?
4. **The brief:** move it fully into the drawer (proposed), or keep a
   one-line headline in Mission Control too?
5. **Other PCs' runs:** show every run (as FYI) or only runs with Needs-you
   lines?
6. **Face icon:** reuse Luna's avatar art, or a simple line-drawn face that
   follows the theme accent?

## Risks

- **Badge fatigue.** If everything is "needs", nothing is. Keep `needs` for
  things with a clear action; usage and updates stay `info`.
- **Stale cross-PC items.** A run PC that never syncs again leaves items
  forever; "Mark done" clears them, and runs older than 14 days drop to
  Recent.
- **Brief move breaks muscle memory.** The Mission Control chip can show a
  small "brief moved to the hub" hint once.
- **main.js size.** Everything lives in new `hub*.js` modules; main gets one
  `register()` call.

## Verification

```bash
npm test                      # collectors, merge, done filter, snapshot v2 parsing
npx electron . --luna-probe   # hub widgets remount cleanly
npm start                     # drawer on 3 themes; a finished run on PC A shows on PC B
```
