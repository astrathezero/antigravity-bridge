// Antigravity Web Bridge - Multi-Session Background Service Worker
// Automatically tracks all open gemini.google.com tabs, maps them to their respective
// logged-in Google accounts and Bridge profiles, and maintains simultaneous SSE connections.

const DEFAULT_BRIDGE = 'http://127.0.0.1:8000';
const RECONNECT_INTERVAL_MS = 3000;
const CYCLE_MS = 4 * 60 * 1000; // proactively cycle connection before browser stream timeout
const SCAN_INTERVAL_MS = 10000;
// A connect attempt that has not settled within this window is treated as dead, so a hung
// fetch can never latch isConnecting and block every future reconnect.
const CONNECT_STALE_MS = 30000;
// The bridge writes ": keepalive" every 10s, so a stream with no traffic for this long is dead
// even though no error was raised.
const HEARTBEAT_STALE_MS = 60000;

// 1. Multi-Session State Store
// Map<tabId, { tabId, url, email, profile, lastSeen }>
const openGeminiTabs = new Map();

// Map<profileName, { profile, email, controller, clientId, isConnected, lastHeartbeat, cycleTimer }>
const profileConnections = new Map();

// Map<jobId, { tabId, profile, startTime }>
const activeJobs = new Map();

// Learned mapping from a Google multi-login index (the N in gemini.google.com/u/N/) to the
// email actually signed in at that index, observed from tabs as their account is detected.
// Chrome gives no way to derive this, and it differs per browser profile, so it is learned at
// runtime rather than hardcoded to one person's account layout.
// Map<number, string>
const emailByAccountIndex = new Map();

function accountIndexFromUrl(url) {
  const m = /\/u\/(\d+)\//.exec(url || '');
  return m ? Number(m[1]) : null;
}

