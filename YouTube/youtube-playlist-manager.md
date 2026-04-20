# YouTube Playlist Manager

Free userscript. Bulk copy/move videos across YouTube playlists with checkboxes. Export/import playlists as JSON. The missing YouTube power-user tool.

## Install

Requires **Tampermonkey** (Chrome/Firefox/Edge) or **Violentmonkey**. Greasemonkey 4 may work but isn't tested.

1. Install the userscript manager if you don't have one.
2. Open `youtube-playlist-manager.user.js` → click "Install".

## Use

Navigate to any playlist page (`/playlist?list=...` or Liked Videos `/feed/liked`). A small red "P" button appears in the bottom-right corner. Click to expand the panel.

**Select videos**: check the checkboxes injected next to each video row. The counter in the panel shows your selection.

**Copy to…**: pick one or more destination playlists and click Go. Videos are added to each selected destination.

**Move to…**: like Copy, but removes from the source afterwards. Requires the source playlist to be one you own (obviously).

**Export JSON**: exports the current playlist as a `ytpm.bundle/1` file. Schema:

```json
{
  "schema": "ytpm.bundle/1",
  "exportedAt": "...",
  "playlists": [
    {
      "id": "PL...",
      "title": "...",
      "itemCount": 142,
      "items": [{"videoId", "setVideoId", "title", "channelId", "channelName", "isPlayable", "deleted"}]
    }
  ]
}
```

**Import JSON**: merges videos from a bundle into the current playlist. Deduplication is on by default — existing videoIds are skipped.

## What's in v0

- [x] Checkbox multi-select on playlist pages
- [x] Bulk copy to N playlists
- [x] Bulk move (copy + remove)
- [x] Export playlist to JSON bundle
- [x] Import JSON into current playlist (with dedupe)
- [x] Per-batch verifier (detects silent mutation drops)
- [x] Log-normal jittered pacing (account-safety)
- [x] Shadow DOM floating UI (survives YouTube's A/B tests)

## What's not in v0

Cut explicitly — see spec doc. Notable defers:

- Dead video detection (easy v1.0 add — already tracks `isPlayable` in exports)
- Keyboard shortcuts (shift-range select, Ctrl+A)
- Cross-playlist duplicate finder (the viral feature per the market lens)
- Playlist diff/compare
- Within-playlist dedup
- Drag/drop reorder (YouTube's native is fine)

## Known limitations

- `loadOwnedPlaylists()` does not paginate. If you have more than ~30 playlists, the destination picker may not show all of them. Reload the page to refresh.
- Selection keys on `videoId`. A playlist containing duplicates will collapse them into one selection slot. Acceptable for most use, but move ops on duplicate rows will behave unexpectedly.
- No built-in undo yet. Exports before destructive ops are your undo until v1.0.

## Safety / OPSEC

- Uses YouTube's internal InnerTube API (the same one your browser already hits). No third-party servers, no telemetry.
- Cookies and `SAPISIDHASH` never leave the browser.
- Exports do **not** include cookies, tokens, or `ytcfg` blobs.
- Log-normal jittered 500–4000ms delays between mutations to stay under anti-abuse thresholds. Never parallelizes writes.
- Bulk operations over 500 items prompt for explicit confirmation.

## Failure modes handled

- **Silent mutation drops** — YouTube's `playlist/edit` can return 200 with dropped actions. After each batch of ≤100 actions, the plugin re-reads the target playlist and reconciles. Missing actions are retried with halved batch size, up to 3 times.
- **Rate limit (429/503)** — exponential backoff starting 5s, max 60s, 3 attempts before surfacing to the user.
- **Session expiry (401/403)** — logs a prompt to reload the page. Does not attempt silent refresh.
- **Tab backgrounded** — mutations pause until tab becomes visible again (accounts for humans sleeping).

## Troubleshooting

**The panel doesn't appear.** Make sure you're on a playlist page. The panel only mounts on `/playlist` and `/feed/liked`. Also check the userscript manager's icon for error messages.

**"No SAPISID cookie — are you signed in?"** Sign into YouTube. The script only works on authenticated sessions.

**"INNERTUBE_CONTEXT missing"** — the page loaded partially. Reload.

**Move fails with "only resolved N/M setVideoIds"** — the plugin couldn't scrape all `setVideoId` handles from the DOM and had to re-query InnerTube. This usually works. If it doesn't, the source playlist may have been partially refreshed; reload and retry.

## Dev

Single file, no build step. Author in place, reload via Tampermonkey. Sections are clearly marked — grep for `──── Storage`, `──── Pacing`, etc.

## License

MIT. See header.
