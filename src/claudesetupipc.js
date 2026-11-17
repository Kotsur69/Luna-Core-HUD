// ============================================================================
// LunaCore - Claude setup switcher IPC (the `setup` widget)
// ----------------------------------------------------------------------------
// Seven channels. list and status take nothing; preview and apply take one
// profile name; the Antigravity mirror adds agyStatus and agySync (no
// payload) and agySetEnabled (a boolean). The renderer is not trusted: a name that is not a string
// matching NAME_RE is refused here, before src/claudesetup.js is touched, and
// claudesetup.js then checks it against the CLI's own list. Answers are the
// whitelisted shapes claudesetup.js builds; the only free CLI text that
// crosses is one trimmed error line (`detail`, shown to the local user).
// ============================================================================

'use strict';

const { createClaudeSetup, validName } = require('./claudesetup');
const { createAgyMirror } = require('./agysetupmirror');

const bad = (error) => ({ ok: false, error });

/** Runs one call; anything that still throws becomes {ok:false}. */
async function safely(label, fn) {
  try {
    const res = await fn();
    return res && typeof res === 'object' ? res : bad('failed');
  } catch (err) {
    console.error(`[claudesetupipc] ${label} failed:`, err && err.message);
    return bad('failed');
  }
}

/**
 * @param {{ipcMain: object, setup?: ReturnType<typeof createClaudeSetup>,
 *   getEnv?: () => Record<string,string>}} deps
 *   setup is injectable for tests; getEnv gives the CLI the same PATH a
 *   session gets (so `claude plugin install` finds claude).
 */
function registerClaudeSetupIpc({ ipcMain, setup = null, getEnv } = {}) {
  const switcher = setup || createClaudeSetup({ getEnv, agyMirror: createAgyMirror() });

  ipcMain.handle('claudeSetup:list', () => safely('list', () => switcher.list()));
  ipcMain.handle('claudeSetup:status', () => safely('status', () => switcher.status()));
  ipcMain.handle('claudeSetup:preview', (_event, name) =>
    validName(name) ? safely('preview', () => switcher.preview(name)) : bad('bad-name'),
  );
  ipcMain.handle('claudeSetup:apply', (_event, name) =>
    validName(name) ? safely('apply', () => switcher.apply(name)) : bad('bad-name'),
  );

  // Antigravity (agy) mirror. agyStatus and agySync take nothing - anything
  // the renderer sends is refused, not ignored; agySetEnabled takes a boolean.
  const noPayload = (payload) => payload === undefined || payload === null;
  ipcMain.handle('claudeSetup:agyStatus', (_event, payload) =>
    noPayload(payload) ? safely('agyStatus', () => switcher.agyStatus()) : bad('bad-payload'),
  );
  ipcMain.handle('claudeSetup:agySetEnabled', (_event, on) =>
    typeof on === 'boolean' ? safely('agySetEnabled', () => switcher.setAgyEnabled(on)) : bad('bad-payload'),
  );
  ipcMain.handle('claudeSetup:agySync', (_event, payload) =>
    noPayload(payload) ? safely('agySync', () => switcher.syncAgy()) : bad('bad-payload'),
  );
}

module.exports = { registerClaudeSetupIpc };
