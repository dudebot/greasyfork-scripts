# YouTube Streamer Chat Highlight

A Tampermonkey/Greasemonkey userscript that **captures streamer/owner messages from YouTube live chat** into a persistent panel that doesn't get truncated as chat scrolls.

## Features

- Automatically detects messages from the channel owner (streamer) in live chat
- Displays them in a dedicated panel above the chat that persists even as new messages scroll the original away
- Preserves emojis and custom channel emotes
- Shows streamer profile picture, name with yellow highlight (matching YouTube's style), message content, and timestamp
- Toggle on/off with a switch in the panel header
- Remembers your preference via localStorage
- Works on both `/watch` and `/live/` YouTube URLs

## Installation

1. Install [Tampermonkey](https://www.tampermonkey.net/) (or similar userscript manager)
2. Install the script via [GreasyFork](https://greasyfork.org/) (link coming soon) or from [this GitHub repo](https://github.com/dudebot/greasyfork-scripts)
3. Visit any YouTube live stream with chat enabled
4. The "Streamer Messages" panel will appear above the chat

## How It Works

YouTube embeds live chat in an iframe. This script runs in both contexts:

1. **Inside the chat iframe**: Observes the chat message list for new messages, detects owner messages via the `author-type="owner"` attribute, and sends them to the parent page via `postMessage`

2. **On the main watch page**: Creates the UI panel, listens for messages from the iframe, and displays them with proper styling

This dual-context approach ensures reliable message capture even with YouTube's iframe-based chat architecture.

## Known Limitations

- Only captures messages while the page is open (no historical backfill from before you loaded the page, though existing messages are scanned on load)
- Messages are stored in memory only; refreshing the page clears the panel
- No export functionality (yet)

## Contributing

Feel free to fork or submit issues and improvements on [GitHub](https://github.com/dudebot/greasyfork-scripts).

## License

MIT
