// ============================================================================
// LunaCore - Skill Tracker tiles
// ----------------------------------------------------------------------------
// A tile lights up when a tool is detected and goes dark after a moment of
// quiet. Note what this does NOT know: when a tool actually FINISHED. A long
// Bash and an instant Read look identical, and a two-minute tool blinks off
// after 1.5 s while it is still running. Fixing that needs the tool_use /
// tool_result id pairing from the transcript - see B8 in FUTURE_PLAN.md.
// ============================================================================

'use strict';

const TILE_ACTIVE_MS = 1500;
const tileTimers = new Map();

export function lightTiles(tiles) {
  if (!Array.isArray(tiles)) return;
  for (const name of tiles) {
    const tile = document.querySelector(`.skill-tile[data-skill="${name}"]`);
    if (!tile) continue;
    tile.classList.add('is-active');
    // Refresh the off timer (a further detection extends the glow).
    clearTimeout(tileTimers.get(name));
    tileTimers.set(
      name,
      setTimeout(() => tile.classList.remove('is-active'), TILE_ACTIVE_MS)
    );
  }
}
