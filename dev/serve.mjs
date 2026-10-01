// Local stand-in for Supabase + GitHub Pages, for testing before the real accounts exist.
//
//   fake    the suite's own fake mailbox (project_management_suite/test/relay_fake_mailbox.js):
//           GoTrue password/refresh, PostgREST with relay.sql's RLS rules, Storage list/delete
//   api     a proxy in front of it on another port, as Supabase is another origin for the app:
//           adds CORS, plus what the phone needs that the fake leaves out:
//             GET  /auth/v1/authorize?provider=github…   a stand-in for GitHub: redirects straight
//                  back with ?code= (signs in as the `github` account, see setGitHubUser)
//             POST /auth/v1/token?grant_type=pkce        checks the code_verifier, returns a session
//             GET/POST /storage/v1/object/relay/<path>   blob download / upload (no upsert)
//   app     this folder as static files, with /config.js pointing at `api`
//
// Never touches the live suite on :4777. Ports are picked by the OS.
//
//   node dev/serve.mjs            prints the URLs; Ctrl-C stops it
//   import { startDev } from './serve.mjs'   (dev/e2e.mjs)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SUITE = process.env.PMS_SUITE || path.join(ROOT, '..', 'project_management_suite');

export const USERS = {
  mac: { email: 'mac@relay.test', password: 'mac-pw', role: 'mac' },
  phone: { email: 'tine@relay.test', password: 'phone-pw', role: 'phone', login: 'tine' },
  stranger: { email: 'stranger@relay.test', password: 'x-pw', role: null, login: 'someone-else' },
};

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml', '.txt': 'text/plain' };
const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const BLOB_PATH = /^([0-9a-f-]{36})\/[0-9a-f-]{36}\.bin$/i;

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
const readAll = async (req) => { const parts = []; for await (const c of req) parts.push(c); return Buffer.concat(parts); };

