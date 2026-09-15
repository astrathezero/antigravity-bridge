import { MAX_CLI_ARG_BYTES } from "../config.mjs";

export function sanitizePromptForCli(promptText, maxBytes = MAX_CLI_ARG_BYTES) {
  if (!promptText || typeof promptText !== "string") return "";
  const buf = Buffer.from(promptText, "utf-8");
  if (buf.length <= maxBytes) {
    return promptText;
  }

  const headSize = Math.floor(maxBytes * 0.35);
  const tailSize = Math.max(0, maxBytes - headSize - 200);

  let headStr = buf.subarray(0, headSize).toString("utf-8");
  let tailStr = buf.subarray(Math.max(0, buf.length - tailSize)).toString("utf-8");

  // Clean up cutoffs at section boundaries / newlines (matches Python lines 2690-2698)
  if (headStr.includes("\n\n[")) {
    const lastIdx = headStr.lastIndexOf("\n\n[");
    headStr = headStr.slice(0, lastIdx);
  } else if (headStr.includes("\n")) {
    const lastIdx = headStr.lastIndexOf("\n");
    headStr = headStr.slice(0, lastIdx);
  }

  if (tailStr.includes("\n\n[")) {
    const firstIdx = tailStr.indexOf("\n\n[");
    tailStr = "[" + tailStr.slice(firstIdx + 3);
  } else if (tailStr.includes("\n")) {
    const firstIdx = tailStr.indexOf("\n");
    tailStr = tailStr.slice(firstIdx + 1);
  }

  return `${headStr}\n\n... [Middle context truncated: prompt sliced to ${maxBytes} bytes for fast model reasoning] ...\n\n${tailStr}`;
}

export function compactToolOutput(content, maxChars = 1500) {
  if (content === null || content === undefined) return "";
  let text = typeof content === "string" ? content : JSON.stringify(content);
  if (text.length <= maxChars) {
    return text;
  }
  const headLen = Math.floor(maxChars * 0.4);
  const tailLen = Math.floor(maxChars * 0.4);
  const truncatedCount = text.length - headLen - tailLen;
  return `${text.slice(0, headLen)}\n... [truncated ${truncatedCount} characters of tool output] ...\n${text.slice(-tailLen)}`;
}

export function compactMessages(messages, maxTotalChars = 280000) {
  if (!messages || !Array.isArray(messages)) return [];
  let totalChars = 0;
  for (const m of messages) {
    const c = m.content;
    if (typeof c === "string") {
      totalChars += c.length;
    } else if (Array.isArray(c)) {
      for (const part of c) {
        if (typeof part === "string") totalChars += part.length;
        else if (part && typeof part.text === "string") totalChars += part.text.length;
      }
    }
  }

  if (totalChars <= maxTotalChars) {
    return messages;
  }

  // Truncate tool results and earlier assistant/user messages
  return messages.map((m, idx) => {
    // Keep last 3 messages and first 2 messages relatively untouched
    const isEdge = idx < 2 || idx >= messages.length - 3;
    if (m.role === "tool" || m.role === "function") {
      return { ...m, content: compactToolOutput(m.content, isEdge ? 3000 : 800) };
    }
    if (!isEdge && typeof m.content === "string" && m.content.length > 2000) {
      return { ...m, content: compactToolOutput(m.content, 1500) };
    }
    return m;
  });
}
