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
  lines.push(
    "Tool arguments must be valid JSON: keep every string value on ONE line and write line breaks inside it as \\n. " +
      "Never inline a multi-line script in a command argument (python3 -c, bash -c, heredocs): if the client offers a " +
      "file-writing tool, save the script as a file (for example a .py file) with it first, then run that file."
  );
  lines.push(
    "Tool results already in this conversation ([Tool Result] blocks) are the real outputs of your earlier calls. " +
      "Never call a tool again with the same arguments to re-read a result you already have. " +
      "When the results are sufficient, reply to the user with a normal text answer and no tool_calls. " +
      "Focus on the latest user message."
  );
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

// Models (Gemini especially) hand back tool_calls JSON with raw newlines inside string values
// (multi-line shell or python commands) and with non-JSON escapes such as the \s of a regex. Both
// make JSON.parse throw, which turned a valid tool call into a plain-text reply that ended the
// client's turn (seen with Hermes). Only string literals are touched: raw control characters are
// escaped and a backslash that does not start a JSON escape becomes a literal backslash.
// Find the index of the "}" that closes the object opened at `start`, scanning with string/escape
// awareness so braces inside string values do not miscount. Returns -1 if it never balances.
// `ends` (a Map), when given, also receives the answer for every other "{" the scan passes outside a
// string: a scan started there would read the rest of the text exactly the same way.
export function balancedObjectEnd(text, start, ends = null) {
  let depth = 0;
  let inStr = false;
  let esc = false;
  const open = [];
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") {
      depth++;
      if (ends) open.push(i);
    } else if (ch === "}") {
      depth--;
      if (ends) ends.set(open.pop(), i);
      if (depth === 0) return i;
    }
  }
  if (ends) for (const p of open) ends.set(p, -1);
  return -1;
}

export function repairJsonText(raw) {
  let out = "";
  let inString = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (!inString) {
      if (ch === '"') inString = true;
      out += ch;
      continue;
    }
    if (ch === "\\") {
      const next = raw[i + 1];
      if (next !== undefined && '"\\/bfnrt'.includes(next)) {
        out += ch + next;
        i++;
      } else if (next === "u" && /^[0-9a-fA-F]{4}$/.test(raw.slice(i + 2, i + 6))) {
        out += raw.slice(i, i + 6);
        i += 5;
      } else {
        out += "\\\\";
      }
      continue;
    }
    if (ch === '"') {
      inString = false;
      out += ch;
      continue;
    }
    const code = ch.charCodeAt(0);
    if (code < 0x20) {
      if (ch === "\n") out += "\\n";
      else if (ch === "\r") out += "\\r";
      else if (ch === "\t") out += "\\t";
      else out += "\\u" + code.toString(16).padStart(4, "0");
      continue;
    }
    out += ch;
  }
  return out;
}

