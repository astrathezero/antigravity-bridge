import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import net from "node:net";

/**
 * Lightweight zero-dependency .env file parser and loader.
 * @param {string[]} [paths]
 */
export function loadDotenv(paths) {
  if (!paths) {
    const cwd = process.cwd();
    const home = os.homedir();
    paths = [
      path.join(cwd, ".env"),
      path.join(home, ".config", "antigravity", "bridge.env"),
      path.join(home, ".config", "antigravity", ".env"),
      path.join(home, ".env"),
    ];
  }

  for (const p of paths) {
    if (fs.existsSync(p)) {
      try {
        const content = fs.readFileSync(p, "utf-8");
        for (const line of content.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) {
            continue;
          }
          const eqIdx = trimmed.indexOf("=");
          const k = trimmed.slice(0, eqIdx).trim();
          let v = trimmed.slice(eqIdx + 1).trim();
          if (
            (v.startsWith('"') && v.endsWith('"')) ||
            (v.startsWith("'") && v.endsWith("'"))
          ) {
            v = v.slice(1, -1);
          }
          if (!(k in process.env)) {
            process.env[k] = v;
          }
        }
      } catch {
        // Ignore read errors
      }
    }
  }
}

// Load default environment variables
loadDotenv();

export const DEFAULT_PORT = parseInt(
  process.env.PORT || process.env.ANTIGRAVITY_PORT || process.env.BRIDGE_PORT || "8008",
  10
);
export const DEFAULT_HOST = process.env.HOST || process.env.ANTIGRAVITY_HOST || "127.0.0.1";

export const MAX_BODY_SIZE = 32 * 1024 * 1024; // 32 MB
// Linux limits a SINGLE argv string to MAX_ARG_STRLEN = 131072 bytes (spawn E2BIG above that), so the
// prompt passed as `-p "<prompt>"` must stay below it; 120000 leaves headroom. Thai text is 3 bytes/char.
export const MAX_CLI_ARG_BYTES = parseInt(process.env.ANTIGRAVITY_MAX_CLI_ARG_BYTES || "120000", 10) || 120000;
// Prompts larger than MAX_CLI_ARG_BYTES are handed to agy over stdin as one NDJSON line
// ({"event":"user","message":{"role":"user","content":...}} with --input-format stream-json),
// which has no argv size limit. This is the hard cap for that path.
export const MAX_STDIN_PROMPT_BYTES = parseInt(process.env.ANTIGRAVITY_MAX_STDIN_PROMPT_BYTES || "2000000", 10) || 2000000;

export const DEFAULT_PROFILE_TIMEOUT = parseFloat(process.env.ANTIGRAVITY_PROFILE_TIMEOUT || "600.0");
export const DEFAULT_TOTAL_TIMEOUT = parseFloat(process.env.ANTIGRAVITY_TOTAL_TIMEOUT || "1800.0");
export const DEFAULT_MAX_AUTOSCALE_TIMEOUT = parseFloat(process.env.ANTIGRAVITY_MAX_AUTOSCALE_TIMEOUT || "900.0");
export const DEFAULT_MAX_TOTAL_TIMEOUT = parseFloat(process.env.ANTIGRAVITY_MAX_TOTAL_TIMEOUT || "3600.0");
// Silence is NOT a hang signal for agy: in print mode it emits nothing while the model
// is thinking (often minutes for reasoning models). The stall watchdog therefore only
// fires after a long quiet period; the hard per-profile timeout remains the real guard.
export const DEFAULT_STALL_TIMEOUT = parseFloat(process.env.ANTIGRAVITY_STALL_TIMEOUT || "600.0");
export const DEFAULT_SHORT_PROMPT_TIMEOUT = parseFloat(process.env.ANTIGRAVITY_SHORT_PROMPT_TIMEOUT || "120.0");

export const DEFAULT_IMAGE_ROUTER_URL = process.env.ANTIGRAVITY_IMAGE_ROUTER_URL || "";
export const DEFAULT_IMAGE_ROUTER_KEY = process.env.ANTIGRAVITY_IMAGE_ROUTER_KEY || "";

