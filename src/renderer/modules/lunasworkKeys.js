// ============================================================================
// LunaCore - Settings -> Luna's Work -> Asset library keys
// ----------------------------------------------------------------------------
// The API keys of the free asset libraries the asset worker searches
// (src/lunasworkFreeSources.js). Write-only: main answers with booleans
// (stored / not set), never a key, and the inputs are cleared after a save.
// The keys themselves live in safeStorage (src/lunasworkAssetKeys.js).
// ============================================================================

'use strict';

import { t } from './util.js';
import { onLangChange } from './bus.js';

const SAVED_FLASH_MS = 2000;

function show(el, text) {
  el.textContent = text || '';
  el.hidden = !text;
}

/** Localized text for a failed answer. */
function errorText(res) {
  const reason = res && typeof res.reason === 'string' ? res.reason : 'failed';
  const text = t(`lw.err.${reason}`);
  return text === `lw.err.${reason}` ? t('lw.err.failed') : text;
}

/**
 * @param {HTMLElement} root the Settings overlay
 */
export function mountLunasWorkKeys(root) {
  const box = root.querySelector('#lw-keys');
  const save = root.querySelector('#lw-keys-save');
  const error = root.querySelector('#lw-keys-error');
  const saved = root.querySelector('#lw-keys-saved');
  const note = root.querySelector('#lw-keys-note');
  if (!box || !save || !error || !saved || !note || !window.lunacore || typeof window.lunacore.lunasworkAssetKeys !== 'function') return;
  const rows = Array.from(box.querySelectorAll('[data-lw-key]')).map((row) => ({
    source: row.dataset.lwKey,
    input: row.querySelector('[data-lw-key-input]'),
    status: row.querySelector('[data-lw-key-status]'),
    clear: row.querySelector('[data-lw-key-clear]'),
  })).filter((r) => r.input && r.status && r.clear);
  let state = null;
  let savedTimer = null;

  function paint() {
    for (const r of rows) {
      const stored = !!(state && state.keys && state.keys[r.source]);
      r.status.textContent = `(${t(stored ? 'lw.keys.stored' : 'lw.keys.missing')})`;
      r.clear.disabled = !stored;
    }
    note.hidden = !state || state.persisted !== false || !rows.some((r) => state.keys && state.keys[r.source]);
  }

  async function refresh() {
    const res = await window.lunacore.lunasworkAssetKeys();
    if (res && res.ok) state = res;
    else show(error, errorText(res));
    paint();
  }

  /** Sends one change; the answer (booleans) is what gets painted. A rejected IPC call reads as 'failed'. */
  async function send(source, key) {
    let res;
    try {
      res = await window.lunacore.lunasworkSetAssetKey(source, key);
    } catch (err) {
      console.warn('[lunasworkKeys] saving a key failed:', err && err.message);
      return { ok: false, reason: 'failed' };
    }
    if (!res || !res.ok) return res || { ok: false, reason: 'failed' };
    state = res;
    return res;
  }

  let busy = false;
  /** Runs one change with the buttons disabled, so a double click cannot send twice. */
  async function exclusive(fn) {
    if (busy) return;
    busy = true;
    save.disabled = true;
    for (const r of rows) r.clear.disabled = true;
    try {
      await fn();
    } finally {
      busy = false;
      save.disabled = false;
      paint();
    }
  }

  save.addEventListener('click', () => exclusive(async () => {
    show(error, '');
    const typed = rows.filter((r) => r.input.value.trim());
    for (const r of typed) {
      const res = await send(r.source, r.input.value.trim());
      if (!res.ok) {
        show(error, `${r.source}: ${errorText(res)}`);
        return;
      }
      r.input.value = '';
    }
    if (!typed.length) return;
    saved.hidden = false;
    clearTimeout(savedTimer);
    savedTimer = setTimeout(() => { saved.hidden = true; }, SAVED_FLASH_MS);
  }));

  for (const r of rows) {
    r.clear.addEventListener('click', () => exclusive(async () => {
      show(error, '');
      const res = await send(r.source, null);
      if (!res.ok) show(error, `${r.source}: ${errorText(res)}`);
    }));
  }

  onLangChange(paint);
  refresh().catch(() => show(error, t('lw.err.failed')));
}
