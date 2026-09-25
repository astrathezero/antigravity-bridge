/**
 * Preload (CommonJS, sandboxed renderer): the only API the UI gets. Every call is an IPC request that
 * main.mjs validates; the renderer has no Node access (contextIsolation + sandbox).
 */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
  // Bridge lifecycle & telemetry
  onBridgeState: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on("bridge:state", handler);
    return () => ipcRenderer.removeListener("bridge:state", handler);
  },
  onBridgeLog: (callback) => {
    const handler = (_event, line) => callback(line);
    ipcRenderer.on("bridge:log", handler);
    return () => ipcRenderer.removeListener("bridge:log", handler);
  },
  getState: () => ipcRenderer.invoke("bridge:getState"),
  startBridge: () => ipcRenderer.invoke("bridge:start"),
  restartBridge: () => ipcRenderer.invoke("bridge:restart"),
  stopBridge: () => ipcRenderer.invoke("bridge:stop"),
  getRecentLogs: () => ipcRenderer.invoke("bridge:getLogs"),

  // agy CLI detection & installation
  detectAgy: () => ipcRenderer.invoke("agy:detect"),
  installAgy: () => ipcRenderer.invoke("agy:install"),

  // Profiles
  listProfiles: () => ipcRenderer.invoke("profile:list"),
  addProfile: (name) => ipcRenderer.invoke("profile:add", name),
  cancelAddProfile: (name) => ipcRenderer.invoke("profile:cancelAdd", name),
  removeProfile: (name) => ipcRenderer.invoke("profile:remove", name),
  disableProfile: (name) => ipcRenderer.invoke("profile:disable", name),
  enableProfile: (name) => ipcRenderer.invoke("profile:enable", name),
  resetProfile: (name) => ipcRenderer.invoke("profile:reset", name),
  probeProfile: (name) => ipcRenderer.invoke("profile:probe", name),

  // API keys
  listKeys: () => ipcRenderer.invoke("key:list"),
  createKey: (label) => ipcRenderer.invoke("key:create", label),
  revokeKey: (label) => ipcRenderer.invoke("key:revoke", label),

  // Hermes
  getHermesSnippet: () => ipcRenderer.invoke("hermes:snippet"),
  openHermesConfigDir: () => ipcRenderer.invoke("hermes:openDir"),

  // Settings / diagnostics
  getSettings: () => ipcRenderer.invoke("settings:get"),
  saveSettings: (settings) => ipcRenderer.invoke("settings:set", settings),
  runDoctor: () => ipcRenderer.invoke("doctor:run"),

  // Shell helpers: `which` is "logs" | "config" | "userData"
  openFolder: (which) => ipcRenderer.invoke("shell:openPath", which),
  openExternal: (url) => ipcRenderer.invoke("shell:openExternal", url),
});
