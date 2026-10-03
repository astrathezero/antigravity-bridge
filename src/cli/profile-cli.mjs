import fs from "node:fs";
import path from "node:path";
import {
  GLOBAL_PROFILE_MANAGER,
  getAvailableProfiles,
  getProfileAccountEmail,
  formatCooldownDuration,
} from "../core/profile-manager.mjs";
import { syncProfileToSystem } from "../core/keyring-sync.mjs";
import { executeCliCommand } from "../core/executor.mjs";
import { detectCliCommand, getBridgeConfigPath, DEFAULT_PORT } from "../config.mjs";
import { getConfiguredApiKeys } from "../auth.mjs";
import { isSafeProfileName } from "../core/security.mjs";
import {
  loginProfile,
  removeProfileDir,
  runDoctor,
  copyAllProfilesToRemote,
  copyProfileToRemote,
} from "./profile-tools.mjs";

export const PROFILE_HELP = `
Antigravity Bridge - Profile Manager CLI 👤

Usage:
  node src/index.mjs profile list                    List profiles, logged-in emails, cooldowns and quota
  node src/index.mjs profile login <name>            Log in or add a profile interactively with agy
  node src/index.mjs profile remove <name>           Delete a profile directory
  node src/index.mjs profile test [name] [--model M] [--prompt P]
                                                     Run a prompt on one profile (or every profile)
  node src/index.mjs profile disable <name>          Stop sending requests to a profile
  node src/index.mjs profile enable <name>           Re-enable a disabled profile
  node src/index.mjs profile order <p1,p2,...>       Set the rotation pool and order (alias: set)
  node src/index.mjs profile reset [name]            Clear cooldowns for one profile or all of them
  node src/index.mjs profile refresh [name]          Refresh OAuth tokens now
  node src/index.mjs profile doctor                  Check outbound IP, proxy and every profile's token
  node src/index.mjs profile sync <name>             Install a profile's token as this machine's agy login
  node src/index.mjs profile copy <user@host>        Copy every profile's auth files to another host over ssh
  node src/index.mjs profile copy <name> <user@host> Copy one profile directory to another host with scp

Shortcuts (no "profile" needed):
  node src/index.mjs profiles | login <name> | doctor | reset [name] | refresh [name] | test [name]

Commands that change cooldowns reach the running bridge on 127.0.0.1:$ANTIGRAVITY_PORT (default 8008).
`;

export function bridgePort() {
  return parseInt(process.env.ANTIGRAVITY_PORT || String(DEFAULT_PORT), 10);
}

// A command that changes profile state only reaches the running bridge through its HTTP API; the
// local cache write alone is overwritten by the server's own state. Say so instead of a bare [OK]
// (seen on n8n.mrserm.com: a leftover ANTIGRAVITY_PORT=8000 in .env sent `profile reset` to the
// dead Python port while the Node bridge on 8008 kept its 1-day cooldowns).
function warnIfServerMissed(res) {
  if (res) return;
  console.warn(
    `[Warning] The running bridge did not answer on 127.0.0.1:${bridgePort()}, so only the local cache changed.\n` +
      "          If the bridge runs on another port (check ANTIGRAVITY_PORT in .env and in the systemd unit),\n" +
      "          rerun with ANTIGRAVITY_PORT=<port> in front of this command."
  );
}

