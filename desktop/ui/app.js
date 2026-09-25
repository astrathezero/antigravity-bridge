/**
 * Antigravity Bridge Desktop - Frontend Application Logic
 */

// Simple I18N translations
const translations = {
  en: {
    "nav.dashboard": "Dashboard",
    "nav.profiles": "Profiles",
    "nav.hermes": "Hermes Setup",
    "nav.doctor": "Doctor",
    "nav.settings": "Settings",
    "nav.wizard": "Getting started",
    "dash.title": "System Dashboard",
    "dash.subtitle": "Live status, fallback health, and real-time execution telemetry.",
    "dash.in_flight": "Active Requests",
    "dash.profiles_ready": "Ready Profiles",
    "dash.model_mode": "Primary Engine",
    "dash.daemon_status": "Daemon Mode",
    "dash.logs_title": "Live Gateway Logs",
    "dash.autoscroll": "Auto-scroll",
    "profiles.title": "Google Profiles Pool",
    "profiles.subtitle": "Manage authenticated Gemini accounts for automatic rotation and quota failover.",
    "profiles.add_btn": "Add Profile",
    "hermes.title": "Hermes Desktop Integration",
    "hermes.subtitle": "Zero-config OpenAI compatible endpoint setup for Hermes Agent.",
    "doctor.title": "System Diagnostics",
    "doctor.subtitle": "Automated verification of runtime requirements, network bindings, and credentials.",
    "settings.title": "Application Settings",
    "settings.subtitle": "Configure port, system launch behavior, and CLI paths.",
    "actions.restart": "Restart",
    "actions.clear": "Clear",
  },
  th: {
    "nav.dashboard": "แดชบอร์ด",
    "nav.profiles": "โปรไฟล์",
    "nav.hermes": "ตั้งค่า Hermes",
    "nav.doctor": "หมอตรวจระบบ",
    "nav.settings": "ตั้งค่า",
    "nav.wizard": "เริ่มต้นใช้งาน",
    "dash.title": "ภาพรวมระบบ",
    "dash.subtitle": "สถานะการทำงาน, สุขภาพพูลโควตา, และ Log แบบเรียลไทม์",
    "dash.in_flight": "คำขอกำลังประมวลผล",
    "dash.profiles_ready": "โปรไฟล์พร้อมใช้งาน",
    "dash.model_mode": "โมเดลหลัก",
    "dash.daemon_status": "โหมดเดมอน",
    "dash.logs_title": "บันทึกการทำงานสด (Live Logs)",
    "dash.autoscroll": "เลื่อนจออัตโนมัติ",
    "profiles.title": "พูลบัญชี Google",
    "profiles.subtitle": "จัดการโปรไฟล์ Google ที่ล็อกอินแล้ว สำหรับหมุนเวียนและสลับบัญชีเมื่อโควตาเต็ม",
    "profiles.add_btn": "เพิ่มโปรไฟล์",
    "hermes.title": "เชื่อมต่อ Hermes Desktop",
    "hermes.subtitle": "ตั้งค่า OpenAI endpoint สำหรับ Hermes Agent 0.21.1+ อย่างง่ายดาย",
    "doctor.title": "ตรวจสอบสุขภาพระบบ (Doctor)",
    "doctor.subtitle": "ตรวจสอบสภาพแวดล้อม agy, พอร์ต และสิทธิ์การทำงานอัตโนมัติ",
    "settings.title": "การตั้งค่าแอปพลิเคชัน",
    "settings.subtitle": "กำหนดหมายเลขพอร์ต, การเปิดแอปเมื่อเปิดเครื่อง, และเส้นทาง agy",
    "actions.restart": "รีสตาร์ต",
    "actions.clear": "ล้าง",
  },
};

let currentLang = "th";

function setLanguage(lang) {
  currentLang = lang;
  document.querySelectorAll(".lang-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.lang === lang);
  });
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    const key = el.dataset.i18n;
    if (translations[lang] && translations[lang][key]) {
      el.textContent = translations[lang][key];
    }
  });
}

