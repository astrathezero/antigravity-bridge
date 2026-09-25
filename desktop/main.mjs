/**
 * Main process of the desktop edition. The bridge runs in a utility process (bridge-supervisor.mjs), so
 * its process.exit() and global handlers cannot take the app down; this process owns the window, the tray
 * and the actions the UI asks for. Actions on profiles and keys go to the running bridge over HTTP:
 * importing the bridge's modules here would give this process a second, disconnected ProfileManager.
 *
 * No top-level await: an ESM main that awaits app.whenReady() at the top level never gets `ready`.
 */
import { app, BrowserWindow, Tray, Menu, ipcMain, dialog, powerMonitor, shell, nativeImage } from "electron";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { BridgeSupervisor } from "./bridge-supervisor.mjs";
import { loadSettings, saveSettings } from "./settings.mjs";
import { findAgy, getAgyVersion, openInstallTerminal } from "./agy-installer.mjs";
import { startDesktopLogin, waitForDesktopLogin, addToRotation, removeFromRotation } from "./profile-login.mjs";
import { bridgeSrcDir, bootstrapEntry, importBridge } from "./bridge-paths.mjs";
import { readApiKeys, envFiles, bridgeEnvFile } from "./keys.mjs";
import { hermesSnippet, hermesHome } from "./hermes.mjs";

// The environment the app was started with, taken before any bridge module is imported: src/config.mjs
// loads the .env files into process.env when imported, and the bridge must load them itself on each start
// (a key created later would otherwise be shadowed by this process's stale copy).
const LAUNCH_ENV = { ...process.env };
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOME = os.homedir();
const CONFIG_DIR = path.join(HOME, ".config", "antigravity");
// The same files for this process and the bridge, whatever the cwd (it is "/" when opened from Finder).
const PINNED_ENV = {
  ANTIGRAVITY_BRIDGE_CONFIG: LAUNCH_ENV.ANTIGRAVITY_BRIDGE_CONFIG || path.join(CONFIG_DIR, "bridge_config.json"),
  ANTIGRAVITY_QUOTA_CACHE_FILE: LAUNCH_ENV.ANTIGRAVITY_QUOTA_CACHE_FILE || path.join(CONFIG_DIR, "quota_cache_node.json"),
  ANTIGRAVITY_SANDBOX_BASE: LAUNCH_ENV.ANTIGRAVITY_SANDBOX_BASE || path.join(CONFIG_DIR, "sandboxes-node"),
};
Object.assign(process.env, PINNED_ENV);
// ANTIGRAVITY_DESKTOP_SMOKE=1: start everything with the window hidden, wait for an authenticated /health,
// print one "SMOKE {...}" line and quit (exit 0 = healthy). For tests and CI, no user interaction.
const SMOKE = LAUNCH_ENV.ANTIGRAVITY_DESKTOP_SMOKE === "1";

let bridge = null; // the bridge's own modules (config, auth, security, profile manager, profile login)
let mainWindow = null;
let tray = null;
let supervisor = null;
let settings = null;
let userDataDir = null;
let bridgeCwd = null;
let quitting = false;
const activeLogins = new Map();

if (!app.requestSingleInstanceLock()) {
  app.quit(); // the running instance shows its window (second-instance)
} else {
  app.on("second-instance", () => showWindow());
  app.whenReady().then(main).catch((err) => {
    dialog.showErrorBox("Antigravity Bridge", String(err?.stack || err));
    app.exit(1);
  });
  app.on("before-quit", onBeforeQuit);
  app.on("window-all-closed", () => {
    if (!settings?.closeToTray) app.quit();
  });
}

