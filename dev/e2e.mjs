// End-to-end check against the local fake mailbox, with the real suite as the Mac:
//
//   fake Supabase + this app          dev/serve.mjs (in-process)
//   the Mac                           the suite's server.js on a free port, throwaway data dir,
//                                     relay set up with scripts/relay.mjs against the fake,
//                                     PMS_CLAUDE_BIN = a stub: no agent ever runs. It fails like
//                                     /usr/bin/false, except for a marked worker run and its
//                                     --resume follow-ups (they need a session id) and the R6 run
//                                     started from the phone (it ends with a markdown report), and
//                                     it logs each run's arguments
//   the phone                         headless Chromium, 390×844 touch, a persistent profile so
//                                     "relaunch" keeps IndexedDB and the service worker
//
// Never touches :4777 or the real data/. Screenshots and a log go to the folder given (default
// .dev/e2e/). Exits 1 on the first failed check.
//
//   node dev/e2e.mjs [outDir]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startDev, SUITE, USERS } from './serve.mjs';
import { launch, launchPersistent } from './browser.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.resolve(process.argv[2] || path.join(ROOT, '.dev', 'e2e'));
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pms-relay-e2e-'));
const DATA = path.join(TMP, 'data');
const KEYCHAIN = path.join(TMP, 'keychain.json');
const rc = await import(pathToFileURL(path.join(ROOT, 'js/relay_crypto.js')).href);

