// ============================================================================
// LunaCore - diagnostics core (consolidated self-checks)
// ----------------------------------------------------------------------------
// LunaCore keeps discovering its own degraded states in passing: mpv missing so
// every sound is silently dead, 16 of 17 MCP servers never once called, `claude`
// nowhere on PATH. Each fact is already known somewhere in the process - this
// module is the one place that turns those live readings into a single list of
// check rows the diagnostics tile renders.
//
// PURE and DOM-FREE on purpose. Every export takes a plain object and returns a
// row; nothing here spawns a process, reads a file, or touches Electron, so
// `node --test` covers every branch without a display. The thin composer that
// gathers the three live inputs lives in main.js (`diag:report`).
//
// TWO NON-OBVIOUS RULES, both inherited from claudecheck.js:
//
//   1. A CHECK THAT COULD NOT RUN IS 'unknown', NEVER 'fail'. Crying wolf about
//      a working tool sends someone to reinstall it; saying nothing is the safer
//      failure. Missing or malformed input always lands on 'unknown'.
//   2. NO REMEDIATION HERE. An `action` only points somewhere - docs, the
//      clipboard, another widget. The row never carries a fix, only a signpost.
//
// A row: { id, status, detailKey, detailParams?, action? }
//   status        'ok' | 'warn' | 'fail' | 'unknown'
//   detailKey     i18n key, resolved in the renderer
//   detailParams  interpolation values for that key (optional)
//   action        { kind: 'docs' | 'copy' | 'focus', value: string } (optional)
// ============================================================================

'use strict';

/** Worst-first ranking shared by every row status and by rollup(). */
const RANK = { ok: 0, unknown: 1, warn: 2, fail: 3 };
const BY_RANK = ['ok', 'unknown', 'warn', 'fail'];

// A server list this idle is worth a warning outright; below it, the ratio
// decides. Both live here so the tests pin the words, not a magic number in a
// branch.
const MCP_IDLE_ABSOLUTE = 5;
const MCP_IDLE_RATIO = 0.5;

/**
 * Sound + narration health, from SoundManager.getStatus().
 *
 * `narrationManager` shares the same mpv binary, so this one row speaks for both
 * - the detail strings say so. `reason` is the only field consulted; `available`
 * rides along for callers that want it but does not change the verdict.
 *
 * @param {{ available?: boolean, reason?: string }} [status]
 * @returns {{ id: string, status: string, detailKey: string, action?: object }}
 */
function summarizeSound(status) {
  const reason = status && typeof status.reason === 'string' ? status.reason : null;
  switch (reason) {
    case 'ok':
      return { id: 'sound', status: 'ok', detailKey: 'diag.sound.ok' };
    case 'not-found':
      // The only recoverable one: point at the install page. The detail string
      // also names LUNACORE_MPV_PATH so the override is discoverable in place.
      return {
        id: 'sound',
        status: 'fail',
        detailKey: 'diag.sound.notFound',
        action: { kind: 'docs', value: 'mpv' },
      };
    case 'spawn-failed':
      return { id: 'sound', status: 'fail', detailKey: 'diag.sound.spawnFailed' };
    case 'ipc-failed':
      return { id: 'sound', status: 'fail', detailKey: 'diag.sound.ipcFailed' };
    case 'starting':
      // The check genuinely has no answer yet - not a failure.
      return { id: 'sound', status: 'unknown', detailKey: 'diag.unknown' };
    default:
      return { id: 'sound', status: 'unknown', detailKey: 'diag.unknown' };
  }
}

/**
 * Whether Claude Code is on PATH, from claude:status ({ found, path }).
 *
 * Only a definite `found === false` is a failure. Anything else - a thrown
 * check, a malformed object - is 'unknown', for the claudecheck.js reason.
 *
 * @param {{ found?: boolean }} [status]
 * @returns {{ id: string, status: string, detailKey: string, action?: object }}
 */
function summarizeClaude(status) {
  if (!status || typeof status.found !== 'boolean') {
    return { id: 'claude', status: 'unknown', detailKey: 'diag.unknown' };
  }
  if (status.found === false) {
    return {
      id: 'claude',
      status: 'fail',
      detailKey: 'diag.claude.missing',
      action: { kind: 'docs', value: 'claude' },
    };
  }
  return { id: 'claude', status: 'ok', detailKey: 'diag.claude.ok' };
}

/**
 * MCP usage, from getMcpHealth() ({ servers: [...] }).
 *
 * Reuses the transcript-mined `lastUsed` the MCP widget already computes - this
 * probes nothing. "Idle" means enabled but never once called on this machine;
 * a wall of those is context-window cost with nothing to show for it, so past a
 * threshold the row warns and points at the MCP widget for the detail.
 *
 * Never a 'fail': an unused server is a judgement call (it may be busy in
 * another client), exactly the line the MCP widget itself draws.
 *
 * @param {{ servers?: Array<{ enabled?: boolean, lastUsed?: * }> }} [health]
 * @returns {{ id, status, detailKey, detailParams?, action? }}
 */
function summarizeMcp(health) {
  if (!health || !Array.isArray(health.servers)) {
    return { id: 'mcp', status: 'unknown', detailKey: 'diag.unknown' };
  }
  const enabled = health.servers.filter((s) => s && s.enabled);
  const total = enabled.length;
  const never = enabled.filter((s) => !s.lastUsed).length;

  if (never === 0) {
    return { id: 'mcp', status: 'ok', detailKey: 'diag.mcp.ok', detailParams: { total } };
  }
  if (never >= MCP_IDLE_ABSOLUTE || never / total > MCP_IDLE_RATIO) {
    return {
      id: 'mcp',
      status: 'warn',
      detailKey: 'diag.mcp.idle',
      detailParams: { never, total },
      action: { kind: 'focus', value: 'mcp' },
    };
  }
  return { id: 'mcp', status: 'ok', detailKey: 'diag.mcp.ok', detailParams: { total } };
}

/**
 * The one-line header verdict: the worst status across the rows, and how many
 * of them are actually asking for attention (warn + fail).
 *
 * @param {Array<{ status?: string }>} rows
 * @returns {{ status: string, issues: number }}
 */
function rollup(rows) {
  const list = Array.isArray(rows) ? rows : [];
  let worst = 0;
  let issues = 0;
  for (const row of list) {
    const rank = RANK[row && row.status] ?? 0;
    if (rank > worst) worst = rank;
    if (row && (row.status === 'warn' || row.status === 'fail')) issues += 1;
  }
  return { status: BY_RANK[worst], issues };
}

module.exports = {
  summarizeSound,
  summarizeClaude,
  summarizeMcp,
  rollup,
  MCP_IDLE_ABSOLUTE,
  MCP_IDLE_RATIO,
};