async function main() {
  userDataDir = app.getPath("userData");
  bridgeCwd = path.join(userDataDir, "bridge");
  fs.mkdirSync(bridgeCwd, { recursive: true, mode: 0o700 });
  settings = loadSettings(userDataDir);
  bridge = {
    config: await importBridge("config.mjs"),
    auth: await importBridge("auth.mjs"),
    security: await importBridge("core/security.mjs"),
    profiles: await importBridge("core/profile-manager.mjs"),
    login: await importBridge("core/profile-login.mjs"),
  };

  applyLoginItem();
  ensureApiKey();

  supervisor = new BridgeSupervisor({
    entry: bootstrapEntry(),
    cwd: bridgeCwd,
    logFile: path.join(app.getPath("logs"), "bridge.log"),
    port: settings.port,
    env: bridgeEnv,
    getApiKey: firstApiKey,
    knownSecrets: () => Object.keys(apiKeys()),
  });
  supervisor.on("state", (state) => {
    updateTray(state);
    sendToWindow("bridge:state", { state, health: supervisor.lastHealth, port: settings.port });
  });
  supervisor.on("health", (health) => sendToWindow("bridge:state", { state: supervisor.state, health, port: settings.port }));
  supervisor.on("log", (line) => sendToWindow("bridge:log", line));
  supervisor.on("fatal", (why) => {
    if (mainWindow && !mainWindow.isDestroyed()) dialog.showMessageBox(mainWindow, { type: "error", message: why });
  });
  powerMonitor.on("resume", () => supervisor.noteResume());

  setupIpcHandlers();
  createTray();
  if (SMOKE || !startedHidden()) showWindow();
  if (SMOKE) runSmoke();
  await supervisor.start();
}

async function runSmoke() {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline && !(supervisor.state === "healthy" && supervisor.lastHealth?.concurrency)) {
    await new Promise((r) => setTimeout(r, 250));
  }
  const healthy = supervisor.state === "healthy" && Boolean(supervisor.lastHealth?.concurrency);
  let chat = null;
  if (healthy) {
    const res = await supervisor
      .request("/v1/chat/completions", { method: "POST", body: { model: "antigravity", messages: [{ role: "user", content: "hi" }] }, timeoutMs: 60000 })
      .catch((err) => ({ status: String(err) }));
    chat = { status: res.status, text: res.json?.choices?.[0]?.message?.content?.slice(0, 40) };
  }
  await new Promise((r) => setTimeout(r, 1000)); // let the renderer receive the state
  const ui = await mainWindow?.webContents
    .executeJavaScript('({ status: document.getElementById("status-text")?.textContent, hermes: document.getElementById("hermes-yaml-snippet")?.textContent?.split("\\n")[5] })')
    .catch((err) => ({ error: String(err) }));
  console.log(`SMOKE ${JSON.stringify({ healthy, chat, electron: process.versions.electron, state: supervisor.state, keys: Object.keys(apiKeys()).length, userData: userDataDir, entry: bootstrapEntry(), ui })}`);
  quitting = true;
  await supervisor.stop({ force: true });
  app.exit(healthy && chat?.status === 200 ? 0 : 1);
}

// ---------------------------------------------------------------- bridge environment, keys, requests

function pathKey(env) {
  return Object.keys(env).find((k) => k.toUpperCase() === "PATH") || "PATH";
}

