import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { writePrivateFile, chmodPrivateIfExists } from "./core/security.mjs";

export function generateApiKey(prefix = "sk-agv-") {
  const randHex = crypto.randomBytes(24).toString("hex");
  return `${prefix}${randHex}`;
}

export function maskApiKey(key) {
  if (!key || typeof key !== "string") return "****";
  if (key.length <= 8) return "****";
  return `${key.slice(0, 6)}...${key.slice(-4)}`;
}

export function parseApiKeys(rawVal) {
  const result = {};
  if (!rawVal) return result;

  if (typeof rawVal === "object" && !Array.isArray(rawVal)) {
    for (const [k, v] of Object.entries(rawVal)) {
      result[String(k).trim()] = String(v).trim();
    }
    return result;
  }

  const s = String(rawVal).trim();
  if (!s) return result;

  // Try JSON
  if (s.startsWith("{")) {
    try {
      const parsed = JSON.parse(s);
      if (typeof parsed === "object" && !Array.isArray(parsed)) {
        for (const [k, v] of Object.entries(parsed)) {
          result[String(k).trim()] = String(v).trim();
        }
        return result;
      }
    } catch {
      // Not JSON
    }
  }

  // Comma or newline separated items: key or label:key
  const tokens = s.split(/[\n,]+/);
  for (let token of tokens) {
    token = token.trim();
    if (!token) continue;
    if (token.includes(":")) {
      const [lbl, ...rest] = token.split(":");
      const keyVal = rest.join(":").trim();
      if (keyVal) {
        result[keyVal] = lbl.trim() || "default";
      }
    } else {
      result[token] = "default";
    }
  }

  return result;
}

export function findPrimaryEnvFile(createIfMissing = true) {
  const candidates = [
    path.join(process.cwd(), ".env"),
    path.join(os.homedir(), ".config", "antigravity", "bridge.env"),
    path.join(os.homedir(), ".config", "antigravity", ".env"),
    path.join(os.homedir(), ".env"),
  ];

  for (const c of candidates) {
    if (fs.existsSync(c)) {
      chmodPrivateIfExists(c);
      return c;
    }
  }

  const defaultPath = path.join(process.cwd(), ".env");
  if (createIfMissing) {
    try {
      writePrivateFile(defaultPath, "# Antigravity Bridge Configuration\n");
    } catch {
      // Ignore
    }
  }
  return defaultPath;
}

export function getConfiguredApiKeys(cliKey = null, cliKeys = null) {
  const keys = {};

  if (cliKeys) {
    Object.assign(keys, parseApiKeys(cliKeys));
  }
  if (cliKey) {
    keys[cliKey.trim()] = "cli";
  }

  const envKeys = process.env.ANTIGRAVITY_API_KEYS || process.env.BRIDGE_API_KEYS || process.env.API_KEYS;
  if (envKeys) {
    Object.assign(keys, parseApiKeys(envKeys));
  }

  const envSingle =
    process.env.ANTIGRAVITY_API_KEY ||
    process.env.BRIDGE_API_KEY ||
    process.env.API_KEY;
  if (envSingle && !keys[envSingle.trim()]) {
    keys[envSingle.trim()] = "default";
  }

  return keys;
}

export function saveApiKeyToEnv(label, key, envPath = null) {
  const targetPath = envPath || findPrimaryEnvFile(true);
  try {
    let content = "";
    if (fs.existsSync(targetPath)) {
      content = fs.readFileSync(targetPath, "utf-8");
    }

    const lines = content.split("\n");
    let found = false;
    const newEntry = `${label}:${key}`;

    const newLines = lines.map((line) => {
      const trimmed = line.trim();
      if (trimmed.startsWith("ANTIGRAVITY_API_KEYS=")) {
        found = true;
        let val = trimmed.slice("ANTIGRAVITY_API_KEYS=".length).trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        const updated = val ? `${val},${newEntry}` : newEntry;
        return `ANTIGRAVITY_API_KEYS="${updated}"`;
      }
      return line;
    });

    if (!found) {
      newLines.push(`ANTIGRAVITY_API_KEYS="${newEntry}"`);
    }

    writePrivateFile(targetPath, newLines.join("\n"));
    process.env.ANTIGRAVITY_API_KEYS = (process.env.ANTIGRAVITY_API_KEYS ? `${process.env.ANTIGRAVITY_API_KEYS},` : "") + newEntry;
    return [true, targetPath];
  } catch (err) {
    return [false, err.message];
  }
}

export function revokeApiKeyFromEnv(target, envPath = null) {
  const targetPath = envPath || findPrimaryEnvFile(false);
  if (!fs.existsSync(targetPath)) {
    return [false, `Env file not found: ${targetPath}`, []];
  }

  try {
    const content = fs.readFileSync(targetPath, "utf-8");
    const lines = content.split("\n");
    const removed = [];

    const newLines = lines.map((line) => {
      const trimmed = line.trim();
      if (trimmed.startsWith("ANTIGRAVITY_API_KEYS=")) {
        let val = trimmed.slice("ANTIGRAVITY_API_KEYS=".length).trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        const entries = val.split(",").map((e) => e.trim()).filter(Boolean);
        const kept = [];
        for (const entry of entries) {
          const [lbl, ...kParts] = entry.split(":");
          const kVal = kParts.join(":").trim();
          if (lbl === target || kVal === target || entry === target) {
            removed.push([lbl, kVal]);
          } else {
            kept.push(entry);
          }
        }
        return `ANTIGRAVITY_API_KEYS="${kept.join(",")}"`;
      }
      return line;
    });

    writePrivateFile(targetPath, newLines.join("\n"));
    // The server takes its keys from process.env (getConfiguredApiKeys): drop the revoked ones there as
    // well, or a revoked key keeps working until the next restart.
    if (removed.length && process.env.ANTIGRAVITY_API_KEYS) {
      const gone = new Set(removed.map(([lbl, k]) => k || lbl));
      process.env.ANTIGRAVITY_API_KEYS = process.env.ANTIGRAVITY_API_KEYS.split(",")
        .map((e) => e.trim())
        .filter(Boolean)
        .filter((entry) => {
          const [, ...kParts] = entry.split(":");
          return !gone.has(kParts.length ? kParts.join(":").trim() : entry);
        })
        .join(",");
    }
    return [true, targetPath, removed];
  } catch (err) {
    return [false, err.message, []];
  }
}
