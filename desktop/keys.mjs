/**
 * The bridge's API keys as the desktop app sees them. The bridge takes its keys from its environment,
 * filled at start-up from the first of these files that defines them (loadDotenv(): an existing variable
 * is never overridden): <bridge cwd>/.env, ~/.config/antigravity/bridge.env, ~/.config/antigravity/.env,
 * ~/.env. The main process reads the same files on every call instead of trusting its own process.env,
 * which was filled once when the bridge modules were first imported.
 */
import fs from "node:fs";
import path from "node:path";

const KEY_LIST_VARS = ["ANTIGRAVITY_API_KEYS", "BRIDGE_API_KEYS", "API_KEYS"];
const KEY_SINGLE_VARS = ["ANTIGRAVITY_API_KEY", "BRIDGE_API_KEY", "API_KEY"];
export const KEY_VARS = [...KEY_LIST_VARS, ...KEY_SINGLE_VARS];

export function bridgeEnvFile(homedir) {
  return path.join(homedir, ".config", "antigravity", "bridge.env");
}

export function envFiles({ homedir, bridgeCwd }) {
  return [
    bridgeCwd ? path.join(bridgeCwd, ".env") : null,
    bridgeEnvFile(homedir),
    path.join(homedir, ".config", "antigravity", ".env"),
    path.join(homedir, ".env"),
  ].filter(Boolean);
}

/** Same rules as loadDotenv(): KEY=value lines, optional matching quotes, first definition wins. */
export function parseDotenv(text) {
  const out = {};
  for (const line of String(text).split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const eq = trimmed.indexOf("=");
    const k = trimmed.slice(0, eq).trim();
    let v = trimmed.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!(k in out)) out[k] = v;
  }
  return out;
}

/** {key: label} exactly as the bridge would load it (getConfiguredApiKeys over the merged environment). */
export function readApiKeys({ homedir, bridgeCwd, launchEnv = {}, parseApiKeys }) {
  const env = {};
  for (const k of KEY_VARS) if (launchEnv[k] !== undefined) env[k] = launchEnv[k];
  for (const file of envFiles({ homedir, bridgeCwd })) {
    let parsed;
    try {
      parsed = parseDotenv(fs.readFileSync(file, "utf-8"));
    } catch {
      continue;
    }
    for (const k of KEY_VARS) if (!(k in env) && k in parsed) env[k] = parsed[k];
  }
  const keys = {};
  const list = KEY_LIST_VARS.map((k) => env[k]).find(Boolean);
  if (list) Object.assign(keys, parseApiKeys(list));
  const single = KEY_SINGLE_VARS.map((k) => env[k]).find(Boolean);
  if (single && !keys[single.trim()]) keys[single.trim()] = "default";
  return keys;
}
