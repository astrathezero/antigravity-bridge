import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { getCanonicalAntigravityDir, detectCliCommand } from "../config.mjs";
import { getAuthSyncDirectories, getOsType } from "./keyring-sync.mjs";
import { getAvailableProfiles } from "./profile-manager.mjs";
import { assertSafeProfileName, writePrivateFile, mkdirPrivate, macKeychainStore } from "./security.mjs";

export function refreshProfileToken(profile, agyExec = null) {
  assertSafeProfileName(profile);
  const configBase = getCanonicalAntigravityDir();
  const pName = profile || "default";
  let pDir = path.join(configBase, "profiles", pName);
  if (!fs.existsSync(pDir)) {
    const cand = path.join(configBase, pName);
    if (fs.existsSync(cand)) {
      pDir = cand;
    }
  }

  const oauthFile = path.join(pDir, "oauth_creds.json");
  if (!fs.existsSync(oauthFile)) {
    return [false, `oauth_creds.json not found in ${pDir}`];
  }

  let data;
  try {
    data = JSON.parse(fs.readFileSync(oauthFile, "utf-8"));
  } catch (err) {
    return [false, `Failed reading ${oauthFile}: ${err.message}`];
  }

  const refreshTok =
    data.refresh_token ||
    (data.token && typeof data.token === "object" ? data.token.refresh_token : null);

  if (!refreshTok) {
    return [false, "refresh_token is missing"];
  }

  let execBinary = agyExec;
  if (!execBinary) {
    const cliDetect = detectCliCommand();
    execBinary = cliDetect.binary;
  }

  const osType = getOsType();
  if (osType === "darwin") {
    const keyringPayload = {
      token: {
        access_token: "",
        refresh_token: refreshTok,
        token_type: "Bearer",
        expiry: "2020-01-01T00:00:00Z",
      },
      auth_method: "consumer",
    };
    const b64Val =
      "go-keyring-base64:" +
      Buffer.from(JSON.stringify(keyringPayload), "utf-8").toString("base64");

    // Secret is piped over stdin (security -i), not exposed in argv.
    macKeychainStore("gemini", "antigravity", b64Val);

    // Execute agy to trigger Google auto-refresh
    spawnSync(execBinary, ["--dangerously-skip-permissions", "-p", "hi"], {
      stdio: "ignore",
    });

    try {
      const res = spawnSync(
        "security",
        ["find-generic-password", "-s", "gemini", "-a", "antigravity", "-w"],
        { encoding: "utf-8" }
      );
      if (res.status === 0 && res.stdout) {
        const raw = res.stdout.trim().replace("go-keyring-base64:", "");
        const freshD = JSON.parse(Buffer.from(raw, "base64").toString("utf-8"));
        const newAccessTok =
          (freshD.token && freshD.token.access_token) || freshD.access_token;
        const exp = (freshD.token && freshD.token.expiry) || "";
        if (newAccessTok) {
          data.access_token = newAccessTok;
          if (data.token && typeof data.token === "object") {
            data.token.access_token = newAccessTok;
            data.token.expiry = exp;
          }
          writePrivateFile(oauthFile, JSON.stringify(data, null, 2));
          const tokPath = path.join(pDir, "antigravity-oauth-token");
          writePrivateFile(
            tokPath,
            JSON.stringify(
              {
                token: data.token || data,
                auth_method: data.auth_method || "consumer",
              },
              null,
              2
            ),
            "utf-8"
          );
          return [true, `New Access Token generated (expires ${exp})`];
        }
      }
      return [false, "Google rejected refresh_token (account may need re-login)"];
    } catch (err) {
      return [false, `Keyring error: ${err.message}`];
    }
  } else {
    // Linux / Windows
    const fallbackPayload = {
      token: {
        access_token: "",
        refresh_token: refreshTok,
        token_type: "Bearer",
        expiry: "2020-01-01T00:00:00Z",
      },
      auth_method: "consumer",
    };

    for (const td of getAuthSyncDirectories()) {
      mkdirPrivate(td);
      try {
        writePrivateFile(
          path.join(td, "antigravity-oauth-token"),
          JSON.stringify(fallbackPayload)
        );
      } catch {
        // Ignore
      }
    }

    spawnSync(execBinary, ["--dangerously-skip-permissions", "-p", "hi"], {
      stdio: "ignore",
    });

    for (const td of getAuthSyncDirectories()) {
      const tokPath = path.join(td, "antigravity-oauth-token");
      if (fs.existsSync(tokPath)) {
        try {
          const freshD = JSON.parse(fs.readFileSync(tokPath, "utf-8"));
          const newAccessTok =
            (freshD.token && freshD.token.access_token) || freshD.access_token;
          const exp = (freshD.token && freshD.token.expiry) || "";
          if (newAccessTok) {
            data.access_token = newAccessTok;
            if (data.token && typeof data.token === "object") {
              data.token.access_token = newAccessTok;
              data.token.expiry = exp;
            }
            writePrivateFile(oauthFile, JSON.stringify(data, null, 2));
            writePrivateFile(
              path.join(pDir, "antigravity-oauth-token"),
              JSON.stringify(
                {
                  token: data.token || data,
                  auth_method: data.auth_method || "consumer",
                },
                null,
                2
              ),
              "utf-8"
            );
            return [true, `New Access Token generated (expires ${exp})`];
          }
        } catch {
          // Ignore
        }
      }
    }
    return [true, "Token refresh executed via agy"];
  }
}

export function startTokenRefreshDaemon(profileManagerOrProfiles = null, intervalSeconds = 3300) {
  if (
    ["1", "true", "yes"].includes(
      (process.env.ANTIGRAVITY_NO_AUTO_REFRESH || "").toLowerCase()
    )
  ) {
    console.log("[AUTO-REFRESH] Background token auto-refresh is disabled via ANTIGRAVITY_NO_AUTO_REFRESH");
    return null;
  }
  if (intervalSeconds <= 0) return null;
  const intervalMin = Math.floor(intervalSeconds / 60);

  const getProfiles = () => {
    if (profileManagerOrProfiles && typeof profileManagerOrProfiles.get_profiles === "function") {
      return profileManagerOrProfiles.get_profiles();
    }
    if (Array.isArray(profileManagerOrProfiles) && profileManagerOrProfiles.length > 0) {
      return profileManagerOrProfiles;
    }
    return getAvailableProfiles();
  };

  console.log(`[AUTO-REFRESH] Background OAuth Token Auto-Refresher started (interval: ${intervalMin} min)`);

  const timer = setInterval(() => {
    try {
      const profiles = getProfiles();
      console.log(`[AUTO-REFRESH] ⏰ Starting scheduled ${intervalMin}-minute OAuth token refresh for ${profiles.length} profile(s)...`);
      let successCount = 0;
      for (const p of profiles) {
        const [ok, msg] = refreshProfileToken(p);
        if (ok) {
          successCount++;
          console.log(`[AUTO-REFRESH] Profile '${p || "default"}': ${msg}`);
        } else {
          console.warn(`[AUTO-REFRESH] Profile '${p || "default"}' refresh failed: ${msg}`);
        }
      }
      console.log(`[AUTO-REFRESH] Scheduled refresh completed (${successCount}/${profiles.length} profiles refreshed successfully).`);
    } catch (err) {
      console.error(`[AUTO-REFRESH] Error during scheduled token refresh: ${err.message}`);
    }
  }, intervalSeconds * 1000);

  return timer;
}
