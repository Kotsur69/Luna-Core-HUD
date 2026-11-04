# Claude accounts - failover + per-account usage meter

Two Claude subscriptions (matitrampolin@gmail.com, mateuszma@onet.pl). When one
hits its 5 h or weekly limit, everything LunaCore runs moves to the other one
and carries on. The HUD meter shows both.

## Resume here

- Phase 1 (failover) is **built, unit-tested, smoke-tested, not committed**.
- Phase 2 (per-account meter) is **built and unit-tested, not verified live** - see its Status.
- Next: Mati adds both tokens -> live failover test (T1-T3) -> Phase 2 live check (U1-U4).

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

## Phase 2 - usage meter for both accounts (built, needs the live check)

### Status (2026-11-04, branch `luna/multi-gm-accounts-r1jqz`)

Built and unit-tested (`test/usageaccounts.test.js`), but **not verified live**. The P0 probe
could not run from the build session: the tokens live encrypted in
`claude-accounts.local.json` (safeStorage, readable only by the Electron process), and no token
was printed or copied out to probe by hand. So both paths are built, and the app decides at
runtime:

| Piece | Where |
|-------|-------|
| Probe + per-account poll + header fallback + cooldown sync | `src/usageaccounts.js` |
| Hook in the watcher (payload gains `accounts`) | `src/usage.js` `UsageWatcher.accountUsage` |
| Wiring (tokens stay in main; reset -> `setLimit` + registry) | `src/main.js` `startUsageWatcher` |
| `setLimit(id, until)`, main-only `usageCredentials()` | `src/claudeaccounts.js` |
| Grouped rows, active dot, limited reset in colour | `src/renderer/modules/usage.js`, `styles.css` |

How it behaves:
- **Probe:** the active account's token makes the first `GET /api/oauth/usage` of each app run.
  When it is refused, a second account is asked, so one revoked token does not decide for all.
  - 200 -> `usage` mode: every account is polled every 2 min.
  - 401/403 -> `headers` mode.
  - No clear answer (network, 429, 5xx) -> probe again after its backoff (Retry-After).
- **Headers mode:** first `POST /v1/messages/count_tokens`, which is free and every 5 min.
  - If that carries no `anthropic-ratelimit-unified-*` headers: a 1-token `claude-haiku-5-5`
    call every 15 min, only for non-active accounts.
  - The active account's row keeps its last reading.
- **Cooldown sync:** a wall sets the cooldown to the real reset, in claudeAccounts and in God
  Mode's memory.
  - A wall is raw utilization ≥ 100 on the usage endpoint, or a `rejected` status in the
    headers. The header number alone never counts as a wall: its scale is unverified.
  - It replaces the CLI's one-hour guess, but never shortens a longer cooldown, which may be a
    wall the meter can't see (an Opus window, overage).
  - Only a cooldown the meter set itself is ended early, by every window under 90 %. A cooldown
    the CLI set runs to its own time, so failover never flaps on a limit the meter doesn't model.
- **Active account:** alerts and the phone snapshot use its numbers when it has a fresh reading
  (under 20 min old); otherwise the `/login` meter as before.

Not verified - check these on the first run:
1. **Probe result:** look in the main log for `[usage-accounts] probe:`.
2. **Header names and format:** utilization is assumed to be a 0..1 fraction (a value above 1 is
   read as a percent), and the reset epoch seconds.
3. **Does `count_tokens` carry the unified headers with an OAuth token?** The log says
   `count_tokens carries no rate-limit headers` when it doesn't.
4. **Does a limited account's 429 on `/v1/messages` carry the headers?** It is read as the wall
   when it does.
5. **Does the Claude Code system prompt on the 1-token call satisfy the OAuth check**, and is
   `thinking: {type: 'disabled'}` accepted on Haiku 5.5?
6. **The layout at the real HUD width.** Below ~280 px of tile the reset wraps under the bar.

### Live check (needs both tokens)

- **U1:** with both accounts set up, the meter shows 5-hour and Weekly groups with a row each,
  and a dot on the active one.
- **U2:** with matitrampolin limited, its reset is red and it stays off the active spot. Settings
  shows "limited until" at the real reset, not the guessed hour.
- **U3:** after its 5 h reset, the next reading clears the cooldown, and new tabs go back to
  matitrampolin without a Settings clear.
- **U4:** remove both accounts -> the meter is exactly the old one.

After U1-U4 pass -> rename this doc `DONE_CLAUDE_ACCOUNTS_PLAN.md`.

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
