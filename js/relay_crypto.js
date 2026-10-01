// Project Suite — the phone relay's crypto (docs/relay-design.md, "Crypto"). One ES module with no
// dependencies that runs the same in Node 20+ and in a phone browser, because both sides must make
// byte-identical keys, refs and ciphertext. Everything goes through WebCrypto
// (globalThis.crypto.subtle).
//
//   passphrase --PBKDF2-SHA256 (600k, 16-byte salt)--> 32-byte master
//   master --HKDF-SHA256--> encKey (AES-256-GCM) + refKey (HMAC-SHA256)
//
// The Mac keeps the master (Keychain) and calls importKeys(master). The phone calls
// deriveKeys(passphrase, kdf) and keeps only the non-extractable CryptoKeys it gets back.
//
// Mailbox rows are AES-GCM with a fresh 96-bit IV and AAD = `dir|kind|ref|key_version`, so a row
// moved to the other direction, relabelled, or re-pointed at another ref fails to decrypt. Every
// failure (wrong key, tampered byte, wrong AAD) throws RelayCryptoError. Callers drop the row.
//
// Changing any constant here (info strings, verifier text, AAD layout) breaks every existing
// mailbox row, verifier and phone install. Do that only with `pms relay rekey`, and update the
// fixed test vector in test/relay-crypto.test.js and public/relay_crypto_test.html with it.

const subtle = () => {
  const s = globalThis.crypto?.subtle;
  if (!s) throw new RelayCryptoError('WebCrypto is not available (needs Node 20+ or a secure https page)');
  return s;
};

export class RelayCryptoError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'RelayCryptoError';
    if (cause) this.cause = cause;
  }
}

export const KDF_ALG = 'PBKDF2-SHA256';
export const KDF_ITER = 600000;
// Lowest iteration count deriveMaster accepts from relay_meta, so a forged meta row cannot make
// the phone derive a cheap-to-guess key.
export const KDF_MIN_ITER = 100000;
const SALT_BYTES = 16;
const IV_BYTES = 12;
const MASTER_BYTES = 32;
const INFO_ENC = 'pms-relay v1 enc';
const INFO_REF = 'pms-relay v1 ref';
const VERIFIER_TEXT = 'pms-relay verifier v1';
const DIRS = new Set(['down', 'up']);

const te = new TextEncoder();
const td = new TextDecoder('utf-8', { fatal: true });

// ---- bytes <-> base64 (the mailbox columns are text) ----

export function toB64(bytes) {
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
}

export function fromB64(text) {
  if (typeof text !== 'string') throw new RelayCryptoError('expected base64 text');
  let bin;
  try { bin = atob(text); } catch (e) { throw new RelayCryptoError('bad base64', e); }
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}

const toB64url = (bytes) => toB64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// getRandomValues takes at most 64 KB per call in both Node and browsers.
export function randomBytes(n) {
  const u = new Uint8Array(n);
  for (let i = 0; i < n; i += 0x10000) globalThis.crypto.getRandomValues(u.subarray(i, Math.min(n, i + 0x10000)));
  return u;
}

// ---- passphrase ----

// What the phone keyboard does to a typed passphrase (a capital first letter, a trailing space,
// double spaces, hyphens instead of spaces) must not change the key. Generated passphrases are
// lowercase words, so folding case loses nothing.
export function normalizePassphrase(passphrase) {
  if (typeof passphrase !== 'string') throw new RelayCryptoError('passphrase must be a string');
  const p = passphrase.normalize('NFKC').toLowerCase().replace(/[\s\-_.,]+/g, ' ').trim();
  if (!p) throw new RelayCryptoError('passphrase is empty');
  return p;
}

// `count` words picked uniformly at random from `wordlist` (rejection sampling, no modulo bias),
// joined by spaces. The word list is the caller's (Q5: a generated 4-word passphrase). With 7776
// words that is about 51.7 bits.
export function generatePassphrase(wordlist, count = 4) {
  if (!Array.isArray(wordlist) || wordlist.length < 2 || wordlist.length > 0x10000) {
    throw new RelayCryptoError('word list must have 2..65536 words');
  }
  const n = wordlist.length;
  const limit = 0x10000 - (0x10000 % n);
  const words = [];
  while (words.length < count) {
    const [r] = new Uint16Array(randomBytes(2).buffer);
    if (r < limit) words.push(wordlist[r % n]);
  }
  return words.join(' ');
}

