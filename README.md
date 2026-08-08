# greasyfork-scripts

A collection of Tampermonkey/Violentmonkey userscripts, organized by the site they target. Each script lives in its own folder with a `.user.js` file and a doc explaining what it does and how it works under the hood.

These exist to fill gaps the sites themselves leave open: saving TTS audio that's otherwise stream-only, bulk playlist operations YouTube never shipped, and keeping streamer messages visible after chat scrolls them away.

## Scripts

| Script | Site | What it does |
|---|---|---|
| [PlaylistPlus](YouTube/PlaylistPlus.md) (v0.1.7) | YouTube | Bulk copy/move videos across playlists with checkboxes; export/import playlists as JSON. The missing YouTube power-user tool. |
| [YouTube Streamer Chat Highlight](YouTube/youtube-streamer-chat-highlight.md) (v1.3.0) | YouTube | Collects streamer messages from live chat into a persistent, resizable panel that doesn't truncate. Works on watch pages and popout chat. |
| [ChatGPT TTS Grabber](ChatGPT/chatgpt-tts-grabber.md) (v1.2.0) | ChatGPT | Automatically downloads ChatGPT's voice-playback audio, named after the chat title. Captures MSE-streamed audio that never exists as a plain file. |
| [Grok TTS Grabber](Grok/grok-tts-grabber.md) (v0.2.0) | Grok | Automatically downloads Grok's "Read Aloud" audio as `.wav`, named after the chat title. |

## Installing a script

1. Install [Tampermonkey](https://www.tampermonkey.net/) or [Violentmonkey](https://violentmonkey.github.io/) in your browser.
2. Open the raw `.user.js` file for the script you want (e.g. `YouTube/PlaylistPlus.user.js`) — your userscript manager will offer to install it. Alternatively, paste the file contents into a new userscript.
3. Visit the target site; the script activates on its matched pages automatically.

Each script's folder doc covers usage, how it works, and known limitations.

## Repo layout

```
ChatGPT/   chatgpt-tts-grabber.user.js  + doc
Grok/      grok-tts-grabber.user.js     + doc
YouTube/   PlaylistPlus.user.js         + doc + screenshot
           youtube-streamer-chat-highlight.user.js + doc + screenshot
```

## Status

Actively maintained. Scripts hook into site internals (DOM selectors, private APIs, `MediaSource`/`HTMLMediaElement` patching), so a site redesign can break them — file an [issue](https://github.com/dudebot/greasyfork-scripts/issues) if one stops working.

## License

MIT — see [LICENSE](LICENSE).
