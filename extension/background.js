// Antigravity Web Bridge - Background Service Worker
// Maintains long-lived SSE connection to Antigravity Bridge server (port 8000),
// dispatches prompt jobs to open gemini.google.com tabs, and relays response streams.

const DEFAULT_BRIDGE = 'http://127.0.0.1:8000';
const RECONNECT_INTERVAL_MS = 3000;
const CYCLE_MS = 4 * 60 * 1000; // proactively cycle connection before browser stream timeout

let sseAbortController = null;
let isConnected = false;
let lastError = '';
let currentClientId = '';
let activeJobs = new Map(); // jobId -> { tabId, startTime }
let offscreenSetupPromise = null;

// 1. Worker Lifecycle Touch & Offscreen Keepalive Document Management
function touchWorker() {
  try {
    chrome.storage.local.get('lastTouch').catch(() => {});
  } catch {}
}

async function ensureOffscreenDocument() {
  if (typeof chrome.offscreen === 'undefined') return;
  if (offscreenSetupPromise) return offscreenSetupPromise;

  offscreenSetupPromise = (async () => {
    try {
      if (await chrome.offscreen.hasDocument?.()) return;
      await chrome.offscreen.createDocument({
        url: 'offscreen.html',
        reasons: ['BLOBS', 'MATCH_MEDIA'],
        justification: 'Keep service worker and SSE stream alive 24/7 for Antigravity web bridge'
      });
    } catch (err) {
      if (!/single offscreen document/i.test(String(err?.message ?? err))) {
        console.warn('[Antigravity BG] Offscreen creation notice:', err);
      }
    } finally {
      offscreenSetupPromise = null;
    }
  })();
  return offscreenSetupPromise;
}

// 2. Storage Helpers
async function getConfig() {
  try {
    const res = await chrome.storage.local.get(['bridgeUrl', 'assignedProfile', 'activeEmail', 'webEnabled', 'preferredWebModel']);
    return {
      bridgeUrl: res.bridgeUrl || DEFAULT_BRIDGE,
      assignedProfile: res.assignedProfile || '',
      activeEmail: res.activeEmail || '',
      webEnabled: res.webEnabled !== false, // default true
      preferredWebModel: res.preferredWebModel || 'gemini-2.0-flash-thinking'
    };
  } catch {
    return {
      bridgeUrl: DEFAULT_BRIDGE,
      assignedProfile: '',
      activeEmail: '',
      webEnabled: true,
      preferredWebModel: 'gemini-2.0-flash-thinking'
    };
  }
}

// 3. HTTP Helpers to Bridge Server
async function postToBridge(path, data) {
  const cfg = await getConfig();
  const url = `${cfg.bridgeUrl.replace(/\/+$/, '')}${path}`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    if (!res.ok) {
      console.warn(`[Antigravity BG] Bridge refused ${path} with HTTP ${res.status}`);
    }
    return res.ok;
  } catch (err) {
    console.error(`[Antigravity BG] Error posting to bridge ${path}:`, err);
    return false;
  }
}

