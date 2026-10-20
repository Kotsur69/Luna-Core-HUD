# Free LLM API providers - and how to keep working on them

How LunaCore keeps a coding session (or a whole God Mode run) going on free
models: stack several free tiers behind one gateway, and let an ordered
**fallback chain** of capable models take over the moment one runs out.

> Free tiers change every few weeks. The limits below are orientation only.
> Check each provider's own page before relying on a number, and check the
> model ids your gateway really serves with `GET http://127.0.0.1:31415/v1/models`.

## 1. Providers with a usable free tier

| Provider | What is free | Strong models worth chaining | Notes |
|---|---|---|---|
| **Google AI Studio** (Gemini API) | API key, daily request caps per model | Gemini 2.5 Pro (and newer Pro releases) | Pro has far lower daily caps than Flash. Free-tier prompts may be used for training. |
| **Gemini CLI** (Google account login) | ~1000 requests/day with a personal Google login | Gemini Pro family | A CLI, not an API - use the `gemini-cli` profile, not the chain. |
| **Groq** | Free key, per-minute and per-day caps | Kimi K2, GPT-OSS 120B, Qwen 3 large | Very fast; daily token caps are the real limit. |
| **Cerebras** | Free key, daily token budget | Qwen 3 Coder 480B, Qwen 3 235B, GPT-OSS 120B | Large context, generous daily tokens. |
| **OpenRouter** | `:free` model variants, ~50 req/day (more with $10 of credit once) | DeepSeek V3.x / R1, Qwen 3 Coder, Kimi K2, GLM | Many free variants; availability rotates. Has its own `openrouter` template. |
| **NVIDIA NIM** (build.nvidia.com) | Free credits / rate-limited endpoints | DeepSeek, Qwen 3, Kimi K2, Llama 4 | Good for the big open models. |
| **Mistral** (La Plateforme) | Free "Experiment" tier, rate-limited | Mistral Large, Devstral Medium, Codestral | Prompts may be used for training on the free tier. |
| **Z.ai (Zhipu)** | GLM Flash models free; Coding Plan is paid | GLM-4.6 / GLM-5 (paid plan), GLM Flash (free, weak) | The paid Coding Plan shows its 5 h quota in the usage panel. |
| **Cloudflare Workers AI** | Daily free "neurons" | Llama, Qwen, DeepSeek distills | Smaller models mostly - few strong enough for a chain. |
| **Hugging Face Inference** | Small monthly credit | Router to many open models | Credit runs out fast for agent work. |
| **Cohere** | Trial key, monthly call cap | Command A | Not a coding model; skip for code. |
| **GitHub Models** | Free with a GitHub account, low daily caps | GPT-4.1 / o-series, DeepSeek, Llama | Very low caps for agents. |
| **LM Studio / Ollama** (local) | Unlimited, your own GPU | Whatever fits in VRAM | Not a free API - see the `lm-studio` profile and its shim. |

**Weak models are deliberately left out** of every chain: Flash / Flash-Lite,
`mini`, `nano`, `haiku`, `small`, anything 1-9B, and the gateway's own `auto`
router (it may pick a weak model). `src/freechains.js` refuses them even if a
chain file lists them. Speed does not matter for unattended runs; quality does.

## 2. One gateway for all of them: FreeLLMAPI

[FreeLLMAPI](https://github.com/tashfeenahmed/freellmapi) aggregates ~34 free
providers behind one key and one local endpoint (desktop app on
`127.0.0.1:31415`, Docker on `:3001`). It speaks the Anthropic Messages API
(so `claude` runs against it), the OpenAI Responses API (Codex) and the
native Gemini API (Gemini CLI).

1. Install the Windows desktop app from its Releases page.
2. Add a key for every provider above that you have (Keys page).
3. Copy the unified `freellmapi-...` key from the Keys page header.

LunaCore never stores the upstream provider keys - only the gateway's
unified key, inside the profile.

## 3. Fallback chains in LunaCore

FreeLLMAPI's own router can fall over too, but only along the chain set in
its dashboard, and an explicit model id has no fallback. LunaCore therefore
owns the chain:

- `config/freechains.json` ships three presets of capable models only:
  `free-coding` (default), `free-reasoning`, `free-long-context`.
- `config/freechains.local.json` (same shape, gitignored) adds chains or
  replaces a preset by id - e.g. to match the model ids your gateway lists.
- A profile made from the **"FreeLLMAPI (claude, fallback chain)"** template
  (`freellm-chain`) runs on `free-coding`. Another chain: set
  `"fallbackChain": "free-reasoning"` on the profile in
  `config/profiles.local.json`.

When such a tab starts, LunaCore starts a loopback **fallback proxy**
(`src/fallbackproxy.js`) in front of the gateway and points the tab at it.
Every request goes out with `model` set to the first model of the chain that
is not cooling down. On a **429 / quota**, **5xx / 529 / connection error**
or **"unknown model"** answer, that model cools down (Retry-After, else 1 min
for limits, 30 s for outages, 1 h for unknown ids) and the *same request* is
sent to the next model. Only a success or a non-retryable error (a bad
gateway key, a malformed request) reaches the CLI. The tab's options never
change; the answering model is in the `x-lunacore-model` response header.

An id the gateway does not know is simply skipped, so a stale preset never
breaks a session - but it wastes a round trip, so keep the list current.

## 4. God Mode on free providers

Tick **Free providers** next to Approve on the God Mode board. The run then:

- launches every worker on the first profile that has a fallback chain;
- works on `luna-free/<package>-<stamp>` branches - never `luna/`, never the
  target branch (a worktree that is not on a `luna-free/` branch is stopped);
- **always commits and pushes** its branch: leftovers are committed as usual,
  and the branch is pushed even when verify fails (the worker is still asked
  to fix it), so free-model work is never lost;
- integrates as **branches only** - no merge into, and no PR against, the
  normal target branch. Review the `luna-free/*` branches and merge by hand.

No chain profile configured -> Approve answers "No profile with a free-model
chain" and nothing launches.

## 5. Working continuously

- **Stack providers.** Each free tier alone runs dry within hours of agent
  work; five or six together (Google, Groq, Cerebras, OpenRouter, NVIDIA,
  Mistral) last a working day.
- **Keep Claude for planning.** God Mode plans on the cloud default; when the
  Claude 5 h / weekly limit is spent, planning now waits and starts by itself
  at the reset (see the God Mode board), while free workers keep going.
- **Watch the usage panel.** It lists every configured provider that exposes
  a quota (Codex, Z.ai Coding Plan, Kimi Code, Moonshot balance, OpenRouter
  credits, Gemini login quota); the rest show "not available".
- **Mind the harness size.** Claude Code sends ~20k tokens of rules and tools
  per turn; free models with small context windows or weak tool calling are
  the first to fail - one more reason the chains hold large-context models only.
- **Privacy.** Several free tiers may train on prompts. Do not send secrets or
  client code you are not allowed to share.
