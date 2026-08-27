#!/usr/bin/env bash
# ============================================================================
# LunaCore - dual-runner environment setup (POSIX / Git Bash / WSL)
# ----------------------------------------------------------------------------
# One source of truth for the environment that separates the two runners:
#
#   native - first-party Anthropic. No overrides at all; `claude` uses the
#            OAuth credentials it already has. This mode CLEARS every variable
#            the GLM mode sets, so a polluted parent shell cannot leak.
#   glm    - the same `claude` binary pointed at an Anthropic-compatible
#            endpoint serving GLM (Z.ai by default).
#
# Deliberately NOT written into ~/.claude/settings.json: that file is read by
# both runners, so a base URL there would silently redirect native sessions
# too. Environment variables are per-process, which is exactly the isolation
# two runners on one shared config directory need.
#
# Usage:
#   source scripts/env-setup.sh glm      # apply to the current shell
#   source scripts/env-setup.sh native   # clear back to first-party
#   bash   scripts/env-setup.sh --check glm    # validate config, exit 1 on error
#   bash   scripts/env-setup.sh --print glm    # masked summary of what applies
# ============================================================================

# Repo root, resolved from this script rather than $PWD - the runners are meant
# to work from any subdirectory.
LUNA_ENV_SETUP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
LUNA_ROOT="$(cd "$LUNA_ENV_SETUP_DIR/.." && pwd)"
LUNA_ENV_FILE="${LUNA_ENV_FILE:-$LUNA_ROOT/.env.luna}"

# Every variable this script owns. Listing them once keeps "apply" and "clear"
# from drifting apart - a variable added to one and forgotten in the other is
# exactly how a native session ends up quietly talking to a proxy.
LUNA_OWNED_VARS="
ANTHROPIC_BASE_URL
ANTHROPIC_AUTH_TOKEN
ANTHROPIC_MODEL
ANTHROPIC_SMALL_FAST_MODEL
ANTHROPIC_DEFAULT_OPUS_MODEL
ANTHROPIC_DEFAULT_SONNET_MODEL
ANTHROPIC_DEFAULT_HAIKU_MODEL
ANTHROPIC_DEFAULT_FABLE_MODEL
CLAUDE_CODE_SUBAGENT_MODEL
CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC
API_TIMEOUT_MS
MCP_TIMEOUT
MCP_TOOL_TIMEOUT
LUNA_RUNNER
"

luna_env__warn() { printf 'env-setup: %s\n' "$*" >&2; }

# Reads .env.luna into LUNA_GLM_* shell variables. Tolerates CRLF (the file is
# often edited on Windows) and an `export KEY=` prefix. A missing file is fine:
# the presets below still produce a usable config for everything but the key.
luna_env__load_file() {
  [ -f "$LUNA_ENV_FILE" ] || return 0
  local line key value cr
  cr=$(printf '\r')
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%$cr}"
    case "$line" in
      "" | \#*) continue ;;
    esac
    line="${line#export }"
    case "$line" in
      *=*) ;;
      *) continue ;;
    esac
    key="${line%%=*}"
    value="${line#*=}"
    # Only our own namespace, so a stray line cannot set arbitrary env.
    case "$key" in
      LUNA_GLM_*) ;;
      *) continue ;;
    esac
    # Strip one layer of matching double quotes.
    case "$value" in
      \"*\")
        value="${value#\"}"
        value="${value%\"}"
        ;;
    esac
    export "$key=$value"
  done < "$LUNA_ENV_FILE"
}

# Preset defaults. Only fill what was left blank - an explicit value in
# .env.luna always wins, which is what makes `custom` (and pinning a different
# variant) work without a second code path.
luna_env__apply_preset() {
  case "${LUNA_GLM_PROVIDER:-zai}" in
    zai)
      : "${LUNA_GLM_BASE_URL:=https://api.z.ai/api/anthropic}"
      : "${LUNA_GLM_MODEL:=glm-5.3}"
      : "${LUNA_GLM_FAST_MODEL:=glm-5.3-flash}"
      ;;
    openrouter)
      : "${LUNA_GLM_BASE_URL:=https://openrouter.ai/api}"
      : "${LUNA_GLM_MODEL:=z-ai/glm-5.3}"
      : "${LUNA_GLM_FAST_MODEL:=z-ai/glm-5.3-flash}"
      ;;
    custom) : ;;
    *)
      luna_env__warn "unknown LUNA_GLM_PROVIDER (expected zai|openrouter|custom)"
      return 1
      ;;
  esac
  : "${LUNA_GLM_API_TIMEOUT_MS:=3000000}"
  : "${LUNA_GLM_MCP_TIMEOUT_MS:=60000}"
  : "${LUNA_GLM_MCP_TOOL_TIMEOUT_MS:=120000}"
  : "${LUNA_GLM_DISABLE_NONESSENTIAL_TRAFFIC:=1}"
  # Fast model is optional: without one, cheap internal calls fall back to the
  # main model rather than 404-ing on a slug the provider does not serve.
  : "${LUNA_GLM_FAST_MODEL:=$LUNA_GLM_MODEL}"
  return 0
}

