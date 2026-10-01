// Renders icons/icon.svg (the suite's icon) to the PNGs the manifest and iOS want. Run once after
// changing the SVG: node dev/make-icons.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch } from './browser.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const svg = fs.readFileSync(path.join(ROOT, 'icons/icon.svg'), 'utf8');
const browser = await launch();
const page = await browser.newPage();
// iOS draws the apple-touch icon on its own rounded square, and Android crops maskable icons to a
// circle: those two get a full-bleed background with the bars inside the safe zone.
const full = svg.replace('<rect x="100" y="100" width="824" height="824" rx="185"', '<rect x="0" y="0" width="1024" height="1024" rx="0"');
const jobs = [
  ['icon-192.png', 192, svg, 'transparent'],
  ['icon-512.png', 512, svg, 'transparent'],
  ['apple-touch-icon.png', 180, full, '#1c5cab'],
  ['icon-maskable-512.png', 512, full.replace('<svg ', '<svg style="transform:scale(.8)" '), '#2a78d6'],
];
for (const [name, size, src, bg] of jobs) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<html><body style="margin:0;background:${bg}">${src.replace(/width="1024" height="1024"/, `width="${size}" height="${size}"`)}</body></html>`);
  await page.screenshot({ path: path.join(ROOT, 'icons', name), omitBackground: bg === 'transparent' });
  console.log('wrote icons/' + name);
}
await browser.close();