async function makeAuthedRequest(endpoint, method = "GET", bodyData = null) {
  const port = bridgePort();
  const activeKeys = getConfiguredApiKeys();
  const headers = {};
  const keyList = Object.keys(activeKeys);
  if (keyList.length > 0) {
    headers["Authorization"] = `Bearer ${keyList[0]}`;
  }
  if (bodyData) {
    headers["Content-Type"] = "application/json";
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 2000);
  try {
    const res = await fetch(`http://127.0.0.1:${port}${endpoint}`, {
      method,
      headers,
      body: bodyData ? JSON.stringify(bodyData) : undefined,
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    if (res.ok) {
      return await res.json();
    }
  } catch {
    clearTimeout(timeoutId);
  }
  return null;
}

export async function handleProfileCli(argv) {
  const subcmd = (argv[0] || "list").toLowerCase();

  if (subcmd === "help" || subcmd === "-h" || subcmd === "--help") {
    console.log(PROFILE_HELP);
    return 0;
  }

  if (subcmd === "list" || subcmd === "ls" || subcmd === "status") {
    let summary = null;
    let allProfiles = null;

    const liveData = await makeAuthedRequest("/v1/profiles");
    if (liveData && typeof liveData.profiles === "object") {
      summary = liveData.profiles;
      allProfiles = Object.keys(summary);
    } else {
      allProfiles = getAvailableProfiles();
      summary = GLOBAL_PROFILE_MANAGER.get_status_summary();
    }

    console.log("\n" + "=".repeat(135));
    console.log(
      `${"Profile Name".padEnd(18)} ${"Google Account Email".padEnd(30)} ${"Status".padEnd(10)} ${"Concurrency".padEnd(14)} ${"Gemini Quota".padEnd(20)} ${"Model Mode".padEnd(24)} Success`
    );
    console.log("=".repeat(135));

    let geminiReadyCt = 0;
    let sonnetFallbackCt = 0;
    let disabledCt = 0;

    for (const p of allProfiles) {
      const name = p || "default";
      const email = getProfileAccountEmail(p);
      const info = summary[name] || {};
      const status = info.status || "OK";
      const inFl = info.in_flight || 0;
      const maxC = info.max_concurrency || 1;
      const cStatus = info.concurrency_status || "IDLE";
      const concurrencyDisplay = `${inFl}/${maxC} (${cStatus})`;
      const gemRem = info.gemini_cooldown_seconds_remaining ?? info.cooldown_seconds_remaining ?? 0;
      const isFallback = Boolean(info.sonnet_fallback_candidate);
      const succ = info.success_count || 0;
      const qPct = `${info.estimated_quota_percent ?? 100}%`;

      let gemDisplay;
      let modeDisplay;
      if (status === "DISABLED") {
        disabledCt++;
        gemDisplay = "DISABLED";
        modeDisplay = "⚪ Disabled";
      } else if (gemRem > 0) {
        gemDisplay = `Resets in ${formatCooldownDuration(gemRem)}`;
        if (isFallback) {
          sonnetFallbackCt++;
          modeDisplay = "🟣 Model Fallback";
        } else {
          modeDisplay = "🔴 Exhausted";
        }
      } else {
        geminiReadyCt++;
        gemDisplay = `🟢 Ready (${qPct})`;
        modeDisplay = "🟢 Gemini 3.8";
      }

      console.log(
        `${name.padEnd(18)} ${email.padEnd(30)} ${status.padEnd(10)} ${concurrencyDisplay.padEnd(14)} ${gemDisplay.padEnd(20)} ${modeDisplay.padEnd(24)} ${succ}`
      );
    }
    console.log("=".repeat(135));
    console.log(
      `📊 Pool Status: 🟢 ${geminiReadyCt} Gemini Ready • 🟣 ${sonnetFallbackCt} Sonnet Fallback Active • ⚪ ${disabledCt} Disabled (Total: ${allProfiles.length} Profiles)\n`
    );
    return 0;
  }

  if (subcmd === "set" || subcmd === "use" || subcmd === "config" || subcmd === "order" || subcmd === "rotate") {
    if (argv.length < 2) {
      console.error("[Error] Please specify profiles: node src/index.mjs profile order profile_1,profile_2,profile_3");
      return 1;
    }
    const raw = argv[1].trim();
    const newProfiles = raw.split(",").map((p) => p.trim()).filter(Boolean);

    let serverUpdated = false;
    const res = await makeAuthedRequest("/v1/profiles/config", "POST", { profiles: newProfiles });
    if (res && res.status === "ok") {
      serverUpdated = true;
    }

    GLOBAL_PROFILE_MANAGER.set_profiles(newProfiles);
    const cfgFile = getBridgeConfigPath();
    try {
      let cfgData = {};
      if (fs.existsSync(cfgFile)) {
        try {
          cfgData = JSON.parse(fs.readFileSync(cfgFile, "utf-8"));
        } catch {
          cfgData = {};
        }
      }
      if (!cfgData || typeof cfgData !== "object") cfgData = {};
      cfgData.profiles = newProfiles;
      fs.mkdirSync(path.dirname(cfgFile), { recursive: true });
      fs.writeFileSync(cfgFile, JSON.stringify(cfgData, null, 2), "utf-8");
    } catch (err) {
      console.warn("[Warning] Failed to save bridge_config.json:", err.message);
    }

    if (serverUpdated) {
      console.log(`[OK] Profiles rotation updated live on running bridge server: ${newProfiles.join(", ")}`);
    } else {
      console.log(`[OK] Profiles rotation order saved locally to ${cfgFile}: ${newProfiles.join(", ")}`);
      console.log("     (Note: Bridge server not running or unreachable on default port; changes will take effect on next start)");
    }
    return 0;
  }

  if (subcmd === "disable" || subcmd === "block" || subcmd === "off" || subcmd === "pause") {
    const target = argv[1];
    if (!target) {
      console.error("Usage: node src/index.mjs profile disable <profile_name>");
      return 1;
    }
    warnIfServerMissed(await makeAuthedRequest("/v1/profiles/disable", "POST", { profile: target }));
    GLOBAL_PROFILE_MANAGER.mark_disabled(target);
    console.log(`[OK] Profile '${target}' has been DISABLED`);
    return 0;
  }

  if (subcmd === "enable" || (subcmd === "unblock" && argv[1]) || subcmd === "on" || subcmd === "unpause" || subcmd === "resume") {
    const target = argv[1];
    if (!target) {
      console.error("Usage: node src/index.mjs profile enable <profile_name>");
      return 1;
    }
    warnIfServerMissed(await makeAuthedRequest("/v1/profiles/enable", "POST", { profile: target }));
    GLOBAL_PROFILE_MANAGER.enable(target);
    console.log(`[OK] Profile '${target}' has been ENABLED`);
    return 0;
  }

  if (subcmd === "reset" || subcmd === "clear" || subcmd === "unblock") {
    const target = argv[1] || null;
    warnIfServerMissed(await makeAuthedRequest("/v1/profiles/reset", "POST", { profile: target }));
    GLOBAL_PROFILE_MANAGER.reset_all(target);
    console.log(`[OK] Reset quota cooldowns for profile(s): ${target || "all"}`);
    return 0;
  }

  if (subcmd === "copy" || subcmd === "scp" || (subcmd === "sync" && (argv.length > 2 || /@/.test(argv[1] || "")))) {
    // `sync user@host` / `sync <name> <host>` is the Python CLI's remote copy; `sync <name>` below is local.
    try {
      if (argv.length === 2) return await copyAllProfilesToRemote(argv[1].trim());
      if (argv.length === 3) return await copyProfileToRemote(argv[1].trim(), argv[2].trim());
    } catch (err) {
      console.error(`[ERROR] ${err.message}`);
      return 1;
    }
    console.error("Usage: node src/index.mjs profile copy <user@host> | profile copy <name> <user@host>");
    return 1;
  }

  if (subcmd === "sync") {
    const target = argv[1];
    if (!target) {
      console.error("Usage: node src/index.mjs profile sync <profile_name>");
      return 1;
    }
    const [email, token] = syncProfileToSystem(target);
    console.log(`[OK] Successfully synchronized profile '${target}':`);
    console.log(`     Account: ${email}`);
    console.log(`     Token:   ${token}`);
    return 0;
  }

  if (subcmd === "probe" || subcmd === "test" || subcmd === "check") {
    const rest = argv.slice(1);
    const option = (flag) => {
      const i = rest.indexOf(flag);
      if (i < 0 || i + 1 >= rest.length) return null;
      return rest.splice(i, 2)[1];
    };
    const model = option("--model");
    const prompt = option("--prompt") || "Hello! Reply with 1 word: OK";
    const targets = rest[0] ? [rest[0].trim()] : getAvailableProfiles();
    const { template } = detectCliCommand();
    let failed = 0;
    console.log(`[INFO] Probing ${targets.length} profile(s)${model ? ` with ${model}` : ""} via agy CLI...`);
    for (const target of targets) {
      const name = target || "default";
      const t0 = Date.now();
      try {
        const output = await executeCliCommand(template, prompt, { timeout: 60, profile: target, modelName: model });
        const preview = output.trim().replace(/\s+/g, " ").slice(0, 180);
        console.log(`[OK] '${name}' (${getProfileAccountEmail(target)}) answered in ${((Date.now() - t0) / 1000).toFixed(1)}s: ${preview}`);
      } catch (err) {
        failed++;
        console.error(`[ERROR] '${name}' (${getProfileAccountEmail(target)}) failed: ${err.message}`);
      }
    }
    return failed ? 1 : 0;
  }

  if (subcmd === "login" || subcmd === "add" || subcmd === "new" || subcmd === "auth") {
    const name = (argv[1] || "").trim();
    if (!name || !isSafeProfileName(name)) {
      console.error("Usage: node src/index.mjs profile login <profile_name>  (letters, digits, '.', '_' or '-')");
      return 1;
    }
    try {
      const { ok } = await loginProfile(name);
      if (ok) {
        const pool = getAvailableProfiles();
        if (!pool.includes(name)) {
          console.log(`[NOTE] '${name}' is not in the rotation pool yet: add it with  node src/index.mjs profile order ${[...pool.filter(Boolean), name].join(",")}`);
        }
      }
      return ok ? 0 : 1;
    } catch (err) {
      console.error(`[ERROR] ${err.message}`);
      return 1;
    }
  }

  if (subcmd === "remove" || subcmd === "delete" || subcmd === "rm") {
    const name = (argv[1] || "").trim();
    if (!name || !isSafeProfileName(name)) {
      console.error("Usage: node src/index.mjs profile remove <profile_name>");
      return 1;
    }
    if (!removeProfileDir(name)) {
      console.warn(`[Warning] Profile '${name}' has no directory; nothing to delete.`);
      return 0;
    }
    if (GLOBAL_PROFILE_MANAGER.state[name]) {
      delete GLOBAL_PROFILE_MANAGER.state[name];
      GLOBAL_PROFILE_MANAGER.save_cache();
    }
    console.log(`[OK] Profile '${name}' deleted.`);
    if (getAvailableProfiles().includes(name)) {
      console.log(`[NOTE] '${name}' is still listed in the rotation pool; update it with  node src/index.mjs profile order ...`);
    }
    return 0;
  }

  if (subcmd === "doctor" || subcmd === "diag" || subcmd === "debug" || subcmd === "info") {
    const problems = await runDoctor();
    return problems ? 1 : 0;
  }

  if (subcmd === "refresh" || subcmd === "reauth") {
    const target = argv[1] || null;
    const { refreshProfileToken } = await import("../core/token-daemon.mjs");
    if (target) {
      console.log(`[INFO] Refreshing OAuth token for profile '${target}'...`);
      const [ok, msg] = await refreshProfileToken(target);
      if (ok) console.log(`[OK] Profile '${target}': ${msg}`);
      else console.error(`[ERROR] Profile '${target}': ${msg}`);
      return ok ? 0 : 1;
    } else {
      const profiles = getAvailableProfiles();
      console.log(`[INFO] Refreshing OAuth tokens for ${profiles.length} profiles...`);
      let successCount = 0;
      for (const p of profiles) {
        const [ok, msg] = await refreshProfileToken(p);
        if (ok) {
          successCount++;
          console.log(`[OK] Profile '${p || "default"}': ${msg}`);
        } else {
          console.error(`[ERROR] Profile '${p || "default"}': ${msg}`);
        }
      }
      console.log(`[INFO] Completed: ${successCount}/${profiles.length} refreshed.`);
      return 0;
    }
  }

  console.error(`[ERROR] Unknown profile command '${subcmd}'.`);
  console.log(PROFILE_HELP);
  return 1;
}
