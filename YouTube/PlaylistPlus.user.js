// ==UserScript==
// @name         PlaylistPlus
// @namespace    https://github.com/dudebot/greasyfork-scripts
// @version      0.1.6
// @description  Bulk copy/move videos across playlists with checkboxes. Export/import playlists as JSON. The missing YouTube power-user tool.
// @author       dudebot
// @match        https://www.youtube.com/*
// @grant        none
// @run-at       document-idle
// @license      MIT
// ==/UserScript==

(function () {
  'use strict';

  // ─────────────────────────────────────────────────────────────────────────
  // Config
  // ─────────────────────────────────────────────────────────────────────────
  const CFG = {
    BATCH_SIZE: 100,
    MAX_BATCH_RETRIES: 3,
    PACE_MU_MS: 1200,
    PACE_SIGMA_MS: 400,
    PACE_MIN_MS: 500,
    PACE_MAX_MS: 4000,
    BACKOFF_START_MS: 5000,
    BACKOFF_MAX_MS: 60000,
    BACKOFF_MAX_ATTEMPTS: 3,
    WARN_BULK_THRESHOLD: 500,
    FETCH_TIMEOUT_MS: 30000,
    MAX_PAGES: 200, // ceiling for paginated reads — guards runaway continuations
    DEBUG: false,
  };

  const log = (...a) => { if (CFG.DEBUG) console.log('[YTPM]', ...a); };
  const warn = (...a) => console.warn('[YTPM]', ...a);
  const err = (...a) => console.error('[YTPM]', ...a);

  // ─────────────────────────────────────────────────────────────────────────
  // Pacing — log-normal jittered delays, single-flight writes
  // ─────────────────────────────────────────────────────────────────────────
  const pacing = {
    _lastWrite: 0,
    _queue: Promise.resolve(),

    _jitter() {
      // Box-Muller for log-normal
      const u1 = Math.random() || 1e-9;
      const u2 = Math.random();
      const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      // log-normal: exp(mean_log + sigma_log * z)
      const ms = Math.exp(Math.log(CFG.PACE_MU_MS) + (CFG.PACE_SIGMA_MS / CFG.PACE_MU_MS) * z);
      return Math.min(CFG.PACE_MAX_MS, Math.max(CFG.PACE_MIN_MS, ms));
    },

    sleep(ms) { return new Promise(r => setTimeout(r, ms)); },

    async writeGate() {
      const now = Date.now();
      const since = now - this._lastWrite;
      const delay = this._jitter();
      if (since < delay) await this.sleep(delay - since);
      if (document.hidden) {
        // wait for visibility
        await new Promise(r => {
          const h = () => { if (!document.hidden) { document.removeEventListener('visibilitychange', h); r(); } };
          document.addEventListener('visibilitychange', h);
        });
      }
      this._lastWrite = Date.now();
    },

    // Serializes all write operations
    async serialize(fn) {
      const p = this._queue.then(() => fn());
      this._queue = p.catch(() => {});
      return p;
    },
  };

  // ─────────────────────────────────────────────────────────────────────────
  // ytcfg / auth — extract session + compute SAPISIDHASH
  // ─────────────────────────────────────────────────────────────────────────
  const auth = {
    _sapisid: null,

    _readSAPISID() {
      if (this._sapisid) return this._sapisid;
      const jar = {};
      for (const c of document.cookie.split(';').map(s => s.trim())) {
        const i = c.indexOf('=');
        if (i > 0) jar[c.slice(0, i)] = c.slice(i + 1);
      }
      // Explicit priority — SAPISID preferred over secure variants
      const priority = ['SAPISID', '__Secure-3PAPISID', '__Secure-1PAPISID'];
      for (const k of priority) if (jar[k]) { this._sapisid = jar[k]; return jar[k]; }
      return null;
    },

    async sapisidhash() {
      const sid = this._readSAPISID();
      if (!sid) throw new Error('No SAPISID cookie — are you signed in?');
      const ts = Math.floor(Date.now() / 1000);
      const origin = location.origin;
      const raw = `${ts} ${sid} ${origin}`;
      const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(raw));
      const hex = [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
      return `${ts}_${hex}`;
    },

    async authHeader() {
      const h = await this.sapisidhash();
      return `SAPISIDHASH ${h}`;
    },

    ytcfgGet(key) {
      return window.ytcfg?.get?.(key);
    },

    context() {
      const c = this.ytcfgGet('INNERTUBE_CONTEXT');
      if (!c) throw new Error('INNERTUBE_CONTEXT missing — page not fully loaded');
      return c;
    },

    apiKey() {
      const k = this.ytcfgGet('INNERTUBE_API_KEY');
      if (!k) throw new Error('INNERTUBE_API_KEY missing');
      return k;
    },

    // Stable identity string for the currently-active YouTube account. Covers
    // both multi-Google-login (SESSION_INDEX differs) and brand/channel
    // accounts (DELEGATED_SESSION_ID differs under the same Google account).
    identityTag() {
      return `${this.ytcfgGet('SESSION_INDEX') || 0}|${this.ytcfgGet('DELEGATED_SESSION_ID') || ''}`;
    },

    // Op-scoped identity pin. Capture at the start of a multi-step operation
    // (move, copy, import, delete) and call check() before any destructive
    // step. If the active account/brand changed mid-op, the guard throws and
    // the op is aborted before later batches go to the wrong principal.
    openOpGuard() {
      const tag = this.identityTag();
      return {
        tag,
        check: () => {
          const now = auth.identityTag();
          if (now !== tag) {
            throw new Error(`Identity changed mid-operation (was "${tag}", now "${now}") — aborting to avoid wrong-account writes`);
          }
        },
      };
    },
  };

  // ─────────────────────────────────────────────────────────────────────────
  // InnerTube HTTP client
  // ─────────────────────────────────────────────────────────────────────────
  const innertube = {
    async call(endpoint, body, { isWrite = false } = {}) {
      const key = auth.apiKey();
      const url = `${location.origin}/youtubei/v1/${endpoint}?key=${encodeURIComponent(key)}&prettyPrint=false`;
      const headers = {
        'Content-Type': 'application/json',
        'Authorization': await auth.authHeader(),
        'X-Origin': location.origin,
        'X-Goog-AuthUser': String(auth.ytcfgGet('SESSION_INDEX') || 0),
        'X-Youtube-Client-Name': String(auth.ytcfgGet('INNERTUBE_CONTEXT_CLIENT_NAME') || 1),
        'X-Youtube-Client-Version': auth.ytcfgGet('INNERTUBE_CONTEXT_CLIENT_VERSION') || '2.0',
      };
      // Brand/channel accounts under a Google account are identified by
      // DELEGATED_SESSION_ID. Without X-Goog-PageId, YouTube auths the
      // request as the parent Google account instead of the brand.
      const pageId = auth.ytcfgGet('DELEGATED_SESSION_ID');
      if (pageId) headers['X-Goog-PageId'] = pageId;
      const ctx = auth.context();
      const payload = { context: ctx, ...body };
      if (isWrite) await pacing.writeGate();
      let attempt = 0;
      let backoff = CFG.BACKOFF_START_MS;
      for (;;) {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), CFG.FETCH_TIMEOUT_MS);
        let res;
        try {
          res = await fetch(url, {
            method: 'POST',
            credentials: 'include',
            headers,
            body: JSON.stringify(payload),
            signal: ctrl.signal,
          });
        } catch (e) {
          if (e.name === 'AbortError') {
            throw new Error(`InnerTube ${endpoint} timed out after ${CFG.FETCH_TIMEOUT_MS}ms`);
          }
          throw e;
        } finally {
          clearTimeout(timer);
        }
        if (res.status === 429 || res.status === 503) {
          attempt++;
          if (attempt > CFG.BACKOFF_MAX_ATTEMPTS) throw new Error(`Rate-limited after ${attempt} retries (${res.status})`);
          const retryAfter = parseInt(res.headers.get('Retry-After') || '0', 10) * 1000;
          await pacing.sleep(Math.max(retryAfter, backoff));
          backoff = Math.min(CFG.BACKOFF_MAX_MS, backoff * 2);
          continue;
        }
        if (res.status === 401 || res.status === 403) {
          throw new Error(`Auth rejected (${res.status}) — reload the page`);
        }
        if (!res.ok) throw new Error(`InnerTube ${endpoint} failed: ${res.status}`);
        return res.json();
      }
    },

    browse(body) { return this.call('browse', body); },
    playlistEdit(body) { return this.call('browse/edit_playlist', body, { isWrite: true }); },
    playlistCreate(body) { return this.call('playlist/create', body, { isWrite: true }); },
  };

  // ─────────────────────────────────────────────────────────────────────────
  // Reader — paginate playlist items, track videoId + setVideoId
  // ─────────────────────────────────────────────────────────────────────────
  const reader = {
    _extractItems(renderers) {
      const items = [];
      for (const r of renderers || []) {
        const v = r.playlistVideoRenderer;
        if (v) {
          items.push({
            videoId: v.videoId,
            setVideoId: v.setVideoId,
            title: v.title?.simpleText || v.title?.runs?.[0]?.text || '',
            channelId: v.shortBylineText?.runs?.[0]?.navigationEndpoint?.browseEndpoint?.browseId || '',
            channelName: v.shortBylineText?.runs?.[0]?.text || '',
            isPlayable: v.isPlayable !== false,
            deleted: v.isPlayable === false,
          });
          continue;
        }
        const cont = r.continuationItemRenderer;
        if (cont) {
          items.push({ __continuation: cont.continuationEndpoint?.continuationCommand?.token });
        }
      }
      return items;
    },

    async loadPlaylist(playlistId, onProgress) {
      const items = [];
      let resp = await innertube.browse({ browseId: `VL${playlistId}` });
      const header = this._extractHeader(resp);
      let renderers = this._findPlaylistRenderers(resp);
      // Parse-drift sentinel: only cry "drift" when the header explicitly says
      // there ARE items (>0) but we found none. A genuinely empty playlist has
      // itemCount 0 or an unparseable "No videos" count (null); those must return
      // empty rather than throw — otherwise adding to / copying into any empty
      // playlist breaks at the pre-count read. Drift with a positive count would
      // still silently poison exports, dedupe previews, and setVideoId resolution.
      if (header.title && !renderers && header.itemCount > 0) {
        throw new Error(`Playlist parse drift: header recognized but no item renderers found (playlistId=${playlistId})`);
      }
      const seenTokens = new Set();
      let pages = 0;
      while (renderers && renderers.length) {
        pages++;
        if (pages > CFG.MAX_PAGES) {
          throw new Error(`Pagination ceiling reached (${CFG.MAX_PAGES} pages, ${items.length} items) — likely a runaway continuation loop`);
        }
        const extracted = this._extractItems(renderers);
        const cont = extracted.find(x => x.__continuation);
        const before = items.length;
        for (const it of extracted) if (!it.__continuation) items.push(it);
        if (onProgress) onProgress({ loaded: items.length, total: header.itemCount });
        if (!cont) break;
        if (seenTokens.has(cont.__continuation)) {
          throw new Error(`Pagination token repeated at page ${pages} — aborting infinite loop`);
        }
        if (items.length === before && pages > 1) {
          throw new Error(`Pagination made no progress (page ${pages} added 0 items)`);
        }
        seenTokens.add(cont.__continuation);
        resp = await innertube.browse({ continuation: cont.__continuation });
        renderers = this._findContinuationRenderers(resp);
      }
      return { header, items };
    },

    _extractHeader(resp) {
      const h = resp.header?.playlistHeaderRenderer
             || resp.metadata?.playlistMetadataRenderer
             || resp.sidebar?.playlistSidebarRenderer?.items?.[0]?.playlistSidebarPrimaryInfoRenderer;
      const countText = h?.numVideosText?.runs?.[0]?.text
                     || h?.stats?.[0]?.runs?.[0]?.text
                     || '';
      const title = h?.title?.simpleText || h?.title?.runs?.[0]?.text || '';
      return {
        title,
        itemCount: parseInt(countText.replace(/[^\d]/g, ''), 10) || null,
      };
    },

    _findPlaylistRenderers(resp) {
      const tabs = resp.contents?.twoColumnBrowseResultsRenderer?.tabs;
      if (!tabs) return null;
      for (const t of tabs) {
        const sections = t.tabRenderer?.content?.sectionListRenderer?.contents;
        if (!sections) continue;
        for (const s of sections) {
          const items = s.itemSectionRenderer?.contents?.[0]?.playlistVideoListRenderer?.contents;
          if (items) return items;
        }
      }
      return null;
    },

    _findContinuationRenderers(resp) {
      const buckets = [
        resp.onResponseReceivedActions,
        resp.onResponseReceivedEndpoints,
        resp.onResponseReceivedCommands,
      ].filter(Boolean).flat();
      for (const a of buckets) {
        const cont = a.appendContinuationItemsAction?.continuationItems
                  || a.reloadContinuationItemsCommand?.continuationItems;
        if (cont) return cont;
      }
      return null;
    },

    // Fetch the list of user's owned playlists (for destination picker)
    async loadOwnedPlaylists() {
      // Use the /feed/library endpoint via browseId FEplaylist_aggregation
      const resp = await innertube.browse({ browseId: 'FEplaylist_aggregation' });
      const out = [];
      const tabs = resp.contents?.twoColumnBrowseResultsRenderer?.tabs || [];
      const walk = (node) => {
        if (!node || typeof node !== 'object') return;
        if (Array.isArray(node)) { node.forEach(walk); return; }
        if (node.lockupViewModel?.contentId && node.lockupViewModel.contentType === 'LOCKUP_CONTENT_TYPE_PLAYLIST') {
          const meta = node.lockupViewModel.metadata?.lockupMetadataViewModel;
          out.push({
            id: node.lockupViewModel.contentId,
            title: meta?.title?.content || '',
          });
          return;
        }
        if (node.playlistLockupViewModel) {
          out.push({
            id: node.playlistLockupViewModel.contentId || node.playlistLockupViewModel.playlistId,
            title: node.playlistLockupViewModel.metadata?.lockupMetadataViewModel?.title?.content || '',
          });
          return;
        }
        for (const k of Object.keys(node)) walk(node[k]);
      };
      walk(tabs);
      // dedupe
      const seen = new Set();
      return out.filter(p => p.id && !seen.has(p.id) && seen.add(p.id));
    },
  };

  // ─────────────────────────────────────────────────────────────────────────
  // Mutator — build actions[] and dispatch in batches with verification
  // ─────────────────────────────────────────────────────────────────────────
  const mutator = {
    async addVideos(playlistId, videoIds, onProgress) {
      return this._batchedEdit(playlistId, videoIds.map(v => ({
        action: 'ACTION_ADD_VIDEO',
        addedVideoId: v,
      })), { mode: 'add', videoIds }, onProgress);
    },

    async removeVideos(playlistId, setVideoIds, onProgress) {
      return this._batchedEdit(playlistId, setVideoIds.map(s => ({
        action: 'ACTION_REMOVE_VIDEO',
        setVideoId: s,
      })), { mode: 'remove', setVideoIds }, onProgress);
    },

    async _batchedEdit(playlistId, actions, meta, onProgress) {
      const result = { applied: 0, failed: [], retried: 0 };
      const batches = [];
      for (let i = 0; i < actions.length; i += CFG.BATCH_SIZE) {
        batches.push(actions.slice(i, i + CFG.BATCH_SIZE));
      }
      for (let bi = 0; bi < batches.length; bi++) {
        const batch = batches[bi];
        // capture pre-batch count for add verification
        if (meta.mode === 'add') {
          const { items } = await reader.loadPlaylist(playlistId);
          meta._preCount = new Map();
          for (const i of items) meta._preCount.set(i.videoId, (meta._preCount.get(i.videoId) || 0) + 1);
        }
        await pacing.serialize(() => this._runAndVerifyBatch(playlistId, batch, meta, result));
        if (onProgress) onProgress({
          batch: bi + 1,
          totalBatches: batches.length,
          applied: result.applied,
          failed: result.failed.length,
        });
      }
      return result;
    },

    async _runAndVerifyBatch(playlistId, batch, meta, result, depth = 0) {
      try {
        await innertube.playlistEdit({
          playlistId,
          actions: batch,
        });
      } catch (e) {
        warn('playlistEdit threw:', e.message);
        // treat entire batch as failed
        if (depth >= CFG.MAX_BATCH_RETRIES) {
          result.failed.push(...batch);
          return;
        }
        await pacing.sleep(CFG.BACKOFF_START_MS * (depth + 1));
      }

      // Verify: re-read the target playlist and check whether our actions landed.
      // For adds, compare multiset counts (not set membership) so pre-existing
      // entries don't mask dropped mutations.
      const { items } = await reader.loadPlaylist(playlistId);
      const countByVideo = new Map();
      for (const i of items) countByVideo.set(i.videoId, (countByVideo.get(i.videoId) || 0) + 1);
      const presentSetIds = new Set(items.map(i => i.setVideoId));
      // Verifier health: removal logic relies on setVideoId presence in the
      // reread. If the playlist has rows but the extractor produced zero
      // setVideoIds, the parser has drifted — every "absent" act would look
      // like a successful removal. Refuse to confirm.
      if (meta.mode === 'remove' && items.length > 0) {
        const haveSetIds = items.some(i => i.setVideoId);
        if (!haveSetIds) {
          throw new Error('Verifier health: playlist has rows but no setVideoIds were extracted — extractor likely drifted, refusing to confirm removals');
        }
      }

      const expectedAdds = new Map(); // videoId -> expected count after batch
      if (meta.mode === 'add') {
        // Invariant: expected = pre-batch count + adds in this batch. _preCount
        // is captured per outer batch (before any retry recursion) and shared
        // by reference, so retries with shrunk subsets still expect the same
        // baseline — recursive verification then sees cur >= exp once enough
        // retries land, and short = exp - cur falls to 0.
        const pre = meta._preCount || new Map();
        for (const act of batch) {
          const v = act.addedVideoId;
          expectedAdds.set(v, (expectedAdds.get(v) || pre.get(v) || 0) + 1);
        }
      }

      const missing = [];
      if (meta.mode === 'add') {
        // for each unique videoId expected, compare current count to expected
        for (const [vid, exp] of expectedAdds) {
          const cur = countByVideo.get(vid) || 0;
          const short = exp - cur;
          if (short > 0) {
            const acts = batch.filter(a => a.addedVideoId === vid).slice(0, short);
            missing.push(...acts);
          }
        }
      } else {
        for (const act of batch) {
          if (presentSetIds.has(act.setVideoId)) missing.push(act);
        }
      }

      result.applied += batch.length - missing.length;

      if (missing.length && depth < CFG.MAX_BATCH_RETRIES) {
        result.retried += missing.length;
        log(`Verifier: ${missing.length}/${batch.length} silently dropped, retrying (depth ${depth + 1})`);
        // Halve batch size on retry
        const half = Math.max(1, Math.floor(missing.length / 2));
        for (let i = 0; i < missing.length; i += half) {
          await this._runAndVerifyBatch(playlistId, missing.slice(i, i + half), meta, result, depth + 1);
        }
      } else if (missing.length) {
        result.failed.push(...missing);
      }
    },
  };

  // ─────────────────────────────────────────────────────────────────────────
  // Export / Import
  // ─────────────────────────────────────────────────────────────────────────
  const portability = {
    async exportPlaylist(playlistId, { includeUnlisted = false } = {}) {
      const { header, items } = await reader.loadPlaylist(playlistId);
      const cleanItems = items.map(i => ({
        videoId: i.videoId,
        setVideoId: i.setVideoId || null,
        title: i.title,
        channelId: i.channelId || null,
        channelName: i.channelName || null,
        isPlayable: i.isPlayable,
        deleted: i.deleted,
      }));
      return {
        schema: 'ytpm.bundle/1',
        exportedAt: new Date().toISOString(),
        origin: location.origin,
        playlists: [{
          id: playlistId,
          title: header.title,
          itemCount: cleanItems.length,
          items: cleanItems,
        }],
      };
    },

    async importIntoPlaylist(targetPlaylistId, bundle, { dedupe = true } = {}) {
      const pls = Array.isArray(bundle?.playlists) ? bundle.playlists : [];
      const existingIds = new Set();
      if (dedupe) {
        const { items } = await reader.loadPlaylist(targetPlaylistId);
        items.forEach(i => existingIds.add(i.videoId));
      }
      const seenInBundle = new Set();
      const videoIds = [];
      for (const p of pls) {
        for (const it of (p?.items || [])) {
          if (!it || typeof it.videoId !== 'string' || !it.videoId) continue;
          if (it.deleted) continue;
          if (dedupe && existingIds.has(it.videoId)) continue;
          if (seenInBundle.has(it.videoId)) continue;
          seenInBundle.add(it.videoId);
          videoIds.push(it.videoId);
        }
      }
      return mutator.addVideos(targetPlaylistId, videoIds);
    },

    downloadJSON(data, filename) {
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
    },

    async readFile(file) {
      const text = await file.text();
      return JSON.parse(text);
    },
  };

  // ─────────────────────────────────────────────────────────────────────────
  // DOM adapter — detect playlist pages, inject checkboxes
  // ─────────────────────────────────────────────────────────────────────────
  const dom = {
    _observer: null,
    // rowKey -> { videoId, setVideoId, title }
    // Keyed per-row (not per-videoId) so that playlists with the same video
    // appearing more than once track each instance independently.
    _selected: new Map(),
    _listeners: new Set(),
    _rowSeq: 0,

    currentPlaylistId() {
      const u = new URL(location.href);
      const list = u.searchParams.get('list');
      if (list) return list;
      if (location.pathname === '/feed/liked') return 'LL';
      return null;
    },

    isPlaylistPage() {
      return location.pathname === '/playlist'
          || location.pathname === '/feed/liked'
          || (location.pathname === '/watch' && new URL(location.href).searchParams.get('list'));
    },

    onSelectionChange(fn) { this._listeners.add(fn); return () => this._listeners.delete(fn); },
    _emit() { for (const fn of this._listeners) fn(this._selected); },

    clearSelection() { this._selected.clear(); this._refreshCheckboxes(); this._emit(); },
    getSelection() { return new Map(this._selected); },

    // Playlist rows scoped to the playlist's OWN list. YouTube renders the
    // "Recommended videos" section below using the same ytd-playlist-video-renderer
    // tag; including those would let Select-all / bulk ops act on non-playlist items.
    _rows() {
      const list = document.querySelector('ytd-playlist-video-list-renderer');
      return list ? list.querySelectorAll('ytd-playlist-video-renderer') : [];
    },

    _refreshCheckboxes() {
      const rows = this._rows();
      rows.forEach(r => {
        const rowKey = r.dataset.ytpmRowKey;
        const cb = r.querySelector('.ytpm-cb');
        if (cb && rowKey) cb.checked = this._selected.has(rowKey);
      });
    },

    _videoIdOf(row) {
      const link = row.querySelector('a#video-title, a#thumbnail');
      if (!link) return null;
      const href = link.getAttribute('href') || '';
      const m = href.match(/[?&]v=([^&]+)/);
      return m ? m[1] : null;
    },

    _setVideoIdOf(row) {
      const d = row.data || row.polymerController?.data || row.__data;
      return d?.setVideoId
          || d?.playlistVideoRenderer?.setVideoId
          || null;
    },

    _titleOf(row) {
      return row.querySelector('#video-title')?.textContent?.trim() || '';
    },

    injectCheckboxes() {
      const rows = this._rows();
      rows.forEach(row => {
        if (row.querySelector('.ytpm-cb')) return;
        if (!row.dataset.ytpmRowKey) {
          row.dataset.ytpmRowKey = `r${++this._rowSeq}`;
        }
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.className = 'ytpm-cb';
        cb.style.cssText = 'margin-right: 8px; width: 18px; height: 18px; cursor: pointer; accent-color: #f00;';
        cb.addEventListener('click', (e) => {
          e.stopPropagation();
          const rowKey = row.dataset.ytpmRowKey;
          const vid = this._videoIdOf(row);
          if (!rowKey || !vid) return;
          if (cb.checked) {
            this._selected.set(rowKey, {
              videoId: vid,
              setVideoId: this._setVideoIdOf(row),
              title: this._titleOf(row),
            });
          } else {
            this._selected.delete(rowKey);
          }
          this._emit();
        });
        const anchor = row.querySelector('#index-container') || row.querySelector('#index') || row.firstElementChild;
        if (anchor) anchor.insertBefore(cb, anchor.firstChild);
      });
      this._refreshCheckboxes();
    },

    selectAll() {
      const rows = this._rows();
      rows.forEach(row => {
        if (!row.dataset.ytpmRowKey) {
          row.dataset.ytpmRowKey = `r${++this._rowSeq}`;
        }
        const rowKey = row.dataset.ytpmRowKey;
        const vid = this._videoIdOf(row);
        if (rowKey && vid) this._selected.set(rowKey, {
          videoId: vid,
          setVideoId: this._setVideoIdOf(row),
          title: this._titleOf(row),
        });
      });
      this._refreshCheckboxes();
      this._emit();
    },

    start() {
      if (this._observer) return;
      this._observer = new MutationObserver(() => {
        if (this.isPlaylistPage()) this.injectCheckboxes();
      });
      this._observer.observe(document.body, { childList: true, subtree: true });
      // also hook SPA navigation
      window.addEventListener('yt-navigate-finish', () => {
        this._selected.clear();
        this._emit();
        ui._updateVisibility();
        ui._refreshAcct();
        setTimeout(() => this.injectCheckboxes(), 500);
      });
    },
  };

  // ─────────────────────────────────────────────────────────────────────────
  // UI — Shadow DOM floating panel
  // ─────────────────────────────────────────────────────────────────────────
  const ui = {
    _root: null,
    _shadow: null,
    _el: {},
    _ownedPlaylists: [],
    _ownedPlaylistsTag: null,
    _log: [],
    _busy: false,

    _logMsg(msg, kind = 'info') {
      this._log.push({ t: Date.now(), msg, kind });
      if (this._log.length > 100) this._log.shift();
      this._renderLog();
    },

    _renderLog() {
      if (!this._el.log) return;
      setHTML(this._el.log, this._log.slice(-10).reverse().map(e =>
        `<div class="log-${e.kind}">${escapeHtml(e.msg)}</div>`
      ).join(''));
    },

    mount() {
      if (this._root) return;
      this._root = document.createElement('div');
      this._root.id = 'ytpm-root';
      this._root.style.cssText = 'position:fixed;bottom:16px;right:16px;z-index:2147483647;';
      this._shadow = this._root.attachShadow({ mode: 'open' });
      document.body.appendChild(this._root);

      setHTML(this._shadow, `
        <style>
          :host { all: initial; }
          .panel {
            font: 13px/1.4 'Roboto','Arial',sans-serif;
            background: #212121; color: #eee;
            border: 1px solid #3a3a3a; border-radius: 12px;
            width: 320px; max-height: 70vh;
            display: flex; flex-direction: column;
            box-shadow: 0 6px 20px rgba(0,0,0,.4);
            overflow: hidden;
          }
          .panel.collapsed { width: 52px; height: 52px; border-radius: 26px; align-items: center; justify-content: center; cursor: pointer; }
          .panel.collapsed > *:not(.badge) { display: none; }
          .panel.collapsed .badge { display: flex; align-items: center; justify-content: center; width: 100%; height: 100%; font-size: 20px; font-weight: bold; color: #f00; }
          .header { display:flex; align-items:center; padding: 8px 12px; border-bottom: 1px solid #3a3a3a; gap: 8px; }
          .title { flex: 1; font-weight: 600; }
          .acct { font-weight: 400; font-size: 11px; color: #888; margin-left: 4px; }
          .count { font-variant-numeric: tabular-nums; color: #f00; font-weight: 600; }
          button.icon { background:none;border:none;color:#ccc;cursor:pointer;padding:4px 6px; font-size:14px; }
          button.icon:hover { color:#fff; }
          .actions { display:grid; grid-template-columns: 1fr 1fr; gap: 6px; padding: 8px 12px; border-bottom: 1px solid #2a2a2a; }
          button.btn { background:#303030;border:none;color:#eee;padding:8px;border-radius:4px;cursor:pointer;font-size:12px; }
          button.btn:hover { background:#404040; }
          button.btn.primary { background:#c00; color:#fff; }
          button.btn.primary:hover { background:#e00; }
          button.btn:disabled { opacity:.5; cursor:not-allowed; }
          button.btn.danger { background:#5a1a1a; color:#fff; }
          button.btn.danger:hover { background:#7a2020; }
          .span2 { grid-column: 1 / -1; }
          .destpicker { padding: 4px 12px; display:flex; flex-direction:column; }
          .destpicker .dest-list { max-height: 180px; overflow:auto; margin: 6px 0; }
          .destpicker .dest-actions { text-align:right; padding-top:6px; border-top:1px solid #2a2a2a; }
          .dest-row { display:flex; align-items:center; padding:4px; cursor:pointer; border-radius:3px; }
          .dest-row:hover { background:#2a2a2a; }
          .dest-row input { margin-right:6px; }
          .dest-row .dest-title { flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
          .log { flex:1; max-height:120px; overflow:auto; padding: 6px 12px; font-size:11px; color:#aaa; border-top:1px solid #2a2a2a; }
          .log-info { color:#aaa; }
          .log-ok { color:#7e7; }
          .log-warn { color:#fd7; }
          .log-err { color:#f77; }
          .progress { height:4px; background:#333; }
          .progress > .bar { height:100%; background:#f00; width:0%; transition:width .2s; }
          input[type="file"] { display:none; }
          .hint { font-size: 11px; color: #888; padding: 4px 12px; }
        </style>
        <div class="panel collapsed" id="panel">
          <div class="badge" id="badge">P</div>
          <div class="header">
            <div class="title">Playlist Manager <span class="acct" id="acct" title="Active account"></span></div>
            <span class="count" id="count">0</span>
            <button class="icon" id="collapse" title="Collapse">—</button>
          </div>
          <div class="progress"><div class="bar" id="bar"></div></div>
          <div class="actions">
            <button class="btn" id="selall">Select all</button>
            <button class="btn" id="clear">Clear</button>
            <button class="btn primary" id="copy">Copy to…</button>
            <button class="btn primary" id="move">Move to…</button>
            <button class="btn danger span2" id="delete">Delete from this playlist</button>
            <button class="btn" id="export">Export JSON</button>
            <label class="btn" style="text-align:center;cursor:pointer;" for="importfile">Import JSON</label>
            <input type="file" id="importfile" accept=".json,application/json">
          </div>
          <div class="destpicker" id="destpicker" style="display:none"></div>
          <div class="log" id="log"></div>
          <div class="hint">alpha v0.1.6</div>
        </div>
      `);

      const $ = (id) => this._shadow.getElementById(id);
      this._el = {
        panel: $('panel'), badge: $('badge'), count: $('count'), bar: $('bar'),
        collapse: $('collapse'), selall: $('selall'), clear: $('clear'),
        copy: $('copy'), move: $('move'), delete: $('delete'), export: $('export'),
        importfile: $('importfile'), destpicker: $('destpicker'), log: $('log'),
        acct: $('acct'),
      };
      this._refreshAcct();
      this._updateVisibility();

      this._el.badge.addEventListener('click', () => this._toggleExpand());
      this._el.collapse.addEventListener('click', () => this._toggleExpand());
      this._el.selall.addEventListener('click', () => dom.selectAll());
      this._el.clear.addEventListener('click', () => dom.clearSelection());
      this._el.copy.addEventListener('click', () => this._withLock(() => this._showDestPicker('copy')));
      this._el.move.addEventListener('click', () => this._withLock(() => this._showDestPicker('move')));
      this._el.delete.addEventListener('click', () => this._withLock(() => this._doDelete()));
      this._el.export.addEventListener('click', () => this._withLock(() => this._doExport()));
      this._el.importfile.addEventListener('change', (e) => {
        const file = e.target.files[0];
        // Reset so the same file can be re-imported after a previous attempt
        e.target.value = '';
        this._withLock(() => this._doImport(file));
      });

      dom.onSelectionChange(sel => this._onSelectionChange(sel));
      this._renderLog();
    },

    // UI in-flight lock — prevents overlapping write operations from
    // double-click, accidental re-trigger, or queuing two bulk ops at once.
    // pacing.serialize() only serializes individual write batches; this
    // makes whole user-initiated workflows atomic.
    async _withLock(fn) {
      if (this._busy) {
        this._logMsg('Another operation is in progress — wait for it to finish.', 'warn');
        return;
      }
      this._busy = true;
      this._setActionsDisabled(true);
      try {
        return await fn();
      } finally {
        this._busy = false;
        this._setActionsDisabled(false);
      }
    },

    _setActionsDisabled(disabled) {
      for (const k of ['selall','clear','copy','move','delete','export']) {
        if (this._el[k]) this._el[k].disabled = disabled;
      }
    },

    _toggleExpand() {
      this._el.panel.classList.toggle('collapsed');
      if (!this._el.panel.classList.contains('collapsed')) {
        this._loadOwnedPlaylists();
      }
    },

    _refreshAcct() {
      if (!this._el.acct) return;
      const idx = auth.ytcfgGet('SESSION_INDEX') || 0;
      const brand = auth.ytcfgGet('DELEGATED_SESSION_ID');
      const label = brand
        ? `brand ${String(brand).slice(0, 6)}…`
        : `authuser ${idx}`;
      this._el.acct.textContent = `· ${label}`;
    },

    _updateVisibility() {
      if (!this._root) return;
      const show = dom.isPlaylistPage();
      this._root.style.display = show ? '' : 'none';
    },

    async _loadOwnedPlaylists() {
      const tag = auth.identityTag();
      if (this._ownedPlaylists.length && this._ownedPlaylistsTag === tag) return;
      try {
        this._ownedPlaylists = await reader.loadOwnedPlaylists();
        this._ownedPlaylistsTag = tag;
        this._logMsg(`Loaded ${this._ownedPlaylists.length} of your playlists`, 'ok');
      } catch (e) {
        this._logMsg(`Failed to load playlists: ${e.message}`, 'err');
      }
    },

    _onSelectionChange(sel) {
      this._el.count.textContent = sel.size;
      this._el.badge.textContent = sel.size || 'P';
      this._el.badge.style.color = sel.size ? '#fff' : '#f00';
    },

    _showDestPicker(mode) {
      const sel = dom.getSelection();
      if (!sel.size) { this._logMsg('No videos selected', 'warn'); return; }
      const srcId = dom.currentPlaylistId();
      const candidates = this._ownedPlaylists.filter(p => p.id !== srcId);
      return new Promise((resolve) => {
        setHTML(this._el.destpicker, `
          <div style="font-weight:600;">${mode === 'move' ? 'Move' : 'Copy'} ${sel.size} videos to:</div>
          <div class="dest-list">
            <label class="dest-row" style="border-bottom:1px solid #2a2a2a;font-style:italic;">
              <input type="checkbox" value="__NEW__">
              <span class="dest-title">+ Create new playlist…</span>
            </label>
            ${candidates.map(p => `
              <label class="dest-row">
                <input type="checkbox" value="${escapeHtml(p.id)}">
                <span class="dest-title">${escapeHtml(p.title)}</span>
              </label>
            `).join('')}
          </div>
          <div class="dest-actions">
            <button class="btn" id="cancelpick">Cancel</button>
            <button class="btn primary" id="confirmpick">Go</button>
          </div>
        `);
        this._el.destpicker.style.display = 'block';
        this._shadow.getElementById('cancelpick').onclick = () => {
          this._el.destpicker.style.display = 'none';
          resolve();
        };
        this._shadow.getElementById('confirmpick').onclick = async () => {
          const picks = [...this._shadow.querySelectorAll('.dest-row input:checked')].map(i => i.value);
          if (!picks.length) { this._logMsg('Pick at least one destination', 'warn'); return; }
          this._el.destpicker.style.display = 'none';
          try { await this._runBulkOp(mode, picks, sel); }
          finally { resolve(); }
        };
      });
    },

    // Resolve a setVideoId per selected row, preserving duplicates.
    // If a row already has its setVideoId from DOM scraping, use it.
    // Otherwise, consume one entry from a per-videoId queue built off the
    // source playlist read so multiple selected instances of the same video
    // map to distinct setVideoIds rather than collapsing to a single one.
    async _resolveSetVideoIds(srcId, sel) {
      const need = [...sel.values()];
      const direct = need.map(v => v.setVideoId).filter(Boolean);
      if (direct.length === sel.size) return direct;
      const { items } = await reader.loadPlaylist(srcId);
      const queueByVid = new Map();
      for (const it of items) {
        if (!it.setVideoId) continue;
        if (!queueByVid.has(it.videoId)) queueByVid.set(it.videoId, []);
        queueByVid.get(it.videoId).push(it.setVideoId);
      }
      // Pre-consume DOM-scraped setVideoIds so they aren't double-allocated
      // from the queue.
      for (const v of need) {
        if (!v.setVideoId) continue;
        const q = queueByVid.get(v.videoId);
        if (q) {
          const idx = q.indexOf(v.setVideoId);
          if (idx >= 0) q.splice(idx, 1);
        }
      }
      const out = [];
      for (const v of need) {
        if (v.setVideoId) { out.push(v.setVideoId); continue; }
        const q = queueByVid.get(v.videoId);
        if (q && q.length) out.push(q.shift());
      }
      return out;
    },

    async _runBulkOp(mode, destIds, sel) {
      const srcId = dom.currentPlaylistId();
      const videoIds = [...sel.values()].map(v => v.videoId);
      const guard = auth.openOpGuard();

      const realDestIds = destIds.filter(id => id !== '__NEW__');
      if (destIds.includes('__NEW__')) {
        const name = prompt('Name for the new playlist:');
        if (!name || !name.trim()) {
          this._logMsg('New-playlist destination cancelled (no name)', 'warn');
          return;
        }
        try {
          guard.check();
          const newId = await this._createNewPlaylist(name.trim(), videoIds);
          if (!newId) return;
          // Created playlists already have the videos added by playlistCreate;
          // skip them from the destination loop below to avoid double-add.
          this._ownedPlaylists.push({ id: newId, title: name.trim() });
          this._logMsg(`Created playlist "${name.trim()}" (${newId}) and seeded with ${videoIds.length} videos`, 'ok');
        } catch (e) {
          this._logMsg(`Create-new-playlist failed: ${e.message}. Aborting.`, 'err');
          return;
        }
      }

      let setVideoIds = [];
      if (mode === 'move') {
        this._logMsg(`Resolving setVideoIds from source playlist…`);
        try {
          setVideoIds = await this._resolveSetVideoIds(srcId, sel);
          if (setVideoIds.length !== sel.size) {
            this._logMsg(`Warning: resolved ${setVideoIds.length}/${sel.size} setVideoIds; will proceed but some rows may not be removable`, 'warn');
          }
        } catch (e) {
          this._logMsg(`Failed to resolve setVideoIds: ${e.message}. Aborting move.`, 'err');
          return;
        }
      }

      if (sel.size > CFG.WARN_BULK_THRESHOLD) {
        if (!confirm(`You're about to ${mode} ${sel.size} videos across ${realDestIds.length + (destIds.includes('__NEW__') ? 1 : 0)} playlists. Continue?`)) return;
      }

      const destFailures = []; // { destId, failed?, error? }
      if (realDestIds.length) {
        this._logMsg(`${mode === 'move' ? 'Moving' : 'Copying'} ${videoIds.length} videos → ${realDestIds.length} existing playlist${realDestIds.length === 1 ? '' : 's'}…`);
      }
      for (const destId of realDestIds) {
        try {
          guard.check();
          this._logMsg(`  → ${destId}`);
          const r = await mutator.addVideos(destId, videoIds, p => {
            this._setProgress(p.applied / videoIds.length);
            this._el.count.textContent = `${p.applied}/${videoIds.length}`;
          });
          if (r.failed.length > 0) destFailures.push({ destId, failed: r.failed.length });
          this._logMsg(`  + added ${r.applied}, retried ${r.retried}, failed ${r.failed.length}`, r.failed.length ? 'warn' : 'ok');
        } catch (e) {
          destFailures.push({ destId, error: e.message });
          this._logMsg(`  ! ${destId}: ${e.message}`, 'err');
        }
      }

      if (mode === 'move') {
        if (destFailures.length > 0) {
          // Move = copy-then-conditional-delete. Any destination failure
          // means the source playlist must be left intact, otherwise we
          // silently lose data on a partial copy.
          this._logMsg(`Aborting source removal: ${destFailures.length}/${realDestIds.length} destinations had failures. Source playlist left intact.`, 'err');
          this._setProgress(0);
          return;
        }
        try {
          guard.check();
          this._logMsg(`Removing ${setVideoIds.length} from source…`);
          const r = await mutator.removeVideos(srcId, setVideoIds, p => {
            this._setProgress(p.applied / setVideoIds.length);
          });
          this._logMsg(`- removed ${r.applied}, failed ${r.failed.length}`, r.failed.length ? 'warn' : 'ok');
        } catch (e) {
          this._logMsg(`Source removal error: ${e.message}`, 'err');
        }
      }
      dom.clearSelection();
      this._setProgress(0);
      this._logMsg(`Done.`, 'ok');
    },

    // Seed via playlistCreate's `videoIds` argument so we skip the per-batch
    // verifier path that addVideos uses.
    async _createNewPlaylist(title, videoIds) {
      const body = {
        title,
        privacyStatus: 'PRIVATE',
      };
      if (videoIds && videoIds.length) body.videoIds = videoIds;
      const resp = await innertube.playlistCreate(body);
      // Multiple known response shapes — try them in order.
      const newId = resp?.playlistId
                 || resp?.actions?.[0]?.createPlaylistAction?.playlistId
                 || resp?.actions?.find?.(a => a?.createPlaylistAction)?.createPlaylistAction?.playlistId;
      if (!newId) {
        throw new Error('playlistCreate returned no recognizable playlist ID — InnerTube response shape may have drifted');
      }
      return newId;
    },

    async _doDelete() {
      const sel = dom.getSelection();
      if (!sel.size) { this._logMsg('No videos selected', 'warn'); return; }
      const srcId = dom.currentPlaylistId();
      if (!srcId) { this._logMsg('Not on a playlist page', 'warn'); return; }

      const guard = auth.openOpGuard();
      let setVideoIds;
      try {
        setVideoIds = await this._resolveSetVideoIds(srcId, sel);
      } catch (e) {
        this._logMsg(`Failed to resolve setVideoIds: ${e.message}. Aborting delete.`, 'err');
        return;
      }
      if (!setVideoIds.length) {
        this._logMsg('Could not resolve any setVideoIds for the selected rows; cannot delete.', 'err');
        return;
      }
      if (setVideoIds.length !== sel.size) {
        this._logMsg(`Warning: resolved ${setVideoIds.length}/${sel.size} setVideoIds; only those will be deleted`, 'warn');
      }

      if (!confirm(`Delete ${setVideoIds.length} video${setVideoIds.length === 1 ? '' : 's'} from this playlist?\nThis cannot be undone.`)) {
        this._logMsg('Delete cancelled', 'warn');
        return;
      }

      this._logMsg(`Deleting ${setVideoIds.length} from current playlist…`);
      try {
        guard.check();
        const r = await mutator.removeVideos(srcId, setVideoIds, p => {
          this._setProgress(p.applied / setVideoIds.length);
        });
        this._logMsg(`- deleted ${r.applied}, failed ${r.failed.length}`, r.failed.length ? 'warn' : 'ok');
        dom.clearSelection();
        this._setProgress(0);
      } catch (e) {
        this._logMsg(`Delete error: ${e.message}`, 'err');
      }
    },

    _setProgress(frac) {
      this._el.bar.style.width = `${Math.max(0, Math.min(1, frac)) * 100}%`;
    },

    async _doExport() {
      const id = dom.currentPlaylistId();
      if (!id) { this._logMsg('Not on a playlist page', 'warn'); return; }
      this._logMsg('Exporting…');
      try {
        const data = await portability.exportPlaylist(id);
        const title = data.playlists[0].title.replace(/[^\w\-]/g, '_').slice(0, 40) || 'playlist';
        portability.downloadJSON(data, `ytpm-${title}-${id}.json`);
        this._logMsg(`Exported ${data.playlists[0].items.length} items`, 'ok');
      } catch (e) {
        this._logMsg(`Export failed: ${e.message}`, 'err');
      }
    },

    async _doImport(file) {
      if (!file) return;
      const id = dom.currentPlaylistId();
      if (!id) { this._logMsg('Open a target playlist first', 'warn'); return; }
      const guard = auth.openOpGuard();
      try {
        const bundle = await portability.readFile(file);
        if (!bundle || typeof bundle !== 'object') {
          this._logMsg('Import failed: file is not a valid JSON object', 'err');
          return;
        }
        if (!Array.isArray(bundle.playlists)) {
          this._logMsg('Import failed: bundle.playlists missing or not an array', 'err');
          return;
        }
        if (bundle.schema !== 'ytpm.bundle/1') {
          this._logMsg(`Unknown schema: ${bundle.schema}`, 'warn');
        }
        const sources = bundle.playlists.length;
        if (sources > 1) {
          this._logMsg(`Bundle contains ${sources} source playlists — all will be merged into the current target.`, 'warn');
        }

        // Preview: read the target and count how many items will actually
        // land (after dedupe across target + within-bundle + deleted-item
        // filter + per-item videoId validation). Confirm before write.
        this._logMsg(`Previewing target playlist…`);
        const { header, items } = await reader.loadPlaylist(id);
        const existing = new Set(items.map(i => i.videoId));
        const accepted = new Set();
        let candidate = 0, skipDup = 0, skipDel = 0, skipInBundle = 0, skipBad = 0;
        for (const p of bundle.playlists) {
          for (const it of (p?.items || [])) {
            if (!it || typeof it.videoId !== 'string' || !it.videoId) { skipBad++; continue; }
            if (it.deleted) { skipDel++; continue; }
            if (existing.has(it.videoId)) { skipDup++; continue; }
            if (accepted.has(it.videoId)) { skipInBundle++; continue; }
            accepted.add(it.videoId);
            candidate++;
          }
        }
        const title = header.title || id;
        if (candidate === 0) {
          this._logMsg(`Nothing to import (${skipDup} dupes in target, ${skipInBundle} dup within bundle, ${skipDel} removed from YT, ${skipBad} malformed)`, 'warn');
          return;
        }
        const sourceLine = sources > 1 ? `Merging ${sources} source playlists.\n` : '';
        const skipBits = [];
        if (skipDup) skipBits.push(`${skipDup} already in playlist`);
        if (skipInBundle) skipBits.push(`${skipInBundle} dup within bundle`);
        if (skipDel) skipBits.push(`${skipDel} no longer on YouTube`);
        if (skipBad) skipBits.push(`${skipBad} malformed`);
        const msg =
          sourceLine +
          `Add ${candidate} new video${candidate === 1 ? '' : 's'} to "${title}"?\n` +
          (skipBits.length ? `(${skipBits.join(', ')} — will be skipped)` : '');
        if (!confirm(msg)) { this._logMsg('Import cancelled', 'warn'); return; }

        guard.check();
        this._logMsg(`Importing ${candidate} into "${title}"…`);
        const r = await portability.importIntoPlaylist(id, bundle, { dedupe: true });
        this._logMsg(`Imported: applied=${r.applied} failed=${r.failed.length}`, r.failed.length ? 'warn' : 'ok');
      } catch (e) {
        this._logMsg(`Import failed: ${e.message}`, 'err');
      }
    },
  };

  // ─────────────────────────────────────────────────────────────────────────
  // Utils
  // ─────────────────────────────────────────────────────────────────────────
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
  }

  // YouTube serves `require-trusted-types-for 'script'`; raw innerHTML
  // assignment throws. Route through a named policy so shadow/panel HTML
  // renders under the CSP.
  const ttPolicy = (() => {
    try { return window.trustedTypes?.createPolicy?.('ytpm', { createHTML: s => s }) || null; }
    catch { return null; }
  })();
  function setHTML(el, html) {
    el.innerHTML = ttPolicy ? ttPolicy.createHTML(html) : html;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Boot
  // ─────────────────────────────────────────────────────────────────────────
  let _bootTries = 0;
  function boot() {
    if (!window.ytcfg) {
      if (++_bootTries % 25 === 0) console.warn('[YTPM] still waiting for window.ytcfg (tries=' + _bootTries + '). If this never goes away, the userscript is running in an isolated sandbox — set @grant none.');
      setTimeout(boot, 200);
      return;
    }
    try {
      ui.mount();
      dom.start();
      console.log('[YTPM] mounted (v0.1.6)');
    } catch (e) {
      console.error('[YTPM] mount failed:', e);
    }
  }
  if (document.readyState === 'complete' || document.readyState === 'interactive') boot();
  else window.addEventListener('DOMContentLoaded', boot);
})();
