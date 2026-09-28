/**
 * Profile commands that used to exist only in the Python CLI: interactive login, doctor and copying
 * profiles to another host. Ported from antigravity_bridge.py (v1.0.0) so the Node.js edition no
 * longer needs Python for anything. The steps that touch the network, the keyring or agy take
 * injectable functions, so the tests drive them without any of those.
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { getCanonicalAntigravityDir, detectCliCommand, detectLocalProxy } from "../config.mjs";
import { extractOsKeyringToken, extractOsFileToken, getOsType } from "../core/keyring-sync.mjs";
import { getAvailableProfiles, getProfileAccountEmail } from "../core/profile-manager.mjs";
import { assertSafeProfileName, isSafeProfileName, mkdirPrivate, writePrivateFile, copyPrivateFile } from "../core/security.mjs";

const USERINFO_URL = "https://www.googleapis.com/oauth2/v3/userinfo";
const OAUTH_SCOPE =
  "https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile openid";
// The same fallbacks the Python login writes when agy's token carries no expiry of its own; the
// token daemon replaces both on its first refresh.
const FALLBACK_EXPIRY = "2026-08-18T23:59:59+07:00";
const FALLBACK_EXPIRY_DATE = 1789133170339;
const GEMINI_AUTH_FILES = ["oauth_creds.json", "google_accounts.json", "state.json"];
const REMOTE_RE = /^[A-Za-z0-9._][A-Za-z0-9._@-]*$/;

export function profilesDir() {
  return path.join(getCanonicalAntigravityDir(), "profiles");
}

/** The executable in a detectCliCommand() template (its first, possibly quoted, token). */
export function agyBinaryFromTemplate(template) {
  const m = String(template || "").trim().match(/^"([^"]+)"|^(\S+)/);
  return m ? m[1] || m[2] : "agy";
}

function tokenOf(data) {
  return data && typeof data.token === "object" && data.token ? data.token : data || {};
}

/**
 * Google's userinfo for an access token. Resolves { status, email } (status 0 when the request
 * itself failed) and never throws.
 */
