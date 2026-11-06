// ============================================================================
// LunaCore phone - remembered repo names of host sessions
// ----------------------------------------------------------------------------
// A host's heartbeat names the repo of a LIVE session only; once it ends the
// menu would show just the host. This phone remembers the name it saw (at
// chat.start or while the chat was open), newest 50, in localStorage. A
// private-mode phone just shows the host.
// ============================================================================

const KEY = 'lunacore.host.sessionLabels';
const MAX = 50;
const MAX_LEN = 100;

/** sessionId -> repo name (a plain object without a prototype). */
export function readLabels() {
  const out = Object.create(null);
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || '[]');
    for (const e of Array.isArray(raw) ? raw : []) {
      if (Array.isArray(e) && typeof e[0] === 'string' && typeof e[1] === 'string') out[e[0]] = e[1].slice(0, MAX_LEN);
    }
  } catch {
    // Unreadable or private mode: no remembered names.
  }
  return out;
}

/** Remembers `name` for `sessionId` (newest first, capped). */
export function rememberLabel(sessionId, name) {
  if (typeof sessionId !== 'string' || typeof name !== 'string' || !name) return;
  const labels = readLabels();
  if (labels[sessionId] === name) return;
  const next = [[sessionId, name.slice(0, MAX_LEN)], ...Object.entries(labels).filter(([id]) => id !== sessionId)].slice(0, MAX);
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Private mode / quota: the menu shows the host only.
  }
}
