#!/usr/bin/env bash
# ============================================================================
# LunaCore - GLM runner (POSIX / Git Bash / WSL)
# ----------------------------------------------------------------------------
# Starts the ordinary Claude Code CLI against the GLM endpoint. Everything that
# defines capability - plugins, skills, agents, hooks, MCP servers, CLAUDE.md -
# comes from the shared ~/.claude, untouched. Only the model route differs.
#
# Runs as a child process, so the exports below die with it and the calling
# shell is never left pointing at the proxy.
#
#   scripts/claude-glm.sh                 # interactive session
#   scripts/claude-glm.sh -p "2 + 2"      # one-shot, stdout stays clean
# ============================================================================
set -eu

DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
# shellcheck source=./env-setup.sh
. "$DIR/env-setup.sh" glm

# Banner on stderr, so `claude -p ... | jq` still gets clean stdout.
printf 'luna: runner=glm model=%s endpoint=%s\n' \
  "$ANTHROPIC_MODEL" "$ANTHROPIC_BASE_URL" >&2

exec claude "$@"
