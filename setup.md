# Dual-runner setup — Claude native + GLM-5.3

How to run **two Claude Code CLI sessions side by side** on this machine: one on
first-party Anthropic models, one on GLM-5.3 — with an identical ECC surface
(same plugins, skills, agents, hooks, MCP servers, memory files) in both.

---

## The idea in one paragraph

There is **one** CLI binary and **one** config directory. Claude Code reads every
capability — plugins, skills, agents, hooks, MCP servers, `CLAUDE.md` chain — from
`~/.claude`, and it reads the *model route* from environment variables. So the two
runners are not two installs: they are the same install started with a different
environment.

```
                     ~/.claude/            <- plugins, skills, agents, hooks,
                     ~/.claude.json           MCP servers, statusline, memory
                          |                   (SHARED, never per-runner)
              +-----------+-----------+
              |                       |
    claude-native.*              claude-glm.*
    (no overrides)         ANTHROPIC_BASE_URL -> proxy
              |            ANTHROPIC_*_MODEL  -> glm-5.3
              v                       v
     api.anthropic.com        api.z.ai/api/anthropic
```

Two rules follow, and both are enforced by `scripts/ecc-parity-check.mjs`:

1. **Never** put `ANTHROPIC_BASE_URL` in `~/.claude/settings.json`. Both runners read
   that file, so a base URL there silently redirects native sessions too.
2. **Never** give the GLM runner its own `CLAUDE_CONFIG_DIR`. A second config dir is
   the fastest way to lose parity — you would be maintaining two ECC installs.

---

## Prerequisites

| Thing | This machine | Check |
|---|---|---|
| Claude Code CLI | `2.1.247` at `~/.local/bin/claude.exe` | `claude --version` |
| Node | ships with the repo toolchain | `node --version` |
| A GLM key | Z.ai coding plan, or an OpenRouter key | — |

Both runners work from PowerShell (primary here) and from Git Bash.

---

## 1. One-time setup

```powershell
Copy-Item .env.luna.example .env.luna
notepad .env.luna          # paste the key into LUNA_GLM_API_KEY
```

`.env.luna` is gitignored. `.env.luna.example` is the committed contract — when a
new variable is added, it goes in the example too.

Minimum viable file:

```ini
LUNA_GLM_PROVIDER=zai
LUNA_GLM_API_KEY=<your-z.ai-key>
```

Everything else has a preset default. To use OpenRouter instead, set
`LUNA_GLM_PROVIDER=openrouter` and paste an OpenRouter key — the base URL and the
`z-ai/glm-5.3` slugs switch with it. `LUNA_GLM_PROVIDER=custom` requires you to set
`LUNA_GLM_BASE_URL` and `LUNA_GLM_MODEL` yourself; any endpoint that speaks the
Anthropic Messages API will do.

Validate before launching anything:

```powershell
powershell -File .\scripts\env-setup.ps1 -Check glm
```
```bash
bash scripts/env-setup.sh --check glm
```

---

## 2. Starting each runner

**PowerShell**

```powershell
.\scripts\claude-native.ps1               # first-party Anthropic
.\scripts\claude-glm.ps1                  # GLM-5.3

.\scripts\claude-glm.ps1 -p "reply with the single word: pong"
```

**Git Bash / WSL**

```bash
scripts/claude-native.sh
scripts/claude-glm.sh

scripts/claude-glm.sh -p "reply with the single word: pong"
```

Every argument is passed straight through to `claude`, so `-p`, `--resume`,
`--continue`, `-c`, `--model` and the rest behave exactly as they always do.

Each runner prints one banner line to **stderr** before handing over:

```
luna: runner=glm model=glm-5.3 endpoint=https://api.z.ai/api/anthropic
```

stderr, not stdout — so `claude-glm.sh -p "..." | jq` still gets clean JSON.

### Why there is a `-native` runner at all

`scripts/claude-native.*` is not just an alias for `claude`. It **clears** every
variable the GLM runner sets. Without that, a shell where you once ran
`source scripts/env-setup.sh glm` keeps sending "native" sessions to the proxy, and
nothing in the UI tells you. The PowerShell runners additionally snapshot and restore
the environment around the CLI, so the shell you launched from is handed back untouched.

### Convenience aliases

Add to your PowerShell profile (`$PROFILE`) if you want bare `glm` / `cc` verbs:

```powershell
function glm { & "C:\Users\mmazur\source\repos\Luna-Core-HUD\scripts\claude-glm.ps1" @args }
function cc  { & "C:\Users\mmazur\source\repos\Luna-Core-HUD\scripts\claude-native.ps1" @args }
```

---

## 3. Verifying both runners

