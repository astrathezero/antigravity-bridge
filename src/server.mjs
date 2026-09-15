import http from "node:http";
import url from "node:url";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  DEFAULT_PORT,
  DEFAULT_HOST,
  MAX_BODY_SIZE,
  DEFAULT_PROFILE_TIMEOUT,
  DEFAULT_TOTAL_TIMEOUT,
  DEFAULT_MAX_AUTOSCALE_TIMEOUT,
  DEFAULT_MAX_TOTAL_TIMEOUT,
  SUPPORTED_MODELS,
  MODEL_CONTEXT_LIMITS,
  extractModelAndTimeout,
  extractTimeoutFromPromptText,
  parseTimeoutValue,
  calculateDynamicStallTimeout,
  isImageModel,
  detectCliCommand,
  shouldShowProfileStatus,
  getBridgeConfigPath,
} from "./config.mjs";
import {
  getConfiguredApiKeys,
  maskApiKey,
  saveApiKeyToEnv,
  revokeApiKeyFromEnv,
  generateApiKey,
} from "./auth.mjs";
import {
  GLOBAL_PROFILE_MANAGER,
  getAvailableProfiles,
  parseQuotaResetSeconds,
  isQuotaOrRateLimitError,
} from "./core/profile-manager.mjs";
import { executeCliWithFallback, executeCliCommand } from "./core/executor.mjs";
import { syncProfileToSystem } from "./core/keyring-sync.mjs";
import { normalizeTools } from "./translators/tools.mjs";
import {
  verifyApiKey,
  isSafeProfileName,
  buildAllowedHosts,
  isAllowedHost,
  sanitizeHeaderValue,
  API_KEY_LABEL_RE,
  API_KEY_VALUE_RE,
} from "./core/security.mjs";
import {
  formatMessagesToPrompt,
  buildOpenAIResponse,
  buildOpenAIStreamChunk,
} from "./translators/openai.mjs";
import {
  buildAnthropicResponse,
  buildAnthropicStreamEvents,
} from "./translators/anthropic.mjs";
import { parseToolCallsFromResponse } from "./translators/tools.mjs";
import { generateImageViaRouter } from "./image/imagen-router.mjs";

