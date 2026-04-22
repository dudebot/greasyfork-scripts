import { test, expect, waitForBadge, shadowClick } from '../fixtures/inject';
import fs from 'node:fs';
import path from 'node:path';

const SOURCE_PLAYLIST_ID = 'PLIjN02It1ePXDEvgFEddQab_5sM3pehlv';
const ARTIFACT_DIR = path.resolve('test-results');

test.describe('export / import', () => {
  test('export produces ytpm.bundle/1 JSON with expected fields', async ({ page }) => {
    await page.goto(`/playlist?list=${SOURCE_PLAYLIST_ID}`);
    await waitForBadge(page);
    await page.waitForSelector('ytd-playlist-video-renderer', { timeout: 20_000 });
    await shadowClick(page, 'badge');

    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 60_000 }),
      shadowClick(page, 'export'),
    ]);

    const savePath = path.join(ARTIFACT_DIR, 'exported-bundle.json');
    fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
    await download.saveAs(savePath);
    const bundle = JSON.parse(fs.readFileSync(savePath, 'utf8'));

    expect(bundle.schema).toBe('ytpm.bundle/1');
    expect(typeof bundle.exportedAt).toBe('string');
    expect(Array.isArray(bundle.playlists)).toBe(true);
    expect(bundle.playlists.length).toBeGreaterThan(0);

    const pl = bundle.playlists[0];
    expect(pl.id).toBe(SOURCE_PLAYLIST_ID);
    expect(typeof pl.title).toBe('string');
    expect(Array.isArray(pl.items)).toBe(true);
    expect(pl.items.length).toBeGreaterThan(0);

    for (const it of pl.items.slice(0, 3)) {
      expect(it).toHaveProperty('videoId');
      expect(it).toHaveProperty('setVideoId');
      expect(it).toHaveProperty('title');
      // channelId/channelName may be empty strings or present; just assert key exists
      expect(it).toHaveProperty('channelId');
      expect(it).toHaveProperty('channelName');
    }

    // Share the bundle with the import test
    (test.info() as any).bundlePath = savePath;
  });

  test('import of same bundle dedupes (zero applied additions)', async ({ page }) => {
    // Re-run export to produce a fresh bundle (test independence).
    await page.goto(`/playlist?list=${SOURCE_PLAYLIST_ID}`);
    await waitForBadge(page);
    await shadowClick(page, 'badge');

    const [dl] = await Promise.all([
      page.waitForEvent('download', { timeout: 60_000 }),
      shadowClick(page, 'export'),
    ]);
    const bundlePath = path.join(ARTIFACT_DIR, 'import-roundtrip.json');
    await dl.saveAs(bundlePath);

    // Feed the bundle back through the hidden file input inside the shadow DOM.
    // Playwright's setInputFiles pierces shadow DOM by default.
    const fileInput = page.locator('#ytpm-root').locator('input#importfile');
    // The shadow-piercing requires locator-chain through the host; fall back to evaluate if needed.
    const hasLocator = await fileInput.count().catch(() => 0);

    if (hasLocator > 0) {
      await fileInput.setInputFiles(bundlePath);
    } else {
      // Fallback: construct a File and dispatch on the shadow input.
      const fileContents = fs.readFileSync(bundlePath, 'utf8');
      await page.evaluate(async (body) => {
        const input = document
          .getElementById('ytpm-root')
          ?.shadowRoot?.getElementById('importfile') as HTMLInputElement;
        if (!input) throw new Error('importfile input not found in shadow root');
        const file = new File([body], 'roundtrip.json', { type: 'application/json' });
        const dt = new DataTransfer();
        dt.items.add(file);
        input.files = dt.files;
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }, fileContents);
    }

    // v0.1.3: when every bundle item is a dupe, the script short-circuits
    // before the confirm dialog with "Nothing to import (N dupes, M removed…)".
    // Poll for either the short-circuit line OR the post-confirm applied=0 line.
    page.on('dialog', (d) => d.dismiss()); // safety — shouldn't fire in all-dupe case
    const result = await page
      .waitForFunction(
        () => {
          const text =
            document.getElementById('ytpm-root')?.shadowRoot?.getElementById('log')
              ?.textContent || '';
          const shortCircuit = text.match(/Nothing to import \((\d+) dupes/);
          const posted = text.match(/Imported:\s*applied=(\d+)\s+failed=(\d+)/);
          if (shortCircuit) return { applied: 0, dupes: parseInt(shortCircuit[1], 10), text };
          if (posted) return { applied: parseInt(posted[1], 10), failed: parseInt(posted[2], 10), text };
          return null;
        },
        null,
        { timeout: 120_000, polling: 1500 },
      )
      .then((h) => h.jsonValue());

    expect(result, 'import result line').toBeTruthy();
    expect(result!.applied, 'all items should dedupe').toBe(0);
  });
});
