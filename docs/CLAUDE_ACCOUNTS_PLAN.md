# Claude accounts - failover + per-account usage meter

Two Claude subscriptions (matitrampolin@gmail.com, mateuszma@onet.pl). When one
hits its 5 h or weekly limit, everything LunaCore runs moves to the other one
and carries on. The HUD meter shows both.

## Resume here

- Phase 1 (failover) is **built, unit-tested, smoke-tested, not committed**.
- Next: Mati adds both tokens -> live failover test (T1-T3) -> Phase 2 probe (P0).

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

- **T1** Settings shows both accounts, the first one "active".
- **T2** matitrampolin first (it is limited now) -> new tab -> any prompt ->
  the limit wall -> yellow `[LunaCore] Usage limit on matitrampolin. Continuing
  on onet.` -> the same conversation answers. Settings: matitrampolin "limited
  until ...".
- **T3** God Mode: a run with matitrampolin first -> workers resume on onet,
  the run is not paused.

## Phase 2 - usage meter for both accounts (planned)

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
