import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  getCanonicalAntigravityDir,
  getBridgeConfigPath,
  getModelFamily,
  getModelFallbackChain,
  ANTIGRAVITY_MODEL_FALLBACK_ENABLED,
  DEFAULT_QUOTA_WINDOW_SECONDS,
  DEFAULT_FLASH_QUOTA_CAPACITY,
} from "../config.mjs";
import { isProfileSandboxLocked } from "./sandbox.mjs";
import { isSafeProfileName } from "./security.mjs";

export const QUOTA_ERROR_PATTERNS = [
  /individual\s+quota/i,
  /upgrade\s+your\s+subscription/i,
  /resets?\s+in\s+/i,
  /quota\s*(reached|exceeded|exhausted|limit|capacity)/i,
  /resource_exhausted/i,
  /resourceexhausted/i,
  /rate\s*limit/i,
  /ratelimit/i,
  /too\s*many\s*requests/i,
  /\b429\b/,
  /insufficient_quota/i,
  /exceeded\s+your\s+current\s+quota/i,
  /out\s+of\s+credits?/i,
  /credit\s+balance/i,
  /capacity\s+error/i,
  /model\s+overloaded/i,
  /overloaded/i,
  /\b503\b.*unavailable/i,
  /temporarily\s+unavailable/i,
  /usage\s+limit/i,
  /per-minute\s+quota/i,
  /daily\s+quota/i,
];

export function isQuotaOrRateLimitError(errorMsg) {
  if (!errorMsg || typeof errorMsg !== "string") return false;
  const lower = errorMsg.toLowerCase();
  if (
    lower.includes("resets in") ||
    lower.includes("individual quota") ||
    lower.includes("upgrade your subscription") ||
    lower.includes("quota reached") ||
    lower.includes("quota exceeded") ||
    lower.includes("quota limit") ||
    lower.includes("rate limit") ||
    lower.includes("resource_exhausted") ||
    lower.includes("resourceexhausted")
  ) {
    return true;
  }
  return QUOTA_ERROR_PATTERNS.some((pat) => pat.test(errorMsg));
}

export function parseQuotaResetSeconds(errorMessage) {
  if (!errorMessage || typeof errorMessage !== "string") return null;

  // 1. "Resets in 74h7m25s", "Resets in 1d 2h 3m 4s"
  const match1 = errorMessage.match(
    /Resets?\s+in\s+(?:(\d+)\s*(?:d|days?)\s*)?(?:(\d+)\s*(?:h|hours?|hrs?)\s*)?(?:(\d+)\s*(?:m|minutes?|mins?)\s*)?(?:(\d+(?:\.\d+)?)\s*(?:s|seconds?|secs?)?)?/i
  );
  if (match1 && (match1[1] || match1[2] || match1[3] || match1[4])) {
    let sec = 0;
    if (match1[1]) sec += parseFloat(match1[1]) * 86400;
    if (match1[2]) sec += parseFloat(match1[2]) * 3600;
    if (match1[3]) sec += parseFloat(match1[3]) * 60;
    if (match1[4]) sec += parseFloat(match1[4]);
    if (sec > 0) return sec;
  }

  // 2. Retry-After / Retry in N seconds / Try again in / wait (matches Python lines 1169-1178)
  const match2 = errorMessage.match(
    /(?:retry[-_\s]*after|try\s+again\s+in|wait)\s*[:=]?\s*(\d+(?:\.\d+)?)\s*(s|sec|seconds?|secs?|m|min|minutes?|mins?|h|hours?|hrs?)?/i
  );
  if (match2) {
    const val = parseFloat(match2[1]);
    const unit = (match2[2] || "s").toLowerCase();
    if (unit.startsWith("h")) {
      return val * 3600;
    } else if (unit.startsWith("m")) {
      return val * 60;
    }
    return val;
  }

  return null;
}

export function formatCooldownDuration(seconds) {
  if (!seconds || seconds <= 0) return "ready";
  const s = Math.floor(seconds);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const secs = s % 60;

  const parts = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  if (secs > 0 || parts.length === 0) parts.push(`${secs}s`);
  return parts.join(" ");
}

