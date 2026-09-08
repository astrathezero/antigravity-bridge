// Antigravity Web Bridge - Popup Controller

document.addEventListener('DOMContentLoaded', async () => {
  const statusBadge = document.getElementById('statusBadge');
  const statusText = document.getElementById('statusText');
  const bridgeUrlInput = document.getElementById('bridgeUrl');
  const detectedEmailEl = document.getElementById('detectedEmail');
  const profileSelect = document.getElementById('profileSelect');
  const cliStatusEl = document.getElementById('cliStatus');
  const webChannelToggle = document.getElementById('webChannelToggle');
  const webModelSelect = document.getElementById('webModelSelect');
  const saveBtn = document.getElementById('saveBtn');
  const openGeminiBtn = document.getElementById('openGeminiBtn');
  const alertBox = document.getElementById('alertBox');

  function showAlert(msg, isError = false) {
    alertBox.textContent = msg;
    alertBox.className = `alert ${isError ? 'alert-error' : 'alert-success'}`;
    alertBox.style.display = 'block';
    setTimeout(() => {
      alertBox.style.display = 'none';
    }, 4000);
  }

  // Load profiles from Bridge API
  async function loadProfiles(bridgeUrl, currentSelectedProfile) {
    try {
      const res = await fetch(`${bridgeUrl.replace(/\/+$/, '')}/v1/profiles`);
      if (!res.ok) return;
      const data = await res.json();
      const profiles = data.profiles || [];

      // Preserve first option (Auto-match)
      profileSelect.innerHTML = '<option value="">(Auto-match by Google Email)</option>';

      profiles.forEach(p => {
        const opt = document.createElement('option');
        opt.value = p.name;
        const emailLabel = p.account_email && p.account_email !== 'Not Logged In' ? ` [${p.account_email}]` : '';
        opt.textContent = `${p.name}${emailLabel}`;
        if (p.name === currentSelectedProfile) {
          opt.selected = true;
        }
        profileSelect.appendChild(opt);
      });

      updateChannelStatusUI(profiles, profileSelect.value);
    } catch (e) {
      console.warn('Could not fetch profiles from bridge:', e);
    }
  }

  function updateChannelStatusUI(profiles, selectedProf) {
    if (!selectedProf || !profiles) {
      cliStatusEl.textContent = '🟢 Auto / Default';
      return;
    }
    const profObj = profiles.find(p => p.name === selectedProf);
    if (profObj) {
      cliStatusEl.textContent = profObj.cli_enabled ? '🟢 Enabled' : '🔴 Disabled';
      webChannelToggle.checked = profObj.web_enabled !== false;
    }
  }

  // Fetch initial status from background service worker
  chrome.runtime.sendMessage({ type: 'GET_STATUS' }, (status) => {
    if (!status) return;

    if (status.connected) {
      statusBadge.className = 'status-badge status-connected';
      const profCount = status.connectedProfiles?.length || 0;
      statusText.textContent = profCount > 1 ? `Connected (${profCount} accounts)` : 'Connected';
    } else {
      statusBadge.className = 'status-badge status-disconnected';
      statusText.textContent = status.lastError ? 'Error' : 'Disconnected';
    }

    bridgeUrlInput.value = status.bridgeUrl || 'http://127.0.0.1:8000';
    webChannelToggle.checked = status.webEnabled !== false;
    if (webModelSelect && status.preferredWebModel) {
      webModelSelect.value = status.preferredWebModel;
    }

    // Render active sessions
    const sessionsContainer = document.getElementById('activeSessionsContainer');
    if (sessionsContainer) {
      if (status.activeSessions && status.activeSessions.length > 0) {
        sessionsContainer.innerHTML = status.activeSessions.map(s => `
          <div style="display: flex; align-items: center; justify-content: space-between; background: rgba(15,23,42,0.5); padding: 5px 8px; border-radius: 6px; border: 1px solid var(--border);">
            <div style="display: flex; align-items: center; gap: 6px; overflow: hidden;">
              <span style="display: inline-block; width: 6px; height: 6px; border-radius: 50%; background: ${s.connected ? '#10b981' : '#f59e0b'}; box-shadow: 0 0 4px ${s.connected ? '#10b981' : '#f59e0b'};"></span>
              <span style="font-weight: 500; font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 170px;" title="${s.email}">${s.email}</span>
            </div>
            <span style="font-size: 10px; color: var(--accent-blue); background: rgba(56,189,248,0.1); padding: 2px 5px; border-radius: 4px;">${s.profile}</span>
          </div>
        `).join('');
      } else {
        sessionsContainer.innerHTML = '<span style="color: var(--text-muted); font-size: 11px;">No open Gemini tabs found. Open gemini.google.com to connect.</span>';
      }
    }

    loadProfiles(bridgeUrlInput.value, status.assignedProfile);
  });

  // Save Settings & Reconnect
  saveBtn.addEventListener('click', () => {
    const bridgeUrl = bridgeUrlInput.value.trim() || 'http://127.0.0.1:8000';
    const assignedProfile = profileSelect.value;
    const webEnabled = webChannelToggle.checked;
    const preferredWebModel = webModelSelect ? webModelSelect.value : 'gemini-2.0-flash-thinking';

    chrome.runtime.sendMessage({
      type: 'SET_CONFIG',
      bridgeUrl,
      assignedProfile,
      webEnabled,
      preferredWebModel
    }, (res) => {
      if (res && res.success) {
        showAlert('Settings saved! Reconnecting...');
        setTimeout(() => {
          window.location.reload();
        }, 1000);
      } else {
        showAlert('Failed to save settings', true);
      }
    });
  });

  // Web Channel Toggle handler
  webChannelToggle.addEventListener('change', async () => {
    const bridgeUrl = bridgeUrlInput.value.trim() || 'http://127.0.0.1:8000';
    const assignedProfile = profileSelect.value;
    const isChecked = webChannelToggle.checked;

    if (assignedProfile) {
      try {
        await fetch(`${bridgeUrl.replace(/\/+$/, '')}/v1/profiles/toggle`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ profile: assignedProfile, channel: 'web' })
        });
      } catch (e) {
        console.warn('Failed to notify bridge of toggle:', e);
      }
    }
  });

  // Open Gemini Tab
  openGeminiBtn.addEventListener('click', () => {
    chrome.tabs.create({ url: 'https://gemini.google.com/app' });
  });
});
