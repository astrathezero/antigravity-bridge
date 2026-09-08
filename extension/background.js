// Antigravity Web Bridge - Multi-Session Background Service Worker
// Automatically tracks all open gemini.google.com tabs, maps them to their respective
// logged-in Google accounts and Bridge profiles, and maintains simultaneous SSE connections.

const DEFAULT_BRIDGE = 'http://127.0.0.1:8000';
const RECONNECT_INTERVAL_MS = 3000;
const CYCLE_MS = 4 * 60 * 1000; // proactively cycle connection before browser stream timeout
const SCAN_INTERVAL_MS = 10000;

// 1. Multi-Session State Store
// Map<tabId, { tabId, url, email, profile, lastSeen }>
const openGeminiTabs = new Map();

// Map<profileName, { profile, email, controller, clientId, isConnected, lastHeartbeat, cycleTimer }>
const profileConnections = new Map();

// Map<jobId, { tabId, profile, startTime }>
const activeJobs = new Map();

// Cache of bridge profiles fetched from /v1/profiles
let cachedBridgeProfiles = [];
let lastProfileFetchTime = 0;
let offscreenSetupPromise = null;

// 2. Worker Lifecycle & Offscreen Document Keepalive
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
        justification: 'Keep service worker and SSE streams alive 24/7 for Antigravity web bridge'
      });
    } catch (err) {
      if (!/single offscreen document/i.test(String(err?.message ?? err))) {
        console.warn('[Antigravity BG] Offscreen notice:', err);
      }
    } finally {
      offscreenSetupPromise = null;
    }
  })();
  return offscreenSetupPromise;
}

// 3. Storage & Configuration Helpers
async function getConfig() {
  try {
    const res = await chrome.storage.local.get(['bridgeUrl', 'assignedProfile', 'webEnabled', 'preferredWebModel']);
    return {
      bridgeUrl: res.bridgeUrl || DEFAULT_BRIDGE,
      assignedProfile: res.assignedProfile || '',
      webEnabled: res.webEnabled !== false,
      preferredWebModel: res.preferredWebModel || 'gemini-3.8-flash-thinking'
    };
  } catch {
    return {
      bridgeUrl: DEFAULT_BRIDGE,
      assignedProfile: '',
      webEnabled: true,
      preferredWebModel: 'gemini-3.8-flash-thinking'
    };
  }
}

// 4. HTTP Helpers to Bridge Server
async function postToBridge(path, data) {
  const cfg = await getConfig();
  const url = `${cfg.bridgeUrl.replace(/\/+$/, '')}${path}`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    return res.ok;
  } catch (err) {
    console.error(`[Antigravity BG] Error posting to ${path}:`, err);
    return false;
  }
}

async function fetchBridgeProfiles() {
  const cfg = await getConfig();
  const url = `${cfg.bridgeUrl.replace(/\/+$/, '')}/v1/profiles`;
  try {
    const res = await fetch(url);
    if (res.ok) {
      const data = await res.json();
      cachedBridgeProfiles = data.profiles || [];
      lastProfileFetchTime = Date.now();
      return cachedBridgeProfiles;
    }
  } catch (e) {
    console.warn('[Antigravity BG] Could not fetch profiles from bridge:', e);
  }
  return cachedBridgeProfiles;
}

// 5. Intelligent Profile Resolution from Email & URL
function resolveProfile(email, url) {
  const cleanEmail = (email || '').toLowerCase().trim();

  // 1. Exact match by account_email in bridge profiles
  if (cleanEmail && cachedBridgeProfiles.length > 0) {
    const exact = cachedBridgeProfiles.find(p =>
      p.account_email && p.account_email.toLowerCase().trim() === cleanEmail
    );
    if (exact) return exact.name;

    // 2. Match by email username portion
    const userPart = cleanEmail.split('@')[0];
    const partial = cachedBridgeProfiles.find(p =>
      p.name.toLowerCase() === userPart || userPart.includes(p.name.toLowerCase())
    );
    if (partial) return partial.name;
  }

  // 3. Heuristic match by URL (/u/1/ secondary account)
  if (url && url.includes('/u/1/')) {
    const u1Prof = cachedBridgeProfiles.find(p =>
      (p.account_email && /somporn/i.test(p.account_email)) || /somporn/i.test(p.name)
    );
    if (u1Prof) return u1Prof.name;
    return 'somporn';
  }

  // 4. Default to username portion if email present
  if (cleanEmail) {
    return cleanEmail.split('@')[0];
  }

  return 'default';
}

