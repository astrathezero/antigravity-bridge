import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  MAX_CLI_ARG_BYTES,
  MAX_STDIN_PROMPT_BYTES,
  DEFAULT_PROFILE_TIMEOUT,
  DEFAULT_TOTAL_TIMEOUT,
  calculateDynamicStallTimeout,
  resolveModelFlags,
  getModelFamily,
  ANTIGRAVITY_MODEL_FALLBACK_ENABLED,
  detectLocalProxy,
  cliToolsAllowed,
  ownTranscriptReadsAllowed,
  toolBlockRetries,
  toolBlockRetryNotice,
  blockedToolTranslationEnabled,
  earlyToolCallExitEnabled,
  quotaFastFailEnabled,
} from "../config.mjs";
import { sanitizePromptForCli } from "../translators/context-compactor.mjs";
import { parseToolCallsFromResponse, translateBlockedToolCall } from "../translators/tools.mjs";
import {
  acquireSandboxLock,
  getProfileSandboxDir,
  getProfileSandboxBasePath,
} from "./sandbox.mjs";
import { syncProfileToSystem, getOsType } from "./keyring-sync.mjs";
import {
  isQuotaOrRateLimitError,
  isHardQuotaError,
  parseQuotaResetSeconds,
  formatCooldownDuration,
  GLOBAL_PROFILE_MANAGER,
} from "./profile-manager.mjs";

/** NDJSON line understood by `agy --input-format stream-json` (one user turn). */
export function buildStdinPromptPayload(promptText) {
  return JSON.stringify({ event: "user", message: { role: "user", content: promptText } }) + "\n";
}

/**
 * Turn an agy `... --output-format stream-json -p "{prompt}"` argv into its stdin form: the prompt
 * argument becomes "" and `--input-format stream-json` is inserted before -p. Returns null when the
 * template is not an agy stream-json template (caller falls back to truncation).
 */
export function buildStdinPromptArgv(parts, placeholder, cmdTemplate) {
  if (!cmdTemplate.includes("--output-format") || !cmdTemplate.includes("stream-json")) return null;
  const argv = parts.map((p) => (p === placeholder ? "" : p));
  for (let i = 0; i < argv.length; i++) {
    if (["-p", "--print", "--prompt"].includes(argv[i]) && i + 1 < argv.length && argv[i + 1] === "") {
      if (argv.includes("--input-format")) return argv;
      return [...argv.slice(0, i), "--input-format", "stream-json", ...argv.slice(i)];
    }
  }
  return null;
}