function tryParseToolCallJson(rawStr, allowedTools = null) {
  if (!rawStr || !rawStr.trim()) return null;

  let data;
  try {
    data = JSON.parse(rawStr);
  } catch {
    try {
      data = JSON.parse(repairJsonText(rawStr));
    } catch {
      return null;
    }
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

/**
 * The text left over once a tool call has been lifted out of the reply, or null when there is none
 * worth keeping. The model regularly closes its JSON with one brace or one fence too many
 * (gemini-3.8-flash does both), and that leftover is not prose: a client that stores the assistant
 * message verbatim would keep "}" or "```" as the whole turn and feed it back on the next request
 * (seen with zeroclaw, whose session history filled up with exactly those). Anything carrying no
 * letter and no digit is punctuation, so it is dropped.
 */
export function toolCallRemainder(...parts) {
  const joined = parts
    .map((p) => (typeof p === "string" ? p.trim() : ""))
    .filter(Boolean)
    .join("\n")
    .trim();
  if (!joined) return null;
  return /\p{L}|\p{N}/u.test(joined) ? joined : null;
}

// The ```...``` and <tool_call>...</tool_call> candidates are found with indexOf, not with the regexes
// /```(?:json)?\s*([\s\S]*?)\s*```/ and /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/ used before: on an
// opening fence or tag followed by a long run of whitespace and no closing one (a model reply that
// floods newlines until its token limit) those backtrack cubically. 2,000 newlines after an unclosed
// ``` took 3 s and 5,000 after <tool_call> took 47 s, with the event loop, and so every request and
// /health, frozen for the whole time. Both scanners below are linear and return the same spans.

/** Every ```...``` block, left to right: the body skips an optional "json" after the opening fence. */
function fencedBlocks(text) {
  const blocks = [];
  let from = 0;
  for (;;) {
    const open = text.indexOf("```", from);
    if (open === -1) break;
    let bodyStart = open + 3;
    if (text.slice(bodyStart, bodyStart + 4).toLowerCase() === "json") bodyStart += 4;
    const close = text.indexOf("```", bodyStart);
    if (close === -1) break;
    blocks.push({ start: open, end: close + 3, body: text.slice(bodyStart, close) });
    from = close + 3;
  }
  return blocks;
}

/** Every <tool_call>/<function_call> ... </tool_call>/</function_call> block, left to right. */
function taggedBlocks(text) {
  const openRe = /<(?:tool_call|function_call)>/gi;
  const closeRe = /<\/(?:tool_call|function_call)>/gi;
  const blocks = [];
  for (;;) {
    const open = openRe.exec(text);
    if (!open) break;
    closeRe.lastIndex = open.index + open[0].length;
    const close = closeRe.exec(text);
    if (!close) break;
    blocks.push({ start: open.index, end: close.index + close[0].length, body: text.slice(open.index + open[0].length, close.index) });
    openRe.lastIndex = close.index + close[0].length;
  }
  return blocks;
}

export function parseToolCallsFromResponse(outputText, allowedTools = null) {
  if (!outputText || !outputText.trim()) {
    return [outputText, null];
  }

  const text = outputText.trim();

  // 1. ```json ... ``` or ``` ... ``` blocks
  for (const block of fencedBlocks(text)) {
    const parsed = tryParseToolCallJson(block.body.trim(), allowedTools);
    if (parsed) {
      const prefix = text.slice(0, block.start).trim();
      const suffix = text.slice(block.end).trim();
      const remainingText = toolCallRemainder(prefix, suffix);
      return [remainingText, parsed];
    }
  }

  // 2. XML style <tool_call>...</tool_call> or <function_call>...</function_call>
  const tagged = taggedBlocks(text);
  const allParsed = [];
  for (const block of tagged) {
    const parsed = tryParseToolCallJson(block.body.trim(), allowedTools);
    if (parsed) {
      allParsed.push(...parsed);
    }
  }
  if (allParsed.length > 0) {
    let cleanText = "";
    let last = 0;
    for (const block of tagged) {
      cleanText += text.slice(last, block.start);
      last = block.end;
    }
    cleanText += text.slice(last);
    return [toolCallRemainder(cleanText.trim()), allParsed];
  }

  // 3. Direct JSON parse on whole text
  const parsed = tryParseToolCallJson(text, allowedTools);
  if (parsed) {
    return [null, parsed];
  }

  // 4. Scan for the FIRST brace-balanced {...} object that parses as a tool call. This survives a
  //    trailing extra "}" or prose after the JSON (gemini-3.8-flash does both), which the greedy
  //    match below cannot: it would grab through the stray brace and fail to parse.
  //    A "{" that never balances costs a scan to the end of the text, so each scan's answers for the
  //    braces it passed are kept (a reply cut off inside a large JSON value took 39 s without that).
  const knownEnds = new Map();
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "{") continue;
    let end = knownEnds.get(i);
    if (end === undefined) end = balancedObjectEnd(text, i, knownEnds);
    if (end === -1) continue; // this "{" never balances (e.g. an unclosed string); try the next one
    const candidate = text.slice(i, end + 1);
    const parsed = tryParseToolCallJson(candidate, allowedTools);
    if (parsed) {
      const prefix = text.slice(0, i).trim();
      const suffix = text.slice(end + 1).trim();
      const remainingText = toolCallRemainder(prefix, suffix);
      return [remainingText, parsed];
    }
    i = end; // this object did not parse as a tool call; continue after it
  }

  // 5. The widest { ... } span (first "{" to last "}", what /\{[\s\S]*\}/ matched, without its
  //    per-"{" rescans when no "}" follows)
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first !== -1 && last > first) {
    const candidate = text.slice(first, last + 1);
    const parsedObj = tryParseToolCallJson(candidate, allowedTools);
    if (parsedObj) {
      const prefix = text.slice(0, first).trim();
      const suffix = text.slice(last + 1).trim();
      const remainingText = toolCallRemainder(prefix, suffix);
      return [remainingText, parsedObj];
    }
  }

  return [outputText, null];
}