export const DEFAULT_FALLBACK_CHAIN = ["claude-opus-4-6-thinking", "gpt-oss-120b-medium"];
export const ANTIGRAVITY_MODEL_FALLBACK_ENABLED = ["1", "true", "yes"].includes(
  (process.env.ANTIGRAVITY_MODEL_FALLBACK_ENABLED || "true").toLowerCase()
);

export const DEFAULT_QUOTA_WINDOW_SECONDS = 10800.0; // 3-hour sliding window for Google Gemini quota
export const DEFAULT_FLASH_QUOTA_CAPACITY = 50;      // Baseline 50 requests capacity per 3h window for Flash

export const SUPPORTED_MODELS = {
  "gemini-3.8-flash": ["gemini-3.8-flash", "high"],
  "gemini-3.8-flash-high": ["gemini-3.8-flash", "high"],
  "gemini-3.8-flash-medium": ["gemini-3.8-flash", "medium"],
  "gemini-3.8-flash-low": ["gemini-3.8-flash", "low"],
  "gemini-3.7-flash": ["gemini-3.7-flash", "high"],
  "gemini-3.7-flash-high": ["gemini-3.7-flash", "high"],
  "gemini-3.7-flash-medium": ["gemini-3.7-flash", "medium"],
  "gemini-3.7-flash-low": ["gemini-3.7-flash", "low"],
  "gemini-3.6-flash-high": ["gemini-3.6-flash", "high"],
  "gemini-3.6-flash-medium": ["gemini-3.6-flash", "medium"],
  "gemini-3.6-flash-low": ["gemini-3.6-flash", "low"],
  "gemini-3.6-flash": ["gemini-3.6-flash", null],
  "gemini-3.5-flash-medium": ["gemini-3.5-flash", "medium"],
  "gemini-3.5-flash-low": ["gemini-3.5-flash", "low"],
  "gemini-3.5-flash": ["gemini-3.5-flash", null],
  "gemini-3.1-pro-high": ["gemini-3.1-pro", "high"],
  "gemini-3.1-pro-low": ["gemini-3.1-pro", "low"],
  "gemini-3.1-pro": ["gemini-3.1-pro", "high"],
  "gemini-3.1-flash-image": ["ag/gemini-3.1-flash-image", null],
  "gemini-image": ["ag/gemini-3.1-flash-image", null],
  "imagen-3": ["ag/gemini-3.1-flash-image", null],
  "nano-banana": ["ag/gemini-3.1-flash-image", null],
  "claude-sonnet-4-6": ["claude-sonnet-4-6", null],
  "claude-sonnet-4-6-thinking": ["claude-sonnet-4-6", null],
  "claude-sonnet-4.6-thinking": ["claude-sonnet-4.6", null],
  "claude-sonnet-4.6": ["claude-sonnet-4.6", null],
  "claude-opus-4-6": ["claude-opus-4-6-thinking", null],
  "claude-opus-4-6-thinking": ["claude-opus-4-6-thinking", null],
  "claude-opus-4.6-thinking": ["claude-opus-4.6", null],
  "claude-opus-4.6": ["claude-opus-4.6", null],
  "gpt-oss-120b-medium": ["gpt-oss-120b", "medium"],
  "gpt-oss-120b": ["gpt-oss-120b", null],
  "gpt-oss-128b-medium": ["gpt-oss-120b", "medium"],
  "gpt-oss-128b": ["gpt-oss-120b", "medium"],
  "imagen-3.0-generate-002": ["ag/gemini-3.1-flash-image", null],
  "imagen-3.0-fast-generate-001": ["ag/gemini-3.1-flash-image", null],
};

