import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { getCanonicalAntigravityDir, detectCliCommand } from "../config.mjs";
import { getOsType } from "./keyring-sync.mjs";
import { getAvailableProfiles } from "./profile-manager.mjs";
import { getProfileSandboxBasePath } from "./sandbox.mjs";
import { assertSafeProfileName, writePrivateFile, mkdirPrivate, macKeychainStore } from "./security.mjs";

/**
 * Hard ceiling on one profile's `agy` refresh run. agy performs the OAuth exchange during start-up,
 * long before it talks to a model, so a healthy refresh finishes in a second or two; the run is ended
 * as soon as the new token appears on disk. The ceiling only bounds a run that never gets there, such
 * as an account whose quota is used up (agy then retries a 429 eight times over ~2.5 minutes).
 */
export const DEFAULT_TOKEN_REFRESH_TIMEOUT_MS =
  parseInt(process.env.ANTIGRAVITY_TOKEN_REFRESH_TIMEOUT_MS || "45000", 10) || 45000;

const TOKEN_POLL_INTERVAL_MS = 250;

function sleep(ms) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    if (typeof t.unref === "function") t.unref();
  });
}

function killTree(child) {
  if (!child || !child.pid) return;
  try {
    if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"]);
    else process.kill(-child.pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // already gone
    }
  }
}

/** The profile's directory under ~/.config/antigravity (either layout), or null when absent. */
export function getProfileDir(profile) {
  assertSafeProfileName(profile);
  const configBase = getCanonicalAntigravityDir();
  const pName = profile || "default";
  const primary = path.join(configBase, "profiles", pName);
  if (fs.existsSync(primary)) return primary;
  const alt = path.join(configBase, pName);
  if (fs.existsSync(alt)) return alt;
  return primary;
}

/**
 * A HOME of its own for this profile's refresh run, next to (never inside) the sandbox the live
 * requests use. Before 2026-09-21 the refresh ran agy against the real HOME, which every profile and
 * both editions share: a profile whose own run never produced a token read back whatever the
 * previously refreshed profile had just written there and stored that account's access token as its
 * own (seen on the production host: three profiles holding another account's token, so their requests
 * spent that account's quota). An isolated HOME makes that impossible.
 */
export function getTokenRefreshHome(profile) {
  const sandbox = getProfileSandboxBasePath(profile);
  return path.join(path.dirname(sandbox), ".token-refresh", path.basename(sandbox));
}

/** Auth file locations agy reads and writes under a given HOME. */
function refreshAuthDirs(home) {
  return [
    home,
    path.join(home, ".gemini"),
    path.join(home, ".gemini", "antigravity-cli"),
    path.join(home, ".config", "antigravity"),
    path.join(home, ".config", "gemini"),
  ];
}

function readTokenFile(file) {
  try {
    const d = JSON.parse(fs.readFileSync(file, "utf-8"));
    const tok = d && typeof d.token === "object" && d.token ? d.token : d;
    if (!tok || typeof tok !== "object") return null;
    return { accessToken: tok.access_token || "", refreshToken: tok.refresh_token || "", expiry: tok.expiry || "" };
  } catch {
    return null;
  }
}

/**
 * The refreshed token agy wrote under `home`, or null while there is none yet. A token is only
 * accepted when it carries this profile's own refresh_token: anything else belongs to another
 * account and must never be written into this profile.
 */
export function findRefreshedToken(home, ownRefreshToken) {
  for (const dir of refreshAuthDirs(home)) {
    for (const name of ["antigravity-oauth-token", "oauth_creds.json"]) {
      const found = readTokenFile(path.join(dir, name));
      if (!found || !found.accessToken) continue;
      if (found.refreshToken && ownRefreshToken && found.refreshToken !== ownRefreshToken) continue;
      return found;
    }
  }
  return null;
}

/** Write the refreshed access token back into the profile's own files. */
function storeRefreshedToken(profileDir, data, accessToken, expiry) {
  data.access_token = accessToken;
  if (data.token && typeof data.token === "object") {
    data.token.access_token = accessToken;
    data.token.expiry = expiry;
  }
  writePrivateFile(path.join(profileDir, "oauth_creds.json"), JSON.stringify(data, null, 2));
  writePrivateFile(
    path.join(profileDir, "antigravity-oauth-token"),
    JSON.stringify({ token: data.token || data, auth_method: data.auth_method || "consumer" }, null, 2),
    "utf-8"
  );
}

