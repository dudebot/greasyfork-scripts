import { test, expect, waitForBadge } from '../fixtures/inject';

/**
 * v0.1.2 targeted checks:
 *   A. Badge is HIDDEN on non-playlist pages even though @match widened to /*
 *   B. Badge becomes VISIBLE after SPA nav from / into a playlist
 *   C. X-Goog-PageId header is added to InnerTube calls when we
 *      stub DELEGATED_SESSION_ID into ytcfg (simulates brand-account mode)
 *   D. Dest-picker action row (Go / Cancel) is outside the scrollable list
 *      and stays visible even when the dest list overflows.
 */

const SOURCE_PLAYLIST_ID = 'PLIjN02It1ePXDEvgFEddQab_5sM3pehlv';

test('A: badge is hidden on home, visible on playlist (visibility toggle)', async ({ page }) => {
  await page.goto('/');
  await waitForBadge(page);
  const hiddenOnHome = await page.evaluate(() => {
    const root = document.getElementById('ytpm-root') as HTMLElement | null;
    return root && getComputedStyle(root).display === 'none';
  });
  expect(hiddenOnHome, 'badge should be hidden on home').toBe(true);

  await page.goto(`/playlist?list=${SOURCE_PLAYLIST_ID}`);
  await waitForBadge(page);
  await page.waitForFunction(() => {
    const root = document.getElementById('ytpm-root') as HTMLElement | null;
    return root && getComputedStyle(root).display !== 'none';
  });
  const visibleOnPlaylist = await page.evaluate(() => {
    const root = document.getElementById('ytpm-root') as HTMLElement | null;
    return root && getComputedStyle(root).display !== 'none';
  });
  expect(visibleOnPlaylist, 'badge should be visible on /playlist').toBe(true);
});

test('C: X-Goog-PageId header added when DELEGATED_SESSION_ID is present', async ({ page }) => {
  // Stub ytcfg.get('DELEGATED_SESSION_ID') via an addInitScript that runs AFTER
  // the userscript, wrapping window.ytcfg.get to inject our fake brand id.
  const BRAND_ID = '108830997';
  await page.addInitScript((brandId) => {
    const originalDescriptor = (() => {
      let orig: any;
      Object.defineProperty(window, 'ytcfg', {
        configurable: true,
        get() { return orig; },
        set(v) {
          orig = v;
          if (v && typeof v.get === 'function') {
            const realGet = v.get.bind(v);
            v.get = function (key: string, ...rest: any[]) {
              if (key === 'DELEGATED_SESSION_ID') return brandId;
              return realGet(key, ...rest);
            };
          }
        },
      });
    })();
    void originalDescriptor;
  }, BRAND_ID);

  await page.goto(`/playlist?list=${SOURCE_PLAYLIST_ID}`);
  await waitForBadge(page);

  // Capture the next InnerTube request.
  const request = await Promise.all([
    page.waitForRequest((r) => r.url().includes('/youtubei/v1/browse'), { timeout: 30_000 }),
    // Trigger a call by expanding the panel (which calls loadOwnedPlaylists → innertube.browse).
    page.evaluate(() => {
      const badge = document.getElementById('ytpm-root')?.shadowRoot?.getElementById('badge') as HTMLElement | undefined;
      badge?.click();
    }),
  ]).then(([req]) => req);

  const headers = await request.allHeaders();
  expect(headers['x-goog-pageid'], 'X-Goog-PageId should be on InnerTube requests').toBe(BRAND_ID);
});

test('D: destpicker Go/Cancel stay visible when dest list scrolls', async ({ page }) => {
  await page.goto(`/playlist?list=${SOURCE_PLAYLIST_ID}`);
  await waitForBadge(page);
  await page.waitForSelector('ytd-playlist-video-renderer', { timeout: 20_000 });
  await page.waitForFunction(
    () => document.querySelectorAll('ytd-playlist-video-renderer .ytpm-cb').length >= 1,
    null,
    { timeout: 15_000 },
  );

  // Select one video so the dest picker opens (it refuses if no selection).
  await page.evaluate(() => {
    const cb = document.querySelector<HTMLInputElement>('ytd-playlist-video-renderer .ytpm-cb');
    cb?.click();
  });

  // Expand panel, wait for owned playlists to load, open Copy picker.
  await page.evaluate(() => {
    (document.getElementById('ytpm-root')?.shadowRoot?.getElementById('badge') as HTMLElement).click();
  });
  await page.waitForFunction(() => {
    const t =
      document.getElementById('ytpm-root')?.shadowRoot?.getElementById('log')
        ?.textContent || '';
    return /Loaded \d+ of your playlists/.test(t);
  }, null, { timeout: 30_000 });
  await page.evaluate(() => {
    (document.getElementById('ytpm-root')?.shadowRoot?.getElementById('copy') as HTMLElement).click();
  });

  // The destpicker now has a .dest-list child (scrollable) and a .dest-actions
  // child (footer). Assert structure, and that the Go button is NOT inside the
  // scrollable element.
  const layout = await page.evaluate(() => {
    const picker = document
      .getElementById('ytpm-root')
      ?.shadowRoot?.getElementById('destpicker');
    if (!picker) return { ok: false, reason: 'no destpicker' };
    const list = picker.querySelector('.dest-list');
    const actions = picker.querySelector('.dest-actions');
    const go = picker.querySelector('#confirmpick');
    if (!list) return { ok: false, reason: 'no .dest-list' };
    if (!actions) return { ok: false, reason: 'no .dest-actions' };
    if (!go) return { ok: false, reason: 'no #confirmpick' };
    return {
      ok: true,
      goInsideList: list.contains(go),
      goInsideActions: actions.contains(go),
    };
  });

  expect(layout.ok, `destpicker structure wrong: ${(layout as any).reason || ''}`).toBe(true);
  expect(layout.goInsideList, 'Go must NOT be inside the scrollable list').toBe(false);
  expect(layout.goInsideActions, 'Go must be inside the pinned actions row').toBe(true);
});
