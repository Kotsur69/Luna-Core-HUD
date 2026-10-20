# Free providers + Luna sync — plan

Status: **draft, waiting for Mati's confirm** (2026-10-20).
Predecessor (uncommitted at time of writing): native `codex-cli` / `gemini-cli`
templates + `openrouter` template (see README "AI providers").

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
| MCP | `~/.claude.json` user servers + local (stdio) servers from enabled plugins. claude.ai connectors are Anthropic-hosted and cannot be carried over. |
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

### S1 — FreeLLMAPI connection + templates

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

### S3 — Wiring

- Profile field `lunaSync: boolean` (default false), allow-listed in
  `profileinput.js`; checkbox only for native templates.
- `spawnInto`: when on, add the overlay env/args for that tab only.
- Security review (IPC payload, overlay paths, args from templates only).

### S4 — Docs, i18n (pl/en), tests, review

## Out of scope

Hooks, `ecc:` agents, Claude-only metrics for Codex/Gemini tabs, writing
anything into a user's home CLI config.
