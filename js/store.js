// The phone's local store (IndexedDB). Everything the app keeps lives here:
//
//   kv       session (Supabase tokens), keys (non-extractable CryptoKeys), keyVersion, directory,
//            sync status, the PKCE verifier during sign-in, hidden blocked cards
//   cards    decrypted Inbox cards, by cardId (the Mac's "ask:<id>", "inbox:<id>", …)
//   reports  decrypted final reports, by runId (shown by R6; cached here so a delivered report is kept)
//   blobs    decrypted card images, by storage path ({ path, blob, at })
//   outbox   phone commands and their status, by command id
//
// Mailbox rows are deleted once they are here, so this is the only copy on the phone. Items go
// after 30 days (Q6) or when dismissed. The passphrase itself is never stored.

const DB = 'pms-relay';
const VERSION = 1;
const STORES = { kv: null, cards: 'cardId', reports: 'runId', blobs: 'path', outbox: 'id' };

let dbp = null;
function db() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, VERSION);
    req.onupgradeneeded = () => {
      const d = req.result;
      for (const [name, keyPath] of Object.entries(STORES)) {
        if (!d.objectStoreNames.contains(name)) d.createObjectStore(name, keyPath ? { keyPath } : undefined);
      }
    };
    req.onsuccess = () => {
      const d = req.result;
      d.onversionchange = () => { d.close(); dbp = null; };
      resolve(d);
    };
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('The app is open in another tab: close it and try again'));
  });
  return dbp;
}

const done = (req) => new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });

// One transaction over `names`. `fn(stores)` queues requests; resolves with fn's value once committed.
async function tx(names, mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(names, mode);
    const stores = Object.fromEntries(names.map((n) => [n, t.objectStore(n)]));
    let out;
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('IndexedDB transaction aborted'));
    Promise.resolve(fn(stores)).then((v) => { out = v; }, (e) => { try { t.abort(); } catch { /* already done */ } reject(e); });
  });
}

export const kv = {
  get: (key) => tx(['kv'], 'readonly', (s) => done(s.kv.get(key))),
  set: (key, value) => tx(['kv'], 'readwrite', (s) => { s.kv.put(value, key); }),
  del: (key) => tx(['kv'], 'readwrite', (s) => { s.kv.delete(key); }),
};

const table = (name) => ({
  get: (id) => tx([name], 'readonly', (s) => done(s[name].get(id))),
  all: () => tx([name], 'readonly', (s) => done(s[name].getAll())),
  put: (v) => tx([name], 'readwrite', (s) => { s[name].put(v); }),
  del: (id) => tx([name], 'readwrite', (s) => { s[name].delete(id); }),
  clear: () => tx([name], 'readwrite', (s) => { s[name].clear(); }),
});

export const cards = table('cards');
export const reports = table('reports');
export const blobs = table('blobs');
export const outbox = table('outbox');

// Read-modify-write of one record in a single transaction. `fn(old)` returns the new record, or
// undefined to leave it alone, or null to delete it.
export function update(name, id, fn) {
  return tx([name], 'readwrite', async (s) => {
    const old = await done(s[name].get(id));
    const next = fn(old);
    if (next === null) s[name].delete(id);
    else if (next !== undefined) s[name].put(next);
    return next;
  });
}

// Sign out / rekey: everything goes, or everything but the session.
export async function wipe({ keepSession = false } = {}) {
  const session = keepSession ? await kv.get('session') : null;
  await tx(Object.keys(STORES), 'readwrite', (s) => { for (const n of Object.keys(STORES)) s[n].clear(); });
  if (session) await kv.set('session', session);
}

// Asks the browser not to evict the store under storage pressure. Best effort.
export async function persist() {
  try { return await navigator.storage?.persist?.(); } catch { return false; }
}