export const MODEL_CONTEXT_LIMITS = {
  "gemini-3.8-flash": 1000000,
  "gemini-3.8-flash-high": 1000000,
  "gemini-3.8-flash-medium": 1000000,
  "gemini-3.8-flash-low": 1000000,
  "gemini-3.7-flash": 1000000,
  "gemini-3.7-flash-high": 1000000,
  "gemini-3.7-flash-medium": 1000000,
  "gemini-3.7-flash-low": 1000000,
  "gemini-3.6-flash-high": 1000000,
  "gemini-3.6-flash-medium": 1000000,
  "gemini-3.6-flash-low": 1000000,
  "gemini-3.6-flash": 1000000,
  "gemini-3.5-flash-medium": 1000000,
  "gemini-3.5-flash-low": 1000000,
  "gemini-3.5-flash": 1000000,
  "gemini-3.1-pro-high": 2000000,
  "gemini-3.1-pro-low": 2000000,
  "gemini-3.1-pro": 2000000,
  "claude-sonnet-4-6": 200000,
  "claude-sonnet-4-6-thinking": 200000,
  "claude-sonnet-4.6-thinking": 200000,
  "claude-sonnet-4.6": 200000,
  "claude-opus-4-6": 200000,
  "claude-opus-4-6-thinking": 200000,
  "claude-opus-4.6-thinking": 200000,
  "claude-opus-4.6": 200000,
  "gpt-oss-120b": 128000,
  "gpt-oss-120b-medium": 128000,
  "gpt-oss-128b": 128000,
  "gpt-oss-128b-medium": 128000,
  "gemini-3.1-flash-image": 32000,
  "gemini-image": 32000,
  "imagen-3": 32000,
  "imagen-3.0-generate-002": 32000,
  "imagen-3.0-fast-generate-001": 32000,
  "nano-banana": 32000,
};

export function getCanonicalAntigravityDir() {
  const home = os.homedir();
  if (home.includes("/sandboxes/")) {
    const baseHome = home.split("/.config/antigravity/sandboxes/")[0];
    const cand = path.join(baseHome, ".config", "antigravity");
    if (fs.existsSync(cand)) {
      return cand;
    }
  }
  return path.join(os.homedir(), ".config", "antigravity");
}

export function getBridgeConfigPath() {
  const envCfg = (process.env.ANTIGRAVITY_BRIDGE_CONFIG || "").trim();
  if (envCfg) return envCfg;
  const cwdCfg = path.join(process.cwd(), "bridge_config.json");
  if (fs.existsSync(cwdCfg)) return cwdCfg;
  return path.join(getCanonicalAntigravityDir(), "bridge_config.json");
}

export function getModelFallbackChain(modelName) {
  const cfgFile = getBridgeConfigPath();
  if (fs.existsSync(cfgFile)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(cfgFile, "utf-8"));
      const fbChains = cfg.fallback_chains || cfg.model_fallbacks;
      if (fbChains && typeof fbChains === "object") {
        if (modelName && fbChains[modelName] && Array.isArray(fbChains[modelName])) {
          return fbChains[modelName].map((m) => String(m).trim()).filter(Boolean);
        }
        if (fbChains.default && Array.isArray(fbChains.default)) {
          return fbChains.default.map((m) => String(m).trim()).filter(Boolean);
        }
      } else if (Array.isArray(fbChains) && fbChains.length > 0) {
        return fbChains.map((m) => String(m).trim()).filter(Boolean);
      }
    } catch {
      // Ignore
    }
  }

  const envChain = (process.env.ANTIGRAVITY_FALLBACK_CHAIN || "").trim();
  if (envChain) {
    return envChain.split(",").map((m) => m.trim()).filter(Boolean);
  }

  const legacySonnet = (process.env.ANTIGRAVITY_SONNET_FALLBACK_MODEL || "").trim();
  if (legacySonnet) {
    return [legacySonnet, "gpt-oss-120b-medium"];
  }

  return [...DEFAULT_FALLBACK_CHAIN];
}

export function parseTimeoutValue(val) {
  if (val === null || val === undefined) return null;
  if (typeof val === "number") return Number.isFinite(val) && val > 0 ? val : null;
  if (typeof val === "string") {
    const s = val.trim().toLowerCase();
    if (!s) return null;
    let multiplier = 1.0;
    let numPart = s;
    if (s.endsWith("ms")) {
      multiplier = 0.001;
      numPart = s.slice(0, -2).trim();
    } else if (s.endsWith("s")) {
      numPart = s.slice(0, -1).trim();
    } else if (s.endsWith("m") || s.endsWith("min") || s.endsWith("mins")) {
      multiplier = 60.0;
      numPart = s.replace(/mins?|m/, "").trim();
    } else if (s.endsWith("h") || s.endsWith("hr") || s.endsWith("hours")) {
      multiplier = 3600.0;
      numPart = s.replace(/hours?|hrs?|h/, "").trim();
    }
    const num = parseFloat(numPart);
    if (Number.isFinite(num) && num > 0) {
      return num * multiplier;
    }
  }
  return null;
}