// ---- keys ----

// A fresh relay_meta.kdf value: {"alg":"PBKDF2-SHA256","iter":600000,"salt":"<b64>"}.
export function newKdf() {
  return { alg: KDF_ALG, iter: KDF_ITER, salt: toB64(randomBytes(SALT_BYTES)) };
}

function checkKdf(kdf) {
  if (!kdf || kdf.alg !== KDF_ALG) throw new RelayCryptoError(`unsupported KDF ${kdf?.alg}`);
  if (!Number.isInteger(kdf.iter) || kdf.iter < KDF_MIN_ITER) throw new RelayCryptoError(`KDF iteration count too low: ${kdf.iter}`);
  const salt = fromB64(kdf.salt);
  if (salt.length < SALT_BYTES) throw new RelayCryptoError('KDF salt too short');
  return salt;
}

// The 32-byte master key as raw bytes. The Mac stores these in the Keychain.
export async function deriveMaster(passphrase, kdf) {
  const salt = checkKdf(kdf);
  const base = await subtle().importKey('raw', te.encode(normalizePassphrase(passphrase)), 'PBKDF2', false, ['deriveBits']);
  const bits = await subtle().deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: kdf.iter }, base, MASTER_BYTES * 8);
  return new Uint8Array(bits);
}

// { encKey, refKey } from the master bytes. Non-extractable by default, so a key read back from the
// phone's IndexedDB cannot be exported.
export async function importKeys(master, { extractable = false } = {}) {
  const raw = master instanceof Uint8Array ? master : new Uint8Array(master);
  if (raw.length !== MASTER_BYTES) throw new RelayCryptoError(`master key must be ${MASTER_BYTES} bytes`);
  const hkdf = await subtle().importKey('raw', raw, 'HKDF', false, ['deriveKey']);
  const params = (info) => ({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: te.encode(info) });
  const encKey = await subtle().deriveKey(params(INFO_ENC), hkdf, { name: 'AES-GCM', length: 256 }, extractable, ['encrypt', 'decrypt']);
  const refKey = await subtle().deriveKey(params(INFO_REF), hkdf, { name: 'HMAC', hash: 'SHA-256', length: 256 }, extractable, ['sign', 'verify']);
  return { encKey, refKey };
}

// The phone's path: passphrase straight to keys; the master bytes are not kept.
export async function deriveKeys(passphrase, kdf, opts) {
  const master = await deriveMaster(passphrase, kdf);
  try { return await importKeys(master, opts); } finally { master.fill(0); }
}

// ---- ref ----

// The mailbox `ref` for a local id (an ask id, inbox item id, run id, …): HMAC-SHA256 under refKey,
// base64url. Stable for a key, so the Mac can replace a card in place; unreadable to Supabase.
export async function refFor(keys, localId) {
  if (typeof localId !== 'string' || !localId) throw new RelayCryptoError('ref needs a non-empty local id');
  return toB64url(await subtle().sign('HMAC', keys.refKey, te.encode(localId)));
}

// ---- mailbox rows ----

// The AAD string for a row. `ref` may be null (commands and results carry none).
export function rowAad({ dir, kind, ref = null, keyVersion }) {
  if (!DIRS.has(dir)) throw new RelayCryptoError(`bad dir ${dir}`);
  if (typeof kind !== 'string' || !kind || kind.includes('|')) throw new RelayCryptoError(`bad kind ${kind}`);
  if (ref != null && (typeof ref !== 'string' || ref.includes('|'))) throw new RelayCryptoError('bad ref');
  if (!Number.isInteger(keyVersion) || keyVersion < 1) throw new RelayCryptoError(`bad key_version ${keyVersion}`);
  return `${dir}|${kind}|${ref ?? ''}|${keyVersion}`;
}