### a. Static parity check

```bash
node scripts/ecc-parity-check.mjs          # add --json for machine output
```

It does three things, and it *measures* rather than assumes:

1. Runs each runner's env setup in a real child shell — bash **and** PowerShell — and
   dumps the resulting variables. If the two entry points ever drift apart, this fails.
2. Fails if either runner sets a **capability** variable (`CLAUDE_CONFIG_DIR`,
   `CLAUDE_PLUGIN_ROOT`, `CLAUDE_CODE_SKIP_PLUGIN_MCP_SERVERS`, …) — anything that
   changes *what* the agent can do rather than *which model* answers.
3. Prints the shared ECC inventory plus a short fingerprint, so the same command on
   another machine is directly comparable.

Exit code `0` = parity holds, `1` = a violation was found. Tokens are never printed —
they are reduced to `(set, 29 chars)`.

### b. Live smoke test

```powershell
.\scripts\claude-glm.ps1    -p "reply with the single word: pong"
.\scripts\claude-native.ps1 -p "reply with the single word: pong"
```

Two `pong`s means both routes are authenticated and answering.

### c. Inside a session

Start each runner interactively and compare:

| Command | What to confirm |
|---|---|
| `/status` | model name and API endpoint match the runner you started |
| `/mcp` | same server list in both, same connection states |
| `/plugin` | same 7 plugins enabled in both |
| `/agents` | same agent roster in both |
| `/context` | same skills and memory files loaded |

If `/status` in a "native" session shows a GLM model, you launched it from a polluted
shell — use `scripts/claude-native.*`, which clears the overrides.

---

## 4. Environment variables

Set only by the GLM runner. The native runner clears all of them.

| Variable | Value here | Why |
|---|---|---|
| `ANTHROPIC_BASE_URL` | `https://api.z.ai/api/anthropic` | Anthropic-compatible endpoint. No trailing slash — the CLI appends `/v1/messages`. |
| `ANTHROPIC_AUTH_TOKEN` | your GLM key | Sent as a Bearer token. |
| `ANTHROPIC_API_KEY` | *(unset)* | Deliberately removed. A leftover `x-api-key` alongside a Bearer token is the classic cause of a 401 that looks like a bad key. |
| `ANTHROPIC_MODEL` | `glm-5.3` | Default model for the session. |
| `ANTHROPIC_DEFAULT_OPUS_MODEL` | `glm-5.3` | Alias mapping — see below. |
| `ANTHROPIC_DEFAULT_SONNET_MODEL` | `glm-5.3` | " |
| `ANTHROPIC_DEFAULT_FABLE_MODEL` | `glm-5.3` | " |
| `ANTHROPIC_DEFAULT_HAIKU_MODEL` | `glm-5.3-flash` | " |
| `ANTHROPIC_SMALL_FAST_MODEL` | `glm-5.3-flash` | Legacy name for the cheap-call model; set for older code paths. |
| `CLAUDE_CODE_SUBAGENT_MODEL` | `glm-5.3` | Subagents spawned by the Agent tool. |
| `API_TIMEOUT_MS` | `3000000` | 50 min. GLM through a proxy is slower to first token; the request timeout is what bites first on long agentic turns. |
| `MCP_TIMEOUT` / `MCP_TOOL_TIMEOUT` | `60000` / `120000` | MCP startup and per-call ceilings; `npx`-launched servers need the extra room. |
| `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` | `1` | Suppresses telemetry/update pings while the session is talking to a third party. Set `LUNA_GLM_DISABLE_NONESSENTIAL_TRAFFIC=0` to leave default behaviour alone. |
| `LUNA_RUNNER` | `glm` / `native` | Marker so scripts and the status line can tell which session they are in. |

**All four aliases are mapped on purpose.** Claude Code resolves a model through the
alias the caller asked for — an ECC agent declared `model: haiku`, or a `Task`
delegating to `opus`, requests that alias by name. Map only `ANTHROPIC_MODEL` and those
calls ask the proxy for a Claude slug it does not serve: the subagent dies with a 404
while the main session keeps working. That failure mode is confusing enough to be worth
the eight extra exports.

---

## 5. What both runners share

Measured on this machine (`node scripts/ecc-parity-check.mjs`, fingerprint
`8a630b325860af63`). Everything below is resolved from `~/.claude` and is therefore
identical in both runners by construction.

### Plugins (7 enabled)