export function extractRequestTimeouts(reqJson, headers, pathStr, promptLen, rawPromptText, modelTimeout, serverProfTimeout = DEFAULT_PROFILE_TIMEOUT, serverTotalTimeout = DEFAULT_TOTAL_TIMEOUT) {
  let reqProfTimeout = null;

  // 1. Headers
  for (const hKey of ["x-profile-timeout", "x-execution-timeout", "x-timeout", "x-request-timeout", "timeout", "request-timeout"]) {
    if (headers[hKey]) {
      const parsed = parseTimeoutValue(headers[hKey]);
      if (parsed && parsed > 0) {
        reqProfTimeout = parsed;
        break;
      }
    }
  }

  // 2. Query params
  if (reqProfTimeout === null && pathStr) {
    try {
      const parsedUrl = new URL(pathStr, "http://127.0.0.1");
      for (const qKey of ["profile_timeout", "timeout", "execution_timeout", "request_timeout"]) {
        const val = parsedUrl.searchParams.get(qKey);
        if (val) {
          const parsed = parseTimeoutValue(val);
          if (parsed && parsed > 0) {
            reqProfTimeout = parsed;
            break;
          }
        }
      }
    } catch {
      // Ignore
    }
  }

  // 3. Body
  if (reqProfTimeout === null && reqJson && typeof reqJson === "object") {
    for (const bKey of ["profile_timeout", "timeout", "execution_timeout", "request_timeout"]) {
      if (reqJson[bKey]) {
        const parsed = parseTimeoutValue(reqJson[bKey]);
        if (parsed && parsed > 0) {
          reqProfTimeout = parsed;
          break;
        }
      }
    }
  }

  // 4. Model embedded timeout
  if (reqProfTimeout === null && modelTimeout && modelTimeout > 0) {
    reqProfTimeout = modelTimeout;
  }

  // 5. In-prompt directives
  if (reqProfTimeout === null && rawPromptText) {
    const inPrompt = extractTimeoutFromPromptText(rawPromptText);
    if (inPrompt && inPrompt > 0) {
      reqProfTimeout = inPrompt;
    }
  }

  // Total timeout
  let reqTotalTimeout = null;
  for (const hKey of ["x-total-timeout", "x-fallback-timeout", "x-max-total-timeout", "total-timeout"]) {
    if (headers[hKey]) {
      const parsed = parseTimeoutValue(headers[hKey]);
      if (parsed && parsed > 0) {
        reqTotalTimeout = parsed;
        break;
      }
    }
  }

  if (reqTotalTimeout === null && reqJson && typeof reqJson === "object") {
    for (const bKey of ["total_timeout", "fallback_timeout", "max_total_timeout"]) {
      if (reqJson[bKey]) {
        const parsed = parseTimeoutValue(reqJson[bKey]);
        if (parsed && parsed > 0) {
          reqTotalTimeout = parsed;
          break;
        }
      }
    }
  }

  let effectiveProfTimeout;
  if (reqProfTimeout !== null) {
    effectiveProfTimeout = Math.max(1.0, Math.min(reqProfTimeout, 7200.0));
  } else {
    const maxAutoscale = Math.max(DEFAULT_MAX_AUTOSCALE_TIMEOUT, serverProfTimeout);
    if (promptLen > 10000) {
      const scaled = serverProfTimeout + ((promptLen - 10000) / 10000.0) * 15.0;
      effectiveProfTimeout = Math.max(serverProfTimeout, Math.min(scaled, maxAutoscale));
    } else {
      effectiveProfTimeout = serverProfTimeout;
    }
  }

  let effectiveTotalTimeout;
  if (reqTotalTimeout !== null) {
    effectiveTotalTimeout = Math.max(reqTotalTimeout, effectiveProfTimeout);
  } else if (reqProfTimeout !== null) {
    effectiveTotalTimeout = Math.max(serverTotalTimeout, effectiveProfTimeout * 2.5);
  } else {
    effectiveTotalTimeout = Math.max(serverTotalTimeout, effectiveProfTimeout * 2.0);
    effectiveTotalTimeout = Math.min(effectiveTotalTimeout, DEFAULT_MAX_TOTAL_TIMEOUT);
  }

  effectiveTotalTimeout = Math.max(1.0, Math.min(effectiveTotalTimeout, 18000.0));
  return [effectiveProfTimeout, effectiveTotalTimeout];
}

