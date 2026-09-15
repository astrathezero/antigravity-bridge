import crypto from "node:crypto";
import { formatToolsToSystemPrompt, parseToolCallsFromResponse } from "./tools.mjs";
import { compactMessages } from "./context-compactor.mjs";
import { apiModePreamble, DEFAULT_MAX_PROMPT_CHARS } from "../config.mjs";

export function formatMessagesToPrompt(
  messages,
  tools = null,
  toolChoice = null,
  maxPromptChars = null
) {
  if (maxPromptChars === null) {
    maxPromptChars = DEFAULT_MAX_PROMPT_CHARS;
  }

  const parts = [];
  const preamble = apiModePreamble();
  if (preamble) parts.push(preamble);

  if (tools && tools.length > 0) {
    const toolPrompt = formatToolsToSystemPrompt(tools, toolChoice);
    if (toolPrompt) {
      parts.push(toolPrompt);
    }
  }

  if (!messages || messages.length === 0) {
    return parts.join("\n\n");
  }

  const compacted = compactMessages(messages, maxPromptChars);

  if (compacted.length === 1 && compacted[0]?.role === "user" && !tools) {
    const content = compacted[0].content || "";
    if (typeof content === "string") return preamble ? `${preamble}\n\n${content}` : content;
    if (Array.isArray(content)) {
      const textItems = [];
      for (const c of content) {
        if (!c || typeof c !== "object") continue;
        if (c.type === "text") {
          textItems.push(c.text || "");
        } else if (c.type === "tool_result") {
          let resContent = c.content || "";
          if (Array.isArray(resContent)) {
            resContent = resContent
              .filter((rc) => rc?.type === "text")
              .map((rc) => rc.text || "")
              .join("\n");
          }
          textItems.push(`[Tool '${c.tool_use_id || ""}' Result]:\n${resContent}`);
        }
      }
      const joined = textItems.join("\n");
      return preamble ? `${preamble}\n\n${joined}` : joined;
    }
  }

  for (const msg of compacted) {
    if (!msg || typeof msg !== "object") continue;
    const role = msg.role || "user";
    let content = msg.content || "";
    let msgToolCalls = msg.tool_calls;

    if (Array.isArray(content)) {
      const textParts = [];
      const toolCallParts = [];
      for (const c of content) {
        if (!c || typeof c !== "object") continue;
        if (c.type === "text") {
          textParts.push(c.text || "");
        } else if (c.type === "tool_use") {
          toolCallParts.push({
            name: c.name,
            arguments: c.input || {},
            id: c.id,
          });
        } else if (c.type === "tool_result") {
          let resContent = c.content || "";
          if (Array.isArray(resContent)) {
            resContent = resContent
              .filter((rc) => rc?.type === "text")
              .map((rc) => rc.text || "")
              .join("\n");
          }
          textParts.push(`[Tool '${c.tool_use_id || ""}' Result]:\n${resContent}`);
        } else if (c.type === "image") {
          textParts.push("[Image attached]");
        }
      }
      content = textParts.join("\n");
      if (toolCallParts.length > 0 && !msgToolCalls) {
        msgToolCalls = toolCallParts;
      }
    } else if (typeof content !== "string") {
      content = String(content);
    }

    if (role === "system") {
      parts.push(`[System Instructions]\n${content}`);
    } else if (role === "user") {
      parts.push(`[User]\n${content}`);
    } else if (role === "assistant") {
      const tcText = msgToolCalls ? `\nTool Calls: ${JSON.stringify(msgToolCalls)}` : "";
      parts.push(`[Assistant]\n${content}${tcText}`);
    } else if (role === "tool") {
      parts.push(`[Tool Result]\n${content}`);
    } else {
      const roleName = role.charAt(0).toUpperCase() + role.slice(1);
      parts.push(`[${roleName}]\n${content}`);
    }
  }

  return parts.join("\n\n");
}

export function buildOpenAIResponse(
  outputText,
  model,
  parsedToolCalls = null,
  statusBanner = ""
) {
  const createdTs = Math.floor(Date.now() / 1000);
  const promptTokens = Math.max(1, Math.floor(outputText.length / 4));
  const completionTokens = 50;

  if (parsedToolCalls && parsedToolCalls.length > 0) {
    const oaiToolCalls = parsedToolCalls.map((tc) => ({
      id: tc.id,
      type: "function",
      function: {
        name: tc.name,
        arguments: typeof tc.arguments === "string" ? tc.arguments : JSON.stringify(tc.arguments),
      },
    }));

    return {
      id: `chatcmpl-${crypto.randomBytes(8).toString("hex")}`,
      object: "chat.completion",
      created: createdTs,
      model,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: outputText ? `${outputText}${statusBanner}` : null,
            tool_calls: oaiToolCalls,
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
      },
    };
  }

  const finalContent = `${outputText}${statusBanner}`;
  return {
    id: `chatcmpl-${crypto.randomBytes(8).toString("hex")}`,
    object: "chat.completion",
    created: createdTs,
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: finalContent,
        },
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  };
}

export function buildOpenAIStreamChunk(chunkId, model, delta, finishReason = null) {
  return {
    id: chunkId,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        delta,
        finish_reason: finishReason,
      },
    ],
  };
}
