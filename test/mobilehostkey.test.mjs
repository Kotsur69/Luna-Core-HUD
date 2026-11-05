// Phone session key (mobile/src/hostkey.js), J-M11 of docs/tbc_docs/REMOTE_HOST_PLAN.md
// "Security review": two concurrent first signCommands used to make two
// session keys, the second overwriting the first, so one command was signed
// by a key its grant did not name. A fake IndexedDB and a fake passkey stand
// in for the browser; the signing is real WebCrypto.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';

const store = new Map();
let assertions = 0;

/** Just enough of indexedDB for mobile/src/idb.js: one store, get / put / delete. */
function fakeIndexedDB() {
  const db = {
    createObjectStore: () => {},
    transaction: () => {
      const tx = {};
      const later = (req, fn) => {
        setTimeout(() => {
          req.result = fn();
          if (tx.oncomplete) tx.oncomplete();
        }, 1);
        return req;
      };
      tx.objectStore = () => ({
        get: (k) => later({}, () => store.get(k)),
        put: (v, k) => later({}, () => store.set(k, v)),
        delete: (k) => later({}, () => store.delete(k)),
        clear: () => later({}, () => store.clear()),
      });
      return tx;
    },
  };
  return {
    open: () => {
      const req = { result: db };
      setTimeout(() => req.onsuccess && req.onsuccess(), 1);
      return req;
    },
  };
}

let hostkey;

before(async () => {
  globalThis.indexedDB = fakeIndexedDB();
  Object.defineProperty(globalThis, 'location', { value: { hostname: 'luna.example' }, configurable: true });
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      credentials: {
        // A passkey prompt takes a moment: plenty of time for a racing caller.
        get: async () => {
          assertions++;
          await new Promise((r) => setTimeout(r, 5));
          const bytes = (n) => new Uint8Array(n).fill(7).buffer;
          return { rawId: bytes(16), response: { authenticatorData: bytes(37), clientDataJSON: bytes(20), signature: bytes(64) } };
        },
      },
    },
  });
  hostkey = await import('../mobile/src/hostkey.js');
});

const b64uToBytes = (s) => Uint8Array.from(Buffer.from(s, 'base64url'));

test('J-M11: two concurrent first signCommands share one session key and one Face ID prompt', async () => {
  await hostkey.wipe();
  assertions = 0;
  const [a, b] = await Promise.all([hostkey.signCommand('KT-PC', 'news.scan', { a: 1 }), hostkey.signCommand('KT-PC', 'news.scan', { b: 2 })]);
  assert.equal(a.grant.grant.sessionKeyPub, b.grant.grant.sessionKeyPub, 'one key');
  assert.equal(assertions, 1, 'one passkey prompt');
  assert.equal(store.get('hostkey:session').pub, a.grant.grant.sessionKeyPub, 'the stored key is the granted one');
  // Both commands verify under the key their grant names.
  const canon = (await import('../src/hostcanon.js')).default;
  const pub = await webcrypto.subtle.importKey('spki', b64uToBytes(a.grant.grant.sessionKeyPub), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  for (const r of [a, b]) {
    const ok = await webcrypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, b64uToBytes(r.sig), new TextEncoder().encode(canon.canonicalCommand(r.command)));
    assert.equal(ok, true);
  }
});

test('J-M11: a wipe while a key loads never lets the old load become the session', async () => {
  await hostkey.wipe();
  const first = hostkey.grantFor('KT-PC');
  await hostkey.wipe();
  await assert.rejects(first, /wiped while in use/);
  const after = await hostkey.signCommand('KT-PC', 'news.scan', {});
  assert.equal(store.get('hostkey:session').pub, after.grant.grant.sessionKeyPub);
});