// 4. Tab Discovery and Creation for gemini.google.com
async function findOrOpenGeminiTab(job) {
  const cfg = await getConfig();
  const tabs = await chrome.tabs.query({ url: ['https://gemini.google.com/*', 'https://*.gemini.google.com/*'] });
  if (tabs.length > 0) {
    // Account-aware tab matching: Google accounts often use /u/1/ for secondary profiles
    if (cfg.activeEmail && /somporn/i.test(cfg.activeEmail)) {
      const u1Tab = tabs.find(t => t.url && t.url.includes('/u/1/') && !t.discarded);
      if (u1Tab) return u1Tab;
    } else if (cfg.activeEmail && /attasit/i.test(cfg.activeEmail)) {
      const defaultTab = tabs.find(t => t.url && !t.url.includes('/u/1/') && !t.discarded);
      if (defaultTab) return defaultTab;
    }

    const nonDiscarded = tabs.find(t => !t.discarded && t.status === 'complete');
    if (nonDiscarded) return nonDiscarded;
    return tabs[0];
  }

  // No tab exists, open one
  const targetUrl = (cfg.activeEmail && /somporn/i.test(cfg.activeEmail))
    ? 'https://gemini.google.com/u/1/app'
    : 'https://gemini.google.com/app';
  const newTab = await chrome.tabs.create({ url: targetUrl, active: false });
  // Wait for tab to complete loading
  await new Promise((resolve) => {
    const listener = (tabId, info) => {
      if (tabId === newTab.id && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
    setTimeout(resolve, 10000); // 10s fallback timeout
  });
  return newTab;
}

// 5. Job Dispatcher
async function handleJobEvent(job) {
  const jobId = job.jobId || job.job_id;
  const cfg = await getConfig();

  if (!cfg.webEnabled) {
    await postToBridge('/extension/error', {
      job_id: jobId,
      error: `Web extension channel is currently disabled in extension settings for profile '${job.profile}'.`
    });
    return;
  }

  // Default to best Flash Thinking model
  job.model = job.model && job.model !== 'gemini-web' && job.model !== 'default' 
    ? job.model 
    : (cfg.preferredWebModel || 'gemini-2.0-flash-thinking');

  console.log(`[Antigravity BG] Processing job ${jobId} (profile=${job.profile}, model=${job.model})`);

  try {
    const tab = await findOrOpenGeminiTab(job);
    if (!tab || !tab.id) {
      throw new Error('Could not acquire or open a gemini.google.com tab.');
    }

    activeJobs.set(jobId, { tabId: tab.id, startTime: Date.now() });

    // Send command to content script in tab
    chrome.tabs.sendMessage(tab.id, { type: 'EXECUTE_JOB', job }, async (response) => {
      if (chrome.runtime.lastError) {
        console.warn('[Antigravity BG] Error communicating with tab content script:', chrome.runtime.lastError.message);
        // Fallback injection if needed
        try {
          await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            files: ['content.js']
          });
          setTimeout(() => {
            chrome.tabs.sendMessage(tab.id, { type: 'EXECUTE_JOB', job });
          }, 500);
        } catch (injErr) {
          await postToBridge('/extension/error', {
            job_id: jobId,
            error: `Failed to dispatch to tab: ${injErr.message}`
          });
        }
      }
    });
  } catch (err) {
    await postToBridge('/extension/error', {
      job_id: jobId,
      error: `Job dispatch failed: ${err.message}`
    });
  }
}

// 6. SSE Connection Management
async function connectSSE() {
  if (sseAbortController) {
    try { sseAbortController.abort(); } catch {}
    sseAbortController = null;
  }

  await ensureOffscreenDocument();
  const cfg = await getConfig();

  const queryParams = new URLSearchParams();
  if (cfg.assignedProfile) queryParams.set('profile', cfg.assignedProfile);
  if (cfg.activeEmail) queryParams.set('email', cfg.activeEmail);

  const sseUrl = `${cfg.bridgeUrl.replace(/\/+$/, '')}/extension/events?${queryParams.toString()}`;
  console.log(`[Antigravity BG] Connecting to SSE: ${sseUrl}`);

  sseAbortController = new AbortController();
  const signal = sseAbortController.signal;

  try {
    const response = await fetch(sseUrl, {
      method: 'GET',
      headers: { 'Accept': 'text/event-stream' },
      signal
    });

    if (!response.ok) {
      throw new Error(`SSE connection failed with HTTP status ${response.status}`);
    }

    isConnected = true;
    lastError = '';
    console.log('[Antigravity BG] SSE connected successfully.');

    // Cycle connection before browser long-fetch limit
    const cycleTimer = setTimeout(() => {
      console.log('[Antigravity BG] Cycling SSE connection...');
      connectSSE();
    }, CYCLE_MS);

    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      touchWorker();

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      let currentEvent = 'message';
      let currentData = '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) {
          // Dispatch accumulated event
          if (currentData) {
            try {
              const parsed = JSON.parse(currentData);
              if (currentEvent === 'connected') {
                currentClientId = parsed.clientId || '';
                console.log(`[Antigravity BG] Registered with bridge as clientId=${currentClientId}`);
              } else if (currentEvent === 'job') {
                handleJobEvent(parsed);
              }
            } catch (e) {
              console.warn('[Antigravity BG] Failed to parse SSE event data:', currentData, e);
            }
          }
          currentEvent = 'message';
          currentData = '';
          continue;
        }

        if (trimmed.startsWith('event:')) {
          currentEvent = trimmed.slice(6).trim();
        } else if (trimmed.startsWith('data:')) {
          currentData = trimmed.slice(5).trim();
        }
      }
    }

    clearTimeout(cycleTimer);
  } catch (err) {
    if (signal.aborted) return;
    isConnected = false;
    lastError = String(err?.message ?? err);
    console.warn(`[Antigravity BG] SSE disconnected (${lastError}). Retrying in ${RECONNECT_INTERVAL_MS}ms...`);
    setTimeout(connectSSE, RECONNECT_INTERVAL_MS);
  }
}

