#!/bin/bash
# ============================================================================
# LunaCore - start this Mac as a Luna host (docs/REMOTE_HOST_PLAN.md)
# ----------------------------------------------------------------------------
# Double-click in Finder. Lives in a clone of this repo: pulls it, installs the
# dependencies only when package-lock.json changed, keeps the Mac awake with
# caffeinate and runs LunaCore headless (tray only) as the default host.
# Needs git, Node, Claude Code and `gh auth login` once. No .dmg, no signing.
# ============================================================================
set -euo pipefail

cd "$(dirname "$0")/.."

lock_sum() { shasum -a 256 package-lock.json 2>/dev/null | cut -d' ' -f1 || true; }

before="$(lock_sum)"
git pull --ff-only || echo "git pull failed - starting the current checkout"
after="$(lock_sum)"

stamp=".host-lock.sha256"
if [ ! -d node_modules ] || [ "$before" != "$after" ] || [ "$(cat "$stamp" 2>/dev/null)" != "$after" ]; then
  npm ci
  echo "$after" > "$stamp"
fi

# -i: no idle sleep, -s: no system sleep on AC power; ends with this script.
caffeinate -is -w $$ &

exec npx electron . --host --make-default