export function getProfileAccountEmail(profile) {
  if (!isSafeProfileName(profile)) return "N/A";
  const configBase = getCanonicalAntigravityDir();
  let p;
  if (!profile || profile === "default") {
    const candGemini = path.join(path.dirname(configBase), ".gemini", "google_accounts.json");
    p = fs.existsSync(candGemini) ? candGemini : path.join(os.homedir(), ".gemini", "google_accounts.json");
  } else {
    p = path.join(configBase, "profiles", profile, "google_accounts.json");
    if (!fs.existsSync(p)) {
      const altP = path.join(configBase, profile, "google_accounts.json");
      if (fs.existsSync(altP)) {
        p = altP;
      }
    }
  }

  if (p && fs.existsSync(p)) {
    try {
      const data = JSON.parse(fs.readFileSync(p, "utf-8"));
      return data.active || "N/A";
    } catch {
      // Ignore
    }
  }
  return "Not Logged In";
}

export function getAvailableProfiles() {
  const envProfiles = (process.env.ANTIGRAVITY_PROFILES || "").trim();
  if (envProfiles) {
    const list = envProfiles.split(",").map((p) => p.trim()).filter(Boolean);
    if (list.length > 0) return list;
  }

  const configBase = getCanonicalAntigravityDir();
  const cfgFile = getBridgeConfigPath();
  if (fs.existsSync(cfgFile)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(cfgFile, "utf-8"));
      if (cfg.profiles && Array.isArray(cfg.profiles) && cfg.profiles.length > 0) {
        return cfg.profiles.map((p) => String(p).trim()).filter(Boolean);
      }
    } catch {
      // Ignore
    }
  }

  const profilesDir = path.join(configBase, "profiles");
  if (fs.existsSync(profilesDir) && fs.statSync(profilesDir).isDirectory()) {
    const found = fs
      .readdirSync(profilesDir)
      .filter((d) => {
        const full = path.join(profilesDir, d);
        return (
          fs.statSync(full).isDirectory() &&
          !d.startsWith(".") &&
          !d.endsWith(".disabled") &&
          !d.endsWith(".bak")
        );
      })
      .sort();

    if (found.length > 0) {
      const active = (process.env.ANTIGRAVITY_PROFILE || "").trim();
      if (active && found.includes(active)) {
        const idx = found.indexOf(active);
        found.splice(idx, 1);
        found.unshift(active);
      }
      return found;
    }
  }

  const active = (process.env.ANTIGRAVITY_PROFILE || "").trim();
  return active ? [active] : [null];
}

export function getDisabledProfiles() {
  const disSet = new Set();
  const envDis = (process.env.ANTIGRAVITY_DISABLED_PROFILES || "").trim();
  if (envDis) {
    for (const p of envDis.split(",")) {
      if (p.trim()) disSet.add(p.trim());
    }
  }

  const cfgFile = getBridgeConfigPath();
  if (fs.existsSync(cfgFile)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(cfgFile, "utf-8"));
      if (cfg.disabled_profiles && Array.isArray(cfg.disabled_profiles)) {
        for (const p of cfg.disabled_profiles) {
          if (String(p).trim()) disSet.add(String(p).trim());
        }
      }
    } catch {
      // Ignore
    }
  }

  return disSet;
}

export class ProfileManager {
  constructor(profiles = null) {
    this._profiles = profiles || getAvailableProfiles();
    this.concurrency_per_profile = parseInt(process.env.ANTIGRAVITY_CONCURRENCY_PER_PROFILE || "1", 10);
    this.default_cooldown = 180.0;
    this.max_cooldown = 86400.0;
    this.cache_file =
      process.env.ANTIGRAVITY_QUOTA_CACHE_FILE ||
      path.join(getCanonicalAntigravityDir(), "quota_cache_node.json");

    this.state = {};
    this.in_flight = new Map();
    this.last_execution_models = new Map();
    this.load_cache();
  }