// The /u/N/ index whose signed-in email matches this profile, or null if never observed.
function accountIndexForProfile(profile, email) {
  const wanted = (email || '').toLowerCase().trim() ||
    (cachedBridgeProfiles.find(p => p.name === profile)?.account_email || '').toLowerCase().trim();
  if (!wanted) return null;
  for (const [idx, mail] of emailByAccountIndex.entries()) {
    if (mail === wanted) return idx;
  }
  return null;
}

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
        reasons: ['BLOBS'],
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
    const res = await chrome.storage.local.get(['bridgeUrl', 'assignedProfile', 'webEnabled', 'canvasMode', 'preferredWebModel']);
    return {
      bridgeUrl: res.bridgeUrl || DEFAULT_BRIDGE,
      assignedProfile: res.assignedProfile || '',
      webEnabled: res.webEnabled !== false,
      // Default OFF. In Canvas mode Gemini writes the answer into the side panel and leaves
      // only a one-line stub in the chat bubble, so any drift in the Canvas panel markup
      // truncates every response. Opt in from the popup once extraction is confirmed working.
      canvasMode: res.canvasMode === true,
      preferredWebModel: res.preferredWebModel || 'gemini-3.8-flash-thinking'
    };
  } catch {
    return {
      bridgeUrl: DEFAULT_BRIDGE,
      assignedProfile: '',
      webEnabled: true,
      canvasMode: false,
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

  // 3. Match by the Google account index in the URL (/u/N/), using the email we have
  //    previously observed at that index in this browser. This replaces a hardcoded account
  //    name that mapped every /u/1/ tab onto one specific person's profile, which silently
  //    routed other users' jobs to the wrong Google account.
  const idx = accountIndexFromUrl(url);
  if (idx !== null) {
    const knownEmail = emailByAccountIndex.get(idx);
    if (knownEmail) {
      const byIndex = cachedBridgeProfiles.find(p =>
        p.account_email && p.account_email.toLowerCase().trim() === knownEmail
      );
      if (byIndex) return byIndex.name;
    }
  }

  // 4. Default to username portion if email present
  if (cleanEmail) {
    return cleanEmail.split('@')[0];
  }

  // No email detected yet. Returning a guess here would open an SSE for a profile this tab
  // may not belong to, so report "unknown" and let the DETECTED_EMAIL message resolve it.
  return '';
}

// 6. Multi-Profile SSE Connection Management
async function ensureConnectionForProfile(profile, email) {
  if (!profile) return;
  const cfg = await getConfig();
  if (!cfg.webEnabled) return;

  const existing = profileConnections.get(profile);
  // Both early-returns below are staleness-checked. Without that, a connection that dies
  // without settling (hung fetch, or a stream that stops delivering without raising) leaves
  // the flag set forever and every later scan tick returns here instead of reconnecting.
  if (existing && existing.isConnected) {
    if (email && !existing.email) existing.email = email;
    if (Date.now() - (existing.lastHeartbeat || 0) < HEARTBEAT_STALE_MS) return;
    console.warn(`[Antigravity BG] [${profile}] SSE marked connected but silent for >${HEARTBEAT_STALE_MS / 1000}s — forcing reconnect.`);
  } else if (existing && existing.isConnecting) {
    if (email && !existing.email) existing.email = email;
    if (Date.now() - (existing.connectStartedAt || 0) < CONNECT_STALE_MS) return;
    console.warn(`[Antigravity BG] [${profile}] Connect attempt stalled for >${CONNECT_STALE_MS / 1000}s — forcing reconnect.`);
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
    isConnecting: true,
    connectStartedAt: Date.now(),
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
      conn.isConnecting = false;
      return;
    }

    conn.isConnected = true;
    conn.isConnecting = false;
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
    // Must be cleared here, not only on the success path: a fetch that throws (bridge
    // restarting, connection refused) would otherwise leave isConnecting latched true and
    // the early-return above would block every reconnect for the life of the worker.
    conn.isConnecting = false;
    if (conn.cycleTimer) clearTimeout(conn.cycleTimer);

    // Auto-reconnect if any tab is still open for this profile or if assignedProfile matches.
    setTimeout(async () => {
      // A stale connection can be aborted and replaced while its fetch is still unwinding.
      // Only act if the map still holds THIS connection, otherwise this late cleanup would
      // tear down the healthy replacement that took its place.
      if (profileConnections.get(profile) !== conn) return;

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

  if (!job.model || job.model === 'default' || job.model === 'gemini-web') {
    job.model = cfg.preferredWebModel || 'gemini-3.8-flash-thinking';
  }

  if (job.canvas === undefined) {
    job.canvas = cfg.canvasMode === true;
  }

  const targetProfile = job.profile || assignedProfile;
  const targetEmail = (assignedEmail || '').toLowerCase();

  console.log(`[Antigravity BG] Dispatching job ${jobId} to profile=${targetProfile} (model=${job.model}, canvas=${job.canvas})`);

  // Step 1: Find tab belonging to this profile / email
  let targetTabId = null;

  for (const [tId, tInfo] of openGeminiTabs.entries()) {
    if (tInfo.profile === targetProfile || (targetEmail && tInfo.email === targetEmail)) {
      targetTabId = tId;
      break;
    }
  }

  // The /u/N/ index this profile's Google account is signed in at, if we have ever seen it.
  // Previously this was a hardcoded test for one specific account name, which mapped every
  // /u/1/ tab onto one person and would hand another user's job to the wrong Google account.
  const targetIndex = accountIndexForProfile(targetProfile, targetEmail);

  // Step 2: Fallback matching across all open tabs by account index
  if (!targetTabId) {
    const allTabs = await chrome.tabs.query({ url: ['https://gemini.google.com/*', 'https://*.gemini.google.com/*'] });
    const live = allTabs.filter(t => !t.discarded);

    if (targetIndex !== null) {
      const match = live.find(t => accountIndexFromUrl(t.url) === targetIndex);
      if (match) targetTabId = match.id;
    }

    // Never fall back to an arbitrary tab when we know which account we need but cannot find
    // it — that would run the prompt under someone else's Google account. Only guess when the
    // target account is genuinely unknown.
    if (!targetTabId && targetIndex === null && live.length > 0) {
      targetTabId = live[0].id;
    }

    if (!targetTabId && targetIndex !== null) {
      console.warn(`[Antigravity BG] No open tab for account index ${targetIndex} (profile=${targetProfile}); opening one.`);
    }
  }

  // Step 3: Open tab if no tab exists
  if (!targetTabId) {
    const useCanvas = job.canvas !== false;
    const prefix = targetIndex !== null && targetIndex > 0
      ? `https://gemini.google.com/u/${targetIndex}`
      : 'https://gemini.google.com';
    const targetUrl = `${prefix}${useCanvas ? '/canvas' : '/app'}`;
    const newTab = await chrome.tabs.create({ url: targetUrl, active: false });
    targetTabId = newTab.id;
    await new Promise(r => setTimeout(r, 4000));
  }

  activeJobs.set(jobId, { tabId: targetTabId, profile: targetProfile, startTime: Date.now() });

  // Activate tab so typing/execCommand and MutationObserver execute with full browser focus
  try {
    await chrome.tabs.update(targetTabId, { active: true });
    await new Promise(r => setTimeout(r, 150));
  } catch {}

  // Ensure content script is active in this tab
  try {
    await chrome.scripting.executeScript({
      target: { tabId: targetTabId },
      files: ['content.js']
    });
  } catch {}

  // Send command to content script in tab with retry and fallback error reporting
  let sent = false;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await new Promise((resolve, reject) => {
        chrome.tabs.sendMessage(targetTabId, { type: 'EXECUTE_JOB', job }, (response) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else {
            resolve(response);
          }
        });
      });
      sent = true;
      break;
    } catch (e) {
      console.warn(`[Antigravity BG] Attempt ${attempt} failed to send EXECUTE_JOB to tab ${targetTabId}:`, e.message);
      if (attempt < 3) {
        await new Promise(r => setTimeout(r, 1000));
      }
    }
  }

  if (!sent) {
    activeJobs.delete(jobId);
    await postToBridge('/extension/error', {
      job_id: jobId,
      error: `Failed to deliver job to Gemini tab ${targetTabId} for profile '${targetProfile}'. Tab may still be loading or unready.`
    });
  }
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

    // Track the tab, but do not guess who is signed into it. This used to assume one of two
    // hardcoded accounts based on the URL, which registered every unknown tab under one
    // person's profile and opened an SSE connection for an account that tab may not hold.
    // The tab stays unresolved until its content script reports the real address, and a job
    // is only ever routed to a tab whose account we actually know.
    if (!openGeminiTabs.has(tab.id)) {
      openGeminiTabs.set(tab.id, {
        tabId: tab.id,
        url: tab.url,
        email: '',
        profile: '',
        firstSeen: Date.now(),
        lastSeen: Date.now()
      });
    } else {
      const existingTab = openGeminiTabs.get(tab.id);
      if (existingTab && existingTab.profile) {
        ensureConnectionForProfile(existingTab.profile, existingTab.email);
      } else if (existingTab && !existingTab.warnedUnresolved &&
                 Date.now() - (existingTab.firstSeen || 0) > 30000) {
        // Account detection is the only thing that can resolve a tab now, so say clearly
        // when it never succeeds instead of the tab sitting silently unconnected.
        existingTab.warnedUnresolved = true;
        console.warn(
          `[Antigravity BG] Tab ${tab.id} has been open >30s without a detected Google ` +
          `account, so no SSE connection was opened for it. Set an explicit profile in the ` +
          `extension popup, or check the email selectors in page.js.`
        );
      }
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
  } else if (message.type === 'DEBUG') {
    postToBridge('/extension/debug', message.debug);
  } else if (message.type === 'DETECTED_EMAIL') {
    const tabId = sender.tab?.id;
    const tabUrl = sender.tab?.url || '';
    const email = (message.email || '').toLowerCase().trim();

    if (tabId && email) {
      // Learn which /u/N/ index this account occupies in this browser, so jobs for it can be
      // routed to the right tab (and the right tab opened) without hardcoding account names.
      const idx = accountIndexFromUrl(tabUrl);
      if (idx !== null && emailByAccountIndex.get(idx) !== email) {
        emailByAccountIndex.set(idx, email);
        console.log(`[Antigravity BG] Learned account index /u/${idx}/ -> ${email}`);
      }

      const profile = resolveProfile(email, tabUrl);
      openGeminiTabs.set(tabId, {
        tabId,
        url: tabUrl,
        email,
        profile,
        lastSeen: Date.now()
      });
      if (profile) {
        console.log(`[Antigravity BG] Registered tab ${tabId}: ${email} -> Profile: ${profile}`);
        ensureConnectionForProfile(profile, email);
      } else {
        console.warn(`[Antigravity BG] Tab ${tabId} (${email}) matches no bridge profile — not connecting.`);
      }
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
        canvasMode: cfg.canvasMode === true,
        preferredWebModel: cfg.preferredWebModel
      });
    });
    return true;
  } else if (message.type === 'SET_CONFIG') {
    chrome.storage.local.set({
      bridgeUrl: message.bridgeUrl,
      assignedProfile: message.assignedProfile,
      webEnabled: message.webEnabled !== false,
      canvasMode: message.canvasMode === true,
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
