import { test as setup } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const AUTH_FILE = path.resolve('.auth/youtube.json');
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

setup.setTimeout(30 * 60 * 1000);

setup('authenticate to YouTube', async ({ page, context }) => {
  fs.mkdirSync(path.dirname(AUTH_FILE), { recursive: true });

  if (fs.existsSync(AUTH_FILE)) {
    const age = Date.now() - fs.statSync(AUTH_FILE).mtimeMs;
    if (age < MAX_AGE_MS) {
      const mins = Math.round(age / 60_000);
      console.log(`[auth] reusing ${AUTH_FILE} (age ${mins} min). Delete the file to re-auth.`);
      return;
    }
  }

  await page.goto('https://www.youtube.com');
  console.log('');
  console.log('══════════════════════════════════════════════════════════');
  console.log(' Please sign in to YouTube in the browser window.');
  console.log(' Waiting up to 30 min for sign-in to complete…');
  console.log(' (Detection: ytcfg.LOGGED_IN === true + SAPISID cookie)');
  console.log('══════════════════════════════════════════════════════════');
  console.log('');

  await page.waitForFunction(
    () => {
      const loggedIn =
        !!(window as any).ytcfg &&
        typeof (window as any).ytcfg.get === 'function' &&
        (window as any).ytcfg.get('LOGGED_IN') === true;
      const hasSapisid = document.cookie
        .split(';')
        .some((c) => /(^|\s)(SAPISID|__Secure-3PAPISID|__Secure-1PAPISID)=/.test(c));
      return loggedIn && hasSapisid;
    },
    null,
    { timeout: 30 * 60 * 1000, polling: 2000 },
  );

  await context.storageState({ path: AUTH_FILE });
  console.log(`[auth] saved storage state → ${AUTH_FILE}`);
});
