// Headless Chromium for the dev scripts. Uses Playwright's own download if there is one, else the
// headless shell under ~/Library/Caches/ms-playwright (CHROME=<path> overrides both).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';

function findShell() {
  if (process.env.CHROME) return process.env.CHROME;
  const base = path.join(os.homedir(), 'Library/Caches/ms-playwright');
  const dirs = fs.existsSync(base) ? fs.readdirSync(base).filter((d) => d.startsWith('chromium_headless_shell-')).sort().reverse() : [];
  for (const d of dirs) {
    for (const arch of ['chrome-headless-shell-mac-arm64', 'chrome-headless-shell-mac-x64', 'chrome-headless-shell-linux64']) {
      const p = path.join(base, d, arch, 'chrome-headless-shell');
      if (fs.existsSync(p)) return p;
    }
  }
  return undefined;
}

export const executablePath = findShell();
export const launch = (opts = {}) => chromium.launch({ executablePath, ...opts });
export const launchPersistent = (dir, opts = {}) => chromium.launchPersistentContext(dir, { executablePath, ...opts });
export { chromium };
