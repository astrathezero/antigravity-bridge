import {
  generateApiKey,
  maskApiKey,
  getConfiguredApiKeys,
  saveApiKeyToEnv,
  revokeApiKeyFromEnv,
} from "../auth.mjs";

export function handleKeyCli(argv) {
  const subcmd = (argv[0] || "list").toLowerCase();

  if (subcmd === "generate" || subcmd === "create" || subcmd === "add") {
    let label = "agent-custom";
    let customKey = "";
    for (let i = 1; i < argv.length; i++) {
      if (argv[i] === "--label" && argv[i + 1]) {
        label = argv[i + 1].trim();
        i++;
      } else if (argv[i] === "--key" && argv[i + 1]) {
        customKey = argv[i + 1].trim();
        i++;
      } else if (!argv[i].startsWith("-")) {
        label = argv[i].trim();
      }
    }

    const key = customKey || generateApiKey();
    const [ok, pathOrErr] = saveApiKeyToEnv(label, key);
    if (ok) {
      console.log(`[OK] Generated & Saved API Key for '${label}':`);
      console.log(`     Key:   ${key}`);
      console.log(`     File:  ${pathOrErr}`);
      return 0;
    } else {
      console.error(`[ERROR] Failed to save key: ${pathOrErr}`);
      return 1;
    }
  }

  if (subcmd === "revoke" || subcmd === "remove" || subcmd === "delete") {
    const target = argv[1];
    if (!target) {
      console.error("Usage: antigravity-bridge key revoke <label|key>");
      return 1;
    }

    const [ok, pathOrErr, removed] = revokeApiKeyFromEnv(target);
    if (ok) {
      console.log(`[OK] Successfully revoked ${removed.length} key(s) matching '${target}':`);
      for (const [lbl, k] of removed) {
        console.log(`     - Label: ${lbl} (${maskApiKey(k)})`);
      }
      return 0;
    } else {
      console.error(`[ERROR] ${pathOrErr}`);
      return 1;
    }
  }

  if (subcmd === "list" || subcmd === "ls") {
    const keys = getConfiguredApiKeys();
    const entries = Object.entries(keys);
    console.log(`\n🔑 Configured API Keys (${entries.length}):`);
    console.log("--------------------------------------------------");
    if (entries.length === 0) {
      console.log("  (No API keys configured. Server runs in open dev mode)");
    } else {
      for (const [k, lbl] of entries) {
        console.log(`  - Label: ${lbl.padEnd(20)} Key: ${maskApiKey(k)}`);
      }
    }
    console.log("--------------------------------------------------\n");
    return 0;
  }

  console.log("Usage: antigravity-bridge key [list | generate <label> | revoke <label>]");
  return 0;
}