  get_profiles() {
    return [...this._profiles];
  }

  set_profiles(profiles) {
    this._profiles = Array.isArray(profiles) ? profiles : [null];
    for (const p of this._profiles) {
      const k = p || "default";
      if (!this.state[k]) {
        this.state[k] = {
          status: "OK",
          exhausted_until: 0,
          family_cooldowns: { gemini: 0, claude: 0, "gpt-oss": 0 },
          last_checked: 0,
          last_used: 0,
          last_reason: "",
          consecutive_errors: 0,
          success_count: 0,
          window_requests: 0,
          window_start: 0,
        };
      }
    }
  }

  load_cache() {
    const disabledSet = getDisabledProfiles();
    for (const p of this._profiles) {
      const k = p || "default";
      const isDis = disabledSet.has(k);
      this.state[k] = {
        status: isDis ? "DISABLED" : "OK",
        exhausted_until: isDis ? Math.floor(Date.now() / 1000) + 315360000 : 0,
        family_cooldowns: {
          gemini: isDis ? Math.floor(Date.now() / 1000) + 315360000 : 0,
          claude: 0,
          "gpt-oss": 0,
        },
        last_checked: 0,
        last_used: 0,
        last_reason: isDis ? "Configured as permanently disabled" : "",
        consecutive_errors: 0,
        success_count: 0,
        window_requests: 0,
        window_start: 0,
      };
    }

    if (fs.existsSync(this.cache_file)) {
      try {
        const saved = JSON.parse(fs.readFileSync(this.cache_file, "utf-8"));
        if (saved && typeof saved === "object") {
          for (const [k, v] of Object.entries(saved)) {
            if (v && typeof v === "object") {
              if (!this.state[k]) {
                this.state[k] = {
                  status: "OK",
                  exhausted_until: 0,
                  family_cooldowns: { gemini: 0, claude: 0, "gpt-oss": 0 },
                  last_checked: 0,
                  last_used: 0,
                  last_reason: "",
                  consecutive_errors: 0,
                  success_count: 0,
                  window_requests: 0,
                  window_start: 0,
                };
              }
              Object.assign(this.state[k], v);
              if (!this.state[k].family_cooldowns) {
                this.state[k].family_cooldowns = { gemini: 0, claude: 0, "gpt-oss": 0 };
              }
            }
          }
        }
      } catch {
        // Ignore cache load errors
      }
    }
  }

  save_cache() {
    try {
      const cacheDir = path.dirname(this.cache_file);
      fs.mkdirSync(cacheDir, { recursive: true });
      const tmpFile = `${this.cache_file}.tmp.${process.pid}`;
      fs.writeFileSync(tmpFile, JSON.stringify(this.state, null, 2), { encoding: "utf-8", mode: 0o600 });
      fs.renameSync(tmpFile, this.cache_file);
    } catch {
      // Ignore cache write errors
    }
  }

  get_in_flight(profile) {
    const k = profile || "default";
    return this.in_flight.get(k) || 0;
  }

  get_total_in_flight() {
    let total = 0;
    for (const v of this.in_flight.values()) {
      total += v;
    }
    return total;
  }

  is_profile_busy(profile) {
    const k = profile || "default";
    const inFl = this.get_in_flight(profile);
    return inFl >= this.concurrency_per_profile || isProfileSandboxLocked(profile);
  }

  get_idle_profiles() {
    const now = Math.floor(Date.now() / 1000);
    return this._profiles.filter((p) => {
      const k = p || "default";
      const info = this.state[k] || {};
      const inFl = this.get_in_flight(p);
      const isLocked = isProfileSandboxLocked(p);
      const isDis = info.status === "DISABLED";
      const isEx = (info.exhausted_until || 0) > now;
      return inFl === 0 && !isLocked && !isDis && !isEx;
    });
  }

