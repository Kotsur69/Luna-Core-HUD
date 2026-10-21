// ============================================================================
// LunaCore - God Mode arm confirm: payload validation + dialog text
// ----------------------------------------------------------------------------
// The renderer's tryArm() sends {runnable, skipped, blocked} with the
// 'godmode:confirm' IPC call. main never trusts it: every count is clamped to
// a whole number in [0, MAX_ITEMS] before it reaches the native dialog. Kept
// out of src/main.js so the rules are unit-testable without Electron.
// ============================================================================

'use strict';

const { MAX_ITEMS } = require('./todorows');

/** A count from the renderer: a whole number in [0, MAX_ITEMS], else 0. */
function cleanCount(value) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) return 0;
  return Math.min(value, MAX_ITEMS);
}

/**
 * @param {unknown} raw the renderer's payload
 * @returns {{runnable:number, skipped:number, blocked:number}}
 */
function normalizeArmCounts(raw) {
  const obj = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    runnable: cleanCount(obj.runnable),
    skipped: cleanCount(obj.skipped),
    blocked: cleanCount(obj.blocked),
  };
}

/** Polish plural for "zadanie": 1 zadanie, 2-4 zadania, 5+ zadan. */
function plTasks(n) {
  if (n === 1) return 'zadanie';
  const lastTwo = n % 100;
  const last = n % 10;
  return last >= 2 && last <= 4 && (lastTwo < 12 || lastTwo > 14) ? 'zadania' : 'zadan';
}

/**
 * The dialog's detail line. Skipped/blocked sentences appear only when
 * non-zero, so a list with no manual items reads as it always did.
 * @param {{runnable:number, skipped:number, blocked:number}} counts already normalized
 * @param {boolean} pl
 * @returns {string}
 */
function confirmDetail({ runnable, skipped, blocked }, pl) {
  if (pl) {
    const lines = [`LunaCore sam wykona ${runnable} ${plTasks(runnable)} z listy, jedno po drugim, bez pytania o zgode.`];
    if (skipped) lines.push(`Pominie ${skipped} ${plTasks(skipped)} oznaczone do zrobienia recznie.`);
    if (blocked) lines.push(`${blocked} ${plTasks(blocked)} zablokowane przez zadania reczne poczeka na Ciebie.`);
    return lines.join('\n');
  }
  const tasks = (n) => (n === 1 ? 'task' : 'tasks');
  const lines = [`LunaCore will run ${runnable} open ${tasks(runnable)} from this list, one by one, without asking again.`];
  if (skipped) lines.push(`It skips ${skipped} manual ${tasks(skipped)} kept for you.`);
  if (blocked) lines.push(`${blocked} ${tasks(blocked)} blocked by a manual task will wait for you.`);
  return lines.join('\n');
}

module.exports = { normalizeArmCounts, confirmDetail };
