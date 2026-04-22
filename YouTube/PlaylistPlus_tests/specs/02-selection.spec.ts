import { test, expect, waitForBadge, shadowText, shadowClick } from '../fixtures/inject';

const SOURCE_PLAYLIST_ID = 'PLIjN02It1ePXDEvgFEddQab_5sM3pehlv';

test.describe('panel / selection', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(`/playlist?list=${SOURCE_PLAYLIST_ID}`);
    await waitForBadge(page);
    await page.waitForSelector('ytd-playlist-video-renderer', { timeout: 20_000 });
    await page.waitForFunction(
      () => document.querySelectorAll('ytd-playlist-video-renderer .ytpm-cb').length >= 3,
      null,
      { timeout: 15_000 },
    );
  });

  test('clicking badge expands the panel', async ({ page }) => {
    // Initial state: panel has .collapsed class
    const before = await page.evaluate(
      () =>
        document
          .getElementById('ytpm-root')
          ?.shadowRoot?.getElementById('panel')
          ?.classList.contains('collapsed'),
    );
    expect(before).toBe(true);

    await shadowClick(page, 'badge');
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            document
              .getElementById('ytpm-root')
              ?.shadowRoot?.getElementById('panel')
              ?.classList.contains('collapsed'),
        ),
      )
      .toBe(false);
    await page.screenshot({ path: 'test-results/02-panel-expanded.png' });
  });

  test('selecting 3 videos updates the count', async ({ page }) => {
    // Check the first 3 injected checkboxes.
    const clicked = await page.evaluate(() => {
      const boxes = [...document.querySelectorAll<HTMLInputElement>('ytd-playlist-video-renderer .ytpm-cb')].slice(0, 3);
      boxes.forEach((b) => b.click());
      return boxes.length;
    });
    expect(clicked).toBe(3);

    // Expand panel so we can see the count
    await shadowClick(page, 'badge');
    await expect.poll(() => shadowText(page, 'count')).toBe('3');
  });

  test('selection does NOT persist across SPA nav (documented behavior)', async ({ page }) => {
    // Select 2
    await page.evaluate(() => {
      const boxes = [...document.querySelectorAll<HTMLInputElement>('ytd-playlist-video-renderer .ytpm-cb')].slice(0, 2);
      boxes.forEach((b) => b.click());
    });
    await shadowClick(page, 'badge');
    await expect.poll(() => shadowText(page, 'count')).toBe('2');

    // SPA-navigate away and back. yt-navigate-finish handler in the script
    // explicitly calls `_selected.clear()`, so the count should reset.
    await page.goto('/feed/trending', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1500);
    await page.goto(`/playlist?list=${SOURCE_PLAYLIST_ID}`);
    await waitForBadge(page);
    await page.waitForFunction(
      () => document.querySelectorAll('ytd-playlist-video-renderer .ytpm-cb').length >= 2,
      null,
      { timeout: 15_000 },
    );

    // Expand to see count
    const collapsed = await page.evaluate(
      () =>
        document
          .getElementById('ytpm-root')
          ?.shadowRoot?.getElementById('panel')
          ?.classList.contains('collapsed'),
    );
    if (collapsed) await shadowClick(page, 'badge');

    const count = await shadowText(page, 'count');
    expect(count, 'selection cleared on SPA nav per dom.start() handler').toBe('0');
  });
});