  get_busy_profiles() {
    return this._profiles.filter((p) => {
      const inFl = this.get_in_flight(p);
      const isLocked = isProfileSandboxLocked(p);
      return inFl >= this.concurrency_per_profile || isLocked;
    });
  }

  is_family_in_cooldown(profile, family) {
    const k = profile || "default";
    const info = this.state[k] || {};
    if (info.status === "DISABLED") return true;
    const now = Math.floor(Date.now() / 1000);
    const famUntil = info.family_cooldowns?.[family] || 0;
    return now < famUntil;
  }

  get_family_cooldown_remaining(profile, family) {
    const k = profile || "default";
    const info = this.state[k] || {};
    const famUntil = info.family_cooldowns?.[family] || 0;
    return Math.max(0, famUntil - Math.floor(Date.now() / 1000));
  }

  is_in_cooldown(profile, model = null) {
    const k = profile || "default";
    const info = this.state[k] || {};
    if (info.status === "DISABLED") return true;
    const now = Math.floor(Date.now() / 1000);

    if (model) {
      const fam = getModelFamily(model);
      const famUntil = info.family_cooldowns?.[fam] || 0;
      if (famUntil > now) return true;
      if (info.status === "ERROR_COOLDOWN" && info.exhausted_until > now) return true;
      return false;
    }

    return now < (info.exhausted_until || 0);
  }

  is_executable(profile, model = null) {
    const k = profile || "default";
    const info = this.state[k] || {};
    if (info.status === "DISABLED") return false;
    const now = Math.floor(Date.now() / 1000);

    if (!model) {
      return now >= (info.exhausted_until || 0);
    }

    const fam = getModelFamily(model);
    if (fam === "gemini" && ANTIGRAVITY_MODEL_FALLBACK_ENABLED) {
      const geminiUntil = info.family_cooldowns?.gemini || 0;
      if (now >= geminiUntil) return true;
      return this.get_available_fallback_model(profile, model) !== null;
    }

    return !this.is_in_cooldown(profile, model);
  }

  get_available_fallback_model(profile, requestedModel = null) {
    if (!ANTIGRAVITY_MODEL_FALLBACK_ENABLED) return null;
    const k = profile || "default";
    const info = this.state[k] || {};
    if (info.status === "DISABLED") return null;

    const chain = getModelFallbackChain(requestedModel);
    for (const cand of chain) {
      const fam = getModelFamily(cand);
      if (!this.is_family_in_cooldown(profile, fam)) {
        return cand;
      }
    }
    return null;
  }

  is_sonnet_fallback_candidate(profile, requestedModel = null) {
    if (!ANTIGRAVITY_MODEL_FALLBACK_ENABLED) return false;
    const k = profile || "default";
    const info = this.state[k] || {};
    if (info.status === "DISABLED") return false;
    const now = Math.floor(Date.now() / 1000);
    const geminiUntil = info.family_cooldowns?.gemini || 0;
    if (now >= geminiUntil) return false;
    return this.get_available_fallback_model(profile, requestedModel) !== null;
  }

  acquire_profile(candidateProfiles, waitTimeout = 0, model = null) {
    for (const p of candidateProfiles) {
      if (!this.is_profile_busy(p) && this.is_executable(p, model)) {
        this.acquire_specific_profile(p);
        return p;
      }
    }
    return null;
  }

  acquire_specific_profile(profile) {
    const k = profile || "default";
    const current = this.in_flight.get(k) || 0;
    this.in_flight.set(k, current + 1);
  }

  release_profile(profile) {
    const k = profile || "default";
    const current = this.in_flight.get(k) || 0;
    if (current > 0) {
      this.in_flight.set(k, current - 1);
    }
  }

  set_last_execution_model(profile, model) {
    const k = profile || "default";
    this.last_execution_models.set(k, model);
  }

  get_last_execution_model(profile) {
    const k = profile || "default";
    return this.last_execution_models.get(k) || null;
  }

