// Antigravity Web Bridge - Offscreen Keepalive Script
// Runs in a persistent offscreen DOM context that Chrome does not discard.
// Prevents Manifest V3 Service Worker idle eviction (30s timeout)
// in headless Docker / 24/7 server environments.

let port = null;

function setupPort() {
  try {
    port = chrome.runtime.connect({ name: 'offscreen-keepalive' });
    port.onDisconnect.addListener(() => {
      port = null;
      setTimeout(setupPort, 1000);
    });
  } catch (err) {
    console.warn('[Antigravity Offscreen] Connect error:', err);
    setTimeout(setupPort, 2000);
  }
}

// Keep persistent port connection
setupPort();

// Dual-channel heartbeat every 10 seconds:
// 1. Port message to keep long-lived channel active
// 2. chrome.runtime.sendMessage to explicitly trigger an IPC event that resets Chrome's 30s idle timer
setInterval(() => {
  if (port) {
    try {
      port.postMessage({ type: 'offscreen-heartbeat', time: Date.now() });
    } catch {
      setupPort();
    }
  } else {
    setupPort();
  }

  chrome.runtime.sendMessage({ type: 'offscreen-ping', time: Date.now() }).catch(() => {});
}, 10000);