export function extractModelAndTimeout(modelName) {
  if (!modelName || typeof modelName !== "string") return [null, null];
  const m = modelName.trim().slice(0, 256); // bound regex input
  const match = m.match(/^(.*?)[@:](?:timeout[=:])?(\d+(?:\.\d+)?(?:ms|s|m|min|mins|h|hr|hours)?)$/i);
  if (match) {
    const baseModel = match[1].trim();
    const tVal = parseTimeoutValue(match[2]);
    return [baseModel, tVal];
  }
  return [m, null];
}

export function extractTimeoutFromPromptText(promptText) {
  if (!promptText || typeof promptText !== "string") return null;
  const match = promptText.match(/(?:<!--\s*timeout:\s*(\d+(?:\.\d+)?(?:ms|s|m|h)?)\s*-->|\[timeout:\s*(\d+(?:\.\d+)?(?:ms|s|m|h)?)\])/i);
  if (match) {
    const rawVal = match[1] || match[2];
    return parseTimeoutValue(rawVal);
  }
  return null;
}

export function calculateDynamicStallTimeout(promptLen, modelName = null) {
  // Long-thinking models produce zero output for minutes; a short silence-based
  // watchdog killed healthy runs and cascaded into profile fallbacks/cooldowns.
  // Keep one lenient threshold (env-overridable) regardless of prompt size/model.
  let baseStall = DEFAULT_STALL_TIMEOUT;
  if (!Number.isFinite(baseStall) || baseStall <= 0) baseStall = 600.0;
  return baseStall;
}

export function isImageModel(modelName) {
  if (!modelName || typeof modelName !== "string") return false;
  const m = modelName.toLowerCase();
  return (
    m.includes("image") ||
    m.includes("imagen") ||
    m.includes("nano-banana") ||
    m.startsWith("ag/gemini-3.1-flash-image")
  );
}

export function getModelFamily(modelName) {
  if (!modelName || typeof modelName !== "string") return "gemini";
  const m = modelName.toLowerCase().trim();
  if (m.includes("claude") || m.includes("sonnet") || m.includes("opus")) return "claude";
  if (m.includes("gpt-oss")) return "gpt-oss";
  if (m.includes("gemini") || m.includes("imagen") || m.includes("nano-banana")) return "gemini";
  return "other";
}

export function resolveModelFlags(modelName) {
  const flags = [];
  if (!modelName) return flags;

  const [cleanM] = extractModelAndTimeout(modelName);
  const modelClean = (cleanM || modelName).trim();
  let modelLower = modelClean.toLowerCase();

  if (SUPPORTED_MODELS[modelLower]) {
    const [realModel, effort] = SUPPORTED_MODELS[modelLower];
    flags.push("--model", realModel);
    if (effort) {
      flags.push("--effort", effort);
    }
    return flags;
  }

  let effort = null;
  if (modelLower.endsWith("-thinking")) {
    modelLower = modelLower.slice(0, -9);
  }

  if (modelLower.endsWith("-low")) {
    effort = "low";
    modelLower = modelLower.slice(0, -4);
  } else if (modelLower.endsWith("-medium")) {
    effort = "medium";
    modelLower = modelLower.slice(0, -7);
  } else if (modelLower.endsWith("-high")) {
    effort = "high";
    modelLower = modelLower.slice(0, -5);
  }

  if (modelLower.includes("gemini-3.8-flash")) {
    flags.push("--model", "gemini-3.8-flash");
    if (!effort) effort = "high";
  } else if (modelLower.includes("gemini-3.7-flash")) {
    flags.push("--model", "gemini-3.7-flash");
    if (!effort) effort = "medium";
  } else if (modelLower.includes("gemini-3.6-flash")) {
    flags.push("--model", "gemini-3.6-flash");
  } else if (modelLower.includes("gemini-3.5-flash")) {
    flags.push("--model", "gemini-3.5-flash");
  } else if (modelLower.includes("gemini-3.1-pro")) {
    flags.push("--model", "gemini-3.1-pro");
    if (!effort) effort = "high";
  } else if (modelLower.includes("claude-sonnet-4.6") || modelLower.includes("claude-3-7-sonnet")) {
    flags.push("--model", "Claude Sonnet 4.6 (Thinking)");
  } else if (modelLower.includes("claude-opus-4.6")) {
    flags.push("--model", "Claude Opus 4.6 (Thinking)");
  } else if (modelLower.includes("gpt-oss-120b") || modelLower.includes("gpt-oss-128b")) {
    flags.push("--model", "gpt-oss-120b");
    if (!effort) effort = "medium";
  } else if (!["antigravity", "agy", "default", "local"].includes(modelLower) && !modelClean.startsWith("-")) {
    flags.push("--model", modelClean);
  }

  if (effort) {
    flags.push("--effort", effort);
  }

  return flags;
}

