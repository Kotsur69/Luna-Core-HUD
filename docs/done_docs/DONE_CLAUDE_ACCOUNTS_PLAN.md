# Claude accounts - failover + per-account usage meter

Two Claude subscriptions (matitrampolin@gmail.com, mateuszma@onet.pl). When one
hits its 5 h or weekly limit, everything LunaCore runs moves to the other one
and carries on. The HUD meter shows both.

> **✅ DONE (2026-11-06).** Phase 1 failover (`1d05f8a`, limit-wall fix `85d1451`) and Phase 2
> per-account usage meter (`25334d3`, merge `ea5b877`) are built and live-checked by Mati
> (T1 2026-11-02; T2, T3 and the Phase 2 check 2026-11-06). Usage-login renewal now uses a real
> OAuth refresh-token grant (`11ea645`); compact usage-limits tile shipped in `84276f8`.

## Leftover (setup, not build work)

- Home PC: add both tokens again (they are encrypted per PC).

## Mechanism (verified live, CLI 2.1.316)

- `claude setup-token` mints a long-lived OAuth token for the account the
  browser is signed in to.
- `CLAUDE_CODE_OAUTH_TOKEN=<token>` overrides the stored `/login` **per
  process**; `auth status` then reports `authMethod: "oauth_token"`.
  `CLAUDE_CONFIG_DIR` stays `~/.claude`, so both accounts share the whole
  harness. Nothing in `~/.claude` is copied, swapped or trimmed.
- `claude --resume <id>` keeps writing into the same `<id>.jsonl`, so a resumed
  tab keeps its transcript watcher, context bar and limit detection.

## Phase 1 - failover (done)

| Piece | Where |
|-------|-------|
| Encrypted account store (safeStorage), order = preference, cooldowns | `src/claudeaccounts.js` |
| Token injected into every plain-Claude launch (skipped for provider profiles / API keys) | `src/sessionenv.js` `setAccountLayer` |
| Tab / God Mode worker hits limit -> restart on next account with `--resume` + "continue" | `src/main.js` `failoverTab`, `src/launch.js` `withAccountResume` |
| God Mode planner + Luna's Work steps retry on next account (~3 s) | `src/orchestra.js`, `src/lunaswork.js` |
| Settings -> AI providers -> Claude accounts | `src/claudeaccountsipc.js`, `modules/claudeaccountsettings.js` |

Rules: first free account in the list is active; back to the preferred one once
its reset passes; all limited -> old behaviour (wait for the earliest reset).
Loop guard: one tab never fails over twice from the same account within 60 s.

Verified: 16 unit tests + full suite (4180 pass); in-process smoke run of the
real app (IPC add/list/remove, wrapped-token paste, encrypted file, no token in
the renderer, env layer on/off, Settings rows render); security review (no
CRITICAL/HIGH; setup-token tab no longer inherits a token).

### Live test (needs the tokens)

- **T1** Settings shows both accounts, the first one "active". ✅ passed 2026-11-02.
- **T2** ✅ passed 2026-11-06. matitrampolin first (it is limited now) -> new tab -> any prompt ->
  the limit wall -> yellow `[LunaCore] Usage limit on matitrampolin. Continuing
  on onet.` -> the same conversation answers. Settings: matitrampolin "limited
  until ...".
- **T3** ✅ passed 2026-11-06. God Mode: a run with matitrampolin first -> workers resume on onet,
  the run is not paused.

## Phase 2 - usage meter for both accounts (built 2026-11-05, merged `ea5b877`, live-checked 2026-11-06)

### What was built (branch `luna/usage-all-accounts-qy902`, merged into `main`)

P0 answered: a setup-token token gets **403** on `GET /api/oauth/usage` (no
`user:profile` scope). So instead of the header fallback below, each account
gets a **usage-only login** (`claude auth login` under
`CLAUDE_CONFIG_DIR=~/.claude-usage-<id>`), used for nothing but that GET.

| Piece | Where |
|-------|-------|
| Per-account read, stagger, 401/403 -> reconnect, renewal, connect | `src/claudeaccountusage.js` |
| `usageDir` / `usageEmail` per account (path only, inside home) | `src/claudeaccounts.js` |
| IPC (id only crosses) | `src/claudeaccountsipc.js`, `src/preload.js` |
| Watcher hook (payload gains `accounts`) | `src/usage.js` `UsageWatcher.accountUsage` |
| One block per account, active dot + tag, reconnect note | `src/renderer/modules/usage.js` |
| Connect usage / Use main login / Reconnect / Disconnect | `src/renderer/modules/claudeaccountsettings.js` |
| Phone rows per account (old readers unchanged) | `src/usagesnapshot.js`, `mobile/src/views/usage.js` |

Layout: one block per account (name, then its 5 h + weekly bars), not the
window-grouped layout sketched below.

**Renewal (fixed `11ea645`).** `claude auth status` turned out not to refresh the
token (checked 2026-11-05), so `src/claudeoauthrefresh.js` now does a real OAuth
refresh-token grant for each usage login.
The main `~/.claude` login is never touched.

Live check: connect both accounts in Settings -> the gauge shows two labelled
pairs, the active one marked; let a usage login expire (or delete its
`.credentials.json`) -> only that account says *reconnect*; watch the log
around the token's `expiresAt` to see whether `auth status` renewed it.

### Original plan

### Layout (approved by Mati)

```
USAGE LIMITS                              ⟳  updated 12s ago
5-hour
 ● onet          ▓▓▓▓▓░░░░░░░░░   34%   2h 10m
   matitrampolin ▓▓▓▓▓▓▓▓▓▓▓▓▓▓  100%   1h 05m   <- red bar
Weekly
 ● onet          ▓▓▓░░░░░░░░░░░   21%   4d 3h
   matitrampolin ▓▓▓▓▓▓▓▓░░░░░░   58%   2d 19h
```

- Grouped by window; one line per account: name, bar, %, reset.
- Reset in a fixed-width right column, dim; full colour when that account is
  limited (the only time it matters).
- `●` = active account. Narrow widths: reset wraps under the bar.
- No accounts configured -> the meter is exactly today's.

### Data

- **P0 probe (first, decides the rest):** `GET /api/oauth/usage` with a
  setup-token token. The `/login` token carries `user:profile`; setup-token
  tokens are expected to be inference-only, which may give 403.
  - Works -> poll each account like today (zero quota).
  - 403 -> read the `anthropic-ratelimit-unified-*` headers (5 h / 7 d
    utilization + reset). Try the free `count_tokens` endpoint first; else a
    1-token Haiku call every ~15 min for non-active accounts only.
- New `src/usageaccounts.js` (keeps `main.js` from growing): per-account poll,
  and real reset times feed the failover cooldowns (limits clear on their own).
- The 80/95 % voice alerts and the phone `usage` snapshot follow the active
  account only.

### Steps

1. P0 probe with both tokens.
2. `usageaccounts.js` + tests (grouping, ordering, 403 fallback, cooldown sync).
3. `modules/usage.js` grouped renderer + styles (ui-ux-pro-max pass).
4. Full suite, reviewer pass, live check with both accounts -> rename this doc
   `DONE_CLAUDE_ACCOUNTS_PLAN.md`.

## Known gaps

- The active token is in every tab's env, so Claude's own Bash tool can read it.
  That's no wider than `~/.claude/.credentials.json`, which is already readable.
- After copying a token, close the `setup-token` tab (the token stays in its
  scrollback).
