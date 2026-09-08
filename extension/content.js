// Antigravity Web Bridge - Content Script
// Runs in isolated world on gemini.google.com.
// Injects page.js into main execution world and relays messages to background worker.

(() => {
  'use strict';

  console.log('[Antigravity Content] Injecting page script...');

  // 1. Inject page.js into page context
  const script = document.createElement('script');
  script.src = chrome.runtime.getURL('page.js');
  script.onload = () => {
    script.remove();
  };
  (document.head || document.documentElement).appendChild(script);

  // 2. Keepalive port to background worker
  let port = null;
  function ensurePort() {
    try {
      if (!port) {
        port = chrome.runtime.connect({ name: 'gemini-tab' });
        port.onDisconnect.addListener(() => {
          port = null;
          setTimeout(ensurePort, 2000);
        });
      }
    } catch (e) {
      setTimeout(ensurePort, 3000);
    }
  }
  ensurePort();

  // Periodic heartbeat every 10s to keep worker from sleeping
  setInterval(() => {
    try {
      if (port) {
        port.postMessage({ type: 'content-heartbeat', time: Date.now() });
      } else {
        ensurePort();
      }
      chrome.runtime.sendMessage({ type: 'content-ping' }).catch(() => {});
    } catch {}
  }, 10000);

  // 3. Listen to messages from page.js (DOM world)
  window.addEventListener('message', (event) => {
    if (event.source !== window || !event.data || typeof event.data !== 'object') return;

    const msg = event.data;

    if (msg.type === 'AG_PAGE_READY' || msg.type === 'AG_DETECTED_EMAIL') {
      if (msg.email) {
        chrome.runtime.sendMessage({
          type: 'DETECTED_EMAIL',
          email: msg.email
        }).catch(() => {});
      }
    } else if (msg.type === 'AG_JOB_DELTA') {
      chrome.runtime.sendMessage({
        type: 'JOB_DELTA',
        jobId: msg.jobId,
        delta: msg.delta
      }).catch(() => {});
    } else if (msg.type === 'AG_JOB_DONE') {
      chrome.runtime.sendMessage({
        type: 'JOB_DONE',
        jobId: msg.jobId,
        text: msg.text,
        finishReason: msg.finishReason || 'stop'
      }).catch(() => {});
    } else if (msg.type === 'AG_JOB_ERROR') {
      chrome.runtime.sendMessage({
        type: 'JOB_ERROR',
        jobId: msg.jobId,
        error: msg.error
      }).catch(() => {});
    }
  });

  // 4. Listen for commands from background service worker
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || !message.type) return;

    if (message.type === 'EXECUTE_JOB') {
      window.postMessage({
        type: 'AG_EXECUTE_JOB',
        job: message.job
      }, '*');
      sendResponse({ status: 'dispatched' });
    } else if (message.type === 'CHECK_EMAIL') {
      window.postMessage({
        type: 'AG_CHECK_EMAIL'
      }, '*');
      sendResponse({ status: 'checking' });
    }
    return true;
  });
})();
