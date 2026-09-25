/**
 * `profile login` for the Node.js edition (CLI and desktop): sign agy in to one Google account and store
 * the result as a bridge profile, without Python.
 *
 * File mode (default, see agyTokenMode()): agy runs with HOME = a fresh, empty login HOME and
 * SSH_CONNECTION set, so it cannot silently reuse an account that is already signed in and it writes the
 * new token to <loginHome>/.gemini/antigravity-cli/antigravity-oauth-token. The user's own ~/.gemini and
 * OS keyring are never touched. agy in this mode does not open a browser: it prints a sign-in URL and asks
 * for the code Google shows after sign-in.
 *
 * Keyring mode (ANTIGRAVITY_AGY_TOKEN_MODE=keyring) keeps the Python edition's flow: the ~/.gemini auth
 * files are set aside and the keyring entry is cleared so agy asks for a login, and both are put back.
 *
 * The profile directory is written only once the new token is in hand and its account is known not to
 * belong to another profile, so a cancelled or failed login leaves an existing profile exactly as it was.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { writePrivateFile, mkdirPrivate, assertSafeProfileName } from "./security.mjs";
import { getCanonicalAntigravityDir, agyTokenMode, AGY_FILE_MODE_ENV, detectCliCommand } from "../config.mjs";
import { createKeyring } from "./keyring.mjs";

const TOKEN_SCOPE =
  "https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile openid";

/** Prepares an empty login HOME (file mode) or sets the user's agy login aside (keyring mode). */
export async function prepareLogin(name, options = {}) {
  assertSafeProfileName(name);
  if (!name) throw new Error("A profile name is required");

  const baseDir = path.resolve(options.baseDir || getCanonicalAntigravityDir());
  const profilesDir = path.join(baseDir, "profiles");
  const targetDir = path.join(profilesDir, name);
  const targetExisted = fs.existsSync(targetDir);
  const mode = options.mode || agyTokenMode();

  if (mode === "file") {
    const loginHome = path.resolve(options.loginHome || path.join(baseDir, ".login", name));
    fs.rmSync(loginHome, { recursive: true, force: true });
    mkdirPrivate(loginHome);
    return { mode: "file", name, baseDir, profilesDir, targetDir, targetExisted, loginHome };
  }

  const keyring = options.keyring || createKeyring({ platform: options.platform });
  let savedKeyringToken = null;
  try {
    savedKeyringToken = await keyring.getPassword("gemini", "antigravity");
  } catch {
    // Ignore read errors
  }
  try {
    await keyring.deletePassword("gemini", "antigravity");
  } catch {
    // Ignore deletion errors
  }

  const homedir = path.resolve(options.homedir || os.homedir());
  const geminiDir = path.join(homedir, ".gemini");
  const backups = [];
  if (fs.existsSync(geminiDir)) {
    for (const file of ["oauth_creds.json", "google_accounts.json", "state.json"]) {
      const src = path.join(geminiDir, file);
      if (!fs.existsSync(src)) continue;
      const bak = path.join(geminiDir, `.login_bak_${name}_${file}`);
      try {
        fs.copyFileSync(src, bak);
        fs.unlinkSync(src);
        backups.push({ src, bak });
      } catch {
        // Ignore copy errors
      }
    }
  }

  return {
    mode: "keyring",
    name,
    baseDir,
    profilesDir,
    targetDir,
    targetExisted,
    homedir,
    geminiDir,
    backups,
    savedKeyringToken,
    keyring,
  };
}

/** The variables agy needs for this login on top of the user's environment. */
export function loginEnvOverrides(prepareCtx) {
  const overrides = { ANTIGRAVITY_PROFILE: prepareCtx.name };
  if (prepareCtx.mode === "file") {
    const home = prepareCtx.loginHome;
    Object.assign(overrides, AGY_FILE_MODE_ENV, {
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: path.join(home, ".config"),
      XDG_DATA_HOME: path.join(home, ".local", "share"),
      XDG_CACHE_HOME: path.join(home, ".cache"),
    });
  }
  return overrides;
}

