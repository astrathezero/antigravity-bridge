// Antigravity Web Bridge - Content Script
// Runs in isolated world on gemini.google.com.
// Injects page.js into main execution world and relays messages to background worker.

(() => {
  'use strict';

  // Clean up any previous listener/port instances to prevent duplicates while allowing fresh re-binds
  if (typeof window.__ANTIGRAVITY_CLEANUP__ === 'function') {
    try { window.__ANTIGRAVITY_CLEANUP__(); } catch {}
  }

  console.log('[Antigravity Content] Content script initialized.');

  // ---- Extension Context Guard ----
  // Chrome throws "Extension context invalidated" synchronously when the service worker restarts.
  // .catch() doesn't catch synchronous throws, so we wrap every chrome.runtime call.
  let contextInvalidated = false;
  let reloadScheduled = false;

  function isContextInvalidated(e) {
    return e && typeof e.message === 'string' &&
      (e.message.includes('Extension context invalidated') ||
       e.message.includes('context invalidated') ||
       e.message.includes('Cannot read properties of undefined'));
  }

  function handleContextInvalidated() {
    if (contextInvalidated) return;
    contextInvalidated = true;
    console.warn('[Antigravity Content] Extension context invalidated — reloading page in 2s to restore connection...');
    // Clean up listeners so they don't fire during reload
    try { if (typeof window.__ANTIGRAVITY_CLEANUP__ === 'function') window.__ANTIGRAVITY_CLEANUP__(); } catch {}
    if (!reloadScheduled) {
      reloadScheduled = true;
      // Delay reload so any in-flight job result can still be read from the page
      setTimeout(() => { try { window.location.reload(); } catch {} }, 2000);
    }
  }

  // Safe wrapper around chrome.runtime.sendMessage
  function safeSend(msg) {
    if (contextInvalidated) return;
    try {
      const p = chrome.runtime.sendMessage(msg);
      if (p && typeof p.catch === 'function') {
        p.catch(e => {
          if (isContextInvalidated(e)) handleContextInvalidated();
        });
      }
    } catch (e) {
      if (isContextInvalidated(e)) {
        handleContextInvalidated();
      }
    }
  }

  // 1. Inject page.js into page context
  function injectPageScript() {
    try {
      const existing = document.getElementById('antigravity-page-script');
      if (existing) existing.remove();
      const script = document.createElement('script');
      script.id = 'antigravity-page-script';
      script.src = chrome.runtime.getURL('page.js?t=' + Date.now());
      (document.head || document.documentElement).appendChild(script);
    } catch (e) {
      console.warn('[Antigravity Content] Failed to inject page script:', e);
      if (isContextInvalidated(e)) handleContextInvalidated();
    }
  }
  injectPageScript();

  // 2. Keepalive port to background worker
  let port = null;
  function ensurePort() {
    if (contextInvalidated) return;
    try {
      if (!port) {
        port = chrome.runtime.connect({ name: 'gemini-tab' });
        port.onDisconnect.addListener(() => {
          port = null;
          if (!contextInvalidated) setTimeout(ensurePort, 2000);
        });
      }
    } catch (e) {
      if (isContextInvalidated(e)) {
        handleContextInvalidated();
      } else {
        setTimeout(ensurePort, 3000);
      }
    }
  }
  ensurePort();

  // Periodic heartbeat every 10s to keep worker from sleeping
  const heartbeatTimer = setInterval(() => {
    if (contextInvalidated) { clearInterval(heartbeatTimer); return; }
    try {
      if (port) {
        port.postMessage({ type: 'content-heartbeat', time: Date.now() });
      } else {
        ensurePort();
      }
      safeSend({ type: 'content-ping' });
    } catch (e) {
      if (isContextInvalidated(e)) handleContextInvalidated();
    }
  }, 10000);

  // 3. Listen to messages from page.js (DOM world)
  const onWindowMessage = (event) => {
    if (event.source !== window || !event.data || typeof event.data !== 'object') return;
    if (contextInvalidated) return;

    const msg = event.data;

    if (msg.type === 'AG_PAGE_READY' || msg.type === 'AG_DETECTED_EMAIL') {
      if (msg.email) {
        safeSend({ type: 'DETECTED_EMAIL', email: msg.email });
      }
    } else if (msg.type === 'AG_JOB_DELTA') {
      safeSend({ type: 'JOB_DELTA', jobId: msg.jobId, delta: msg.delta });
    } else if (msg.type === 'AG_JOB_DONE') {
      safeSend({ type: 'JOB_DONE', jobId: msg.jobId, text: msg.text, finishReason: msg.finishReason || 'stop' });
    } else if (msg.type === 'AG_JOB_ERROR') {
      safeSend({ type: 'JOB_ERROR', jobId: msg.jobId, error: msg.error });
    } else if (msg.type === 'AG_DEBUG') {
      safeSend({ type: 'DEBUG', debug: msg.debug });
    }
  };
  window.addEventListener('message', onWindowMessage);

  // 4. Listen for commands from background service worker
  const onRuntimeMessage = (message, sender, sendResponse) => {
    if (!message || !message.type) return;

    if (message.type === 'EXECUTE_JOB') {
      window.postMessage({ type: 'AG_EXECUTE_JOB', job: message.job }, '*');
      sendResponse({ status: 'dispatched' });
    } else if (message.type === 'CHECK_EMAIL') {
      window.postMessage({ type: 'AG_CHECK_EMAIL' }, '*');
      sendResponse({ status: 'checking' });
    }
    return true;
  };
  try {
    chrome.runtime.onMessage.addListener(onRuntimeMessage);
  } catch (e) {
    if (isContextInvalidated(e)) handleContextInvalidated();
  }

  window.__ANTIGRAVITY_CONTENT_INITIALIZED__ = true;

  window.__ANTIGRAVITY_CLEANUP__ = () => {
    window.removeEventListener('message', onWindowMessage);
    try { chrome.runtime.onMessage.removeListener(onRuntimeMessage); } catch {}
    clearInterval(heartbeatTimer);
    if (port) {
      try { port.disconnect(); } catch {}
      port = null;
    }
  };
})();
