// ============================================================================
// LunaCore - Claude accounts IPC (Settings -> Claude accounts)
// ----------------------------------------------------------------------------
// The renderer lists, adds, renames, removes and reorders accounts, makes one
// active (Usage panel click) and sets its reserve caps. A token only ever
// travels renderer -> main (the paste on "Add"); list() never returns one.
// Every payload is validated here - the renderer is not trusted.
//
// Usage logins (src/claudeaccountusage.js): the renderer sends only an account
// id. The dir is derived in main from that id, the CLI runs with no shell and
// constant args, and only an email and a status ever come back.
// ============================================================================

'use strict';

const { validateReserve } = require('./accountreserve');

const ID_RE = /^[a-z0-9]{1,20}$/;
const MAX_LABEL_IN = 200;
const MAX_TOKEN_IN = 4000;

const bad = (error) => ({ ok: false, error });
const validId = (id) => typeof id === 'string' && ID_RE.test(id);

/**
 * @param {{ipcMain: object, accounts: ReturnType<import('./claudeaccounts').createClaudeAccounts>,
 *   openTokenTab: () => void,
 *   accountUsage?: ReturnType<import('./claudeaccountusage').createAccountUsage>|null}} deps
 */
function registerClaudeAccountsIpc({ ipcMain, accounts, openTokenTab, accountUsage = null }) {
  ipcMain.handle('claudeAccounts:list', () => (accountUsage ? accountUsage.decorate(accounts.list()) : accounts.list()));

  ipcMain.handle('claudeAccounts:add', (_event, payload) => {
    const p = payload && typeof payload === 'object' ? payload : {};
    if (typeof p.label !== 'string' || p.label.length > MAX_LABEL_IN) return bad('badLabel');
    if (typeof p.token !== 'string' || p.token.length > MAX_TOKEN_IN) return bad('badToken');
    return accounts.add(p.label, p.token);
  });

  ipcMain.handle('claudeAccounts:rename', (_event, payload) => {
    const p = payload && typeof payload === 'object' ? payload : {};
    if (!validId(p.id)) return bad('notFound');
    if (typeof p.label !== 'string' || p.label.length > MAX_LABEL_IN) return bad('badLabel');
    return accounts.rename(p.id, p.label);
  });
  ipcMain.handle('claudeAccounts:remove', (_event, id) => (validId(id) ? accounts.remove(id) : bad('notFound')));
  ipcMain.handle('claudeAccounts:move-up', (_event, id) => (validId(id) ? accounts.moveUp(id) : bad('notFound')));
  ipcMain.handle('claudeAccounts:clear-limit', (_event, id) => (validId(id) ? accounts.clearLimit(id) : bad('notFound')));
  // Usage panel click: the account becomes the one new work runs on. One id
  // argument; moveToTop() answers 'notFound' for an id not in the stored list.
  ipcMain.handle('claudeAccounts:make-active', (_event, id) => (validId(id) ? accounts.moveToTop(id) : bad('notFound')));
  // Reserve caps (src/accountreserve.js): each an integer 1-100 or empty.
  ipcMain.handle('claudeAccounts:set-reserve', (_event, payload) => {
    const p = payload && typeof payload === 'object' ? payload : {};
    if (!validId(p.id)) return bad('notFound');
    const checked = validateReserve({ fiveHour: p.fiveHour, weekly: p.weekly });
    return checked.ok ? accounts.setReserve(p.id, checked.reserve) : checked;
  });

  // Opens a tab running `claude setup-token` (browser OAuth for one account).
  ipcMain.on('claudeAccounts:open-token-tab', () => openTokenTab());

  if (!accountUsage) return;
  // `claude auth login` for this account's usage-only login (opens the browser).
  ipcMain.handle('claudeAccounts:connect-usage', (_event, id) => (validId(id) ? accountUsage.connect(id) : bad('notFound')));
  ipcMain.handle('claudeAccounts:use-main-usage', (_event, id) => (validId(id) ? accountUsage.useMain(id) : bad('notFound')));
  ipcMain.handle('claudeAccounts:disconnect-usage', (_event, id) => (validId(id) ? accountUsage.disconnect(id) : bad('notFound')));
}

module.exports = { registerClaudeAccountsIpc };
