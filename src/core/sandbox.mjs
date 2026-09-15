import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { assertSafeProfileName, writePrivateFile, mkdirPrivate } from "./security.mjs";

export class ProfileSandboxBusyError extends Error {
  constructor(message) {
    super(message);
    this.name = "ProfileSandboxBusyError";
  }
}

const inMemoryLocks = new Map();

export function getProfileSandboxBasePath(profileName) {
  assertSafeProfileName(profileName);
  const key = profileName || "default";
  const baseDir =
    process.env.ANTIGRAVITY_SANDBOX_BASE ||
    path.join(os.homedir(), ".config", "antigravity", "sandboxes-node");
  return path.join(baseDir, key);
}

export function isProfileSandboxLocked(profileName) {
  const key = profileName || "default";
  if (inMemoryLocks.get(key)) {
    return true;
  }

  const sandboxBase = getProfileSandboxBasePath(profileName);
  const lockFile = path.join(sandboxBase, ".sandbox.lock");
  if (fs.existsSync(lockFile)) {
    try {
      const pidStr = fs.readFileSync(lockFile, "utf-8").trim();
      const pid = parseInt(pidStr, 10);
      if (!isNaN(pid) && pid > 0) {
        // Check if process is still running
        try {
          process.kill(pid, 0);
          return true; // Still running
        } catch (e) {
          // Process does not exist (ESRCH), lock is stale
          return false;
        }
      }
    } catch {
      // Ignore read error
    }
  }
  return false;
}

export function acquireSandboxLock(profileName) {
  const key = profileName || "default";
  if (inMemoryLocks.get(key)) {
    throw new ProfileSandboxBusyError(
      `Profile '${key}' sandbox is currently locked by another in-flight request`
    );
  }

  const sandboxBase = getProfileSandboxBasePath(profileName);
  fs.mkdirSync(sandboxBase, { recursive: true });
  const lockFile = path.join(sandboxBase, ".sandbox.lock");

  if (fs.existsSync(lockFile)) {
    try {
      const pidStr = fs.readFileSync(lockFile, "utf-8").trim();
      const pid = parseInt(pidStr, 10);
      if (!isNaN(pid) && pid > 0) {
        try {
          process.kill(pid, 0);
          throw new ProfileSandboxBusyError(
            `Profile '${key}' sandbox is currently locked by running process (PID ${pid})`
          );
        } catch (err) {
          if (err instanceof ProfileSandboxBusyError) throw err;
          // Stale lock, can safely overwrite
        }
      }
    } catch (err) {
      if (err instanceof ProfileSandboxBusyError) throw err;
    }
  }

  // Acquire in-memory and write PID to lockfile
  inMemoryLocks.set(key, true);
  try {
    fs.writeFileSync(lockFile, String(process.pid), "utf-8");
  } catch {
    // Ignore write error if any
  }

  return function releaseLock() {
    inMemoryLocks.delete(key);
    try {
      if (fs.existsSync(lockFile)) {
        fs.unlinkSync(lockFile);
      }
    } catch {
      // Ignore unlink error
    }
  };
}

export function getProfileSandboxDir(profileName) {
  const key = profileName || "default";
  const sandboxBase = getProfileSandboxBasePath(profileName);
  const geminiDir = path.join(sandboxBase, ".gemini");
  const geminiCliDir = path.join(sandboxBase, ".gemini", "antigravity-cli");
  const configDir = path.join(sandboxBase, ".config", "antigravity");
  const configGemini = path.join(sandboxBase, ".config", "gemini");

  const targetDirs = [geminiDir, geminiCliDir, configDir, configGemini, sandboxBase];
  for (const td of targetDirs) {
    mkdirPrivate(td);
  }

  // Source profile directory
  const home = os.homedir();
  let srcDir = profileName
    ? path.join(home, ".config", "antigravity", "profiles", key)
    : path.join(home, ".gemini");

  if (profileName && !fs.existsSync(srcDir)) {
    const alt = path.join(home, ".config", "antigravity", key);
    if (fs.existsSync(alt)) {
      srcDir = alt;
    }
  }

  // Sync auth files into sandbox
  if (fs.existsSync(srcDir) && fs.statSync(srcDir).isDirectory()) {
    const authFiles = [
      "oauth_creds.json",
      "google_accounts.json",
      "state.json",
      "settings.json",
      "antigravity-oauth-token",
    ];

    for (const fname of authFiles) {
      const srcFile = path.join(srcDir, fname);
      if (fs.existsSync(srcFile)) {
        const srcMtime = fs.statSync(srcFile).mtimeMs;
        for (const destD of targetDirs) {
          const dstFile = path.join(destD, fname);
          try {
            if (!fs.existsSync(dstFile) || srcMtime > fs.statSync(dstFile).mtimeMs) {
              fs.copyFileSync(srcFile, dstFile);
            }
          } catch {
            // Ignore copy errors
          }
        }
      }
    }

    // Generate antigravity-oauth-token inside sandbox if oauth_creds.json is present
    const oauthFile = path.join(srcDir, "oauth_creds.json");
    if (fs.existsSync(oauthFile)) {
      try {
        const rawContent = fs.readFileSync(oauthFile, "utf-8");
        const oData = JSON.parse(rawContent);
        const rawTok = oData.token && typeof oData.token === "object" ? oData.token : oData;
        const authMeth = oData.auth_method || "consumer";
        const tokenObj = {
          token: {
            access_token: rawTok.access_token || "",
            token_type: rawTok.token_type || "Bearer",
            refresh_token: rawTok.refresh_token || "",
            expiry: rawTok.expiry || "2026-08-18T23:59:59+07:00",
          },
          auth_method: authMeth,
        };
        const tokJsonStr = JSON.stringify(tokenObj);
        for (const td of targetDirs) {
          try {
            const dstTok = path.join(td, "antigravity-oauth-token");
            writePrivateFile(dstTok, tokJsonStr);
          } catch {
            // Ignore
          }
        }
      } catch {
        // Ignore
      }
    }
  }

  // Clean stale lock and cache files from sandbox (matches Python lines 2889-2898)
  const staleFiles = [
    "update.lock",
    "knowledge.lock",
    "jetski_state.pbtxt",
    "default-cli-project.json",
    "default_project_id.txt",
  ];
  for (const sf of staleFiles) {
    for (const td of [geminiDir, sandboxBase]) {
      const lp = path.join(td, sf);
      if (fs.existsSync(lp)) {
        try {
          fs.unlinkSync(lp);
        } catch {
          // Ignore
        }
      }
    }
  }

  return sandboxBase;
}
