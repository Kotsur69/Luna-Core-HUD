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
is not cooling down. On an **"All models ..." 429 / quota**, **5xx / 529 /
connection error** or **"unknown model"** answer, that model cools down and
the *same request* is sent to the next model. Only a success or a
non-retryable error (a bad gateway key, a malformed request) reaches the CLI.
The tab's options never change; the model that really answered (the
gateway's `X-Routed-Via`, else the chain model) is in the `x-lunacore-model`
response header and, for a God Mode free run, in the run log.

Cooldowns: a limit waits for the gateway's Retry-After, else the
"Soonest cooldown reset ~Xm" hint in its message, else 30 min (a daily cap
names no reset); 30 s for outages; 10 min for a substitution; 1 h for an
unknown id.

**Every model used up.** The proxy then answers HTTP 429 with
`Free coding models: usage limit reached · resets Nov 8, 3:40pm` (local time:
the first moment any model of the chain is back - each model cools for the
gateway's Retry-After, else its ~Xm hint, else its default - else +30 min;
at least 1 min, at most 6 h; `src/freeLimit.js`). Claude Code records that as the
usage-limit wall, so a God Mode run pauses until then and resumes by itself,
and the board says "Free coding models limited - retrying at HH:MM". Until the
reset the proxy sends nothing upstream; after it, ONE model is re-probed before
the chain is walked again.

**The gateway's own window.** FreeLLMAPI allows 120 requests per minute per
client (`X-RateLimit-Limit: 120`), shared by every free worker. The proxy
spaces requests to stay under it (`src/freePacer.js`, keeping 10 in reserve
and trusting `X-RateLimit-Remaining` / `X-RateLimit-Reset` when present). A
429 that is NOT "All models ..." ("Rate limit exceeded: more than 120 requests
per minute. Retry in 7s.") is that window: the proxy waits the Retry-After and
sends the same request to the same model again (3 retries), it does not pause
the run. A free run also runs at most `FREE_MAX_PARALLEL` workers at once
(`src/orchestraFree.js`; override with `LUNACORE_FREE_MAX_PARALLEL`).

**Substitution guard.** A gateway may answer from a different model than the
one asked for. A chain can list the models it accepts as substrings of
`X-Routed-Via` (`<platform>/<model>`):

```json
{ "id": "free-coding", "models": ["nemotron-3-ultra", "gpt-oss-120b", "nemotron-3-super"],
  "expect": ["nemotron-3-ultra", "gpt-oss-120b", "nemotron-3-super"] }
```

An answer routed elsewhere is refused as `substituted` - decided on the
response headers, before a byte of it reaches the CLI (streams too) - and the
next model is tried; all substituted means the "usage limit reached" answer
above. No `X-Routed-Via` header: accepted, with a warning. Requests for an
`auto:*` model (God Mode plan runs) skip the guard - any member is fine there.
A malformed `expect` (not 1-16 short strings) is ignored with a warning; the
chain itself still loads.

An id the gateway does not know is simply skipped, so a stale preset never
breaks a session - but it wastes a round trip, so keep the list current.

## 4. God Mode on free providers

The **Workers** selector (in the to-do picker and next to Approve on the God
Mode board) replaced the old *Free providers* tick. It has three settings:
**Claude only**, **Plan with free models in mind** (hybrid, below) and
**Free only**. A *Free only* run:

- launches every worker on the first profile that has a fallback chain;
- works on `luna-free/<package>-<stamp>` branches - never `luna/`, never the
  target branch (a worktree that is not on a `luna-free/` branch is stopped);
- **always commits and pushes** its branch: leftovers are committed as usual,
  and the branch is pushed even when verify fails (the worker is still asked
  to fix it), so free-model work is never lost;
- integrates as **branches only** - no merge into, and no PR against, the
  normal target branch. Review the `luna-free/*` branches and merge by hand.

No chain profile configured -> Approve answers "No profile with a free-model
chain" and nothing launches. An opt-in run option (off by default) has Claude
review each pushed `luna-free/*` branch read-only when the run settles and
write the result to `docs/plans/<slug>/REVIEW.md`
(`docs/plans/free-run-<id>/` when the run did not come from a plan).

**Hybrid runs** (*Plan with free models in mind*): Claude plans and may mark
very simple packages `free`. `src/orchestraHybridGuard.js` moves such a
package to Sonnet when it lists 0 or more than 2 files, touches a protected
path (`config/hybrid-protected.json` plus the repo's
`.lunacore/hybrid-protected.json`) or has no verify. Free packages run on
the *FreeLLMAPI - coding* profile (never `freellm-auto` or an `auto:easy` chain); Approve without
such a profile is refused. Before a free package joins the run it passes
verify and one short read-only Sonnet review of its diff; a failed review,
or a second stall, hands it to Sonnet in its own worktree. Only the free
package waits on free limits - the run goes on - and after 1 hour with Claude
packages depending on it, it is handed to Sonnet.

**Plan only runs** write Markdown, never code: topic docs, a critique and a
`PLAN.md` under `docs/plans/<slug>/`, on `luna-plan/` branches that are
never merged. Plan workers run on the `freellm-auto` profile, locked down
to read tools plus Edit/Write inside that folder (no shell, no subagents,
read-only Playwright). **Approve plan** merges `PLAN.md` into the base
branch and turns its unchecked tasks into to-dos tagged `plan:<slug>`.
Plan: [`../tbc_docs/FREE_GODMODE_V2_PLAN.md`](../tbc_docs/FREE_GODMODE_V2_PLAN.md).

### Live checks done

- **CLI records the proxy's 429 as the usage-limit wall** (2026-11-08,
  Claude Code 2.1.319, fake gateway answering "All models rate-limited ...
  Soonest cooldown reset ~12m" with `Retry-After: 720`). The CLI sent the
  request once (the proxy's `x-should-retry: false` is honoured - no retry
  burn) and wrote a transcript entry with `isApiErrorMessage: true`,
  `apiErrorStatus: 429`, `error: "rate_limit"` and the text
  `API Error: Server is temporarily limiting requests (not your usage limit) ·
  Free coding models: usage limit reached · resets Nov 8, 9:50pm`.
  `usageLimitFrom()` read it as 21:50 local - the 12 min rounded up to the
  minute. No body change was needed.
- **Gateway 429 shapes** (FreeLLMAPI source, `server/src/lib/fallback-loop.ts`,
  `services/router.ts`, `middleware/rateLimit.ts`):
  `All models rate-limited after N attempts. Soonest cooldown reset ~12m. ...`
  with `Retry-After`; `All models exhausted: N routes checked (...). ... Soonest
  reset ~45m.` without it; and the per-client window `Rate limit exceeded: more
  than 120 requests per minute. Retry in Ns.` with `Retry-After` and
  `X-RateLimit-Limit / -Remaining / -Reset` (epoch seconds). None of them names a
  clock time, which is why the proxy rewrites them.

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