/**
 * Run `agy` until it has exchanged the refresh token, or until the deadline. Returns the fresh token
 * or null. The process never blocks the event loop and is always killed before this resolves.
 */
async function runAgyUntilToken(execBinary, env, cwd, onPoll, timeoutMs) {
  const child = spawn(execBinary, ["--dangerously-skip-permissions", "-p", "hi"], {
    cwd,
    env,
    detached: process.platform !== "win32",
    stdio: "ignore",
  });

  let exited = false;
  child.on("error", () => {
    exited = true;
  });
  child.on("close", () => {
    exited = true;
  });

  const deadline = Date.now() + timeoutMs;
  try {
    for (;;) {
      const found = onPoll();
      if (found) return found;
      if (exited) return onPoll();
      if (Date.now() >= deadline) return null;
      await sleep(TOKEN_POLL_INTERVAL_MS);
    }
  } finally {
    killTree(child);
  }
}

/**
 * Refresh one profile's OAuth access token. Resolves to [ok, message]; never throws and never blocks
 * the event loop (before 2026-09-21 this used spawnSync, which froze the whole bridge for the
 * duration of every run: 15-16 minutes per cycle on the production host once several accounts were
 * out of quota, which read as "the bridge hangs, restart it").
 */
export async function refreshProfileToken(profile, options = {}) {
  // osType is injectable so the tests can exercise the path production runs (Linux) on any host,
  // and so no test ever writes to a developer's real login keychain.
  const { agyExec = null, timeoutMs = DEFAULT_TOKEN_REFRESH_TIMEOUT_MS, osType = getOsType() } = options;
  assertSafeProfileName(profile);
  const profileDir = getProfileDir(profile);
  const oauthFile = path.join(profileDir, "oauth_creds.json");
  if (!fs.existsSync(oauthFile)) return [false, `oauth_creds.json not found in ${profileDir}`];

  let data;
  try {
    data = JSON.parse(fs.readFileSync(oauthFile, "utf-8"));
  } catch (err) {
    return [false, `Failed reading ${oauthFile}: ${err.message}`];
  }

  const refreshTok =
    data.refresh_token || (data.token && typeof data.token === "object" ? data.token.refresh_token : null);
  if (!refreshTok) return [false, "refresh_token is missing"];

  const execBinary = agyExec || detectCliCommand().binary;
  const forcePayload = {
    token: { access_token: "", refresh_token: refreshTok, token_type: "Bearer", expiry: "2020-01-01T00:00:00Z" },
    auth_method: "consumer",
  };

  if (osType === "darwin") {
    // macOS keeps the token in the login keychain, which is one shared entry per machine; there is no
    // per-profile isolation to be had, so only the blocking is fixed here.
    macKeychainStore("gemini", "antigravity", "go-keyring-base64:" + Buffer.from(JSON.stringify(forcePayload), "utf-8").toString("base64"));
    const readKeychain = () => {
      try {
        const res = spawnSync("security", ["find-generic-password", "-s", "gemini", "-a", "antigravity", "-w"], { encoding: "utf-8" });
        if (res.status !== 0 || !res.stdout) return null;
        const raw = res.stdout.trim().replace("go-keyring-base64:", "");
        const d = JSON.parse(Buffer.from(raw, "base64").toString("utf-8"));
        const tok = d.token && typeof d.token === "object" ? d.token : d;
        if (!tok.access_token) return null;
        if (tok.refresh_token && tok.refresh_token !== refreshTok) return null;
        return { accessToken: tok.access_token, expiry: tok.expiry || "" };
      } catch {
        return null;
      }
    };
    const found = await runAgyUntilToken(execBinary, process.env, undefined, readKeychain, timeoutMs);
    if (!found) return [false, `no refreshed token within ${Math.round(timeoutMs / 1000)}s (account may need re-login)`];
    storeRefreshedToken(profileDir, data, found.accessToken, found.expiry);
    return [true, `New Access Token generated (expires ${found.expiry})`];
  }

  // Linux / Windows: agy reads and writes the token under HOME, so an isolated HOME per profile
  // keeps concurrent refreshes (including the Python edition's) from mixing accounts up.
  const home = getTokenRefreshHome(profile);
  const dirs = refreshAuthDirs(home);
  for (const d of dirs) mkdirPrivate(d);
  for (const d of dirs) {
    try {
      writePrivateFile(path.join(d, "antigravity-oauth-token"), JSON.stringify(forcePayload));
    } catch {
      // Ignore: another directory may still work.
    }
    try {
      fs.rmSync(path.join(d, "oauth_creds.json"), { force: true });
    } catch {
      // Ignore
    }
  }
  // agy identifies the account from these; copy whatever the profile has.
  for (const name of ["google_accounts.json", "state.json", "settings.json"]) {
    const src = path.join(profileDir, name);
    if (!fs.existsSync(src)) continue;
    for (const d of dirs) {
      try {
        fs.copyFileSync(src, path.join(d, name));
      } catch {
        // Ignore
      }
    }
  }

  const env = { ...process.env, HOME: home, USERPROFILE: home };
  env.XDG_CONFIG_HOME = path.join(home, ".config");
  env.XDG_DATA_HOME = path.join(home, ".local", "share");
  env.XDG_CACHE_HOME = path.join(home, ".cache");
  if (profile) env.ANTIGRAVITY_PROFILE = profile;

  const found = await runAgyUntilToken(execBinary, env, home, () => findRefreshedToken(home, refreshTok), timeoutMs);
  if (!found) {
    return [false, `no refreshed token within ${Math.round(timeoutMs / 1000)}s (quota exhausted or account needs re-login)`];
  }
  storeRefreshedToken(profileDir, data, found.accessToken, found.expiry);
  return [true, `New Access Token generated (expires ${found.expiry})`];
}

