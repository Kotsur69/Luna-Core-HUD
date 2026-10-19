// ============================================================================
// LunaCore phone - entry
// ----------------------------------------------------------------------------
// Logged out -> login screen. Logged in -> shell + to-dos, pulled again when
// the app comes back to the foreground (a PC may have changed things since).
// ============================================================================

import './styles.css';
import { cloudConfig, createCloud } from './cloud.js';
import { renderLogin } from './views/login.js';
import { mountShell } from './shell.js';
import { mountTodos } from './views/todos.js';
import { t } from './i18n.js';

const root = document.getElementById('app');
const config = cloudConfig();
const cloud = config ? createCloud(config) : null;
let shownUser = null;

function showApp(user) {
  if (shownUser === user.id) return;
  shownUser = user.id;
  let todos = null;
  const { main, toast } = mountShell(root, {
    who: user.user_metadata?.user_name || user.email || '',
    current: 'todos',
    onSync: async () => {
      await todos.refresh();
      toast(t('synced'));
    },
    onLogout: async () => {
      shownUser = null;
      await cloud.logout().catch(() => {});
      location.reload();
    },
  });
  todos = mountTodos(main, { cloud, toast });
  todos.refresh();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') todos.refresh();
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