export async function lookupUserInfo(accessToken, timeoutMs = 8000) {
  try {
    const res = await fetch(USERINFO_URL, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { status: res.status, email: null, reason: res.statusText };
    const data = await res.json();
    return { status: res.status, email: data.email || null };
  } catch (err) {
    return { status: 0, email: null, reason: err.message };
  }
}

function runAgyInteractive(name) {
  const bin = agyBinaryFromTemplate(detectCliCommand().template);
  const res = spawnSync(bin, [], { stdio: "inherit", env: { ...process.env, ANTIGRAVITY_PROFILE: name } });
  if (res.error && res.error.code === "ENOENT") {
    throw new Error(`'${bin}' binary not found. Make sure agy is installed.`);
  }
  return res.status;
}

/** Writes oauth_creds.json and antigravity-oauth-token for a token agy produced. Returns the access token. */
function saveToken(targetDir, rawToken, authMethod) {
  const token = {
    access_token: rawToken.access_token || "",
    refresh_token: rawToken.refresh_token || "",
    token_type: rawToken.token_type || "Bearer",
    expiry: rawToken.expiry || FALLBACK_EXPIRY,
  };
  const oauth = {
    access_token: token.access_token,
    refresh_token: token.refresh_token,
    token_type: token.token_type,
    scope: OAUTH_SCOPE,
    expiry_date: FALLBACK_EXPIRY_DATE,
    token,
    auth_method: authMethod || "consumer",
  };
  writePrivateFile(path.join(targetDir, "oauth_creds.json"), JSON.stringify(oauth, null, 2));
  writePrivateFile(
    path.join(targetDir, "antigravity-oauth-token"),
    JSON.stringify({ token, auth_method: oauth.auth_method }, null, 2)
  );
  return token.access_token;
}

/**
 * Logs a profile in with agy, the way `python3 antigravity_bridge.py profile login <name>` does:
 * ~/.gemini's auth files are moved aside so agy has to run its browser OAuth, the token agy stores
 * (OS keyring first, then its token files) is written into the profile directory together with the
 * verified account email, and ~/.gemini's own files are put back afterwards.
 *
 * deps (all optional, for tests): runAgy(name) -> exit status, extractKeyring(), extractFile(),
 * lookupEmail(accessToken) -> email|null, log(line).
 */
export async function loginProfile(name, deps = {}) {
  assertSafeProfileName(name);
  if (!name) throw new Error("Please specify a profile name");
  const runAgy = deps.runAgy || runAgyInteractive;
  const extractKeyring = deps.extractKeyring || extractOsKeyringToken;
  const extractFile = deps.extractFile || extractOsFileToken;
  const lookupEmail = deps.lookupEmail || (async (tok) => (await lookupUserInfo(tok, 5000)).email);
  const log = deps.log || ((line) => console.log(line));

  const targetDir = path.join(profilesDir(), name);
  mkdirPrivate(targetDir);
  // Stale files would let agy skip the login this command is for.
  for (const f of fs.readdirSync(targetDir)) {
    const fp = path.join(targetDir, f);
    try {
      if (!fs.lstatSync(fp).isDirectory()) fs.rmSync(fp, { force: true });
    } catch {
      // ignore
    }
  }

  log(`\n[INFO] Starting interactive login for profile '${name}'...`);
  log(`[INFO] Profile directory: ${targetDir}`);
  log("=".repeat(80));
  log("💡 ขั้นตอนการบันทึกโปรไฟล์ (Login Instructions):");
  log("   1. เมื่อหน้าต่างเบราว์เซอร์เปิดขึ้นมา (Browser OAuth):");
  log(`      - เลือกล็อกอินด้วยบัญชี Google ที่ต้องการผูกกับ '${name}'`);
  log("   2. เมื่อล็อกอินสำเร็จและกลับมาที่หน้าต่าง Terminal (ที่ขึ้นเครื่องหมาย > ):");
  log("      - พิมพ์คำว่า 'hi' แล้วกด Enter 1 ครั้ง เพื่อให้ระบบยืนยันสิทธิ์ Token");
  log("      - พิมพ์ '/exit' หรือกด Ctrl+D เพื่อบันทึก Credential และกลับสู่หน้าหลัก");
  log("=".repeat(80) + "\n");

  if (!deps.runAgy && getOsType() === "darwin") {
    // A stale keychain entry would also let agy skip the browser login.
    spawnSync("security", ["delete-generic-password", "-s", "gemini", "-a", "antigravity"], { stdio: "ignore" });
  }

  const geminiDir = path.join(os.homedir(), ".gemini");
  const moved = [];
  for (const f of GEMINI_AUTH_FILES) {
    const src = path.join(geminiDir, f);
    const bak = path.join(geminiDir, `.${f}.bak`);
    try {
      if (fs.existsSync(src)) {
        fs.renameSync(src, bak);
        moved.push([bak, src]);
      }
    } catch (err) {
      log(`[WARNING] Could not back up ${src}: ${err.message}`);
    }
  }

  let email = null;
  try {
    runAgy(name);

    let accessToken = "";
    let saved = false;
    const keyring = extractKeyring();
    const keyringToken = keyring && keyring.token;
    if (keyringToken && keyringToken.access_token) {
      accessToken = saveToken(targetDir, keyringToken, keyring.auth_method);
      saved = true;
    }
    if (!saved) {
      const fileData = extractFile();
      if (fileData) {
        accessToken = saveToken(targetDir, tokenOf(fileData), fileData.auth_method);
        saved = true;
      }
    }
    if (!saved) {
      // Whatever agy left in ~/.gemini is the best there is.
      for (const f of GEMINI_AUTH_FILES) {
        const src = path.join(geminiDir, f);
        if (fs.existsSync(src)) copyPrivateFile(src, path.join(targetDir, f));
      }
    }
    if (accessToken) email = await lookupEmail(accessToken);
    if (email) {
      writePrivateFile(path.join(targetDir, "google_accounts.json"), JSON.stringify({ active: email, old: [] }, null, 2));
      writePrivateFile(path.join(targetDir, "state.json"), JSON.stringify({ active: email }, null, 2));
    }
  } finally {
    for (const [bak, src] of moved) {
      try {
        fs.renameSync(bak, src);
      } catch (err) {
        log(`[WARNING] Could not restore ${src}: ${err.message}`);
      }
    }
  }

  const account = getProfileAccountEmail(name);
  const ok = Boolean(account && account !== "Not Logged In" && account !== "N/A");
  if (ok) {
    log(`\n[OK] Profile '${name}' login completed (OS: ${getOsType()})! Active Account: ${account}\n`);
  } else {
    log(`\n[WARNING] Profile '${name}' does not appear to be logged in. Run the command again if needed.\n`);
  }
  return { ok, email: ok ? account : null, targetDir };
}

/** Deletes a profile directory. Returns false when there was nothing to delete. */
export function removeProfileDir(name) {
  assertSafeProfileName(name);
  if (!name) throw new Error("Please specify a profile name");
  const dir = path.join(profilesDir(), name);
  if (!fs.existsSync(dir)) return false;
  fs.rmSync(dir, { recursive: true, force: true });
  return true;
}

function profileAuthDir(profile) {
  if (!profile) return path.join(os.homedir(), ".gemini");
  const primary = path.join(profilesDir(), profile);
  if (fs.existsSync(primary)) return primary;
  const alt = path.join(getCanonicalAntigravityDir(), profile);
  return fs.existsSync(alt) ? alt : primary;
}

/**
 * One doctor line for a profile's stored token: whether Google still accepts the access token,
 * or whether a refresh token is there to get a new one. lookup(accessToken) -> { status, email, reason }.
 */
export async function checkProfileToken(profile, lookup = lookupUserInfo) {
  const name = profile || "default";
  const dir = profileAuthDir(profile);
  const oauthFile = path.join(dir, "oauth_creds.json");
  if (!fs.existsSync(oauthFile)) return { level: "error", line: `❌ Profile '${name}': oauth_creds.json missing at ${dir}` };
  let data;
  try {
    data = JSON.parse(fs.readFileSync(oauthFile, "utf-8"));
  } catch (err) {
    return { level: "error", line: `❌ Profile '${name}': token check error: ${err.message}` };
  }
  const nested = data && typeof data.token === "object" && data.token ? data.token : {};
  const access = data.access_token || nested.access_token || "";
  const refresh = data.refresh_token || nested.refresh_token || "";
  const account = getProfileAccountEmail(profile);
  if (!access && !refresh) return { level: "error", line: `❌ Profile '${name}': tokens are empty in ${oauthFile}` };
  if (!access) {
    return { level: "warn", line: `🟡 Profile '${name}': Refresh Token READY ✅ (an access token is made on the next run) | Account: ${account}` };
  }
  const info = await lookup(access);
  if (info.status === 200) return { level: "ok", line: `✅ Profile '${name}': Token ACTIVE & VALID! Verified Google Account: ${info.email}` };
  if (info.status === 401) {
    return refresh
      ? { level: "warn", line: `🟡 Profile '${name}': Access token expired (normal after 1h) | Refresh Token: READY ✅ | Account: ${account}` }
      : { level: "error", line: `❌ Profile '${name}': Access token expired (401) and refresh_token is missing` };
  }
  if (info.status === 0) return { level: "warn", line: `⚠️  Profile '${name}': UserInfo check error: ${info.reason}` };
  return { level: "warn", line: `⚠️  Profile '${name}': Google OAuth API returned HTTP ${info.status}: ${info.reason || ""}`.trimEnd() };
}

/** `profile doctor`: outbound IP, proxy, stale agy cache files and every profile's token. */
export async function runDoctor({ log = (line) => console.log(line), lookup = lookupUserInfo } = {}) {
  log("\n🔍 Antigravity Bridge Diagnostic Doctor 🩺\n" + "=".repeat(60));
  try {
    const res = await fetch("https://ifconfig.me/ip", { headers: { "User-Agent": "curl/7.88.1" }, signal: AbortSignal.timeout(5000) });
    log(`🌐 Direct Outbound IP: ${(await res.text()).trim()}`);
  } catch (err) {
    log(`🌐 Direct Outbound IP: Error (${err.message})`);
  }
  const proxy = await detectLocalProxy(true);
  log(`🛡️  Active Proxy Setting: ${proxy || "None (Direct connection)"}`);

  const geminiDir = path.join(os.homedir(), ".gemini");
  const cleaned = [];
  for (const f of ["default-cli-project.json", "default_project_id.txt", "jetski_state.pbtxt", "update.lock", "knowledge.lock"]) {
    const fp = path.join(geminiDir, f);
    try {
      if (fs.existsSync(fp)) {
        fs.rmSync(fp, { force: true });
        cleaned.push(f);
      }
    } catch {
      // ignore
    }
  }
  if (cleaned.length) log(`🧹 Cleaned stale project cache files: ${cleaned.join(", ")}`);

  const profiles = getAvailableProfiles();
  log(`\n📋 Inspecting ${profiles.length} profile token(s) with Google's OAuth UserInfo API:`);
  let problems = 0;
  for (const p of profiles) {
    const r = await checkProfileToken(p, lookup);
    if (r.level === "error") problems++;
    log(`  ${r.line}`);
  }
  log("=".repeat(60) + "\n");
  return problems;
}

function assertRemote(remote) {
  if (!REMOTE_RE.test(remote || "")) throw new Error(`Invalid remote ${JSON.stringify(remote)}: expected [user@]host`);
}

function waitExit(child) {
  return new Promise((resolve) => {
    child.on("error", () => resolve(127));
    child.on("close", (code) => resolve(code ?? 1));
  });
}

/**
 * Copies every profile's auth files (oauth_creds.json, google_accounts.json, state.json) to
 * `remote` over ssh as a tar stream. Returns the exit status.
 */
export async function copyAllProfilesToRemote(remote, { log = (line) => console.log(line) } = {}) {
  assertRemote(remote);
  const base = profilesDir();
  const files = [];
  for (const p of getAvailableProfiles()) {
    if (!p || !isSafeProfileName(p)) continue;
    for (const f of GEMINI_AUTH_FILES) {
      if (fs.existsSync(path.join(base, p, f))) files.push(`${p}/${f}`);
    }
  }
  if (files.length === 0) {
    log("[ERROR] No profile auth files found to copy.");
    return 1;
  }
  log(`[INFO] Copying the auth files of ${new Set(files.map((f) => f.split("/")[0])).size} profile(s) to ${remote}...`);
  const tar = spawn("tar", ["-czf", "-", "-C", base, ...files], { stdio: ["ignore", "pipe", "inherit"] });
  const ssh = spawn(
    "ssh",
    [remote, "mkdir -p ~/.config/antigravity/profiles && tar -xzf - -C ~/.config/antigravity/profiles"],
    { stdio: ["pipe", "inherit", "inherit"] }
  );
  tar.stdout.pipe(ssh.stdin);
  const [tarCode, sshCode] = await Promise.all([waitExit(tar), waitExit(ssh)]);
  const code = tarCode || sshCode;
  if (code === 0) log(`[OK] All profiles copied to ${remote}.`);
  else log(`[ERROR] Copy failed (tar exit ${tarCode}, ssh exit ${sshCode}).`);
  return code;
}

/** Copies one profile directory to `remote` with scp. Returns the exit status. */
export async function copyProfileToRemote(name, remote, { log = (line) => console.log(line) } = {}) {
  assertSafeProfileName(name);
  if (!name) throw new Error("Please specify a profile name");
  assertRemote(remote);
  const source = path.join(profilesDir(), name);
  if (!fs.existsSync(source)) {
    log(`[ERROR] Local profile '${name}' not found at ${source}`);
    return 1;
  }
  const mk = await waitExit(spawn("ssh", [remote, `mkdir -p ~/.config/antigravity/profiles/${name}`], { stdio: "ignore" }));
  if (mk !== 0) {
    log(`[ERROR] Could not create the profile directory on ${remote} (ssh exit ${mk}).`);
    return mk;
  }
  const dest = `${remote}:~/.config/antigravity/profiles/${name}`;
  log(`[INFO] Copying profile '${name}' to ${dest}...`);
  const code = await waitExit(spawn("scp", ["-r", `${source}/.`, dest], { stdio: "inherit" }));
  if (code === 0) log(`[OK] Profile '${name}' copied to ${remote}.`);
  else log(`[ERROR] scp failed with exit code ${code}`);
  return code;
}