| Plugin | Version | Skills | Agents | Commands |
|---|---|---|---|---|
| `ecc@ecc` | 2.2.0 | 284 | 67 | 94 |
| `document-skills@anthropic-agent-skills` | `3b3fad96af16` | 19 | 0 | 0 |
| `diagram-design@diagram-design` | 2.2.0 | 1 | 0 | 3 |
| `impeccable@impeccable` | 3.9.1 | 1 | 1 | 0 |
| `frontend-design@claude-plugins-official` | `b819188d2eea` | 1 | 0 | 0 |
| `last30days@last30days-skill` | 3.18.4 | 1 | 0 | 0 |
| `ui-ux-pro-max@ui-ux-pro-max-skill` | 2.6.2 | — | — | — |

Marketplaces are declared in `~/.claude/settings.json` → `extraKnownMarketplaces`;
`ecc` has `autoUpdate: true`, so both runners follow the same version automatically.

### MCP endpoints

| Scope | Servers |
|---|---|
| User (`~/.claude.json`) | `codebase-memory-mcp` (local exe), `shadcn` (`npx shadcn@latest mcp`) |
| Enabled for this project (`.claude/settings.local.json`) | `claude-flow`, `context7`, `github`, `notion`, `playwright`, `supabase` |
| Project file (`.mcp.json`) | none — this repo ships no project-scoped servers |

Plugin-provided servers (e.g. `chrome-devtools` from ECC) load in both runners as well.

### Local skills, agents and hooks

- **User skills** (`~/.claude/skills/`): `codebase-memory`, `design-motion-principles`,
  `design-taste-frontend`, `full-output-enforcement`, `gpt-taste`,
  `high-end-visual-design`, `redesign-existing-projects`, plus `learned/`.
- **User agents** (`~/.claude/agents/`): `codebase-memory`, `codebase-memory-scout`,
  `codebase-memory-auditor`.
- **Hooks** (`~/.claude/hooks/`, wired in `settings.json`): `cbm-code-discovery-gate`
  (PreToolUse on `Grep|Glob`, PostToolUse on `Read`), `cbm-session-reminder`
  (SessionStart × 4 matchers), `cbm-subagent-reminder` (SubagentStart).
  Hooks are shell commands — they run identically regardless of which model is answering.
- **Status line**: `~/.claude/helpers/luna-statusline.cjs`.
- **Memory chain**: `~/.claude/CLAUDE.md` → `source/repos/CLAUDE.md` →
  `source/repos/Luna-Core-HUD/CLAUDE.md`, plus
  `~/.claude/projects/<project>/memory/MEMORY.md`.

### Built-in tools

`Read`, `Write`, `Edit`, `Bash`, `Glob`, `Grep`, `WebSearch`, `WebFetch`, `Task`,
`TodoWrite` and the rest are implemented **inside the CLI**, not by the model. Their
behaviour, permission prompts and hook interception are byte-identical across runners.
What differs is only how well a given model *chooses* to use them.

---

## 6. GLM inside the LunaCore HUD

The app has its own runner mechanism — `config/profiles.json`, whose `env` block is
applied to the PTY in `src/main.js` (`spawnInto`). A `glm-5.3` profile now ships there
with the endpoint and model mapping, but **without a key**.

Add the key in `config/profiles.local.json` (gitignored, replaces by `id`):

```json
{
  "profiles": [
    {
      "id": "glm-5.3",
      "label": "GLM-5.3 (Z.ai)",
      "command": "claude",
      "args": [],
      "env": {
        "ANTHROPIC_BASE_URL": "https://api.z.ai/api/anthropic",
        "ANTHROPIC_AUTH_TOKEN": "<your-z.ai-key>",
        "ANTHROPIC_MODEL": "glm-5.3",
        "ANTHROPIC_DEFAULT_OPUS_MODEL": "glm-5.3",
        "ANTHROPIC_DEFAULT_SONNET_MODEL": "glm-5.3",
        "ANTHROPIC_DEFAULT_FABLE_MODEL": "glm-5.3",
        "ANTHROPIC_DEFAULT_HAIKU_MODEL": "glm-5.3-flash",
        "ANTHROPIC_SMALL_FAST_MODEL": "glm-5.3-flash",
        "CLAUDE_CODE_SUBAGENT_MODEL": "glm-5.3",
        "API_TIMEOUT_MS": "3000000"
      }
    }
  ]
}
```

A local profile **replaces** the shipped one by `id` — it is not deep-merged, so repeat
the whole block. After that, the profile dropdown switches a tab between Claude and GLM
with no shell involved.

---

## 7. Troubleshooting

### 401 / "invalid API key" / "authentication_error"

- Is `ANTHROPIC_API_KEY` still set? Run `bash scripts/env-setup.sh --print glm`; it must
  say `(unset)`. A stale `x-api-key` beats the Bearer token and the proxy rejects it.