// Tab navigation
document.querySelectorAll(".nav-item").forEach((btn) => {
  btn.addEventListener("click", () => {
    const tab = btn.dataset.tab;
    document.querySelectorAll(".nav-item").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));

    btn.classList.add("active");
    const targetView = document.getElementById(`view-${tab}`);
    if (targetView) targetView.classList.add("active");

    if (tab === "profiles") loadProfiles();
    if (tab === "hermes") loadHermesSnippet();
    if (tab === "doctor") runDoctorChecks();
    if (tab === "settings") loadSettingsForm();
  });
});

// Language buttons
document.querySelectorAll(".lang-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    setLanguage(btn.dataset.lang);
  });
});

// Real-time bridge logs and state
const consoleStream = document.getElementById("console-stream");
const autoscrollToggle = document.getElementById("autoscroll-toggle");
const logCountPill = document.getElementById("log-count-pill");
let logLineCount = 0;

function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

function appendConsoleLog(line) {
  if (!consoleStream) return;
  const div = document.createElement("div");
  if (line.includes("[EXEC]")) div.className = "log-line-exec";
  else if (line.includes("[DONE]")) div.className = "log-line-done";
  else if (line.includes("[ERR]") || line.includes("[FAILED]") || line.includes("[TOOL BLOCKED]")) div.className = "log-line-err";
  else if (line.includes("[FALLBACK]") || line.includes("[QUOTA]")) div.className = "log-line-fallback";
  div.textContent = line;
  consoleStream.appendChild(div);
  while (consoleStream.childElementCount > 1000) consoleStream.firstElementChild.remove();
  logLineCount++;
  if (logCountPill) logCountPill.textContent = `${logLineCount} lines`;
  if (autoscrollToggle && autoscrollToggle.checked) consoleStream.scrollTop = consoleStream.scrollHeight;
}

document.getElementById("clear-logs-btn")?.addEventListener("click", () => {
  if (consoleStream) consoleStream.replaceChildren();
  logLineCount = 0;
  if (logCountPill) logCountPill.textContent = "0 lines";
});

const statusPill = document.getElementById("status-pill");
let currentBridgeState = "starting";

const STATE_LABELS = {
  healthy: "🟢 Serving",
  degraded: "🟣 All profiles cooling down",
  unresponsive: "🟠 Not answering",
  starting: "🟡 Starting...",
  stopped: "🔴 Stopped",
  crashloop: "⚠️ Crash loop",
  "port-busy": "⚠️ Port in use",
};

function updateStatusDisplay(state, port) {
  currentBridgeState = state;
  if (port) setText("port-display", port);
  if (statusPill) statusPill.className = `status-indicator-pill ${state}`;
  setText("status-text", STATE_LABELS[state] || state);
  const stopped = ["stopped", "crashloop", "port-busy"].includes(state);
  setText("toggle-service-text", stopped ? "Start" : "Stop");
}

function updateDashboardMetrics(health) {
  const c = health?.concurrency;
  if (!c) return; // liveness-only answer (no API key)
  setText("metric-inflight", c.active_in_flight);
  setText("metric-inflight-sub", c.active_in_flight ? `${c.active_in_flight} of ${c.max_pool_capacity} slots busy` : "Idle");
  const profiles = Object.values(health.profiles || {});
  setText("metric-ready-count", profiles.filter((p) => p.available).length);
  setText("metric-total-profiles", `Total: ${profiles.length} configured`);
  const last = profiles.map((p) => p.last_execution_model).find(Boolean);
  if (last) setText("metric-engine", last);
}

if (window.api) {
  window.api.onBridgeState((data) => {
    updateStatusDisplay(data.state, data.port);
    if (data.health) updateDashboardMetrics(data.health);
  });
  window.api.onBridgeLog(appendConsoleLog);
  window.api.getRecentLogs().then((logs) => Array.isArray(logs) && logs.forEach(appendConsoleLog));
  window.api.getState().then((d) => {
    updateStatusDisplay(d.state, d.port);
    if (d.health) updateDashboardMetrics(d.health);
  });
}

