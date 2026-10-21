// ============================================================================
// LunaCore phone - pair a host (REMOTE_HOST_PLAN H1, "Passkey + session key")
// ----------------------------------------------------------------------------
// Mati types the host's machine name (the host's tray and pairing hint show
// it; hosts already online are suggested), taps Pair, approves the passkey
// with Face ID and compares the 6-digit code here with the one on the host's
// screen. The host stores the key only once confirmed there (hostpair.js).
// ============================================================================

import { h } from '../dom.js';
import { t, tf } from '../i18n.js';
import { pairWithHost, HOST_RE } from '../hostpair.js';

const LABEL = 'iPhone';
const MAX_SUGGESTIONS = 16;

/** Machine names from `host` snapshot rows (raw, untrusted). */
function knownHosts(rows) {
  const names = (Array.isArray(rows) ? rows : []).map((r) => r && r.machine).filter((m) => typeof m === 'string' && HOST_RE.test(m));
  return [...new Set(names)].slice(0, MAX_SUGGESTIONS);
}

/**
 * @param {HTMLElement} main
 * @param {{cloud: object, toast: (m: string, bad?: boolean) => void}} deps
 * @returns {{refresh: () => Promise<void>}}
 */
export function mountPair(main, { cloud, toast }) {
  let busy = false;
  let cancelled = false;
  const list = h('datalist', { id: 'pair-hosts' });
  const input = h('input', { class: 'field', id: 'pair-host', type: 'text', list: 'pair-hosts', maxlength: '63', autocomplete: 'off', autocapitalize: 'characters', spellcheck: 'false', required: true });
  const status = h('p', { class: 'hint', role: 'status' });
  const code = h('p', { class: 'big-sm num', hidden: true, 'aria-live': 'polite' });
  const submit = h('button', { class: 'btn btn-primary', type: 'submit' }, t('pairStart'));

  const say = (text, bad = false) => {
    status.textContent = text;
    status.classList.toggle('is-bad', bad);
  };

  const form = h(
    'form',
    { class: 'card stack-sm' },
    h('h2', { class: 'section-title' }, t('pairTitle')),
    h('p', { class: 'hint' }, t('pairIntro')),
    h('label', { class: 'label', for: 'pair-host' }, t('pairHost')),
    input,
    list,
    submit,
    code,
    status,
  );

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (busy) return;
    const host = input.value.trim();
    if (!HOST_RE.test(host)) return say(t('pairBadHost'), true);
    busy = true;
    submit.disabled = true;
    code.hidden = true;
    say(t('pairWaitHost'));
    try {
      const result = await pairWithHost({
        cloud,
        host,
        label: LABEL,
        isCancelled: () => cancelled,
        onCode: (c) => {
          code.textContent = `${c.slice(0, 3)} ${c.slice(3)}`;
          code.hidden = false;
          say(tf('pairCompare', { host }));
        },
      });
      if (result === 'confirmed') {
        say(tf('pairDone', { host }));
        toast(tf('pairDone', { host }));
      } else {
        code.hidden = true;
        say(t(result === 'rejected' ? 'pairRejected' : 'pairTimeout'), true);
      }
    } catch (err) {
      code.hidden = true;
      const reason = err && err.message;
      say(t(reason === 'pair-unsupported' ? 'pairUnsupported' : err && err.name === 'NotAllowedError' ? 'pairCancelled' : 'pairFailed'), true);
    } finally {
      busy = false;
      submit.disabled = false;
    }
  });

  main.replaceChildren(h('div', { class: 'stack' }, form));
  // Leaving the page (a fresh mount replaces this node) stops the polling.
  new MutationObserver((_m, obs) => {
    if (!main.isConnected) {
      cancelled = true;
      obs.disconnect();
    }
  }).observe(document.body, { childList: true, subtree: true });

  async function refresh() {
    const rows = await cloud.snapshots('host').catch(() => cloud.cachedSnapshots('host'));
    list.replaceChildren(...knownHosts(rows).map((m) => h('option', { value: m })));
  }

  return { refresh };
}
