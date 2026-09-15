import crypto from "node:crypto";

export function normalizeTools(tools, functions) {
  const normalized = [];

  if (tools && Array.isArray(tools)) {
    for (const t of tools) {
      if (!t || typeof t !== "object") continue;
      if (t.type === "function" && t.function && typeof t.function === "object") {
        const fn = t.function;
        normalized.push({
          name: fn.name || "",
          description: fn.description || "",
          parameters: fn.parameters || {},
        });
      } else if (t.name) {
        normalized.push({
          name: t.name || "",
          description: t.description || "",
          parameters: t.input_schema || t.parameters || {},
        });
      }
    }
  }

  if (functions && Array.isArray(functions)) {
    for (const fn of functions) {
      if (fn && typeof fn === "object" && fn.name) {
        if (!normalized.some((item) => item.name === fn.name)) {
          normalized.push({
            name: fn.name || "",
            description: fn.description || "",
            parameters: fn.parameters || {},
          });
        }
      }
    }
  }

  return normalized;
}

export function formatToolsToSystemPrompt(tools, toolChoice = null) {
  if (!tools || tools.length === 0) return "";

  if (typeof toolChoice === "string" && toolChoice.toLowerCase() === "none") {
    return "";
  }

  let forcedTool = null;
  if (toolChoice && typeof toolChoice === "object") {
    if (toolChoice.type === "function" && toolChoice.function) {
      forcedTool = toolChoice.function.name;
    } else if (toolChoice.type === "tool") {
      forcedTool = toolChoice.name;
    } else if (toolChoice.name) {
      forcedTool = toolChoice.name;
    }
  }

  const toolsJson = JSON.stringify(tools, null, 2);
  const lines = [
    "# TOOL CALLING INSTRUCTIONS",
    "You have access to the following tools/functions that you can invoke to answer the user's request:",
    "```json",
    toolsJson,
    "```",
    "",
    "To call one or more tools, you MUST reply with a valid JSON object matching this schema:",
    "```json",
    JSON.stringify(
      {
        tool_calls: [
          {
            name: "tool_name",
            arguments: { param1: "value1" },
          },
        ],
      },
      null,
      2
    ),
    "```",
  ];

  if (forcedTool) {
    lines.push(`CRITICAL: You MUST call the tool '${forcedTool}'.`);
  } else if (typeof toolChoice === "string" && ["required", "any"].includes(toolChoice.toLowerCase())) {
    lines.push("CRITICAL: You MUST call at least one tool from the available tools list.");
  } else {
    lines.push("If no tool needs to be called to answer the user's request, respond normally with plain text.");
  }

  lines.push("Do NOT output conversational filler before or after the JSON block when calling a tool.");
  return lines.join("\n");
}

function normalizeToolCallItem(item, allowedTools = null) {
  if (!item || typeof item !== "object") return null;

  if (item.type === "function" && item.function && typeof item.function === "object") {
    item = item.function;
  }

  let name = item.name || item.function_name;
  if (!name || typeof name !== "string") return null;
  name = name.trim();

  if (allowedTools && allowedTools.length > 0) {
    const matched = allowedTools.find((t) => t.toLowerCase() === name.toLowerCase());
    if (matched) {
      name = matched;
    } else {
      return null;
    }
  }

  const rawArgs = item.arguments || item.parameters || item.input || {};
  let argsDict = {};
  if (typeof rawArgs === "string") {
    try {
      argsDict = JSON.parse(rawArgs);
    } catch {
      argsDict = { raw_input: rawArgs };
    }
  } else if (rawArgs && typeof rawArgs === "object") {
    argsDict = rawArgs;
  }

  const callId = item.id || `call_${crypto.randomBytes(6).toString("hex")}`;
  return {
    id: callId,
    name,
    arguments: argsDict,
  };
}

function tryParseToolCallJson(rawStr, allowedTools = null) {
  if (!rawStr || !rawStr.trim()) return null;

  let data;
  try {
    data = JSON.parse(rawStr);
  } catch {
    return null;
  }

  const toolCalls = [];

  if (data && typeof data === "object" && !Array.isArray(data)) {
    if (data.tool_calls && Array.isArray(data.tool_calls)) {
      for (const tc of data.tool_calls) {
        const item = normalizeToolCallItem(tc, allowedTools);
        if (item) toolCalls.push(item);
      }
    } else if (data.name && (data.arguments || data.parameters || data.input)) {
      const item = normalizeToolCallItem(data, allowedTools);
      if (item) toolCalls.push(item);
    } else if (data.function && typeof data.function === "object") {
      const item = normalizeToolCallItem(data.function, allowedTools);
      if (item) toolCalls.push(item);
    }
  } else if (Array.isArray(data)) {
    for (const tc of data) {
      const item = normalizeToolCallItem(tc, allowedTools);
      if (item) toolCalls.push(item);
    }
  }

  return toolCalls.length > 0 ? toolCalls : null;
}

export function parseToolCallsFromResponse(outputText, allowedTools = null) {
  if (!outputText || !outputText.trim()) {
    return [outputText, null];
  }

  const text = outputText.trim();

  // 1. Regex search for ```json ... ``` or ``` ... ```
  const codeBlockRegex = /```(?:json)?\s*([\s\S]*?)\s*```/gi;
  let match;
  while ((match = codeBlockRegex.exec(text)) !== null) {
    const candidate = match[1].trim();
    const parsed = tryParseToolCallJson(candidate, allowedTools);
    if (parsed) {
      const prefix = text.slice(0, match.index).trim();
      const suffix = text.slice(match.index + match[0].length).trim();
      const remainingText = prefix || suffix ? `${prefix}\n${suffix}`.trim() : null;
      return [remainingText, parsed];
    }
  }

  // 2. Search for XML style <tool_call>...</tool_call> or <function_call>...</function_call>
  const xmlRegex = /<(?:tool_call|function_call)>\s*([\s\S]*?)\s*<\/(?:tool_call|function_call)>/gi;
  const allParsed = [];
  while ((match = xmlRegex.exec(text)) !== null) {
    const candidate = match[1].trim();
    const parsed = tryParseToolCallJson(candidate, allowedTools);
    if (parsed) {
      allParsed.push(...parsed);
    }
  }
  if (allParsed.length > 0) {
    const cleanText = text.replace(/<(?:tool_call|function_call)>[\s\S]*?<\/(?:tool_call|function_call)>/gi, "").trim();
    return [cleanText || null, allParsed];
  }

  // 3. Direct JSON parse on whole text
  const parsed = tryParseToolCallJson(text, allowedTools);
  if (parsed) {
    return [null, parsed];
  }

  // 4. Search for { ... } object containing tool_calls
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    const candidate = jsonMatch[0].trim();
    const parsedObj = tryParseToolCallJson(candidate, allowedTools);
    if (parsedObj) {
      const prefix = text.slice(0, jsonMatch.index).trim();
      const suffix = text.slice(jsonMatch.index + jsonMatch[0].length).trim();
      const remainingText = prefix || suffix ? `${prefix}\n${suffix}`.trim() : null;
      return [remainingText, parsedObj];
    }
  }

  return [outputText, null];
}