// 6. Multi-Profile SSE Connection Management
async function ensureConnectionForProfile(profile, email) {
  if (!profile) return;
  const cfg = await getConfig();
  if (!cfg.webEnabled) return;

  const existing = profileConnections.get(profile);
  if (existing && existing.isConnected) {
    if (email && !existing.email) existing.email = email;
    return;
  }

  if (existing && existing.controller) {
    try { existing.controller.abort(); } catch {}
  }
  if (existing && existing.cycleTimer) {
    clearTimeout(existing.cycleTimer);
  }

  await ensureOffscreenDocument();

  const controller = new AbortController();
  const conn = {
    profile,
    email: email || existing?.email || '',
    controller,
    clientId: '',
    isConnected: false,
    lastHeartbeat: Date.now(),
    cycleTimer: null
  };
  profileConnections.set(profile, conn);

  const queryParams = new URLSearchParams();
  queryParams.set('profile', profile);
  if (conn.email) queryParams.set('email', conn.email);

  const sseUrl = `${cfg.bridgeUrl.replace(/\/+$/, '')}/extension/events?${queryParams.toString()}`;
  console.log(`[Antigravity BG] [${profile}] Connecting SSE: ${sseUrl}`);

  try {
    const response = await fetch(sseUrl, {
      method: 'GET',
      headers: { 'Accept': 'text/event-stream' },
      signal: controller.signal
    });

    if (!response.ok) {
      console.warn(`[Antigravity BG] [${profile}] SSE refused with status ${response.status}`);
      conn.isConnected = false;
      return;
    }

    conn.isConnected = true;
    console.log(`[Antigravity BG] [${profile}] SSE connected.`);

    // Cycle connection every 4 minutes before browser stream timeout
    conn.cycleTimer = setTimeout(() => {
      console.log(`[Antigravity BG] [${profile}] Proactively cycling SSE connection...`);
      ensureConnectionForProfile(profile, conn.email);
    }, CYCLE_MS);

    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      touchWorker();
      conn.lastHeartbeat = Date.now();

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      let currentEvent = 'message';
      let currentData = '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) {
          if (currentData) {
            try {
              const parsed = JSON.parse(currentData);
              if (currentEvent === 'connected') {
                conn.clientId = parsed.clientId || '';
                console.log(`[Antigravity BG] [${profile}] Registered as clientId=${conn.clientId}`);
              } else if (currentEvent === 'job') {
                handleJobEvent(parsed, profile, conn.email);
              }
            } catch (e) {
              console.warn(`[Antigravity BG] [${profile}] Failed to parse SSE event:`, currentData, e);
            }
          }
          currentEvent = 'message';
          currentData = '';
          continue;
        }

        if (trimmed.startsWith('event:')) {
          currentEvent = trimmed.slice(6).trim();
        } else if (trimmed.startsWith('data:')) {
          const dataPart = trimmed.slice(5).trim();
          currentData += (currentData ? '\n' : '') + dataPart;
        }
      }
    }
  } catch (err) {
    if (!controller.signal.aborted) {
      console.warn(`[Antigravity BG] [${profile}] SSE disconnected:`, err.message);
    }
  } finally {
    conn.isConnected = false;
    if (conn.cycleTimer) clearTimeout(conn.cycleTimer);

    // Auto-reconnect if any tab is still open for this profile or if assignedProfile matches
    setTimeout(async () => {
      const currentCfg = await getConfig();
      const hasTab = Array.from(openGeminiTabs.values()).some(t => t.profile === profile);
      const isAssigned = currentCfg.assignedProfile === profile;
      if (hasTab || isAssigned) {
        ensureConnectionForProfile(profile, conn.email);
      } else {
        profileConnections.delete(profile);
      }
    }, RECONNECT_INTERVAL_MS);
  }
}

