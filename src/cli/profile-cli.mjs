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
import { detectCliCommand, getBridgeConfigPath, getCanonicalAntigravityDir, DEFAULT_PORT } from "../config.mjs";
import { isSafeProfileName } from "../core/security.mjs";
import { getProfileSandboxBasePath } from "../core/sandbox.mjs";
import { getConfiguredApiKeys } from "../auth.mjs";

async function makeAuthedRequest(endpoint, method = "GET", bodyData = null) {
  const port = parseInt(process.env.ANTIGRAVITY_PORT || String(DEFAULT_PORT), 10);
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
          modeDisplay = "🟣 Sonnet 4.6 (Fallback)";
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
      console.error("[Error] Please specify profiles: antigravity-bridge profile order profile_1,profile_2,profile_3");
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

  if (subcmd === "disable" || subcmd === "block" || subcmd === "off") {
    const target = argv[1];
    if (!target) {
      console.error("Usage: antigravity-bridge profile disable <profile_name>");
      return 1;
    }
    await makeAuthedRequest("/v1/profiles/disable", "POST", { profile: target });
    GLOBAL_PROFILE_MANAGER.mark_disabled(target);
    console.log(`[OK] Profile '${target}' has been DISABLED`);
    return 0;
  }

  if (subcmd === "enable" || subcmd === "unblock" || subcmd === "on") {
    const target = argv[1];
    if (!target) {
      console.error("Usage: antigravity-bridge profile enable <profile_name>");
      return 1;
    }
    await makeAuthedRequest("/v1/profiles/enable", "POST", { profile: target });
    GLOBAL_PROFILE_MANAGER.enable(target);
    console.log(`[OK] Profile '${target}' has been ENABLED`);
    return 0;
  }

  if (subcmd === "reset" || subcmd === "clear") {
    const target = argv[1] || null;
    await makeAuthedRequest("/v1/profiles/reset", "POST", { profile: target });
    GLOBAL_PROFILE_MANAGER.reset_all(target);
    console.log(`[OK] Reset quota cooldowns for profile(s): ${target || "all"}`);
    return 0;
  }

  if (subcmd === "sync") {
    const target = argv[1];
    if (!target) {
      console.error("Usage: antigravity-bridge profile sync <profile_name>");
      return 1;
    }
    const [email, token] = syncProfileToSystem(target);
    console.log(`[OK] Successfully synchronized profile '${target}':`);
    console.log(`     Account: ${email}`);
    console.log(`     Token:   ${token}`);
    return 0;
  }

  if (subcmd === "probe") {
    const target = argv[1] || null;
    const { template } = detectCliCommand();
    console.log(`[INFO] Probing profile '${target || "default"}' via agy CLI...`);
    try {
      const output = await executeCliCommand(template, "Hello! Reply with 1 word: OK", {
        timeout: 30,
        profile: target,
      });
      console.log(`[OK] Probe succeeded! Output: ${output.slice(0, 100)}`);
      return 0;
    } catch (err) {
      console.error(`[ERROR] Probe failed: ${err.message}`);
      return 1;
    }
  }

  if (subcmd === "refresh") {
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

  if (subcmd === "login" || subcmd === "add" || subcmd === "new") {
    const target = argv[1];
    if (!target || !isSafeProfileName(target)) {
      console.error("[Error] Please specify a profile name (A-Z a-z 0-9 . _ -): antigravity-bridge profile login <profile_name>");
      return 1;
    }
    const { prepareLogin, runInteractiveLogin, collectLogin, cleanupLogin } = await import("../core/profile-login.mjs");
    console.log(`\n[INFO] Starting interactive login for profile '${target}'...`);
    let ctx = null;
    try {
      ctx = await prepareLogin(target);
      if (ctx.targetExisted) {
        console.log(`[INFO] Profile '${target}' already exists; it is only replaced once the new login succeeds.`);
      }
      console.log("=".repeat(80));
      if (ctx.mode === "file") {
        // SSH/file mode: agy prints a sign-in URL and waits for a code instead of opening a browser.
        console.log("Login steps (agy runs in SSH mode here, so it does not open the browser by itself):");
        console.log("   1. Choose '1. Google OAuth' and press Enter.");
        console.log(`   2. Open the URL agy prints and sign in with the Google account for '${target}'.`);
        console.log("   3. Copy the code Google shows after sign-in, paste it into this terminal, press Enter.");
        console.log("   4. At the agy prompt type 'hi' + Enter once, then '/exit' (or Ctrl+D) to save the profile.");
      } else {
        console.log("Login steps (keyring mode):");
        console.log(`   1. Sign in in the browser window agy opens, with the Google account for '${target}'.`);
        console.log("   2. Back in this terminal type 'hi' + Enter once, then '/exit' (or Ctrl+D) to save the profile.");
      }
      console.log("=".repeat(80) + "\n");

      await runInteractiveLogin(target, { prepareCtx: ctx });
      const result = await collectLogin(target, { prepareCtx: ctx });
      const note = result.verified ? "" : " (not confirmed with Google: userinfo was unreachable)";
      console.log(`\n[SUCCESS] Profile '${target}' login completed. Account: ${result.email}${note}\n`);
      return 0;
    } catch (err) {
      if (ctx) await cleanupLogin(ctx, { keepTarget: false });
      console.error(`\n[ERROR] Login failed for profile '${target}': ${err.message}\n`);
      return 1;
    }
  }

  if (subcmd === "remove" || subcmd === "delete" || subcmd === "rm") {
    const target = argv[1];
    // The name becomes a path under profiles/: never accept separators or dot segments.
    if (!target || !isSafeProfileName(target)) {
      console.error("[Error] Please specify a profile name (A-Z a-z 0-9 . _ -): antigravity-bridge profile remove <profile_name>");
      return 1;
    }
    const targetDir = path.join(getCanonicalAntigravityDir(), "profiles", target);
    if (fs.existsSync(targetDir)) {
      try {
        fs.rmSync(targetDir, { recursive: true, force: true });
        console.log(`[OK] Profile '${target}' removed (${targetDir})`);
      } catch (err) {
        console.error(`[ERROR] Failed to remove '${target}': ${err.message}`);
        return 1;
      }
    } else {
      console.log(`[Warning] Profile '${target}' directory not found (${targetDir})`);
    }
    // The sandboxes hold copies of the profile's tokens and its agy history.
    const sandbox = getProfileSandboxBasePath(target);
    fs.rmSync(sandbox, { recursive: true, force: true });
    fs.rmSync(path.join(path.dirname(sandbox), ".token-refresh", target), { recursive: true, force: true });

    // Also drop it from bridge_config.json, and from a running bridge's rotation.
    const cfgFile = getBridgeConfigPath();
    if (fs.existsSync(cfgFile)) {
      try {
        const cfg = JSON.parse(fs.readFileSync(cfgFile, "utf-8"));
        if (Array.isArray(cfg.profiles)) {
          cfg.profiles = cfg.profiles.filter((p) => p !== target);
          fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2), "utf-8");
          await makeAuthedRequest("/v1/profiles/config", "POST", { profiles: cfg.profiles });
        }
      } catch (err) {
        console.warn(`[Warning] Could not update ${cfgFile}: ${err.message}`);
      }
    }
    return 0;
  }

  console.log("Usage: antigravity-bridge profile [list | login <name> | remove <name> | order <p1,p2> | sync <name> | probe [name] | refresh [name] | reset [name] | disable <name> | enable <name>]");
  return 0;
}