export function parseCmdTemplate(cmdTemplate, promptText, modelName = null) {
  const rawFlags = resolveModelFlags(modelName);
  const normalizedFlags = [];
  for (const f of rawFlags) {
    if (f === "claude-sonnet-4.6") {
      normalizedFlags.push("claude-sonnet-4-6");
    } else if (f === "claude-opus-4.6") {
      normalizedFlags.push("claude-opus-4-6-thinking");
    } else {
      normalizedFlags.push(f);
    }
  }

  const promptBytesLen = Buffer.byteLength(promptText, "utf-8");

  if (cmdTemplate.includes("{prompt}")) {
    const placeholder = "__PROMPT_PLACEHOLDER__";
    let temp = cmdTemplate
      .replace('"{prompt}"', placeholder)
      .replace("'{prompt}'", placeholder)
      .replace("{prompt}", placeholder);

    // Simple shell split
    const parts = temp.match(/(?:[^\s"]+|"[^"]*")+/g).map((s) => s.replace(/^"|"$/g, ""));
    let finalArgs = parts;
    if (normalizedFlags.length > 0) {
      finalArgs = [parts[0], ...normalizedFlags, ...parts.slice(1)];
    }

    let finalPrompt = promptText;
    if (promptBytesLen > MAX_CLI_ARG_BYTES) {
      const stdinArgv = buildStdinPromptArgv(finalArgs, placeholder, cmdTemplate);
      if (stdinArgv) {
        // Linux caps a single argv string at 128KB (spawn E2BIG): hand the prompt to agy over stdin.
        const payloadText =
          promptBytesLen > MAX_STDIN_PROMPT_BYTES ? sanitizePromptForCli(promptText, MAX_STDIN_PROMPT_BYTES) : promptText;
        console.log(`[EXEC] prompt is ${promptBytesLen} bytes (> ${MAX_CLI_ARG_BYTES} argv limit): delivering via stdin NDJSON`);
        return { argv: stdinArgv, stdinInput: buildStdinPromptPayload(payloadText) };
      }
      finalPrompt = sanitizePromptForCli(promptText, MAX_CLI_ARG_BYTES);
    }

    finalArgs = finalArgs.map((arg) => (arg === placeholder ? finalPrompt : arg));
    return { argv: finalArgs, stdinInput: null };
  }

  // Stdin template
  const parts = cmdTemplate.match(/(?:[^\s"]+|"[^"]*")+/g).map((s) => s.replace(/^"|"$/g, ""));
  let finalArgs = parts;
  if (normalizedFlags.length > 0) {
    finalArgs = [parts[0], ...normalizedFlags, ...parts.slice(1)];
  }

  let finalPrompt = promptText;
  if (promptBytesLen > MAX_CLI_ARG_BYTES) {
    finalPrompt = sanitizePromptForCli(promptText, MAX_CLI_ARG_BYTES);
  }

  return { argv: finalArgs, stdinInput: finalPrompt };
}

export function killProcessTree(child, force = false) {
  if (!child || !child.pid) return;
  const isWindows = process.platform === "win32";

  if (isWindows) {
    try {
      spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"]);
    } catch {
      // Ignore
    }
  } else {
    try {
      // Negative PID targets process group
      process.kill(-child.pid, force ? "SIGKILL" : "SIGTERM");
    } catch {
      try {
        child.kill(force ? "SIGKILL" : "SIGTERM");
      } catch {
        // Process already gone
      }
    }
  }
}

/**
 * Incremental parser for `agy --output-format stream-json` (NDJSON, one event per line).
 * Non-JSON lines are passed through untouched so custom --cmd templates keep working.
 */
export class AgyStreamParser {
  constructor() {
    this.seenEvents = false;
    this.deltas = [];
    this.finalResponse = null;
    this.status = null;
    this.error = null;
    this.rawLines = [];
    this.toolSteps = [];
    // The run's conversation id (from the init event); names its transcript directory in the sandbox.
    this.conversationId = null;
    // error_message steps seen: agy's API call failed and agy retried it in place.
    this.errorSteps = 0;
    // agent_response text grouped per agy step (in stream order). agy retries the model in place when
    // Gemini returns a malformed native function call, so one run can hold several separate replies.
    this._steps = [];
    this._buf = "";
  }

  /** Text of each agent_response step, in order. */
  agentResponses() {
    return this._steps.map((s) => s.text);
  }

  /** Feed a raw stdout chunk. Returns an array of {kind:"delta"|"raw", text} items. */
  feed(chunk) {
    this._buf += chunk;
    const out = [];
    let idx;
    while ((idx = this._buf.indexOf("\n")) !== -1) {
      const line = this._buf.slice(0, idx + 1);
      this._buf = this._buf.slice(idx + 1);
      out.push(...this._line(line));
    }
    return out;
  }

  /** Flush any trailing partial line at EOF. */
  finish() {
    const out = [];
    if (this._buf) {
      out.push(...this._line(this._buf));
      this._buf = "";
    }
    return out;
  }

  _line(line) {
    const trimmed = line.trim();
    if (trimmed.startsWith("{") && trimmed.includes('"event"')) {
      let ev;
      try {
        ev = JSON.parse(trimmed);
      } catch {
        ev = null;
      }
      if (ev && typeof ev === "object" && ev.event) {
        this.seenEvents = true;
        if (!this.conversationId) {
          const cid =
            ev.conversation_id || ev.init?.conversation_id || ev.step_update?.conversation_id || ev.result?.conversation_id;
          if (typeof cid === "string" && cid) this.conversationId = cid;
        }
        if (ev.event === "step_update" && ev.step_update) {
          const su = ev.step_update;
          if (su.step_type === "error_message") {
            // agy's API call failed and agy is about to retry it in place. The error text is not on
            // stdout; it is in the run's transcript (readLatestAgyRunError).
            this.errorSteps++;
            return [{ kind: "api_error", index: su.step_index ?? null }];
          }
          if (su.step_type === "agent_response") {
            const stepKey = su.step_index === undefined || su.step_index === null ? null : su.step_index;
            const out = [];
            if (typeof su.text_delta === "string" && su.text_delta) {
              this.deltas.push(su.text_delta);
              const last = this._steps[this._steps.length - 1];
              if (last && last.key === stepKey) last.text += su.text_delta;
              else this._steps.push({ key: stepKey, text: su.text_delta });
              out.push({ kind: "delta", text: su.text_delta });
            }
            if (su.state === "DONE") {
              // The model's reply for this step is complete. In API mode this is a whole turn, so the
              // executor can end the run here instead of waiting for agy's internal retries.
              const step = [...this._steps].reverse().find((s) => s.key === stepKey) || this._steps[this._steps.length - 1];
              out.push({ kind: "agent_step_done", text: step ? step.text : "" });
            }
            return out;
          }
          if (su.step_type === "tool" && su.state === "ACTIVE") {
            const info = su.tool_info && typeof su.tool_info === "object" ? su.tool_info : {};
            const name = su.tool_name || info.name || "tool";
            let params = "";
            try {
              params = JSON.stringify(info.parameters || {}).slice(0, 200);
            } catch {
              params = "";
            }
            const summary = `${name} ${params}`.trim();
            this.toolSteps.push(summary);
            const parameters = info.parameters && typeof info.parameters === "object" ? info.parameters : {};
            return [{ kind: "tool", text: summary, name, params: parameters }];
          }
        } else if (ev.event === "result" && ev.result) {
          const r = ev.result;
          this.status = r.status || null;
          if (typeof r.response === "string") this.finalResponse = r.response;
          this.error = r.error || r.error_message || r.message || null;
        } else if (ev.event === "error") {
          this.status = this.status || "ERROR";
          this.error = ev.error || ev.message || trimmed;
        }
        return [];
      }
    }
    this.rawLines.push(line);
    return [{ kind: "raw", text: line }];
  }

  /** Final text: agy's `result.response`, else concatenated deltas, else raw stdout. */
  finalText() {
    if (this.finalResponse !== null) return this.finalResponse;
    if (this.deltas.length) return this.deltas.join("");
    return this.rawLines.join("");
  }

  isFailure() {
    return this.seenEvents && this.status !== null && this.status !== "SUCCESS";
  }

  errorText() {
    return this.error || this.finalResponse || this.rawLines.join("").trim() || `agy result status=${this.status}`;
  }
}

// agy's own harness error when Gemini answers with a malformed native function call. Seen with Hermes:
// the model writes the client-side tool_calls JSON as text (which is what the bridge asked for) and
// additionally emits an empty native call; agy then retries the model up to 3 times and ends the run
// with status ERROR although a complete, usable reply is already in the stream.
const MALFORMED_FUNCTION_CALL_RE = /improperly formatted function call|malformed function call/i;

/**
 * When agy ended the run with the malformed-function-call error, return the first agent_response
 * text that is a well-formed call to one of the client's tools, else null.
 */
export function salvageClientToolCall(parser, clientToolNames) {
  if (!Array.isArray(clientToolNames) || clientToolNames.length === 0) return null;
  if (!MALFORMED_FUNCTION_CALL_RE.test(parser.errorText() || "")) return null;
  for (const text of parser.agentResponses()) {
    const [, calls] = parseToolCallsFromResponse(text, clientToolNames);
    if (calls && calls.length > 0) return text.trim();
  }
  return null;
}

// agy's read-only tools. Anything else (run_command, writes, browser, web, subagents) is never matched.
const READ_ONLY_TOOLS = new Set([
  "view_file",
  "view_file_outline",
  "view_code_item",
  "view_content_chunk",
  "list_dir",
  "grep_search",
  "find_by_name",
]);

function looksLikePath(s) {
  return /^(\/|~|\\\\|[A-Za-z]:[\\/])/.test(s);
}

function collectPathStrings(value, out = []) {
  if (typeof value === "string") {
    if (looksLikePath(value.trim())) out.push(value.trim());
  } else if (Array.isArray(value)) {
    for (const v of value) collectPathStrings(v, out);
  } else if (value && typeof value === "object") {
    for (const v of Object.values(value)) collectPathStrings(v, out);
  }
  return out;
}

/**
 * Recognises one kind of tool step: agy reading the conversation log it writes itself during this
 * run. With a large prompt agy hands the model a truncated view and points it at
 * <sandbox>/.gemini/antigravity-cli/brain/<conversation>/.system_generated/logs/transcript_full.jsonl;
 * the model then calls view_file on that path. Nothing runs on the host and nothing is written.
 *
 * Matched: a read-only tool whose every path points inside a conversation directory that did not
 * exist before this run started (other clients' conversations in the same sandbox stay off-limits),
 * plus view_content_chunk once such a read happened (it pages through that same document).
 * Such a step is let through only when ANTIGRAVITY_ALLOW_TRANSCRIPT_READS=1 (default: blocked like
 * every other tool step, with a hint naming the switch).
 */
export class OwnConversationReadPolicy {
  constructor(sandboxDir, { enabled = ownTranscriptReadsAllowed() } = {}) {
    this.enabled = Boolean(enabled);
    this.brainDir = path.resolve(sandboxDir, ".gemini", "antigravity-cli", "brain");
    this.preexisting = new Set();
    try {
      for (const entry of fs.readdirSync(this.brainDir)) this.preexisting.add(entry);
    } catch {
      // No brain directory yet: every conversation agy creates now belongs to this run.
    }
    this.allowedReads = 0;
  }

  /** True when the step is a read of this run's own conversation log (regardless of `enabled`). */
  matches(name, params) {
    if (!READ_ONLY_TOOLS.has(name)) return false;
    const paths = collectPathStrings(params);
    if (name === "view_content_chunk") return this.allowedReads > 0 && paths.length === 0;
    return paths.length > 0 && paths.every((p) => this.isOwnConversationPath(p));
  }

  /** True when the step matches AND the opt-in switch is on; counts the read for view_content_chunk. */
  allows(name, params) {
    if (!this.enabled || !this.matches(name, params)) return false;
    this.allowedReads++;
    return true;
  }

  isOwnConversationPath(p) {
    const resolved = path.resolve(p);
    const rel = path.relative(this.brainDir, resolved);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return false;
    const conversation = rel.split(path.sep)[0];
    return Boolean(conversation) && conversation !== "." && !this.preexisting.has(conversation);
  }
}

const SAFE_CONVERSATION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** Where agy writes a run's steps: the model's replies, and every API error it retried on. */
export function agyRunTranscriptPath(sandboxDir, conversationId) {
  if (typeof conversationId !== "string" || !SAFE_CONVERSATION_ID_RE.test(conversationId) || conversationId.includes("..")) {
    return null;
  }
  return path.join(sandboxDir, ".gemini", "antigravity-cli", "brain", conversationId, ".system_generated", "logs", "transcript.jsonl");
}

/**
 * The newest ERROR_MESSAGE step of a run as { error, stepIndex }, read from the tail of its transcript
 * (the first line holds the whole prompt, often hundreds of KB, so the file is not read from the
 * start). null when there is none yet or the file cannot be read: the caller then leaves the run alone.
 * stepIndex is the step number agy wrote (it matches the step_index of the stdout error_message event),
 * or null when the line has none.
 */
export async function readLatestAgyRunError(sandboxDir, conversationId, { tailBytes = 64 * 1024 } = {}) {
  const file = agyRunTranscriptPath(sandboxDir, conversationId);
  if (!file) return null;
  let fh = null;
  try {
    fh = await fs.promises.open(file, "r");
    const { size } = await fh.stat();
    const len = Math.min(size, tailBytes);
    if (len <= 0) return null;
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, size - len);
    const lines = buf.toString("utf-8").split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (!line.includes("ERROR_MESSAGE")) continue;
      try {
        const step = JSON.parse(line);
        if (step && step.type === "ERROR_MESSAGE" && typeof step.error === "string" && step.error.trim()) {
          return { error: step.error.trim(), stepIndex: Number.isInteger(step.step_index) ? step.step_index : null };
        }
      } catch {
        // The first line of the tail window can be cut mid-line; the newer lines are whole.
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fh) await fh.close().catch(() => {});
  }
}

export const TRANSCRIPT_READ_HINT =
  "This step was agy reading its own conversation log for this run (it does that when the prompt is too large for one turn); " +
  "ANTIGRAVITY_ALLOW_TRANSCRIPT_READS=1 allows only that read, nothing else.";

export async function executeCliCommand(
  cmdTemplate,
  promptText,
  {
    timeout = DEFAULT_PROFILE_TIMEOUT,
    profile = null,
    modelName = null,
    stallTimeout = null,
    outputCallback = null,
    allowCliTools = null,
    signal = null,
    clientToolNames = null,
  } = {}
) {
  const earlyToolCall = earlyToolCallExitEnabled();
  const fastFailQuota = quotaFastFailEnabled();
  const { argv, stdinInput } = parseCmdTemplate(cmdTemplate, promptText, modelName);
  const effectiveStall =
    stallTimeout !== null
      ? stallTimeout
      : calculateDynamicStallTimeout(promptText.length, modelName);
  const allowTools = allowCliTools === null ? cliToolsAllowed() : Boolean(allowCliTools);
  if (signal?.aborted) {
    throw new Error(`Client disconnected: CLI execution cancelled before start (profile=${profile || "default"})`);
  }
  const execStart = Date.now();
  console.log(
    `[EXEC] profile=${profile || "default"} model=${modelName || "default"} timeout=${Number(timeout).toFixed(0)}s stall=${Number(effectiveStall).toFixed(0)}s prompt_len=${promptText.length} tools_allowed=${allowTools}`
  );

  const releaseLock = acquireSandboxLock(profile);
  let tempPromptFile = null;

  try {
    const sandboxDir = getProfileSandboxDir(profile);
    const readPolicy = allowTools ? null : new OwnConversationReadPolicy(sandboxDir);

    const allowedEnvKeys = new Set([
      "PATH",
      "USER",
      "LOGNAME",
      "SHELL",
      "TERM",
      "LANG",
      "LC_ALL",
      "SYSTEMROOT",
      "TEMP",
      "TMP",
      "DBUS_SESSION_BUS_ADDRESS",
      "SSH_AUTH_SOCK",
      "ANTIGRAVITY_PROFILE",
      "ANTIGRAVITY_PROFILES",
      "ANTIGRAVITY_HOME",
      "HTTP_PROXY",
      "HTTPS_PROXY",
      "ALL_PROXY",
      "http_proxy",
      "https_proxy",
      "all_proxy",
      "NO_PROXY",
      "no_proxy",
    ]);

    const env = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (allowedEnvKeys.has(k) || k.startsWith("ANTIGRAVITY_")) {
        env[k] = v;
      }
    }

    env.HOME = sandboxDir;
    env.USERPROFILE = sandboxDir;
    env.XDG_CONFIG_HOME = path.join(sandboxDir, ".config");
    env.XDG_DATA_HOME = path.join(sandboxDir, ".local", "share");
    env.XDG_CACHE_HOME = path.join(sandboxDir, ".cache");
    if (profile) {
      env.ANTIGRAVITY_PROFILE = profile;
      syncProfileToSystem(profile);
    }

    const proxyUrl = await detectLocalProxy();
    if (proxyUrl) {
      env.ALL_PROXY = proxyUrl;
      env.all_proxy = proxyUrl;
      env.HTTPS_PROXY = proxyUrl;
      env.https_proxy = proxyUrl;
      env.HTTP_PROXY = proxyUrl;
      env.http_proxy = proxyUrl;
      env.NO_PROXY = "127.0.0.1,localhost,::1";
      env.no_proxy = "127.0.0.1,localhost,::1";
    }

    let stdinStream = "ignore";
    if (stdinInput) {
      stdinStream = "pipe";
    }

    return await new Promise((resolve, reject) => {
      let stdoutData = "";
      let stderrData = "";
      let lastActivity = Date.now();
      let isSettled = false;
      const parser = new AgyStreamParser();
      let toolViolation = null;
      let quotaCheckPending = false;
      // agy logged an API error and is retrying in place. When the reason is a used-up quota no retry
      // can succeed (agy makes 8 of them, ~2.5 min): end the run now so the fallback loop can put this
      // profile in cooldown until the reset and move on within seconds. Anything else (a busy model, a
      // per-minute limit) is left to agy's own retry. The transcript line can land a moment after the
      // stdout event, so a missing line, or a non-quota line that belongs to an earlier step than the
      // one that triggered the read, is re-read every 400 ms for up to 2 s before giving up on this
      // step. A hard quota line is decisive whatever its step: a quota used up at an earlier attempt
      // of this run is still used up now, so a line that lags more than that is judged on the next step.
      const checkForQuotaError = (rereads, stepIndex) => {
        readLatestAgyRunError(sandboxDir, parser.conversationId)
          .then((found) => {
            if (isSettled) return;
            const hardQuota = found !== null && isHardQuotaError(found.error);
            const stale =
              found !== null &&
              !hardQuota &&
              Number.isInteger(found.stepIndex) &&
              Number.isInteger(stepIndex) &&
              found.stepIndex < stepIndex;
            if (found === null || stale) {
              if (rereads > 0) {
                const t = setTimeout(() => checkForQuotaError(rereads - 1, stepIndex), 400);
                if (typeof t.unref === "function") t.unref();
              } else {
                quotaCheckPending = false;
              }
              return;
            }
            quotaCheckPending = false;
            const errText = found.error;
            if (!hardQuota) return;
            isSettled = true;
            clearTimeout(totalTimer);
            clearInterval(stallInterval);
            killProcessTree(child, true);
            console.warn(
              `[QUOTA] profile=${profile || "default"}: agy reported "${errText.replace(/\s+/g, " ").slice(0, 160)}" ${((Date.now() - execStart) / 1000).toFixed(1)}s into the run; ending it now instead of waiting for agy's own retries`
            );
            const quotaErr = new Error(`CLI Execution Error (profile=${profile || "default"}, status=ERROR): ${errText}`);
            quotaErr.code = "QUOTA_EXHAUSTED";
            reject(quotaErr);
          })
          .catch(() => {
            quotaCheckPending = false;
          });
      };
      const emit = (items) => {
        for (const it of items) {
          if (it.kind === "api_error") {
            if (fastFailQuota && !isSettled && !quotaCheckPending) {
              quotaCheckPending = true;
              checkForQuotaError(5, it.index);
            }
            continue;
          }
          if (it.kind === "tool") {
            if (!allowTools) {
              if (readPolicy && readPolicy.allows(it.name, it.params)) {
                console.log(
                  `[TOOL ALLOWED] profile=${profile || "default"}: agy reads its own conversation log (ANTIGRAVITY_ALLOW_TRANSCRIPT_READS=1): ${it.text}`
                );
              } else if (!toolViolation && !isSettled) {
                const hint = readPolicy && readPolicy.matches(it.name, it.params) ? ` ${TRANSCRIPT_READ_HINT}` : "";
                toolViolation = it.text;
                console.warn(
                  `[TOOL BLOCKED] profile=${profile || "default"}: agy attempted to run ${it.text} - killing CLI (API mode; set ANTIGRAVITY_ALLOW_CLI_TOOLS=1 to allow)`
                );
                isSettled = true;
                clearTimeout(totalTimer);
                clearInterval(stallInterval);
                killProcessTree(child, true);
                const blockedErr = new Error(
                  `CLI tool execution blocked (profile=${profile || "default"}): agy attempted to run ${it.text}. ` +
                    "The bridge runs in API mode and does not let agy execute tools on this machine; " +
                    "ask for a text answer or a client-side tool call instead (set ANTIGRAVITY_ALLOW_CLI_TOOLS=1 to allow)." +
                    hint
                );
                blockedErr.code = "TOOL_BLOCKED";
                blockedErr.toolViolation = it.text;
                blockedErr.toolCall = { name: it.name, params: it.params && typeof it.params === "object" ? it.params : {} };
                reject(blockedErr);
              }
            } else {
              console.log(`[TOOL STEP] profile=${profile || "default"}: ${it.text}`);
            }
          }
          if (it.kind === "agent_step_done") {
            // API mode + client tools: a completed agent_response that is a client-side tool call is the
            // whole answer. End the run now rather than let agy retry the model (it emits an empty native
            // call alongside the JSON and burns ~3 retries before finishing). Same reply, no wait.
            if (
              !isSettled &&
              !allowTools &&
              earlyToolCall &&
              Array.isArray(clientToolNames) &&
              clientToolNames.length > 0 &&
              it.text &&
              it.text.trim()
            ) {
              const [, calls] = parseToolCallsFromResponse(it.text, clientToolNames);
              if (calls && calls.length > 0) {
                isSettled = true;
                clearTimeout(totalTimer);
                clearInterval(stallInterval);
                killProcessTree(child, true);
                console.warn(
                  `[EARLY EXIT] profile=${profile || "default"}: returning the completed client-side tool call without waiting for agy to finish (retries skipped)`
                );
                resolve(it.text.trim());
              }
            }
            continue;
          }
          if (!outputCallback) continue;
          try {
            outputCallback(it.text, it.kind);
          } catch {
            // Ignore callback errors
          }
        }
      };

      const child = spawn(argv[0], argv.slice(1), {
        cwd: sandboxDir,
        env,
        detached: process.platform !== "win32",
        stdio: [stdinStream, "pipe", "pipe"],
      });

      if (stdinInput && child.stdin) {
        child.stdin.write(stdinInput);
        child.stdin.end();
      }

      // Output listeners
      child.stdout.on("data", (chunk) => {
        lastActivity = Date.now(); // any event (init, tool steps, deltas) counts as activity
        const text = chunk.toString("utf-8");
        stdoutData += text;
        emit(parser.feed(text));
      });

      child.stderr.on("data", (chunk) => {
        lastActivity = Date.now();
        stderrData += chunk.toString("utf-8");
      });

      // Total timeout
      const totalTimer = setTimeout(() => {
        if (isSettled) return;
        isSettled = true;
        killProcessTree(child, true);
        reject(
          new Error(
            `CLI execution timed out after ${timeout}s (profile=${profile || "default"})`
          )
        );
      }, timeout * 1000);

      // Stall watchdog
      const stallInterval = setInterval(() => {
        if (isSettled) {
          clearInterval(stallInterval);
          return;
        }
        const silenceSec = (Date.now() - lastActivity) / 1000;
        if (silenceSec >= effectiveStall) {
          isSettled = true;
          clearInterval(stallInterval);
          clearTimeout(totalTimer);
          killProcessTree(child, true);
          reject(
            new Error(
              `CLI execution stalled (${effectiveStall}s of silence, profile=${profile || "default"})`
            )
          );
        }
      }, 2000);

      child.on("error", (err) => {
        if (isSettled) return;
        isSettled = true;
        clearTimeout(totalTimer);
        clearInterval(stallInterval);
        reject(err);
      });

      // Client went away: stop burning quota on an answer nobody will read.
      if (signal) {
        signal.addEventListener(
          "abort",
          () => {
            if (isSettled) return;
            isSettled = true;
            clearTimeout(totalTimer);
            clearInterval(stallInterval);
            killProcessTree(child, true);
            console.warn(
              `[CLIENT DISCONNECTED] profile=${profile || "default"}: cancelled CLI execution after ${((Date.now() - execStart) / 1000).toFixed(1)}s`
            );
            reject(new Error(`Client disconnected: CLI execution cancelled (profile=${profile || "default"})`));
          },
          { once: true }
        );
      }

      child.on("close", (code) => {
        if (isSettled) return;
        isSettled = true;
        clearTimeout(totalTimer);
        clearInterval(stallInterval);

        emit(parser.finish());
        console.log(
          `[EXEC] profile=${profile || "default"} finished in ${((Date.now() - execStart) / 1000).toFixed(1)}s exit=${code} status=${parser.status || (parser.seenEvents ? "?" : "text")} deltas=${parser.deltas.length} tool_steps=${parser.toolSteps.length}`
        );
        if (parser.isFailure()) {
          const salvaged = salvageClientToolCall(parser, clientToolNames);
          if (salvaged !== null) {
            console.warn(
              `[SALVAGED] profile=${profile || "default"}: agy ended with "${String(parser.errorText()).replace(/\s+/g, " ").slice(0, 100)}" but the model had already replied with a client-side tool call; using that reply`
            );
            resolve(salvaged);
            return;
          }
          reject(
            new Error(
              `CLI Execution Error (profile=${profile || "default"}, status=${parser.status}): ${parser.errorText()}`
            )
          );
          return;
        }
        if (code === 0) {
          resolve(parser.finalText().trim());
        } else {
          const combinedErr = (stderrData || (parser.seenEvents ? parser.errorText() : stdoutData)).trim() || `Exit code ${code}`;
          reject(
            new Error(
              `CLI Execution Error (profile=${profile || "default"}, exit=${code}): ${combinedErr}`
            )
          );
        }
      });
    });
  } finally {
    releaseLock();
    if (tempPromptFile && fs.existsSync(tempPromptFile)) {
      try {
        fs.unlinkSync(tempPromptFile);
      } catch {
        // Ignore
      }
    }
  }
}

export async function executeCliWithFallback(
  cmdTemplate,
  promptText,
  {
    timeout = DEFAULT_PROFILE_TIMEOUT,
    totalTimeout = DEFAULT_TOTAL_TIMEOUT,
    profiles = null,
    modelName = null,
    profileManager = null,
    preferredProfile = null,
    stallTimeout = null,
    outputCallback = null,
    allowCliTools = null,
    signal = null,
    clientToolNames = null,
    clientTools = null,
  } = {}
) {
  const mgr = profileManager || GLOBAL_PROFILE_MANAGER;
  if (!clientToolNames && Array.isArray(clientTools) && clientTools.length > 0) {
    clientToolNames = clientTools.map((t) => t?.name).filter(Boolean);
  }
  if (profiles) {
    mgr.set_profiles(profiles);
  }

  let candidateProfiles = mgr.get_ordered_profiles(modelName);
  if (preferredProfile && candidateProfiles.includes(preferredProfile)) {
    if (!mgr.is_profile_busy(preferredProfile) && mgr.is_executable(preferredProfile, modelName)) {
      candidateProfiles = [
        preferredProfile,
        ...candidateProfiles.filter((p) => p !== preferredProfile),
      ];
    }
  }

  const errors = [];
  const triedProfiles = new Set();
  const startTime = Date.now();

  // A tool-blocked run (API mode) is retried on the same profile with a reinforced notice:
  // whether the model reaches for its own tools is a per-run accident, not a profile problem.
  // Text already streamed to the client cannot be taken back, so the retry is only safe while
  // nothing has been forwarded yet.
  let toolBlockRetriesLeft = toolBlockRetries();
  let deltaForwarded = false;
  const trackedOutputCallback = outputCallback
    ? (text, kind) => {
        if (kind === "delta" && text) deltaForwarded = true;
        outputCallback(text, kind);
      }
    : null;

  for (let i = 0; i < candidateProfiles.length; i++) {
    const elapsed = (Date.now() - startTime) / 1000;
    const remainingBudget = totalTimeout - elapsed;
    if (remainingBudget <= 0) {
      errors.push(`Total fallback timeout budget (${totalTimeout}s) exceeded`);
      break;
    }

    const available = candidateProfiles.filter((p) => !triedProfiles.has(p));
    if (available.length === 0) break;

    let profile = mgr.acquire_profile(available, 0, modelName);
    if (!profile && available.length > 0) {
      // Last resort: nothing is both free and runnable. Prefer a free profile that is merely in a
      // short error back-off over one whose sandbox is locked (that attempt fails before it starts).
      const free = available.filter((p) => !mgr.is_profile_busy(p));
      const pool = [...(free.length > 0 ? free : available)].sort((a, b) => mgr.get_in_flight(a) - mgr.get_in_flight(b));
      profile = pool[0];
      mgr.acquire_specific_profile(profile);
    }

    triedProfiles.add(profile);
    const profileKey = profile || "default";
    const attemptTimeout = Math.max(1.0, Math.min(timeout, remainingBudget));

    // Determine effective model for this attempt
    let effectiveModel = modelName;
    const fam = getModelFamily(modelName);
    if (fam === "gemini" && ANTIGRAVITY_MODEL_FALLBACK_ENABLED) {
      if (mgr.is_family_in_cooldown(profile, "gemini")) {
        const fbModel = mgr.get_available_fallback_model(profile, modelName);
        if (fbModel) {
          effectiveModel = fbModel;
        } else {
          mgr.release_profile(profile);
          errors.push(`Profile '${profileKey}' exhausted for Gemini and all fallback models.`);
          continue;
        }
      }
    } else if (mgr.is_in_cooldown(profile, modelName)) {
      mgr.release_profile(profile);
      errors.push(`Profile '${profileKey}' is in cooldown. Skipping.`);
      continue;
    }

    mgr.note_attempt(profile);
    const attemptStart = Date.now();
    try {
      let attemptPrompt = promptText;
      let attemptBudget = attemptTimeout;
      let output;
      for (;;) {
        try {
          output = await executeCliCommand(cmdTemplate, attemptPrompt, {
            timeout: attemptBudget,
            profile,
            modelName: effectiveModel,
            stallTimeout,
            outputCallback: trackedOutputCallback,
            allowCliTools,
            signal,
            clientToolNames,
          });
          break;
        } catch (err) {
          if (err?.code === "TOOL_BLOCKED" && !deltaForwarded && blockedToolTranslationEnabled()) {
            const translated = translateBlockedToolCall(err.toolCall, clientTools, {
              sandboxPrefixes: [getProfileSandboxBasePath(profile), getProfileSandboxDir(profile)],
            });
            if (translated) {
              console.warn(
                `[TOOL TRANSLATED] profile=${profileKey}: agy's ${err.toolCall.name} step became a client-side ${translated.name} call`
              );
              output = translated.text;
              break;
            }
          }
          if (err?.code !== "TOOL_BLOCKED" || toolBlockRetriesLeft <= 0 || deltaForwarded) throw err;
          toolBlockRetriesLeft--;
          console.warn(
            `[TOOL BLOCKED] profile=${profileKey}: retrying on the same profile with a reinforced no-tools notice (${toolBlockRetriesLeft} retry left)`
          );
          attemptPrompt = `${promptText}\n\n${toolBlockRetryNotice(err.toolViolation, clientToolNames)}`;
          attemptBudget = Math.max(1.0, Math.min(timeout, totalTimeout - (Date.now() - startTime) / 1000));
        }
      }

      mgr.mark_success(profile, effectiveModel);
      mgr.set_last_execution_model(profile, effectiveModel);
      return { outputText: output, usedProfile: profile, effectiveModel };
    } catch (err) {
      const errMsg = err.message || String(err);
      errors.push(`[${profileKey}] ${errMsg}`);

      const errLower = errMsg.toLowerCase();
      if (errLower.includes("cli tool execution blocked") || errLower.includes("client disconnected")) {
        // Retrying on another profile would repeat the same behaviour; no cooldown either.
        console.warn(`[FALLBACK] Profile '${profileKey}': ${errMsg} (not retrying)`);
        throw err;
      }
      // One journal line per profile switch: what failed, how long it cost, what the profile's state is
      // now and how many candidates remain. (Quota exhaustion used to be marked silently.)
      const cooldownLeft = () =>
        formatCooldownDuration(Math.max(0, (mgr.state?.[profileKey]?.exhausted_until || 0) - Math.floor(Date.now() / 1000)));
      let verdict;
      if (errLower.includes("sandbox is currently locked")) {
        verdict = "busy, no cooldown";
      } else if (errLower.includes("authentication required") || errLower.includes("not signed in")) {
        mgr.mark_exhausted(profile, errMsg, 3600.0, effectiveModel);
        verdict = `not signed in, cooldown ${cooldownLeft()}`;
      } else if (isQuotaOrRateLimitError(errMsg)) {
        const cooldown = parseQuotaResetSeconds(errMsg);
        mgr.mark_exhausted(profile, errMsg, cooldown, effectiveModel);
        verdict = `quota, cooldown ${cooldownLeft()}`;
      } else if (errLower.includes("stalled")) {
        // A quiet CLI is usually a model still thinking, not a broken profile:
        // route onward but do NOT put the profile into error cooldown.
        verdict = "no output for the stall window, no cooldown";
      } else {
        mgr.mark_error(profile, errMsg);
        verdict = `error, cooldown ${cooldownLeft()}`;
      }
      // What this loop can still try, judged the way the loop itself admits a profile: ready ones, plus
      // the ones in a short error back-off that only get a run as a last resort.
      const untried = candidateProfiles.filter((p) => !triedProfiles.has(p));
      const inBackoff = untried.filter((p) => mgr.is_in_error_cooldown(p));
      const runnable = (p) =>
        fam === "gemini" && ANTIGRAVITY_MODEL_FALLBACK_ENABLED
          ? !mgr.is_family_in_cooldown(p, "gemini") || mgr.get_available_fallback_model(p, modelName) !== null
          : !mgr.is_in_cooldown(p, modelName);
      const left = untried.filter((p) => !mgr.is_in_error_cooldown(p) && runnable(p)).length;
      console.warn(
        `[FALLBACK] Profile '${profileKey}' failed after ${((Date.now() - attemptStart) / 1000).toFixed(1)}s (${verdict}): ${errMsg.replace(/\s+/g, " ").slice(0, 160)}; ${left} profile(s) left${inBackoff.length ? ` (+${inBackoff.length} in error back-off)` : ""}`
      );
    } finally {
      mgr.release_profile(profile);
    }
  }

  throw new Error(`All agy profile attempts failed:\n${errors.join("\n")}`);
}