export function detectCliCommand() {
  const envCmd = (process.env.ANTIGRAVITY_BRIDGE_CMD || "").trim();
  if (envCmd) {
    const binary = envCmd.split(/\s+/)[0];
    return { binary, template: envCmd };
  }

  // 1. Search PATH
  const isWindows = process.platform === "win32";
  const pathDirs = (process.env.PATH || "").split(isWindows ? ";" : ":");
  const binName = isWindows ? "agy.exe" : "agy";

  for (const d of pathDirs) {
    if (!d) continue;
    const full = path.join(d, binName);
    try {
      if (fs.existsSync(full)) {
        return {
          binary: "agy",
          template: `"${full}" --dangerously-skip-permissions --print-timeout 20m0s --output-format stream-json -p "{prompt}"`,
        };
      }
    } catch {
      // Ignore
    }
  }

  // 2. Check ~/.local/bin/agy
  const home = os.homedir();
  const localBin = path.join(home, ".local", "bin", binName);
  try {
    if (fs.existsSync(localBin)) {
      return {
        binary: "agy",
        template: `"${localBin}" --dangerously-skip-permissions --print-timeout 20m0s --output-format stream-json -p "{prompt}"`,
      };
    }
  } catch {
    // Ignore
  }

  return {
    binary: "agy",
    template: 'agy --dangerously-skip-permissions --print-timeout 20m0s --output-format stream-json -p "{prompt}"',
  };
}

/**
 * agy may execute its own tools (terminal, files, browser) during a request. Default OFF for
 * API requests: an agentic run can execute arbitrary commands on this host for many minutes on
 * behalf of any API client. Set ANTIGRAVITY_ALLOW_CLI_TOOLS=1 to allow it.
 */
export function cliToolsAllowed() {
  return ["1", "true", "yes"].includes((process.env.ANTIGRAVITY_ALLOW_CLI_TOOLS || "").trim().toLowerCase());
}

/**
 * Opt-in, narrower than ANTIGRAVITY_ALLOW_CLI_TOOLS: let agy read only the conversation log it
 * writes itself during the run (<sandbox>/.gemini/antigravity-cli/brain/<conversation>/...). With a
 * large prompt agy points the model at that transcript; blocked (the default), that run is killed
 * and the request fails. Set ANTIGRAVITY_ALLOW_TRANSCRIPT_READS=1 to allow just those reads.
 */
export function ownTranscriptReadsAllowed() {
  return ["1", "true", "yes"].includes((process.env.ANTIGRAVITY_ALLOW_TRANSCRIPT_READS || "").trim().toLowerCase());
}

export const API_MODE_PREAMBLE = [
  "[Bridge Mode: API backend]",
  "You are answering a request relayed by Antigravity Bridge. Behave as a plain language-model API:",
  "- Do NOT use your own built-in agent tools (run_command / terminal, file read/write/list, browser, web fetch, subagents). Never run commands or read files to gather context.",
  "- Reply with text only. If the request below defines client-side tools and one is needed, output the tool call JSON exactly as instructed and stop; the client will execute it and send the result back. Tool results already present in the conversation are real outputs: use them, never call the same tool again to re-read them, and once they are sufficient answer the user in plain text.",
  "- If the task cannot be completed without acting on a machine, say so briefly instead of acting.",
].join("\n");

