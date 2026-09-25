#!/usr/bin/env node
/**
 * Antigravity Bridge Server (Node.js Edition)
 * High-performance, zero-dependency OpenAI & Anthropic compatible REST API Bridge.
 */

import { DEFAULT_PORT, DEFAULT_HOST, detectCliCommand, isBenignSocketError } from "./config.mjs";
import { getConfiguredApiKeys } from "./auth.mjs";
import { GLOBAL_PROFILE_MANAGER, getAvailableProfiles } from "./core/profile-manager.mjs";
import { createBridgeServer } from "./server.mjs";
import { handleProfileCli } from "./cli/profile-cli.mjs";
import { handleKeyCli } from "./cli/key-cli.mjs";
import { startTokenRefreshDaemon } from "./core/token-daemon.mjs";
import { buildAllowedHosts } from "./core/security.mjs";
import { registerServer, beginShutdown } from "./core/host.mjs";

async function main() {
  const argv = process.argv.slice(2);

  // Subcommand dispatch
  if (argv.length > 0) {
    const first = argv[0].toLowerCase();
    if (first === "profile") {
      const code = await handleProfileCli(argv.slice(1));
      process.exit(code);
    } else if (first === "key" || first === "keys") {
      const code = handleKeyCli(argv.slice(1));
      process.exit(code);
    } else if (first === "login") {
      const code = await handleProfileCli(["login", ...argv.slice(1)]);
      process.exit(code);
    }
  }

  // Parse server options
  let port = DEFAULT_PORT;
  let host = DEFAULT_HOST;
  let enableCors = false;
  let allowedHostsArg;
  let customCmd = null;
  let cliKey = null;
  let cliKeys = null;
  let autoRefreshMin = 55.0;
  if (
    ["1", "true", "yes"].includes(
      (process.env.ANTIGRAVITY_NO_AUTO_REFRESH || "").toLowerCase()
    )
  ) {
    autoRefreshMin = 0;
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--port" || arg === "-p") {
      port = parseInt(argv[++i], 10);
    } else if (arg === "--host" || arg === "-h") {
      host = argv[++i];
    } else if (arg === "--api-key") {
      cliKey = argv[++i];
    } else if (arg === "--api-keys") {
      cliKeys = argv[++i];
    } else if (arg === "--enable-cors") {
      enableCors = true;
    } else if (arg === "--no-cors") {
      enableCors = false;
    } else if (arg === "--allowed-hosts") {
      allowedHostsArg = argv[++i];
    } else if (arg === "--cmd") {
      customCmd = argv[++i];
    } else if (arg === "--no-auto-refresh") {
      autoRefreshMin = 0;
    } else if (arg === "--auto-refresh-min" && argv[i + 1]) {
      autoRefreshMin = parseFloat(argv[++i]);
    } else if (arg === "--help" || arg === "-help") {
      console.log(`
Antigravity Bridge Server (Node.js Version) 🌉

Usage:
  node src/index.mjs [--port 8008] [--host 127.0.0.1] [--api-key KEY]

Subcommands:
  node src/index.mjs profile [list | login <name> | remove <name> | sync <name> | probe [name] | reset [name]]
  node src/index.mjs login <name>
  node src/index.mjs key [list | generate <label> | revoke <label>]

Options:
  -p, --port <port>       Port to listen on (Default: 8008)
  -h, --host <host>       Host to bind to (Default: 127.0.0.1)
      --api-key <key>     Configure single client API key
      --api-keys <keys>   Configure multiple API keys (label:key,label2:key2)
      --enable-cors       Enable Cross-Origin Resource Sharing (default: OFF; opens the
                          bridge to any web page you visit - only enable if needed)
      --allowed-hosts     Comma-separated extra Host header values to accept
                          (also ANTIGRAVITY_ALLOWED_HOSTS). Loopback + bind host are
                          always allowed; a 0.0.0.0 bind accepts any Host unless set.
      --cmd <template>    Custom CLI execution command template
      --no-auto-refresh   Disable background OAuth token auto-refresher
      --auto-refresh-min  Auto-refresh interval in minutes (Default: 55)
`);
      process.exit(0);
    }
  }

  const apiKeys = getConfiguredApiKeys(cliKey, cliKeys);
  if (Object.keys(apiKeys).length === 0) {
    console.warn(
      "[WARN] No API key configured: every endpoint is unauthenticated (anonymous mode).\n" +
      "       Anyone who can reach this port can drive the agy agent on this machine.\n" +
      "       Keep the bind on 127.0.0.1 and create a key with: node src/index.mjs key generate my-agent"
    );
  }
  if (enableCors) {
    console.warn("[WARN] CORS enabled with wildcard origin: any web page you open can call this bridge.");
  }
  const profiles = getAvailableProfiles();
  GLOBAL_PROFILE_MANAGER.set_profiles(profiles);

  const { server } = createBridgeServer({
    port,
    host,
    enableCors,
    customCmd,
    apiKeys,
    allowedHosts: buildAllowedHosts(host, allowedHostsArg),
    profileManager: GLOBAL_PROFILE_MANAGER,
  });

  let daemonTimer = null;
  registerServer(server);
  server.listen(port, host, () => {
    const cliInfo = detectCliCommand();
    if (autoRefreshMin > 0) {
      daemonTimer = startTokenRefreshDaemon(GLOBAL_PROFILE_MANAGER, autoRefreshMin * 60);
    }
    console.log(`
================================================================================
🚀 Antigravity Bridge Server (Node.js Version) running on http://${host}:${port}
================================================================================
• Default Port:        ${port} (No collision with Python bridge)
• Endpoints:           /v1/chat/completions (OpenAI), /v1/messages (Anthropic)
• Health Check:        http://${host}:${port}/health
• Active Profiles:     ${profiles.join(", ") || "default"} (${profiles.length} total)
• CLI Binary:          ${cliInfo.binary}
• Background Daemon:   ${autoRefreshMin > 0 ? `OAuth Token Auto-Refresh active (every ${autoRefreshMin}m)` : "DISABLED"}
• Auth Required:       ${Object.keys(apiKeys).length > 0 ? `YES (${Object.keys(apiKeys).length} key(s))` : "NO (anonymous mode - localhost only!)"}
• CORS:                ${enableCors ? "ENABLED (wildcard origin)" : "disabled"}
================================================================================
Press Ctrl+C to stop.
`);
  });

  function shutdown() {
    console.log("\n[INFO] Gracefully shutting down Antigravity Bridge Server...");
    if (daemonTimer) clearInterval(daemonTimer);
    // agy runs detached: end the runs in flight (and refuse fallback attempts) so none outlives the bridge.
    beginShutdown();
    // Drop keep-alive / streaming connections so a restart is not held open by long-lived
    // clients (e.g. Hermes); force-exit if anything is still hanging after 10s.
    try { server.closeIdleConnections?.(); } catch { /* older Node */ }
    const forceTimer = setTimeout(() => {
      console.warn("[WARN] Shutdown timed out with open connections; forcing exit.");
      try { server.closeAllConnections?.(); } catch { /* older Node */ }
      process.exit(0);
    }, 10_000);
    forceTimer.unref();
    server.close(() => {
      console.log("[OK] Server stopped.");
      process.exit(0);
    });
  }

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

// Last-resort process guards. The per-connection socket guard in server.mjs handles the normal
// teardown race, but a stray async EPIPE/ECONNRESET from anywhere else must still never take the
// whole bridge (and every bot on it) down. Benign socket disconnects are swallowed; a genuine bug
// is logged and exits so systemd (Restart=always) restarts on clean code.
process.on("uncaughtException", (err) => {
  if (isBenignSocketError(err)) {
    console.warn(`[SOCKET] swallowed uncaught ${err.code} (client disconnect)`);
    return;
  }
  console.error(`[FATAL] Uncaught exception: ${err && (err.stack || err.message) ? (err.stack || err.message) : err}`);
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  if (isBenignSocketError(reason)) {
    console.warn(`[SOCKET] swallowed unhandled rejection ${reason.code} (client disconnect)`);
    return;
  }
  console.error(`[FATAL] Unhandled rejection: ${reason && (reason.stack || reason.message) ? (reason.stack || reason.message) : reason}`);
  process.exit(1);
});

main().catch((err) => {
  console.error(`[FATAL] Unhandled server exception: ${err.stack || err.message}`);
  process.exit(1);
});