  mark_exhausted(profile, reason, cooldownSeconds = null, model = null) {
    const k = profile || "default";
    const now = Math.floor(Date.now() / 1000);
    let fam = getModelFamily(model);
    const rLower = reason.toLowerCase();
    if (rLower.includes("claude") || rLower.includes("sonnet") || rLower.includes("opus")) {
      fam = "claude";
    } else if (rLower.includes("gpt-oss")) {
      fam = "gpt-oss";
    }

    if (!this.state[k]) {
      this.state[k] = {
        status: "OK",
        exhausted_until: 0,
        family_cooldowns: { gemini: 0, claude: 0, "gpt-oss": 0 },
        last_checked: 0,
        last_used: 0,
        last_reason: "",
        consecutive_errors: 0,
        success_count: 0,
        window_requests: 0,
        window_start: 0,
      };
    }

    const errCount = (this.state[k].consecutive_errors || 0) + 1;
    this.state[k].consecutive_errors = errCount;

    let duration;
    if (cooldownSeconds !== null) {
      duration = cooldownSeconds;
    } else {
      const parsed = parseQuotaResetSeconds(reason);
      if (parsed) {
        duration = parsed;
      } else {
        const multiplier = Math.min(Math.pow(2, errCount - 1), 8);
        duration = Math.min(this.default_cooldown * multiplier, this.max_cooldown);
      }
    }

    const untilTs = Math.floor(now + duration);
    this.state[k].status = "EXHAUSTED";
    if (!this.state[k].family_cooldowns) {
      this.state[k].family_cooldowns = { gemini: 0, claude: 0, "gpt-oss": 0 };
    }
    this.state[k].family_cooldowns[fam] = untilTs;
    this.state[k].exhausted_until = Math.max(...Object.values(this.state[k].family_cooldowns));
    this.state[k].last_checked = now;
    this.state[k].last_reason = reason;
    this.state[k].window_requests = DEFAULT_FLASH_QUOTA_CAPACITY;
    this.save_cache();
  }

  mark_error(profile, reason) {
    const k = profile || "default";
    const now = Math.floor(Date.now() / 1000);
    if (!this.state[k]) {
      this.state[k] = {
        status: "OK",
        exhausted_until: 0,
        family_cooldowns: { gemini: 0, claude: 0 },
        last_checked: 0,
        last_used: 0,
        last_reason: "",
        consecutive_errors: 0,
        success_count: 0,
        window_requests: 0,
        window_start: 0,
      };
    }
    const errCount = (this.state[k].consecutive_errors || 0) + 1;
    this.state[k].consecutive_errors = errCount;
    this.state[k].last_checked = now;
    this.state[k].last_reason = reason;

    const duration = Math.min(30.0 * Math.pow(2, errCount - 1), this.max_cooldown);
    this.state[k].status = "ERROR_COOLDOWN";
    this.state[k].exhausted_until = Math.floor(now + duration);
    this.save_cache();
  }

  mark_success(profile, model = null) {
    const k = profile || "default";
    const now = Math.floor(Date.now() / 1000);
    const fam = model ? getModelFamily(model) : null;

    if (!this.state[k]) {
      this.state[k] = {
        status: "OK",
        exhausted_until: 0,
        family_cooldowns: { gemini: 0, claude: 0 },
        last_checked: 0,
        last_used: 0,
        last_reason: "",
        consecutive_errors: 0,
        success_count: 0,
        window_requests: 0,
        window_start: 0,
      };
    }

    if (fam && this.state[k].family_cooldowns?.[fam]) {
      this.state[k].family_cooldowns[fam] = 0;
    }

    const activeCds = Object.values(this.state[k].family_cooldowns || {}).filter((ts) => ts > now);
    if (activeCds.length === 0) {
      this.state[k].status = "OK";
      this.state[k].exhausted_until = 0;
    } else {
      this.state[k].exhausted_until = Math.max(...activeCds);
    }

    this.state[k].consecutive_errors = 0;
    this.state[k].success_count = (this.state[k].success_count || 0) + 1;

    const wStart = this.state[k].window_start || 0;
    if (now - wStart > DEFAULT_QUOTA_WINDOW_SECONDS) {
      this.state[k].window_start = now;
      this.state[k].window_requests = 1;
    } else {
      this.state[k].window_requests = (this.state[k].window_requests || 0) + 1;
    }

    this.state[k].last_used = now;
    this.state[k].last_checked = now;
    this.save_cache();
  }

