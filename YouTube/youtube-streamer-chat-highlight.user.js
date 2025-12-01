// ==UserScript==
// @name         YouTube Streamer Chat Highlight
// @namespace    https://github.com/dudebot/greasyfork-scripts
// @version      1.1.0
// @description  Collects streamer messages from live chat into a persistent panel that doesn't truncate
// @author       dudebot
// @license      MIT
// @supportURL   https://github.com/dudebot/greasyfork-scripts/issues
// @match        https://www.youtube.com/watch*
// @match        https://www.youtube.com/live/*
// @match        https://www.youtube.com/live_chat*
// @grant        none
// ==/UserScript==

(() => {
  const STORAGE_KEY = 'yt-streamer-chat-enabled';
  const MESSAGE_TYPE = 'yt-streamer-chat-message';

  // Detect if we're in the chat iframe or main page
  const isInChatIframe = window.location.pathname.startsWith('/live_chat');

  if (isInChatIframe) {
    runInChatIframe();
  } else {
    runInMainPage();
  }

  // ============ CHAT IFRAME CONTEXT ============
  function runInChatIframe() {
    console.log('[Streamer Chat] Running in chat iframe');
    let seenMessages = new Set();
    let observer = null;

    function checkAndSendOwnerMessage(node) {
      const isOwner = node.getAttribute('author-type') === 'owner';
      if (!isOwner) return;

      const authorEl = node.querySelector('#author-name');
      const messageEl = node.querySelector('#message');
      const timestampEl = node.querySelector('#timestamp');
      const authorPhotoEl = node.querySelector('#author-photo img');

      if (authorEl && messageEl) {
        const authorName = authorEl.textContent.trim();
        const messageText = messageEl.textContent.trim();
        const timestamp = timestampEl?.textContent?.trim() || new Date().toLocaleTimeString();
        const msgKey = `${authorName}-${timestamp}-${messageText}`;

        if (seenMessages.has(msgKey)) return;
        seenMessages.add(msgKey);

        // Clone message HTML to preserve emojis
        const messageHtml = messageEl.innerHTML;
        const authorPhotoSrc = authorPhotoEl?.src || '';

        // Send to parent window
        window.parent.postMessage({
          type: MESSAGE_TYPE,
          authorName,
          messageHtml,
          messageText,
          timestamp,
          authorPhotoSrc
        }, '*');

        console.log('[Streamer Chat] Sent owner message:', authorName, messageText);
      }
    }

    function scanExistingMessages() {
      const messages = document.querySelectorAll('yt-live-chat-text-message-renderer, yt-live-chat-paid-message-renderer');
      console.log('[Streamer Chat] Scanning existing messages:', messages.length);
      messages.forEach(checkAndSendOwnerMessage);
    }

    function setupObserver() {
      const chatContainer = document.querySelector('yt-live-chat-item-list-renderer #items');
      if (!chatContainer) {
        console.log('[Streamer Chat] Chat container not found, retrying...');
        setTimeout(setupObserver, 1000);
        return;
      }

      observer = new MutationObserver((mutations) => {
        mutations.forEach((mutation) => {
          mutation.addedNodes.forEach((node) => {
            if (node.nodeType === 1) {
              checkAndSendOwnerMessage(node);
            }
          });
        });
      });

      observer.observe(chatContainer, { childList: true });
      console.log('[Streamer Chat] Observer attached to chat');

      // Scan existing messages
      scanExistingMessages();
    }

    // Wait for chat to load
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', setupObserver);
    } else {
      setupObserver();
    }
  }

  // ============ MAIN PAGE CONTEXT ============
  function runInMainPage() {
    console.log('[Streamer Chat] Running in main page');
    let enabled = localStorage.getItem(STORAGE_KEY) !== 'false';
    let panel = null;
    let messageContainer = null;

    // Create a TrustedTypes policy for innerHTML (YouTube's CSP requires this)
    let trustedPolicy = null;
    if (window.trustedTypes && trustedTypes.createPolicy) {
      try {
        trustedPolicy = trustedTypes.createPolicy('streamerChatPolicy', {
          createHTML: (string) => string
        });
      } catch (e) {
        // Policy might already exist or not be allowed
        console.log('[Streamer Chat] Could not create TrustedTypes policy:', e);
      }
    }

    function safeSetInnerHTML(element, html) {
      if (trustedPolicy) {
        element.innerHTML = trustedPolicy.createHTML(html);
      } else {
        element.innerHTML = html;
      }
    }

    function createPanel() {
      if (panel) return;

      panel = document.createElement('div');
      panel.id = 'streamer-chat-panel';
      panel.style.cssText = `
        background: #0f0f0f;
        border: 1px solid #3f3f3f;
        border-radius: 8px;
        margin-bottom: 8px;
        max-height: 200px;
        display: flex;
        flex-direction: column;
        overflow: hidden;
      `;

      // Header with toggle
      const header = document.createElement('div');
      header.style.cssText = `
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 8px 12px;
        border-bottom: 1px solid #3f3f3f;
        background: #1a1a1a;
        flex-shrink: 0;
      `;

      const title = document.createElement('span');
      title.textContent = 'Streamer Messages';
      title.style.cssText = `
        color: #fff;
        font-size: 13px;
        font-weight: 500;
      `;

      const toggle = createToggle();

      header.appendChild(title);
      header.appendChild(toggle);

      // Message container
      messageContainer = document.createElement('div');
      messageContainer.style.cssText = `
        flex: 1;
        overflow-y: auto;
        padding: 8px;
      `;

      const placeholder = document.createElement('div');
      placeholder.id = 'streamer-chat-placeholder';
      placeholder.textContent = 'No streamer messages yet...';
      placeholder.style.cssText = `
        color: #aaa;
        font-size: 12px;
        text-align: center;
        padding: 16px;
      `;
      messageContainer.appendChild(placeholder);

      panel.appendChild(header);
      panel.appendChild(messageContainer);

      updatePanelVisibility();
    }

    function createToggle() {
      const toggle = document.createElement('label');
      toggle.style.cssText = `
        position: relative;
        display: inline-block;
        width: 36px;
        height: 20px;
        cursor: pointer;
      `;

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = enabled;
      checkbox.style.cssText = 'opacity: 0; width: 0; height: 0;';

      const slider = document.createElement('span');
      slider.style.cssText = `
        position: absolute;
        top: 0; left: 0; right: 0; bottom: 0;
        background-color: ${enabled ? '#3ea6ff' : '#444'};
        border-radius: 20px;
        transition: background-color 0.2s;
      `;

      const knob = document.createElement('span');
      knob.style.cssText = `
        position: absolute;
        height: 14px;
        width: 14px;
        left: ${enabled ? '19px' : '3px'};
        bottom: 3px;
        background-color: white;
        border-radius: 50%;
        transition: left 0.2s;
      `;

      checkbox.addEventListener('change', () => {
        enabled = checkbox.checked;
        localStorage.setItem(STORAGE_KEY, enabled ? 'true' : 'false');
        slider.style.backgroundColor = enabled ? '#3ea6ff' : '#444';
        knob.style.left = enabled ? '19px' : '3px';
        updatePanelVisibility();
      });

      slider.appendChild(knob);
      toggle.appendChild(checkbox);
      toggle.appendChild(slider);

      return toggle;
    }

    function updatePanelVisibility() {
      if (!panel || !messageContainer) return;
      if (enabled) {
        messageContainer.style.display = 'block';
      } else {
        messageContainer.style.display = 'none';
      }
    }

    function injectPanel() {
      if (document.getElementById('streamer-chat-panel')) return;

      createPanel();

      const chatContainer = document.querySelector('ytd-live-chat-frame') ||
                            document.querySelector('#chat-container') ||
                            document.querySelector('#secondary #chat');
      if (chatContainer) {
        chatContainer.parentElement.insertBefore(panel, chatContainer);
        console.log('[Streamer Chat] Panel injected');
      } else {
        console.log('[Streamer Chat] Could not find chat container');
      }
    }

    function addStreamerMessage(data) {
      if (!messageContainer) {
        console.log('[Streamer Chat] messageContainer not ready, queuing message');
        // Queue the message and retry
        setTimeout(() => addStreamerMessage(data), 500);
        return;
      }

      // Remove placeholder if exists
      const placeholder = document.getElementById('streamer-chat-placeholder');
      if (placeholder) placeholder.remove();

      const msgDiv = document.createElement('div');
      msgDiv.style.cssText = `
        display: flex;
        align-items: flex-start;
        gap: 8px;
        padding: 6px 8px;
        border-radius: 4px;
        margin-bottom: 4px;
      `;

      // Profile picture
      if (data.authorPhotoSrc) {
        const pfp = document.createElement('img');
        pfp.src = data.authorPhotoSrc;
        pfp.style.cssText = 'width: 24px; height: 24px; border-radius: 50%; flex-shrink: 0;';
        msgDiv.appendChild(pfp);
      }

      // Message content (inline format)
      const contentWrapper = document.createElement('div');
      contentWrapper.style.cssText = 'flex: 1; min-width: 0;';

      const inlineContent = document.createElement('span');
      inlineContent.style.cssText = 'color: #fff; font-size: 13px; line-height: 1.4;';

      const name = document.createElement('span');
      name.textContent = data.authorName;
      name.style.cssText = `
        color: rgba(0, 0, 0, 0.87);
        font-weight: 500;
        margin-right: 6px;
        background-color: #ffd600;
        padding: 2px 4px;
        border-radius: 2px;
      `;

      const content = document.createElement('span');
      safeSetInnerHTML(content, data.messageHtml);
      content.style.cssText = 'display: inline;';
      content.querySelectorAll('img').forEach(img => {
        img.style.cssText = 'height: 18px; width: 18px; vertical-align: middle;';
      });

      inlineContent.appendChild(name);
      inlineContent.appendChild(content);
      contentWrapper.appendChild(inlineContent);

      // Timestamp on the right
      const time = document.createElement('span');
      time.textContent = data.timestamp;
      time.style.cssText = 'color: #aaa; font-size: 11px; flex-shrink: 0; margin-left: 8px;';

      msgDiv.appendChild(contentWrapper);
      msgDiv.appendChild(time);

      messageContainer.appendChild(msgDiv);
      messageContainer.scrollTop = messageContainer.scrollHeight;
    }

    // Listen for messages from chat iframe
    window.addEventListener('message', (event) => {
      if (event.data?.type === MESSAGE_TYPE) {
        console.log('[Streamer Chat] Received message from iframe:', event.data);
        addStreamerMessage(event.data);
      }
    });

    function init() {
      // Wait for page to be ready
      const checkReady = setInterval(() => {
        const chatFrame = document.querySelector('ytd-live-chat-frame');
        if (chatFrame) {
          clearInterval(checkReady);
          injectPanel();
        }
      }, 500);

      // Re-inject on navigation (YouTube is SPA)
      let lastUrl = location.href;
      new MutationObserver(() => {
        if (location.href !== lastUrl) {
          lastUrl = location.href;
          setTimeout(injectPanel, 1000);
        }
      }).observe(document.body, { childList: true, subtree: true });
    }

    init();
  }
})();
