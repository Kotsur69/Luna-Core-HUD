// ============================================================================
// LunaCore - API keys of the free asset libraries (Sketchfab, Poly Pizza,
// Freesound), main process only
// ----------------------------------------------------------------------------
// The keys live in LunaCore's secret storage: Electron safeStorage (the OS
// keychain) in asset-keys.local.json, through the same encryptedStorage as the
// cloud session (src/cloudauth.js). Without usable encryption (none, or
// Linux's plain-text "basic_text" backend) a key is kept in memory for this
// run only - never written in plain text.
//
//   main      get(source) for the library clients (src/lunasworkFreeSources.js),
//             secrets() for redacting error texts
//   renderer  two IPC channels (registerAssetKeyIpc): status() - which keys
//             are stored, booleans only; set(source, key | null). A key never
//             goes back to the renderer, a log or a file in a repo.
//
// The storage is opened on first use, after the app is ready (safeStorage
// cannot decrypt before that).
// ============================================================================

'use strict';

const path = require('path');
const { encryptedStorage } = require('./cloudauth');
const { KEYED_SOURCES } = require('./lunasworkFreeSources');

const STORE_FILE = 'asset-keys.local.json';
// Library keys are opaque tokens: letters, digits and a few separators.
const KEY_RE = /^[A-Za-z0-9_.-]{8,200}$/;

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/** safeStorage as encryptedStorage sees it: "basic_text" counts as no encryption. */
function guardedSafeStorage(raw) {
  const usable = () => {
    try {
      if (!raw || typeof raw.isEncryptionAvailable !== 'function' || !raw.isEncryptionAvailable()) return false;
      const backend = typeof raw.getSelectedStorageBackend === 'function' ? raw.getSelectedStorageBackend() : null;
      return backend !== 'basic_text';
    } catch {
      return false;
    }
  };
  return {
    isEncryptionAvailable: usable,
    encryptString: (s) => raw.encryptString(s),
    decryptString: (b) => raw.decryptString(b),
  };
}

/**
 * @param {{dir:()=>string, safeStorage?:()=>object|null}} deps dir = LunaCore's user config folder
 * @returns {{get:(source:string)=>string|null, set:(source:string, key:string|null)=>{ok:boolean, reason?:string},
 *   status:()=>{ok:true, keys:Record<string, boolean>, persisted:boolean}, secrets:()=>string[]}}
 */
function createAssetKeyStore(deps) {
  let storage = null;
  let ss = null;
  const open = () => {
    if (!storage) {
      ss = guardedSafeStorage(typeof deps.safeStorage === 'function' ? deps.safeStorage() : require('electron').safeStorage);
      storage = encryptedStorage(path.join(deps.dir(), STORE_FILE), ss);
    }
    return storage;
  };

  function get(source) {
    if (!KEYED_SOURCES.includes(source)) return null;
    const value = open().getItem(source);
    return typeof value === 'string' && KEY_RE.test(value) ? value : null;
  }

  function set(source, key) {
    if (!KEYED_SOURCES.includes(source)) return { ok: false, reason: 'bad-source' };
    if (key === null || key === '') {
      open().removeItem(source);
      return { ok: true };
    }
    if (typeof key !== 'string' || !KEY_RE.test(key.trim())) return { ok: false, reason: 'bad-key' };
    open().setItem(source, key.trim());
    return { ok: true };
  }

  function status() {
    const keys = Object.fromEntries(KEYED_SOURCES.map((s) => [s, get(s) !== null]));
    return { ok: true, keys, persisted: ss ? ss.isEncryptionAvailable() : false };
  }

  const secrets = () => KEYED_SOURCES.map(get).filter(Boolean);

  return { get, set, status, secrets };
}

/**
 * lunaswork:assetKeys -> status (booleans only); lunaswork:setAssetKey {source, key|null}.
 * The renderer is not trusted: the payload is checked here.
 */
function registerAssetKeyIpc({ ipcMain, keys }) {
  ipcMain.handle('lunaswork:assetKeys', () => {
    try {
      return keys.status();
    } catch (err) {
      console.error('[lunaswork] asset key status failed:', err && (err.code || err.name));
      return { ok: false, reason: 'failed' };
    }
  });
  ipcMain.handle('lunaswork:setAssetKey', (_event, req) => {
    if (!isObj(req) || typeof req.source !== 'string' || (req.key !== null && typeof req.key !== 'string')) return { ok: false, reason: 'bad-request' };
    try {
      const res = keys.set(req.source, req.key);
      return res.ok ? keys.status() : res;
    } catch (err) {
      // The error names the failure only, never the key.
      console.error('[lunaswork] asset key not saved:', err && (err.code || err.name));
      return { ok: false, reason: 'failed' };
    }
  });
}

module.exports = { STORE_FILE, KEY_RE, createAssetKeyStore, registerAssetKeyIpc };