// Profiles
async function loadProfiles() {
  const tbody = document.getElementById("profiles-table-body");
  const countBadge = document.getElementById("profile-count-badge");
  if (!tbody || !window.api) return;
  try {
    const profiles = await window.api.listProfiles();
    const names = Object.keys(profiles);
    if (countBadge) countBadge.textContent = names.length;
    if (names.length === 0) {
      tbody.innerHTML = `<tr><td colspan="6" class="empty-state">No profiles yet. Click 'Add Profile' to sign in a Google account.</td></tr>`;
      return;
    }
    tbody.replaceChildren();
    for (const name of names) {
      const p = profiles[name] || {};
      const disabled = p.status === "DISABLED";
      const status = p.status || (p.available === false ? "COOLDOWN" : "OK");
      const cooldown = p.cooldown_seconds_remaining > 0 ? `Cooldown (${p.cooldown_seconds_remaining}s)` : p.available === undefined ? "-" : `Ready (${p.estimated_quota_percent ?? 100}%)`;
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td><strong>${escapeHtml(name)}</strong></td>
        <td>${escapeHtml(p.email || "N/A")}</td>
        <td><span class="badge ${status === "OK" ? "badge-success" : "badge-warning"}">${escapeHtml(status)}</span></td>
        <td>${Number(p.in_flight || 0)}/${Number(p.max_concurrency || 1)}</td>
        <td>${escapeHtml(cooldown)}</td>
        <td class="text-right">
          <button class="btn btn-ghost btn-sm" data-act="probe" data-name="${escapeHtml(name)}" title="One short request with this account (uses a little quota)">Probe</button>
          <button class="btn btn-ghost btn-sm" data-act="reset" data-name="${escapeHtml(name)}" title="Clear its cooldown">Reset</button>
          <button class="btn btn-ghost btn-sm" data-act="${disabled ? "enable" : "disable"}" data-name="${escapeHtml(name)}">${disabled ? "Enable" : "Disable"}</button>
          <button class="btn btn-ghost btn-sm" data-act="remove" data-name="${escapeHtml(name)}" style="color:#f87171">Remove</button>
        </td>`;
      tbody.appendChild(tr);
    }
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="6" class="empty-state" style="color:#f87171">Failed to load profiles: ${escapeHtml(err.message)}</td></tr>`;
  }
}

document.getElementById("profiles-table-body")?.addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-act]");
  if (!btn || !window.api) return;
  const { act, name } = btn.dataset;
  try {
    if (act === "remove") {
      if (!confirm(`Remove profile '${name}'? Its sign-in and agy history are deleted.`)) return;
      await window.api.removeProfile(name);
    } else if (act === "probe") {
      btn.textContent = "Probing...";
      const res = await window.api.probeProfile(name);
      alert(`Profile '${name}': ${res.message || "OK"}`);
    } else if (act === "reset") await window.api.resetProfile(name);
    else if (act === "disable") await window.api.disableProfile(name);
    else if (act === "enable") await window.api.enableProfile(name);
  } catch (err) {
    alert(`${act} failed: ${err.message}`);
  }
  loadProfiles();
});

// Add Profile modal
const addModal = document.getElementById("add-profile-modal");
let pendingLogin = null;

function openAddModal() {
  addModal?.classList.add("open");
  setText("add-profile-status", "");
}

function closeAddModal() {
  if (pendingLogin) window.api?.cancelAddProfile(pendingLogin);
  addModal?.classList.remove("open");
}

document.getElementById("btn-add-profile-modal")?.addEventListener("click", openAddModal);
document.getElementById("btn-close-modal")?.addEventListener("click", closeAddModal);
document.getElementById("btn-cancel-add-profile")?.addEventListener("click", closeAddModal);

document.getElementById("btn-confirm-add-profile")?.addEventListener("click", async () => {
  const name = document.getElementById("new-profile-name")?.value.trim();
  if (!name || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) {
    setText("add-profile-status", "Use 1-64 characters: letters, digits, . _ - (start with a letter or digit).");
    return;
  }
  const btn = document.getElementById("btn-confirm-add-profile");
  btn.disabled = true;
  btn.textContent = "Waiting for the sign-in in the terminal...";
  setText("add-profile-status", "A terminal window opened. Complete the sign-in there; Cancel stops waiting.");
  pendingLogin = name;
  try {
    const res = await window.api.addProfile(name);
    const note = res.verified ? "" : " (Google could not be reached to confirm the account)";
    alert(`Profile '${name}' signed in as ${res.email}${note}.`);
    addModal?.classList.remove("open");
    loadProfiles();
  } catch (err) {
    setText("add-profile-status", `Sign-in failed: ${err.message}`);
  } finally {
    pendingLogin = null;
    btn.disabled = false;
    btn.textContent = "Launch Login Terminal";
  }
});

