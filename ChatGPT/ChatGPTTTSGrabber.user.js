// ==UserScript==
// @name         ChatGPT TTS Grabber
// @namespace    https://github.com/dudebot/
// @version      1.0.0
// @description  Automatically downloads ChatGPT's TTS audio whenever playback is triggered.
// @author       dudebot
// @license      MIT
// @supportURL   https://github.com/dudebot/greasyfork-scripts/issues
// @match        https://chat.openai.com/*
// @match        https://chatgpt.com/*
// @grant        none
// ==/UserScript==

// ==UserScript== Extended Description ==
// This script captures and automatically downloads the TTS audio played by ChatGPT.
// It works by hooking into the browser's MediaSource API to reconstruct streamed audio,
// saving each playback as a downloadable file (e.g., .webm or .aac).
//
// ==/UserScript==

(() => {
  const OrigMS = window.MediaSource;
  window.MediaSource = function() {
    const ms = new OrigMS();
    const origAdd = ms.addSourceBuffer.bind(ms);
    ms.addSourceBuffer = mime => {
      const sb = origAdd(mime);
      if (mime.startsWith('audio/')) {
        const chunks = [];
        const origAppend = sb.appendBuffer.bind(sb);
        sb.appendBuffer = buf => {
          chunks.push(buf.slice(0));
          origAppend(buf);
        };
        // when the player calls endOfStream:
        ms.addEventListener('sourceended', () => {
          const blob = new Blob(chunks, { type: mime });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = `chatgpt-${Date.now()}.${mime.split('/')[1]}`;
          a.click();
        });
      }
      return sb;
    };
    return ms;
  };
  window.MediaSource.prototype = OrigMS.prototype;
  MediaSource.isTypeSupported = OrigMS.isTypeSupported;
})();
