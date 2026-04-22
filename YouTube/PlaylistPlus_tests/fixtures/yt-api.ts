import type { Page } from '@playwright/test';

/**
 * In-page InnerTube helpers. Re-implement the SAPISIDHASH dance the userscript
 * does so we can create / seed / inspect throwaway playlists without going
 * through the panel UI. Everything runs in the page context so cookies +
 * ytcfg are automatically available.
 */

export interface PlaylistItem {
  videoId: string;
  setVideoId: string | null;
  title: string;
}

/**
 * Injected into every page.evaluate below. Defines `_call(endpoint, body)` in
 * the page scope. Kept as a string because page.evaluate's serialization
 * strips closures.
 */
const HELPERS = `
  const _jar = {};
  for (const c of document.cookie.split(';').map(s => s.trim())) {
    const i = c.indexOf('=');
    if (i > 0) _jar[c.slice(0, i)] = c.slice(i + 1);
  }
  const _sid = _jar['SAPISID'] || _jar['__Secure-3PAPISID'] || _jar['__Secure-1PAPISID'];
  if (!_sid) throw new Error('No SAPISID cookie — auth state missing?');
  async function _sapisidhash() {
    const ts = Math.floor(Date.now() / 1000);
    const buf = await crypto.subtle.digest('SHA-1',
      new TextEncoder().encode(ts + ' ' + _sid + ' ' + location.origin));
    const hex = [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2,'0')).join('');
    return ts + '_' + hex;
  }
  async function _call(endpoint, body) {
    const cfg = window.ytcfg;
    if (!cfg || !cfg.get) throw new Error('ytcfg missing');
    const key = cfg.get('INNERTUBE_API_KEY');
    const ctx = cfg.get('INNERTUBE_CONTEXT');
    const url = location.origin + '/youtubei/v1/' + endpoint +
      '?key=' + encodeURIComponent(key) + '&prettyPrint=false';
    const res = await fetch(url, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'SAPISIDHASH ' + await _sapisidhash(),
        'X-Origin': location.origin,
        'X-Goog-AuthUser': String(cfg.get('SESSION_INDEX') || 0),
        'X-Youtube-Client-Name': String(cfg.get('INNERTUBE_CONTEXT_CLIENT_NAME') || 1),
        'X-Youtube-Client-Version': cfg.get('INNERTUBE_CONTEXT_CLIENT_VERSION') || '2.0',
      },
      body: JSON.stringify(Object.assign({ context: ctx }, body)),
    });
    if (!res.ok) throw new Error(endpoint + ' failed: ' + res.status + ' ' + await res.text().catch(()=>''));
    return res.json();
  }
`;

/** Run `body` as a function in the page context with `_call` and `_sapisidhash` in scope. */
async function inPage<T, A extends readonly unknown[]>(
  page: Page,
  args: A,
  body: string,
): Promise<T> {
  const src = `
    (async function(args) {
      ${HELPERS}
      ${body}
    })(arguments[0])
  `;
  // eslint-disable-next-line no-new-func
  return page.evaluate<T, A>(new Function('args', `return (${src})`) as any, args);
}

// ---------------------------------------------------------------------------

export async function createPlaylist(
  page: Page,
  title: string,
  videoIds: string[] = [],
): Promise<string> {
  return inPage<string, [string, string[]]>(page, [title, videoIds], `
    const [title, ids] = args;
    const resp = await _call('playlist/create', {
      title,
      privacyStatus: 'PRIVATE',
      videoIds: ids,
    });
    const findPid = (n) => {
      if (!n || typeof n !== 'object') return null;
      if (typeof n.playlistId === 'string' && n.playlistId.startsWith('PL')) return n.playlistId;
      if (typeof n.playlistId === 'string' && n.playlistId.startsWith('VL')) return n.playlistId.slice(2);
      for (const k of Object.keys(n)) {
        const r = findPid(n[k]); if (r) return r;
      }
      return null;
    };
    const pid = resp.playlistId || findPid(resp);
    if (!pid) throw new Error('playlist/create: no playlistId — ' + JSON.stringify(resp).slice(0, 400));
    return pid;
  `);
}

export async function addToPlaylist(
  page: Page,
  playlistId: string,
  videoIds: string[],
): Promise<void> {
  await inPage<void, [string, string[]]>(page, [playlistId, videoIds], `
    const [pid, ids] = args;
    await _call('browse/edit_playlist', {
      playlistId: pid,
      actions: ids.map(v => ({ action: 'ACTION_ADD_VIDEO', addedVideoId: v })),
    });
  `);
}

export async function readPlaylist(
  page: Page,
  playlistId: string,
): Promise<{ title: string; items: PlaylistItem[] }> {
  return inPage<{ title: string; items: PlaylistItem[] }, [string]>(
    page,
    [playlistId],
    `
    const [pid] = args;
    const items = [];
    let resp = await _call('browse', { browseId: 'VL' + pid });
    const h = resp.header?.playlistHeaderRenderer || resp.metadata?.playlistMetadataRenderer;
    const title = h?.title?.simpleText || h?.title?.runs?.[0]?.text || '';
    const findList = (r) => {
      const tabs = r.contents?.twoColumnBrowseResultsRenderer?.tabs;
      if (!tabs) return null;
      for (const t of tabs) {
        const secs = t.tabRenderer?.content?.sectionListRenderer?.contents;
        if (!secs) continue;
        for (const s of secs) {
          const it = s.itemSectionRenderer?.contents?.[0]?.playlistVideoListRenderer?.contents;
          if (it) return it;
        }
      }
      return null;
    };
    const findCont = (r) => {
      const buckets = [r.onResponseReceivedActions, r.onResponseReceivedEndpoints, r.onResponseReceivedCommands]
        .filter(Boolean).flat();
      for (const a of buckets) {
        const c = a.appendContinuationItemsAction?.continuationItems
               || a.reloadContinuationItemsCommand?.continuationItems;
        if (c) return c;
      }
      return null;
    };
    let renderers = findList(resp);
    while (renderers && renderers.length) {
      let contToken = null;
      for (const r of renderers) {
        const v = r.playlistVideoRenderer;
        if (v) {
          items.push({
            videoId: v.videoId,
            setVideoId: v.setVideoId || null,
            title: v.title?.simpleText || v.title?.runs?.[0]?.text || '',
          });
        }
        const cont = r.continuationItemRenderer;
        if (cont) contToken = cont.continuationEndpoint?.continuationCommand?.token || null;
      }
      if (!contToken) break;
      resp = await _call('browse', { continuation: contToken });
      renderers = findCont(resp);
    }
    return { title, items };
  `,
  );
}
