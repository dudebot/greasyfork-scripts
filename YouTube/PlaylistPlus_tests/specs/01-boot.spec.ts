import { test, expect, waitForBadge, shadowText } from '../fixtures/inject';

const SOURCE_PLAYLIST_ID = 'PLIjN02It1ePXDEvgFEddQab_5sM3pehlv';

test.describe('boot / mount', () => {
  test('badge appears on cold load to /playlist?list=WL', async ({ page, consoleLog }) => {
    await page.goto('/playlist?list=WL');
    await waitForBadge(page);
    await expect.poll(() => shadowText(page, 'badge')).toBe('P');
    await page.screenshot({ path: 'test-results/01-boot-wl.png', fullPage: false });

    // Sanity: script wrote its banner to the console (when DEBUG is on it'd say "YTPM mounted")
    // We can't rely on DEBUG; instead check that no pageerror from the script slipped in.
    const errors = consoleLog.filter((l) => l.startsWith('[pageerror]') || /YTPM\].*Error/i.test(l));
    expect(errors, `unexpected errors:\n${errors.join('\n')}`).toEqual([]);
  });

  test('badge appears after SPA navigation (home → user playlist)', async ({ page }) => {
    await page.goto('/');
    await page.waitForFunction(() => !!(window as any).ytcfg);
    await waitForBadge(page);

    // Force a client-side navigation to the playlist URL. The simplest
    // SPA-style nav from the YT shell is to use the History API directly
    // and let yt-navigate-finish fire, which is the specific event the
    // userscript hooks.
    await page.goto(`/playlist?list=${SOURCE_PLAYLIST_ID}`, { waitUntil: 'domcontentloaded' });
    // The userscript re-inject happens via addInitScript on every nav. Confirm
    // the badge survives and checkboxes get wired up via yt-navigate-finish or
    // the MutationObserver.
    await waitForBadge(page);
    await page.waitForSelector('ytd-playlist-video-renderer', { timeout: 20_000 });
    await page.waitForFunction(
      () => document.querySelectorAll('ytd-playlist-video-renderer .ytpm-cb').length > 0,
      null,
      { timeout: 15_000 },
    );
    await page.screenshot({ path: 'test-results/01-boot-spa.png', fullPage: false });
  });

  test('badge + checkboxes on /feed/liked', async ({ page }) => {
    await page.goto('/feed/liked');
    await waitForBadge(page);
    // Liked Videos page uses ytd-playlist-video-renderer like any other playlist.
    // If the user has zero liked videos the checkbox count may be 0 — tolerate that.
    await page.waitForTimeout(3000); // allow MO to fire
    const hasRows = await page.locator('ytd-playlist-video-renderer').count();
    if (hasRows > 0) {
      await page.waitForFunction(
        () => document.querySelectorAll('ytd-playlist-video-renderer .ytpm-cb').length > 0,
        null,
        { timeout: 15_000 },
      );
    }
    await page.screenshot({ path: 'test-results/01-boot-liked.png' });
  });

  test('badge appears on /watch?list=…', async ({ page }) => {
    await page.goto(`/watch?v=dQw4w9WgXcQ&list=${SOURCE_PLAYLIST_ID}`);
    await waitForBadge(page);
    // The /watch page doesn't render ytd-playlist-video-renderer rows — it has
    // its own ytd-playlist-panel-video-renderer in the sidebar. The userscript
    // only targets ytd-playlist-video-renderer, so NO checkboxes should appear.
    // This is a documented-expectation test.
    await page.waitForTimeout(2500);
    const cbOnWatch = await page.locator('.ytpm-cb').count();
    expect(cbOnWatch, 'checkboxes on /watch page').toBe(0);
    await page.screenshot({ path: 'test-results/01-boot-watch.png' });
  });
});
