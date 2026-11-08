// ============================================================================
// LunaCore phone - start God Mode from a to-do list (pure; test/mobilegodmodestart.test.mjs)
// ----------------------------------------------------------------------------
// Phone God Mode B. The To-dos page picks open cards and a host, then sends
// the signed godmode.plan {projectId, todoAts} (src/hostgodmode.js). This
// file holds the choices behind that: which hosts can run God Mode (their
// `host` snapshot says godmode: true), which cards may be picked (manual
// cards stay out, like the PC picker), the to-do list -> the host's project
// id, and the payload. It never builds HTML.
// ============================================================================

import todoRows from '../../src/todorows.js';

/** src/hostgodmode.js PROJECT_ID_RE. */
const PROJECT_ID_RE = /^[A-Za-z0-9._-]{1,80}$/;
/** A to-do list's own cap: the host refuses a longer pick (todoSelection). */
export const MAX_TODO_ATS = todoRows.MAX_ITEMS;

const sameMachine = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();

/** Parsed hosts (hostmodel.hostList) -> the ones that run God Mode, order kept (online first). */
export function godmodeHosts(hosts) {
  return (Array.isArray(hosts) ? hosts : []).filter((x) => x && x.godmode === true && typeof x.machine === 'string');
}

/** The host to preselect: the current pick while it can, else the default host, else an online one, else the first. */
export function pickGodmodeHost(hosts, current) {
  const list = godmodeHosts(hosts);
  if (!list.length) return null;
  return list.find((x) => sameMachine(x.machine, current)) || list.find((x) => x.default) || list.find((x) => x.online) || list[0];
}

/** The parsed host whose machine name is `machine` (case-insensitive), or null. */
export function hostForMachine(hosts, machine) {
  return (Array.isArray(hosts) ? hosts : []).find((x) => x && sameMachine(x.machine, machine)) || null;
}

/** 'local:home' -> 'home'; null for a git key. */
const localName = (key) => (typeof key === 'string' && key.startsWith('local:') ? key.slice('local:'.length).toLowerCase() : null);

/**
 * A to-do list key ('git:github.com/o/r' or 'local:<name>') -> the project
 * id on `host`. A git repo matches by its repo key; a host sends no key for a
 * local project, so a local list matches by the project's name.
 * @returns {string|null}
 */
export function projectIdFor(host, listKey) {
  if (!host || !Array.isArray(host.repos) || typeof listKey !== 'string') return null;
  const byKey = host.repos.find((r) => r && r.key && r.key === listKey);
  const local = localName(listKey);
  const hit = byKey || (local ? host.repos.find((r) => r && !r.key && typeof r.name === 'string' && r.name.toLowerCase() === local) : null);
  return hit && PROJECT_ID_RE.test(hit.id) ? hit.id : null;
}

/**
 * The open cards of a list for the picker: [{at, text, manual, disabled}].
 * A manual card is shown but cannot be picked.
 */
export function pickableCards(items) {
  return (Array.isArray(items) ? items : [])
    .filter((i) => i && !i.done && Number.isSafeInteger(i.at) && i.at > 0)
    .map((i) => ({ at: i.at, text: String(i.text || ''), manual: i.manual === true, disabled: i.manual === true }));
}

/** The picker's first selection: every card that may be picked. */
export function defaultSelection(cards) {
  return cards.filter((c) => !c.disabled).map((c) => c.at);
}

/** `selected` with `at` added or removed; a disabled or unknown card changes nothing. */
export function toggleSelection(selected, at, cards) {
  const card = cards.find((c) => c.at === at);
  if (!card || card.disabled) return selected;
  return selected.includes(at) ? selected.filter((x) => x !== at) : [...selected, at];
}

/**
 * The godmode.plan payload, or null when there is nothing to send: no
 * project on the host, or no pickable card selected. Only selected cards that
 * are still open and not manual go out, unique, oldest first.
 * @returns {{projectId: string, todoAts: number[]}|null}
 */
export function planPayload(projectId, selected, cards) {
  if (typeof projectId !== 'string' || !PROJECT_ID_RE.test(projectId)) return null;
  const allowed = new Set(cards.filter((c) => !c.disabled).map((c) => c.at));
  const todoAts = [...new Set((Array.isArray(selected) ? selected : []).filter((at) => allowed.has(at)))].sort((a, b) => a - b);
  if (!todoAts.length || todoAts.length > MAX_TODO_ATS) return null;
  return { projectId, todoAts };
}

/** Host refusal codes with their own phone text (i18n key `gmErr_<code>`). */
const KNOWN_ERRORS = new Set([
  'needsHud', 'busy', 'noRepo', 'noPlan', 'noneSelected', 'unknownProject', 'noTab', 'noRun',
  'nothingToRetry', 'lunasWorkActive', 'badTodos', 'timeout',
]);

/** A host refusal code -> its i18n key, or null (the code is shown as it came). */
export function refusalKey(code) {
  return typeof code === 'string' && KNOWN_ERRORS.has(code) ? `gmErr_${code}` : null;
}