// --- Blocked agy tool -> client tool ---------------------------------------------------------------
//
// In API mode agy must not run its own tools, but the model keeps reaching for run_command / view_file
// when it wants to act on a machine - and the client usually offers a tool for exactly that. Instead
// of killing the run and retrying, the bridge turns the blocked step into the equivalent client-side
// tool call: the model's intent is preserved and no second model run is needed.

const COMMAND_TOOL_NAMES = new Set([
  "terminal", "shell", "bash", "sh", "zsh", "run_command", "execute_command", "run_shell_command",
  "execute_shell", "shell_command", "run_terminal_cmd", "exec", "execute", "execute_bash", "bash_tool",
  "command", "run_shell", "shell_exec", "run", "cmd",
]);
const COMMAND_PROPS = ["command", "cmd", "command_line", "commandLine", "CommandLine", "shell_command"];
const READ_TOOL_NAMES = new Set([
  "read_file", "read", "view_file", "file_read", "read_text_file", "cat", "open_file", "get_file_contents",
  "view", "read_files", "file", "readfile",
]);
const PATH_PROPS = ["path", "file_path", "filepath", "filePath", "filename", "file", "absolute_path", "absolutePath", "AbsolutePath", "target_file"];
const OFFSET_PROPS = ["offset", "start_line", "startLine", "start", "line"];
const LIMIT_PROPS = ["limit", "max_lines", "maxLines", "num_lines", "count"];
const END_PROPS = ["end_line", "endLine", "end"];
const CWD_PROPS = ["cwd", "workdir", "working_directory", "workingDirectory", "directory", "dir"];

function schemaProps(tool) {
  const params = tool && tool.parameters && typeof tool.parameters === "object" ? tool.parameters : {};
  const props = params.properties && typeof params.properties === "object" ? params.properties : {};
  return props;
}

function firstProp(props, candidates) {
  for (const c of candidates) if (Object.prototype.hasOwnProperty.call(props, c)) return c;
  return null;
}

function findCommandTool(tools) {
  for (const t of tools || []) {
    const name = String(t?.name || "");
    const props = schemaProps(t);
    const prop = firstProp(props, COMMAND_PROPS);
    if (!prop) continue;
    if (COMMAND_TOOL_NAMES.has(name.toLowerCase()) || /term|shell|bash|cmd|command|exec/i.test(name)) {
      return { tool: t, prop, cwdProp: firstProp(props, CWD_PROPS) };
    }
  }
  return null;
}

function findReadTool(tools) {
  for (const t of tools || []) {
    const name = String(t?.name || "");
    const props = schemaProps(t);
    const prop = firstProp(props, PATH_PROPS);
    if (!prop) continue;
    if (READ_TOOL_NAMES.has(name.toLowerCase()) || /read|view|cat/i.test(name)) {
      const limitProp = firstProp(props, LIMIT_PROPS);
      const limitMax = limitProp && Number.isFinite(props[limitProp]?.maximum) ? props[limitProp].maximum : null;
      return { tool: t, prop, offsetProp: firstProp(props, OFFSET_PROPS), limitProp, limitMax, endProp: firstProp(props, END_PROPS) };
    }
  }
  return null;
}

export function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

