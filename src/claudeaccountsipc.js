// ============================================================================
// LunaCore - Claude accounts IPC (Settings -> Claude accounts)
// ----------------------------------------------------------------------------
// The renderer lists, adds, removes and reorders accounts. A token only ever
// travels renderer -> main (the paste on "Add"); list() never returns one.
// Every payload is validated here - the renderer is not trusted.
// ============================================================================

'use strict';

const ID_RE = /^[a-z0-9]{1,20}$/;
const MAX_LABEL_IN = 200;
const MAX_TOKEN_IN = 4000;

const bad = (error) => ({ ok: false, error });
const validId = (id) => typeof id === 'string' && ID_RE.test(id);

/**
 * @param {{ipcMain: object, accounts: ReturnType<import('./claudeaccounts').createClaudeAccounts>,
 *   openTokenTab: () => void}} deps
 */
function registerClaudeAccountsIpc({ ipcMain, accounts, openTokenTab }) {
  ipcMain.handle('claudeAccounts:list', () => accounts.list());

  ipcMain.handle('claudeAccounts:add', (_event, payload) => {
    const p = payload && typeof payload === 'object' ? payload : {};
    if (typeof p.label !== 'string' || p.label.length > MAX_LABEL_IN) return bad('badLabel');
    if (typeof p.token !== 'string' || p.token.length > MAX_TOKEN_IN) return bad('badToken');
    return accounts.add(p.label, p.token);
  });

  ipcMain.handle('claudeAccounts:remove', (_event, id) => (validId(id) ? accounts.remove(id) : bad('notFound')));
  ipcMain.handle('claudeAccounts:move-up', (_event, id) => (validId(id) ? accounts.moveUp(id) : bad('notFound')));
  ipcMain.handle('claudeAccounts:clear-limit', (_event, id) => (validId(id) ? accounts.clearLimit(id) : bad('notFound')));

  // Opens a tab running `claude setup-token` (browser OAuth for one account).
  ipcMain.on('claudeAccounts:open-token-tab', () => openTokenTab());
}

module.exports = { registerClaudeAccountsIpc };
