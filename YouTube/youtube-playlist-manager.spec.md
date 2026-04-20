# YouTube Playlist Manager — Spec (v0)

## Purpose

Free Tampermonkey/Greasemonkey userscript that fills the gaps in YouTube's native playlist management. Target users: power users with 20+ playlists and 1000+ liked videos who currently pay for TubeBuddy / similar.

## v0 feature set (shipped)

1. **Checkbox multi-select** on any playlist page (including Liked Videos)
2. **Bulk copy** selected videos to other playlists (checkbox grid of destination playlists)
3. **Bulk move** (copy then remove from current) — requires `setVideoId`
4. **Playlist export** as JSON bundle
5. **Playlist import** from JSON bundle (create new or merge into existing)

## Tier 1 (v1.0, planned)

- Dead video detection (flag `isPlayable: false` in export)
- Keyboard shortcuts (shift-click range, Ctrl+A, Esc)
- Playlist diff/compare (pure set math on exports)
- Dedup within playlist
- **Duplicate detection across all playlists** (proposed viral driver)

## Explicit non-goals / kills

- Drag/drop reorder (YT native is fine)
- Cross-account sync
- Tags/labels beyond playlists
- Search across all playlists (Ctrl+F is fine for now)
- Scheduled snapshots (userscripts can't run when tab is closed)
- Folders/nesting (no YT API for it)
- yt-dlp integration (userscripts can't shell out)
- Smart playlists with DSL (scope explosion)
- Playlist create/delete — deferred; YT's native create flow is acceptable

## Architecture

Single `.user.js` file with internal module sections (no build step for v0).
Modules:

- **ytcfg** — extract `INNERTUBE_API_KEY`, `INNERTUBE_CONTEXT`, identity fields
- **auth** — compute `SAPISIDHASH` = SHA1(`timestamp SAPISID origin`) fresh per request
- **innertube** — POST `/youtubei/v1/browse` and `/youtubei/v1/playlist/edit`
- **reader** — paginate playlist items via `continuationCommand.token`, track `videoId` + `setVideoId`
- **mutator** — build `actions[]` for `playlistEditEndpoint` (up to 200 per call)
- **verifier** — after batch, re-read target playlist and reconcile expected vs actual
- **pacing** — log-normal jittered delays 800–2500ms; serialize writes; 429 backoff
- **storage** — GM_setValue (falls back to localStorage); keyed by identity hash (see below)
- **ui** — Shadow DOM floating panel bottom-right, checkbox injection via MutationObserver
- **commandBus** — orchestrates intents → ops with undo log

## Identity scoping for storage

Derive identity hash from `ytcfg.get('DELEGATED_SESSION_ID') || (SESSION_INDEX + CHANNEL_ID)`.
SHA-256, first 12 hex chars. Key layout:

```
ytpm:v1:acct:<idHash>:prefs
ytpm:v1:acct:<idHash>:undo
ytpm:v1:acct:<idHash>:cache:pl:<playlistId>
ytpm:v1:global:migrations
```

Never key by SAPISID/SAPISIDHASH — those are sensitive and can leak via storage inspection.

## Export format — `ytpm.bundle/1`

```json
{
  "schema": "ytpm.bundle/1",
  "exportedAt": "2026-04-19T...Z",
  "origin": "youtube.com",
  "playlists": [
    {
      "id": "PLxxxx",
      "title": "My Playlist",
      "itemCount": 142,
      "items": [
        {
          "videoId": "abc123",
          "setVideoId": "PLITEM-token",
          "title": "Video title snapshot",
          "channelId": "UCxxxx",
          "channelName": "Channel",
          "isPlayable": true,
          "deleted": false
        }
      ]
    }
  ]
}
```

Round-trip rule: unknown top-level keys on import are preserved on re-export. Import modes: `create` (new playlist), `merge` (add to existing, optional dedupe-by-videoId), `replace` (not v0 — needs confirm UI).

Unlisted video IDs: require explicit opt-in checkbox before export; flagged in UI.

## Reliability — the verifier

YouTube's `playlist/edit` silently drops mutations under load (returns 200 with empty `actions[]`).
After each batch of ≤200 edit actions:

1. Wait jittered delay (800–2500ms log-normal)
2. Re-read target playlist (paginated)
3. Compute delta: expected − actual
4. Retry only missing items, halving batch size
5. Max 3 retries per batch
6. Surface final reconciliation: `Applied: 184/200, Retried: 16, Final failures: 3`
7. On final failures, offer "export failed IDs" JSON for manual retry

For move ops, verify both sides: target gained + source lost.

## Rate limiting

- Never parallelize writes
- Inter-write delay: log-normal, μ=1200ms, σ=400ms (jittered ~800–2500ms), clamp [500, 4000]
- On HTTP 429 or `Retry-After`: exponential backoff 5s→60s, max 3 attempts then hard-stop
- On HTTP 401: session expired — prompt user to refresh page
- Pause all ops if tab hidden (`document.hidden`) — resume on focus

## OPSEC

- No network calls to non-google origins
- No `eval`, no remote code loading
- Cookies/SAPISIDHASH never leave the browser
- Default export excludes unlisted video IDs (opt-in required)
- Source on Greasyfork + GitHub (reproducible, auditable)
- Warn before bulk ops on >500 items

## UI surface

- **Shadow DOM** floating panel at `position: fixed; bottom: 16px; right: 16px`
- Collapsed: a single circular toggle button (YT-style)
- Expanded: panel with selection count, bulk-op buttons, progress bar, mini log
- Only renders on playlist pages (`/playlist?list=...` and `/feed/playlists`)
- Checkboxes injected into `ytd-playlist-video-renderer` via MutationObserver
- Persists across SPA nav via `yt-navigate-finish` hook

## Day-2 footgun watchlist

- **`videoId` vs `setVideoId`** — removals require `setVideoId`. Track both everywhere.
- **Continuation pagination** — must exhaust continuations before trusting any "full list" read; verifier is wrong otherwise.
- **Silent mutation drops** — must reconcile per-batch, not per-op.
- **SAPISIDHASH freshness** — recompute every request with current timestamp.
- **A/B layout changes** — anchor to `ytd-playlist-video-renderer` tag name, not internal layout.

## File layout

```
greasyfork-scripts/YouTube/
  youtube-playlist-manager.user.js      # single-file deliverable
  youtube-playlist-manager.spec.md      # this doc
  youtube-playlist-manager.md           # user-facing readme
```
