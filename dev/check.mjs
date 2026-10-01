// Offline checks, no browser: node dev/check.mjs   (--fix rewrites the shell version in sw.js)
//   1. js/relay_crypto.js is byte-identical to the suite's public/relay_crypto.js (the canonical copy)
//   2. it passes the suite's fixed test vector (dev/relay_crypto_vector.js, a copy of the suite's)
//   3. sw.js lists every shell file, and its VERSION was bumped since the shell last changed
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SUITE = process.env.PMS_SUITE || path.join(ROOT, '..', 'project_management_suite');
let failed = 0;
const ok = (name, pass, detail = '') => { console.log(`${pass ? 'ok  ' : 'FAIL'} ${name}${!pass && detail ? ` (${detail})` : ''}`); if (!pass) failed++; };

// 1
const mine = fs.readFileSync(path.join(ROOT, 'js/relay_crypto.js'));
const canon = path.join(SUITE, 'public/relay_crypto.js');
if (fs.existsSync(canon)) {
  ok('relay_crypto.js matches the suite', mine.equals(fs.readFileSync(canon)), 'copy public/relay_crypto.js over js/relay_crypto.js');
  const vec = path.join(SUITE, 'test/relay_crypto_vector.js');
  if (fs.existsSync(vec)) ok('test vector matches the suite', fs.readFileSync(vec).equals(fs.readFileSync(path.join(ROOT, 'dev/relay_crypto_vector.js'))));
} else console.log(`skip relay_crypto.js vs the suite (no ${canon})`);

// 2
const rc = await import(pathToFileURL(path.join(ROOT, 'js/relay_crypto.js')).href);
const { checkVector } = await import(pathToFileURL(path.join(ROOT, 'dev/relay_crypto_vector.js')).href);
for (const r of await checkVector(rc)) ok(`vector: ${r.name}`, r.ok, r.ok ? '' : String(r.got));

// 3
const swFile = path.join(ROOT, 'sw.js');
let sw = fs.readFileSync(swFile, 'utf8');
const list = JSON.parse('[' + sw.match(/const SHELL = \[([\s\S]*?)\];/)[1].replace(/'/g, '"').replace(/,\s*$/, '') + ']');
const want = ['index.html', 'config.js', 'manifest.webmanifest', ...fs.readdirSync(path.join(ROOT, 'js')).map((f) => `js/${f}`), ...fs.readdirSync(path.join(ROOT, 'css')).map((f) => `css/${f}`), 'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png'];
const missing = want.filter((f) => !list.includes(f));
ok('sw.js caches every shell file', !missing.length, missing.join(', '));
const gone = list.filter((f) => f !== './' && !fs.existsSync(path.join(ROOT, f)));
ok('sw.js lists only files that exist', !gone.length, gone.join(', '));
const hash = crypto.createHash('sha256');
for (const f of list.filter((f) => f !== './' && f !== 'config.js').sort()) hash.update(f).update(fs.readFileSync(path.join(ROOT, f)));
const h = hash.digest('hex').slice(0, 12);
const recorded = sw.match(/\/\/ shell: ([0-9a-f]+)/)?.[1];
if (recorded !== h && process.argv.includes('--fix')) {
  const v = sw.match(/const VERSION = 'r5-(\d+)'/);
  sw = sw.replace(/const VERSION = '[^']+';( \/\/ shell: [0-9a-f]+)?/, `const VERSION = 'r5-${v ? Number(v[1]) + 1 : 1}'; // shell: ${h}`);
  fs.writeFileSync(swFile, sw);
  console.log(`fixed sw.js: VERSION bumped, shell ${h}`);
} else ok('sw.js VERSION is current for the shell files', recorded === h, recorded ? `shell changed: run node dev/check.mjs --fix` : 'no shell hash yet: run node dev/check.mjs --fix');

process.exit(failed ? 1 : 0);
