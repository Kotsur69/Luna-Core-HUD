# CLAUDE.md

Instructions for Claude Code when working in this repository.

## Language

**All code comments must always be written in English** — regardless of what language the user's prompt is written in. This applies to `//`, `/* */`, `<!-- -->` comments, JSDoc, and JSON `_comment`-style keys.

This repo ships publicly (LunaCore is an open-source Electron app), so the codebase must read cleanly for any contributor, not just Polish speakers.

Do not translate:
- The `pl`/`en` values inside the localized-content system (`src/localized.js`, `src/renderer/i18n.js`, `src/renderer/modules/localize.js`) — the `pl` entries are genuine, intentional Polish UI text, not comments.
- `data-i18n*` attribute fallback values in `src/renderer/index.html` — same reason.

Polish UI strings in `config/*.json` are written **without diacritics**
(`wyslania`, not `wysłania`). Match that convention when adding entries.

## Agent Delegation — Authorized

**This CLAUDE.md explicitly authorizes proactive use of the Agent tool in this
repository.** Claude Code's default guidance is "do not use the Agent tool
unless the user, *a CLAUDE.md file*, or a skill asks for it" — this file is that
authorization. Do not wait to be asked again.

Delegate without prompting when:

| Trigger | Agent |
|---------|-------|
| Feature spanning 3+ modules, or any `src/main.js` change | `ecc:planner` |
| Code just written or modified | `ecc:typescript-reviewer` (covers JS) |
| Anything touching `src/preload.js` or IPC | `ecc:security-reviewer` |
| Bug fix or new feature needing tests | `ecc:tdd-guide` |
| Structural / architectural decision | `ecc:architect` |
| Renderer perf, jank, memory growth | `ecc:performance-optimizer` |
| Swallowed errors, empty `catch {}` | `ecc:silent-failure-hunter` |
| Dead code after a refactor | `ecc:refactor-cleaner` |

**Do NOT delegate** trivial edits, single-file changes, or anything already
sized for one context. Agents start cold with no conversation history — the
handoff cost only pays off for bounded, self-contained work.

### Completion contract

Applies at every depth. **Your final message IS the deliverable.** Never end a
turn with "waiting for background agents" — ending your turn while children run
orphans their results. If you delegate, you own collection: wait, integrate,
then answer.

## ECC Workflow In This Repo

Project context: Electron app, `main` / `preload` / `renderer`, plain JavaScript
(no TypeScript), `node --test` with 58 test files in `test/`, packaged by
`electron-builder`. Entry point `src/main.js`.

| Situation | Command |
|-----------|---------|
| Starting a non-trivial feature | `/plan` — stops and waits for your confirm |
| Finished writing code | `/code-review` |
| Before a commit | `/security-scan` |
| Build or tests failing | `/build-fix` |
| Coverage gaps | `/test-coverage` |
| Post-refactor cleanup | `/refactor-clean` |
| Full feature, end to end | `/orch-add-feature` |
| Bug, reproduced as a failing test first | `/orch-fix-defect` |

### Repo-specific review focus

- **IPC boundary** — every `contextBridge` / `ipcRenderer` addition in
  `src/preload.js` widens the renderer's attack surface. Validate payloads in
  the main-process handler; never trust the renderer.
- **Config loaders** — `cheatsheets.js`, `prompts.js`, `layouts.js`, `themes.js`
  share one contract: safe read, validate at the boundary, a broken file yields
  an empty list rather than a crash. Preserve that shape.
- **File size** — `src/main.js` (2220 lines) and `src/observer.js` (1171) are
  well past the 500-line guideline in the parent `CLAUDE.md`. Prefer extracting
  a module over growing them further.
- **Localization** — new user-facing strings need both `pl` and `en`.