// 7. Multi-Tab Job Dispatcher
async function handleJobEvent(job, assignedProfile, assignedEmail) {
  const jobId = job.jobId || job.job_id;
  const cfg = await getConfig();

  if (!cfg.webEnabled) {
    await postToBridge('/extension/error', {
      job_id: jobId,
      error: `Web extension channel is currently disabled in settings.`
    });
    return;
  }

  job.model = job.model && job.model !== 'gemini-web' && job.model !== 'default' 
    ? job.model 
    : (cfg.preferredWebModel || 'gemini-3.8-flash-thinking');

  const targetProfile = job.profile || assignedProfile;
  const targetEmail = (assignedEmail || '').toLowerCase();

  console.log(`[Antigravity BG] Dispatching job ${jobId} to profile=${targetProfile} (email=${targetEmail})`);

  // Step 1: Find tab belonging to this profile / email
  let targetTabId = null;

  for (const [tId, tInfo] of openGeminiTabs.entries()) {
    if (tInfo.profile === targetProfile || (targetEmail && tInfo.email === targetEmail)) {
      targetTabId = tId;
      break;
    }
  }

  // Step 2: Fallback matching across all open tabs by URL path
  if (!targetTabId) {
    const allTabs = await chrome.tabs.query({ url: ['https://gemini.google.com/*', 'https://*.gemini.google.com/*'] });
    const isU1 = /somporn/i.test(targetProfile) || /somporn/i.test(targetEmail);

    if (isU1) {
      const u1Tab = allTabs.find(t => t.url && t.url.includes('/u/1/') && !t.discarded);
      if (u1Tab) targetTabId = u1Tab.id;
    } else {
      const defTab = allTabs.find(t => t.url && !t.url.includes('/u/1/') && !t.discarded);
      if (defTab) targetTabId = defTab.id;
    }

    if (!targetTabId && allTabs.length > 0) {
      const nonDiscarded = allTabs.find(t => !t.discarded);
      targetTabId = (nonDiscarded || allTabs[0]).id;
    }
  }

  // Step 3: Open tab if no tab exists
  if (!targetTabId) {
    const isU1 = /somporn/i.test(targetProfile) || /somporn/i.test(targetEmail);
    const targetUrl = isU1 ? 'https://gemini.google.com/u/1/app' : 'https://gemini.google.com/app';
    const newTab = await chrome.tabs.create({ url: targetUrl, active: false });
    targetTabId = newTab.id;
    await new Promise(r => setTimeout(r, 4000));
  }

  activeJobs.set(jobId, { tabId: targetTabId, profile: targetProfile, startTime: Date.now() });

  // Ensure content script is active in this tab
  try {
    await chrome.scripting.executeScript({
      target: { tabId: targetTabId },
      files: ['content.js']
    });
  } catch {}

  // Send command to content script in tab
  chrome.tabs.sendMessage(targetTabId, { type: 'EXECUTE_JOB', job }, (response) => {
    if (chrome.runtime.lastError) {
      console.warn(`[Antigravity BG] Failed to send EXECUTE_JOB to tab ${targetTabId}:`, chrome.runtime.lastError.message);
    }
  });
}

// 8. Open Tabs Scanning & Auto-Registration
async function scanOpenTabs() {
  touchWorker();
  await ensureOffscreenDocument();

  if (Date.now() - lastProfileFetchTime > 60000) {
    await fetchBridgeProfiles();
  }

  const allTabs = await chrome.tabs.query({ url: ['https://gemini.google.com/*', 'https://*.gemini.google.com/*'] });
  const openIds = new Set(allTabs.map(t => t.id));

  // Remove closed tabs
  for (const tId of openGeminiTabs.keys()) {
    if (!openIds.has(tId)) {
      openGeminiTabs.delete(tId);
    }
  }

  for (const tab of allTabs) {
    if (tab.discarded) continue;

    // Send check email request to content script
    chrome.tabs.sendMessage(tab.id, { type: 'CHECK_EMAIL' }, (res) => {
      void chrome.runtime.lastError;
    });

    // If tab is not yet tracked, provide initial fallback entry
    if (!openGeminiTabs.has(tab.id)) {
      const isU1 = tab.url && tab.url.includes('/u/1/');
      const fallbackProf = isU1 ? 'somporn' : 'attasitgits';
      const fallbackEmail = isU1 ? 'sompornjitdee80@gmail.com' : 'attasitgits@gmail.com';
      openGeminiTabs.set(tab.id, {
        tabId: tab.id,
        url: tab.url,
        email: fallbackEmail,
        profile: fallbackProf,
        lastSeen: Date.now()
      });
      ensureConnectionForProfile(fallbackProf, fallbackEmail);
    }
  }

  // Also check assignedProfile from config
  const cfg = await getConfig();
  if (cfg.assignedProfile && cfg.webEnabled) {
    ensureConnectionForProfile(cfg.assignedProfile, '');
  }
}