/** The environment of the interactive agy: the user's own (its TUI needs TERM etc.) minus the bridge's keys. */
export function loginEnvironment(prepareCtx, baseEnv = process.env) {
  const env = {};
  for (const [k, v] of Object.entries(baseEnv)) {
    if (k.startsWith("ANTIGRAVITY_") && /_KEYS?$/i.test(k)) continue;
    env[k] = v;
  }
  return Object.assign(env, loginEnvOverrides(prepareCtx));
}

/** Runs agy interactively in this terminal until the user leaves it. */
export async function runInteractiveLogin(name, options = {}) {
  const { prepareCtx } = options;
  if (!prepareCtx) throw new Error("Missing prepareCtx from prepareLogin()");

  const cliBin = options.cliBin || detectCliCommand().binary;
  const spawnFn = options.spawnFn || spawn;
  const env = { ...loginEnvironment(prepareCtx), ...options.env };

  return new Promise((resolve, reject) => {
    const child = spawnFn(cliBin, options.cliArgs || [], {
      env,
      stdio: options.stdio || "inherit",
      windowsHide: true,
    });
    child.on("error", (err) => reject(err));
    child.on("close", (code, signal) => resolve({ exitCode: code ?? 0, signal }));
  });
}

/** Where agy writes the token of a file-mode login. */
export function loginTokenFile(prepareCtx) {
  return path.join(prepareCtx.loginHome, ".gemini", "antigravity-cli", "antigravity-oauth-token");
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return null;
  }
}

/** The token agy has written for a file-mode login, once it carries both tokens; otherwise null. */
export function readLoginToken(prepareCtx) {
  if (prepareCtx.mode !== "file") return null;
  for (const file of [
    loginTokenFile(prepareCtx),
    path.join(prepareCtx.loginHome, ".gemini", "antigravity-oauth-token"),
    path.join(prepareCtx.loginHome, ".gemini", "oauth_creds.json"),
  ]) {
    const data = readJson(file);
    const token = data && typeof data.token === "object" && data.token ? data.token : data;
    if (token?.access_token && token?.refresh_token) return data;
  }
  return null;
}

/** The account agy itself recorded for the login (google_accounts.json), used when userinfo is unreachable. */
function readAgyAccountEmail(loginHome) {
  if (!loginHome) return null;
  for (const file of [
    path.join(loginHome, ".gemini", "google_accounts.json"),
    path.join(loginHome, ".gemini", "antigravity-cli", "google_accounts.json"),
  ]) {
    const active = readJson(file)?.active;
    if (typeof active === "string" && active.includes("@")) return active;
  }
  return null;
}