// Hermes
async function loadHermesSnippet() {
  if (!window.api) return;
  try {
    setText("hermes-yaml-snippet", await window.api.getHermesSnippet());
    const keys = await window.api.listKeys();
    const keyInput = document.getElementById("endpoint-key-input");
    if (keyInput) keyInput.value = keys[0]?.key || "";
    const s = await window.api.getSettings();
    const urlInput = document.getElementById("endpoint-url-input");
    if (urlInput && s?.port) urlInput.value = `http://127.0.0.1:${s.port}/v1`;
  } catch {}
}

function copyFrom(id, text) {
  if (!text) return;
  navigator.clipboard.writeText(text);
  const btn = document.getElementById(id);
  if (btn) {
    const orig = btn.textContent;
    btn.textContent = "Copied!";
    setTimeout(() => (btn.textContent = orig), 1500);
  }
}

document.getElementById("btn-copy-yaml")?.addEventListener("click", () => copyFrom("btn-copy-yaml", document.getElementById("hermes-yaml-snippet")?.textContent));
document.getElementById("btn-copy-url")?.addEventListener("click", () => copyFrom("btn-copy-url", document.getElementById("endpoint-url-input")?.value));
document.getElementById("btn-copy-key")?.addEventListener("click", () => copyFrom("btn-copy-key", document.getElementById("endpoint-key-input")?.value));
document.getElementById("btn-toggle-key")?.addEventListener("click", (e) => {
  const keyInput = document.getElementById("endpoint-key-input");
  if (!keyInput) return;
  const reveal = keyInput.type === "password";
  keyInput.type = reveal ? "text" : "password";
  e.target.textContent = reveal ? "Hide" : "Reveal";
});
document.getElementById("open-hermes-dir-btn")?.addEventListener("click", async () => {
  const res = await window.api?.openHermesConfigDir();
  if (res && !res.ok) alert(`Hermes' folder was not found (${res.path}). Is Hermes installed?`);
});

// Doctor
async function runDoctorChecks() {
  const container = document.getElementById("doctor-results-list");
  if (!container || !window.api) return;
  container.innerHTML = '<div class="empty-state">Running diagnostics...</div>';
  try {
    const checks = await window.api.runDoctor();
    container.replaceChildren();
    for (const c of checks) {
      const item = document.createElement("div");
      item.className = "doctor-item";
      item.innerHTML = `
        <div class="doctor-info"><h4>${escapeHtml(c.name)}</h4><p>${escapeHtml(c.detail)}</p></div>
        <span class="doctor-badge ${c.ok ? "pass" : "fail"}">${c.ok ? "PASS" : "FAIL"}</span>`;
      container.appendChild(item);
    }
  } catch (err) {
    container.innerHTML = `<div class="empty-state" style="color:#f87171">Diagnostics error: ${escapeHtml(err.message)}</div>`;
  }
}
document.getElementById("btn-run-doctor")?.addEventListener("click", runDoctorChecks);

// Settings and API keys
async function loadSettingsForm() {
  if (!window.api) return;
  const s = await window.api.getSettings();
  if (!s) return;
  document.getElementById("setting-port").value = s.port || 8008;
  document.getElementById("setting-autostart").checked = Boolean(s.autostart);
  document.getElementById("setting-closetotray").checked = Boolean(s.closeToTray);
  document.getElementById("setting-noproxy").checked = Boolean(s.noProxy);
  document.getElementById("setting-agypath").value = s.agyPath || "";
  loadKeys();
}

function maskKey(k) {
  return k.length > 14 ? `${k.slice(0, 10)}...${k.slice(-4)}` : "********";
}

