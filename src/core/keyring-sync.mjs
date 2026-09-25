import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { getCanonicalAntigravityDir } from "../config.mjs";
import {
  assertSafeProfileName,
  writePrivateFile,
  copyPrivateFile,
  mkdirPrivate,
} from "./security.mjs";
import { readToken, writeToken } from "./keyring.mjs";

export function getOsType() {
  const p = process.platform;
  if (p === "darwin") return "darwin";
  if (p === "linux") return "linux";
  if (p === "win32") return "windows";
  return "other";
}

export function getAuthSyncDirectories() {
  const home = os.homedir();
  const dirs = [
    path.join(home, ".gemini"),
    path.join(home, ".gemini", "antigravity-cli"),
    path.join(home, ".config", "antigravity"),
    path.join(home, ".config", "gemini"),
  ];

  const seen = new Set();
  const result = [];
  for (const d of dirs) {
    const norm = path.resolve(d);
    if (!seen.has(norm)) {
      seen.add(norm);
      result.push(d);
    }
  }
  return result;
}

export function injectOsKeyringToken(rawOauthStr) {
  try {
    const parsed = typeof rawOauthStr === "string" ? JSON.parse(rawOauthStr) : rawOauthStr;
    return writeToken(parsed);
  } catch {
    return writeToken(rawOauthStr);
  }
}

export function extractOsKeyringToken() {
  return readToken();
}

export function extractOsFileToken() {
  const syncDirs = getAuthSyncDirectories();
  for (const td of syncDirs) {
    const tokFile = path.join(td, "antigravity-oauth-token");
    if (fs.existsSync(tokFile)) {
      try {
        const d = JSON.parse(fs.readFileSync(tokFile, "utf-8"));
        const tok = d.token || d;
        if (tok.access_token || tok.refresh_token) {
          return d;
        }
      } catch {
        // Ignore
      }
    }

    const oauthFile = path.join(td, "oauth_creds.json");
    if (fs.existsSync(oauthFile)) {
      try {
        const d = JSON.parse(fs.readFileSync(oauthFile, "utf-8"));
        const tok = d.token || d;
        if (tok.access_token || tok.refresh_token) {
          return d;
        }
      } catch {
        // Ignore
      }
    }
  }
  return null;
}

export function syncProfileToSystem(profileName) {
  assertSafeProfileName(profileName);
  const configBase = getCanonicalAntigravityDir();
  let profileDir = path.join(configBase, "profiles", profileName);
  if (!fs.existsSync(profileDir)) {
    const altDir = path.join(configBase, profileName);
    if (fs.existsSync(altDir) && fs.statSync(altDir).isDirectory()) {
      profileDir = altDir;
    }
  }

  let tokenPreview = "N/A";
  let emailPreview = "N/A";

  if (!fs.existsSync(profileDir) || !fs.statSync(profileDir).isDirectory()) {
    return [emailPreview, tokenPreview];
  }

  const targetDirs = getAuthSyncDirectories();
  for (const td of targetDirs) {
    mkdirPrivate(td);
  }

  // 1. Copy JSON & token files
  const filesToCopy = [
    "oauth_creds.json",
    "google_accounts.json",
    "state.json",
    "settings.json",
    "antigravity-oauth-token",
  ];

  for (const f of filesToCopy) {
    const src = path.join(profileDir, f);
    if (fs.existsSync(src)) {
      for (const td of targetDirs) {
        const dst = path.join(td, f);
        if (path.resolve(src) !== path.resolve(dst)) {
          try {
            copyPrivateFile(src, dst);
          } catch {
            // Ignore
          }
        }
      }

      if (f === "google_accounts.json") {
        try {
          const gData = JSON.parse(fs.readFileSync(src, "utf-8"));
          emailPreview = gData.active || "unknown";
        } catch {
          // Ignore
        }
      } else if (f === "oauth_creds.json") {
        try {
          const oData = JSON.parse(fs.readFileSync(src, "utf-8"));
          const t = oData.access_token || (oData.token && oData.token.access_token) || "";
          if (t) {
            tokenPreview = t.length > 20 ? `${t.slice(0, 12)}...${t.slice(-6)}` : t;
          }
        } catch {
          // Ignore
        }
      }
    }
  }

  // 2. Generate and write antigravity-oauth-token
  const oauthFile = path.join(profileDir, "oauth_creds.json");
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
          writePrivateFile(path.join(td, "antigravity-oauth-token"), tokJsonStr);
        } catch {
          // Ignore
        }
      }

      // 3. Inject into system Keyring / macOS Keychain
      injectOsKeyringToken(rawContent);
    } catch {
      // Ignore
    }
  }

  return [emailPreview, tokenPreview];
}
