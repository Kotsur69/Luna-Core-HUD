# Claude Prompt: Multi-Provider Model Connectivity for LunaCore

You are working in `C:\Users\mmazur\source\repos\Luna-Core-HUD`, an Electron app named LunaCore.

LunaCore is currently a visual GUI wrapper around the real `claude` CLI. Preserve the project's core constraint: LunaCore must not spend hidden tokens, inject invisible prompts, or silently call model APIs in the background. Any model-provider integration must be user-visible, opt-in, configurable, and easy to disable.

Read the repository before editing. Follow `CLAUDE.md`, especially the rule that all code comments must be in English. Also follow the Codebase Memory / AGENTS instructions if available: prefer graph tools for code discovery, then read exact source where needed.

## Goal

Make LunaCore easy to connect to multiple model backends:

- OpenAI GPT models
- Local models through Ollama
- Local models through LM Studio
- xAI Grok
- Google Gemini
- Other compatible providers such as OpenRouter, Together, Groq, Mistral, Anthropic-compatible endpoints, or any OpenAI-compatible endpoint

The result should feel native to LunaCore: profile-driven, local-first where possible, explicit about network use, and consistent with the existing config/UI architecture.

## Important Project Context

Before designing anything, inspect these areas:

- `src/main.js` for PTY session startup, profile handling, IPC, and the "real CLI in a terminal" boundary.
- `src/profiles.js` and `config/profiles.json` for the existing runtime-profile system.
- `src/lmstudio.js` because LunaCore already has local model watcher logic and LM Studio endpoint probing.
- `src/renderer/modules/*` for UI module conventions.
- `src/preload.js` for safe IPC exposure.
- `config/*.json` for the base + `.local.json` override pattern.
- `.env.luna.example` for environment documentation.
- `README.md` sections about network behavior, zero extra tokens, local writes, and profiles.
- Existing tests under `test/`.

Do not duplicate an existing local-model watcher if one already exists. Extend or reuse it.

## Desired Architecture

Add a provider abstraction that can normalize model access without forcing every provider into the same implementation detail.

Prefer a small, explicit interface such as:

```js
{
  id,
  label,
  kind,
  baseUrl,
  apiKeyEnv,
  defaultModel,
  supports: {
    chat,
    streaming,
    tools,
    jsonMode,
    vision,
    embeddings
  }
}
```

Adapt the exact shape to the codebase. The important part is that the app can:

- List configured providers.
- Validate provider configuration without exposing secrets.
- List or probe models when the provider supports it.
- Launch a profile with the right command, args, and environment.
- Show whether a local endpoint is up/down.
- Keep provider credentials out of committed config.

If LunaCore should continue launching CLI tools rather than becoming a direct API client, implement provider support as profile templates and environment wiring first. For example, let a profile point the real Claude CLI, OpenAI-compatible tools, or local endpoints at the correct `BASE_URL`, `API_KEY`, and model env vars. Only add direct API calls if there is a clear user-facing feature that requires them.

## Providers to Support

Implement at least these provider definitions/config templates:

### OpenAI

- API key env: `OPENAI_API_KEY`
- Base URL env: `OPENAI_BASE_URL`
- Default base URL: `https://api.openai.com/v1`
- Model examples: `gpt-5`, `gpt-5-mini`, `gpt-4.1`

### Ollama

- No API key by default.
- OpenAI-compatible base URL: `http://localhost:11434/v1`
- Native API root if needed: `http://localhost:11434`
- Model examples: `llama3.1`, `qwen2.5-coder`, `mistral`, `deepseek-coder`
- Probe `/api/tags` or `/v1/models`, depending on implementation.

### LM Studio

- No API key by default.
- OpenAI-compatible base URL: `http://localhost:1234/v1`
- Reuse or extend `src/lmstudio.js`.
- Respect any existing `autoModel` behavior in profiles.

### xAI Grok

- API key env: `XAI_API_KEY`
- Base URL env: `XAI_BASE_URL`
- Default base URL: `https://api.x.ai/v1`
- Treat as OpenAI-compatible unless current docs or tests show otherwise.

### Google Gemini

- API key env: `GEMINI_API_KEY` or `GOOGLE_API_KEY`
- Gemini is not simply OpenAI-compatible in every setup, so isolate it behind a provider adapter.
- If using the official SDK, keep it optional and document the dependency.
- If using REST, centralize request/response translation.

