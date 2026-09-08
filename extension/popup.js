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
      statusText.textContent = 'Connected';
    } else {
      statusBadge.className = 'status-badge status-disconnected';
      statusText.textContent = status.lastError ? 'Error' : 'Disconnected';
    }

    bridgeUrlInput.value = status.bridgeUrl || 'http://127.0.0.1:8000';
    detectedEmailEl.textContent = status.activeEmail || 'Not Detected';
    webChannelToggle.checked = status.webEnabled !== false;
    if (webModelSelect && status.preferredWebModel) {
      webModelSelect.value = status.preferredWebModel;
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