/** Environment of each bridge start: the launch environment, the pinned files, agy's path and install dirs. */
function bridgeEnv() {
  const agy = findAgy(settings.agyPath);
  const env = {
    ...LAUNCH_ENV,
    ...PINNED_ENV,
    ANTIGRAVITY_DESKTOP_BRIDGE_SRC: bridgeSrcDir(),
    ANTIGRAVITY_PORT: String(settings.port),
    ANTIGRAVITY_HOST: "127.0.0.1",
  };
  if (settings.noProxy) env.ANTIGRAVITY_NO_PROXY = "1";
  // A GUI app gets the system PATH only (macOS: /usr/bin:/bin:/usr/sbin:/sbin): add agy's usual homes.
  const sep = process.platform === "win32" ? ";" : ":";
  const extra =
    process.platform === "win32"
      ? [LAUNCH_ENV.LOCALAPPDATA && path.join(LAUNCH_ENV.LOCALAPPDATA, "agy", "bin")]
      : [path.join(HOME, ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin"];
  if (agy) extra.unshift(path.dirname(agy));
  const key = pathKey(env);
  const parts = String(env[key] || "").split(sep).filter(Boolean);
  for (const dir of extra) if (dir && !parts.includes(dir)) parts.push(dir);
  env[key] = parts.join(sep);
  if (agy && !LAUNCH_ENV.ANTIGRAVITY_BRIDGE_CMD && !agy.includes('"')) {
    env.ANTIGRAVITY_BRIDGE_CMD = `"${agy}" --dangerously-skip-permissions --print-timeout 20m0s --output-format stream-json -p "{prompt}"`;
  }
  return env;
}

function apiKeys() {
  return readApiKeys({ homedir: HOME, bridgeCwd, launchEnv: LAUNCH_ENV, parseApiKeys: bridge.auth.parseApiKeys });
}

function firstApiKey() {
  return Object.keys(apiKeys())[0] || null;
}

/** The env file keys are written to: the first that exists (as the bridge picks it), else bridge.env. */
function keyFile() {
  return envFiles({ homedir: HOME, bridgeCwd }).find((f) => fs.existsSync(f)) || bridgeEnvFile(HOME);
}

/**
 * The desktop edition never runs anonymous: create a key before the first start if there is none, in
 * ~/.config/antigravity/bridge.env (which the bridge then also picks for keys created later).
 */
function ensureApiKey() {
  if (firstApiKey()) return;
  const label = settings.apiKeyLabel || "hermes-desktop";
  const [ok, where] = bridge.auth.saveApiKeyToEnv(label, bridge.auth.generateApiKey(), bridgeEnvFile(HOME));
  if (!ok) dialog.showErrorBox("Antigravity Bridge", `Could not save an API key: ${where}`);
}

const bridgeRunning = () => Boolean(supervisor?.child) && ["healthy", "degraded", "unresponsive"].includes(supervisor.state);

async function bridgeCall(pathname, { method = "GET", body = null, timeoutMs = 10000 } = {}) {
  if (!bridgeRunning()) throw new Error("The bridge is not running");
  const { status, json } = await supervisor.request(pathname, { method, body, timeoutMs });
  if (status >= 400) throw new Error(json?.error?.message || (typeof json?.error === "string" ? json.error : `HTTP ${status}`));
  return json;
}

function requireProfileName(name) {
  if (typeof name !== "string" || !name || !bridge.security.isSafeProfileName(name)) {
    throw new Error("Profile names use 1-64 characters: A-Z a-z 0-9 . _ - (starting with a letter or digit)");
  }
  return name;
}

// ---------------------------------------------------------------- window, tray, quitting

function sendToWindow(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

function startedHidden() {
  if (process.platform === "darwin") return Boolean(app.getLoginItemSettings().wasOpenedAsHidden);
  return process.argv.includes("--hidden");
}

function applyLoginItem() {
  // Only a packaged app: in development this would register the bare Electron binary as a login item.
  if (!app.isPackaged) return;
  try {
    app.setLoginItemSettings({
      openAtLogin: Boolean(settings.autostart),
      openAsHidden: Boolean(settings.openAsHidden),
      args: settings.openAsHidden ? ["--hidden"] : [],
    });
  } catch {
    // Unsupported on this platform
  }
}

function showWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    return;
  }
  mainWindow = new BrowserWindow({
    width: 1040,
    height: 720,
    minWidth: 860,
    minHeight: 600,
    title: "Antigravity Bridge",
    show: false,
    backgroundColor: "#0d1117",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, "ui", "index.html"));
  mainWindow.once("ready-to-show", () => {
    if (SMOKE) return;
    mainWindow.show();
    mainWindow.focus();
  });
  // The UI never navigates: links open in the browser, anything else is refused.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (e) => e.preventDefault());
  mainWindow.on("close", (e) => {
    if (settings?.closeToTray && !quitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
}

function createTray() {
  // 16x16 placeholder until the app has real icons (build/).
  const icon = nativeImage.createFromDataURL(
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAAXNSR0IArs4c6QAAAE9JREFUOE9jZKAQMFKon2HUAAYGBoa/DAwM/5kYGRn/MzAw/EcnQ0eDYYAGRgNGBsNoGIxhQDU8RsNgDAOm4TEqEAYASqIID2i39v8AAAAASUVORK5CYII="
  );
  tray = new Tray(icon);
  tray.on("click", () => showWindow());
  updateTray(supervisor.state);
}

const STATE_LABELS = {
  healthy: "Serving",
  degraded: "Every profile is cooling down",
  unresponsive: "Not answering",
  starting: "Starting...",
  stopped: "Stopped",
  crashloop: "Crash loop (not restarting)",
  "port-busy": "Port in use",
};

function updateTray(state) {
  if (!tray) return;
  const label = STATE_LABELS[state] || state;
  tray.setToolTip(`Antigravity Bridge: ${label}`);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: `Status: ${label}`, enabled: false },
      { type: "separator" },
      { label: "Open Dashboard", click: () => showWindow() },
      { label: "Restart Bridge", click: () => restartBridge() },
      { type: "separator" },
      { label: "Quit", click: () => app.quit() },
    ])
  );
}

