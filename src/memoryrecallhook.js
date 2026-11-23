// ============================================================================
// LunaCore - the auto-recall switch and a tab's UserPromptSubmit hook (main)
// ----------------------------------------------------------------------------
// docs/tbc_docs/RAG_STYLE_MEMORY_PLAN.md, phase 7 lite. `memoryAutoRecall`
// is OFF by default. With it on, a `claude` tab started in a project with
// memory switched on gets one extra settings file (`--settings`) holding an
// HTTP UserPromptSubmit hook: every prompt is posted to the intake server's
// POST /recall (src/intake.js) with the tab's own bearer token, and the
// answer (src/memoryrecall.js) is added to the prompt as data.
//
// It never slows a prompt down for long: the recall waits at most 400 ms for
// the local embedding model, and Claude Code gives the hook HOOK_TIMEOUT_S at
// most. A hook that fails or times out is a non-blocking error: the prompt
// goes on without memories.
//
// The hook is fixed when the tab starts. Switching recall off works at once
// (the endpoint answers {} for every tab); switching it on reaches tabs
// started afterwards.
//
// The switch syncs like the auto-accept switches (src/memoryautoaccept.js):
//
//   memory-recall.local.json = {memoryAutoRecall: true|false}
//   config-scope unit          memory-recall:auto = {on: true}
//
// The per-tab file sits next to the tab's --mcp-config (src/intake.js) and,
// like it, holds the tab's token: `.local.json`, mode 0600, deleted with the tab.
// ============================================================================

'use strict';

const fs = require('fs');
const path = require('path');
const { readDoc, writeAtomic } = require('./projectsync');
const { isClaudeCommand } = require('./launch');
const { readEnabled } = require('./memoryprojects');

const SETTINGS_KEY = 'memoryAutoRecall';
const UNIT_KEY = 'memory-recall:auto';
/** Seconds Claude Code waits for the hook before the prompt goes on without it. */
const HOOK_TIMEOUT_S = 2;
/**
 * A launch that decides its own settings or skips hooks: a lean local-model
 * tab (--strict-mcp-config), --bare, or a profile with its own --settings.
 */
