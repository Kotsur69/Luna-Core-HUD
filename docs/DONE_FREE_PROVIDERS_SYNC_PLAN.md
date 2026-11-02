# Free providers + Luna sync — plan

> **✅ DONE (2026-10-22).** S0-S3 built, released in v0.17.0 and live-checked by Mati. Small follow-ups (FreeLLMAPI port, gateway status row, overlay copy skip) are cards in the to-do list.

Status: **S0-S3 built, tested and pushed** (2026-10-20, commits
326a3e1..7323279). Mati's live click-through passed 2026-10-22; released in v0.17.0. Related, built by the God Mode run and merged 2026-10-21:
free-model fallback chains + the "Free providers" God Mode mode
([`FREE_PROVIDERS.md`](FREE_PROVIDERS.md)) and usage rows for Codex / Gemini
/ GLM / Kimi - none live-checked yet.

## Resume here

- ~~**Live check (Mati):**~~ ✅ passed 2026-10-22: restart LunaCore, add a Gemini CLI profile with
  "Use my Luna setup" on, Google login + trust once, ask "who are you?" -
  must answer as Luna. Same for a FreeLLMAPI profile with the unified key.
- **Built 2026-10-22 (package freellm-gateway), not live-checked:**
  configurable FreeLLMAPI port (Settings > AI providers, saved in
  `config/freellm.local.json`, applied to every `freellm-*` profile at launch
  by `withGatewayPort()` - env, Codex args, fallback proxy upstream); gateway
  status row (up / not running / not installed, 1.5 s probe in main,
  `src/freellmgateway.js` + `src/freellmipc.js`); the Luna overlay is rebuilt
  only when its fingerprint changes (`src/lunasyncfingerprint.js`,
  `<overlay>.fingerprint.json`). "Not installed" = no desktop install folder
  found - a stopped Docker gateway also reads as not installed.
- **Built + live-checked 2026-11-02:** project `.mcp.json` servers in
  Codex/Gemini Luna tabs for that project only; claude.ai connectors named as
  skipped with a reason - see "Project MCP servers + claude.ai connectors".
- **Not planned:** hooks and `ecc:` agents for Codex/Gemini (no equivalent);
  carrying claude.ai connectors (their auth is the claude.ai login).

## How to use it (agreed with Mati, 2026-10-20)

FreeLLMAPI swaps only the MODEL, never the program or the setup:

| Need | Profile |
|---|---|
| Best quality, full Luna | Claude Cloud (uses Claude limits) |
| Free, strong, Luna instructions + skills | Gemini CLI (Google login, ~1000 req/day) + "Use my Luna setup" |
| Full Luna harness when Claude limits run out | FreeLLMAPI (claude) - fallback only |

