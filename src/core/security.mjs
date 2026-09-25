/**
 * Security helpers shared across the Node.js edition.
 *
 * - Timing-safe API key verification (own-property only, no prototype lookups)
 * - Profile name validation (blocks path traversal / control characters)
 * - Private file writes (0600) and directory creation (0700)
 * - Host header allow-listing (DNS-rebinding defence)
 * - Header value sanitisation (CRLF injection defence)
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

export const PROFILE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const API_KEY_LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const API_KEY_VALUE_RE = /^[A-Za-z0-9._-]{8,256}$/;

/**
 * Returns true when `name` is a safe single path segment usable as a profile name.
 * `null`/"" (meaning the default profile) is accepted.
 */
export function isSafeProfileName(name) {
  if (name === null || name === undefined || name === "") return true;
  if (typeof name !== "string") return false;
  if (name === "." || name === "..") return false;
  return PROFILE_NAME_RE.test(name);
}

/** Throws if `name` is not a safe profile name. Returns the name unchanged. */
export function assertSafeProfileName(name) {
  if (!isSafeProfileName(name)) {
    throw new Error(`Invalid profile name: ${JSON.stringify(String(name)).slice(0, 80)}`);
  }
  return name;
}

/**
 * Resolves `child` inside `root` and verifies the result does not escape it.
 */
export function resolveInside(root, ...segments) {
  const rootAbs = path.resolve(root);
  const target = path.resolve(rootAbs, ...segments);
  if (target !== rootAbs && !target.startsWith(rootAbs + path.sep)) {
    throw new Error("Path escapes its base directory");
  }
  return target;
}

function timingSafeEqualStr(a, b) {
  const ba = Buffer.from(String(a), "utf-8");
  const bb = Buffer.from(String(b), "utf-8");
  if (ba.length !== bb.length) {
    // Still burn comparable time before returning.
    crypto.timingSafeEqual(ba, ba);
    return false;
  }
  return crypto.timingSafeEqual(ba, bb);
}

/**
 * Checks `candidate` against the configured key map in constant time and
 * without consulting the prototype chain. Returns the key's label or null.
 */
export function verifyApiKey(candidate, apiKeys) {
  if (!candidate || typeof candidate !== "string" || !apiKeys) return null;
  let matchedLabel = null;
  for (const key of Object.keys(apiKeys)) {
    if (!Object.prototype.hasOwnProperty.call(apiKeys, key)) continue;
    if (timingSafeEqualStr(candidate, key)) {
      matchedLabel = apiKeys[key] || "default";
      // Do not break early: keep timing independent of match position.
    }
  }
  return matchedLabel;
}

/** Writes `content` to `filePath` readable only by the owner (0600). */
export function writePrivateFile(filePath, content, options = {}) {
  const encoding = options.encoding || "utf-8";
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(filePath, content, { encoding, mode: 0o600 });
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // Windows / unsupported FS: ignore
  }
}

/** Copies `src` to `dst` and forces 0600 on the destination. */
export function copyPrivateFile(src, dst) {
  fs.mkdirSync(path.dirname(dst), { recursive: true, mode: 0o700 });
  fs.copyFileSync(src, dst);
  try {
    fs.chmodSync(dst, 0o600);
  } catch {
    // ignore
  }
}

/** Creates a directory (recursively) with owner-only permissions. */
export function mkdirPrivate(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dirPath, 0o700);
  } catch {
    // ignore
  }
}

/** Best-effort tightening of an existing secret file's permissions. */
export function chmodPrivateIfExists(filePath) {
  try {
    if (fs.existsSync(filePath)) fs.chmodSync(filePath, 0o600);
  } catch {
    // ignore
  }
}

/**
 * Stores a secret in the macOS Keychain without exposing it on the command
 * line: commands are piped to `security -i` over stdin instead of `-w <value>`.
 * `value` must not contain whitespace or quotes (base64 payloads are fine).
 */
export function macKeychainStore(service, account, value) {
  if (!/^[A-Za-z0-9+/=:_.-]+$/.test(value)) {
    throw new Error("Keychain value contains characters unsafe for security -i");
  }
  const cmd = `add-generic-password -U -s ${JSON.stringify(service)} -a ${JSON.stringify(account)} -w ${value}\n`;
  const res = spawnSync("security", ["-i"], { input: cmd, encoding: "utf-8", timeout: 10000, windowsHide: true });
  return res.status === 0;
}

const WILDCARD_HOSTS = new Set(["", "0.0.0.0", "::", "[::]", "*"]);
const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "::1", "[::1]"];

/**
 * Builds the set of Host header values accepted by the server.
 * Returns null when any Host must be accepted (wildcard bind with no explicit list).
 */
export function buildAllowedHosts(bindHost, extra = null) {
  const list = [];
  const extraRaw = extra ?? process.env.ANTIGRAVITY_ALLOWED_HOSTS ?? "";
  for (const h of String(extraRaw).split(/[\s,]+/)) {
    if (h) list.push(h.toLowerCase());
  }
  const bind = String(bindHost || "").toLowerCase();
  if (WILDCARD_HOSTS.has(bind) && list.length === 0) {
    return null;
  }
  for (const h of LOOPBACK_HOSTS) list.push(h);
  if (bind && !WILDCARD_HOSTS.has(bind)) list.push(bind);
  return new Set(list);
}

/** Strips the port from a Host header value and lower-cases it. */
export function normaliseHostHeader(hostHeader) {
  const raw = String(hostHeader || "").trim().toLowerCase();
  if (!raw) return "";
  if (raw.startsWith("[")) {
    const end = raw.indexOf("]");
    return end === -1 ? raw : raw.slice(0, end + 1);
  }
  const idx = raw.lastIndexOf(":");
  if (idx !== -1 && raw.indexOf(":") === idx) {
    return raw.slice(0, idx);
  }
  return raw;
}

/** Returns true when the request's Host header is acceptable. */
export function isAllowedHost(hostHeader, allowedHosts) {
  if (!allowedHosts) return true; // wildcard bind, no explicit list
  const host = normaliseHostHeader(hostHeader);
  if (!host) return false;
  return allowedHosts.has(host);
}

/** Removes CR/LF and other control characters from a header value. */
export function sanitizeHeaderValue(value, maxLen = 512) {
  return String(value ?? "")
    .replace(/[\r\n\x00-\x1f\x7f]/g, " ")
    .slice(0, maxLen);
}
