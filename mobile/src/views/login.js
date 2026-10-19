// LunaCore phone - login screen (GitHub through Supabase, same account as the PCs).

import { h, icon, ICONS } from '../dom.js';
import { t } from '../i18n.js';

/**
 * @param {HTMLElement} root
 * @param {{onLogin: (() => Promise<unknown>)|null}} opts null = this build has no cloud config
 */
export function renderLogin(root, { onLogin }) {
  const btn = h('button', { class: 'btn', disabled: !onLogin }, icon(ICONS.github), t('login'));
  if (onLogin) {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        await onLogin();
      } catch {
        btn.disabled = false;
      }
    });
  }
  root.replaceChildren(
    h(
      'section',
      { class: 'login' },
      h('img', { src: '/icon-512.png', alt: '', width: 96, height: 96 }),
      h('h1', {}, 'LUNACORE'),
      h('p', {}, t('appTagline')),
      btn,
      h('p', {}, onLogin ? t('loginHint') : t('noConfig')),
    ),
  );
}
