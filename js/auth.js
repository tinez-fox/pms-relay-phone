// Sign-in with Supabase Auth (GoTrue), GitHub only (Q3), PKCE flow. Plain fetch, no supabase-js:
// the same calls supabase-js makes, and nothing else.
//
//   1. signInWithGitHub(): keep a random code_verifier in IndexedDB, go to
//      <supabase>/auth/v1/authorize?provider=github&redirect_to=<this page>&code_challenge=…&code_challenge_method=s256
//      in the same window (so it works from the home-screen app, not only in the browser).
//   2. GitHub → Supabase → back to this page with ?code=…  (or ?error=…).
//   3. finishRedirect(): POST /auth/v1/token?grant_type=pkce {auth_code, code_verifier} → session.
//   4. accessToken(): the session's token, refreshed (grant_type=refresh_token) a minute before it
//      expires. Refresh tokens rotate, so one refresh runs at a time and its result is saved at once.
//
// The session ({ access, refresh, expiresAt, user: { id, email, name } }) lives in IndexedDB.
import { kv } from './store.js';

export class AuthError extends Error {
  constructor(message) { super(message); this.name = 'AuthError'; }
}

const te = new TextEncoder();
const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// The page Supabase sends the user back to: this app's own URL without query or hash. It has to be
// in the Supabase project's redirect allowlist (setup step 2).
export const redirectTo = () => location.origin + location.pathname;

export function createAuth({ url, anonKey, fetchImpl = (...a) => fetch(...a) }) {
  const base = url.replace(/\/$/, '');
  let refreshing = null;

  async function token(grant, body) {
    let res, json = null;
    try {
      res = await fetchImpl(`${base}/auth/v1/token?grant_type=${grant}`, { method: 'POST', headers: { apikey: anonKey, 'content-type': 'application/json' }, body: JSON.stringify(body) });
      json = await res.json().catch(() => null);
    } catch (e) {
      throw Object.assign(new Error(`Supabase not reachable: ${e.message}`), { kind: 'network' });
    }
    if (!res.ok || !json?.access_token) {
      const msg = json?.error_description || json?.msg || json?.message || json?.error || `HTTP ${res.status}`;
      if (res.status >= 500) throw Object.assign(new Error(`Supabase: ${msg}`), { kind: 'network' });
      throw new AuthError(msg);
    }
    const meta = json.user?.user_metadata || {};
    const session = {
      access: json.access_token, refresh: json.refresh_token,
      expiresAt: Date.now() + (json.expires_in || 3600) * 1000,
      user: { id: json.user?.id || null, email: json.user?.email || '', name: meta.user_name || meta.preferred_username || meta.name || json.user?.email || '' },
    };
    await kv.set('session', session);
    return session;
  }

  return {
    async session() { return (await kv.get('session')) || null; },

    async signInWithGitHub() {
      const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)));
      const challenge = b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', te.encode(verifier))));
      await kv.set('pkce', { verifier, at: Date.now() });
      const q = new URLSearchParams({ provider: 'github', redirect_to: redirectTo(), code_challenge: challenge, code_challenge_method: 's256' });
      location.assign(`${base}/auth/v1/authorize?${q}`);
    },

    // Call once at start-up. Returns null when this page load is not a sign-in redirect, the new
    // session when it is, and throws AuthError when Supabase or GitHub said no.
    async finishRedirect() {
      const q = new URLSearchParams(location.search);
      const h = new URLSearchParams(location.hash.replace(/^#/, ''));
      const err = q.get('error_description') || q.get('error') || h.get('error_description') || h.get('error');
      const code = q.get('code');
      if (!err && !code) return null;
      history.replaceState(null, '', redirectTo()); // a reload must not reuse the code
      if (err) throw new AuthError(err.replace(/\+/g, ' '));
      const pkce = await kv.get('pkce');
      await kv.del('pkce');
      if (!pkce || Date.now() - pkce.at > 15 * 60000) throw new AuthError('The sign-in took too long or started somewhere else. Try again.');
      return token('pkce', { auth_code: code, code_verifier: pkce.verifier });
    },

    // A valid access token. `force` refreshes even if the current one looks fine (after a 401).
    async accessToken({ force = false } = {}) {
      const s = await kv.get('session');
      if (!s) throw new AuthError('Not signed in');
      if (!force && Date.now() < s.expiresAt - 60000) return s.access;
      if (!refreshing) {
        refreshing = token('refresh_token', { refresh_token: s.refresh }).finally(() => { refreshing = null; });
      }
      return (await refreshing).access;
    },

    async signOut() {
      const s = await kv.get('session');
      await kv.del('session');
      if (s) fetchImpl(`${base}/auth/v1/logout`, { method: 'POST', headers: { apikey: anonKey, authorization: `Bearer ${s.access}` } }).catch(() => {});
    },
  };
}
