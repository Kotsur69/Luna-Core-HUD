// ============================================================================
// LunaCore - Settings -> General -> Editor auto-save (renderer)
// ----------------------------------------------------------------------------
// Lists the Unity projects and Blender versions main found (src/editorAutosave.js)
// and installs / removes the in-editor auto-save script. The renderer only
// ever sends the interval; which folders are written is main's decision.
// Static overlay, mounted once from termcustom.js (same shape as notify.js).
// ============================================================================

'use strict';

import { t } from './util.js';
import { onLangChange } from './bus.js';

const DEFAULT_MINUTES = 5;

/** The status text of one target row. Pure. */
export function rowStateText(row, translate = t) {
  if (!row || typeof row !== 'object') return '';
  if (row.ok === false) return translate(row.error === 'foreign' ? 'autosave.state.foreign' : 'autosave.state.failed');
  if (row.state === 'installed') {
    return Number.isInteger(row.minutes) ? translate('autosave.state.installed', { n: row.minutes }) : translate('autosave.state.installedPlain');
  }
  if (row.state === 'foreign') return translate('autosave.state.foreign');
  return translate('autosave.state.absent');
}

/** Rows out of an IPC answer; junk becomes an empty list. Pure. */
export function cleanRows(res) {
  const list = res && typeof res === 'object' && Array.isArray(res.targets) ? res.targets : [];
  return list.filter((r) => r && typeof r === 'object' && typeof r.name === 'string' && (r.kind === 'unity' || r.kind === 'blender'));
}

/** The interval to preselect: what is installed, else the default. Pure. */
export function installedMinutes(rows) {
  const row = rows.find((r) => r.state === 'installed' && Number.isInteger(r.minutes));
  return row ? row.minutes : DEFAULT_MINUTES;
}

/** Called once from termcustom.js with the #termcustom overlay as root. */
export function mountEditorAutosave(root) {
  const els = {
    minutes: root.querySelector('#autosave-minutes'),
    install: root.querySelector('#autosave-install'),
    remove: root.querySelector('#autosave-remove'),
    rows: root.querySelector('#autosave-rows'),
  };
  if (!els.minutes || !els.install || !els.remove || !els.rows) return;
  let rows = [];
  let options = [DEFAULT_MINUTES];
  let loaded = false;

  const renderOptions = (selected) => {
    els.minutes.replaceChildren(
      ...options.map((n) => {
        const option = document.createElement('option');
        option.value = String(n);
        option.textContent = t('autosave.minutes', { n });
        option.selected = n === selected;
        return option;
      }),
    );
  };

  const renderRows = () => {
    if (loaded && rows.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'termcustom__hint';
      empty.textContent = t('autosave.none');
      els.rows.replaceChildren(empty);
    } else {
      els.rows.replaceChildren(
        ...rows.map((row) => {
          const line = document.createElement('div');
          line.className = 'autosave-row';
          const name = document.createElement('span');
          name.className = 'autosave-row__name';
          name.textContent = row.name;
          const state = document.createElement('span');
          state.className = `autosave-row__state${row.state === 'installed' && row.ok !== false ? ' is-on' : ''}${row.ok === false ? ' is-bad' : ''}`;
          state.textContent = rowStateText(row);
          line.append(name, state);
          return line;
        }),
      );
    }
    els.install.disabled = rows.length === 0;
    els.remove.disabled = !rows.some((r) => r.state === 'installed');
  };

  const apply = (res) => {
    if (res && Array.isArray(res.minutes) && res.minutes.every(Number.isInteger) && res.minutes.length) options = res.minutes;
    rows = cleanRows(res);
    loaded = true;
    // What is installed wins; otherwise the choice on screen stays.
    const current = Number(els.minutes.value);
    const hasInstalled = rows.some((r) => r.state === 'installed' && Number.isInteger(r.minutes));
    renderOptions(hasInstalled ? installedMinutes(rows) : options.includes(current) ? current : DEFAULT_MINUTES);
    renderRows();
  };

  const run = (call) => {
    els.install.disabled = true;
    els.remove.disabled = true;
    call()
      .then(apply)
      .catch(() => renderRows());
  };

  els.install.addEventListener('click', () => run(() => window.lunacore.installEditorAutosave(Number(els.minutes.value))));
  els.remove.addEventListener('click', () => run(() => window.lunacore.removeEditorAutosave()));
  onLangChange(() => {
    renderOptions(Number(els.minutes.value) || DEFAULT_MINUTES);
    renderRows();
  });

  renderOptions(DEFAULT_MINUTES);
  run(() => window.lunacore.getEditorAutosave());
}