  mark_disabled(profile, reason = "Manually disabled by user") {
    const k = profile || "default";
    if (!this.state[k]) {
      this.state[k] = { status: "OK", exhausted_until: 0 };
    }
    this.state[k].status = "DISABLED";
    this.state[k].exhausted_until = Math.floor(Date.now() / 1000) + 315360000;
    this.state[k].last_reason = reason;
    this.save_cache();
  }

  enable(profile) {
    this.reset_all(profile);
  }

  reset_all(profile = null) {
    const now = Math.floor(Date.now() / 1000);
    if (profile) {
      const k = profile;
      if (this.state[k]) {
        this.state[k].status = "OK";
        this.state[k].exhausted_until = 0;
        this.state[k].family_cooldowns = { gemini: 0, claude: 0, "gpt-oss": 0 };
        this.state[k].consecutive_errors = 0;
        this.state[k].window_requests = 0;
        this.state[k].window_start = now;
      }
    } else {
      for (const k of Object.keys(this.state)) {
        if (this.state[k].status === "DISABLED") continue;
        this.state[k].status = "OK";
        this.state[k].exhausted_until = 0;
        this.state[k].family_cooldowns = { gemini: 0, claude: 0, "gpt-oss": 0 };
        this.state[k].consecutive_errors = 0;
        this.state[k].window_requests = 0;
        this.state[k].window_start = now;
      }
    }
    this.save_cache();
  }

  get_estimated_quota_percent(profile) {
    const key = profile || "default";
    const info = this.state[key] || {};
    const status = info.status || "OK";
    if (status === "DISABLED") return 0;
    const now = Math.floor(Date.now() / 1000);
    const exUntil = info.exhausted_until || 0;
    if (exUntil > now) return 0;
    const wStart = info.window_start || 0;
    if (now - wStart > DEFAULT_QUOTA_WINDOW_SECONDS) {
      return 100;
    }
    const reqs = info.window_requests || 0;
    const usedRatio = Math.min(1.0, reqs / Number(DEFAULT_FLASH_QUOTA_CAPACITY));
    const pct = Math.max(5, Math.floor((1.0 - usedRatio) * 100));
    return pct;
  }

  get_ordered_profiles(model = null) {
    const now = Math.floor(Date.now() / 1000);
    const fam = model ? getModelFamily(model) : null;
    const useFallback = fam === "gemini" && ANTIGRAVITY_MODEL_FALLBACK_ENABLED;

    const readyIdle = [];
    const readyAvail = [];
    const fallbackIdle = [];
    const fallbackAvail = [];
    const busy = [];
    const exhausted = [];

    for (const p of this._profiles) {
      const k = p || "default";
      const info = this.state[k] || {};
      if (info.status === "DISABLED") continue;

      const fCds = info.family_cooldowns || {};
      const geminiCd = fCds.gemini || 0;
      const exUntil = info.exhausted_until || 0;

      if (useFallback) {
        const isGeminiDown = now < geminiCd || (info.status === "EXHAUSTED" && geminiCd === 0 && now < exUntil);
        const fbCand = isGeminiDown ? this.get_available_fallback_model(p, model) : null;
        if (isGeminiDown && !fbCand) {
          exhausted.push(p);
          continue;
        }
      } else {
        if (exUntil > 0 && now < exUntil) {
          exhausted.push(p);
          continue;
        }
      }

      const inFl = this.get_in_flight(p);
      const isLocked = isProfileSandboxLocked(p);
      const isBusy = inFl >= this.concurrency_per_profile || isLocked;

      if (useFallback) {
        const isGeminiDown = now < geminiCd || (info.status === "EXHAUSTED" && geminiCd === 0 && now < exUntil);
        if (!isGeminiDown) {
          if (inFl === 0 && !isLocked) readyIdle.push(p);
          else if (!isBusy) readyAvail.push(p);
          else busy.push(p);
        } else {
          if (inFl === 0 && !isLocked) fallbackIdle.push(p);
          else if (!isBusy) fallbackAvail.push(p);
          else busy.push(p);
        }
      } else {
        if (inFl === 0 && !isLocked) readyIdle.push(p);
        else if (!isBusy) readyAvail.push(p);
        else busy.push(p);
      }
    }

    return [...readyIdle, ...readyAvail, ...fallbackIdle, ...fallbackAvail, ...busy, ...exhausted];
  }