const t0 = Date.now();
const logLines = [];
const log = (...a) => { const l = `[${((Date.now() - t0) / 1000).toFixed(1)}s] ${a.join(' ')}`; console.log(l); logLines.push(l); };
let failures = 0;
const check = (name, pass, detail = '') => { log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); if (!pass) { failures++; throw new Error(`check failed: ${name}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(what, fn, { timeout = 30000, every = 250 } = {}) {
  const start = Date.now();
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return { value: v, ms: Date.now() - start };
    if (Date.now() - start > timeout) throw new Error(`timed out after ${timeout} ms waiting for: ${what}`);
    await sleep(every);
  }
}
const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const cli = (args, input) => new Promise((resolve) => {
  const p = execFile(process.execPath, [path.join(SUITE, 'scripts', 'relay.mjs'), ...args], { cwd: SUITE, env: { ...process.env, PMS_DATA_DIR: DATA, PMS_RELAY_KEYCHAIN_FILE: KEYCHAIN }, timeout: 60000 }, (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr }));
  p.stdin.end(input);
});

let dev, suite, browser, ctx;
async function cleanup() {
  await ctx?.close().catch(() => {});
  await browser?.close().catch(() => {});
  if (suite && suite.exitCode === null) { suite.kill('SIGTERM'); await sleep(300); }
  await dev?.close().catch(() => {});
}

try {
  // ---------- fake Supabase + app ----------
  dev = await startDev({ log });
  log(`app ${dev.appUrl}  api ${dev.apiUrl}  fake ${dev.fake.url}  scratch ${TMP}`);

  // ---------- the Mac: relay setup + scratch suite ----------
  const setup = await cli(['setup', '--url', dev.fake.url, '--anon-key', dev.anonKey, '--email', USERS.mac.email, '--yes'], `${USERS.mac.password}\n`);
  check('relay.mjs setup against the fake', setup.code === 0, setup.stderr.trim());
  const PASS = setup.stdout.match(/\n {4}(.+)\n/)[1];
  check('a generated 4-word passphrase', PASS.split(' ').length === 4);
  const master = Buffer.from(JSON.parse(fs.readFileSync(KEYCHAIN, 'utf8')).key, 'hex'); // the test keychain file
  const macKeys = await rc.importKeys(new Uint8Array(master));
  const keyVersion = dev.fake.meta.key_version;

  // R6: what the phone-started run "reports" (the stub prints it as its result). Markdown that an
  // agent would write, plus HTML that must stay text on the phone.
  const R6_REPORT = [
    '## Done', '', 'Moved the **CTA** above the fold in portrait and checked a real build at `390×844`.', '',
    '- Changed `assets/scripts/end_card.ts`', '  - one anchor, no new files', '- Build verified in both orientations', '',
    '| check | result |', '|---|---|', '| portrait | ok |', '| landscape | ok |', '',
    '```', 'npm test  # 12/12', '```', '', 'Raw HTML stays text: <img src=x onerror="window.__xss=1"> <script>window.__xss=2</script>',
  ].join('\n');
  const ARGS = path.join(TMP, 'run-args');
  fs.mkdirSync(ARGS);
  const STUB = path.join(TMP, 'claude-stub');
  fs.writeFileSync(STUB, `#!${process.execPath}
const a = process.argv.slice(2);
require('fs').writeFileSync(require('path').join(${JSON.stringify(ARGS)}, process.env.PMS_RUN_ID + '.json'), JSON.stringify(a));
const r6 = a.join(' ').includes('R6-PHONE');
if (!a.includes('--resume') && !a.join(' ').includes('R4-WORKER') && !r6) process.exit(1);
console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'stub-session' }));
console.log(JSON.stringify({ type: 'result', result: r6 ? ${JSON.stringify(R6_REPORT)} : 'Stub run: did nothing.', session_id: 'stub-session' }));
`, { mode: 0o755 });
  const runArgs = (runId) => { try { return JSON.parse(fs.readFileSync(path.join(ARGS, `${runId}.json`), 'utf8')); } catch { return null; } };

  const PORT = await freePort();
  suite = spawn(process.execPath, ['server.js'], {
    cwd: SUITE,
    env: { ...process.env, PORT: String(PORT), PMS_DATA_DIR: DATA, PMS_RELAY_KEYCHAIN_FILE: KEYCHAIN, PMS_CLAUDE_BIN: STUB, PMS_INBOX_SUMMARIES: '0', PMS_CAPTIONS: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const suiteLog = fs.createWriteStream(path.join(OUT, 'suite.log'));
  suite.stdout.pipe(suiteLog); suite.stderr.pipe(suiteLog);
  log(`scratch suite pid ${suite.pid} on :${PORT}`);
  const MAC = `http://127.0.0.1:${PORT}/api`;
  await until('the scratch suite answers', async () => (await fetch(`${MAC}/state`)).ok, { timeout: 20000 });
  const api = async (method, p, body) => {
    const r = await fetch(MAC + p, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    const j = await r.json().catch(() => null);
    if (!r.ok) throw new Error(`${method} ${p}: ${r.status} ${JSON.stringify(j)}`);
    return j;
  };
  const macTask = async (id) => (await api('GET', '/state')).tasks.find((t) => t.id === id);

  // ---------- images for the cards ----------
  const art = await launch();
  const artPage = await art.newPage();
  async function png(file, w, h, html) {
    await artPage.setViewportSize({ width: w, height: h });
    await artPage.setContent(`<html><body style="margin:0;font:600 ${Math.round(h / 9)}px system-ui">${html}</body></html>`);
    await artPage.screenshot({ path: file });
    return file;
  }
  const scene = (sky, sand, hat, label) => `<div style="position:relative;width:100%;height:100vh;background:linear-gradient(${sky},#fff 70%);overflow:hidden">
    <div style="position:absolute;left:0;right:0;bottom:0;height:34%;background:${sand}"></div>
    <div style="position:absolute;left:38%;bottom:22%;width:24%;height:40%;border-radius:45% 45% 30% 30%;background:#f4c27a"></div>
    <div style="position:absolute;left:33%;bottom:58%;width:34%;height:12%;border-radius:50% 50% 10% 10%;background:${hat}"></div>
    <div style="position:absolute;left:6%;top:6%;color:#123">${label}</div></div>`;
  const opt = [
    await png(path.join(TMP, 'opt-a.png'), 800, 600, scene('#8fd3ff', '#f2d49b', '#d03b3b', 'A · red cap')),
    await png(path.join(TMP, 'opt-b.png'), 800, 600, scene('#8fd3ff', '#f2d49b', '#2a78d6', 'B · blue sun hat')),
    await png(path.join(TMP, 'opt-c.png'), 800, 600, scene('#8fd3ff', '#f2d49b', '#1baf7a', 'C · green bandana')),
  ];
  const shots = [
    await png(path.join(TMP, 'shot-1.png'), 1280, 720, scene('#ffb36b', '#e9c27c', '#2a78d6', 'Level 3 · start')),
    await png(path.join(TMP, 'shot-2.png'), 1280, 720, scene('#6bb8ff', '#e9c27c', '#2a78d6', 'Wave 2')),
    await png(path.join(TMP, 'shot-3.png'), 1280, 720, scene('#3a4a8a', '#c9a76a', '#2a78d6', 'Night shift')),
    await png(path.join(TMP, 'shot-4.png'), 1280, 720, scene('#9be3c8', '#e9c27c', '#2a78d6', 'Results card')),
    await png(path.join(TMP, 'shot-5.png'), 2560, 1440, scene('#ffd27a', '#e9c27c', '#d03b3b', 'Boss intro (2560 px)')),
    await png(path.join(TMP, 'shot-6.png'), 720, 1280, scene('#b9a6ff', '#e9c27c', '#2a78d6', 'Portrait')),
  ];
  const bigPhoto = await png(path.join(TMP, 'phone-photo.png'), 3000, 2000, scene('#ddd', '#bbb', '#d03b3b', 'Phone photo 3000×2000'));
  const tallPhoto = await png(path.join(TMP, 'phone-photo-2.png'), 1200, 2400, scene('#cde', '#bbb', '#1baf7a', 'Photo 2'));
  await art.close();

  // ---------- cards made on the Mac ----------
  const projDir = path.join(TMP, 'bubbu_beach');
  fs.mkdirSync(projDir);
  const proj = (await api('POST', '/projects', { path: projDir, name: 'bubbu_survivor' })).added[0];
  const task = (title) => api('POST', '/tasks', { projectId: proj.id, title });
  const tDecision = await task('Beach level: player hat');
  await api('POST', `/tasks/${tDecision.id}/ask`, {
    type: 'decision', title: 'Which hat for the beach level?', recommend: 'B',
    problem: 'The beach level needs a hat that reads at phone size against bright sand.',
    did: 'Made three mockups on the level 3 background.',
    options: [
      { label: 'Red cap', detail: 'Matches the logo; low contrast on the sunset sky.', image: opt[0] },
      { label: 'Blue sun hat', detail: 'Reads best on sand and sky. Needs a new sprite.', image: opt[1] },
      { label: 'Green bandana', detail: 'Cheapest: recolour of the jungle bandana.', image: opt[2] },
    ],
  });
  const tCheck = await task('Beach level: art pass');
  await api('POST', `/tasks/${tCheck.id}/ask`, {
    type: 'check', title: 'Beach level art pass: look at the build', did: 'New sky, sand and hat in level 3, checked in a real build at 390×844.',
    images: shots.map((p, i) => ({ path: p, caption: ['Start of level 3', 'Wave 2 at noon', 'Night shift palette', 'Results card', 'Boss intro', 'Portrait layout'][i] })),
  });
  // A check card after a real worker run, so Send back resumes that run's session (followUp).
  const tCheck2 = await api('POST', '/tasks', { projectId: proj.id, title: 'Beach level: shop icons', notes: 'R4-WORKER' });
  await api('POST', `/tasks/${tCheck2.id}/delegate`, { agent: '', mode: 'auto' });
  const worker = (await until('the worker run ends with a session', async () => (await api('GET', '/state')).runs.find((r) => r.taskId === tCheck2.id && !r.kind && r.status === 'succeeded' && r.sessionId), { timeout: 20000 })).value;
  await api('POST', `/tasks/${tCheck2.id}/ask`, { type: 'check', title: 'Shop icons for the beach set', did: 'Six icons, exported at 2x.', images: [{ path: shots[3], caption: 'Shop grid' }] });
  const inboxAsk = await api('POST', '/inbox', { title: 'Release the beach update today?', why: 'Build 1.4.2 passed the smoke test. The store listing is ready.', options: ['Ship it today', 'Wait for Monday'], from: 'project-manager' });

  // ---------- R4: the Mac's down images ----------
  // The real Mac loop makes a phone copy of each card image (JPEG, ≤ 1600 px), encrypts it and
  // uploads it to relay/<mac uid>/<uuid>.bin before the card row. 3 mockups + 6 + 1 screenshots.
  const cardRows = (await until('the Mac pushes the cards and their 10 images', async () => {
    const rows = dev.fake.rows.filter((r) => r.dir === 'down' && r.kind === 'card');
    return rows.length >= 4 && dev.fake.blobs.size >= 10 && rows;
  }, { timeout: 30000 })).value;
  const macUid = dev.fake.user('mac').uid;
  const ciphertextOnly = dev.fake.rows.every((r) => !/Which hat for the beach|Beach level art pass|Release the beach update/.test(Buffer.from(r.body, 'base64').toString('latin1')) && Object.keys(r).every((k) => ['id', 'dir', 'kind', 'ref', 'key_version', 'iv', 'body', 'created_at', 'seq', 'expires_at'].includes(k)));
  check('the mailbox holds only ciphertext and routing columns', ciphertextOnly, `${dev.fake.rows.length} rows`);
  const blobsUp = [...dev.fake.blobs.entries()];
  check('the Mac put the 10 card images in the bucket, encrypted, in its own folder', blobsUp.length === 10 && blobsUp.every(([n, b]) => n.startsWith(macUid + '/') && n.endsWith('.bin') && b[0] !== 0x89 && !(b[0] === 0xff && b[1] === 0xd8)), `${blobsUp.length} blobs`);
  const checkRow = await Promise.all(cardRows.map((r) => rc.decryptRow(macKeys, r))).then((vs) => vs.find((v) => v.taskId === tCheck.id));
  const sizes = [];
  for (const x of checkRow.images) { const j = await rc.decryptBlob(macKeys, x.path, dev.fake.blobs.get(x.path)); const d = jpegSize(j); sizes.push(`${d.w}×${d.h}`); if (d.w !== x.w || d.h !== x.h || !(j[0] === 0xff && j[1] === 0xd8)) throw new Error(`image ${x.path} is not the ${x.w}×${x.h} JPEG the card says`); }
  check('the check card names 6 JPEG copies in order, the 2560 px one shrunk to 1600', checkRow.images.length === 6 && checkRow.images[4].w === 1600 && checkRow.images.map((x) => x.caption).join('|') === 'Start of level 3|Wave 2 at noon|Night shift palette|Results card|Boss intro|Portrait layout', sizes.join(', '));

  // ---------- the phone ----------
  const PROFILE = path.join(TMP, 'phone-profile');
  const phoneOpts = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, serviceWorkers: 'allow', colorScheme: 'light' };
  const open = async () => {
    ctx = await launchPersistent(PROFILE, phoneOpts);
    const page = ctx.pages()[0] || await ctx.newPage();
    page.on('pageerror', (e) => log('PAGEERROR', e.message));
    page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') log(`console.${m.type()}: ${m.text()}`); });
    page.on('dialog', (d) => d.accept());
    return page;
  };
  let page = await open();
  const shot = async (name, opts = {}) => { await sleep(250); await page.screenshot({ path: path.join(OUT, `${name}.png`), ...opts }); log(`shot ${name}.png`); };
  const idb = (store, key) => page.evaluate(([s, k]) => new Promise((res, rej) => {
    const r = indexedDB.open('pms-relay'); r.onerror = () => rej(r.error);
    r.onsuccess = () => { const q = r.result.transaction(s).objectStore(s)[k === undefined ? 'getAll' : 'get'](k); q.onsuccess = () => { res(q.result === undefined ? null : JSON.parse(JSON.stringify(q.result, (kk, vv) => (vv instanceof CryptoKey ? `CryptoKey(${vv.extractable ? 'extractable' : 'non-extractable'})` : vv instanceof Blob ? `Blob(${vv.size})` : vv)))); r.result.close(); }; };
  }), [store, key]);
  const audit = () => page.evaluate(() => {
    const W = document.documentElement.clientWidth;
    const wide = [...document.querySelectorAll('body *')].filter((el) => { const r = el.getBoundingClientRect(); return r.width && (r.right > W + 1 || r.left < -1) && !el.closest('.zoom'); }).map((el) => el.className || el.tagName).slice(0, 5);
    const small = [...document.querySelectorAll('button, a[href], label.btn, textarea, input:not([hidden]), [role=button]')].filter((el) => { const r = el.getBoundingClientRect(); return r.width && r.height && (r.height < 44 || r.width < 44); }).map((el) => `${el.className || el.tagName} ${Math.round(el.getBoundingClientRect().width)}x${Math.round(el.getBoundingClientRect().height)}`).slice(0, 8);
    return { scrollW: document.scrollingElement.scrollWidth, W, wide, small };
  });
  const layoutOk = async (where) => { const a = await audit(); check(`${where}: nothing past the 390 px edge, tap targets ≥ 44 px`, a.scrollW <= a.W && !a.wide.length && !a.small.length, JSON.stringify(a)); };

  // 1. sign-in
  await page.goto(dev.appUrl);
  await page.waitForSelector('[data-act="signin"]');
  await shot('01-sign-in');
  await layoutOk('sign-in');

  // GitHub says no → the reason shows, nothing stored
  dev.setGitHubUser('deny');
  await page.tap('[data-act="signin"]');
  await page.waitForSelector('.gate .err');
  check('a refused GitHub sign-in shows why', /denied/i.test(await page.textContent('.gate .err')));
  dev.setGitHubUser('phone');

  // 2. GitHub (stand-in) → back with ?code= → PKCE exchange → passphrase screen
  await page.tap('[data-act="signin"]');
  await page.waitForSelector('#pass');
  check('the sign-in code is gone from the address bar', !/code=/.test(page.url()), page.url());
  const session = await idb('kv', 'session');
  check('signed in as the phone user', session?.user?.id === dev.fake.user('phone').uid && session.user.name === 'tine');
  await shot('02-passphrase');
  await layoutOk('passphrase');

  // 3. wrong passphrase: refused, nothing stored
  await page.fill('#pass', 'wrong horse battery staple');
  await page.tap('.pass-form button[type=submit]');
  await page.waitForSelector('.gate .err', { timeout: 20000 });
  check('a wrong passphrase is refused', /isn’t the relay passphrase/.test(await page.textContent('.gate .err')));
  check('a wrong passphrase stores no key', (await idb('kv', 'keys')) === null);
  await shot('03-wrong-passphrase');

  // 4. right passphrase, typed the way a phone keyboard does it (capital, trailing space)
  const typed = PASS[0].toUpperCase() + PASS.slice(1) + ' ';
  await page.fill('#pass', typed);
  const unlockAt = Date.now();
  await page.tap('.pass-form button[type=submit]');
  await page.waitForSelector('.tabs', { timeout: 20000 });
  log(`unlock (PBKDF2 600k on desktop Chromium) ${Date.now() - unlockAt} ms`);
  const keys = await idb('kv', 'keys');
  check('the key is kept as non-extractable CryptoKeys, not the passphrase', keys?.encKey === 'CryptoKey(non-extractable)' && keys.refKey === 'CryptoKey(non-extractable)' && !JSON.stringify(await idb('kv')).includes(PASS.split(' ')[1]));
  const cardsIn = await until('4 cards with 10 images in the phone Inbox', async () => (await page.$$('.card')).length >= 4 && (await page.$$('.card img')).length >= 10, { timeout: 25000 });
  log(`cards shown ${cardsIn.ms} ms after unlock`);
  check('the cards were delivered: their rows and blobs are gone from the mailbox', await until('mailbox empty of cards', async () => !dev.fake.rows.some((r) => r.dir === 'down' && r.kind === 'card') && dev.fake.blobs.size === 0, { timeout: 10000 }).then(() => true));
  await page.waitForSelector('.conn.good');
  await shot('04-inbox');
  await layoutOk('inbox');

  // 5. the cards with images
  const dec = page.locator(`.card:has(h2:text("Which hat for the beach level?"))`);
  await dec.locator('.opt[data-v="B"] .opt-text').tap();
  check('tapping an option selects it', (await dec.locator('.opt.on').getAttribute('data-v')) === 'B' && !(await page.$('.zoom')));
  await dec.locator('textarea').fill('Blue, but keep the brim small.');
  await dec.locator('textarea').blur();
  await dec.scrollIntoViewIfNeeded();
  await page.evaluate(() => window.scrollBy(0, -70));
  await shot('05-card-decision-images');
  const chk = page.locator(`.card:has(h2:text("Beach level art pass: look at the build"))`);
  await chk.scrollIntoViewIfNeeded();
  await page.evaluate(() => window.scrollBy(0, -70));
  await shot('06-card-check-images');
  await layoutOk('card with images');
  await chk.locator('img').first().tap();
  await page.waitForSelector('.zoom img');
  await shot('07-image-zoom');
  await page.tap('.zoom-x');
  await dec.locator('.opt[data-v="A"] .enlarge').tap();
  await page.waitForSelector('.zoom img');
  check('the enlarge button opens a mockup without changing the pick', (await dec.locator('.opt.on').getAttribute('data-v')) === 'B');
  await page.tap('.zoom-x');

  // 7. a new card while the phone is open, before any command (so the normal 15 s poll, not the fast one): Mac push 2 s + phone poll 15 s
  const tLive = await task('Beach level: music');
  const liveAt = Date.now();
  await api('POST', `/tasks/${tLive.id}/ask`, { type: 'decision', title: 'Which beach music loop?', problem: 'Two loops fit; one is licensed.', options: [{ label: 'Steel drums' }, { label: 'Ukulele (licensed)' }] });
  const live = page.locator(`.card:has(h2:text("Which beach music loop?"))`);
  await until('the new card on the phone', async () => (await live.count()) > 0, { timeout: 25000, every: 100 });
  const liveMs = Date.now() - liveAt;
  check('a card made on the Mac shows on the open phone within about 20 s', liveMs <= 20000, `${(liveMs / 1000).toFixed(1)} s`);

  // card-gone: the agent withdraws the card on the Mac → it leaves the phone
  await api('DELETE', `/tasks/${tLive.id}/ask`);
  await until('the withdrawn card leaves the phone', async () => !(await live.count()), { timeout: 30000 });
  check('a card closed on the Mac leaves the phone (card-gone)', true);

  // 6. pick B → sent → the Mac applies it → the card goes, the outbox says done
  await dec.locator('[data-act="pick"]').tap();
  await page.waitForSelector('.card.is-pending .pending:has-text("waiting for the Mac")', { timeout: 10000 });
  await page.evaluate(() => { document.querySelector('.card.is-pending .pending').scrollIntoView({ block: 'end' }); window.scrollBy(0, 120); });
  await shot('08-sent-waiting-for-mac');
  const picked = await until('the Mac applies the pick', async () => { const t = await macTask(tDecision.id); const a = t.asks.at(-1); return a.answer?.pick === 'B' && a.answer; }, { timeout: 30000 });
  check('picking B on the phone answered the card on the Mac', picked.value.via === 'phone' && picked.value.comment === 'Blue, but keep the brim small.', `${picked.ms} ms`);
  check('the answer is in the ticket notes', /picked B \(Blue sun hat\)/.test((await macTask(tDecision.id)).notes));
  await until('the card leaves the phone', async () => !(await dec.count()), { timeout: 30000 });

  // check card: accept → the ticket moves to done
  await chk.locator('[data-act="accept"]').tap();
  const accepted = await until('the check is accepted on the Mac', async () => (await macTask(tCheck.id)).status === 'done', { timeout: 30000 });
  check('“Looks good” on the phone moved the ticket to done', true, `${accepted.ms} ms`);
  await until('the check card leaves the phone', async () => !(await chk.count()), { timeout: 30000 });

  // suite-ask item: an option answers it
  const ia = page.locator(`.card:has(h2:text("Release the beach update today?"))`);
  await ia.locator('[data-act="inbox-pick"][data-v="Wait for Monday"]').tap();
  const iaDone = await until('the Inbox ask is resolved on the Mac', async () => { const it = await api('GET', `/inbox/${inboxAsk.id}`); return it.status === 'done' && it; }, { timeout: 30000 });
  check('a suite-ask answered from the phone', iaDone.value.reply === 'Wait for Monday', iaDone.value.reply);

  // Send back with 2 photos: the phone downsizes, encrypts and uploads them; the Mac (R4) takes them
  // into the attachment store, resumes the worker's session with them, and deletes the blobs.
  const c2 = page.locator(`.card:has(h2:text("Shop icons for the beach set"))`);
  await c2.locator('input[type=file]').setInputFiles([bigPhoto, tallPhoto]);
  await until('2 photos on the card', async () => (await c2.locator('.photo img').count()) === 2, { timeout: 10000 });
  await c2.locator('textarea').fill('The coin icon is blurry.');
  await c2.locator('textarea').blur();
  await c2.scrollIntoViewIfNeeded();
  await shot('09-send-back-with-photos');
  const blobsBefore = new Set(dev.fake.blobs.keys());
  const phoneUid = dev.fake.user('phone').uid;
  const seenUp = new Map(); // the phone's uploads, caught before the Mac deletes them
  const watch = setInterval(() => { for (const [k, b] of dev.fake.blobs) if (!blobsBefore.has(k) && !seenUp.has(k)) seenUp.set(k, b); }, 20);
  await c2.locator('[data-act="redo"]').tap();
  const sent = await until('the Mac applies the send-back', async () => { const t = await macTask(tCheck2.id); const a = t.asks.at(-1); return a.answer?.pick === 'redo' && a.answer; }, { timeout: 30000 });
  clearInterval(watch);
  check('the photos went up to relay/<phone uid>/<uuid>.bin', seenUp.size === 2 && [...seenUp.keys()].every((k) => k.startsWith(phoneUid + '/') && k.endsWith('.bin')), [...seenUp.keys()].join(', '));
  const dims = await Promise.all([...seenUp].map(async ([k, b]) => jpegSize(await rc.decryptBlob(macKeys, k, b))));
  check('each photo is a JPEG at most 1600 px', dims.every((d) => Math.max(d.w, d.h) === 1600), dims.map((d) => `${d.w}×${d.h}`).join(', '));
  const st = await api('GET', '/state');
  const added = sent.value.attachments || [];
  const lib = added.map((id) => st.attachments.find((a) => a.id === id));
  check('Send back with 2 phone photos: 2 Attachments on the answer, Tine’s, on the task', added.length === 2 && sent.value.via === 'phone' && lib.every((a) => a?.kind === 'image' && a.addedBy === 'tine') && added.every((id) => (st.tasks.find((t) => t.id === tCheck2.id).attachments || []).includes(id)), JSON.stringify(lib.map((a) => a && { name: a.name, kind: a.kind, size: a.size })));
  const follow = st.runs.find((r) => r.parentRunId === worker.id);
  const followArgs = follow && (await until('the follow-up run started', async () => runArgs(follow.id), { timeout: 10000 })).value;
  check('they arrive as attachments on the follow-up run (the worker session resumed with both files)', follow && followArgs.includes('--resume') && lib.every((a) => followArgs.join('\n').includes(a.path)), follow ? `${follow.id} resumes ${worker.id}` : 'no follow-up run');
  await until('the send-back card leaves the phone', async () => !(await c2.count()), { timeout: 30000 });
  const empty = await until('bucket empty after delivery', async () => dev.fake.blobs.size === 0, { timeout: 15000 }).then(() => true, () => false);
  check('after delivery the bucket is empty', empty, `${dev.fake.blobs.size} blobs left`);

  // The failed PM run (PMS_CLAUDE_BIN=/usr/bin/false) arrives as a run-failed card: clear it
  const failedCard = page.locator('.card.k-run-failed').first();
  await until('a run-failed card', async () => (await failedCard.count()) > 0, { timeout: 30000 });
  const failedRunId = (await idb('cards')).find((c) => c.value.type === 'run-failed').value.runId;
  await failedCard.locator('[data-act="clear"]').tap();
  await until('the failed run is acknowledged on the Mac', async () => (await api('GET', '/state')).runs.find((r) => r.id === failedRunId)?.acknowledged, { timeout: 30000 });
  check('Clear on a failed-run card acknowledges the run on the Mac', true);

  // 8. offline: the pick waits in the outbox, goes when the connection is back
  const tOff = await task('Beach level: boss');
  await api('POST', `/tasks/${tOff.id}/ask`, { type: 'decision', title: 'Boss for the beach level?', problem: 'The crab boss is half done.', options: [{ label: 'Giant crab' }, { label: 'Seagull swarm' }] });
  const off = page.locator(`.card:has(h2:text("Boss for the beach level?"))`);
  await until('the boss card', async () => (await off.count()) > 0, { timeout: 25000 });
  await ctx.setOffline(true);
  await off.locator('.opt[data-v="A"]').tap();
  await off.locator('[data-act="pick"]').tap();
  await page.goto(dev.appUrl + '#/outbox');
  await page.waitForSelector('.pill.warn:has-text("Waiting to send")');
  await page.evaluate(() => window.scrollTo(0, 0));
  await shot('10-outbox-offline-queued');
  await ctx.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  const offDone = await until('the queued pick reaches the Mac', async () => (await macTask(tOff.id)).asks.at(-1).answer?.pick === 'A', { timeout: 40000 });
  check('a pick made offline is sent when the connection is back', true, `${offDone.ms} ms`);
  await page.waitForSelector('.cmd .pill.good:has-text("Done") >> nth=0');
  await until('outbox shows the boss pick done', async () => (await page.locator('.cmd:has-text("Boss for the beach level?") .pill.good').count()) > 0, { timeout: 30000 });
  await page.evaluate(() => window.scrollTo(0, 0));
  await shot('11-outbox-status');
  await layoutOk('outbox');
  const states = (await idb('outbox')).map((c) => `${c.kind}:${c.state}`).sort();
  log('outbox: ' + states.join(', '));

  // 9. an expired access token is refreshed without asking
  await page.evaluate(() => new Promise((res) => { const r = indexedDB.open('pms-relay'); r.onsuccess = () => { const s = r.result.transaction('kv', 'readwrite').objectStore('kv'); const g = s.get('session'); g.onsuccess = () => { s.put({ ...g.result, expiresAt: Date.now() - 1000 }, 'session'); }; s.transaction.oncomplete = () => { r.result.close(); res(); }; }; }));
  const oldAccess = (await idb('kv', 'session')).access;
  await page.tap('.conn');
  await until('a refreshed session', async () => (await idb('kv', 'session')).access !== oldAccess, { timeout: 10000 });
  check('an expired session is refreshed (refresh_token grant)', (await page.textContent('.top .conn')).includes('Mac seen'));

  // resync: the Mac sends everything again; the phone replaces by cardId, so nothing doubles
  await page.goto(dev.appUrl + '#/inbox');
  await page.waitForSelector('.card');
  const before = (await idb('cards')).map((c) => c.cardId).sort();
  await page.goto(dev.appUrl + '#/outbox');
  await page.tap('[data-act="resync"]');
  await until('the resync result', async () => (await idb('outbox')).some((c) => c.kind === 'resync' && c.state === 'ok'), { timeout: 30000 });
  await until('the resent cards are in', async () => !dev.fake.rows.some((r) => r.dir === 'down' && r.kind === 'card'), { timeout: 20000 });
  const after = (await idb('cards')).map((c) => c.cardId).sort();
  await page.goto(dev.appUrl + '#/inbox');
  const shown = await page.$$eval('.card', (els) => els.map((e) => e.dataset.card));
  check('“Resend everything” brings the cards back, none doubled', before.every((id) => after.includes(id)) && new Set(shown).size === shown.length && shown.length === after.length, `before ${before.join(', ')} · after ${after.join(', ')}`);
  check('after the resend the bucket is empty again', await until('bucket empty', async () => dev.fake.blobs.size === 0, { timeout: 15000 }).then(() => true, () => false), `${dev.fake.blobs.size} blobs`);

  // ---------- R6: new task + delegate from the phone, and its report back ----------
  const ALLOWED = ['project-manager', 'senior-dev', 'art-director', 'game-manager', 'claude'];
  const userAgents = fs.readdirSync(path.join(os.homedir(), '.claude', 'agents')).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3));
  const notAllowed = userAgents.filter((a) => !ALLOWED.includes(a));
  await page.goto(dev.appUrl + '#/new');
  await page.waitForSelector('form.newform', { timeout: 20000 });
  const offered = await page.evaluate(() => ({
    projects: [...document.querySelectorAll('#nf-project option')].map((o) => o.textContent),
    agents: [...document.querySelectorAll('input[name=nf-agent]')].map((x) => x.value),
    modes: [...document.querySelectorAll('.seg[aria-label=mode] button')].map((b) => b.dataset.v),
    models: [...document.querySelectorAll('#nf-model option')].map((o) => o.value),
    efforts: [...document.querySelectorAll('#nf-effort option')].map((o) => o.value),
    budget: !!document.querySelector('[id*=budget], [data-field*=budget]'),
    text: document.body.textContent,
  }));
  log(`New offers ${JSON.stringify({ ...offered, text: undefined })}; agents in ~/.claude/agents not on the allowlist: ${notAllowed.join(', ')}`);
  check('New: the projects come from the directory', offered.projects.includes('bubbu_survivor'));
  check('New: only allowlisted agents that exist for the project are offered', offered.agents.includes('senior-dev') && offered.agents.includes('claude') && offered.agents.every((a) => ALLOWED.includes(a)) && notAllowed.every((a) => !offered.agents.includes(a)), offered.agents.join(', '));
  check('New: modes are auto / plan / acceptEdits only, never bypassPermissions, and no budget field', JSON.stringify(offered.modes) === '["auto","plan","acceptEdits"]' && !/bypass|No checks/i.test(offered.text) && !offered.budget);
  check('New: model and effort pickers carry the directory’s short lists', JSON.stringify(offered.models) === '["","opus","sonnet","haiku"]' && JSON.stringify(offered.efforts) === '["","low","medium","high"]');
  check('New: the hourly phone limit is shown', /At most 10 runs an hour/.test(offered.text));
  await page.fill('#nf-title', 'R6: end card CTA from the phone');
  await page.fill('#nf-notes', 'R6-PHONE The CTA hides behind the banner in portrait. Done = visible in both orientations.');
  await page.tap('.seg[aria-label=priority] button[data-v=high]');
  await page.locator('label.agent:has(input[value="senior-dev"])').tap();
  await page.tap('.seg[aria-label=mode] button[data-v=plan]');
  await page.selectOption('#nf-effort', 'high');
  await page.fill('#nf-extra', 'Look and write a plan; change nothing.');
  await page.locator('#nf-extra').blur();
  check('New: what was typed survives the choices redrawing the form', (await page.inputValue('#nf-title')) === 'R6: end card CTA from the phone' && /R6-PHONE/.test(await page.inputValue('#nf-notes')));
  await page.evaluate(() => window.scrollTo(0, 0));
  await shot('15-new-task');
  await layoutOk('new task');
  await page.locator('.delegate').scrollIntoViewIfNeeded();
  await page.evaluate(() => window.scrollTo(0, document.scrollingElement.scrollHeight));
  await shot('16-new-task-delegate');
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.evaluate(() => window.scrollTo(0, 0));
  await shot('16b-new-task-dark');
  await page.emulateMedia({ colorScheme: 'light' });
  await page.tap('form.newform button[type=submit]');
  await page.waitForSelector('.rep.wait', { timeout: 10000 });
  await shot('17-reports-run-started');
  const made = await until('the Mac creates the phone task and starts its run', async () => {
    const st = await api('GET', '/state');
    const t = st.tasks.find((x) => x.title === 'R6: end card CTA from the phone');
    const r = t && st.runs.find((x) => x.taskId === t.id && !x.kind);
    return r && { t, r };
  }, { timeout: 40000 });
  log(`phone create+delegate → run on the Mac in ${made.ms} ms`);
  const { t: r6Task, r: r6Run } = made.value;
  const r6Args = (await until('the run’s arguments', async () => runArgs(r6Run.id), { timeout: 10000 })).value;
  const argAt = (flag) => { const i = r6Args.indexOf(flag); return i < 0 ? null : r6Args[i + 1]; };
  check('the task came from the phone with its brief and priority', r6Task.source?.kind === 'phone' && /R6-PHONE/.test(r6Task.notes) && r6Task.priority === 'high', JSON.stringify({ source: r6Task.source, priority: r6Task.priority }));
  check('the run started with the chosen agent, mode and effort, tagged via phone', r6Run.via === 'phone' && r6Run.agent === 'senior-dev' && r6Run.mode === 'plan' && r6Run.effort === 'high' && argAt('--agent') === 'senior-dev' && argAt('--permission-mode') === 'plan' && argAt('--effort') === 'high', JSON.stringify({ via: r6Run.via, agent: r6Run.agent, mode: r6Run.mode, effort: r6Run.effort }));
  check('no budget cap on the phone run (no --max-budget-usd)', !r6Args.includes('--max-budget-usd') && r6Args.join(' ').includes('Look and write a plan; change nothing.'));
  const repLink = page.locator(`a.rep[href="#/reports/${r6Run.id}"]`);
  const repIn = await until('the run’s final report on the phone', async () => (await repLink.count()) > 0, { timeout: 45000 });
  log(`report shown on the phone ${repIn.ms} ms after the run started`);
  check('the report was delivered: no report rows left in the mailbox', await until('no report rows', async () => !dev.fake.rows.some((r) => r.dir === 'down' && r.kind === 'report'), { timeout: 20000 }).then(() => true, () => false));
  check('the started-from-phone placeholder gives way to the report', !(await page.locator('.rep.wait:has-text("R6: end card CTA from the phone")').count()));
  await page.evaluate(() => window.scrollTo(0, 0));
  await shot('18-reports');
  await layoutOk('reports');
  await repLink.tap();
  await page.waitForSelector('.report .md h4');
  const md = await page.evaluate(() => ({ h: document.querySelector('.report .md h4')?.textContent, table: document.querySelectorAll('.report .md td').length, nested: document.querySelectorAll('.report .md li li').length, pre: document.querySelector('.report .md pre')?.textContent, img: document.querySelectorAll('.report .md img, .report .md script').length, xss: window.__xss ?? null, text: document.querySelector('.report .md').textContent }));
  check('the report renders as markdown: heading, nested list, table, code', md.h === 'Done' && md.table === 4 && md.nested === 1 && /npm test/.test(md.pre), JSON.stringify({ ...md, text: undefined }));
  check('HTML in a report stays text (sanitised)', md.img === 0 && md.xss === null && md.text.includes('<img src=x onerror='));
  await shot('19-report-detail');
  await layoutOk('report detail');
  check('opening a report marks it read', (await idb('reports', r6Run.id))?.seen === true);
  await page.tap('[data-act="dismiss-report"]');
  await until('the report leaves the phone', async () => !(await idb('reports', r6Run.id)) && !(await repLink.count()), { timeout: 5000 });
  check('Done reading removes a report and remembers it', !!(await idb('kv', 'dismissedReports'))?.[r6Run.id]);

  // Forged commands, made as if a tampered phone sent them (the form never offers these): the Mac refuses each.
  const tForge = await task('R6: target for forged delegations');
  const forgedIds = await page.evaluate(async ([taskId, projectId]) => {
    const s = await import(new URL('js/sync.js', location.href).href);
    const q = async (kind, fields, label) => (await s.queueCommand(kind, fields, { label })).id;
    return {
      notListed: await q('delegate', { taskId, agent: 'store-analyzer', mode: 'auto' }, 'forged: agent not on the allowlist'),
      unknown: await q('delegate', { taskId, agent: 'evil-agent', mode: 'auto' }, 'forged: unknown agent'),
      bypass: await q('delegate', { taskId, agent: 'senior-dev', mode: 'bypassPermissions' }, 'forged: bypassPermissions'),
      newBypass: await q('new-task', { projectId, title: 'R6 forged: must not exist', delegate: { agent: 'senior-dev', mode: 'bypassPermissions' } }, 'forged: new task + bypassPermissions'),
    };
  }, [tForge.id, proj.id]);
  await page.tap('.conn');
  const forged = (await until('the Mac answers the forged commands', async () => { const all = await idb('outbox'); const got = Object.fromEntries(Object.entries(forgedIds).map(([k, id]) => [k, all.find((c) => c.id === id)])); return Object.values(got).every((c) => c && (c.state === 'ok' || c.state === 'error')) && got; }, { timeout: 45000 })).value;
  log('forged: ' + Object.entries(forged).map(([k, c]) => `${k}=${c.state}: ${c.error}`).join(' | '));
  const stF = await api('GET', '/state');
  check('forged: an agent not on the allowlist, an unknown agent and bypassPermissions are refused by the Mac', forged.notListed.state === 'error' && /not allowed from the phone/.test(forged.notListed.error) && forged.unknown.state === 'error' && /not allowed/.test(forged.unknown.error) && forged.bypass.state === 'error' && /bypassPermissions is never allowed/.test(forged.bypass.error) && forged.newBypass.state === 'error' && /never allowed/.test(forged.newBypass.error));
  check('forged: nothing started, no stray task', !stF.runs.some((r) => r.taskId === tForge.id) && !stF.tasks.some((t) => t.title === 'R6 forged: must not exist'));

  // A burst over the rate limit (10 phone runs per rolling hour; the R6 run is the first): 9 more go, the next is refused.
  const burstIds = await page.evaluate(async (projectId) => {
    const s = await import(new URL('js/sync.js', location.href).href);
    const ids = [];
    for (let i = 1; i <= 10; i++) ids.push((await s.queueCommand('new-task', { projectId, title: `R6 burst ${i}`, delegate: { agent: 'senior-dev', mode: 'auto' } }, { label: `burst ${i}` })).id);
    return ids;
  }, proj.id);
  await page.tap('.conn');
  const burst = (await until('the Mac answers the burst', async () => { const all = await idb('outbox'); const got = burstIds.map((id) => all.find((c) => c.id === id)); return got.every((c) => c && (c.state === 'ok' || c.state === 'error')) && got; }, { timeout: 60000 })).value;
  const stB = await api('GET', '/state');
  const phoneRuns = stB.runs.filter((r) => r.via === 'phone').length;
  check('rate limit: 9 more phone runs start, the 11th in the hour is refused', burst.slice(0, 9).every((c) => c.state === 'ok') && burst[9].state === 'error' && /at most 10 an hour/.test(burst[9].error) && phoneRuns === 10 && !stB.tasks.some((t) => t.title === 'R6 burst 10'), `${burst.map((c) => c.state).join(',')} · ${phoneRuns} phone runs · ${burst[9].error}`);
  await page.goto(dev.appUrl + '#/outbox');
  await page.waitForSelector('.cmd .pill.bad');
  await page.evaluate(() => window.scrollTo(0, 0));
  await shot('20-outbox-refused');

  // 10. relaunch from the home screen, offline: the shell comes from the service worker, the cards from IndexedDB
  await page.goto(dev.appUrl + '#/inbox');
  await page.waitForSelector('.card');
  await page.evaluate(() => navigator.serviceWorker.ready);
  const cachedTitles = await page.$$eval('.card h2', (h) => h.map((x) => x.textContent));
  await ctx.close();
  page = await open();
  await ctx.setOffline(true);
  await page.goto(dev.appUrl);
  await page.waitForSelector('.tabs', { timeout: 15000 });
  await page.waitForSelector('.card');
  await page.waitForSelector('.conn.warn', { timeout: 15000 });
  const relaunchTitles = await page.$$eval('.card h2', (h) => h.map((x) => x.textContent));
  check('relaunched offline: no passphrase asked, cached cards shown, marked offline', cachedTitles.length > 0 && cachedTitles.every((t) => relaunchTitles.includes(t)) && /No connection|Can’t reach Supabase/.test(await page.textContent('.conn')), `cached [${cachedTitles.join(' | ')}] relaunch [${relaunchTitles.join(' | ')}] conn "${await page.textContent('.conn')}"`);
  await shot('12-relaunch-offline');
  // back online, with a card made while the phone was closed
  const tWhile = await task('Beach level: palm trees');
  await api('POST', `/tasks/${tWhile.id}/ask`, { type: 'decision', title: 'Palm trees: two or three?', problem: 'Three looks busy at phone size.', options: [{ label: 'Two' }, { label: 'Three' }] });
  await sleep(2500);
  await ctx.setOffline(false);
  await page.reload();
  await page.waitForSelector('.card:has(h2:text("Palm trees: two or three?"))', { timeout: 25000 });
  check('back online after relaunch: the card made meanwhile arrives', true);

  // 11. rekey on the Mac → the phone asks for the new passphrase, refuses the old one
  const rekey = await cli(['rekey', '--yes'], '');
  check('relay.mjs rekey', rekey.code === 0, rekey.stderr.trim());
  const PASS2 = rekey.stdout.match(/\n {4}(.+)\n/)[1];
  await page.reload();
  await page.waitForSelector('#pass', { timeout: 20000 });
  check('after a rekey the phone asks for the new passphrase', (await page.textContent('.gate h1')) === 'New passphrase');
  await shot('13-new-passphrase-after-rekey');
  await page.fill('#pass', PASS);
  await page.tap('.pass-form button[type=submit]');
  await page.waitForSelector('.gate .err', { timeout: 20000 });
  check('the old passphrase is refused after a rekey', /isn’t the relay passphrase/.test(await page.textContent('.gate .err')));
  await page.fill('#pass', PASS2);
  await page.tap('.pass-form button[type=submit]');
  await page.waitForSelector('.tabs', { timeout: 20000 });
  check('the new passphrase unlocks; cached cards stay', (await page.$$('.card')).length > 0);
  await page.emulateMedia({ colorScheme: 'dark' });
  await shot('14-inbox-dark');
  await ctx.close(); ctx = null;

  // 12. a GitHub account that is not a relay member gets nothing to unlock
  dev.setGitHubUser('stranger');
  ctx = await launchPersistent(path.join(TMP, 'stranger-profile'), phoneOpts);
  page = ctx.pages()[0];
  await page.goto(dev.appUrl);
  await page.tap('[data-act="signin"]');
  await page.fill('#pass', PASS2);
  await page.tap('.pass-form button[type=submit]');
  await page.waitForSelector('.gate .err', { timeout: 20000 });
  check('a non-member account is told it is not on the relay', /isn’t on the relay/.test(await page.textContent('.gate .err')));

  log(`all checks passed in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
} catch (e) {
  log('ERROR', e.stack || e.message);
  try { const p = ctx?.pages()[0]; if (p) await p.screenshot({ path: path.join(OUT, 'zz-failure.png') }); } catch { /* closed */ }
  failures = failures || 1;
} finally {
  fs.writeFileSync(path.join(OUT, 'e2e.log'), logLines.join('\n') + '\n');
  await cleanup();
  if (!failures) fs.rmSync(TMP, { recursive: true, force: true });
  else log(`scratch kept for a look: ${TMP}`);
  process.exit(failures ? 1 : 0);
}

// Width and height from a JPEG's SOF marker.
function jpegSize(u) {
  let i = 2;
  while (i < u.length) {
    if (u[i] !== 0xff) { i++; continue; }
    const m = u[i + 1];
    const len = (u[i + 2] << 8) | u[i + 3];
    if (m >= 0xc0 && m <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(m)) return { h: (u[i + 5] << 8) | u[i + 6], w: (u[i + 7] << 8) | u[i + 8] };
    i += 2 + len;
  }
  return { w: 0, h: 0 };
}