Why FreeLLMAPI (claude) is a fallback, not a daily driver: the Luna harness
sends ~20k tokens of rules plus Claude Code's own prompt and MCP tool lists
on every turn (and is never trimmed - see memory "never trim the Luna
harness"); free models have small quotas/contexts, weaker tool calling, and
the gateway rotates models as daily caps run out.

## Goal

1. More free model backends usable from **all three** agent CLIs LunaCore can
   launch (`claude`, `codex`, `gemini`) — via the FreeLLMAPI gateway
   (34 free providers: Google, Groq, Cerebras, NVIDIA, Mistral, Z.ai, …) plus
   direct templates where a provider has its own Anthropic endpoint.
2. An **opt-in, per-profile "Use my Luna setup"** switch for Codex/Gemini tabs:
   the tab gets the user's Claude instructions + persona, skills and MCP
   servers, so e.g. Gemini answers as Luna with the same skills.

## Decisions (agreed 2026-10-20)

| Topic | Decision |
|---|---|
| Sync delivery | **Overlay per tab.** LunaCore generates the Luna setup in its own folder and points only that tab at it. `~/.codex`, `~/.gemini`, `~/.claude` are never written. |
| Sync scope | Instructions + persona, Skills, MCP servers. **No hooks.** |
| Providers | FreeLLMAPI gateway (one connection, all 3 CLIs) + direct templates. |
| Switch | Per profile, **default off**. Off = tab behaves exactly like today. |
| Skills | The 9 personal `~/.claude/skills` always + plugin skills the user ticks in a Settings list (latest version of each, deduped). ~3.2k plugin SKILL.md files exist, so "everything" is not an option. |
| MCP | `~/.claude.json` user servers + servers from enabled plugins; since 2026-11-02 also the open project's approved `.mcp.json` / local-scope servers, per tab. claude.ai connectors are Anthropic-hosted and cannot be carried over - each is reported as skipped. |
| Instructions | Global `~/.claude/CLAUDE.md` + rules **and** the project's `CLAUDE.md`. |

## Verified live (2026-10-20, this machine)

- `codex-cli 0.146.0`, logged in with ChatGPT. Honors `CODEX_HOME`,
  `-c key=value` overrides, `developer_instructions`, `model_instructions_file`;
  has skills + plugins features.
- `gemini 0.60.0` (npm global). Honors `GEMINI_CLI_SYSTEM_SETTINGS_PATH`
  (settings layer above `~/.gemini`), `GEMINI_CLI_HOME`, `GOOGLE_GEMINI_BASE_URL`;
  has a skills system (`skills.enabled`), `context.fileName`,
  `includeDirectories`.
- FreeLLMAPI (docs, not yet installed): gateway on `localhost:3001`;
  Anthropic Messages at root (claude), Responses API at `/v1` (codex,
  `wire_api = "responses"`), native Gemini API via `GOOGLE_GEMINI_BASE_URL`
  (gemini). Windows install = desktop `.exe` from GitHub Releases.

## Slices

### S0 — Spikes (no product code)

Prove each mechanism by hand before building it. Hash `~/.codex` and
`~/.gemini` before/after every spike: they must be byte-identical.

- **Gemini overlay**: a system-settings file via
  `GEMINI_CLI_SYSTEM_SETTINGS_PATH` that adds a `LUNA.md` context file, MCP
  servers and a skills dir. Pass: Gemini introduces itself as Luna, lists a
  synced skill, sees a synced MCP tool.
- **Codex overlay**, two candidates, pick one:
  - (a) flags only: `-c developer_instructions=…` + `-c mcp_servers.<n>.…`.
    Cheap, but skills can't be added this way, and long text on a Windows
    command line is fragile.
  - (b) LunaCore-owned `CODEX_HOME` (its own `config.toml`, `AGENTS.md`,
    `skills/`), reusing the ChatGPT login. Risk: `auth.json` refresh writes
    — must verify the login survives without copying the token.
- **FreeLLMAPI**: Mati installs the desktop app and adds ≥1 free key. Probe
  all three wires: `claude` (root), `codex` (`-c model_provider` pointing at
  `/v1`), `gemini` (`GOOGLE_GEMINI_BASE_URL`).
- **Direct free endpoints**: list which providers offer a free tier on an
  Anthropic-compatible endpoint (candidates: Z.ai GLM flash, OpenRouter,
  MiniMax). Only verified ones become templates.

#### S0 results (2026-10-20)

- **Gemini — PASS via `GEMINI_CLI_HOME`** (not the system-settings layer:
  skills are discovered only from `<home>/.gemini/skills`,
  `<home>/.agents/skills`, extensions and the project — no settings key adds a
  skills dir). `GEMINI_CLI_HOME=<overlay>` makes Gemini treat `<overlay>` as
  the home: `<overlay>/.gemini/{settings.json,GEMINI.md,skills/}` all load
  (`gemini skills list` showed the probe skill, `gemini mcp list` the probe
  server). Real `~/.gemini` byte-identical before/after. Caveats:
  - MCP servers stay disabled until the folder is trusted, and trust lives in
    the overlay home (`trustedFolders.json`) — the first run asks once.
  - Overlay home has no login: one-time Google login inside a Luna tab
    (stored in the overlay, never copied from `~/.gemini`), or a key.
  - Persona check (model call) still pending that login.
- **Codex — PASS via `CODEX_HOME`** (candidate b). `<overlay>/{AGENTS.md,
  config.toml,skills/}`: `codex mcp list` showed the probe server and
  `codex debug prompt-input` (no model call) contained "You are Luna" and the
  probe skill. Real `~/.codex` (config, AGENTS.md, auth.json, skills, rules)
  hash-identical. Caveats:
  - One-time ChatGPT login inside a Luna tab (`Not logged in` in a fresh
    home) — tokens are never copied.
  - `~/.agents/skills` is read in addition to `CODEX_HOME` — the user's own
    shared skills still appear; that is their setup, left alone.
  - Codex refuses PATH-alias helpers under a temp dir; the real overlay lives
    in userData (`%APPDATA%`), not temp.
- **FreeLLMAPI** — pending: Mati installs the Windows desktop app.
- **Direct free endpoints** — pending research.

Design consequence: a "Luna" Codex/Gemini tab is a **separate CLI profile**
(own login, own history) living in LunaCore's userData. With sync off,
nothing changes and the user's normal login is used.

#### S1 status (2026-10-20): built, verified live

Desktop app on `127.0.0.1:31415`, Google AI Studio + Groq keys, 278 models
(`auto` router; `claude-*-4-5` names accepted). All three CLIs answered through
it. Templates `freellm-claude` / `freellm-codex` / `freellm-gemini`:
- Codex ignores `OPENAI_BASE_URL` (went to api.openai.com, no key sent) - the
  template carries fixed, shell-safe `-c model_providers.freellmapi.*` args
  (validated in providers.js) + `FREELLM_API_KEY`; ran verbatim in PowerShell.
- Gemini: a saved Google-login choice in a home beats `GEMINI_DEFAULT_AUTH_TYPE`
  and a system-settings `enforcedType` - so `freellm-gemini` has
  `gatewayHome: true` and always runs on its own LunaCore home pinned to
  `gemini-api-key` (`luna-overlay/gemini-freellm-gemini`); Luna setup only if
  switched on.
- Port: configurable since 2026-10-22 (default 31415; Docker = 3001).
- Status row in Settings: built 2026-10-22.

### S1 — FreeLLMAPI connection + templates (original plan)

- `src/freellmapi.js`: detect-only (probe `127.0.0.1:<port>/v1/models`,
  default 3001), "open dashboard" action. LunaCore never stores upstream
  provider keys — same boundary as CCR: only the gateway's unified key.
- Templates: `freellm-claude` (direct, `ANTHROPIC_BASE_URL`),
  `freellm-codex` (native + fixed `-c` provider config — needs template-owned
  `args`, validated like `command`), `freellm-gemini` (native,
  `GOOGLE_GEMINI_BASE_URL` + `GEMINI_API_KEY`).
- Settings: gateway status row (up / not running / not installed + link).

### S2 — Sync builder (pure, unit-tested)

`src/lunasync.js`: reads the Claude setup → writes an overlay under
LunaCore's userData (`luna-overlay/gemini`, `luna-overlay/codex`):

- **Instructions**: `~/.claude/CLAUDE.md` + `~/.claude/rules/**` merged into
  `LUNA.md` (Claude-only tool names left as-is; a short header tells the
  model these come from a Claude setup).
- **Skills**: `~/.claude/skills/*` (+ plugin skills per the S0 answer) as
  `SKILL.md` folders — copied, never moved.
- **MCP**: user-scope servers from `~/.claude.json` translated to Gemini JSON
  / Codex TOML. Overlay files hold the same secrets the source already holds,
  stay local, never cross IPC.
- Rebuilt lazily on tab spawn when any source changed (content hash).

#### S2 status (2026-10-20): built

`src/lunasync.js` (pure) + `src/lunasyncio.js` (I/O), 19 tests. Live run
against Mati's real `~/.claude` into a scratch overlay: 12 personal skills +
1 picked plugin skill listed by `gemini skills list`; 3 MCP servers in both
CLIs; Codex prompt contains "User = **Mati**", "assistant = **Luna**".
`~/.claude`, `~/.claude.json`, `~/.codex`, `~/.gemini` hash-identical.
Only 3 MCP servers come from `~/.claude.json` + enabled plugins' `.mcp.json`;
servers Mati sees in Claude from elsewhere (project `.mcp.json`, claude.ai
connectors) were not carried over then - done 2026-11-02, see "Project MCP
servers + claude.ai connectors" below.
Note: FreeLLMAPI's desktop app listens on **31415**, not the docs' 3001.

#### S2 review follow-up (2026-10-20)

Live: `codex mcp add` REWRITES config.toml and re-attaches comments, so a
start/end comment pair is not a safe ownership marker there. TOML ownership is
now by server NAME (`.lunacore-sync.json` -> `codexServers`). Also fixed:
refuse unreadable/JSONC overlay files and damaged Markdown blocks instead of
overwriting; home-dir guard; tmp+rename writes; skill copy skips
`.git`/`node_modules`, never replaces a folder it did not create, case-folds
names; SSE / `${VAR}` servers reported as skipped for Codex.

#### S3 status (2026-10-20): built; live-checked 2026-10-22

- Profile `lunaSync` (native templates only) -> "Use my Luna setup" switch in
  the provider form; `lunaLaunchFor()` in `spawnInto` builds
  `<userData>/luna-overlay/<cli>` and layers `CODEX_HOME`/`GEMINI_CLI_HOME`;
  a status line is printed in the tab (failure = starts without overlay, says why).
- Settings "Luna setup for Codex/Gemini" picker (`lunasyncpicker.js`), picked
  ids in `config/lunasync.local.json`; IPC carries ids/names only.
- Verified outside Electron: overlay in `%APPDATA%` (no Codex temp warning),
  Codex prompt carries the Luna persona, env layering overrides an inherited
  `GEMINI_CLI_HOME`. Not yet clicked through in the running app.

### S3 — Wiring (original plan)

- Profile field `lunaSync: boolean` (default false), allow-listed in
  `profileinput.js`; checkbox only for native templates.
- `spawnInto`: when on, add the overlay env/args for that tab only.
- Security review (IPC payload, overlay paths, args from templates only).

### S4 — Docs, i18n (pl/en), tests, review

## Project MCP servers + claude.ai connectors (2026-11-02): built, live-checked

`src/lunasyncproject.js` (+ builders in `src/lunasync.js`), wired in
`lunaLaunchFor()` with the tab's cwd.

**Which servers.** What Claude Code itself loads for the tab's folder: every
`.mcp.json` from the folder up to the drive root (nearer wins - Claude does
this too, e.g. Luna-Core-HUD picks up `repos/.mcp.json`), **approved only**
(`enableAllProjectMcpServers` / `enabledMcpjsonServers` minus
`disabledMcpjsonServers`, from `~/.claude/settings.json`,
`<dir>/.claude/settings{,.local}.json` and `~/.claude.json` `projects[<dir>]`),
plus Claude's local-scope servers (`~/.claude.json` `projects[<dir>].mcpServers`).
A server Claude never approved is not started in another CLI either
(`not-approved` / `disabled-in-claude`). **Trust gate:** `.mcp.json` servers
(and the repo's own `.claude/` approvals) count only once Claude's workspace
trust dialog was accepted for the folder or a parent
(`projects[<dir>].hasTrustDialogAccepted`) - otherwise `folder-not-trusted`,
so a cloned repo cannot approve its own servers (review finding, fixed).
A revoked/removed server, or a gateway tab with the switch off, clears that
folder's layer.

**Scoped per project, outside the shared overlay.** The shared overlay and its
fingerprint/copy-skip are unchanged (a project switch never rebuilds it or
re-copies skills); a small per-project layer sits next to it, rewritten only
when its content changes:
- Codex: `<overlay>/luna<hash>.config.toml` + `--profile luna<hash>` appended
  to the tab's command. Codex 0.146 layers `<CODEX_HOME>/<name>.config.toml`
  over `config.toml`, `mcp_servers` merged by name with the profile winning
  (same precedence as Claude: project over user). Skipped with a reason when
  the tab's own args already pass `-p/--profile` or the overlay `config.toml`
  holds a legacy `profile =` / `[profiles.x]` (Codex then refuses `--profile`).
- Gemini: an extension `<overlay>/.gemini/extensions/luna<hash>/` that
  `extension-enablement.json` turns on for that folder only
  (`["!/*", "/C:/path/", "/c:/path/"]` - Gemini matches case-sensitively).
  Gemini's own entries in that file are kept; an unparsable one is never
  overwritten. A same-named server in the overlay `settings.json` wins in
  Gemini, so it is reported as `name-taken`. First try was a
  `GEMINI_CLI_SYSTEM_DEFAULTS_PATH` layer - **Gemini 0.60 refuses it** unless
  its folder is admin/SYSTEM-owned ("Security Warning: Skipping system defaults
  file").

**Secrets.** Nothing is resolved by LunaCore. Gemini expands `${VAR}` itself
(settings and extension configs), so placeholders are copied as-is. Codex has
no expansion, but reads env vars by name: `KEY: "${KEY}"` -> `env_vars`,
`Authorization: Bearer ${T}` -> `bearer_token_env_var`, a header that is
exactly `${T}` -> `env_http_headers`; the value stays in the tab's env, never
in a file or on the command line. Any other `${...}` (in args, inside a JSON
string, a renamed var, `${X:-default}`) is skipped as `env-placeholder`, as
before. This also applies to user-level servers. Literal values are copied
exactly as before (overlay in the user-only `%APPDATA%`).

**claude.ai connectors.** Claude keeps only their names locally
(`~/.claude.json` `claudeAiMcpEverConnected`) and reaches them through
Anthropic with the claude.ai login - even the "Claude Docs" connector URL
(`api.anthropic.com/v1/pages/mcp`) answers 401 without it. That login is never
handed to another CLI, so both Codex and Gemini support remote MCP but every
connector is reported as skipped: `connector-auth`.

**Tab notice.** A second line names every skip with its reason (pl/en), e.g.
`Skipped: claude.ai Gmail, ... (claude.ai connector - its login stays with
Claude); notion, supabase (${VAR} this CLI cannot fill).` The first line adds
`project: N (names)`.

**Live check (this PC, Luna-Core-HUD, real `~/.claude`, the real
`lunaLaunchFor` into a scratch overlay under `%APPDATA%\LunaCore-smoke-check`):**
- Codex 0.146 with the returned env + `--profile`: `claude-flow` and
  `context7` started (their stdio banners in the log), `github` loaded and
  asked for `GITHUB_PERSONAL_ACCESS_TOKEN` (not set on this PC - Claude warns
  about the same). Same home **without** `--profile`: none of them start.
  `notion` / `supabase` skipped (`${VAR}` inside a JSON env value / an arg).
- Gemini 0.60: extension `✓ Enabled (Workspace)` in the project, `✗` in the
  parent `repos` folder; `gemini mcp list` in the project: `claude-flow`,
  `playwright`, `context7`, `notion`, `supabase` **Connected** (from the
  extension), `github` disconnected (same missing token). A marker-file probe
  server started in the project and not in the parent.
- On disk: only `${...}` placeholders, no token value (grep for the token
  prefix: 0 hits). Note `gemini mcp list` itself prints the EXPANDED args,
  i.e. the supabase token, like Claude's own `claude mcp list`.
- 6 connectors reported as skipped (`connector-auth`) in both CLIs.
- Not clicked through in the running app (no Luna Codex/Gemini tab exists on
  this PC); the first real tab still needs the one-time login + folder trust.
- `npm test`: 4211 pass. `ecc:typescript-reviewer`: 2 HIGH (repo self-approval,
  stale Gemini layer on revoke) fixed; open LOWs: Gemini prefers the user-level
  server on a name clash where Codex/Claude prefer the project's (reported as
  `name-taken`); per-project layers are never pruned (one small file/folder per
  project ever opened); a Gemini rule matches the cwd spelling of the last tab
  that spawned there.

## Out of scope

Hooks, `ecc:` agents, Claude-only metrics for Codex/Gemini tabs, writing
anything into a user's home CLI config.
