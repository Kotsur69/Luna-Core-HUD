# Bundled fonts

Both families are under the **SIL Open Font License 1.1**, which permits
bundling and redistribution inside an application as long as the fonts are not
sold on their own and this notice travels with them.

| Family | Files | Upstream |
|---|---|---|
| JetBrains Mono | `JetBrainsMono-Regular.woff2`, `JetBrainsMono-Bold.woff2` | https://github.com/JetBrains/JetBrainsMono — © 2020 The JetBrains Mono Project Authors |
| Chakra Petch | `ChakraPetch-{600,700}-{latin,latin-ext}.woff2` | https://github.com/cadsondemak/chakra-petch — © 2018 Cadson Demak |

Full licence text: <https://scripts.sil.org/OFL>

## Why these are checked in

The renderer loads over `file://` with no network. A Google Fonts `@import`
would fail silently offline and fall back to a system face partway through
launch — visible only on a machine without a warm cache, i.e. exactly the one
that matters. Local files or nothing.

## Subsetting

Chakra Petch is split into `latin` and `latin-ext` exactly as Google subsets it.
The two ranges are **disjoint** — `latin-ext` contains no ASCII at all — so both
files are needed for Polish text, and each is ~10 KB. JetBrains Mono ships
unsubset (~92 KB per weight) because the upstream project does not publish
subsets and re-subsetting it here would mean a build step this project does not
otherwise have.

Total: ~240 KB.

## Packaging note (Phase D)

When electron-builder lands, `assets/` must be in the `files` allowlist. If it
is not, the packaged app silently falls back to system faces — the `@font-face`
rules stay valid, the files behind them just do not exist.
