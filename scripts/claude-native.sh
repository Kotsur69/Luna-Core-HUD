#!/usr/bin/env bash
# ============================================================================
# LunaCore - native Claude runner (POSIX / Git Bash / WSL)
# ----------------------------------------------------------------------------
# Plain `claude`, with one job beyond that: it actively CLEARS every variable
# the GLM runner sets. Without that step, a shell where `source env-setup.sh
# glm` was run earlier would keep sending "native" sessions to the proxy - the
# failure is silent, which is exactly why the clear is explicit here.
#
#   scripts/claude-native.sh              # interactive session
#   scripts/claude-native.sh -p "2 + 2"   # one-shot, stdout stays clean
# ============================================================================
set -eu

DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
# shellcheck source=./env-setup.sh
. "$DIR/env-setup.sh" native

printf 'luna: runner=native model=(account default) endpoint=api.anthropic.com\n' >&2

exec claude "$@"
