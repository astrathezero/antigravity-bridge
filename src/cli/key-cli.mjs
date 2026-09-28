import {
  generateApiKey,
  maskApiKey,
  getConfiguredApiKeys,
  saveApiKeyToEnv,
  revokeApiKeyFromEnv,
  findPrimaryEnvFile,
} from "../auth.mjs";
import { DEFAULT_PORT } from "../config.mjs";
import { API_KEY_LABEL_RE, API_KEY_VALUE_RE } from "../core/security.mjs";

export const KEY_HELP = `
Antigravity Bridge - API Key Manager CLI 🔑

Usage:
  node src/index.mjs key list                      List configured keys (masked) and where they come from
  node src/index.mjs key create [label]            Generate a new key and save it to .env (alias: generate)
  node src/index.mjs key add <label> <key>         Save an existing key under a label
  node src/index.mjs key revoke <label|key>        Remove a key from .env (alias: remove)
  node src/index.mjs key test <key> [--host H] [--port P]
                                                   Check a key against the running bridge

Keys are stored in .env as ANTIGRAVITY_API_KEYS="label:key,...". Shortcut: node src/index.mjs keys
`;

function defaultLabel() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `agent-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}`;
}

/** Positional arguments plus --label / --key options (kept from the original `key generate`). */
function parseKeyArgs(args) {
  const positional = [];
  const opts = {};
  for (let i = 0; i < args.length; i++) {
    if ((args[i] === "--label" || args[i] === "--key" || args[i] === "--host" || args[i] === "--port") && args[i + 1] !== undefined) {
      opts[args[i].slice(2)] = args[++i].trim();
    } else if (!args[i].startsWith("-")) {
      positional.push(args[i].trim());
    }
  }
  return { positional, opts };
}

function saveKey(label, key, generated) {
  // A comma, colon, quote or newline would corrupt the ANTIGRAVITY_API_KEYS line in .env.
  if (!API_KEY_LABEL_RE.test(label)) {
    console.error(`[ERROR] Invalid label '${label}': use letters, digits, '.', '_' or '-' (max 64).`);
    return 1;
  }
  if (!API_KEY_VALUE_RE.test(key)) {
    console.error("[ERROR] Invalid key: 8-256 characters of letters, digits, '.', '_' or '-'.");
    return 1;
  }
  const existing = getConfiguredApiKeys();
  if (Object.prototype.hasOwnProperty.call(existing, key)) {
    console.error(`[ERROR] That key is already configured (label '${existing[key]}').`);
    return 1;
  }
  const [ok, pathOrErr] = saveApiKeyToEnv(label, key);
  if (!ok) {
    console.error(`[ERROR] Failed to save key: ${pathOrErr}`);
    return 1;
  }
  if (generated) {
    console.log(`[OK] Generated & Saved API Key for '${label}':`);
    console.log(`     Key:   ${key}`);
    console.log("     Copy it now and send it as 'Authorization: Bearer <key>' or 'x-api-key'.");
  } else {
    console.log(`[OK] Saved API Key for '${label}' (${maskApiKey(key)})`);
  }
  console.log(`     File:  ${pathOrErr}`);
  console.log("     Restart the bridge to load it.");
  return 0;
}

async function testKey(key, host, port) {
  const url = `http://${host}:${port}/v1/models`;
  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(3000) });
    if (res.status === 200) {
      const data = await res.json().catch(() => ({}));
      console.log(`[OK] API key ${maskApiKey(key)} is accepted by ${url} (${(data.data || []).length} models).`);
      return 0;
    }
    if (res.status === 401) {
      console.error(`[FAILED] Unauthorized (401): ${url} rejected ${maskApiKey(key)}.`);
    } else {
      console.error(`[FAILED] ${url} answered HTTP ${res.status}.`);
    }
    return 1;
  } catch (err) {
    console.warn(`[WARNING] Could not reach the bridge at http://${host}:${port} (${err.cause?.code || err.message}).`);
    const keys = getConfiguredApiKeys();
    if (Object.prototype.hasOwnProperty.call(keys, key)) {
      console.log(`[LOCAL CHECK] ${maskApiKey(key)} matches the local key labelled '${keys[key]}'.`);
      return 0;
    }
    console.error(`[LOCAL CHECK] ${maskApiKey(key)} does not match any key in .env or the environment.`);
    return 1;
  }
}

export async function handleKeyCli(argv) {
  const subcmd = (argv[0] || "list").toLowerCase();
  const { positional, opts } = parseKeyArgs(argv.slice(1));

  if (subcmd === "help" || subcmd === "-h" || subcmd === "--help") {
    console.log(KEY_HELP);
    return 0;
  }

  if (subcmd === "generate" || subcmd === "create" || subcmd === "new") {
    return saveKey(opts.label || positional[0] || defaultLabel(), opts.key || generateApiKey(), !opts.key);
  }

  if (subcmd === "add" || subcmd === "set") {
    // `add <label> <key>` saves the given key; `add <label>` keeps its old meaning and generates one.
    const label = opts.label || positional[0];
    const key = opts.key || positional[1];
    if (!label) {
      console.error("Usage: node src/index.mjs key add <label> <key>");
      return 1;
    }
    return saveKey(label, key || generateApiKey(), !key);
  }

  if (subcmd === "revoke" || subcmd === "remove" || subcmd === "delete" || subcmd === "rm") {
    const target = positional[0];
    if (!target) {
      console.error("Usage: node src/index.mjs key revoke <label|key>");
      return 1;
    }

    const [ok, pathOrErr, removed] = revokeApiKeyFromEnv(target);
    if (!ok) {
      console.error(`[ERROR] ${pathOrErr}`);
      return 1;
    }
    if (removed.length === 0) {
      console.error(`[ERROR] No key labelled or equal to '${target}' in ${pathOrErr}.`);
      return 1;
    }
    console.log(`[OK] Successfully revoked ${removed.length} key(s) matching '${target}':`);
    for (const [lbl, k] of removed) {
      console.log(`     - Label: ${lbl} (${maskApiKey(k)})`);
    }
    console.log(`     File:  ${pathOrErr}`);
    return 0;
  }

  if (subcmd === "test" || subcmd === "check" || subcmd === "verify") {
    const key = positional[0];
    if (!key) {
      console.error("Usage: node src/index.mjs key test <api_key> [--host 127.0.0.1] [--port 8008]");
      return 1;
    }
    const port = parseInt(opts.port || process.env.ANTIGRAVITY_PORT || String(DEFAULT_PORT), 10);
    return testKey(key, opts.host || "127.0.0.1", port);
  }

  if (subcmd === "list" || subcmd === "ls" || subcmd === "status" || subcmd === "all") {
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
    console.log("--------------------------------------------------");
    console.log(`  Config file: ${findPrimaryEnvFile(false)}\n`);
    return 0;
  }

  console.error(`[ERROR] Unknown key command '${subcmd}'.`);
  console.log(KEY_HELP);
  return 1;
}
