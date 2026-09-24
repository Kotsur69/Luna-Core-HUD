# RESUME — AI providers feature

Operational hand-off for the AI-providers work. This is built directly on
`main` (no dedicated feature branch) via the `/orch-add-feature` gated
pipeline (Research → Plan → Gate 1 → TDD → Review → Gate 2 → Commit), one
phase at a time. Read this file first in a new session before doing anything
else on this feature - it says exactly where things stand and what's left.

Last updated: 2026-09-24, after Phase 8b (the two parallel Phase 8 branches
merged into one, Kimi Code template, overnight guard wired into God Mode).

---

## The original request (verbatim, from Mati)

> please now configure the ai providers so user can choose lm studio ollama
> codex kimi glm gemini etc - in my example please try to keep every possible
> provider to use this claude setup as a main harness so luna with claude.md
> mcps skills etc and make it easy to add also please in settings let me have
> the ability to load downloaded models in lm studio cause now i have a
> script that doesn't let me change settings on my desktop its called go
> local claude and ye i want to change settings from here.

Two threads follow from this: **(A)** a provider-template system so any of
these backends (LM Studio, Ollama, Codex, Kimi, GLM, Gemini, Grok, a generic
OpenAI-compatible endpoint, Claude Cloud) can drive the SAME `claude` CLI
LunaCore already knows how to run, and **(B)** replacing the external
"go local claude" desktop script entirely - every setting it used to gate
should be changeable from inside LunaCore's own Settings overlay (Ctrl+L).

## Where things stand

```
461edf1  feat: add AI-provider profile CRUD to Settings              (Phase 3, done)
0210e4d  feat: let Settings load downloaded LM Studio models         (Phase 2, done)
03c47c0  feat: add AI-provider templates + /ask + highlights         (Phase 1, done)
b84027b  feat: add claude-code-router (CCR) lifecycle management    (Phase 4, done)
02988cc  Phases 5 + 7: LM Studio runs the full Luna harness           (done)
ee3cf38  Phase 8: shim token, env fix, CCR module + Test button       (done)
082e53c  Phase 8b: local Phase 8 branch folded in (Kimi Code etc.)    (done)
<this commit>  Phase 8b: overnight guard wired into God Mode         (done, not run live)
```

Everything is on `main`; there are no feature branches left.
`npm test` on Mati's Windows machine → **1482 tests, 1482 pass**. (On Linux
cloud sessions `test/launch.test.js` "withSessionId accepts a path or
.exe/.cmd form of the binary" fails - it is Windows-path-only and fails on
untouched `main` there too.) `npm start` runs the app.

### Phase 1 — DONE (`03c47c0`)
The template/backend layer. `src/providers.js` (`loadProviders()`,
`getProviderTemplate()`, `buildProfileFromTemplate()`) reads the read-only
catalog `config/providers.json` - 9 shipped templates: `claude-cloud`,
`lm-studio`, `glm`, `kimi` (all `wireVia: 'direct'`), and `ollama`, `codex`,
`gemini`, `grok`, `openai-compatible` (all `wireVia: 'ccr'`, routed through a
locally-run `claude-code-router` gateway - see Phase 4 below for how that
actually works). `src/profiles.js` got `addProfile`/`updateProfile`/
`removeProfile` (writing to gitignored `config/profiles.local.json`) and
`redactProfile()` (strips secrets before anything crosses IPC). Full CRUD IPC
was wired in `src/main.js` + `src/preload.js` at this point too: `profiles:list`,
`providers:list`, `profiles:add-from-template`, `profiles:update-from-template`,
`profiles:remove` - Phase 3's UI is built entirely on IPC that already existed
from this commit.

