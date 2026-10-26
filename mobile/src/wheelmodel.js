// ============================================================================
// LunaCore phone - Luna's Work "Hand me the wheel" (pure, C11)
// ----------------------------------------------------------------------------
// The PC publishes who has the wheel in its run's feedback section of the
// `godmode` snapshot (running / requested / handed). A tap goes back as one
// unit in the `todos` cloud scope under `lunaswork-wheel:<id>`, through the
// outbox like every to-do write; the unit is built by the PC's own module
// (src/lunasworkWheel.js), so the phone never sends one the PC would refuse.
// ============================================================================

import wheelLib from '../../src/lunasworkWheel.js';

const { wheelUnit, WHEEL_LIST_KEY } = wheelLib;

export { wheelUnit };

const VIEWS = {
  running: { state: 'wheelRunning', action: 'hand', button: 'wheelHand', hint: 'wheelHandHint' },
  requested: { state: 'wheelRequested', action: 'back', button: 'wheelCancel', hint: 'wheelRequestedHint' },
  handed: { state: 'wheelHanded', action: 'back', button: 'wheelBack', hint: 'wheelBackHint' },
};

/**
 * The i18n keys and the action of the wheel button for a published state.
 * @param {string} wheel running | requested | handed
 * @returns {{state:string, action:'hand'|'back', button:string, hint:string}}
 */
export const wheelView = (wheel) => (Object.hasOwn(VIEWS, wheel) ? VIEWS[wheel] : VIEWS.running);

/**
 * The action this phone sent that the PC has not shown yet, or null: the
 * newest wheel unit of the section's run, when the published state still
 * asks for that same action.
 * @param {{runId:string, wheel:string}|null} section godmodeFeedbackFrom output
 * @param {Record<string, {v: unknown, u: number, d: number|null}>} mirror the `todos` mirror with the outbox over it
 * @returns {'hand'|'back'|null}
 */
export function pendingAction(section, mirror) {
  if (!section) return null;
  const prefix = `${WHEEL_LIST_KEY}:`;
  let newest = null;
  for (const [k, row] of Object.entries(mirror || {})) {
    if (!k.startsWith(prefix) || !row || row.d !== null || !row.v || row.v.runId !== section.runId) continue;
    const id = Number(k.slice(prefix.length));
    if (Number.isSafeInteger(id) && (!newest || id > newest.id)) newest = { id, action: row.v.action };
  }
  if (!newest) return null;
  return newest.action === wheelView(section.wheel).action ? newest.action : null;
}