### Generic OpenAI-Compatible

- Env vars: `LUNA_AI_BASE_URL`, `LUNA_AI_API_KEY`, `LUNA_AI_MODEL`
- Let users point at OpenRouter, Together, Groq, Mistral, local proxies, or custom gateways.
- Do not hardcode provider-specific assumptions for this generic path.

## Configuration Requirements

Use the repo's existing config style:

- Ship safe defaults in committed config.
- Store machine-specific settings in ignored `.local.json` files.
- Never commit real API keys.
- Add or update `.env.luna.example` with all supported env vars.
- Document which providers make network requests and which are local-only.

Recommended files, adjusted after inspecting the repo:

- `config/model-providers.json`
- `config/model-providers.local.json` (ignored, user-created)
- `src/modelproviders.js` or `src/ai/providers.js`
- `src/renderer/modules/modelproviders.js` if UI is added
- Tests in `test/modelproviders.test.js`

## UX Requirements

Add a small, practical UI surface if it fits the existing layout:

- Provider list with status: configured, missing key, local endpoint down, ready.
- Model list or loaded-model badge for local servers.
- Clear labels for local versus network providers.
- Copyable env/config hints, but never display actual API keys.
- A way to choose or create runtime profiles from provider templates.

Use the existing renderer module style, i18n system, and theme tokens. Do not create a landing page or marketing screen.

## Behavior Requirements

The implementation should:

- Preserve current Claude CLI behavior as the default.
- Keep the renderer network-isolated unless the existing architecture intentionally allows otherwise.
- Do provider probing in the main process where filesystem/network access already belongs.
- Use timeouts and friendly errors for local endpoints that are not running.
- Redact secrets in logs, diagnostics, IPC payloads, and UI.
- Avoid hidden background model requests. Health checks should only hit metadata/model-list endpoints.
- Support cancellation or timeout for any request that can hang.
- Degrade cleanly when optional providers are not configured.

## Testing Requirements

Add focused tests for:

- Provider config normalization.
- Secret redaction.
- Base URL normalization, including trailing slash handling.
- Local endpoint/model parsing for Ollama and LM Studio.
- Missing API key states.
- Profile/env generation.

Mock all network calls. Do not require OpenAI, Gemini, xAI, Ollama, or LM Studio to be running for tests.

Run:

```powershell
npm test
```

If tests cannot run, explain exactly why and what remains unverified.

## Documentation Requirements

Update documentation so a user can connect providers quickly:

- Add a README section or separate setup doc for "Model Providers".
- Explain OpenAI, Ollama, LM Studio, Grok, Gemini, and generic OpenAI-compatible setup.
- Include Windows-friendly examples.
- State clearly that local providers are local-only unless configured otherwise.
- State clearly when a provider will make network requests.
- Document where local overrides live and which files are ignored.

Example env block:

```dotenv
# OpenAI
OPENAI_API_KEY=
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_MODEL=gpt-5-mini

# Ollama
OLLAMA_BASE_URL=http://localhost:11434/v1
OLLAMA_MODEL=llama3.1

# LM Studio
LMSTUDIO_BASE_URL=http://localhost:1234/v1
LMSTUDIO_MODEL=

# xAI / Grok
XAI_API_KEY=
XAI_BASE_URL=https://api.x.ai/v1
XAI_MODEL=

# Gemini
GEMINI_API_KEY=
GEMINI_MODEL=

# Generic OpenAI-compatible endpoint
LUNA_AI_BASE_URL=
LUNA_AI_API_KEY=
LUNA_AI_MODEL=
```

## Acceptance Criteria

The task is complete when:

- Existing Claude CLI profiles still work unchanged.
- Users can configure OpenAI, Ollama, LM Studio, Grok, Gemini, and a generic OpenAI-compatible provider without editing source code.
- Local endpoints show useful status without crashing when offline.
- No secrets are committed, logged, or sent to the renderer.
- Provider docs and `.env.luna.example` are updated.
- Tests cover normalization, redaction, local endpoint parsing, and profile generation.
- `npm test` passes or any failure is clearly explained.

## Implementation Style

Keep the change small and coherent. Prefer the existing profile/config machinery over a large new framework. Use plain JavaScript unless the project already uses TypeScript in the touched area. Match LunaCore's current IPC and renderer-module conventions. Make the default path boring and reliable: current Claude behavior first, optional providers second.