// 9. Tab Lifecycle Event Listeners
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (tab.url && tab.url.includes('gemini.google.com') && changeInfo.status === 'complete') {
    scanOpenTabs();
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  const removed = openGeminiTabs.get(tabId);
  openGeminiTabs.delete(tabId);

  if (removed && removed.profile) {
    // Check if any other tab still uses this profile
    const remaining = Array.from(openGeminiTabs.values()).some(t => t.profile === removed.profile);
    if (!remaining) {
      getConfig().then(cfg => {
        if (cfg.assignedProfile !== removed.profile) {
          const conn = profileConnections.get(removed.profile);
          if (conn && conn.controller) {
            try { conn.controller.abort(); } catch {}
          }
          profileConnections.delete(removed.profile);
        }
      });
    }
  }
});

// 10. Keepalive Port Listener
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

// 11. Extension Message Router (from Content Scripts & Popup)
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
    const tabId = sender.tab?.id;
    const tabUrl = sender.tab?.url || '';
    const email = (message.email || '').toLowerCase().trim();

    if (tabId && email) {
      const profile = resolveProfile(email, tabUrl);
      openGeminiTabs.set(tabId, {
        tabId,
        url: tabUrl,
        email,
        profile,
        lastSeen: Date.now()
      });
      console.log(`[Antigravity BG] Registered tab ${tabId}: ${email} -> Profile: ${profile}`);
      ensureConnectionForProfile(profile, email);
    }
  } else if (message.type === 'GET_STATUS') {
    getConfig().then(cfg => {
      const activeSessions = Array.from(openGeminiTabs.values()).map(t => {
        const conn = profileConnections.get(t.profile);
        return {
          tabId: t.tabId,
          url: t.url,
          email: t.email,
          profile: t.profile,
          connected: conn ? conn.isConnected : false
        };
      });

      const connectedProfiles = Array.from(profileConnections.entries())
        .filter(([_, c]) => c.isConnected)
        .map(([name, c]) => ({ name, email: c.email }));

      sendResponse({
        connected: connectedProfiles.length > 0,
        connectedProfiles,
        activeSessions,
        bridgeUrl: cfg.bridgeUrl,
        assignedProfile: cfg.assignedProfile,
        webEnabled: cfg.webEnabled,
        preferredWebModel: cfg.preferredWebModel
      });
    });
    return true;
  } else if (message.type === 'SET_CONFIG') {
    chrome.storage.local.set({
      bridgeUrl: message.bridgeUrl,
      assignedProfile: message.assignedProfile,
      webEnabled: message.webEnabled !== false,
      preferredWebModel: message.preferredWebModel || 'gemini-3.8-flash-thinking'
    }, () => {
      sendResponse({ success: true });
      scanOpenTabs();
    });
    return true;
  } else if (message.type === 'RECONNECT') {
    scanOpenTabs().then(() => {
      sendResponse({ status: 'reconnecting' });
    });
    return true;
  }
});

// 12. Periodic Watchdog & Health Alarms
chrome.alarms.create('bridge_health_check', { periodInMinutes: 0.25 }); // every 15s
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'bridge_health_check') {
    touchWorker();
    scanOpenTabs();
  }
});

chrome.runtime.onStartup.addListener(() => {
  ensureOffscreenDocument();
  scanOpenTabs();
});

chrome.runtime.onInstalled.addListener(() => {
  ensureOffscreenDocument();
  scanOpenTabs();
});

// Initial startup scan
ensureOffscreenDocument();
fetchBridgeProfiles().then(() => {
  scanOpenTabs();
});
setInterval(scanOpenTabs, SCAN_INTERVAL_MS);
