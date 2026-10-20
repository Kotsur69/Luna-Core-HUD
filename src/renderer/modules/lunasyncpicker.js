// ============================================================================
// LunaCore - Luna sync skill picker (Settings, DOM + IPC half)
// ----------------------------------------------------------------------------
// docs/FREE_PROVIDERS_SYNC_PLAN.md S3. Lists the enabled plugins' skills
// (ids/names only - main never sends paths) and saves which ones a Codex/
// Gemini tab with "Use my Luna setup" also gets. Personal ~/.claude/skills
// always go along, so they are not listed. The list logic is pure and lives
// in lunasyncpickermodel.js.
// ============================================================================

import { t } from './util.js';
import { onLangChange } from './bus.js';
import { filterSkills, togglePicked } from './lunasyncpickermodel.js';

/** Rows drawn at once; the filter narrows the rest. */
const MAX_ROWS = 60;

/** Filter input settle time before redrawing. */
const FILTER_DEBOUNCE_MS = 120;

let els = null;
let skills = [];
let picked = [];
let savedPicked = [];
let query = '';
let loadFailed = false;

function setStatus(key, failed) {
  if (!els) return;
  els.status.hidden = false;
  els.status.classList.toggle('is-fail', failed);
  els.status.textContent = t(key);
}

function buildRow(row) {
  const li = document.createElement('li');
  li.className = 'diag-item';
  const label = document.createElement('label');
  label.className = 'switch-field';
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.checked = row.picked;
  box.addEventListener('change', () => {
    picked = togglePicked(picked, row.id, box.checked);
    renderCount();
  });
  const text = document.createElement('span');
  text.className = 'switch-field__text';
  const name = document.createElement('span');
  name.className = 'switch-field__label';
  name.textContent = row.name;
  const plugin = document.createElement('span');
  plugin.className = 'switch-field__status';
  plugin.textContent = row.plugin;
  text.append(name, plugin);
  label.append(box, text);
  li.appendChild(label);
  return li;
}

function renderCount(view) {
  if (!els) return;
  const parts = [t('lunasync.picked', { n: picked.length })];
  if (view && view.hidden > 0) parts.push(t('lunasync.more', { n: view.hidden }));
  els.count.textContent = parts.join(' · ');
  els.save.disabled = JSON.stringify([...picked].sort()) === JSON.stringify([...savedPicked].sort());
}

function render() {
  if (!els) return;
  els.list.innerHTML = '';
  if (loadFailed) {
    els.count.textContent = t('lunasync.loadFailed');
    els.save.disabled = true;
    return;
  }
  const view = filterSkills(skills, query, picked, MAX_ROWS);
  if (view.rows.length === 0) {
    els.count.textContent = skills.length === 0 ? t('lunasync.none') : t('lunasync.noMatch');
    return;
  }
  for (const row of view.rows) els.list.appendChild(buildRow(row));
  renderCount(view);
}

async function refresh() {
  try {
    const result = await window.lunacore.getLunaSyncSkills();
    skills = (result && Array.isArray(result.skills) && result.skills) || [];
    savedPicked = (result && Array.isArray(result.pickedSkills) && result.pickedSkills) || [];
    picked = [...savedPicked];
    loadFailed = false;
  } catch {
    loadFailed = true;
  }
  render();
}

async function save() {
  if (!els) return;
  els.save.disabled = true;
  let response;
  try {
    response = await window.lunacore.setLunaSyncSkills(picked);
  } catch {
    response = null;
  }
  if (response && response.ok) {
    savedPicked = response.prefs.pickedSkills;
    picked = [...savedPicked];
    setStatus('lunasync.saved', false);
    render();
  } else {
    setStatus('lunasync.saveFailed', true);
    renderCount();
  }
}

/**
 * Called once from termcustom.js's Settings-overlay init, like mountProviderSettings().
 * @param {ParentNode} root
 * @returns {() => void} disposer
 */
export function mountLunaSyncPicker(root) {
  els = {
    filter: root.querySelector('#lunasync-filter'),
    count: root.querySelector('#lunasync-count'),
    list: root.querySelector('#lunasync-list'),
    save: root.querySelector('#lunasync-save'),
    status: root.querySelector('#lunasync-status'),
  };
  if (!els.list || typeof window.lunacore.getLunaSyncSkills !== 'function') {
    els = null;
    return () => {};
  }

  let timer = null;
  els.filter.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      query = els ? els.filter.value : '';
      render();
    }, FILTER_DEBOUNCE_MS);
  });
  els.save.addEventListener('click', save);
  els.count.textContent = t('lunasync.loading');

  const offLang = onLangChange(render);
  refresh();

  return () => {
    clearTimeout(timer);
    offLang();
    els = null;
  };
}
