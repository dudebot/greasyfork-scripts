// ==UserScript==
// @name         ChatGPT TTS Grabber
// @namespace    https://github.com/dudebot/greasyfork-scripts/tree/main/ChatGPT
// @version      1.1.0
// @description  Offer to download ChatGPT's TTS audio with a filename based on the chat title.
// @author       dudebot
// @license      MIT
// @supportURL   https://github.com/dudebot/greasyfork-scripts/issues
// @match        https://chat.openai.com/*
// @match        https://chatgpt.com/*
// @grant        none
// @downloadURL  https://update.greasyfork.org/scripts/536858/ChatGPT%20TTS%20Grabber.user.js
// @updateURL    https://update.greasyfork.org/scripts/536858/ChatGPT%20TTS%20Grabber.meta.js
// ==/UserScript==

(() => {
  const OrigMS = window.MediaSource;
  let latestTitleSlug = 'chatgpt';

  function updateTitleSlugFromBody(bodyText) {
    try {
      const json = JSON.parse(bodyText);
      const title = json && json.context && json.context.page && json.context.page.title;
      if (typeof title === 'string' && title.trim()) {
        let slug = title.trim().replace(/\s+/g, '_');
        slug = slug.replace(/[^\w\-]+/g, '');
        if (!slug) slug = 'chat';
        latestTitleSlug = slug;
      }
    } catch (e) {
      // ignore parse errors
    }
  }

  // hook fetch so we can grab context.page.title from /ces/v1/t
  const origFetch = window.fetch;
  window.fetch = function(input, init) {
    let url = '';
    if (typeof input === 'string') {
      url = input;
    } else if (input instanceof Request) {
      url = input.url;
    }

    if (url.includes('/ces/v1/t')) {
      // handle request object case
      if (input instanceof Request) {
        try {
          input.clone().text().then(updateTitleSlugFromBody).catch(() => {});
        } catch (e) {
          // ignore
        }
      } else if (init && typeof init.body === 'string') {
        updateTitleSlugFromBody(init.body);
      }
    }

    return origFetch.apply(this, arguments);
  };

  function showDownloadPrompt(url, mime) {
    const existing = document.getElementById('chatgpt-tts-download-prompt');
    if (existing) existing.remove();

    const ext = (mime.split('/')[1] || 'webm').split(';')[0];
    const safeSlug = latestTitleSlug || 'chatgpt';
    const filename = `${safeSlug}-${Date.now()}.${ext}`;

    const wrapper = document.createElement('div');
    wrapper.id = 'chatgpt-tts-download-prompt';
    wrapper.style.position = 'fixed';
    wrapper.style.right = '20px';
    wrapper.style.bottom = '20px';
    wrapper.style.zIndex = '999999';
    wrapper.style.background = '#111';
    wrapper.style.color = '#fff';
    wrapper.style.padding = '12px 16px';
    wrapper.style.borderRadius = '8px';
    wrapper.style.boxShadow = '0 4px 12px rgba(0,0,0,0.4)';
    wrapper.style.fontFamily = 'system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif';
    wrapper.style.fontSize = '13px';
    wrapper.style.display = 'flex';
    wrapper.style.flexDirection = 'column';
    wrapper.style.gap = '8px';

    const text = document.createElement('div');
    text.textContent = 'download chatgpt tts audio?';

    const btnRow = document.createElement('div');
    btnRow.style.display = 'flex';
    btnRow.style.gap = '8px';
    btnRow.style.justifyContent = 'flex-end';

    const downloadBtn = document.createElement('button');
    downloadBtn.textContent = 'download';
    downloadBtn.style.cursor = 'pointer';
    downloadBtn.style.border = 'none';
    downloadBtn.style.borderRadius = '4px';
    downloadBtn.style.padding = '6px 10px';
    downloadBtn.style.fontSize = '12px';
    downloadBtn.style.fontWeight = '500';
    downloadBtn.style.background = '#10a37f';
    downloadBtn.style.color = '#fff';

    const cancelBtn = document.createElement('button');
    cancelBtn.textContent = 'cancel';
    cancelBtn.style.cursor = 'pointer';
    cancelBtn.style.border = '1px solid #444';
    cancelBtn.style.borderRadius = '4px';
    cancelBtn.style.padding = '6px 10px';
    cancelBtn.style.fontSize = '12px';
    cancelBtn.style.background = '#222';
    cancelBtn.style.color = '#eee';

    function cleanup() {
      URL.revokeObjectURL(url);
      wrapper.remove();
    }

    downloadBtn.addEventListener('click', () => {
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      cleanup();
    });

    cancelBtn.addEventListener('click', () => {
      cleanup();
    });

    btnRow.appendChild(cancelBtn);
    btnRow.appendChild(downloadBtn);
    wrapper.appendChild(text);
    wrapper.appendChild(btnRow);
    document.body.appendChild(wrapper);
  }

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
          showDownloadPrompt(url, mime);
        });
      }

      return sb;
    };

    return ms;
  };

  window.MediaSource.prototype = OrigMS.prototype;
  MediaSource.isTypeSupported = OrigMS.isTypeSupported;
})();
