// ============================================================================
// LunaCore phone - IndexedDB key/value store
// ----------------------------------------------------------------------------
// One object store of plain values. Holds each scope's pulled mirror
// ({cursor, mirror, pushed}, the same shape cloudsync.js keeps on a PC), so
// the app opens instantly and still shows data while offline.
// ============================================================================

const DB = 'lunacore';
const STORE = 'kv';

let opening = null;

function open() {
  opening ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => {
      // A newer tab upgrading the schema: let it, and reopen next time.
      req.result.onversionchange = () => {
        req.result.close();
        opening = null;
      };
      resolve(req.result);
    };
    req.onerror = () => reject(req.error);
  }).catch((err) => {
    // A failed open (storage full, private mode) is retried on the next call.
    opening = null;
    throw err;
  });
  return opening;
}

async function run(mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(req.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export const get = (key) => run('readonly', (s) => s.get(key));
export const put = (key, value) => run('readwrite', (s) => s.put(value, key));
export const clear = () => run('readwrite', (s) => s.clear());
export const del = (key) => run('readwrite', (s) => s.delete(key));