async function loadKeys() {
  const list = document.getElementById("keys-list");
  if (!list || !window.api) return;
  const keys = await window.api.listKeys();
  list.replaceChildren();
  if (!keys.length) list.innerHTML = '<div class="empty-state">No key: the bridge would accept anyone on this machine.</div>';
  for (const { label, key } of keys) {
    const row = document.createElement("div");
    row.className = "doctor-item";
    row.innerHTML = `<div class="doctor-info"><h4>${escapeHtml(label)}</h4><p><code>${escapeHtml(maskKey(key))}</code></p></div>`;
    const btn = document.createElement("button");
    btn.className = "btn btn-ghost btn-sm";
    btn.style.color = "#f87171";
    btn.textContent = "Revoke";
    btn.addEventListener("click", async () => {
      if (!confirm(`Revoke key '${label}'? Clients using it get 401 from now on.`)) return;
      try {
        await window.api.revokeKey(key);
      } catch (err) {
        alert(`Revoke failed: ${err.message}`);
      }
      loadKeys();
    });
    row.appendChild(btn);
    list.appendChild(row);
  }
}

document.getElementById("btn-create-key")?.addEventListener("click", async () => {
  const input = document.getElementById("new-key-label");
  const label = input?.value.trim() || "desktop-user";
  try {
    const key = await window.api.createKey(label);
    if (input) input.value = "";
    await navigator.clipboard.writeText(key);
    alert(`Key '${label}' created and copied to the clipboard.`);
  } catch (err) {
    alert(`Could not create the key: ${err.message}`);
  }
  loadKeys();
});

document.getElementById("btn-save-settings")?.addEventListener("click", async () => {
  if (!window.api) return;
  const res = await window.api.saveSettings({
    port: parseInt(document.getElementById("setting-port")?.value, 10),
    autostart: document.getElementById("setting-autostart")?.checked,
    closeToTray: document.getElementById("setting-closetotray")?.checked,
    noProxy: document.getElementById("setting-noproxy")?.checked,
    agyPath: document.getElementById("setting-agypath")?.value.trim() || null,
  });
  alert(res?.restartPending ? "Saved. The bridge restarts with the new settings once no request is running (use Restart)." : "Settings saved.");
  loadSettingsForm();
});

// Start / Stop and Restart
document.getElementById("toggle-service-btn")?.addEventListener("click", async () => {
  if (!window.api) return;
  if (["stopped", "crashloop", "port-busy"].includes(currentBridgeState)) await window.api.startBridge();
  else await window.api.stopBridge();
  const d = await window.api.getState();
  updateStatusDisplay(d.state, d.port);
});

document.getElementById("restart-server-btn")?.addEventListener("click", async () => {
  if (!window.api) return;
  await window.api.restartBridge();
  const d = await window.api.getState();
  updateStatusDisplay(d.state, d.port);
});

// Getting started
const startModal = document.getElementById("start-modal");

async function refreshGettingStarted() {
  if (!window.api) return;
  const agy = await window.api.detectAgy();
  setText("start-agy", agy.found ? `Found: ${agy.path} (version ${agy.version || "unknown"})` : "Not installed yet.");
  const profiles = Object.keys(await window.api.listProfiles());
  setText("start-profiles", profiles.length ? `${profiles.length} profile(s): ${profiles.join(", ")}` : "No profile yet.");
}

document.getElementById("open-wizard-btn")?.addEventListener("click", () => {
  startModal?.classList.add("open");
  refreshGettingStarted();
});
document.getElementById("btn-close-start")?.addEventListener("click", () => startModal?.classList.remove("open"));
document.getElementById("btn-start-recheck")?.addEventListener("click", refreshGettingStarted);
document.getElementById("btn-start-install")?.addEventListener("click", async () => {
  try {
    await window.api.installAgy();
    setText("start-agy", "The installer runs in the terminal window; press Check again when it has finished.");
  } catch (err) {
    setText("start-agy", `Could not open a terminal: ${err.message}`);
  }
});
document.getElementById("btn-start-add")?.addEventListener("click", () => {
  startModal?.classList.remove("open");
  openAddModal();
});
document.getElementById("btn-start-hermes")?.addEventListener("click", () => {
  startModal?.classList.remove("open");
  document.querySelector('.nav-item[data-tab="hermes"]')?.click();
});

function escapeHtml(str) {
  if (str === null || str === undefined) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// Initial setup
setLanguage("th");
loadProfiles();
loadHermesSnippet();
loadSettingsForm();