const SETTINGS_DECIDED = /(^|\s)(--strict-mcp-config|--bare|--settings)(\s|=|$)/;
/** Characters that would break the single-quoted shell argument (U+2018-U+201B: PowerShell quotes). */
const UNQUOTABLE_RE = /['`\r\n‘-‛]/;
const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const TOKEN_RE = /^[A-Za-z0-9]{16,256}$/;
const RECALL_URL_RE = /^http:\/\/127\.0\.0\.1:\d{1,5}\/recall$/;

const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const errText = (err) => (err && (err.code || err.message)) || 'error';

// ---------------------------------------------------------------- the switch

/** Whether auto-recall is on; throws when the file exists but is unreadable. */
function readAutoRecallStrict(file) {
  const doc = readDoc(file);
  // Only a literal true switches it on: anything else in a hand-edited file is off.
  return isObject(doc) && doc[SETTINGS_KEY] === true;
}

/** Whether auto-recall is on; an unreadable file reads as off. */
function readAutoRecall(file) {
  try {
    return readAutoRecallStrict(file);
  } catch (err) {
    console.error('[memory] auto-recall setting unreadable, off:', errText(err));
    return false;
  }
}

/**
 * Switches auto-recall on or off.
 * @param {string} file memoryPaths().recall
 * @param {boolean} on
 * @returns {boolean} the switch afterwards
 */
function setAutoRecall(file, on) {
  if (typeof on !== 'boolean') throw new Error('bad-switch');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeAtomic(file, `${JSON.stringify({ [SETTINGS_KEY]: on })}\n`);
  return on;
}

/** The switch as a configsync.js provider (scope `config`), like memory-auto:<type>. */
function createAutoRecallProvider(file) {
  return {
    name: 'memory-recall',
    owns: (k) => k === UNIT_KEY,
    valid: (k, v) => (k === UNIT_KEY && isObject(v) && v.on === true ? { on: true } : null),
    read(now) {
      const fresh = !fs.existsSync(file);
      const base = fresh ? 0 : Math.floor(Math.min(fs.statSync(file).mtimeMs, now));
      // A missing file is a fresh PC, not "switched off".
      return { units: readAutoRecallStrict(file) ? [[UNIT_KEY, { on: true }]] : [], base, fresh };
    },
    write(units) {
      setAutoRecall(file, units.some(([k]) => k === UNIT_KEY));
    },
  };
}

/**
 * The memory project a tab's prompts are recalled for, or null: auto-recall
 * is off, the tab has no memory project, or memory is off for it.
 * @param {{recallFile: string, projectsFile: string, project: string|null}} ctx
 *   recallFile / projectsFile = memoryPaths().recall / .projects
 * @returns {string|null}
 */
function recallProject({ recallFile, projectsFile, project }) {
  if (typeof project !== 'string' || !project || !readAutoRecall(recallFile)) return null;
  return readEnabled(projectsFile).includes(project) ? project : null;
}

// ---------------------------------------------------------------- the tab's hook

/**
 * The settings document of one tab: an HTTP UserPromptSubmit hook to /recall.
 * @param {string} url the intake server's recallUrl()
 * @param {string} token the tab's bearer token
 * @returns {object}
 */
function hookSettings(url, token) {
  return {
    hooks: {
      UserPromptSubmit: [{ hooks: [{ type: 'http', url, headers: { Authorization: `Bearer ${token}` }, timeout: HOOK_TIMEOUT_S }] }],
    },
  };
}

/** Where one tab's hook settings live. The session id is LunaCore's own `s<n>`. */
function hookSettingsPath(dir, sessionId) {
  return path.join(dir, `recall-hook-${sessionId}.local.json`);
}

/** Deletes one tab's hook settings; a missing file is fine. */
function removeRecallHook(dir, sessionId, fsImpl = fs) {
  if (typeof sessionId !== 'string' || !SESSION_ID_RE.test(sessionId)) return;
  try {
    fsImpl.unlinkSync(hookSettingsPath(dir, sessionId));
  } catch (err) {
    if (err && err.code !== 'ENOENT') console.error('[memory] recall hook not removed:', errText(err));
  }
}

/**
 * Writes (or, when recall is off, removes) one tab's hook settings.
 * @param {{dir: string, sessionId: string, url: string|null, token: string, on: boolean, fsImpl?: object}} opts
 *   on = auto-recall is switched on and memory is on for the tab's project
 * @returns {string|null} the file for --settings, or null (off, bad input, or not written)
 */
function prepareRecallHook({ dir, sessionId, url, token, on, fsImpl = fs }) {
  if (typeof sessionId !== 'string' || !SESSION_ID_RE.test(sessionId)) return null;
  if (!on || typeof url !== 'string' || !RECALL_URL_RE.test(url) || typeof token !== 'string' || !TOKEN_RE.test(token)) {
    removeRecallHook(dir, sessionId, fsImpl);
    return null;
  }
  const file = hookSettingsPath(dir, sessionId);
  try {
    fsImpl.writeFileSync(file, JSON.stringify(hookSettings(url, token)), { encoding: 'utf8', mode: 0o600 });
    return file;
  } catch (err) {
    console.error('[memory] recall hook not written:', errText(err));
    return null;
  }
}

/**
 * Appends `--settings '<file>'` to a plain `claude` start command. Other
 * programs, launches matching SETTINGS_DECIDED and a path that would break
 * the single-quoted argument are left alone.
 * @param {string} command
 * @param {string|null} settingsPath prepareRecallHook()'s file
 * @returns {string}
 */
function withRecallHook(command, settingsPath) {
  const cmd = String(command || '').trim();
  if (!cmd || typeof settingsPath !== 'string' || !settingsPath || UNQUOTABLE_RE.test(settingsPath)) return cmd;
  if (!isClaudeCommand(cmd) || SETTINGS_DECIDED.test(cmd)) return cmd;
  return `${cmd} --settings '${settingsPath}'`;
}

module.exports = {
  readAutoRecall,
  setAutoRecall,
  createAutoRecallProvider,
  recallProject,
  hookSettings,
  hookSettingsPath,
  prepareRecallHook,
  removeRecallHook,
  withRecallHook,
  SETTINGS_KEY,
  UNIT_KEY,
  HOOK_TIMEOUT_S,
};