### Phase 2 — DONE (`0210e4d`)
`src/lmstudiocli.js`: a `lms` CLI wrapper (`execFile`, never `shell:true`) that
lists every model DOWNLOADED to disk (not just a running server's loaded one)
and force-loads one. New Settings section ("LM Studio", Ctrl+L) built on top:
`src/renderer/modules/lmstudiomodels.js` + i18n + HTML + CSS. This is the part
of "go local claude" that dealt with switching LM Studio's loaded model - it's
now fully replaced from inside LunaCore.

### Phase 3 — DONE (`461edf1`)
A new "AI providers" Settings section (Ctrl+L) that lets Mati add/edit/remove
a profile built FROM a provider template - no hand-editing
`config/profiles.local.json` ever again. Inline per-row add/edit forms;
hand-written profiles (`templateId: null`, e.g. the shipped `claude-cloud`) are
hidden from this list with a one-line "N other profiles are edited by hand"
hint. `redactProfile()` exposes derived non-secret facts (`model`, `fastModel`,
`hasApiKey`, `hasBaseUrl`) instead of the raw `env`.

### Phase 4 — DONE (`b84027b`)
`claude-code-router` (CCR) integration: LunaCore can detect/start/stop a local
CCR gateway process and hand off to its own management UI, plus a "Router
(CCR)" Settings block. **This phase's design changed mid-flight** after a live
install revealed the originally-planned architecture didn't match reality -
recorded here so nobody re-derives (or re-breaks) this.

**What was originally assumed (WRONG):** that LunaCore could author CCR's
`config.json` directly (providers/models/routing), matching CCR's old 1.0.x
architecture. `ccrConfig` (`{providerType, apiKey?, baseUrl?}` on a profile)
was built in an earlier pass of this same session specifically to support that.

**What's actually true** (verified live against `@musistudio/claude-code-router
v3.1.1`, the current published release - 1.0.x is an abandoned pre-rewrite
line): CCR stores its own config in a SQLite database and is configured ONLY
through its own browser-based management UI (`ccr ui`) - no CLI flags or
config file LunaCore can script. The gateway (the endpoint `claude` actually
talks to) defaults to `http://127.0.0.1:3456`; its real route for a model list
is `GET /v1/models` (not `/api/v1/models` - corrected from an initial
assumption during Phase 4a's build). There's no `ccr --version` flag; `ccr
--help`'s exit code is the "is it on PATH" signal instead. The management UI
runs on a separate port (3458 by default) and its URL carries an authenticated
`ccr_web_token` query param CCR itself treats as a password.

**The design that actually shipped ("launch + hand off to CCR's own UI"):**
LunaCore never sees or stores the user's real upstream provider secret
(OpenAI/Gemini/xAI/Ollama key) - that's entered directly into CCR's own UI,
once, by the user. The ONE credential LunaCore stores for a CCR-routed profile
is a **CCR client API key** (created by the user in CCR's UI under "API
Keys" - a different credential from the upstream secret), which flows straight
into `env.ANTHROPIC_AUTH_TOKEN` via `{{apiKey}}`, exactly like `glm`/`kimi`
already do. `ccrConfig` was deleted entirely - it had no remaining reason to
exist once LunaCore stopped authoring CCR's config. Model/fast-model fields
stay in the add/edit form as an OPTIONAL override, empty by default (blank =
let CCR's own Router decide; typing a value forces `ANTHROPIC_MODEL`/
`ANTHROPIC_SMALL_FAST_MODEL` for that profile) - also via `env`, also empty
unless the user types one.

**New/changed files:**
- `src/ccr.js` (new) - the lifecycle module. Pure: `gatewayPortFromEnv`,
  `candidatePorts` (covers CCR's own silent "port taken, try the next one"
  fallback), `classifyProbe`, `redactCcrOutput` (strips any `ccr_web_token`
  before a child-process string can reach a log/IPC payload), `describeState`.
  Impure, typed-never-throw: `detectCcr`, `probeGateway`, `findGateway`,
  `startGateway`, `stopGateway` (refuses on anything LunaCore didn't start
  itself), `openManagementUi` (NEVER returns a URL, by construction - CCR
  opens its own browser window with its own token), `testClientKey` (built,
  wired end-to-end via `ccr:test-key` IPC, but has no UI caller yet - staged
  for a future "Test connection" button, see main.js's comment on that
  handler; not a bug).
- `config/providers.json`, `src/providers.js`, `src/profiles.js`,
  `src/renderer/modules/providerform.js` - reshaped away from `ccrConfig`: the
  5 CCR templates now set `requiresApiKey: true` (including `ollama`, which
  didn't before - **unverified assumption, see below**), `defaultModel`/
  `defaultFastModel: ""`, and `envTemplate.ANTHROPIC_AUTH_TOKEN: "{{apiKey}}"`
  (was the literal `"ccr-local"`). `buildProfileFromTemplate()` now drops any
  env key that resolves to an empty string (so an unset model never reaches
  `pty.spawn()` as `ANTHROPIC_MODEL: ""`). New exports: `isCcrTemplate`/
  `isCcrProfile` (providers.js), `NON_SECRET_AUTH_TOKENS`/`isLegacyCcrProfile`
  (profiles.js - `isLegacyCcrProfile` is now wired into `redactProfile()`'s
  `isLegacyCcr` field and shown as a row badge, "needs your CCR key
  re-entered", for any profile still carrying the old `'ccr-local'` sentinel).
  `redactProfile()` also now exposes a sanitized `baseUrl` (template-generated
  profiles only).
- `src/main.js`/`src/preload.js` - six new `ccr:*` IPC handlers
  (`status`/`start`/`stop`/`open-ui`/`docs`/`test-key`), a fire-and-forget
  `ensureGatewayFor()` called from `spawnInto()` when a CCR-routed profile
  spawns (never blocks tab startup), `ccrStartedByUs` tracking so `ccr:stop`
  refuses to touch a gateway LunaCore didn't start. Passed a dedicated
  security review (no CRITICAL/HIGH findings) - the one LOW finding
  (`ensureGatewayFor()`'s fire-and-forget call had no `.catch()`) was fixed.
- `src/renderer/modules/ccrsettings.js` (new) - a "Router (CCR)" Settings
  block, mounted in `termcustom.js` above the existing "Dostawcy AI" section.
  Status line + Start/Stop/"Open CCR settings"/Install-help buttons, matching
  the existing LM Studio/AI-providers section's exact visual language (no new
  design system - this was deliberate, see Gate 1 below). Includes the single
  most important string in this phase: an explanation that the API key field
  on a CCR-routed profile is a **CCR client key**, not the user's real
  provider key.

**Gate 1 decisions Mati made for this phase** (don't re-ask, don't re-derive):
1. CCR is detected on PATH, never bundled as a dependency - same pattern as
   the `lms` CLI already uses.
2. Only one CCR gateway process/config exists app-wide (not per-tab) - CCR's
   own UI owns routing for every LunaCore tab identically. A tab spawning
   under a CCR profile auto-starts the gateway silently if it's down.
3. A per-profile `ccrPort` field exists in the add/edit form (threaded through
   `buildAddPayload`/`buildEditPayload`, validated 1-65535) for when CCR's own
   port-fallback picks a different port than 3456.
4. Model/fast-model fields stay visible for CCR profiles as an optional,
   empty-by-default override (see above).
5. LunaCore refuses to touch (start/stop/reconfigure) a CCR instance it did
   not itself start - protects a pre-existing manual CCR setup.
6. **Unverified assumption, flagged for Mati to confirm once CCR's UI is
   actually open:** CCR's gateway requires a client API key for every request,
   even a local Ollama backend - `requiresApiKey: true` was set on all 5 CCR
   templates on that basis. If wrong, it's a one-line JSON boolean flip, not a
   redesign (deliberately chosen so a wrong guess here is cheap).

**Deliberately deferred, not built this phase (documented, not silently
dropped):**
- **No per-tab status strip.** This codebase has no existing toast/per-session
  banner component to hook into, and a CCR-routed tab that can't connect
  already fails exactly like any other unreachable local-endpoint profile
  (LM Studio included) does today - as ordinary `claude` connection-error
  output in that tab's terminal. Building new UI infrastructure for this was
  judged out of scope for what Mati actually asked for.
- **No "Test connection" button.** `ccr:test-key`/`testClientKey()` are fully
  built, typed, and unit-tested, just not wired to a UI trigger yet - see the
  comment on the `ccr:test-key` handler in `main.js`.

**Review findings, all fixed before commit:**
- Security review (no CRITICAL/HIGH): one LOW finding, `ensureGatewayFor()`'s
  fire-and-forget call lacked a `.catch()` - fixed (defense-in-depth against a
  future change reintroducing a throw path).
- Code-quality review (no CRITICAL/HIGH): two MEDIUM findings, both about the
  same shape - `isLegacyCcrProfile`/`testClientKey` were built but had no
  caller. `isLegacyCcrProfile` is now wired into the UI (badge). `testClientKey`
  stays staged/documented rather than rushing a "Test connection" UX Mati
  didn't ask for.

**Not yet done for Phase 4:** same caveat as Phases 2/3 - no browser/GUI
automation tool was available to click through the new Settings block
visually. Everything verifiable programmatically (syntax, the pure decision
functions' unit coverage, the full suite, i18n key parity) checks out clean,
but Mati hasn't personally confirmed it renders/behaves correctly yet. Also
unverified: assumption #6 above (Ollama needing a CCR client key) - only
confirmable once CCR's own UI is opened and a provider is actually added.

---

## What's next

### Phase 5 — LM Studio redesign: dedupe profiles, real load-param UI, root-cause the 400

**Status: 5a/5b/5d DONE (2026-09-22, uncommitted). 5c still open - see below.**
Mati said "we do everything" to the plan below, then asked separately how to
use CCR and link Gemini/Codex through it (answered in chat, not written here
since it's usage guidance, not a code change).

What shipped this pass:
- **5a**: `config/profiles.json`'s shipped `lm-studio` entry now carries
  `"templateId": "lm-studio"`, so it is visible/editable in the AI-providers
  panel. The `lm-studio-2` duplicate was already gone from Mati's real
  `profiles.local.json` (removed via the UI at some point between sessions -
  `removedIds: ["lm-studio-2"]`, `profiles: []` when checked this session), so
  no rename migration was needed after all.
- **5b**: `main.js` now instantiates one module-level `LocalModelWatcher`
  and, in `spawnInto()`, calls `localModelWatcher.setEndpoint(...)` +
  `resolveAutoModel(profile, localModelWatcher.current())` before building
  `env`, injecting `ANTHROPIC_MODEL` last (never overriding an explicit
  model). Known limitation, documented in-code: the very first spawn onto a
  local endpoint the watcher hasn't sampled yet still falls back to `claude`'s
  own default model - the watcher's first tick (network probe) can't
  complete synchronously. Every restart/spawn after that first sample lands
  auto-resolves correctly.
- **5d**: `lmstudiocli.js`'s `buildLoadArgs` accepts `contextLength`
  (`-c/--context-length`) and `parallel` (`--parallel`), verified live against
  `lms load --help`. `lmstudiomodels.js` grew a per-model collapsible options
  panel (5 fields: context length, GPU offload [auto/off/max/custom ratio],
  parallel, TTL, identifier) backed by a `Map` keyed by model key so
  in-progress edits survive the list's re-renders. New pl/en i18n keys under
  `lmstudio.options.*`, plus a static hint saying the other ~10 sliders stay
  in LM Studio's own dialog. Also fixed the stale 404 `docsUrl`.
- Tests: added `contextLength`/`parallel` cases to
  `test/lmstudiocli.test.js`. Full suite: **1339 pass, 0 fail**.
- `ecc:typescript-reviewer` pass (5e) found one real HIGH issue, now fixed:
  the first version of 5b used a single MODULE-LEVEL `LocalModelWatcher`
  shared across every tab. Two sessions on two different local-endpoint
  profiles would repeatedly flip its one `endpoint` pointer and wipe each
  other's cached reading on every restart - a realistic setup now that Phase
  3 lets you add multiple LM Studio/local profiles from Settings, not a
  hypothetical. Fixed by moving the watcher onto the SESSION object itself
  (`session.localModelWatcher`, lazily created in `spawnInto`, stopped only
  in `closeSession` - NOT in `teardownSession`, so a same-endpoint restart
  keeps its warm sample). Full suite re-run after the fix: still 1339/1339.
  Everything else in the review (IPC validation, renderer event delegation,
  `autoModel` preservation through the template system) came back solid.

**5c is SOLVED by Phase 7 below (the loopback shim) - the CCR experiment
was never needed. The text that follows is kept as the historical record.**
Original note: 5c (the 400 root-cause fix) was still open and needed a live
session with Mati (CCR's UI requires manual clicks with real provider
keys). Superseding the old Phase 5 candidate list
below (kept at the bottom as Phase 6 candidates) - Mati reported two concrete
problems on 2026-09-22: (a) the LM Studio profile in Settings "cannot be
edited," and (b) a real LM Studio session immediately throws
`API Error: 400 request.messages.1.role: Invalid discriminator value.
Expected 'user' | 'assistant'`. He also wants LunaCore's own Settings to let
him pick a downloaded LM Studio model AND set its load parameters (context
window, GPU offload, etc. - the LM Studio "Load" dialog sliders), fully
replacing any need to touch LM Studio's own UI for that.

Everything below was verified LIVE against this machine before writing this
plan (installed `lms` CLI, the running LM Studio server, `claude --version
2.1.278`, `ANTHROPIC_LOG=debug`) - not guessed from docs or training data, per
the standing rule in this repo's session memory about verifying external
tools live before designing around them.

#### What's actually broken (root-caused, not guessed)

1. **Duplicate, half-editable LM Studio profiles.** `config/profiles.json`
   ships a HAND-WRITTEN `lm-studio` entry (no `templateId`) -
   `providerform.js`'s `generatedProfiles()` only lists profiles with a
   `templateId`, so this shipped one is invisible to the AI-providers edit
   panel - that's the literal "cannot be edited" bug. When Mati used "AI
   providers" to add LM Studio anyway, `addProfile()` couldn't reuse id
   `lm-studio` (already taken by the shipped entry) and minted `lm-studio-2`
   instead - confirmed present in his real `config/profiles.local.json`.
   Two near-identical LM Studio profiles now exist side by side; only the
   second is editable, and nothing in the UI explains the split.

2. **`resolveAutoModel()` is dead code.** `src/lmstudio.js` fully builds,
   exports, and documents this function - its own header comment says
   *"so spawnInto() can call it synchronously off the watcher's last sample -
   see src/main.js"* - but grepping `main.js` for `resolveAutoModel` or
   `autoModel` returns zero matches. It is never called. Every LM Studio
   session spawns with no `ANTHROPIC_MODEL` at all, so `claude` silently
   falls back to its own built-in default (`claude-sonnet-5`) regardless of
   what is actually loaded in LM Studio. `autoModel: true` on the profile
   has never done anything.

3. **The 400 crash is NOT a LunaCore config bug - it's LM Studio's own beta
   Anthropic-compat endpoint rejecting a valid modern request.** Reproduced
   live with `ANTHROPIC_LOG=debug`:
   - `claude` correctly POSTs to `http://localhost:1234/v1/messages?beta=true`
     - LunaCore's base-URL shape (`http://localhost:1234`, no trailing `/v1` -
     `claude` appends `/v1/messages` itself) matches LM Studio's own current
     docs exactly (confirmed live via WebFetch against
     `lmstudio.ai/docs/developer/anthropic-compat/messages` - the *old*
     `docsUrl` in `config/providers.json`,
     `lmstudio.ai/docs/api/endpoints/anthropic`, now 404s and needs updating).
     This is NOT the historical "double /v1" trap (`src/lmstudio.js`'s header
     comment) - that one's already fixed.
   - LM Studio's server rejects the request in 21ms, before generation ever
     starts - confirmed it never reaches `lms log stream` (which only logs
     requests that pass validation; a manual control request over the same
     endpoint DID show up in the log, proving the log mechanism itself
     works and the real request really is being rejected at the door).
   - Explicitly ruled out the model name as the cause: forcing a real,
     locally-loaded model id (`--model qwen2.5-coder-14b-instruct`) produces
     the IDENTICAL 400. The dead auto-model bug (#2) is real and worth fixing,
     but it is not what causes this crash.
   - The actual request `claude` v2.1.278 sends is a large, modern Anthropic
     payload: a `system` field as an array of 3 content blocks, 300+ tool
     definitions, and several beta features via the `anthropic-beta` header
     (`context-management-2025-06-27`, `mid-conversation-system-2026-04-07`,
     `prompt-caching-scope-2026-01-05`, among others). LM Studio's Anthropic
     endpoint is a newer/beta feature on their side; the working theory is it
     mishandles one of these modern shapes while reconstructing its internal
     message list, producing an extra/relabeled entry its own schema then
     rejects. LunaCore has no way to change what `claude` sends - this is
     either an LM Studio bug to report upstream, or something to route
     around (see 5c below).

4. **Only 5 of the ~15 sliders in Mati's screenshot are scriptable at all.**
   Live-checked `lms load --help`: the full flag set is `--context-length`,
   `--gpu`, `--parallel`, `--ttl`, `--identifier` - nothing else. Checked
   LM Studio's own preset/config storage for an undocumented path per Mati's
   "investigate anyway" answer: `~/.lmstudio/config-presets` and
   `~/.lmstudio/.internal/user-concrete-model-default-config` both exist but
   are EMPTY on this machine - nothing persisted there to reverse-engineer.
   `~/.lmstudio/settings.json` confirms an `experimentalLoadPresets` key,
   matching the screenshot's own "Experimental" badges on CPU Thread Pool
   Size / Evaluation Batch Size / Max Concurrent / Unified KV Cache - LM
   Studio itself does not consider this a stable surface yet. Building
   against it would mean reverse-engineering an explicitly experimental,
   undocumented feature that can silently break on any LM Studio update.
   Conclusion: ship the 5 real ones; do not attempt the rest.
   **Superseded by Phase 7:** the official `@lmstudio/sdk` load config
   reaches expert offload, flash attention, K/V cache type and eval batch,
   so the Settings panel now loads through the SDK. CPU threads remain
   LM Studio-only (no SDK field).

#### Proposed work, in order

**5a. Fix the profile duplication (low risk, do first).**
- Delete the hand-written `lm-studio` entry from `config/profiles.json`
  (consolidating to one profile, per Mati's decision).
- One-time migration: rename the existing `lm-studio-2` entry in his real
  `config/profiles.local.json` back to id `lm-studio`, carrying over its
  current env unchanged. Confirmed via grep that no source file hardcodes the
  `'lm-studio'` id string, so this rename is safe.
- If `activeProfile` currently points at `lm-studio-2`, update it to
  `lm-studio` in the same pass so the active tab doesn't silently change.

**5b. Wire up the dead auto-model code (low-medium risk).**
- Call `resolveAutoModel()` from `spawnInto()` (`main.js`), reading the
  `LocalModelWatcher`'s last sample for the profile's endpoint (need to find
  where that watcher instance already lives - it's used for the Settings
  local-model status tile) and inject the result into `env.ANTHROPIC_MODEL`
  before `pty.spawn()`, only when it resolves non-null (never override an
  explicit model).
- Add a unit test exercising this decision in isolation (it's already pure
  per lmstudio.js's own doc comment - the new code is just the wiring, which
  may need extracting spawnInto's env-assembly into a small testable helper
  first, same shape `withClaudeOnPath`/`stripClaudeSessionMarkers` already
  use).

**5c. 400 root-cause mitigation - needs a decision with Mati, not a
guaranteed fix.**
- Present the finding above as-is. Proposed experiment: reconfigure the
  `lm-studio` provider template to route via CCR
  (`wireVia: 'ccr'`, `ccrProviderType: 'openai-compatible'`) pointed at LM
  Studio's OWN mature, non-beta `/v1/chat/completions` endpoint instead of its
  beta Anthropic endpoint - same pattern already shipped for ollama/codex/
  gemini/grok in Phase 4. CCR is already installed and detectable.
- This needs a few manual clicks in CCR's own browser UI (add LM Studio's
  OpenAI-compatible endpoint as an upstream provider there, generate a CCR
  client key) before we'll know whether it actually avoids the 400 - it is a
  hypothesis to test live together, not something to commit to blind.
- Fallback if CCR routing does NOT help: pattern-match this specific failure
  in the existing terminal-output scanner (`main.js`'s `proc.onData`, same
  mechanism already used for approval-prompt/signal detection) and surface a
  clear message pointing at the LM Studio issue tracker instead of the raw
  SDK error.
- Regardless of outcome, fix the stale `docsUrl` in `config/providers.json`'s
  `lm-studio` entry (currently 404s).

**5d. Redesign the LM Studio Settings panel - the actual UI ask.**
- Extend `lmstudiocli.js`'s `buildLoadArgs`/`loadModel` to accept the 5 real
  parameters (context length, GPU offload, parallel/"max concurrent", TTL,
  identifier) - `gpu`/`identifier`/`ttl` are already there; add
  `contextLength` and `parallel`.
- Extend `lmstudiomodels.js` + the Settings HTML/CSS so each model row (or an
  expandable "advanced" section per row) exposes these 5 as inline fields
  before the Load button, defaulting to blank/"let LM Studio decide" - never
  a forced value the user didn't type.
- Explicitly do NOT build the remaining ~10 sliders - add a short pl/en
  Settings hint that those stay inside LM Studio's own Load dialog, since
  there is no stable way to script them (see finding #4).
- i18n: new pl/en keys for the 5 fields + the hint, no-diacritics convention
  for the pl strings per this repo's CLAUDE.md.

**5e. Tests + review.**
- `ecc:typescript-reviewer` after 5a-5d land (this repo's JS-covering
  reviewer).
- `ecc:silent-failure-hunter` specifically on 5b/5c - both are exactly the
  "something fails without telling anyone" shape.
- Update this file with the real outcome, same as every prior phase -
  especially whether 5c's CCR experiment actually worked.

#### Open question for Mati before coding starts
Whether to run 5c's CCR-routing experiment live together first (a few manual
clicks in CCR's UI, uncertain outcome), or ship 5a/5b/5d first - profile
cleanup, the auto-model fix, and the real load-parameter UI - and leave the
400 as a documented known issue for now.

### Phase 7 — DONE (2026-09-24): LM Studio runs the full Luna harness

Goal from Mati: qwen/qwen3-coder-next (80B MoE) in LM Studio running Luna
exactly like Claude - CLAUDE.md, rules, skills, agents, hooks - fast enough
for long unattended coding runs. **Standing rule: never trim ~/.claude**;
every speed-up is load tuning or CLI launch flags only.

**Root cause of the 400 (found live):** Claude Code sends SessionStart hook
output as a mid-conversation `role: "system"` message; LM Studio's
Anthropic endpoint only accepts user/assistant. No CLI env var turns it off.

What shipped:
- **`src/lmstudioshim.js`** - loopback proxy (127.0.0.1, random port) in
  front of LM Studio. Rewrites each system message into a user message
  wrapped in `<system-reminder>`, merges consecutive same-role messages,
  keeps tool_result blocks first. Everything else streams through untouched.
  Rejects foreign Host headers, forwards only to a local upstream, 32 MiB
  body cap, 60 s request-receipt timeout, never logs bodies. One shim per
  upstream, stopped on app quit.
- **`src/locallaunch.js`** - before a local tab's pty spawns: probes the
  loaded model, starts the shim, maps EVERY tier env var (opus/sonnet/
  haiku/fable/small-fast) to the loaded model, sets
  `CLAUDE_CODE_MAX_CONTEXT_TOKENS` to the loaded context, and adds the lean
  flags (`--strict-mcp-config` with an empty MCP file, `--disallowedTools`
  for 14 built-in CLI tools a local session never uses). Never rejects; a
  failed step degrades to the direct upstream. `spawnSeq` drops stale preps.
  Measured: first-turn request 141 KB -> 98 KB, full test 6m41s -> 1m04s.
- **Settings toggles** (AI providers -> edit LM Studio): shim / no MCP /
  hide unused tools, defaults from `config/providers.json`'s
  `localLaunch`, per-profile override stored in profiles.local.json. The
  hint says ~/.claude always loads in full.
- **`src/lmstudiosdk.js`** (`@lmstudio/sdk` pinned 2.0.0) replaces
  `lms load`: whitelist-validated load options incl. MoE expert offload,
  flash attention, K/V cache type, eval batch; unloads other models first by
  default (checkbox); single-flight with an abortable 5-min timeout; the
  model list now marks what is loaded. Verified live: 23 s reload of the
  80B with the tuned settings.
- **`lms` CLI kept only as the waker.** Mati's condition was to remove it
  only if the SDK can wake LM Studio - it cannot (it only connects to a
  running instance on its API ports, verified in the SDK source), so
  `src/lmstudiocli.js` shrank to detect + `lms server start` + the shared
  downloaded-model normalizer. The wake path itself was not exercised live
  (it would have meant killing LM Studio); it uses the same mechanism
  `lms load` always relied on.

Best-known load for the 80B on this machine (RTX 16 GB): 128k context, q8
K/V, flash attention, eval batch 2048, GPU max + expert offload 0.85, CPU
threads 6 (set in LM Studio's My Models) - ~268 tok/s prompt, ~35 tok/s
generation. Prompt processing is the ceiling (llama.cpp's Qwen3-Next path);
no setting moves it further.

Reviews (ecc:typescript-reviewer + ecc:security-reviewer, 2026-09-24): no
CRITICAL. Fixed: the load lock now follows the real (possibly aborted) load,
not the timeout race, with a 60 s grace bound and an ownership token; an
unknown model key is refused BEFORE anything is unloaded; the panel's
"running" flag now also flips back to false on a failed list; out-of-order
list refreshes are dropped. Accepted risk (MEDIUM): `findApiPort` trusts any
local process answering `{"lmstudio":true}` on the SDK's fixed ports - the
same check the SDK itself makes, and exploiting it already requires running
code as the user.

Open follow-ups: ~~per-shim auth token~~ (done in Phase 8); verify CCR route
names before Codex; the Kimi Code template; an "overnight run" mode.

### Phase 8 — DONE (2026-09-24): hardening + the Phase 6 items a cloud session could do

Picked from the Phase 6 / Phase 7 follow-up list: everything buildable and
verifiable without Mati's LM Studio, a real CCR install, or provider keys.

- **Bug fixed: `CLAUDE_CODE_*` env from a profile never reached the CLI.**
  `spawnInto()` ran `stripClaudeSessionMarkers()` on the MERGED env, after the
  profile and local-launch layers - so Phase 7's
  `CLAUDE_CODE_MAX_CONTEXT_TOKENS` and GLM's `CLAUDE_CODE_SUBAGENT_MODEL` were
  deleted before `pty.spawn` (the /ask path had the same bug). New
  `src/sessionenv.js` (`buildSessionEnv(inherited, ...layers)`) strips the
  inherited env only, then layers profile / auto-model / launch overrides.
  Verified live: with the fix, `claude` 2.1.281 refuses a turn with "Prompt is
  too long" when the value is 8192, which proves the CLI now receives it. The
  README's env table always described the fixed order; the code now matches.
  Phase 7's "6m41s -> 1m04s" measurement was taken outside `spawnInto`, so
  context-aware auto-compaction in real LM Studio tabs starts working only now.
- **Per-shim auth token** (Phase 7 follow-up). Each `LmStudioShim` generates
  `crypto.randomBytes(32)` hex; every request must carry
  `x-lunacore-shim-token` (constant-time compare) or gets a 401 in Anthropic
  error shape, checked after the Host check and before anything is
  forwarded. The header is stripped before forwarding; the client's own
  `Authorization` passes through untouched. `locallaunch.js` hands the token
  to the tab via `ANTHROPIC_CUSTOM_HEADERS`, merged with any value the
  profile sets (or, if it sets none, the one inherited from the shell). The
  shim URL is only used when a token exists, otherwise the tab goes direct.
  An inherited shim-token line (LunaCore started from inside a LM Studio tab)
  is stripped like any other session marker, so non-shim tabs never send it
  to a provider. Scope, stated honestly in the shim's header: it stops
  browser pages and other users' processes, not same-user processes (the
  token sits in the tab's env), and LM Studio's own port stays open on
  loopback. Verified live end to end with the real CLI through the real shim
  to a fake upstream: request forwarded, token not leaked upstream,
  `Authorization` and the profile's own custom header intact, a token-less
  request gets 401. A browser page can no longer drive the shim: a custom
  header forces a CORS preflight the shim never approves.
- **Phase 6 #4 - CCR IPC extracted** to `src/ccrcontrol.js`
  (`createCcrControl({send, getProfiles, getProviders, openExternal, safeUrl})`
  -> `registerIpc`, `ensureGatewayFor`, `shutdown`, `isStartedByUs`). With
  `profileinput.js` below, main.js went 2773 -> 2551 lines. The handlers are now unit-tested
  (`test/ccrcontrol.test.js`). `ccr:test-key` is also stricter: non-string or
  unknown id -> `unknown-profile`, non-CCR profile -> `not-ccr` (a GLM/Kimi
  key is never sent anywhere), blank key or `NON_SECRET_AUTH_TOKENS` sentinel
  -> `no-key`, non-loopback base URL -> `not-local`. All four are refused before any
  network call.
- **Phase 6 #2 - "Test connection" button** on every CCR-routed row in
  Settings -> AI providers. Only the profile id crosses IPC. The row shows
  what each outcome means: connected + model count, key OK but no provider in
  CCR yet, key rejected (with the "client key, not provider key" hint), gateway
  down, foreign process on the port, no key stored, not local. Results are kept per row
  across re-renders, dropped on edit/remove, and a result landing after an
  edit is discarded. Pure mapping in `providerform.js`
  (`canTestConnection`, `testResultMessage`, `TEST_RESULT_KEYS`), tested.
- **Phase 4 gap closed - the CCR port field.** Gate 1 decision #3 said the
  add/edit form has a per-profile port field. The payload layer supported it,
  but `providersettings.js` never rendered the input, and
  `providers.error.invalidPort` had no translation. Both are fixed: the port field
  shows for `{{ccrPort}}` templates and the edit form prefills it from the
  profile's base URL (`portFromBaseUrl`). `buildProfileFromTemplate` now also rejects a
  numeric port outside 1-65535 with `invalid-port` (it used to accept e.g.
  70000 and build `http://localhost:70000`).
- `failureKey`/`testResultMessage` use an own-property lookup, so a reason
  like `constructor` can't resolve to an inherited `Object` property.
- **Pre-existing IPC holes closed (security review finding, HIGH + MEDIUM).**
  `profiles:add/update-from-template` spread the raw renderer payload into
  `buildProfileFromTemplate`, which honours `extraEnv` for any key the
  template declares. A compromised renderer could therefore repoint a stored
  GLM key's `ANTHROPIC_BASE_URL` to its own host (the key is kept on an edit
  that does not resend it). And an edit could switch a GLM profile to a CCR
  template while keeping the key, which the new `ccr:test-key` would then
  send to a loopback port. New `src/profileinput.js` (`pickTemplateInput`,
  `resolveTemplateAdd`, `resolveTemplateUpdate`) keeps only the form's own
  fields and refuses a template switch (`template-mismatch`) or a
  hand-written profile. It holds main.js's keep-current rules, moved as-is. Both
  handlers are now four lines, and the rules are unit-tested
  (`test/profileinput.test.js`, including both attack payloads). Any numeric
  `ccrPort` on edit now reaches the same 1-65535 check as on add.

**Reviews** (general-purpose agents standing in for ecc:security-reviewer /
ecc:typescript-reviewer, which this cloud environment does not have). No
CRITICAL. The only HIGH was the pre-existing `extraEnv` hole above; fixed.
Everything else is fixed as well:
- the Test button's full `render()` wiped an open add/edit form. It now
  repaints only its own row, and a live GUI regression check confirms a
  typed-but-unsaved key survives;
- the inherited shim-token leak;
- the shim comment overstated what the token protects;
- inherited custom headers were dropped in shim tabs;
- the edit form's port placeholder promised "default" where blank keeps the
  current port;
- add and edit validated ports differently;
- a stale test result stayed after a gateway start/stop (now cleared on
  `ccr:state`);
- no test compared a wrong token of the same length.

Reviewer note worth acting on: now that `CLAUDE_CODE_MAX_CONTEXT_TOKENS`
actually reaches LM Studio tabs, run one with a SMALL loaded context (e.g.
4096) and check it compacts or refuses cleanly instead of overflowing.

**Clicked through for real** (first time for this feature): Electron 43 under
xvfb, driven by Playwright, against a fake CCR gateway on 127.0.0.1:3456 that
accepts one client key. Steps: add an Ollama (via CCR) profile with a wrong
key -> Test connection -> rejected-key message; Edit -> port prefilled 3456,
70000 -> "The port must be a number from 1 to 65535."; enter the right key ->
Save (the old result clears) -> Test -> "Connected - the key works, models in
CCR: 2." Not verified: a REAL CCR install (still Phase 6 #1 / assumption #6)
and a real LM Studio tab end to end.

Small pre-existing thing noticed, not changed: a CCR template's Model field
placeholder reads "default: " with nothing after it (the CCR templates ship
`defaultModel: ""`). A "blank = CCR's router decides" hint would read better.

### Phase 8b — DONE (2026-09-24): two Phase 8s merged, overnight guard wired

Phase 8 was built twice in parallel: once locally (`feat/overnight-guard`,
`83c8b9e`) and once in a cloud session (`ai-providers-phase-8`, `ee3cf38`,
the section above). Both were green alone but conflicted in 8 files (each had
its own `ccrcontrol.js` and shim token). Mati picked the cloud branch as the
base; `082e53c` ports what only the local branch had:

- **Kimi Code template** (`kimi-code`): `https://api.kimi.ai/coding/`, auth
  via `ANTHROPIC_API_KEY` per Kimi's docs, all tiers -> `k3-256k` (type
  `k3[1m]` for the 1M plan), context/auto-compact 262144, effort high.
  `profileAuthKey()` (profiles.js) reads whichever of `ANTHROPIC_AUTH_TOKEN` /
  `ANTHROPIC_API_KEY` a profile uses, for `hasApiKey` AND for
  `profileinput.js`'s keep-key-on-edit. Without the latter, editing a Kimi
  Code profile failed with `missing-api-key` (found while merging; test
  added). Not yet tried with a real key.
- **Shim probe exemption**: the CLI's `HEAD /api/hello` connectivity probe
  carries no custom headers (seen live on claude 2.1.278), so exactly that
  request (HEAD, that path) skips the token check. It has no body and cannot
  start a generation.
- **`API_TIMEOUT_MS` = 50 min** on every local tab unless the profile sets it
  (`LOCAL_API_TIMEOUT_MS` in locallaunch.js). The CLI default is 10 min; a 128k
  prefill measured ~8 min on a 16 GB card.

**Overnight guard** = hardening a God Mode run, NOT a new runner or toggle.
`src/overnight.js` (`createOvernightGuard`, `recoverLocalBackend`) is now
wired:
- **main.js**: the guard is built next to `ccrControl`. For the run's
  lifetime it holds `powerSaveBlocker('prevent-app-suspension')` (the screen
  may still turn off) and sets `setBackgroundThrottling(false)` so a minimized
  window keeps God Mode's timers. Only an **LM Studio** tab (one
  `resolveLocalLaunch` accepts) gets the 30 s backend watchdog. A CCR gateway on
  loopback is deliberately excluded, because waking LM Studio cannot fix it.
  One bad probe is re-checked 3 s later before anything acts on it. Recovery =
  `lms server start` -> SDK list -> reload ONLY if nothing is loaded. It reloads
  the model this run last saw loaded; the last successful Settings load
  (`lastLmStudioLoad`, a shallow copy of the `lmstudiocli:load` payload,
  re-validated by `buildLoadRequest`) only contributes its options when it is
  for that same model, or when the run never saw one loaded. (The first cut
  preferred the app-wide Settings load, which could swap in a model loaded
  for another tab - security-review HIGH, fixed + tested.) 3 failed
  recoveries -> `backendLost`.
  New IPC `godmode:run` (renderer -> main): arms the guard only for a live
  session id, anything else releases it. `onApiError` also pokes the guard
  (`onConnectionError`), `closeSession` forgets the tab, quit calls `stop()`.
- **preload.js**: `setGodModeRun(sessionId|null)`.
- **godmode.js**: reports the run on arm / finish / disarm. New phase
  `waiting-backend` (shown as "restoring the local model" / "przywraca
  lokalny model"). The pure transition is `backendSignalStep()`, tested in
  `test/godmode-backend.test.js`:
  `backendRecovering` -> wait (timers cleared, a drop already seen is
  remembered); `connectionError` while waiting -> remembered, no retry;
  `backendRecovered` -> running, pasting `continue` ONLY if a request dropped
  (the CLI may have retried by itself); `backendLost` -> stalled.
- main.js is 2600 lines (was 2551).

**Not verified live yet** - Mati is testing on 2026-09-25. What to check:
1. God Mode on an LM Studio tab, window minimized: the machine does not sleep
   and the run keeps going.
2. Mid-run, eject the model in LM Studio: within ~30 s the status reads
   "restoring the local model", the model comes back, and the run resumes.
3. Quit LM Studio's server mid-run: same, via `lms server start`.
4. God Mode on a cloud (Claude) tab: no watchdog, only the sleep blocker.
5. A Kimi Code profile with a real key: add, edit without re-entering the
   key, open a tab.

Known limits:
- The watchdog's upstream is resolved when the run is armed. If the tab's
  profile is switched mid-run, it keeps watching the old endpoint until the
  run is re-armed.
- Accepted (security-review MEDIUM): `godmode:run` checks only that the id is
  a live session - main has no independent knowledge of a God Mode run. A
  compromised renderer could hold the sleep blocker, or watch a tab that is
  not running God Mode. That is bounded by the recovery rule above: it only
  reloads when nothing is loaded, and only loopback LM Studio is ever woken.

### Phase 6 — further polish (old Phase 5 candidates, lower priority)
#2 and #4 are DONE in Phase 8 (see above). Still open: #1 and #3.
Candidates from before Mati's 2026-09-22 report, roughly in likely-usefulness
order:
1. Click through the app for real (Ctrl+L → Router (CCR) section, and the AI
   providers section for a CCR template) and confirm assumption #6 from
   Phase 4 above once CCR's UI is open with a real provider configured.
2. Wire a "Test connection" button using the already-built `ccr:test-key` IPC,
   if the manual click-through above shows it'd genuinely help (e.g. people
   pasting the wrong kind of key is a real confusion point).
3. A per-tab status strip, if a CCR gateway failure turns out to be
   meaningfully less discoverable in practice than a plain terminal error -
   would need a new toast/banner component this codebase doesn't have yet.
4. `src/main.js` is now ~2665 lines (pre-existing oversized-file condition,
   not introduced by this feature) - the new CCR IPC block
   (`ccr:status`/`start`/`stop`/`open-ui`/`docs`/`test-key`, contiguous) is a
   clean extraction candidate into its own `registerCcrIpc()` function or
   module, same pattern `src/ccr.js` already set for the pure logic.

---

## How to resume this in a new session

Tell the new session: *"read reference/AI_PROVIDERS_RESUME.md."* Phases 1-5,
7, 8 and 8b are done - there's no blocking next phase. What is left needs Mati
or his machine:
- Phase 8b's live checklist (overnight guard + Kimi Code with a real key).
- Phase 6 #1: open CCR's own UI with a real provider and confirm assumption
  #6 (does the gateway need a client key even for Ollama?). The new Test
  connection button is the quickest way to check.
- Phase 6 #3: a per-tab status strip, only if a CCR failure turns out hard
  to spot in practice.
- Phase 7 follow-up: verify CCR route names before Codex.
- Re-measure a real LM Studio tab now that `CLAUDE_CODE_MAX_CONTEXT_TOKENS`
  actually reaches it (Phase 8's env fix).
Otherwise treat this feature as complete and ask what's next.

---

## Environment gotchas that cost real time this feature

- **The GateGuard hook blocks the first Write/Edit of each file** in a
  session until importers/callers, the affected API, any data schema, and
  the user's verbatim instruction are stated in the same message as the
  retry. Expect this on every new file this feature touches for the first
  time in a session; it is not a real error, just state the justification
  and retry.
- **A concurrent Claude session can share this git index.** Check `git
  status`/`git log` before committing; never `git add -A` - stage explicit
  paths only.
- Renderer modules in this repo use ESM `import`/`export` syntax but are
  plain `.js` files (no bundler in the loop for the app itself); `node
  --input-type=module --check < file.js` is how to syntax-check one from a
  shell without a browser, since plain `node --check` chokes on the ESM
  syntax.
- **A tool's real behavior can diverge from its own docs, or a fresh
  `npm install` can pull a much newer major version than expected.** Phase 4
  planned an integration against `claude-code-router`'s documented/assumed
  1.0.x-era architecture (a hand-authorable `config.json`); the actually
  installed latest version (3.1.1) turned out to be a full rewrite (SQLite +
  browser UI, no scriptable config). When integrating an external CLI/service
  this feature doesn't control the version of, install it for real and probe
  its actual behavior (`--help`, hit its real HTTP routes) before designing
  around its docs or training-data knowledge of an older version.