export function apiModePreamble() {
  return cliToolsAllowed() ? "" : API_MODE_PREAMBLE;
}

/**
 * When agy ignores the preamble and starts one of its own tools, the run is killed (executor.mjs).
 * That choice is a per-run sampling accident of the model, not a profile problem, so the same
 * profile gets this many further attempts with toolBlockRetryNotice() appended to the prompt
 * before the request fails. ANTIGRAVITY_TOOL_BLOCK_RETRIES=0 disables the retry.
 */
/**
 * In API mode agy must not run its own tools, so a turn is exactly one model reply. When agy answers
 * with a client-side tool call it ALSO tends to emit an empty native function call; agy then retries
 * the model up to 3 times (30-60s wasted) before ending the run, and the bridge salvages the reply at
 * the end. With this on, the bridge instead ends the run the moment the first complete agent_response
 * parses as a client tool call - the same reply, without the retries. ANTIGRAVITY_EARLY_TOOL_CALL_EXIT=0 disables it.
 */
export function earlyToolCallExitEnabled() {
  const raw = (process.env.ANTIGRAVITY_EARLY_TOOL_CALL_EXIT || "").trim().toLowerCase();
  return !["0", "false", "no", "off"].includes(raw);
}

export function toolBlockRetries() {
  const raw = (process.env.ANTIGRAVITY_TOOL_BLOCK_RETRIES || "").trim();
  if (raw === "") return 1;
  const v = parseInt(raw, 10);
  return Number.isFinite(v) && v >= 0 ? v : 1;
}

/**
 * When agy starts one of its own tools and the request defines a client-side tool that does the same
 * job, the bridge answers with that client tool call instead of killing the run and retrying
 * (translateBlockedToolCall in translators/tools.mjs). ANTIGRAVITY_TRANSLATE_BLOCKED_TOOLS=0 disables it.
 */
export function blockedToolTranslationEnabled() {
  const raw = (process.env.ANTIGRAVITY_TRANSLATE_BLOCKED_TOOLS || "").trim().toLowerCase();
  return !["0", "false", "no", "off"].includes(raw);
}

// Socket write / connection errors that only mean one client hung up (Hermes gave up, a proxy reset,
// the user pressed stop). They must never crash the whole bridge and every other in-flight bot with it.
const BENIGN_SOCKET_ERROR_CODES = new Set([
  "EPIPE", "ECONNRESET", "ECONNABORTED", "ERR_STREAM_DESTROYED", "ERR_STREAM_WRITE_AFTER_END",
]);
export function isBenignSocketError(err) {
  return Boolean(err) && BENIGN_SOCKET_ERROR_CODES.has(err.code);
}

export const TOOL_BLOCK_RETRY_NOTICE_HEADER = "[Bridge notice: previous attempt aborted]";

export function toolBlockRetryNotice(toolText, clientToolNames = null) {
  const shown = String(toolText || "a built-in tool").replace(/\s+/g, " ").slice(0, 160);
  const names = Array.isArray(clientToolNames) ? clientToolNames.filter((n) => typeof n === "string" && n) : [];
  const lines = [
    TOOL_BLOCK_RETRY_NOTICE_HEADER,
    `Your previous attempt at this exact request was killed because you tried to run your own built-in tool (${shown}).`,
    "That is forbidden here and would be killed again. Do NOT run commands, read or list files, or browse.",
  ];
  if (names.length > 0) {
    // Name the client's tools: the model usually reached for run_command/view_file because it wanted to
    // act on the machine, and the client already offers that as a tool it will run itself.
    lines.push(
      `The client-side tools defined in this request are: ${names.join(", ")}. Anything that touches a machine ` +
        "(running a command, reading or editing a file, scheduling) must be done by replying with the tool_calls JSON " +
        'for one of those tools, e.g. {"tool_calls":[{"name":"<tool>","arguments":{...}}]}, and then stopping; the client runs it and sends the result back.'
    );
  }
  lines.push(
    "Answer from the conversation above only: reply in plain text, or, if the request defines client-side tools and one is truly needed, output that tool call JSON exactly as instructed and stop."
  );
  return lines.join("\n");
}

