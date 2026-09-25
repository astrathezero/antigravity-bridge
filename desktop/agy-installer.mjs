/**
 * Helper module for finding, verifying, and guiding installation of agy CLI binary.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { openTerminalScript } from "./terminal.mjs";

export function findAgy(customPath = null, options = {}) {
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  const exists = options.exists || fs.existsSync;
  const homedir = options.homedir || os.homedir();
  const isWindows = platform === "win32";
  const pathLib = isWindows ? path.win32 : path.posix;

  if (customPath && typeof customPath === "string" && exists(customPath)) {
    return customPath;
  }

  // 1. Check well-known installation locations
  const candidates = [];
  if (isWindows) {
    if (env.LOCALAPPDATA) {
      candidates.push(pathLib.join(env.LOCALAPPDATA, "agy", "bin", "agy.exe"));
      candidates.push(pathLib.join(env.LOCALAPPDATA, "Programs", "agy", "bin", "agy.exe"));
    }
    if (homedir) {
      candidates.push(pathLib.join(homedir, "AppData", "Local", "agy", "bin", "agy.exe"));
      candidates.push(pathLib.join(homedir, ".local", "bin", "agy.exe"));
    }
  } else {
    candidates.push(pathLib.join(homedir, ".local", "bin", "agy"));
    candidates.push("/opt/homebrew/bin/agy");
    candidates.push("/usr/local/bin/agy");
    candidates.push("/usr/bin/agy");
  }

  for (const c of candidates) {
    if (exists(c)) return c;
  }

  // 2. Check PATH environment variable
  const pathSep = isWindows ? ";" : ":";
  const exeName = isWindows ? "agy.exe" : "agy";
  const pathDirs = (env.PATH || "").split(pathSep).map((d) => d.trim()).filter(Boolean);

  for (const dir of pathDirs) {
    const full = pathLib.join(dir, exeName);
    if (exists(full)) return full;
  }

  return null;
}

export function getAgyVersion(agyPath) {
  if (!agyPath || !fs.existsSync(agyPath)) {
    return null;
  }
  try {
    const res = spawnSync(agyPath, ["--version"], {
      encoding: "utf-8",
      timeout: 5000,
      windowsHide: true,
    });
    if (res.status === 0 && res.stdout) {
      const match = res.stdout.match(/\b\d+\.\d+\.\d+\b/);
      return match ? match[0] : res.stdout.trim().slice(0, 40);
    }
  } catch {
    // Binary execution error
  }
  return null;
}

// Google's official installers (https://antigravity.google/docs/cli/install/). Note the /cli/ segment:
// https://antigravity.google/install.sh and /install.ps1 answer 404.
export const AGY_INSTALL_SH = "https://antigravity.google/cli/install.sh";
export const AGY_INSTALL_PS1 = "https://antigravity.google/cli/install.ps1";

export function getInstallInstructions(platform = process.platform) {
  if (platform === "win32") {
    return {
      platform: "win32",
      command: `irm ${AGY_INSTALL_PS1} | iex`,
      description: "Run this command in PowerShell to install the Antigravity CLI:",
      shell: "powershell",
    };
  }
  return {
    platform,
    command: `curl -fsSL ${AGY_INSTALL_SH} | bash`,
    description: "Run this command in Terminal to install the Antigravity CLI:",
    shell: "bash",
  };
}

/** Opens a terminal that runs Google's installer. Resolves to the script path; rejects if no terminal opened. */
export function openInstallTerminal(platform = process.platform, userDataDir = null, { spawnFn } = {}) {
  const dir = userDataDir ? path.join(userDataDir, "tmp") : os.tmpdir();
  return openTerminalScript({
    platform,
    dir,
    name: "install-agy",
    spawnFn,
    windowsLines: [
      "title Install the Antigravity CLI (agy)",
      "echo Installing the Antigravity CLI (agy) with Google's installer:",
      `echo   irm ${AGY_INSTALL_PS1} ^| iex`,
      `powershell -NoProfile -ExecutionPolicy Bypass -Command "irm ${AGY_INSTALL_PS1} | iex"`,
      "echo.",
      'echo Done. Close this window and press "Check again" in Antigravity Bridge.',
      "pause",
    ],
    posixLines: [
      "echo \"Installing the Antigravity CLI (agy) with Google's installer:\"",
      `echo "  curl -fsSL ${AGY_INSTALL_SH} | bash"`,
      `curl -fsSL ${AGY_INSTALL_SH} | bash`,
      "echo",
      "echo 'Done. Close this window and press \"Check again\" in Antigravity Bridge.'",
      "read -r -p 'Press Enter to close this window...' _",
    ],
  });
}
