// ==UserScript==
// @name         Grok TTS Grabber
// @namespace    https://github.com/dudebot/greasyfork-scripts/tree/main/Grok
// @version      0.2.0
// @description  Automatically downloads Grok's "Read Aloud" TTS audio with a filename based on the chat title.
// @author       dudebot
// @license      MIT
// @supportURL   https://github.com/dudebot/greasyfork-scripts/issues
// @match        https://grok.com/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(() => {
  'use strict';

  // Grok serves "Read Aloud" audio from a stable same-origin URL that an <audio>
  // element points at, e.g.:
  //   https://grok.com/http/app-chat/read-response-audio-file/<responseId>?voiceId=Ara
  // It is a plain GET that returns audio/wav, so we just re-fetch it (with cookies)
  // and download the bytes. The fetch/MediaSource hooks below are defensive
  // fallbacks in case Grok changes delivery later.
  const AUDIO_URL_RX = /read-response-audio-file|\/tts|\/audio|\/synthesize/i;

  const seen = new Set();
  let latestTitleSlug = 'grok';

  function slugify(text) {
    return (text || '')
      .trim()
      .replace(/\s+/g, '_')
      .replace(/[^\w\-]+/g, '')
      .slice(0, 60) || 'grok';
  }

  function updateTitle() {
    // Chat title shows up as "<Chat title> - Grok" in document.title.
    const title = (document.title || '').replace(/\s*[-–|]\s*Grok\s*$/i, '');
    const slug = slugify(title);
    if (slug && slug !== 'grok') latestTitleSlug = slug;
  }

  function extFromMime(mime, magic) {
    if (magic && magic.startsWith('RIFF')) return 'wav';
    if (magic && magic.startsWith('OggS')) return 'ogg';
    if (magic && (magic.startsWith('ID3') || magic.charCodeAt(0) === 0xff)) return 'mp3';
    if (!mime) return 'wav';
    if (mime.includes('wav')) return 'wav';
    if (mime.includes('mpeg') || mime.includes('mp3')) return 'mp3';
    if (mime.includes('ogg')) return 'ogg';
    if (mime.includes('webm')) return 'webm';
    if (mime.includes('aac')) return 'aac';
    return (mime.split('/')[1] || 'wav').split(';')[0];
  }

  function download(blob, ext) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${latestTitleSlug}-${Date.now()}.${ext}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  // Re-fetch a known audio URL and download it.
  async function grabFromUrl(rawUrl) {
    let url;
    try { url = new URL(rawUrl, location.href).href; } catch { return; }
    if (!AUDIO_URL_RX.test(url) || seen.has(url)) return;
    seen.add(url);
    try {
      const resp = await fetch(url, { credentials: 'include' });
      if (!resp.ok) { seen.delete(url); return; }
      const buf = await resp.arrayBuffer();
      if (buf.byteLength < 1000) { seen.delete(url); return; }
      const magic = String.fromCharCode(...new Uint8Array(buf.slice(0, 4)));
      const ct = resp.headers.get('content-type') || '';
      const ext = extFromMime(ct, magic);
      updateTitle();
      console.log(`[GrokTTS] Captured ${buf.byteLength} bytes (${ct || 'unknown'}) -> .${ext}`);
      download(new Blob([buf], { type: ct || `audio/${ext}` }), ext);
    } catch (e) {
      seen.delete(url);
    }
  }

  // --- Primary: watch <audio>/<video> src for the read-aloud URL ---
  const mediaProto = HTMLMediaElement.prototype;
  const srcDesc = Object.getOwnPropertyDescriptor(mediaProto, 'src');
  if (srcDesc && srcDesc.set) {
    Object.defineProperty(mediaProto, 'src', {
      configurable: true,
      get: srcDesc.get,
      set(val) {
        try { if (typeof val === 'string') grabFromUrl(val); } catch (e) {}
        return srcDesc.set.call(this, val);
      },
    });
  }

  const origSetAttr = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function (name, value) {
    try {
      if (this instanceof HTMLMediaElement && String(name).toLowerCase() === 'src') {
        grabFromUrl(value);
      }
    } catch (e) {}
    return origSetAttr.apply(this, arguments);
  };

  // --- Fallback: hook fetch for audio responses (in case delivery changes) ---
  const origFetch = window.fetch;
  window.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    const p = origFetch.apply(this, arguments);
    if (AUDIO_URL_RX.test(url)) {
      p.then((resp) => {
        const ct = resp.headers.get('content-type') || '';
        if (!ct.startsWith('audio/')) return;
        if (seen.has(new URL(url, location.href).href)) return;
        resp.clone().arrayBuffer().then((buf) => {
          if (buf.byteLength < 1000) return;
          const magic = String.fromCharCode(...new Uint8Array(buf.slice(0, 4)));
          const ext = extFromMime(ct, magic);
          updateTitle();
          console.log(`[GrokTTS] Captured via fetch: ${buf.byteLength} bytes (${ct})`);
          download(new Blob([buf], { type: ct }), ext);
        }).catch(() => {});
      }).catch(() => {});
    }
    return p;
  };

  // --- Fallback: MediaSource streaming (kept from earlier stub) ---
  const OrigMS = window.MediaSource;
  if (OrigMS) {
    window.MediaSource = function () {
      const ms = new OrigMS();
      const origAdd = ms.addSourceBuffer.bind(ms);
      ms.addSourceBuffer = (mime) => {
        const sb = origAdd(mime);
        if (mime.startsWith('audio/')) {
          const chunks = [];
          const origAppend = sb.appendBuffer.bind(sb);
          sb.appendBuffer = (buf) => {
            chunks.push(buf instanceof ArrayBuffer ? buf.slice(0) : buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
            origAppend(buf);
          };
          ms.addEventListener('sourceended', () => {
            const blob = new Blob(chunks, { type: mime });
            if (blob.size > 1000) {
              updateTitle();
              console.log(`[GrokTTS] Captured via MediaSource: ${blob.size} bytes`);
              download(blob, extFromMime(mime));
            }
          }, { once: true });
        }
        return sb;
      };
      return ms;
    };
    window.MediaSource.prototype = OrigMS.prototype;
    window.MediaSource.isTypeSupported = OrigMS.isTypeSupported.bind(OrigMS);
  }

  if (document.title) updateTitle();
  document.addEventListener('DOMContentLoaded', updateTitle);

  console.log('[GrokTTS] Grabber active — watching for Read Aloud audio.');
})();
