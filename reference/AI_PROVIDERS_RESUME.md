# RESUME — AI providers feature

Operational hand-off for the AI-providers work. This is built directly on
`main` (no dedicated feature branch) via the `/orch-add-feature` gated
pipeline (Research → Plan → Gate 1 → TDD → Review → Gate 2 → Commit), one
phase at a time. Read this file first in a new session before doing anything
else on this feature - it says exactly where things stand and what Phase 4
needs to do.

Last updated: 2026-09-21, right after Phase 3 landed.

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
0210e4d  feat: let Settings load downloaded LM Studio models   (Phase 2, done)
03c47c0  feat: add AI-provider templates + /ask + highlights   (Phase 1, done - bundled with two unrelated features in one commit)
<uncommitted>  Phase 3: AI-provider profile CRUD in Settings   (done, not yet committed as of this file)
```

`npm test` → **1272 pass, 0 fail**, ~1s. `npm start` runs the app.

### Phase 1 — DONE (`03c47c0`)
The template/backend layer. `src/providers.js` (`loadProviders()`,
`getProviderTemplate()`, `buildProfileFromTemplate()`) reads the read-only
catalog `config/providers.json` - 9 shipped templates: `claude-cloud`,
`lm-studio`, `glm`, `kimi` (all `wireVia: 'direct'`, pointing `claude` straight
at the provider), and `ollama`, `codex`, `gemini`, `grok`, `openai-compatible`
(all `wireVia: 'ccr'` - routed through a **not-yet-built** local
claude-code-router instance, see Phase 4 below). `src/profiles.js` got
`addProfile`/`updateProfile`/`removeProfile` (writing to gitignored
`config/profiles.local.json`) and `redactProfile()` (strips secrets before
anything crosses IPC). Full CRUD IPC was wired in `src/main.js` +
`src/preload.js` at this point too: `profiles:list`, `providers:list`,
`profiles:add-from-template`, `profiles:update-from-template`,
`profiles:remove` - **all of Phase 3's UI is built entirely on IPC that
already existed from this commit.**

### Phase 2 — DONE (`0210e4d`)
`src/lmstudiocli.js`: a `lms` CLI wrapper (`execFile`, never `shell:true`) that
lists every model DOWNLOADED to disk (not just a running server's loaded one,
which is all `src/lmstudio.js`'s older passive HTTP watcher ever saw) and
force-loads one. New Settings section ("LM Studio", Ctrl+L) built on top:
`src/renderer/modules/lmstudiomodels.js` + i18n + HTML + CSS. This is the part
of "go local claude" that dealt with switching LM Studio's loaded model - it's
now fully replaced from inside LunaCore.

### Phase 3 — DONE, uncommitted as of this file
A new "AI providers" Settings section (Ctrl+L, placed right before the LM
Studio section) that lets Mati add/edit/remove a profile built FROM a
provider template - no hand-editing `config/profiles.local.json` ever again.

**New files:**
- `src/renderer/modules/providerform.js` - pure form logic, unit-tested
  (`test/providers-renderer.test.js`): which fields a template needs
  (`templateFields()`), building an add/edit IPC payload with the same typed
  rejection reasons `main.js`'s handlers use (`buildAddPayload`/
  `buildEditPayload`), mapping a failure reason to an i18n key (`failureKey`).
- `src/renderer/modules/providersettings.js` - the DOM/IPC half
  (`mountProviderSettings(root)`). UX: **inline per-row forms** - clicking
  "Edit" on a profile row replaces it with its edit form in place; clicking
  the top "Add profile" button inserts a new form row. Only one row is ever
  in form mode at a time. Hand-written profiles (`templateId: null`, e.g. the
  shipped `claude-cloud`) are hidden from this list with a one-line "N other
  profiles are edited by hand" hint rather than listed - see Gate 1 decisions
  below.

**Backend additions this phase needed (small, on top of Phase 1):**
- `src/profiles.js`'s `redactProfile()` now also derives and exposes
  `model`, `fastModel` (read out of `env`, never `env` itself) and
  `hasApiKey`/`hasBaseUrl` booleans (never the raw secret) - needed so the
  edit form can prefill and preserve the real current model instead of
  silently resetting it to the template default on every save.
- `src/main.js`'s `profiles:update-from-template` handler gained the same
  keep-current fallback for `model`/`fastModel` that `apiKey`/`baseUrl`
  already had (a real bug the code review caught: editing a profile's label
  used to silently reset its model).
- One new safe IPC round trip: `providers:open-docs` (`main.js` + `preload.js`)
  - the renderer only ever sends a template id; the URL is resolved
    server-side from the shipped `config/providers.json` and re-validated
    through `safeUrl()` before `shell.openExternal`, same trust pattern as
    the existing `libraries:open` handler.

**Gate 1 decisions Mati made for this phase** (don't re-ask, don't re-derive):
1. Editing a profile shows/preserves the REAL current model (not blind to it).
2. Add/edit forms are **inline per-row**, not a separate panel.
3. The docs link goes through the new safe `providers:open-docs` bridge, not
   a raw `<a href>` or `window.open`.
4. Hand-written profiles (`claude-cloud`) are hidden from this section with a
   count hint, not listed read-only and not removable from here.
5. (Carried from the planner's other defaults, not objected to): all 9
   templates are offered, with a "CCR lands later" note (`providers.note.ccr`)
   on the 5 CCR-routed ones; no `ccrPort` field yet (uses the 3456 default);
   adding a profile does NOT auto-switch the active tab onto it.

**Review findings, all fixed before commit:**
- Security (MEDIUM): `redactProfile()`'s docstring overclaimed what it strips
  (`command`/`args` pass through unredacted - harmless today, since every
  shipped template/profile only ever puts config in `env`/`ccrConfig`, but
  undocumented). Fixed by tightening the docstring to state the actual
  contract explicitly.
- Code review (HIGH): removing a profile that failed silently showed nothing
  to the user. Fixed - now shows a visible error via the panel's status line.
- Code review (MEDIUM): the model/fastModel keep-current fix above.
- Two minor completeness gaps (base-URL configured/missing state wasn't shown
  in a row's detail text or its status dot) - added.

**Not yet done for Phase 3:** Mati has not personally clicked through the
Ctrl+L → AI providers panel yet (no GUI automation tool available to verify
visually from this side). Worth a look before treating it as fully proven,
same caveat as Phase 2's LM Studio panel.

---

## What's next

### Phase 4 — `src/ccr.js`, NOT STARTED
The claude-code-router (CCR) proxy. **This is the load-bearing gap**: 5 of the
9 provider templates (`ollama`, `codex`, `gemini`, `grok`, `openai-compatible`)
are `wireVia: 'ccr'` - their generated profile points `claude` at
`http://localhost:{{ccrPort}}` (default 3456, `DEFAULT_CCR_PORT` in
`src/providers.js`), and nothing is listening there yet. A user who adds one
of these profiles right now gets exactly the warning the UI already shows
(`providers.note.ccr`: "this provider runs through CCR - CCR routing lands in
a later phase, so the profile saves but does not work yet") - **but it truly
does not work until this phase lands.**

What Phase 4 needs to do, based on what's already in place for it to consume:
- Each CCR-routed profile carries a `ccrConfig` field (`{providerType,
  apiKey?, baseUrl?}` - see `src/profiles.js`'s `normalizeCcrConfig()` and
  `src/providers.js`'s `buildProfileFromTemplate()`) that is stripped from
  the renderer by `redactProfile()` but IS available to the main process's
  own in-memory `profiles` array. `ccrProviderType` per template
  (`'ollama'|'openai'|'gemini'|'openai-compatible'`) is in
  `config/providers.json` already.
- `src/ccr.js` needs to: detect/manage a local claude-code-router process (or
  vendor/spawn it - not yet researched which CCR implementation LunaCore
  should drive), translate a profile's `ccrConfig` into whatever config
  format that router expects, and start/stop it in step with which
  CCR-routed profile is active in a tab.
- This is a `/plan`-worthy phase on its own (research: which CCR project/CLI,
  how it's configured, whether it needs to be bundled or is expected
  pre-installed) - do the Research step properly before writing code, per
  this repo's own `/orch-add-feature` workflow.

### Phase 5 — polish/docs, NOT STARTED
Whatever's left once Phase 4 actually makes the CCR-routed providers work:
README/FUTURE_PLAN updates, and re-walking the "CCR lands later" hint out of
the UI once it's no longer true.

---

## How to resume this in a new session

Tell the new session: *"read reference/AI_PROVIDERS_RESUME.md, then proceed
with Phase 4."* It should NOT re-ask the Gate 1 questions already answered
above, and should start Phase 4 with a `/plan`-style research pass (per this
repo's `CLAUDE.md`, delegate to `ecc:planner` - Phase 4 is a `src/main.js`
change plus a brand-new module, both explicit triggers), since the CCR
integration approach itself hasn't been decided yet.

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
  paths only (this file's own commit does exactly that).
- Renderer modules in this repo use ESM `import`/`export` syntax but are
  plain `.js` files (no bundler in the loop for the app itself); `node
  --input-type=module --check < file.js` is how to syntax-check one from a
  shell without a browser, since plain `node --check` chokes on the ESM
  syntax.
