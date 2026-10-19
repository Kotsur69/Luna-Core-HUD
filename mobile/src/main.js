// ============================================================================
// LunaCore phone - entry
// ----------------------------------------------------------------------------
// Logged out -> login screen. Logged in -> shell + the page in the URL hash
// (Today, Mission, to-dos, Life or Body), pulled again when the app comes back to the foreground
// (a PC may have changed things since).
// ============================================================================

import './styles.css';
import { cloudConfig, createCloud } from './cloud.js';
import { renderLogin } from './views/login.js';
import { mountShell, pageFromHash } from './shell.js';
import { mountTodos } from './views/todos.js';
import { mountLife } from './views/life.js';
import { mountToday } from './views/today.js';
import { mountMission } from './views/mission.js';
import { mountBody } from './views/body.js';
import { t } from './i18n.js';

const VIEWS = { today: mountToday, mission: mountMission, todos: mountTodos, life: mountLife, body: mountBody };
const root = document.getElementById('app');
const config = cloudConfig();
const cloud = config ? createCloud(config) : null;
let shownUser = null;

function showApp(user) {
  if (shownUser === user.id) return;
  shownUser = user.id;
  let view = null;
  const shell = mountShell(root, {
    who: user.user_metadata?.user_name || user.email || '',
    current: pageFromHash(),
    onNavigate: (id) => {
      if (location.hash !== `#${id}`) location.hash = id;
    },
    onSync: async () => {
      await view.refresh();
      shell.toast(t('synced'));
    },
    onLogout: async () => {
      shownUser = null;
      await cloud.logout().catch(() => {});
      location.reload();
    },
  });
  function show(id) {
    shell.setPage(id);
    // A fresh host per page: a late pull of the page left behind renders into a detached node.
    const host = document.createElement('div');
    shell.main.replaceChildren(host);
    view = VIEWS[id](host, { cloud, toast: shell.toast });
    view.refresh();
  }
  show(pageFromHash());
  window.addEventListener('hashchange', () => show(pageFromHash()));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') view.refresh();
  });
}

async function boot() {
  if (!cloud) {
    renderLogin(root, { onLogin: null });
    return;
  }
  // The PKCE redirect lands here with ?code=; supabase-js swaps it for a
  // session on its own and reports it through onAuth. Work is deferred out
  // of the callback: supabase-js holds its auth lock while it runs.
  cloud.onAuth((u) => {
    setTimeout(async () => {
      if (u) {
        showApp(u);
      } else if (shownUser) {
        // Signed out elsewhere or the session was revoked: drop the cached copy.
        shownUser = null;
        await cloud.logout().catch(() => {});
        location.reload();
      }
    }, 0);
  });
  const user = await cloud.user();
  if (user) showApp(user);
  else renderLogin(root, { onLogin: () => cloud.login() });
}

boot();
