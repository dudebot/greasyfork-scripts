import { test as base, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

export const USERSCRIPT_PATH = path.resolve(
  __dirname,
  '../../PlaylistPlus.user.js',
);

const SCRIPT_SOURCE = fs.readFileSync(USERSCRIPT_PATH, 'utf8');

/**
 * `test` fixture that auto-injects the userscript into every page via
 * addInitScript. Approximates Tampermonkey's document-idle injection —
 * GM_* APIs are absent, so the script falls through to its localStorage backend.
 */
export const test = base.extend<{
  consoleLog: string[];
}>({
  consoleLog: async ({ page }, use) => {
    const logs: string[] = [];
    page.on('console', (msg) => {
      const text = `[${msg.type()}] ${msg.text()}`;
      logs.push(text);
    });
    page.on('pageerror', (err) => {
      logs.push(`[pageerror] ${err.message}`);
    });
    await use(logs);
  },
  page: async ({ page }, use) => {
    await page.addInitScript({ content: `window.__YTPM_TEST__ = true;\n${SCRIPT_SOURCE}` });
    await use(page);
  },
});

export { expect };

/** Wait for `#ytpm-root` and its shadow root to exist. */
export async function waitForBadge(page: import('@playwright/test').Page, timeout = 25_000) {
  await page.locator('#ytpm-root').waitFor({ state: 'attached', timeout });
  await page.waitForFunction(
    () => !!document.getElementById('ytpm-root')?.shadowRoot?.getElementById('badge'),
    null,
    { timeout },
  );
}

/** Read text of an element by id inside the panel shadow root. */
export function shadowText(page: import('@playwright/test').Page, id: string) {
  return page.evaluate(
    (id) =>
      document
        .getElementById('ytpm-root')
        ?.shadowRoot?.getElementById(id)
        ?.textContent?.trim() ?? null,
    id,
  );
}

/** Click an element by id inside the panel shadow root. */
export function shadowClick(page: import('@playwright/test').Page, id: string) {
  return page.evaluate((id) => {
    const el = document.getElementById('ytpm-root')?.shadowRoot?.getElementById(id) as
      | HTMLElement
      | undefined;
    if (!el) throw new Error(`shadow #${id} not found`);
    el.click();
  }, id);
}