luna_env__validate() {
  local errors=0
  if [ -z "${LUNA_GLM_API_KEY:-}" ]; then
    luna_env__warn "LUNA_GLM_API_KEY is empty - set it in $LUNA_ENV_FILE"
    errors=$((errors + 1))
  fi
  if [ -z "${LUNA_GLM_BASE_URL:-}" ]; then
    luna_env__warn "LUNA_GLM_BASE_URL is empty (required for provider custom)"
    errors=$((errors + 1))
  else
    case "$LUNA_GLM_BASE_URL" in
      https://* | http://localhost* | http://127.0.0.1*) ;;
      *)
        luna_env__warn "LUNA_GLM_BASE_URL should be https:// or a localhost proxy"
        errors=$((errors + 1))
        ;;
    esac
    # A trailing slash makes some proxies serve /v1//messages -> 404.
    case "$LUNA_GLM_BASE_URL" in
      */)
        luna_env__warn "LUNA_GLM_BASE_URL ends with a slash - drop it, the CLI appends /v1/messages"
        errors=$((errors + 1))
        ;;
    esac
  fi
  if [ -z "${LUNA_GLM_MODEL:-}" ]; then
    luna_env__warn "LUNA_GLM_MODEL is empty (required for provider custom)"
    errors=$((errors + 1))
  fi
  return $errors
}

# Clears everything this script owns. Used by the native runner and as the
# first step of the GLM one, so applying is never additive over stale state.
luna_env_clear() {
  local var
  for var in $LUNA_OWNED_VARS; do unset "$var"; done
}

luna_env_native() {
  luna_env_clear
  export LUNA_RUNNER=native
}

luna_env_glm() {
  luna_env_clear
  luna_env__load_file
  luna_env__apply_preset || return 1
  luna_env__validate || return 1

  export ANTHROPIC_BASE_URL="$LUNA_GLM_BASE_URL"
  export ANTHROPIC_AUTH_TOKEN="$LUNA_GLM_API_KEY"
  # Unset rather than blanked: with a Bearer token in play, a lingering
  # x-api-key credential is the classic cause of a 401 that looks like a bad key.
  unset ANTHROPIC_API_KEY

  # Claude Code resolves a model through the alias the caller asked for, so
  # every alias has to be mapped - otherwise a subagent declared as haiku
  # requests a slug the provider does not serve.
  export ANTHROPIC_MODEL="$LUNA_GLM_MODEL"
  export ANTHROPIC_DEFAULT_OPUS_MODEL="$LUNA_GLM_MODEL"
  export ANTHROPIC_DEFAULT_SONNET_MODEL="$LUNA_GLM_MODEL"
  export ANTHROPIC_DEFAULT_FABLE_MODEL="$LUNA_GLM_MODEL"
  export ANTHROPIC_DEFAULT_HAIKU_MODEL="$LUNA_GLM_FAST_MODEL"
  export ANTHROPIC_SMALL_FAST_MODEL="$LUNA_GLM_FAST_MODEL"
  export CLAUDE_CODE_SUBAGENT_MODEL="$LUNA_GLM_MODEL"

  export API_TIMEOUT_MS="$LUNA_GLM_API_TIMEOUT_MS"
  export MCP_TIMEOUT="$LUNA_GLM_MCP_TIMEOUT_MS"
  export MCP_TOOL_TIMEOUT="$LUNA_GLM_MCP_TOOL_TIMEOUT_MS"
  if [ "$LUNA_GLM_DISABLE_NONESSENTIAL_TRAFFIC" = "1" ]; then
    export CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
  fi

  export LUNA_RUNNER=glm
  return 0
}

# Masked summary. Never prints the token - this output ends up in bug reports.
luna_env_print() {
  local token="${ANTHROPIC_AUTH_TOKEN:-}"
  local masked="(unset)"
  if [ -n "$token" ]; then
    if [ "${#token}" -gt 8 ]; then
      masked="${token:0:4}...${token: -4} (${#token} chars)"
    else
      masked="(set, ${#token} chars)"
    fi
  fi
  printf 'runner               : %s\n' "${LUNA_RUNNER:-native}"
  printf 'ANTHROPIC_BASE_URL   : %s\n' "${ANTHROPIC_BASE_URL:-(unset - first-party Anthropic)}"
  printf 'ANTHROPIC_AUTH_TOKEN : %s\n' "$masked"
  printf 'ANTHROPIC_API_KEY    : %s\n' "${ANTHROPIC_API_KEY:+(set)}${ANTHROPIC_API_KEY:-(unset)}"
  printf 'model opus/sonnet    : %s\n' "${ANTHROPIC_MODEL:-(CLI default)}"
  printf 'model haiku/fast     : %s\n' "${ANTHROPIC_SMALL_FAST_MODEL:-(CLI default)}"
  printf 'subagent model       : %s\n' "${CLAUDE_CODE_SUBAGENT_MODEL:-(inherit)}"
  printf 'API_TIMEOUT_MS       : %s\n' "${API_TIMEOUT_MS:-(CLI default)}"
  printf 'config dir           : %s\n' "${CLAUDE_CONFIG_DIR:-$HOME/.claude (shared)}"
}

luna_env_apply() {
  case "${1:-native}" in
    glm) luna_env_glm ;;
    native) luna_env_native ;;
    *)
      luna_env__warn "unknown runner (expected glm|native)"
      return 2
      ;;
  esac
}

# --- Dispatch ---------------------------------------------------------------
# Sourced: apply and stay quiet. Executed: run the requested sub-command.
if [ "${BASH_SOURCE[0]:-$0}" != "${0}" ]; then
  luna_env_apply "${1:-native}"
else
  case "${1:-}" in
    --check)
      luna_env_apply "${2:-glm}" || exit 1
      printf 'env-setup: %s configuration OK\n' "${2:-glm}"
      ;;
    --print)
      luna_env_apply "${2:-glm}" || exit 1
      luna_env_print
      ;;
    *)
      printf 'usage:\n'
      printf '  source scripts/env-setup.sh <glm|native>\n'
      printf '  bash   scripts/env-setup.sh --check <glm|native>\n'
      printf '  bash   scripts/env-setup.sh --print <glm|native>\n'
      exit 2
      ;;
  esac
fi
