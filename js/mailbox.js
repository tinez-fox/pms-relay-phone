// The phone's side of the Supabase mailbox (the suite's docs/relay-design.md, "Data model" and
// "As built in R1"). PostgREST for `mailbox` and `relay_meta`, Storage for the `relay` bucket.
// What RLS lets the phone do, and so all this does:
//
//   read and delete `down` rows      read `relay_meta`
//   insert `up` rows (return=minimal, id = the command id: the phone cannot read up rows back)
//   upload to relay/<own uid>/<uuid>.bin (no upsert), read and delete any relay blob
//
// Errors are MailboxError with `kind`: 'network' | 'signin' (the session is gone: sign in again) |
// 'forbidden' (RLS said no) | 'paused' | 'conflict' | 'missing' | 'http'.
import { AuthError } from './auth.js';

export class MailboxError extends Error {
  constructor(kind, message, status = null) { super(message); this.name = 'MailboxError'; this.kind = kind; this.status = status; }
}

// Same rule as the Mac (lib/relay_mailbox.js): not yet confirmed against a real paused project (R7).
const isPaused = (status, text) => status === 540 || (status >= 500 && /paus/i.test(text));

export function createMailbox({ url, anonKey, auth, fetchImpl = (...a) => fetch(...a), timeoutMs = 20000 }) {
  const base = url.replace(/\/$/, '');

  async function call(method, path, { body, headers = {}, raw = false, as = 'json' } = {}, retried = false) {
    let token;
    try { token = await auth.accessToken({ force: retried }); } catch (e) {
      if (e instanceof AuthError) throw new MailboxError('signin', e.message);
      throw new MailboxError('network', e.message);
    }
    let res;
    try {
      res = await fetchImpl(base + path, {
        method,
        headers: { apikey: anonKey, authorization: `Bearer ${token}`, ...(body !== undefined && !raw && { 'content-type': 'application/json' }), ...headers },
        body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
        signal: AbortSignal.timeout?.(timeoutMs),
        cache: 'no-store',
      });
    } catch (e) {
      throw new MailboxError('network', navigator.onLine === false ? 'No connection' : `Supabase not reachable (${e.message})`);
    }
    if (res.ok && as === 'bytes') return new Uint8Array(await res.arrayBuffer());
    const text = await res.text().catch(() => '');
    if (res.ok) { try { return text ? JSON.parse(text) : null; } catch { return null; } }
    if (isPaused(res.status, text)) throw new MailboxError('paused', 'The Supabase project is paused', res.status);
    // A token the server refused (revoked, clock jump after sleep): refresh once and try again.
    if (res.status === 401 && !retried) return call(method, path, { body, headers, raw, as }, true);
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    const msg = json?.message || json?.error || json?.msg || text.slice(0, 200) || `HTTP ${res.status}`;
    const kind = res.status === 409 || json?.code === '23505' || /already exists|Duplicate/i.test(msg) ? 'conflict'
      : res.status === 401 ? 'signin' : res.status === 403 ? 'forbidden'
      : res.status === 404 || /not found/i.test(msg) ? 'missing' : 'http';
    throw new MailboxError(kind, `Supabase ${method} ${path.split('?')[0]}: ${msg}`, res.status);
  }

  const q = encodeURIComponent;
  const objectPath = (p) => p.split('/').map(q).join('/');

  return {
    // null when there is no row, or this account is not a relay member (RLS hides it then).
    async getMeta() {
      const rows = await call('GET', '/rest/v1/relay_meta?select=kdf,verifier,key_version,updated_at&id=eq.1');
      return rows?.[0] || null;
    },
    async listDown(limit = 50) {
      return (await call('GET', `/rest/v1/mailbox?select=id,dir,kind,ref,key_version,iv,body,created_at&dir=eq.down&order=created_at.asc&limit=${limit}`)) || [];
    },
    async deleteRow(id) {
      await call('DELETE', `/rest/v1/mailbox?id=eq.${q(id)}`, { headers: { prefer: 'return=minimal' } });
    },
    // `row`: { id, kind, key_version, iv, body }. An id that is already there means an earlier
    // attempt got through before the answer was lost: that is success, not an error.
    async insertUp(row) {
      try {
        await call('POST', '/rest/v1/mailbox', { body: { ...row, dir: 'up' }, headers: { prefer: 'return=minimal' } });
      } catch (e) {
        if (e.kind !== 'conflict') throw e;
      }
    },
    async getBlob(path) {
      return call('GET', `/storage/v1/object/relay/${objectPath(path)}`, { as: 'bytes' });
    },
    // No upsert: the bucket has no update policy. A 409 means an earlier attempt already stored it.
    async putBlob(path, bytes) {
      try {
        await call('POST', `/storage/v1/object/relay/${objectPath(path)}`, { body: bytes, raw: true, headers: { 'content-type': 'application/octet-stream', 'cache-control': 'no-store', 'x-upsert': 'false' } });
      } catch (e) {
        if (e.kind !== 'conflict') throw e;
      }
    },
    async deleteBlobs(paths) {
      if (paths.length) await call('DELETE', '/storage/v1/object/relay', { body: { prefixes: paths } });
    },
  };
}