function pick(params, names) {
  for (const n of names) {
    const v = params?.[n];
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return undefined;
}

function underAny(p, prefixes) {
  const s = String(p || "");
  return (prefixes || []).some((pre) => pre && (s === pre || s.startsWith(pre.endsWith("/") ? pre : pre + "/")));
}

/**
 * Map one blocked agy tool step {name, params} onto the client's tools. Returns
 * {name, arguments, text} (text = the tool_calls JSON the server parses) or null when nothing fits.
 * `sandboxPrefixes`: agy working directories; a Cwd inside them is agy's own scratch space and is
 * dropped, any other Cwd is honoured with a `cd` prefix (or the tool's own cwd property).
 */
export function translateBlockedToolCall(call, clientTools, { sandboxPrefixes = [] } = {}) {
  if (!call || typeof call !== "object" || !call.name) return null;
  if (!Array.isArray(clientTools) || clientTools.length === 0) return null;
  const params = call.params && typeof call.params === "object" ? call.params : {};
  const agyName = String(call.name).toLowerCase();
  let name = null;
  let args = null;

  if (agyName === "run_command") {
    const cmd = pick(params, ["CommandLine", "command_line", "command", "Command", "cmd"]);
    const target = findCommandTool(clientTools);
    if (typeof cmd !== "string" || !cmd.trim() || !target) return null;
    args = { [target.prop]: cmd };
    const cwd = pick(params, ["Cwd", "cwd", "WorkingDirectory"]);
    if (typeof cwd === "string" && cwd.trim() && !underAny(cwd, sandboxPrefixes)) {
      if (target.cwdProp) args[target.cwdProp] = cwd;
      else args[target.prop] = `cd ${shellQuote(cwd)} && ${cmd}`;
    }
    name = target.tool.name;
  } else if (agyName === "view_file" || agyName === "view_file_outline" || agyName === "view_content_chunk") {
    const file = pick(params, ["AbsolutePath", "absolute_path", "path", "file_path", "File"]);
    const target = findReadTool(clientTools);
    if (typeof file !== "string" || !file.trim() || !target) return null;
    args = { [target.prop]: file };
    const start = Number(params.StartLine);
    const end = Number(params.EndLine);
    if (Number.isFinite(start) && start >= 0) {
      if (target.offsetProp) args[target.offsetProp] = start + 1; // agy lines are 0-based
      if (Number.isFinite(end) && end >= start) {
        if (target.limitProp) {
          let limit = end - start + 1;
          if (target.limitMax) limit = Math.min(limit, target.limitMax);
          args[target.limitProp] = limit;
        } else if (target.endProp) {
          args[target.endProp] = end + 1;
        }
      }
    }
    name = target.tool.name;
  } else if (agyName === "list_dir") {
    const dir = pick(params, ["DirectoryPath", "directory_path", "path", "Path"]);
    const target = findCommandTool(clientTools);
    if (typeof dir !== "string" || !dir.trim() || !target) return null;
    args = { [target.prop]: `ls -la ${shellQuote(dir)}` };
    name = target.tool.name;
  } else if (agyName === "grep_search") {
    const query = pick(params, ["Query", "query", "Pattern", "pattern"]);
    const searchPath = pick(params, ["SearchPath", "search_path", "path", "SearchDirectory"]) || ".";
    const target = findCommandTool(clientTools);
    if (typeof query !== "string" || !query || !target) return null;
    const flags = ["-rn"];
    if (params.CaseInsensitive === true) flags.push("-i");
    if (params.IsRegex === false) flags.push("-F");
    const includes = Array.isArray(params.Includes) ? params.Includes.filter((x) => typeof x === "string" && x) : [];
    const inc = includes.map((g) => `--include=${shellQuote(g)}`);
    args = { [target.prop]: ["grep", ...flags, ...inc, shellQuote(query), shellQuote(searchPath)].join(" ") };
    name = target.tool.name;
  } else if (agyName === "find_by_name") {
    const dir = pick(params, ["SearchDirectory", "search_directory", "path"]);
    const pattern = pick(params, ["Pattern", "pattern"]);
    const target = findCommandTool(clientTools);
    if (typeof dir !== "string" || !dir.trim() || !target) return null;
    const parts = ["find", shellQuote(dir)];
    if (typeof pattern === "string" && pattern) parts.push("-name", shellQuote(pattern));
    args = { [target.prop]: parts.join(" ") };
    name = target.tool.name;
  } else {
    return null;
  }

  return { name, arguments: args, text: JSON.stringify({ tool_calls: [{ name, arguments: args }] }) };
}