  get_status_summary() {
    const summary = {};
    const now = Math.floor(Date.now() / 1000);

    for (const p of this._profiles) {
      const k = p || "default";
      const info = { ...(this.state[k] || {}) };
      const exhaustedUntil = info.exhausted_until || 0;
      const cooldownLeft = Math.max(0, Math.floor(exhaustedUntil - now));
      const isAvail = cooldownLeft === 0 && info.status !== "DISABLED";
      info.available = isAvail;
      info.cooldown_seconds_remaining = cooldownLeft;
      const inFl = this.get_in_flight(p);
      const maxC = this.concurrency_per_profile;
      const isLocked = isProfileSandboxLocked(p);
      const isBusy = inFl >= maxC || isLocked;
      info.in_flight = inFl;
      info.max_concurrency = maxC;
      info.is_locked = isLocked;
      info.is_busy = isBusy;
      info.concurrency_status = isBusy ? "BUSY" : inFl === 0 ? "IDLE" : "PARTIAL";

      const gemRem = this.get_family_cooldown_remaining(p, "gemini");
      const claudeRem = this.get_family_cooldown_remaining(p, "claude");
      const gptOssRem = this.get_family_cooldown_remaining(p, "gpt-oss");
      const isFallback = this.is_sonnet_fallback_candidate(p);

      info.gemini_cooldown_seconds_remaining = gemRem;
      info.claude_cooldown_seconds_remaining = claudeRem;
      info.gpt_oss_cooldown_seconds_remaining = gptOssRem;
      info.sonnet_fallback_candidate = isFallback;
      info.last_execution_model = this.get_last_execution_model(p);

      let quotaPct;
      if (info.status === "DISABLED" || cooldownLeft > 0) {
        quotaPct = 0;
      } else {
        const wStart = info.window_start || 0;
        if (now - wStart > DEFAULT_QUOTA_WINDOW_SECONDS) {
          quotaPct = 100;
        } else {
          const reqs = info.window_requests || 0;
          quotaPct = Math.max(5, Math.floor((1.0 - Math.min(1.0, reqs / Number(DEFAULT_FLASH_QUOTA_CAPACITY))) * 100));
        }
      }
      info.estimated_quota_percent = quotaPct;
      summary[k] = info;
    }

    return summary;
  }