export function createBridgeServer(options = {}) {
  const port = options.port || DEFAULT_PORT;
  const host = options.host || DEFAULT_HOST;
  // CORS is opt-in: a wildcard origin on a service that executes an agent
  // would let any web page drive it from the user's browser.
  const enableCors = options.enableCors ?? false;
  const customCmd = options.customCmd || null;
  const profileManager = options.profileManager || GLOBAL_PROFILE_MANAGER;
  let apiKeys = options.apiKeys || getConfiguredApiKeys();
  // Host header allow-list (DNS-rebinding defence). null => accept any (wildcard bind).
  const allowedHosts = options.allowedHosts === undefined
    ? buildAllowedHosts(host)
    : options.allowedHosts;

  function sendJson(res, data, statusCode = 200, extraHeaders = {}) {
    const body = Buffer.from(JSON.stringify(data), "utf-8");
    const headers = {
      "Content-Type": "application/json",
      "Content-Length": body.length,
    };
    for (const [hk, hv] of Object.entries(extraHeaders || {})) {
      headers[hk] = sanitizeHeaderValue(hv);
    }
    if (enableCors) {
      headers["Access-Control-Allow-Origin"] = "*";
      headers["Access-Control-Allow-Headers"] = "*";
    }
    res.writeHead(statusCode, headers);
    res.end(body);
  }

  function isAuthorized(req) {
    if (!apiKeys || Object.keys(apiKeys).length === 0) {
      return true;
    }

    let candidate = null;
    const authHeader = (req.headers["authorization"] || "").trim();
    if (authHeader.startsWith("Bearer ")) {
      candidate = authHeader.slice(7).trim();
    } else if (authHeader) {
      candidate = authHeader;
    }

    if (!candidate) candidate = (req.headers["x-api-key"] || "").trim();
    if (!candidate) candidate = (req.headers["api-key"] || "").trim();
    // NOTE: keys are intentionally NOT accepted from the query string; URLs end
    // up in access logs, proxies and browser history.

    return verifyApiKey(candidate, apiKeys) !== null;
  }

  function isOpenMode() {
    return !apiKeys || Object.keys(apiKeys).length === 0;
  }

  const server = http.createServer(async (req, res) => {
    const parsedUrl = new URL(req.url || "/", "http://127.0.0.1");
    const pathname = (parsedUrl.pathname || "").replace(/\/+$/, "") || "/";

    // Host header validation (blocks DNS-rebinding attacks against localhost)
    if (!isAllowedHost(req.headers["host"], allowedHosts)) {
      sendJson(
        res,
        { error: { message: "Forbidden: Host header not allowed. Set ANTIGRAVITY_ALLOWED_HOSTS to permit it.", type: "forbidden", code: 403 } },
        403
      );
      return;
    }

    // Handle CORS preflight
    if (req.method === "OPTIONS") {
      if (!enableCors) {
        res.writeHead(403);
        res.end();
        return;
      }
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization, x-api-key, api-key",
      });
      res.end();
      return;
    }

    // --- GET Handlers ---
    if (req.method === "GET") {
      if (pathname === "/" || pathname === "/health") {
        if (!isOpenMode() && !isAuthorized(req)) {
          // Liveness only: do not disclose profile names, errors or key counts.
          sendJson(res, { status: "ok", service: "antigravity-bridge", auth_required: true });
          return;
        }
        const activeProfiles = profileManager.get_ordered_profiles();
        const activeP = activeProfiles[0] || "default";
        const totalProfiles = profileManager._profiles.length;
        const summary = profileManager.get_status_summary();

        sendJson(res, {
          status: "ok",
          service: "antigravity-bridge",
          active_profile: activeP,
          auth_required: Object.keys(apiKeys).length > 0,
          active_keys_count: Object.keys(apiKeys).length,
          concurrency: {
            active_in_flight: profileManager.get_total_in_flight(),
            max_pool_capacity: totalProfiles * profileManager.concurrency_per_profile,
            concurrency_per_profile: profileManager.concurrency_per_profile,
            idle_profiles_count: profileManager.get_idle_profiles().length,
            busy_profiles_count: profileManager.get_busy_profiles().length,
          },
          profiles: summary,
        });
        return;
      }

      if (!isAuthorized(req)) {
        sendJson(
          res,
          {
            error: {
              message: "Invalid or missing API key. Provide a valid Bearer token, x-api-key, or api-key header.",
              type: "authentication_error",
              code: 401,
            },
          },
          401
        );
        return;
      }

      if (["/v1/keys", "/keys", "/v1/api-keys", "/api-keys"].includes(pathname)) {
        const keysData = Object.entries(apiKeys).map(([k, label]) => ({
          label,
          key_masked: maskApiKey(k),
          status: "active",
        }));
        sendJson(res, { object: "list", data: keysData, total: keysData.length });
        return;
      }

      if (["/v1/profiles", "/profiles"].includes(pathname)) {
        const totalProfiles = profileManager._profiles.length;
        sendJson(res, {
          object: "list",
          concurrency: {
            active_in_flight: profileManager.get_total_in_flight(),
            max_pool_capacity: totalProfiles * profileManager.concurrency_per_profile,
            concurrency_per_profile: profileManager.concurrency_per_profile,
            idle_profiles_count: profileManager.get_idle_profiles().length,
            busy_profiles_count: profileManager.get_busy_profiles().length,
          },
          profiles: profileManager.get_status_summary(),
        });
        return;
      }

      if (["/v1/models", "/models"].includes(pathname)) {
        const nowTs = Math.floor(Date.now() / 1000);
        const modelsList = Object.keys(SUPPORTED_MODELS).map((m) => ({
          id: m,
          object: "model",
          created: nowTs,
          owned_by: "local",
          context_window: MODEL_CONTEXT_LIMITS[m] || 1000000,
        }));
        modelsList.push(
          { id: "antigravity", object: "model", created: nowTs, owned_by: "local", context_window: 1000000 },
          { id: "agy", object: "model", created: nowTs, owned_by: "local", context_window: 1000000 }
        );
        sendJson(res, { object: "list", data: modelsList });
        return;
      }

      sendJson(res, { error: "Not Found" }, 404);
      return;
    }

    // --- POST Handlers ---
    if (req.method === "POST") {
      const isAnthropic = ["/v1/messages", "/messages"].includes(pathname);
      const isOpenAI = ["/v1/chat/completions", "/chat/completions"].includes(pathname);
      const isImageGen = ["/v1/images/generations", "/images/generations"].includes(pathname);
      const isProfilesReset = ["/v1/profiles/reset", "/profiles/reset"].includes(pathname);
      const isProfilesCheck = ["/v1/profiles/check", "/profiles/check"].includes(pathname);
      const isProfilesDisable = ["/v1/profiles/disable", "/profiles/disable"].includes(pathname);
      const isProfilesEnable = ["/v1/profiles/enable", "/profiles/enable"].includes(pathname);
      const isProfilesConfig = ["/v1/profiles/config", "/profiles/config", "/v1/config", "/config"].includes(pathname);
      const isKeysCreate = [
        "/v1/keys/create",
        "/keys/create",
        "/v1/api-keys/create",
        "/api-keys/create",
      ].includes(pathname);
      const isKeysRevoke = [
        "/v1/keys/revoke",
        "/keys/revoke",
        "/v1/api-keys/revoke",
        "/api-keys/revoke",
      ].includes(pathname);

      if (
        !isOpenAI &&
        !isAnthropic &&
        !isImageGen &&
        !isProfilesReset &&
        !isProfilesCheck &&
        !isProfilesDisable &&
        !isProfilesEnable &&
        !isProfilesConfig &&
        !isKeysCreate &&
        !isKeysRevoke
      ) {
        sendJson(res, { error: "Not Found" }, 404);
        return;
      }

      if (!isAuthorized(req)) {
        sendJson(
          res,
          {
            error: {
              message: "Invalid or missing API key. Provide a valid Bearer token, x-api-key, or api-key header.",
              type: "authentication_error",
              code: 401,
            },
          },
          401
        );
        return;
      }

      // Read body
      const chunks = [];
      let bodyLen = 0;

      for await (const chunk of req) {
        bodyLen += chunk.length;
        if (bodyLen > MAX_BODY_SIZE) {
          sendJson(res, { error: { message: "Payload too large", type: "invalid_request_error" } }, 413);
          return;
        }
        chunks.push(chunk);
      }

      const bodyBuffer = Buffer.concat(chunks);
      let reqJson = {};
      if (bodyBuffer.length > 0) {
        try {
          reqJson = JSON.parse(bodyBuffer.toString("utf-8"));
        } catch (err) {
          sendJson(res, { error: { message: `Invalid JSON payload: ${err.message}`, type: "invalid_request_error" } }, 400);
          return;
        }
      }

      // 1. API Key Create / Revoke
      if (isKeysCreate) {
        const label = String(reqJson.label || "agent-custom").trim();
        const customKey = String(reqJson.key || "").trim();
        if (!API_KEY_LABEL_RE.test(label)) {
          sendJson(res, { error: { message: "Invalid label: use 1-64 chars of A-Z a-z 0-9 . _ -", type: "invalid_request_error" } }, 400);
          return;
        }
        if (customKey && !API_KEY_VALUE_RE.test(customKey)) {
          sendJson(res, { error: { message: "Invalid key: use 8-256 chars of A-Z a-z 0-9 . _ -", type: "invalid_request_error" } }, 400);
          return;
        }
        const keyToSave = customKey || generateApiKey();
        const [ok, pathOrErr] = saveApiKeyToEnv(label, keyToSave);
        if (ok) {
          apiKeys = getConfiguredApiKeys();
          sendJson(res, {
            status: "ok",
            label,
            key: keyToSave,
            key_masked: maskApiKey(keyToSave),
            saved_to: pathOrErr,
          });
        } else {
          sendJson(res, { error: pathOrErr }, 500);
        }
        return;
      }

      if (isKeysRevoke) {
        const target = reqJson.target || reqJson.label || reqJson.key;
        if (!target) {
          sendJson(res, { error: "Missing 'target', 'label', or 'key' in body" }, 400);
          return;
        }
        const targetStr = String(target).trim();
        if (!API_KEY_LABEL_RE.test(targetStr) && !API_KEY_VALUE_RE.test(targetStr)) {
          sendJson(res, { error: "Invalid target" }, 400);
          return;
        }
        const [ok, pathOrErr, removed] = revokeApiKeyFromEnv(targetStr);
        if (ok) {
          apiKeys = getConfiguredApiKeys();
          sendJson(res, {
            status: "ok",
            removed_count: removed.length,
            removed: removed.map(([l, k]) => ({ label: l, key_masked: maskApiKey(k) })),
            saved_to: pathOrErr,
          });
        } else {
          sendJson(res, { error: pathOrErr }, 404);
        }
        return;
      }

      // 2. Profile Management
      if (isProfilesReset) {
        const targetP = reqJson.profile || null;
        if (!isSafeProfileName(targetP)) {
          sendJson(res, { error: "Invalid profile name" }, 400);
          return;
        }
        profileManager.reset_all(targetP);
        sendJson(res, {
          status: "ok",
          message: `Profiles reset: ${targetP || "all"}`,
          profiles: profileManager.get_status_summary(),
        });
        return;
      }

      if (isProfilesCheck) {
        const cliDetect = detectCliCommand();
        const customTpl = customCmd || cliDetect.template;
        const checkModel = reqJson.model || null;
        const checkPrompt =
          reqJson.prompt ||
          "Explain in 2 clear bullet points why Fibonacci series with memoization is O(N) time complexity.";

        const results = {};
        for (const p of profileManager._profiles) {
          const pk = p || "default";
          const startT = Date.now();
          try {
            const output = await executeCliCommand(customTpl, checkPrompt, {
              timeout: 35.0,
              profile: p,
              modelName: checkModel,
            });
            const duration = ((Date.now() - startT) / 1000).toFixed(2);
            if (isQuotaOrRateLimitError(output)) {
              profileManager.mark_exhausted(p, output);
              results[pk] = { ok: false, error: output };
            } else {
              profileManager.mark_success(p);
              results[pk] = {
                ok: true,
                latency: `Passed active check (${duration}s)`,
                preview: output.slice(0, 150),
              };
            }
          } catch (exc) {
            const errMsg = exc.message || String(exc);
            profileManager.mark_exhausted(p, errMsg);
            results[pk] = { ok: false, error: errMsg };
          }
        }

        sendJson(res, {
          status: "ok",
          results,
          profiles: profileManager.get_status_summary(),
        });
        return;
      }

      if (isProfilesDisable) {
        const targetP = reqJson.profile;
        if (targetP && !isSafeProfileName(targetP)) {
          sendJson(res, { error: "Invalid profile name" }, 400);
          return;
        }
        if (targetP) {
          profileManager.mark_disabled(targetP);
          sendJson(res, {
            status: "ok",
            message: `Profile '${targetP}' is now DISABLED`,
            profiles: profileManager.get_status_summary(),
          });
        } else {
          sendJson(res, { error: "Missing 'profile' in request body" }, 400);
        }
        return;
      }

      if (isProfilesEnable) {
        const targetP = reqJson.profile;
        if (targetP && !isSafeProfileName(targetP)) {
          sendJson(res, { error: "Invalid profile name" }, 400);
          return;
        }
        if (targetP) {
          profileManager.enable(targetP);
          sendJson(res, {
            status: "ok",
            message: `Profile '${targetP}' is now ENABLED`,
            profiles: profileManager.get_status_summary(),
          });
        } else {
          sendJson(res, { error: "Missing 'profile' in request body" }, 400);
        }
        return;
      }

      if (isProfilesConfig) {
        const rawP = reqJson.profiles;
        if (rawP !== undefined) {
          let newProfiles;
          if (typeof rawP === "string") {
            newProfiles = rawP.split(",").map((p) => p.trim()).filter(Boolean);
          } else if (Array.isArray(rawP)) {
            newProfiles = rawP.map((p) => String(p).trim()).filter(Boolean);
          } else {
            newProfiles = getAvailableProfiles();
          }
          const badName = newProfiles.find((p) => !isSafeProfileName(p));
          if (badName !== undefined) {
            sendJson(res, { error: { message: `Invalid profile name: ${JSON.stringify(badName).slice(0, 80)}`, type: "invalid_request_error" } }, 400);
            return;
          }
          profileManager.set_profiles(newProfiles);

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
          } catch {
            // Ignore config write error
          }

          sendJson(res, {
            status: "ok",
            message: `Live profiles configuration updated: ${JSON.stringify(newProfiles)}`,
            active_profiles: newProfiles,
            profiles: profileManager.get_status_summary(),
          });
          return;
        } else {
          sendJson(res, {
            status: "ok",
            active_profiles: profileManager._profiles,
            profiles: profileManager.get_status_summary(),
          });
          return;
        }
      }

      // 3. Image Generation via /v1/images/generations
      if (isImageGen) {
        const prompt = reqJson.prompt;
        if (!prompt) {
          sendJson(res, { error: { message: "Missing 'prompt' field", type: "invalid_request_error" } }, 400);
          return;
        }
        const [modelName, imgTimeoutVal] = extractModelAndTimeout(reqJson.model || "gemini-3.1-flash-image");
        const [imgTimeout] = extractRequestTimeouts(reqJson, req.headers, pathname, prompt.length, prompt, imgTimeoutVal);
        try {
          const [mdImg, b64] = await generateImageViaRouter(prompt, modelName || "gemini-3.1-flash-image", undefined, undefined, Math.floor(imgTimeout));
          sendJson(res, {
            created: Math.floor(Date.now() / 1000),
            data: [{ b64_json: b64 || "", revised_prompt: prompt }],
          });
        } catch (err) {
          sendJson(res, { error: { message: `Image generation failed: ${err.message}`, type: "api_error" } }, 500);
        }
        return;
      }

      // 4. OpenAI Chat Completions or Anthropic Messages
      let messages = reqJson.messages || [];
      if (!Array.isArray(messages)) {
        sendJson(res, { error: { message: "'messages' field must be a list", type: "invalid_request_error" } }, 400);
        return;
      }

      const tools = reqJson.tools;
      const functions = reqJson.functions;
      const toolChoice = reqJson.tool_choice;
      const normalizedTools = normalizeTools(tools, functions);

      // System prompt for Anthropic
      if (reqJson.system) {
        let sysStr = "";
        if (Array.isArray(reqJson.system)) {
          sysStr = reqJson.system.map((s) => (s && s.text ? s.text : "")).join("\n");
        } else {
          sysStr = String(reqJson.system);
        }
        if (sysStr.trim()) {
          messages = [{ role: "system", content: sysStr.trim() }, ...messages];
        }
      }

      const rawModel = String(reqJson.model || "antigravity").slice(0, 256);
      const [cleanModel, modelTimeout] = extractModelAndTimeout(rawModel);
      const model = cleanModel || "antigravity";
      const stream = Boolean(reqJson.stream);

      // Handle Image Generation Models via chat/completions or messages
      if (isImageModel(model)) {
        let promptText = "";
        for (let i = messages.length - 1; i >= 0; i--) {
          if (messages[i]?.role === "user") {
            const c = messages[i].content;
            if (typeof c === "string") promptText = c;
            else if (Array.isArray(c)) promptText = c.map((part) => part?.text || "").join(" ");
            if (promptText) break;
          }
        }
        if (!promptText) promptText = formatMessagesToPrompt(messages);

        const [imgTimeout] = extractRequestTimeouts(reqJson, req.headers, pathname, promptText.length, promptText, modelTimeout);
        try {
          const [mdImg] = await generateImageViaRouter(promptText, model, undefined, undefined, Math.floor(imgTimeout));
          const showStatus = shouldShowProfileStatus();
          const banner = showStatus ? profileManager.build_profile_quota_banner(null) : "";
          const finalImgText = `${mdImg}${banner}`;

          if (isAnthropic) {
            sendJson(res, buildAnthropicResponse(finalImgText, model, null));
          } else {
            sendJson(res, buildOpenAIResponse(finalImgText, model, null));
          }
          return;
        } catch (err) {
          sendJson(res, { error: { message: `Image generation failed: ${err.message}`, type: "api_error" } }, 500);
          return;
        }
      }

      const promptText = formatMessagesToPrompt(messages, normalizedTools, toolChoice);
      const cliDetect = detectCliCommand();
      const cmdTpl = customCmd || cliDetect.template;

      const [profTimeout, totalTimeout] = extractRequestTimeouts(
        reqJson,
        req.headers,
        pathname,
        promptText.length,
        promptText,
        modelTimeout
      );
      const stallTimeout = calculateDynamicStallTimeout(promptText.length, model);
      const reqStart = Date.now();
      console.log(
        `[REQUEST] ${pathname} model=${model} prompt_len=${promptText.length} stream=${stream} tools=${normalizedTools ? normalizedTools.length : 0} profile_timeout=${profTimeout.toFixed(0)}s total_timeout=${totalTimeout.toFixed(0)}s stall=${stallTimeout.toFixed(0)}s`
      );

      // Cancel the CLI run if the client disconnects mid-request.
      const abortCtl = new AbortController();
      res.on("close", () => {
        if (!res.writableFinished) abortCtl.abort();
      });

      let heartbeatTimer = null;
      if (stream) {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
          "X-Antigravity-Profile-Timeout": `${profTimeout.toFixed(1)}s`,
          "X-Antigravity-Total-Timeout": `${totalTimeout.toFixed(1)}s`,
          "X-Antigravity-Stall-Timeout": `${stallTimeout.toFixed(1)}s`,
          ...(enableCors ? { "Access-Control-Allow-Origin": "*" } : {}),
        });

        // Heartbeat comment every 3s to keep reverse proxies happy
        heartbeatTimer = setInterval(() => {
          try {
            res.write(isAnthropic ? ": ping\n\n" : ": keep-alive\n\n");
          } catch {
            clearInterval(heartbeatTimer);
          }
        }, 3000);
      }

      // Live token streaming (OpenAI SSE, no tool-calling): forward agy text deltas as they
      // arrive so clients see progress instead of only heartbeats while the model works.
      const liveStreamId = `chatcmpl-${crypto.randomBytes(8).toString("hex")}`;
      let liveStreamedText = "";
      let liveOutputCallback = null;
      if (stream && !isAnthropic && !(normalizedTools && normalizedTools.length > 0)) {
        liveOutputCallback = (text, kind) => {
          if (kind !== "delta" || !text) return;
          liveStreamedText += text;
          const delta = liveStreamedText.length === text.length ? { role: "assistant", content: text } : { content: text };
          try {
            res.write(`data: ${JSON.stringify(buildOpenAIStreamChunk(liveStreamId, model, delta, null))}\n\n`);
          } catch {
            // client gone; the final write will fail too and be logged there
          }
        };
      }

      let reqProfile =
        req.headers["x-antigravity-profile"] ||
        req.headers["x-profile"] ||
        (typeof reqJson.profile === "string" ? reqJson.profile : null);
      if (reqProfile && !isSafeProfileName(String(reqProfile))) {
        reqProfile = null; // ignore unsafe / malformed profile hints
      }

      try {
        const { outputText, usedProfile, effectiveModel } = await executeCliWithFallback(
          cmdTpl,
          promptText,
          {
            timeout: profTimeout,
            totalTimeout,
            modelName: model,
            profileManager,
            preferredProfile: reqProfile,
            stallTimeout,
            outputCallback: liveOutputCallback,
            signal: abortCtl.signal,
          }
        );

        if (heartbeatTimer) clearInterval(heartbeatTimer);
        console.log(
          `[DONE] ${pathname} profile=${usedProfile || "default"} model=${effectiveModel || model} elapsed=${((Date.now() - reqStart) / 1000).toFixed(1)}s response_len=${outputText.length}`
        );

        // Tool calling parse
        let parsedContentText = null;
        let parsedToolCalls = null;
        if (normalizedTools && normalizedTools.length > 0) {
          const allowedNames = normalizedTools.map((t) => t.name).filter(Boolean);
          [parsedContentText, parsedToolCalls] = parseToolCallsFromResponse(outputText, allowedNames);
        }

        const showStatus = shouldShowProfileStatus();
        const banner = showStatus ? profileManager.build_profile_quota_banner(usedProfile) : "";
        const actualModel = effectiveModel || model;

        const extraRespHeaders = {
          "X-Antigravity-Profile-Timeout": `${profTimeout.toFixed(1)}s`,
          "X-Antigravity-Total-Timeout": `${totalTimeout.toFixed(1)}s`,
          "X-Antigravity-Stall-Timeout": `${stallTimeout.toFixed(1)}s`,
        };
        if (usedProfile) {
          extraRespHeaders["X-Antigravity-Active-Profile"] = String(usedProfile);
        }
        if (actualModel && actualModel !== model) {
          extraRespHeaders["X-Antigravity-Effective-Model"] = String(actualModel);
          extraRespHeaders["X-Antigravity-Model-Fallback"] = "true";
        }
        if (profileManager) {
          const summary = profileManager.get_status_summary();
          const readyCt = Object.values(summary).filter((s) => s.available).length;
          extraRespHeaders["X-Antigravity-Profiles-Ready"] = String(readyCt);
          extraRespHeaders["X-Antigravity-Profiles-Total"] = String(Object.keys(summary).length);
          extraRespHeaders["X-Antigravity-Profile-Quota-Percent"] = String(profileManager.get_estimated_quota_percent(usedProfile));
          extraRespHeaders["X-Antigravity-Concurrency-In-Flight"] = String(profileManager.get_total_in_flight());
          extraRespHeaders["X-Antigravity-Profile-Concurrency-Status"] = summary[usedProfile || "default"]?.concurrency_status || "IDLE";
        }

        if (isAnthropic) {
          if (stream) {
            const msgId = `msg_${crypto.randomBytes(12).toString("hex")}`;
            const events = buildAnthropicStreamEvents(
              msgId,
              actualModel,
              parsedContentText || outputText,
              parsedToolCalls,
              banner
            );
            for (const [evType, evData] of events) {
              res.write(`event: ${evType}\ndata: ${JSON.stringify(evData)}\n\n`);
            }
            res.end();
          } else {
            sendJson(
              res,
              buildAnthropicResponse(parsedContentText || outputText, actualModel, parsedToolCalls, banner),
              200,
              extraRespHeaders
            );
          }
        } else {
          // OpenAI
          if (stream) {
            const chunkId = liveStreamId;
            if (parsedToolCalls && parsedToolCalls.length > 0) {
              const deltaTools = parsedToolCalls.map((tc, idx) => ({
                index: idx,
                id: tc.id,
                type: "function",
                function: {
                  name: tc.name,
                  arguments: JSON.stringify(tc.arguments || {}),
                },
              }));
              const chunk = buildOpenAIStreamChunk(chunkId, actualModel, {
                role: "assistant",
                content: parsedContentText ? `${parsedContentText}${banner}` : null,
                tool_calls: deltaTools,
              }, "tool_calls");
              res.write(`data: ${JSON.stringify(chunk)}\n\n`);
            } else {
              // Only send what was not already streamed live (avoid duplicating content).
              let remaining = `${outputText}${banner}`;
              const streamedTrim = liveStreamedText.trim();
              if (streamedTrim && remaining.startsWith(streamedTrim)) {
                remaining = remaining.slice(streamedTrim.length);
              }
              const delta = liveStreamedText ? { content: remaining } : { role: "assistant", content: remaining };
              const chunk = buildOpenAIStreamChunk(chunkId, actualModel, delta, "stop");
              res.write(`data: ${JSON.stringify(chunk)}\n\n`);
            }
            res.write("data: [DONE]\n\n");
            res.end();
          } else {
            sendJson(
              res,
              buildOpenAIResponse(parsedContentText || outputText, actualModel, parsedToolCalls, banner),
              200,
              extraRespHeaders
            );
          }
        }
      } catch (err) {
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        const errMsg = err.message || String(err);
        console.error(`[FAILED] ${pathname} elapsed=${((Date.now() - reqStart) / 1000).toFixed(1)}s: ${errMsg.split("\n")[0].slice(0, 300)}`);
        if (abortCtl.signal.aborted) {
          try { res.end(); } catch { /* already closed */ }
          return;
        }

        if (stream) {
          if (isAnthropic) {
            res.write(`event: error\ndata: ${JSON.stringify({ error: { message: errMsg, type: "api_error" } })}\n\n`);
          } else {
            const errChunk = buildOpenAIStreamChunk(
              `chatcmpl-err-${crypto.randomBytes(6).toString("hex")}`,
              model,
              { role: "assistant", content: `\n\n⚠️ **Antigravity Bridge Error:** ${errMsg}` },
              "stop"
            );
            res.write(`data: ${JSON.stringify(errChunk)}\n\n`);
            res.write("data: [DONE]\n\n");
          }
          res.end();
        } else {
          sendJson(res, { error: { message: errMsg, type: "api_error" } }, 500);
        }
      }
    }
  });

  // Inbound request hygiene: bound header/body receive time (slow-loris) while
  // leaving long-running streamed responses unaffected.
  server.headersTimeout = 30_000;
  server.requestTimeout = 120_000;
  server.keepAliveTimeout = 10_000;

  return { server, port, host, allowedHosts };
}