async function fetchAccountEmail(accessToken, fetchFn, timeoutMs) {
  try {
    const res = await fetchFn("https://www.googleapis.com/oauth2/v3/userinfo", {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return typeof data?.email === "string" ? data.email : null;
  } catch {
    return null;
  }
}

function profileEmail(profileDir) {
  const active = readJson(path.join(profileDir, "google_accounts.json"))?.active;
  return typeof active === "string" ? active : null;
}

/**
 * Stores the new login as the profile (0600 files) once the account is confirmed not to belong to another
 * profile, then removes the login HOME. Throws, leaving any existing profile untouched, when there is no
 * token or the account is already another profile's.
 */
export async function collectLogin(name, options = {}) {
  const { prepareCtx } = options;
  if (!prepareCtx) throw new Error("Missing prepareCtx from prepareLogin()");

  try {
    let tokenData = readLoginToken(prepareCtx);
    if (!tokenData && prepareCtx.mode === "keyring") {
      const keyring = options.keyring || prepareCtx.keyring || createKeyring();
      try {
        const raw = options.keyringToken ?? (await keyring.getPassword("gemini", "antigravity"));
        if (raw) tokenData = typeof raw === "string" ? JSON.parse(raw) : raw;
      } catch {
        // Ignore
      }
      if (!tokenData && prepareCtx.geminiDir) tokenData = readJson(path.join(prepareCtx.geminiDir, "oauth_creds.json"));
    }
    if (!tokenData) throw new Error(`No OAuth token found for profile '${name}' after login`);

    const rawToken = tokenData.token && typeof tokenData.token === "object" ? tokenData.token : tokenData;
    const accessToken = rawToken.access_token || tokenData.access_token || "";
    const refreshToken = rawToken.refresh_token || tokenData.refresh_token || "";
    if (!accessToken) throw new Error(`OAuth token for profile '${name}' has no access_token`);
    if (!refreshToken) throw new Error(`OAuth token for profile '${name}' has no refresh_token, so it could not be kept alive`);
    const tokenType = rawToken.token_type || tokenData.token_type || "Bearer";
    const authMethod = tokenData.auth_method || "consumer";
    const expiry = rawToken.expiry || tokenData.expiry || new Date(Date.now() + 3600 * 1000).toISOString();
    const expiryDate = Date.parse(expiry) || Date.now() + 3600 * 1000;

    const verifiedEmail = await fetchAccountEmail(accessToken, options.fetchFn || fetch, options.timeoutMs ?? 5000);
    const email = verifiedEmail || readAgyAccountEmail(prepareCtx.loginHome);

    if (email && fs.existsSync(prepareCtx.profilesDir)) {
      for (const entry of fs.readdirSync(prepareCtx.profilesDir)) {
        if (entry === name) continue;
        const other = profileEmail(path.join(prepareCtx.profilesDir, entry));
        if (other && other.toLowerCase() === email.toLowerCase()) {
          throw new Error(`Account '${email}' is already registered in profile '${entry}'`);
        }
      }
    }

    const token = { access_token: accessToken, refresh_token: refreshToken, token_type: tokenType, expiry };
    const oauthData = {
      access_token: accessToken,
      refresh_token: refreshToken,
      token_type: tokenType,
      scope: TOKEN_SCOPE,
      expiry,
      expiry_date: expiryDate,
      token,
      auth_method: authMethod,
      ...(tokenData.id_token ? { id_token: tokenData.id_token } : {}),
    };

    mkdirPrivate(prepareCtx.targetDir);
    writePrivateFile(path.join(prepareCtx.targetDir, "oauth_creds.json"), JSON.stringify(oauthData, null, 2));
    writePrivateFile(
      path.join(prepareCtx.targetDir, "antigravity-oauth-token"),
      JSON.stringify({ token, auth_method: authMethod, ...(tokenData.id_token ? { id_token: tokenData.id_token } : {}) }, null, 2)
    );
    for (const [file, content] of [
      ["google_accounts.json", { active: email, old: [] }],
      ["state.json", { active: email }],
    ]) {
      const target = path.join(prepareCtx.targetDir, file);
      // A re-login may switch accounts: never leave the previous account's e-mail behind.
      if (email) writePrivateFile(target, JSON.stringify(content, null, 2));
      else fs.rmSync(target, { force: true });
    }

    return {
      success: true,
      email: email || "unknown",
      verified: Boolean(verifiedEmail),
      profile: name,
      targetDir: prepareCtx.targetDir,
    };
  } finally {
    await cleanupLogin(prepareCtx);
  }
}

/**
 * Removes the login HOME (file mode) or restores the user's own agy login (keyring mode). Idempotent.
 * `keepTarget: false` removes the profile directory only when this login created it.
 */
export async function cleanupLogin(prepareCtx, { keepTarget = true } = {}) {
  if (!prepareCtx) return;

  if (prepareCtx.mode === "file") {
    if (prepareCtx.loginHome) fs.rmSync(prepareCtx.loginHome, { recursive: true, force: true });
  } else if (prepareCtx.mode === "keyring") {
    for (const { src, bak } of prepareCtx.backups || []) {
      try {
        if (fs.existsSync(bak)) {
          fs.copyFileSync(bak, src);
          fs.unlinkSync(bak);
        }
      } catch {
        // Ignore restore error
      }
    }
    prepareCtx.backups = [];
    if (prepareCtx.savedKeyringToken && prepareCtx.keyring) {
      try {
        await prepareCtx.keyring.setPassword("gemini", "antigravity", prepareCtx.savedKeyringToken);
      } catch {
        // Ignore restore error
      }
      prepareCtx.savedKeyringToken = null;
    }
  }

  if (!keepTarget && !prepareCtx.targetExisted && prepareCtx.targetDir) {
    fs.rmSync(prepareCtx.targetDir, { recursive: true, force: true });
  }
}