  build_profile_quota_banner(usedProfile = null) {
    const key = usedProfile || "default";
    const email = getProfileAccountEmail(usedProfile);
    const emailInfo = email && email !== "Not Logged In" ? ` (\`${email}\`)` : "";

    const quotaPct = this.get_estimated_quota_percent(usedProfile);
    const totalProfiles = [...this._profiles];
    const totalCount = totalProfiles.length;

    const readyList = [];
    const sonnetFallbackList = [];
    const cooldownList = [];
    const disabledList = [];

    for (const p of totalProfiles) {
      const pk = p || "default";
      const info = this.state[pk] || {};
      const st = info.status || "OK";
      if (st === "DISABLED") {
        disabledList.push(pk);
        continue;
      }

      const geminiRem = this.get_family_cooldown_remaining(p, "gemini");
      const hasFb = this.get_available_fallback_model(p) !== null;

      if (geminiRem > 0) {
        if (hasFb && ANTIGRAVITY_MODEL_FALLBACK_ENABLED) {
          sonnetFallbackList.push([pk, geminiRem]);
        } else {
          cooldownList.push([pk, geminiRem]);
        }
      } else {
        readyList.push(pk);
      }
    }

    const enabledCount = Math.max(1, totalCount - disabledList.length);
    const readyCount = readyList.length;

    // Header line for used profile
    const geminiRemUsed = this.get_family_cooldown_remaining(usedProfile, "gemini");
    const lastModel = this.get_last_execution_model(usedProfile);
    const isFbCandidate = this.is_sonnet_fallback_candidate(usedProfile);

    let lines;
    if (
      geminiRemUsed > 0 &&
      ((lastModel && (lastModel.toLowerCase().includes("claude") || lastModel.toLowerCase().includes("opus") || lastModel.toLowerCase().includes("gpt-oss"))) || isFbCandidate)
    ) {
      let modelLabel;
      if (lastModel && lastModel.toLowerCase().includes("opus")) {
        modelLabel = "Claude Opus 4.6 (Thinking)";
      } else if (lastModel && lastModel.toLowerCase().includes("gpt-oss")) {
        modelLabel = "GPT-OSS 120B (Medium)";
      } else if (lastModel && lastModel.toLowerCase().includes("sonnet")) {
        modelLabel = "Claude Sonnet 4.6";
      } else {
        const fb = this.get_available_fallback_model(usedProfile, lastModel);
        modelLabel = fb || "Model Fallback";
      }
      lines = [
        "",
        "---",
        `> ⚡ **Antigravity Profile:** \`${key}\`${emailInfo} | 🔀 **Model:** \`${modelLabel}\` (Gemini Reset in ${formatCooldownDuration(geminiRemUsed)})`,
      ];
    } else {
      lines = [
        "",
        "---",
        `> ⚡ **Antigravity Profile:** \`${key}\`${emailInfo} | 🔋 **Quota:** ~**${quotaPct}%** (Flash Est.)`,
      ];
    }

    if (totalCount > 1) {
      const poolParts = [`🟢 **${readyCount}/${enabledCount}** Ready (Gemini)`];
      if (sonnetFallbackList.length > 0) {
        poolParts.push(`🟣 **${sonnetFallbackList.length}** in Cooldown (Model Fallback)`);
      }
      if (cooldownList.length > 0) {
        poolParts.push(`🔴 **${cooldownList.length}** in Cooldown`);
      }
      if (disabledList.length > 0) {
        poolParts.push(`⚪ **${disabledList.length}** Disabled`);
      }
      lines.push(`> 📊 **Quota Pool:** ${poolParts.join(" • ")}`);
      if (sonnetFallbackList.length > 0) {
        sonnetFallbackList.sort((a, b) => a[1] - b[1]);
        const fbItems = sonnetFallbackList.map(
          ([p, rem]) => `\`${p}\` (⏳ Gemini reset in ${formatCooldownDuration(rem)})`
        );
        lines.push(`> 🟣 **Model Fallback Active:** ${fbItems.join(", ")}`);
      }
      if (cooldownList.length > 0) {
        cooldownList.sort((a, b) => a[1] - b[1]);
        const cdItems = cooldownList.map(
          ([p, rem]) => `\`${p}\` (⏳ ${formatCooldownDuration(rem)})`
        );
        lines.push(`> ⏳ **In Cooldown:** ${cdItems.join(", ")}`);
      }
    } else {
      let statusDesc;
      if (geminiRemUsed > 0 && isFbCandidate) {
        statusDesc = `🟣 Model Fallback Active (Gemini reset in ${formatCooldownDuration(geminiRemUsed)})`;
      } else {
        statusDesc = readyList.includes(key) ? "🟢 Ready" : "🔴 In Cooldown";
      }
      lines.push(`> 📊 **Quota Status:** ${statusDesc} (~${quotaPct}%)`);
    }

    return lines.join("\n");
  }
}

export const GLOBAL_PROFILE_MANAGER = new ProfileManager();