// 7. Keepalive Port Listener
chrome.runtime.onConnect.addListener((port) => {
  touchWorker();
  if (port.name === 'keepalive' || port.name === 'gemini-tab' || port.name === 'offscreen-keepalive') {
    port.onMessage.addListener(() => {
      touchWorker();
    });
    port.onDisconnect.addListener(() => {
      void chrome.runtime.lastError;
      ensureOffscreenDocument();
    });
  }
});

// 8. Extension Message Router (from Content Scripts & Popup)
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  touchWorker();
  if (!message || !message.type) return;

  if (message.type === 'offscreen-ping' || message.type === 'content-ping') {
    sendResponse({ ok: true, awake: true, timestamp: Date.now() });
    return true;
  }

  if (message.type === 'JOB_DELTA') {
    postToBridge('/extension/delta', {
      job_id: message.jobId,
      delta: message.delta
    });
  } else if (message.type === 'JOB_DONE') {
    activeJobs.delete(message.jobId);
    postToBridge('/extension/done', {
      job_id: message.jobId,
      text: message.text,
      finish_reason: message.finishReason || 'stop'
    });
  } else if (message.type === 'JOB_ERROR') {
    activeJobs.delete(message.jobId);
    postToBridge('/extension/error', {
      job_id: message.jobId,
      error: message.error
    });
  } else if (message.type === 'DETECTED_EMAIL') {
    if (message.email) {
      chrome.storage.local.get(['activeEmail'], (res) => {
        if (res.activeEmail !== message.email) {
          chrome.storage.local.set({ activeEmail: message.email }, () => {
            console.log(`[Antigravity BG] Detected new account email: ${message.email}. Re-registering...`);
            connectSSE();
          });
        }
      });
    }
  } else if (message.type === 'GET_STATUS') {
    getConfig().then(cfg => {
      sendResponse({
        connected: isConnected,
        lastError,
        clientId: currentClientId,
        bridgeUrl: cfg.bridgeUrl,
        assignedProfile: cfg.assignedProfile,
        activeEmail: cfg.activeEmail,
        webEnabled: cfg.webEnabled,
        preferredWebModel: cfg.preferredWebModel
      });
    });
    return true; // async sendResponse
  } else if (message.type === 'SET_CONFIG') {
    chrome.storage.local.set({
      bridgeUrl: message.bridgeUrl,
      assignedProfile: message.assignedProfile,
      webEnabled: message.webEnabled !== false,
      preferredWebModel: message.preferredWebModel || 'gemini-2.0-flash-thinking'
    }, () => {
      sendResponse({ success: true });
      connectSSE();
    });
    return true;
  } else if (message.type === 'RECONNECT') {
    connectSSE().then(() => {
      sendResponse({ status: 'reconnecting' });
    });
    return true;
  }
});

// 9. Lifecycle Hooks & Periodic Watchdog Alarms
chrome.alarms.create('bridge_health_check', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'bridge_health_check') {
    touchWorker();
    ensureOffscreenDocument();
    if (!isConnected) {
      console.log('[Antigravity BG] Health alarm: reconnecting...');
      connectSSE();
    }
  }
});

chrome.runtime.onStartup.addListener(() => {
  ensureOffscreenDocument();
  connectSSE();
});

chrome.runtime.onInstalled.addListener(() => {
  ensureOffscreenDocument();
  connectSSE();
});

// Initial boot
connectSSE();
ensureOffscreenDocument();