/** One pass over every profile, in sequence, awaiting each so the event loop stays free. */
export async function runTokenRefreshCycle(profiles, { intervalMin = null, timeoutMs = DEFAULT_TOKEN_REFRESH_TIMEOUT_MS, agyExec = null, osType = undefined } = {}) {
  const label = intervalMin === null ? "" : `${intervalMin}-minute `;
  console.log(`[AUTO-REFRESH] ⏰ Starting scheduled ${label}OAuth token refresh for ${profiles.length} profile(s)...`);
  const started = Date.now();
  let successCount = 0;
  for (const p of profiles) {
    let ok = false;
    let msg = "";
    try {
      [ok, msg] = await refreshProfileToken(p, { timeoutMs, agyExec, ...(osType ? { osType } : {}) });
    } catch (err) {
      ok = false;
      msg = err?.message || String(err);
    }
    if (ok) {
      successCount++;
      console.log(`[AUTO-REFRESH] Profile '${p || "default"}': ${msg}`);
    } else {
      console.warn(`[AUTO-REFRESH] Profile '${p || "default"}' refresh failed: ${msg}`);
    }
  }
  console.log(
    `[AUTO-REFRESH] Scheduled refresh completed (${successCount}/${profiles.length} profiles refreshed successfully) in ${((Date.now() - started) / 1000).toFixed(1)}s.`
  );
  return successCount;
}

export function startTokenRefreshDaemon(profileManagerOrProfiles = null, intervalSeconds = 3300) {
  if (["1", "true", "yes"].includes((process.env.ANTIGRAVITY_NO_AUTO_REFRESH || "").toLowerCase())) {
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

  // A cycle that outlives its interval must not start a second one on top of itself.
  let running = false;
  const timer = setInterval(() => {
    if (running) {
      console.warn("[AUTO-REFRESH] Previous refresh cycle is still running; skipping this interval.");
      return;
    }
    running = true;
    runTokenRefreshCycle(getProfiles(), { intervalMin })
      .catch((err) => console.error(`[AUTO-REFRESH] Error during scheduled token refresh: ${err?.message || err}`))
      .finally(() => {
        running = false;
      });
  }, intervalSeconds * 1000);

  return timer;
}
