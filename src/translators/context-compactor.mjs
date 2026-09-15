import { MAX_CLI_ARG_BYTES, RECENT_TOOL_OUTPUT_CHARS, OLD_TOOL_OUTPUT_CHARS } from "../config.mjs";

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
  return `${text.slice(0, headLen)}\n... [truncated ${truncatedCount} characters of tool output by the bridge (original ${text.length}). Do NOT re-run the same tool to see more; work with what is shown or ask the user.] ...\n${text.slice(-tailLen)}`;
}

export function compactMessages(messages, maxTotalChars = 280000) {
  if (!messages || !Array.isArray(messages)) return [];
  // UTF-8 bytes, not characters: the CLI argument limit is in bytes and Thai is 3 bytes/char
  const blen = (t) => Buffer.byteLength(String(t ?? ""), "utf-8");
  let totalChars = 0;
  for (const m of messages) {
    const c = m.content;
    if (typeof c === "string") {
      totalChars += blen(c);
    } else if (Array.isArray(c)) {
      for (const part of c) {
        if (typeof part === "string") totalChars += blen(part);
        else if (part && typeof part.text === "string") totalChars += blen(part.text);
      }
    }
    if (m.tool_calls) {
      try { totalChars += blen(JSON.stringify(m.tool_calls)); } catch { /* ignore */ }
    }
  }

  if (totalChars <= maxTotalChars) {
    return messages;
  }

  // Truncate older tool results / long text; the most recent tool results must stay readable in full
  return messages.map((m, idx) => {
    const isRecent = idx >= messages.length - 4;
    const isKickoff = idx < 2;
    if (m.role === "tool" || m.role === "function") {
      return { ...m, content: compactToolOutput(m.content, isRecent ? RECENT_TOOL_OUTPUT_CHARS : OLD_TOOL_OUTPUT_CHARS) };
    }
    if (!isRecent && !isKickoff && typeof m.content === "string" && m.content.length > 2500) {
      return { ...m, content: compactToolOutput(m.content, 2000) };
    }
    return m;
  });
}