/** Asks before cutting requests in flight. Resolves true when it is fine to go ahead. */
async function confirmCutRequests(action) {
  await supervisor.pollHealth();
  const busy = supervisor.inFlight();
  if (!busy) return true;
  const { response } = await dialog.showMessageBox(mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined, {
    type: "warning",
    buttons: ["Cancel", `${action} anyway`],
    defaultId: 0,
    cancelId: 0,
    message: `${busy} request(s) are still running. ${action} now and they fail (Hermes shows an error).`,
  });
  return response === 1;
}

async function restartBridge() {
  if (!(await confirmCutRequests("Restart"))) return { restarted: false };
  return supervisor.restart({ force: true });
}

async function onBeforeQuit(e) {
  if (quitting) return;
  e.preventDefault();
  if (supervisor && !(await confirmCutRequests("Quit"))) return;
  quitting = true;
  for (const handle of activeLogins.values()) handle.cancelled = true;
  try {
    await supervisor?.stop({ force: true });
  } catch (err) {
    console.error("[Main] Error while stopping the bridge:", err);
  }
  app.exit(0);
}

// ---------------------------------------------------------------- IPC

function setupIpcHandlers() {
  ipcMain.handle("bridge:start", () => supervisor.start());
  ipcMain.handle("bridge:restart", () => restartBridge());
  ipcMain.handle("bridge:stop", async () => {
    if (!(await confirmCutRequests("Stop"))) return { stopped: false };
    return supervisor.stop({ force: true });
  });
  ipcMain.handle("bridge:getLogs", () => supervisor.getRingLogs());
  ipcMain.handle("bridge:getState", () => ({ state: supervisor.state, health: supervisor.lastHealth, port: settings.port }));

  ipcMain.handle("agy:detect", () => {
    const agyBin = findAgy(settings.agyPath);
    return { found: Boolean(agyBin), path: agyBin, version: getAgyVersion(agyBin) };
  });
  ipcMain.handle("agy:install", async () => {
    await openInstallTerminal(process.platform, userDataDir);
    return true;
  });

  ipcMain.handle("profile:list", async () => {
    if (bridgeRunning()) {
      try {
        const summary = (await bridgeCall("/v1/profiles", { timeoutMs: 3000 })).profiles || {};
        // The bridge's summary has no e-mail; each profile's google_accounts.json does.
        for (const [name, info] of Object.entries(summary)) {
          info.email = bridge.profiles.getProfileAccountEmail(name === "default" ? null : name);
        }
        return summary;
      } catch {
        // Fall back to what is on disk
      }
    }
    const result = {};
    for (const p of bridge.profiles.getAvailableProfiles()) {
      result[p || "default"] = { email: bridge.profiles.getProfileAccountEmail(p), status: "bridge not running" };
    }
    return result;
  });

  ipcMain.handle("profile:add", async (_event, rawName) => {
    const name = requireProfileName(rawName);
    if (activeLogins.has(name)) throw new Error(`A sign-in for '${name}' is already open`);
    const agyPath = findAgy(settings.agyPath);
    const handle = await startDesktopLogin(name, {
      core: bridge.login,
      agyPath,
      tmpDir: path.join(userDataDir, "tmp"),
    });
    activeLogins.set(name, handle);
    try {
      const result = await waitForDesktopLogin(handle, { core: bridge.login });
      const list = addToRotation(name, {
        configPath: PINNED_ENV.ANTIGRAVITY_BRIDGE_CONFIG,
        available: bridge.profiles.getAvailableProfiles(),
      });
      if (bridgeRunning()) await bridgeCall("/v1/profiles/config", { method: "POST", body: { profiles: list } }).catch(() => {});
      return result;
    } finally {
      activeLogins.delete(name);
    }
  });

  ipcMain.handle("profile:cancelAdd", (_event, name) => {
    const handle = activeLogins.get(name);
    if (handle) handle.cancelled = true;
    return Boolean(handle);
  });

  ipcMain.handle("profile:remove", async (_event, rawName) => {
    const name = requireProfileName(rawName);
    fs.rmSync(path.join(CONFIG_DIR, "profiles", name), { recursive: true, force: true });
    const list = removeFromRotation(name, { configPath: PINNED_ENV.ANTIGRAVITY_BRIDGE_CONFIG });
    if (bridgeRunning()) {
      const profiles = list || bridge.profiles.getAvailableProfiles().filter((p) => p !== name);
      await bridgeCall("/v1/profiles/config", { method: "POST", body: { profiles } }).catch(() => {});
    }
    // The sandboxes hold copies of the profile's tokens and its agy history.
    const sandboxBase = PINNED_ENV.ANTIGRAVITY_SANDBOX_BASE;
    fs.rmSync(path.join(sandboxBase, name), { recursive: true, force: true });
    fs.rmSync(path.join(sandboxBase, ".token-refresh", name), { recursive: true, force: true });
    return { success: true };
  });

  for (const [channel, endpoint] of [
    ["profile:disable", "/v1/profiles/disable"],
    ["profile:enable", "/v1/profiles/enable"],
    ["profile:reset", "/v1/profiles/reset"],
  ]) {
    ipcMain.handle(channel, async (_event, rawName) => {
      await bridgeCall(endpoint, { method: "POST", body: { profile: requireProfileName(rawName) } });
      return { success: true };
    });
  }

  ipcMain.handle("profile:probe", async (_event, rawName) => {
    const name = requireProfileName(rawName);
    // One short agy run on this profile (it uses a little of the account's quota).
    const json = await bridgeCall("/v1/profiles/check", {
      method: "POST",
      body: { profile: name, prompt: "Reply with exactly one word: OK" },
      timeoutMs: 60000,
    });
    const r = json?.results?.[name];
    if (!r?.ok) throw new Error(r?.error || "probe failed");
    return { success: true, message: r.latency };
  });

  ipcMain.handle("key:list", () => Object.entries(apiKeys()).map(([key, label]) => ({ label, key })));

  ipcMain.handle("key:create", async (_event, rawLabel) => {
    const label = String(rawLabel || "desktop-user").trim();
    if (!bridge.security.API_KEY_LABEL_RE.test(label)) throw new Error("Labels use 1-64 characters: A-Z a-z 0-9 . _ -");
    if (bridgeRunning()) return (await bridgeCall("/v1/keys/create", { method: "POST", body: { label } })).key;
    const key = bridge.auth.generateApiKey();
    const [ok, where] = bridge.auth.saveApiKeyToEnv(label, key, keyFile());
    if (!ok) throw new Error(`Could not save the key: ${where}`);
    return key;
  });

  ipcMain.handle("key:revoke", async (_event, target) => {
    const t = String(target || "").trim();
    if (!t) throw new Error("Nothing to revoke");
    if (bridgeRunning()) {
      await bridgeCall("/v1/keys/revoke", { method: "POST", body: { target: t } });
      return true;
    }
    const [ok, where] = bridge.auth.revokeApiKeyFromEnv(t, keyFile());
    if (!ok) throw new Error(where);
    return true;
  });

  ipcMain.handle("hermes:snippet", () =>
    hermesSnippet({ port: settings.port, apiKey: firstApiKey(), contextLimits: bridge.config.MODEL_CONTEXT_LIMITS })
  );
  ipcMain.handle("hermes:openDir", async () => {
    const dir = hermesHome({ homedir: HOME });
    if (!fs.existsSync(dir)) return { ok: false, path: dir };
    await shell.openPath(dir);
    return { ok: true, path: dir };
  });

  ipcMain.handle("settings:get", () => settings);
  ipcMain.handle("settings:set", async (_event, incoming = {}) => {
    const next = {};
    if (incoming.port !== undefined) next.port = incoming.port;
    for (const k of ["autostart", "closeToTray", "noProxy", "openAsHidden"]) if (typeof incoming[k] === "boolean") next[k] = incoming[k];
    if (incoming.agyPath === null || typeof incoming.agyPath === "string") next.agyPath = incoming.agyPath?.trim() || null;
    const before = settings;
    settings = saveSettings(next, userDataDir);
    applyLoginItem();
    // Port, proxy and agy path only apply when the bridge starts.
    const needsRestart = ["port", "noProxy", "agyPath"].some((k) => before[k] !== settings[k]);
    if (needsRestart && supervisor.child) {
      if (!(await confirmCutRequests("Restart"))) return { ...settings, restartPending: true };
      await supervisor.stop({ force: true });
      supervisor.setPort(settings.port);
      await supervisor.start();
    } else {
      supervisor.setPort(settings.port);
    }
    return settings;
  });

  ipcMain.handle("doctor:run", () => runDoctor());

  // Only the app's own folders, never an arbitrary path from the renderer (shell.openPath runs programs).
  ipcMain.handle("shell:openPath", (_event, which) => {
    const dirs = { logs: app.getPath("logs"), config: CONFIG_DIR, userData: userDataDir };
    if (!dirs[which]) throw new Error("Unknown folder");
    return shell.openPath(dirs[which]);
  });
  ipcMain.handle("shell:openExternal", (_event, url) => {
    if (typeof url === "string" && /^https:\/\//.test(url)) shell.openExternal(url);
  });
}

async function runDoctor() {
  const agyBin = findAgy(settings.agyPath);
  const agyVer = getAgyVersion(agyBin);
  const keys = apiKeys();
  const profiles = bridge.profiles.getAvailableProfiles();
  const portFree = bridgeRunning() || (await supervisor.checkPortAvailable(settings.port));
  let realConfigDir = CONFIG_DIR;
  try {
    realConfigDir = fs.realpathSync.native(CONFIG_DIR);
  } catch {
    // Not created yet
  }
  const synced = /OneDrive|Dropbox|Google Drive|iCloud|CloudStorage/i.test(realConfigDir);
  return [
    { name: "Operating system", ok: true, detail: `${process.platform} ${os.arch()} ${os.release()}` },
    { name: "Runtime", ok: true, detail: `Electron ${process.versions.electron}, Node ${process.version}` },
    {
      name: "Antigravity CLI (agy)",
      ok: Boolean(agyBin),
      detail: agyBin ? `${agyBin} (version ${agyVer || "unknown"})` : "Not found: use Install agy, then Check again",
    },
    {
      name: `Bridge on port ${settings.port}`,
      ok: ["healthy", "degraded"].includes(supervisor.state),
      detail: `${STATE_LABELS[supervisor.state] || supervisor.state}${portFree ? "" : " (the port is used by another program)"}`,
    },
    { name: "API key", ok: Object.keys(keys).length > 0, detail: `${Object.keys(keys).length} key(s) in ${keyFile()}` },
    { name: "Profiles", ok: profiles.length > 0, detail: `${profiles.length} profile(s): ${profiles.join(", ") || "none, add one"}` },
    {
      name: "agy token storage",
      ok: bridge.config.agyTokenMode() === "file",
      detail:
        bridge.config.agyTokenMode() === "file"
          ? "One token file per profile (agy file mode via SSH_CONNECTION); the OS keyring is not used"
          : "Keyring mode: requests run one at a time",
    },
    {
      name: "Profile folder",
      ok: !synced,
      detail: synced ? `${CONFIG_DIR} is inside a synced folder: tokens and keys get uploaded` : CONFIG_DIR,
    },
  ];
}