async function gcmEncrypt(key, iv, aad, plain) {
  return new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: te.encode(aad) }, key, plain));
}

async function gcmDecrypt(key, iv, aad, cipher, what) {
  if (iv.length !== IV_BYTES) throw new RelayCryptoError(`${what}: IV must be ${IV_BYTES} bytes`);
  try {
    return new Uint8Array(await subtle().decrypt({ name: 'AES-GCM', iv, additionalData: te.encode(aad) }, key, cipher));
  } catch (e) {
    throw new RelayCryptoError(`${what} did not decrypt (wrong key, wrong label or tampered)`, e);
  }
}

// Encrypt a JSON-able value for a mailbox row. Returns the two text columns { iv, body }.
// `iv` is for tests only (the fixed vector); never pass it otherwise.
export async function encryptRow(keys, header, value, { iv = randomBytes(IV_BYTES) } = {}) {
  const body = await gcmEncrypt(keys.encKey, iv, rowAad(header), te.encode(JSON.stringify(value)));
  return { iv: toB64(iv), body: toB64(body) };
}

// The value back from a row's { dir, kind, ref, key_version, iv, body }. Header fields may be given
// in row form (key_version) or JS form (keyVersion).
export async function decryptRow(keys, row) {
  const header = { dir: row.dir, kind: row.kind, ref: row.ref ?? null, keyVersion: row.keyVersion ?? row.key_version };
  const plain = await gcmDecrypt(keys.encKey, fromB64(row.iv), rowAad(header), fromB64(row.body), 'row');
  try { return JSON.parse(td.decode(plain)); } catch (e) { throw new RelayCryptoError('row decrypted but is not JSON', e); }
}

// ---- verifier (relay_meta.verifier) ----

// "<iv b64>.<body b64>": a fixed string under encKey, AAD bound to the key version, so the phone
// can tell a wrong passphrase from a network error without touching any mailbox row.
export async function makeVerifier(keys, keyVersion, { iv = randomBytes(IV_BYTES) } = {}) {
  const body = await gcmEncrypt(keys.encKey, iv, `verifier|${keyVersion}`, te.encode(VERIFIER_TEXT));
  return `${toB64(iv)}.${toB64(body)}`;
}

// true when `keys` match the verifier; false for a wrong passphrase. Throws only on a malformed one.
export async function checkVerifier(keys, verifier, keyVersion) {
  const [iv, body, extra] = String(verifier).split('.');
  if (!iv || !body || extra !== undefined) throw new RelayCryptoError('malformed verifier');
  try {
    const plain = await gcmDecrypt(keys.encKey, fromB64(iv), `verifier|${keyVersion}`, fromB64(body), 'verifier');
    return td.decode(plain) === VERIFIER_TEXT;
  } catch (e) {
    if (e instanceof RelayCryptoError && /did not decrypt/.test(e.message)) return false;
    throw e;
  }
}

// ---- blobs (images in Storage) ----

// IV (12 bytes) followed by the ciphertext + tag, AAD = the storage path, so a blob cannot be
// swapped for another path's.
export async function encryptBlob(keys, path, bytes, { iv = randomBytes(IV_BYTES) } = {}) {
  if (typeof path !== 'string' || !path) throw new RelayCryptoError('blob needs its storage path');
  const plain = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const cipher = await gcmEncrypt(keys.encKey, iv, `blob|${path}`, plain);
  const out = new Uint8Array(IV_BYTES + cipher.length);
  out.set(iv, 0);
  out.set(cipher, IV_BYTES);
  return out;
}

export async function decryptBlob(keys, path, blob) {
  if (typeof path !== 'string' || !path) throw new RelayCryptoError('blob needs its storage path');
  const u = blob instanceof Uint8Array ? blob : new Uint8Array(blob);
  if (u.length < IV_BYTES + 16) throw new RelayCryptoError('blob too short');
  return gcmDecrypt(keys.encKey, u.subarray(0, IV_BYTES), `blob|${path}`, u.subarray(IV_BYTES), 'blob');
}
