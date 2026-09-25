/**
 * "Add profile" in the desktop app. agy's sign-in runs in a terminal window of its own (its TUI needs a
 * real terminal) with HOME = an empty login HOME and file mode set, prepared by src/core/profile-login.mjs;
 * the app waits for the token agy writes there and then stores it as the profile. `core` is that module
 * (loaded through bridge-paths.mjs, so this file works in a checkout and in a packaged app alike).
 */
import fs from "node:fs";
import path from "node:path";
import { openTerminalScript } from "./terminal.mjs";

// agy writes the token once, right after the code exchange; a few quiet seconds mean it is complete.
const TOKEN_STABLE_MS = 3000;

// ASCII only on Windows (see terminal.mjs); %VAR% / "$VAR" are the environment set below.
const WINDOWS_LINES = [
  "title Antigravity Bridge - Google sign-in (%AGB_PROFILE%)",
  "cd /d \"%USERPROFILE%\"",
  "echo ======================================================================",
  "echo  Sign in the Google account for profile %AGB_PROFILE%:",
  "echo   1. Choose \"1. Google OAuth\" and press Enter.",
  "echo   2. Open the URL agy prints in your browser and sign in.",
  "echo   3. Copy the code Google shows, paste it here and press Enter.",
  "echo   4. The app picks the login up by itself; then type /exit here.",
  "echo ======================================================================",
  "\"%AGB_AGY%\"",
  "echo done> \"%AGB_MARKER%\"",
  "echo.",
  "echo Finished. You can close this window.",
  "pause",
];

const POSIX_LINES = [
  "cd \"$HOME\" || exit 1",
  "clear",
  "echo '======================================================================'",
  "echo \" Sign in the Google account for profile $AGB_PROFILE:\"",
  "echo '  1. Choose \"1. Google OAuth\" and press Enter.'",
  "echo '  2. Open the URL agy prints in your browser (Cmd+click it) and sign in.'",
  "echo '  3. Copy the code Google shows, paste it here and press Enter.'",
  "echo '  4. The app picks the login up by itself; then type /exit here.'",
  "echo '======================================================================'",
  "\"$AGB_AGY\"",
  "echo done > \"$AGB_MARKER\"",
  "echo",
  "echo 'Finished. You can close this window.'",
];

/** Opens the sign-in terminal. Resolves to a handle for waitForDesktopLogin() / cancel (handle.cancelled = true). */
export async function startDesktopLogin(name, { core, agyPath, tmpDir, platform = process.platform, spawnFn }) {
  if (!agyPath) throw new Error("Antigravity CLI (agy) not found. Install it first.");
  const ctx = await core.prepareLogin(name, { mode: "file" });
  const marker = path.join(tmpDir, `login-${name}.done`);
  fs.rmSync(marker, { force: true });
  const env = { ...core.loginEnvOverrides(ctx), AGB_AGY: agyPath, AGB_MARKER: marker, AGB_PROFILE: name };
  try {
    const script = await openTerminalScript({
      platform,
      dir: tmpDir,
      name: `login-${name}`,
      env,
      windowsLines: WINDOWS_LINES,
      posixLines: POSIX_LINES,
      spawnFn,
    });
    return { name, ctx, marker, script, cancelled: false };
  } catch (err) {
    await core.cleanupLogin(ctx, { keepTarget: false });
    throw new Error(`Could not open a terminal window for the sign-in: ${err.message}`);
  }
}

/**
 * Waits until agy has written a complete token (and either exited or left it unchanged for a few seconds:
 * the user may just close the window), then stores the profile. On timeout, cancel or failure the login
 * HOME is removed and an existing profile is left untouched.
 */
export async function waitForDesktopLogin(handle, { core, timeoutMs = 10 * 60 * 1000, pollMs = 1000, stableMs = TOKEN_STABLE_MS, fetchFn } = {}) {
  const { name, ctx, marker } = handle;
  const tokenFile = core.loginTokenFile(ctx);
  const deadline = Date.now() + timeoutMs;
  let seenMtime = null;
  let stableSince = 0;
  try {
    for (;;) {
      if (handle.cancelled) throw new Error("Sign-in cancelled");
      const exited = fs.existsSync(marker);
      if (core.readLoginToken(ctx)) {
        let mtime = 0;
        try {
          mtime = fs.statSync(tokenFile).mtimeMs;
        } catch {
          // Token found at one of the other paths agy may use
        }
        if (mtime !== seenMtime) {
          seenMtime = mtime;
          stableSince = Date.now();
        }
        if (exited || Date.now() - stableSince >= stableMs) break;
      } else if (exited) {
        throw new Error("agy exited without completing the sign-in");
      }
      if (Date.now() >= deadline) throw new Error(`No sign-in within ${Math.round(timeoutMs / 60000)} minutes`);
      await new Promise((r) => setTimeout(r, pollMs));
    }
    return await core.collectLogin(name, { prepareCtx: ctx, fetchFn });
  } catch (err) {
    await core.cleanupLogin(ctx, { keepTarget: false });
    throw err;
  } finally {
    fs.rmSync(marker, { force: true });
    if (handle.script) fs.rmSync(handle.script, { force: true });
  }
}

/**
 * Adds the profile to bridge_config.json's rotation. Without a list the bridge rotates over every profile
 * directory it finds, so the list starts from those (`available`): writing just the new name would
 * silently drop all the others.
 */
export function addToRotation(name, { configPath, available = [] }) {
  let cfg = {};
  try {
    cfg = JSON.parse(fs.readFileSync(configPath, "utf-8")) || {};
  } catch {
    cfg = {};
  }
  const list = Array.isArray(cfg.profiles) ? [...cfg.profiles] : [...available];
  if (!list.includes(name)) list.push(name);
  cfg.profiles = list;
  fs.mkdirSync(path.dirname(configPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2), "utf-8");
  return list;
}

/** Removes the profile from bridge_config.json's rotation (if listed). Returns the new list or null. */
export function removeFromRotation(name, { configPath }) {
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(configPath, "utf-8"));
  } catch {
    return null;
  }
  if (!cfg || !Array.isArray(cfg.profiles)) return null;
  cfg.profiles = cfg.profiles.filter((p) => p !== name);
  fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2), "utf-8");
  return cfg.profiles;
}
