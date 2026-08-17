# CLAUDE.md

Instructions for Claude Code when working in this repository.

## Language

**All code comments must always be written in English** — regardless of what language the user's prompt is written in. This applies to `//`, `/* */`, `<!-- -->` comments, JSDoc, and JSON `_comment`-style keys.

This repo ships publicly (LunaCore is an open-source Electron app), so the codebase must read cleanly for any contributor, not just Polish speakers.

Do not translate:
- The `pl`/`en` values inside the localized-content system (`src/localized.js`, `src/renderer/i18n.js`, `src/renderer/modules/localize.js`) — the `pl` entries are genuine, intentional Polish UI text, not comments.
- `data-i18n*` attribute fallback values in `src/renderer/index.html` — same reason.
