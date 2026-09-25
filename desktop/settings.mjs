/**
 * Desktop Edition settings management.
 * Persists application preferences to settings.json in userData.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export const DEFAULT_SETTINGS = {
  port: 8008,
  autostart: true,
  openAsHidden: true,
  // A tray app: closing the window keeps the bridge serving Hermes (Quit is in the tray menu).
  closeToTray: true,
  agyPath: null,
  apiKeyLabel: "hermes-desktop",
  onboarded: false,
  noProxy: false,
  theme: "dark",
  language: "th",
};

export function getSettingsPath(userDataDir = null) {
  if (userDataDir) {
    return path.join(userDataDir, "settings.json");
  }
  const base = process.env.APPDATA || path.join(os.homedir(), ".config", "antigravity");
  return path.join(base, "desktop-settings.json");
}

export function loadSettings(userDataDir = null) {
  const filePath = getSettingsPath(userDataDir);
  if (!fs.existsSync(filePath)) {
    return { ...DEFAULT_SETTINGS };
  }
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    const port = parseInt(parsed.port, 10);
    return {
      ...DEFAULT_SETTINGS,
      ...parsed,
      port: Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : DEFAULT_SETTINGS.port,
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings, userDataDir = null) {
  const filePath = getSettingsPath(userDataDir);
  const current = loadSettings(userDataDir);
  const updated = { ...current, ...settings };

  const port = parseInt(updated.port, 10);
  if (Number.isInteger(port) && port >= 1024 && port <= 65535) {
    updated.port = port;
  } else {
    updated.port = DEFAULT_SETTINGS.port;
  }

  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(filePath, JSON.stringify(updated, null, 2), {
      encoding: "utf-8",
      mode: 0o600,
    });
    return updated;
  } catch (err) {
    console.error("[Settings] Failed to save settings:", err);
    return current;
  }
}

export function updateSettings(partial, userDataDir = null) {
  return saveSettings(partial, userDataDir);
}
