# RESUME — AI providers feature

Operational hand-off for the AI-providers work. This is built directly on
`main` (no dedicated feature branch) via the `/orch-add-feature` gated
pipeline (Research → Plan → Gate 1 → TDD → Review → Gate 2 → Commit), one
phase at a time. Read this file first in a new session before doing anything
else on this feature - it says exactly where things stand and what's left.

Last updated: 2026-09-22, right after Phase 4 landed.

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
<uncommitted>  Phase 4: claude-code-router (CCR) lifecycle + UI      (done, not yet committed as of this file)
```

`npm test` → **1337 pass, 0 fail**, ~1s. `npm start` runs the app.

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

### Phase 4 — DONE, uncommitted as of this file
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

### Phase 5 — polish, NOT STARTED
Nothing is currently blocking - Phases 1-4 together deliver everything in the
original request. Candidates for a future pass, roughly in likely-usefulness
order:
1. Click through the app for real (Ctrl+L → Router (CCR) section, and the AI
   providers section for a CCR template) and confirm assumption #6 above once
   CCR's UI is open with a real provider configured.
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

Tell the new session: *"read reference/AI_PROVIDERS_RESUME.md."* Phases 1-4
are all done - there's no blocking next phase. If Mati wants Phase 5 work,
point at the candidate list above; otherwise treat this feature as complete
and ask what's next.

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