export async function startDev({ log = () => {} } = {}) {
  const { startFakeMailbox } = await import(pathToFileURL(path.join(SUITE, 'test', 'relay_fake_mailbox.js')).href);
  // A stranger has a login but no relay_members row: the fake gives role null, so RLS shows nothing.
  const fake = await startFakeMailbox({ users: Object.values(USERS) });
  const sessions = new Map(); // access token → account (only tokens issued through this proxy)
  const codes = new Map();    // auth code → { challenge, account, redirect }
  let github = USERS.phone;   // who "GitHub" signs in as
  let appOrigin = null;

  const cors = (res) => {
    res.setHeader('access-control-allow-origin', appOrigin || '*');
    res.setHeader('access-control-allow-headers', 'apikey, authorization, content-type, prefer, x-upsert, x-client-info, cache-control');
    res.setHeader('access-control-allow-methods', 'GET, POST, PATCH, DELETE, OPTIONS');
    res.setHeader('access-control-expose-headers', 'content-range');
    res.setHeader('vary', 'origin');
  };
  const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };

  async function forward(req, res, body, pathOverride) {
    const headers = { ...req.headers };
    delete headers.host; delete headers.origin; delete headers['content-length'];
    const r = await fetch(fake.url + (pathOverride || req.url), { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body });
    const buf = Buffer.from(await r.arrayBuffer());
    return { status: r.status, type: r.headers.get('content-type') || 'application/json', buf };
  }

  // A session from the fake's own password grant, so its tokens work on every fake route.
  async function sessionFor(account) {
    const r = await fetch(`${fake.url}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: fake.anonKey, 'content-type': 'application/json' }, body: JSON.stringify({ email: account.email, password: account.password }) });
    const j = await r.json();
    if (!j.access_token) throw new Error(`fake sign-in failed for ${account.email}`);
    j.user = { ...j.user, user_metadata: { user_name: account.login || account.email } };
    sessions.set(j.access_token, account);
    return j;
  }
  const accountOf = (req) => sessions.get((req.headers.authorization || '').replace(/^Bearer /, '')) || null;

  const api = http.createServer(async (req, res) => {
    cors(res);
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    try {
      if (fake.mode === 'down') return req.socket.destroy();
      if (p === '/auth/v1/authorize') {
        const redirect = url.searchParams.get('redirect_to') || '';
        if (url.searchParams.get('provider') !== 'github') return json(res, 400, { error: 'only github is enabled' });
        if (!appOrigin || !redirect.startsWith(appOrigin)) return json(res, 400, { error: 'redirect_to is not in the allowlist' });
        if (url.searchParams.get('code_challenge_method') !== 's256' || !url.searchParams.get('code_challenge')) return json(res, 400, { error: 'PKCE required' });
        if (github === 'deny') {
          res.writeHead(302, { location: `${redirect}?error=access_denied&error_description=${encodeURIComponent('The user denied the request')}` });
          return res.end();
        }
        const code = crypto.randomUUID();
        codes.set(code, { challenge: url.searchParams.get('code_challenge'), account: github, redirect });
        res.writeHead(302, { location: `${redirect}?code=${code}` });
        return res.end();
      }
      const body = await readAll(req);
      if (p === '/auth/v1/token' && url.searchParams.get('grant_type') === 'pkce') {
        const b = JSON.parse(body.toString() || '{}');
        const c = codes.get(b.auth_code);
        codes.delete(b.auth_code);
        if (!c) return json(res, 400, { error: 'invalid_grant', error_description: 'Invalid or used auth code' });
        if (b64url(crypto.createHash('sha256').update(b.code_verifier || '').digest()) !== c.challenge) return json(res, 400, { error: 'invalid_grant', error_description: 'code challenge does not match previously saved code verifier' });
        return json(res, 200, await sessionFor(c.account));
      }
      if (p === '/auth/v1/logout') { sessions.delete((req.headers.authorization || '').replace(/^Bearer /, '')); res.writeHead(204); return res.end(); }
      const obj = p.match(/^\/storage\/v1\/object\/relay\/(.+)$/);
      if (obj && (req.method === 'GET' || req.method === 'POST')) {
        if (fake.mode === 'paused') return json(res, 540, { message: 'Project paused' });
        const acc = accountOf(req);
        if (!acc) return json(res, 400, { statusCode: '403', error: 'Unauthorized', message: 'invalid JWT' });
        if (!acc.role) return json(res, 400, { statusCode: '404', error: 'not_found', message: 'Object not found' }); // RLS: not a member
        const name = decodeURIComponent(obj[1]);
        if (req.method === 'GET') {
          if (!fake.blobs.has(name)) return json(res, 400, { statusCode: '404', error: 'not_found', message: 'Object not found' });
          res.writeHead(200, { 'content-type': 'application/octet-stream' });
          return res.end(fake.blobs.get(name));
        }
        const uid = fake.accounts.find((a) => a.email === acc.email)?.uid;
        const m = name.match(BLOB_PATH);
        if (!m || m[1] !== uid) return json(res, 400, { statusCode: '403', error: 'Unauthorized', message: 'new row violates row-level security policy' });
        if (fake.blobs.has(name)) return json(res, 400, { statusCode: '409', error: 'Duplicate', message: 'The resource already exists' });
        if (body.length > 5 * 1024 * 1024) return json(res, 400, { statusCode: '413', error: 'Payload too large', message: 'The object exceeded the maximum allowed size' });
        fake.blobs.set(name, body);
        return json(res, 200, { Key: `relay/${name}` });
      }
      // Signed in but not in relay_members: real PostgREST answers with RLS (empty reads, refused
      // writes). The fake only knows member roles and would say 401, so answer here.
      const acc = accountOf(req);
      if (acc && !acc.role && p.startsWith('/rest/v1/')) {
        return req.method === 'GET' ? json(res, 200, []) : json(res, 403, { code: '42501', message: 'new row violates row-level security policy' });
      }
      const r = await forward(req, res, body);
      if (p === '/auth/v1/token' && r.status === 200) {
        const j = JSON.parse(r.buf.toString());
        const acc = fake.accounts.find((a) => a.uid === j.user?.id);
        if (acc) sessions.set(j.access_token, acc);
      }
      res.writeHead(r.status, { 'content-type': r.type });
      res.end(r.buf);
    } catch (e) {
      log('api error', e);
      if (!res.headersSent) json(res, 500, { message: e.message });
    }
  });
  const apiUrl = await listen(api);

  const app = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    let rel = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
    if (rel === 'config.js') {
      res.writeHead(200, { 'content-type': TYPES['.js'], 'cache-control': 'no-store' });
      return res.end(`// dev/serve.mjs: the local fake mailbox\nexport const CONFIG = { supabaseUrl: ${JSON.stringify(apiUrl)}, anonKey: ${JSON.stringify(fake.anonKey)} };\n`);
    }
    const file = path.join(ROOT, rel);
    if (!file.startsWith(ROOT + path.sep) || /(^|\/)(\.|node_modules|dev\/)/.test(rel)) { res.writeHead(404); return res.end('Not found'); }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); return res.end('Not found'); }
      res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
      res.end(data);
    });
  });
  const appUrl = await listen(app);
  appOrigin = appUrl;

  return {
    fake, appUrl: appUrl + '/', apiUrl, anonKey: fake.anonKey,
    setGitHubUser(who) { github = who === 'deny' ? 'deny' : USERS[who]; },
    async close() {
      api.closeAllConnections?.(); app.closeAllConnections?.();
      await Promise.all([new Promise((r) => api.close(r)), new Promise((r) => app.close(r)), fake.close()]);
    },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dev = await startDev({ log: console.error });
  console.log(JSON.stringify({ app: dev.appUrl, api: dev.apiUrl, fake: dev.fake.url, anonKey: dev.anonKey, mac: USERS.mac }, null, 2));
  console.log(`\nOpen ${dev.appUrl} . For the Mac side, run the suite's scripts/relay.mjs setup against ${dev.fake.url} (see README, "Testing locally").`);
  process.on('SIGINT', () => dev.close().then(() => process.exit(0)));
  process.on('SIGTERM', () => dev.close().then(() => process.exit(0)));
}