- Is the key for the right provider? A Z.ai key against `openrouter.ai` fails this way.
- Z.ai coding-plan keys are plan-scoped — a key without an active plan authenticates
  but is refused on the model.

### 404 / "model not found"

Almost always an unmapped alias. Confirm with `--print glm` that all five model
variables are populated, then check the slug against the provider's current model list —
Z.ai serves `glm-5.3` / `glm-5.3-flash`, OpenRouter uses `z-ai/glm-5.3`. If a subagent
404s while the main session works, it asked for an alias you did not map.

### Timeouts and stalls

- **Request times out mid-turn** → raise `LUNA_GLM_API_TIMEOUT_MS`. The default here is
  already 3 000 000 ms (50 min); a lower ambient `API_TIMEOUT_MS` in your shell profile
  would override the intent, so check `--print` output rather than the file.
- **Stall on the first token of a long turn** → usually the proxy queuing, not a hang.
  The banner plus `/status` confirms the session is alive.
- **MCP server "failed to connect"** → `MCP_TIMEOUT` (startup) and `MCP_TOOL_TIMEOUT`
  (per call). `npx`-launched servers like `shadcn` pay a cold-start cost on first use.
- **Corporate proxy** → `HTTPS_PROXY` is honoured by the CLI and applies to both runners.

### Unexpected token formatting

Symptoms: truncated tool calls, `tool_use` blocks that never close, JSON parse errors in
the transcript, edits applied to the wrong hunk, or thinking text leaking into the answer.

These are **translation-layer** problems, not CLI bugs. The proxy re-encodes GLM output
into Anthropic `content` blocks, and the seams show up under load:

1. Reproduce with `-p` and a trivial prompt. If a one-shot is clean, it is a
   long-context/streaming issue, not a config one.
2. Try the other provider preset — Z.ai's own endpoint and OpenRouter's Anthropic Skin
   are different implementations, and a bug in one often is not in the other.
3. Drop `ANTHROPIC_DEFAULT_HAIKU_MODEL` to the same slug as the main model. Mixed model
   families in one session are a common source of malformed cheap-call responses.
4. Do the actual file edits from the native runner. Tool-call fidelity is the part of
   the protocol third-party endpoints get wrong most often, and a mangled `Edit` is
   worse than a slow one.

### A "native" session is talking to the proxy

You launched `claude` directly from a shell where the GLM env was sourced. Use
`scripts/claude-native.*` (it clears the overrides), or run
`source scripts/env-setup.sh native` in that shell. Confirm with `/status`.

### The GateGuard / cbm hooks behave differently

They cannot — they are `cmd.exe` scripts in `~/.claude/hooks`, invoked by the CLI, with
no model involvement. If a hook fires in one runner and not the other, the difference is
the *conversation*, not the configuration.

---

## 8. Known parity limits

Tool parity is exact. These are the places where "same setup" still means "different
behaviour", and none of them is fixable by configuration:

- **The model is different.** Same skills, same tools, different judgment. ECC skills
  written against Claude's instruction-following (multi-step orchestration skills
  especially) will not perform identically.
- **Prompts that name Claude models.** Any agent definition or skill that hardcodes
  `claude-opus-5` rather than the `opus` alias bypasses the alias mapping and will fail
  on the GLM runner.
- **Cost and usage accounting.** `~/.claude/cost-tracker.log`, the usage widgets and the
  `/cost` command assume Anthropic pricing. GLM turns are recorded but priced wrong.
- **Extended thinking.** Carried through both proxies in principle, but budget and block
  formatting differ from first-party. Treat thinking-dependent workflows as needing
  their own verification.
- **Session history is shared.** Both runners write transcripts to the same
  `~/.claude/projects/<project>/` tree, so `--resume` will happily offer you a GLM
  session in a native runner and vice versa. Harmless, occasionally confusing.

---

## Files in this setup

| File | Role |
|---|---|
| `.env.luna.example` | Committed contract for the GLM config |
| `.env.luna` | Your filled-in copy (gitignored) |
| `scripts/env-setup.sh` / `.ps1` | Single source of truth for both runner environments |
| `scripts/claude-glm.sh` / `.ps1` | GLM runner |
| `scripts/claude-native.sh` / `.ps1` | Native runner (clears GLM overrides) |
| `scripts/ecc-parity-check.mjs` | Measures and reports parity |
| `config/profiles.json` | HUD profile `glm-5.3` (no key) |
| `config/profiles.local.json` | HUD profile override with the key (gitignored) |

## References

- [Z.ai — Claude Code integration](https://docs.z.ai/devpack/tool/claude)
- [OpenRouter — Claude Code integration](https://openrouter.ai/docs/cookbook/coding-agents/claude-code-integration)
