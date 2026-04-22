// ==UserScript==
// @name         YouTube Playlist Manager
// @namespace    https://github.com/dudebot/greasyfork-scripts
// @version      0.1.0
// @description  Bulk copy/move videos across playlists with checkboxes. Export/import playlists as JSON. The missing YouTube power-user tool.
// @author       dudebot
// @match        https://www.youtube.com/playlist*
// @match        https://www.youtube.com/feed/liked*
// @match        https://www.youtube.com/watch*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_listValues
// @run-at       document-idle
// @license      MIT
// ==/UserScript==

(function () {
  'use strict';

  // ─────────────────────────────────────────────────────────────────────────
  // Config
  // ─────────────────────────────────────────────────────────────────────────
  const CFG = {
    STORAGE_VERSION: 1,
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
    DEBUG: false,
  };

  const log = (...a) => { if (CFG.DEBUG) console.log('[YTPM]', ...a); };
  const warn = (...a) => console.warn('[YTPM]', ...a);
  const err = (...a) => console.error('[YTPM]', ...a);

  // ─────────────────────────────────────────────────────────────────────────
  // Storage (GM_setValue with localStorage fallback, account-scoped)
  // ─────────────────────────────────────────────────────────────────────────
  const storage = {
    _backend: typeof GM_setValue === 'function' ? 'gm' : 'ls',
    _idHash: null,

    async _initIdHash() {
      if (this._idHash) return this._idHash;
      const cfg = window.ytcfg;
      const dsid = cfg?.get?.('DELEGATED_SESSION_ID') || '';
      const chid = cfg?.get?.('CHANNEL_ID') || '';
      const sidx = cfg?.get?.('SESSION_INDEX') || '0';
      const raw = dsid || `${sidx}:${chid}`;
      if (!raw || raw === '0:') {
        this._idHash = 'anon';
        return this._idHash;
      }
      const enc = new TextEncoder().encode(raw);
      const buf = await crypto.subtle.digest('SHA-256', enc);
      const hex = [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
      this._idHash = hex.slice(0, 12);
      return this._idHash;
    },

    async _k(suffix) {
      const h = await this._initIdHash();
      return `ytpm:v${CFG.STORAGE_VERSION}:acct:${h}:${suffix}`;
    },

    async get(suffix, fallback = null) {
      const k = await this._k(suffix);
      if (this._backend === 'gm') return GM_getValue(k, fallback);
      const v = localStorage.getItem(k);
      return v == null ? fallback : JSON.parse(v);
    },

    async set(suffix, val) {
      const k = await this._k(suffix);
      if (this._backend === 'gm') return GM_setValue(k, val);
      localStorage.setItem(k, JSON.stringify(val));
    },

    async del(suffix) {
      const k = await this._k(suffix);
      if (this._backend === 'gm') return GM_deleteValue(k);
      localStorage.removeItem(k);
    },
  };

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
      const ctx = auth.context();
      const payload = { context: ctx, ...body };
      if (isWrite) await pacing.writeGate();
      let attempt = 0;
      let backoff = CFG.BACKOFF_START_MS;
      for (;;) {
        const res = await fetch(url, {
          method: 'POST',
          credentials: 'include',
          headers,
          body: JSON.stringify(payload),
        });
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
      while (renderers && renderers.length) {
        const extracted = this._extractItems(renderers);
        const cont = extracted.find(x => x.__continuation);
        for (const it of extracted) if (!it.__continuation) items.push(it);
        if (onProgress) onProgress({ loaded: items.length, total: header.itemCount });
        if (!cont) break;
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
        action: 'ACTION_REMOVE_VIDEO_BY_SET_VIDEO_ID',
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

      const expectedAdds = new Map(); // videoId -> expected count after batch
      if (meta.mode === 'add') {
        // Snapshot of expected counts: previous count (approx via current - 1 if dropped) is unknowable
        // without pre-snapshot. Use the _preSnapshot captured before batch.
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
      const pls = bundle.playlists || [];
      const existingIds = new Set();
      if (dedupe) {
        const { items } = await reader.loadPlaylist(targetPlaylistId);
        items.forEach(i => existingIds.add(i.videoId));
      }
      const videoIds = [];
      for (const p of pls) {
        for (const it of p.items || []) {
          if (it.deleted) continue;
          if (dedupe && existingIds.has(it.videoId)) continue;
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
    _selected: new Map(), // videoId -> { setVideoId, title }
    _listeners: new Set(),

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

    _refreshCheckboxes() {
      const rows = document.querySelectorAll('ytd-playlist-video-renderer');
      rows.forEach(r => {
        const vid = this._videoIdOf(r);
        const cb = r.querySelector('.ytpm-cb');
        if (cb) cb.checked = this._selected.has(vid);
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
      const rows = document.querySelectorAll('ytd-playlist-video-renderer');
      rows.forEach(row => {
        if (row.querySelector('.ytpm-cb')) return;
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.className = 'ytpm-cb';
        cb.style.cssText = 'margin-right: 8px; width: 18px; height: 18px; cursor: pointer; accent-color: #f00;';
        cb.addEventListener('click', (e) => {
          e.stopPropagation();
          const vid = this._videoIdOf(row);
          if (!vid) return;
          if (cb.checked) {
            this._selected.set(vid, {
              setVideoId: this._setVideoIdOf(row),
              title: this._titleOf(row),
            });
          } else {
            this._selected.delete(vid);
          }
          this._emit();
        });
        const anchor = row.querySelector('#index-container') || row.querySelector('#index') || row.firstElementChild;
        if (anchor) anchor.insertBefore(cb, anchor.firstChild);
      });
      this._refreshCheckboxes();
    },

    selectAll() {
      const rows = document.querySelectorAll('ytd-playlist-video-renderer');
      rows.forEach(row => {
        const vid = this._videoIdOf(row);
        if (vid) this._selected.set(vid, {
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
    _log: [],

    _logMsg(msg, kind = 'info') {
      this._log.push({ t: Date.now(), msg, kind });
      if (this._log.length > 100) this._log.shift();
      this._renderLog();
    },

    _renderLog() {
      if (!this._el.log) return;
      this._el.log.innerHTML = this._log.slice(-10).reverse().map(e =>
        `<div class="log-${e.kind}">${escapeHtml(e.msg)}</div>`
      ).join('');
    },

    mount() {
      if (this._root) return;
      this._root = document.createElement('div');
      this._root.id = 'ytpm-root';
      this._root.style.cssText = 'position:fixed;bottom:16px;right:16px;z-index:2147483647;';
      this._shadow = this._root.attachShadow({ mode: 'open' });
      document.body.appendChild(this._root);

      this._shadow.innerHTML = `
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
          .count { font-variant-numeric: tabular-nums; color: #f00; font-weight: 600; }
          button.icon { background:none;border:none;color:#ccc;cursor:pointer;padding:4px 6px; font-size:14px; }
          button.icon:hover { color:#fff; }
          .actions { display:grid; grid-template-columns: 1fr 1fr; gap: 6px; padding: 8px 12px; border-bottom: 1px solid #2a2a2a; }
          button.btn { background:#303030;border:none;color:#eee;padding:8px;border-radius:4px;cursor:pointer;font-size:12px; }
          button.btn:hover { background:#404040; }
          button.btn.primary { background:#c00; color:#fff; }
          button.btn.primary:hover { background:#e00; }
          button.btn:disabled { opacity:.5; cursor:not-allowed; }
          .destpicker { max-height: 180px; overflow:auto; padding: 4px 12px; }
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
            <div class="title">Playlist Manager</div>
            <span class="count" id="count">0</span>
            <button class="icon" id="collapse" title="Collapse">—</button>
          </div>
          <div class="progress"><div class="bar" id="bar"></div></div>
          <div class="actions">
            <button class="btn" id="selall">Select all</button>
            <button class="btn" id="clear">Clear</button>
            <button class="btn primary" id="copy">Copy to…</button>
            <button class="btn primary" id="move">Move to…</button>
            <button class="btn" id="export">Export JSON</button>
            <label class="btn" style="text-align:center;cursor:pointer;" for="importfile">Import JSON</label>
            <input type="file" id="importfile" accept=".json,application/json">
          </div>
          <div class="destpicker" id="destpicker" style="display:none"></div>
          <div class="log" id="log"></div>
          <div class="hint">alpha v0.1 · undo: right-click panel header</div>
        </div>
      `;

      const $ = (id) => this._shadow.getElementById(id);
      this._el = {
        panel: $('panel'), badge: $('badge'), count: $('count'), bar: $('bar'),
        collapse: $('collapse'), selall: $('selall'), clear: $('clear'),
        copy: $('copy'), move: $('move'), export: $('export'),
        importfile: $('importfile'), destpicker: $('destpicker'), log: $('log'),
      };

      this._el.badge.addEventListener('click', () => this._toggleExpand());
      this._el.collapse.addEventListener('click', () => this._toggleExpand());
      this._el.selall.addEventListener('click', () => dom.selectAll());
      this._el.clear.addEventListener('click', () => dom.clearSelection());
      this._el.copy.addEventListener('click', () => this._showDestPicker('copy'));
      this._el.move.addEventListener('click', () => this._showDestPicker('move'));
      this._el.export.addEventListener('click', () => this._doExport());
      this._el.importfile.addEventListener('change', (e) => this._doImport(e.target.files[0]));

      dom.onSelectionChange(sel => this._onSelectionChange(sel));
      this._renderLog();
    },

    _toggleExpand() {
      this._el.panel.classList.toggle('collapsed');
      if (!this._el.panel.classList.contains('collapsed')) {
        this._loadOwnedPlaylists();
      }
    },

    async _loadOwnedPlaylists() {
      if (this._ownedPlaylists.length) return;
      this._logMsg('Loading your playlists…');
      try {
        this._ownedPlaylists = await reader.loadOwnedPlaylists();
        this._logMsg(`Found ${this._ownedPlaylists.length} playlists`, 'ok');
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
      if (!candidates.length) {
        this._logMsg('No other playlists found — reload and try again', 'warn');
        return;
      }
      this._el.destpicker.innerHTML = `
        <div style="font-weight:600;margin-bottom:6px;">${mode === 'move' ? 'Move' : 'Copy'} ${sel.size} videos to:</div>
        ${candidates.map(p => `
          <label class="dest-row">
            <input type="checkbox" value="${escapeHtml(p.id)}">
            <span class="dest-title">${escapeHtml(p.title)}</span>
          </label>
        `).join('')}
        <div style="margin-top:8px;text-align:right;">
          <button class="btn" id="cancelpick">Cancel</button>
          <button class="btn primary" id="confirmpick">Go</button>
        </div>
      `;
      this._el.destpicker.style.display = 'block';
      this._shadow.getElementById('cancelpick').onclick = () => {
        this._el.destpicker.style.display = 'none';
      };
      this._shadow.getElementById('confirmpick').onclick = async () => {
        const picks = [...this._shadow.querySelectorAll('.dest-row input:checked')].map(i => i.value);
        if (!picks.length) { this._logMsg('Pick at least one destination', 'warn'); return; }
        this._el.destpicker.style.display = 'none';
        await this._runBulkOp(mode, picks, sel);
      };
    },

    async _runBulkOp(mode, destIds, sel) {
      const srcId = dom.currentPlaylistId();
      const videoIds = [...sel.keys()];
      let setVideoIds = [...sel.values()].map(v => v.setVideoId).filter(Boolean);

      // For move, resolve setVideoIds reliably via InnerTube if DOM scraping came up short
      if (mode === 'move' && setVideoIds.length !== sel.size) {
        this._logMsg(`Resolving setVideoIds from source playlist…`);
        try {
          const { items } = await reader.loadPlaylist(srcId);
          const byVid = new Map();
          for (const it of items) if (it.setVideoId) byVid.set(it.videoId, it.setVideoId);
          setVideoIds = videoIds.map(v => byVid.get(v)).filter(Boolean);
          if (setVideoIds.length !== sel.size) {
            this._logMsg(`Warning: only resolved ${setVideoIds.length}/${sel.size} setVideoIds; proceeding with what we have`, 'warn');
          }
        } catch (e) {
          this._logMsg(`Failed to resolve setVideoIds: ${e.message}. Aborting move.`, 'err');
          return;
        }
      }
      if (sel.size > CFG.WARN_BULK_THRESHOLD) {
        if (!confirm(`You're about to ${mode} ${sel.size} videos across ${destIds.length} playlists. Continue?`)) return;
      }

      this._logMsg(`${mode === 'move' ? 'Moving' : 'Copying'} ${videoIds.length} videos → ${destIds.length} playlists…`);
      try {
        for (const destId of destIds) {
          this._logMsg(`  → ${destId}`);
          const r = await mutator.addVideos(destId, videoIds, p => {
            this._setProgress(p.applied / videoIds.length);
            this._el.count.textContent = `${p.applied}/${videoIds.length}`;
          });
          this._logMsg(`  + added ${r.applied}, retried ${r.retried}, failed ${r.failed.length}`, r.failed.length ? 'warn' : 'ok');
        }
        if (mode === 'move') {
          this._logMsg(`Removing ${setVideoIds.length} from source…`);
          const r = await mutator.removeVideos(srcId, setVideoIds, p => {
            this._setProgress(p.applied / setVideoIds.length);
          });
          this._logMsg(`- removed ${r.applied}, failed ${r.failed.length}`, r.failed.length ? 'warn' : 'ok');
        }
        dom.clearSelection();
        this._setProgress(0);
        this._logMsg(`Done.`, 'ok');
      } catch (e) {
        err(e);
        this._logMsg(`Error: ${e.message}`, 'err');
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
      this._logMsg(`Importing ${file.name} into current playlist…`);
      try {
        const bundle = await portability.readFile(file);
        if (bundle.schema !== 'ytpm.bundle/1') {
          this._logMsg(`Unknown schema: ${bundle.schema}`, 'warn');
        }
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

  // ─────────────────────────────────────────────────────────────────────────
  // Boot
  // ─────────────────────────────────────────────────────────────────────────
  function boot() {
    if (!window.ytcfg) {
      setTimeout(boot, 200);
      return;
    }
    ui.mount();
    dom.start();
    log('YTPM mounted');
  }
  if (document.readyState === 'complete' || document.readyState === 'interactive') boot();
  else window.addEventListener('DOMContentLoaded', boot);
})();