function envInt(name, dflt) {
  const v = parseInt((process.env[name] || "").trim(), 10);
  return Number.isFinite(v) && v > 0 ? v : dflt;
}
// Context budget for the prompt handed to agy. Tool results are what the model needs to finish a
// task; cutting them short makes it re-run the same tool forever (seen with Hermes).
// Budget is measured in UTF-8 BYTES (Thai = 3 bytes/char). Prompts above MAX_CLI_ARG_BYTES are
// delivered over stdin (see buildStdinPromptArgv), so this can exceed the argv limit.
export const DEFAULT_MAX_PROMPT_CHARS = envInt("ANTIGRAVITY_MAX_PROMPT_CHARS", 200000);
export const RECENT_TOOL_OUTPUT_CHARS = envInt("ANTIGRAVITY_RECENT_TOOL_OUTPUT_CHARS", 20000);
export const OLD_TOOL_OUTPUT_CHARS = envInt("ANTIGRAVITY_OLD_TOOL_OUTPUT_CHARS", 2000);

export function shouldShowProfileStatus() {
  const envHide = (process.env.ANTIGRAVITY_HIDE_PROFILE_STATUS || "").trim().toLowerCase();
  const envShow = (process.env.ANTIGRAVITY_SHOW_PROFILE_STATUS || "").trim().toLowerCase();
  if (["1", "true", "yes"].includes(envHide)) return false;
  if (["0", "false", "no"].includes(envShow)) return false;
  return true;
}

let cachedProxy = undefined;
let cachedProxyTime = 0;

export async function detectLocalProxy(forceFresh = false) {
  const now = Date.now();
  if (!forceFresh && cachedProxy !== undefined && now - cachedProxyTime < 30000) {
    return cachedProxy;
  }

  if (
    ["1", "true", "yes"].includes((process.env.ANTIGRAVITY_NO_PROXY || "").toLowerCase()) ||
    ["1", "true", "yes"].includes((process.env.DISABLE_PROXY || "").toLowerCase()) ||
    process.env.NO_PROXY === "*"
  ) {
    cachedProxy = null;
    cachedProxyTime = now;
    return null;
  }

  for (const envVar of [
    "ALL_PROXY",
    "all_proxy",
    "HTTPS_PROXY",
    "https_proxy",
    "HTTP_PROXY",
    "http_proxy",
  ]) {
    const val = (process.env[envVar] || "").trim();
    if (val) {
      cachedProxy = val;
      cachedProxyTime = now;
      return val;
    }
  }

  function checkPort(host, port, timeoutMs = 250) {
    return new Promise((resolve) => {
      const socket = new net.Socket();
      let done = false;
      socket.setTimeout(timeoutMs);

      const cleanup = (result) => {
        if (!done) {
          done = true;
          socket.destroy();
          resolve(result);
        }
      };

      socket.on("connect", () => cleanup(true));
      socket.on("timeout", () => cleanup(false));
      socket.on("error", () => cleanup(false));

      try {
        socket.connect(port, host);
      } catch {
        cleanup(false);
      }
    });
  }

  // 1. Check local HTTP CONNECT proxies (Privoxy on 8118, tinyproxy on 8888, 8080)
  for (const port of [8118, 8888, 8080]) {
    for (const host of ["127.0.0.1", "::1"]) {
      if (await checkPort(host, port)) {
        const found = `http://127.0.0.1:${port}`;
        cachedProxy = found;
        cachedProxyTime = now;
        return found;
      }
    }
  }

  // 2. Check local SOCKS5 proxies (WARP on 40000, Shadowsocks on 1080, Clash on 7890)
  for (const port of [40000, 1080, 7890]) {
    for (const host of ["127.0.0.1", "::1"]) {
      if (await checkPort(host, port)) {
        const found = `socks5://127.0.0.1:${port}`;
        cachedProxy = found;
        cachedProxyTime = now;
        return found;
      }
    }
  }

  cachedProxy = null;
  cachedProxyTime = now;
  return null;
}
